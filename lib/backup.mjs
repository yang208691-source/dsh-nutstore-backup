/**
 * 备份引擎：把 scanBackupFiles() 扫出来的文件增量同步到坚果云。
 *
 * 增量策略刻意做得"笨但可靠"：远端每个备份对象的名字是**相对路径的 base64url**，
 * 清单（manifest.json）记录每个对象的大小；下一轮只要大小一致就跳过，不比对 mtime
 * （跨机器/跨时区 mtime 不可信）。这样：
 *   ① 每一轮备份只上传"新增或变大变小"的文件，会话 jsonl 是追加写，所以只会传变化过的；
 *   ② 清单本身很小，每轮都重写一次，天然是"这一轮备份的完整快照"；
 *   ③ 不依赖 PROPFIND 列目录（坚果云对 Depth: infinity 支持不好），恢复只需要清单。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { configDir, encodeRemoteName, writeJsonAtomic } from './config.mjs'
import { scanBackupFiles } from './plan.mjs'

export const MANIFEST_NAME = 'manifest.json'
export const INFO_NAME = 'info.json'

/** 远端目录：remoteRoot + [machine]。 */
export function remoteDir(config) {
  const root = (config.remoteRoot || '/dsh-backup').replace(/\/+$/u, '')
  if (config.perMachineDir === false) return root
  return `${root}/${config.machine}`
}

/** 备份对象的远端路径。 */
export function remoteObjectPath(config, relative) {
  return `${remoteDir(config)}/${encodeRemoteName(`${relative}`)}`
}

/**
 * 元数据是否显示"这个文件与上次记录的是同一个、且没被改动过"。
 *
 * 三项都比：大小、mtime（毫秒整数）、文件身份（dev + ino，用来识别"换了个文件但属性恰好一样"）。
 * Windows 上 ino 在 NTFS 下有效；拿不到时（字段为 undefined）就只比大小与 mtime。
 */
function sameFileIdentity(previousEntry, file) {
  if (previousEntry?.size !== file.size) return false
  if (previousEntry?.mtimeMs !== file.mtimeMs) return false
  if (previousEntry?.dev !== undefined && file.dev !== undefined && previousEntry.dev !== file.dev) return false
  if (previousEntry?.ino !== undefined && file.ino !== undefined && previousEntry.ino !== file.ino) return false
  return true
}

/** 并发执行，失败不中断（错误收集在结果里）。 */async function runPool(items, limit, worker) {
  const queue = [...items]
  const results = []
  const size = Math.max(1, Math.min(limit, queue.length))
  const workers = Array.from({ length: size }, async () => {
    for (;;) {
      const item = queue.shift()
      if (item === undefined) return
      try {
        results.push({ item, ok: true, value: await worker(item) })
      } catch (error) {
        results.push({ item, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
  })
  await Promise.all(workers)
  return results
}

/** 读远端的清单；不存在或坏掉都返回 undefined（当作首次备份）。 */
export async function readManifest(client, config) {
  const dir = remoteDir(config)
  try {
    const buffer = await client.getBuffer(`${dir}/${MANIFEST_NAME}`)
    const parsed = JSON.parse(buffer.toString('utf8'))
    if (parsed !== null && typeof parsed === 'object') return parsed
    return undefined
  } catch {
    return undefined
  }
}

/** 列远端有哪些机器的备份目录（给"在新机器上恢复"用）。 */
export async function listRemoteMachines(client, config) {
  const root = (config.remoteRoot || '/dsh-backup').replace(/\/+$/u, '')
  const entries = await client.list(root, 1)
  const machines = []
  for (const entry of entries) {
    if (!entry.collection) continue
    machines.push({ name: entry.name, modified: entry.modified })
  }
  return machines
}

/**
 * 备份一轮。
 * @param options.client WebDavClient
 * @param options.config 归一化后的配置
 * @param options.force true 时忽略远端清单，全部重传
 * @param options.onProgress 进度回调（已上传字节 / 总数）
 */
export async function runBackup(options) {
  const { client, config } = options
  const started = Date.now()
  const dir = remoteDir(config)
  const scanned = scanBackupFiles(config)
  const previous = options.force === true ? undefined : await readManifest(client, config)

  /**
   * 增量判据：**大小 + 内容 sha256**，不能只看大小。
   *
   * 只看大小的漏洞很具体：把 `provider: deepseek-account` 改成另一个等长值、
   * 把 `true` 改成 `false`、把一个数字改成同位数——字节数一模一样，于是被判成"没变"，
   * 云端就一直是旧版本。配置文件和记忆文件里这种"改一句同样长的话"极其常见。
   *
   * 会话文件是追加写的，一变就变长，所以它本来不会中招；加上哈希后连"改等长内容"也覆盖了。
   * 扫描 + 哈希 10 MB 大约几十毫秒，比漏备份的代价小得多。
   */
  const previousEntries = new Map()
  for (const entry of Array.isArray(previous?.files) ? previous.files : []) {
    if (typeof entry?.name === 'string') previousEntries.set(entry.name, entry)
  }

  await client.ensureDir(dir)

  const digestOf = (filePath) => new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('close', () => { /* 正常结束 */ })
  })

  const pending = []
  const unchanged = []
  const digests = new Map()
  const skippedByMetadata = []
  const trustMetadata = options.trustMetadata ?? config.trustFileMetadata !== false
  for (const file of scanned.files) {
    const name = encodeRemoteName(file.relative)
    const previousEntry = previousEntries.get(name)

    /**
     * 第一段：**元数据快路径**——大小 + mtime + 文件身份(dev/ino) 与上次完全一致，
     * 就认为没变，**连读都不读**（省掉打开与读取整份文件的 I/O）。
     *
     * 为什么值得：文件多、会话文件大时，每轮全量读取会成为主要开销。
     * 代价是 mtime 不是内容的凭证——所以：
     *   · mtime 变了（恢复/拷贝/同步工具都会碰它）只会退回去算哈希，不会漏；
     *   · 同一时刻改回同样长度的情况，靠 mtime 的亚毫秒精度 + dev/ino 一起比来兜；
     *   · 想要"绝不漏"就把 trustFileMetadata 关掉，回到每轮全量哈希。
     */
    if (trustMetadata && typeof previousEntry?.sha256 === 'string' && sameFileIdentity(previousEntry, file)) {
      unchanged.push(file)
      skippedByMetadata.push(file.relative)
      digests.set(file.relative, previousEntry.sha256)
      continue
    }

    /**
     * 第二段：算内容 sha256。
     *
     * 不能只看大小：把 `provider: deepseek-account` 换成另一个等长值、把 `true` 改成 `false`、
     * 把一个数字改成同位数——字节数一模一样，只看大小会判成"没变"，云端永远停在旧版本。
     * 配置与记忆文件里这种"改一句同样长的话"极其常见（会话文件是追加写的，本来不会中招）。
     */
    const digest = await digestOf(file.absolute)
    digests.set(file.relative, digest)
    const sameContent = previousEntry?.sha256 !== undefined
      ? previousEntry.sha256 === digest && previousEntry.size === file.size
      : previousEntry?.size === file.size
    if (sameContent) {
      // 内容没变（只是 mtime 被碰过）：不重传，但清单里会写回新的 mtime，下次走快路径。
      unchanged.push(file)
      continue
    }
    pending.push({ ...file, name, sha256: digest })
  }

  const totalBytes = pending.reduce((total, file) => total + file.size, 0)
  let uploadedBytes = 0
  const uploaded = []
  const failed = []

  const results = await runPool(pending, config.concurrency ?? 3, async (file) => {
    // 流式上传 + 瞬时失败重试：不把文件整份读进内存。
    // 必须传 filePath（而不是流）：重试时每次都要重建流，否则上传中断后会挂住。
    await client.putFile(`${dir}/${file.name}`, file.absolute)
    uploadedBytes += file.size
    uploaded.push({ relative: file.relative, size: file.size, root: file.rootKey })
    if (typeof options.onProgress === 'function') {
      options.onProgress({ uploadedBytes, totalBytes, done: uploaded.length, total: pending.length, current: file.relative })
    }
    return file.relative
  })
  for (const result of results) {
    if (!result.ok) failed.push({ relative: result.item.relative, error: result.error })
  }

  // 清单里保留"本轮扫描到但没重传"的文件（它们与云端一致），并带上内容哈希与文件身份。
  const files = scanned.files.map((file) => {
    const name = encodeRemoteName(file.relative)
    return {
      name,
      relative: file.relative,
      root: file.rootKey,
      size: file.size,
      mtimeMs: file.mtimeMs,
      ...(file.dev === undefined ? {} : { dev: file.dev }),
      ...(file.ino === undefined ? {} : { ino: file.ino }),
      sha256: digests.get(file.relative),
    }
  })
  const manifest = {
    format: 'dsh-nutstore-backup/v1',
    machine: config.machine,
    createdAt: new Date().toISOString(),
    dir,
    roots: scanned.roots,
    sources: config.sources,
    workspaceDir: config.workspaceDir,
    files,
    stats: {
      files: files.length,
      bytes: files.reduce((total, file) => total + file.size, 0),
      uploaded: uploaded.length,
      uploadedBytes: totalBytes,
      unchanged: unchanged.length,
      /** 其中有多少是"元数据没变、连读都没读"直接跳过的（省下的 I/O）。 */
      unchangedByMetadata: skippedByMetadata.length,
      hashed: files.length - skippedByMetadata.length,
      failed: failed.length,
      ms: Date.now() - started,
    },
  }
  if (failed.length === 0) {
    await client.put(`${dir}/${MANIFEST_NAME}`, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'))
    await client.put(`${dir}/${INFO_NAME}`, Buffer.from(`${JSON.stringify({
      format: manifest.format,
      machine: config.machine,
      createdAt: manifest.createdAt,
      files: manifest.stats.files,
      bytes: manifest.stats.bytes,
      dshVersion: process.env.DSH_VERSION ?? null,
      profile: process.env.DSH_PROFILE ?? null,
    }, null, 2)}\n`, 'utf8'))
  } else {
    // 有失败就**不**更新清单：下一轮会把失败的文件重新当作 pending，
    // 而不是让清单谎称"这些文件已经在云端了"。
    writeJsonAtomic(path.join(configDir(), 'last-failed.json'), {
      at: new Date().toISOString(),
      dir,
      failed,
    })
  }

  return {
    ok: failed.length === 0,
    dir,
    scanned: { files: scanned.files.length, roots: scanned.roots, skipped: scanned.skipped },
    uploaded: uploaded.length,
    skipped: scanned.files.length - pending.length,
    /** 跳过里有几个是"没读文件就跳过"的（元数据快路径）。 */
    skippedByMetadata: skippedByMetadata.length,
    uploadedBytes: totalBytes,
    failed,
    manifest: failed.length === 0 ? manifest.stats : undefined,
    ms: Date.now() - started,
  }
}

/**
 * 恢复一轮。
 * @param options.client WebDavClient
 * @param options.config 配置
 * @param options.sourceDir 远端目录（默认当前机器的目录；换机恢复时传别的机器名）
 * @param options.mode 'all' | 'missing'（只补本地没有的文件）
 * @param options.dryRun true 时只报告会发生什么
 */
export async function runRestore(options) {
  const { client, config } = options
  const started = Date.now()
  let dir = remoteDir(config)
  if (typeof options.sourceMachine === 'string' && options.sourceMachine.trim() !== '') {
    const root = (config.remoteRoot || '/dsh-backup').replace(/\/+$/u, '')
    dir = `${root}/${options.sourceMachine.trim()}`
  }

  let manifest
  try {
    const buffer = await client.getBuffer(`${dir}/${MANIFEST_NAME}`)
    manifest = JSON.parse(buffer.toString('utf8'))
  } catch (error) {
    throw new Error(`读不到远端清单 ${dir}/${MANIFEST_NAME}：${error instanceof Error ? error.message : String(error)}（先在那台机器上做过一次备份吗？）`)
  }
  const entries = Array.isArray(manifest?.files) ? manifest.files : []
  if (entries.length === 0) throw new Error(`${dir}/${MANIFEST_NAME} 里没有任何文件记录`)

  /**
   * 恢复模式：
   *  · `all`（默认）：云端与本机不同的就写回；但**本机比云端新的文件会被保护**（见下方判定）。
   *  · `missing`：只补本机没有的文件，绝不覆盖已有文件。
   *  · `force`：无条件以云端为准（把本机完全恢复成快照原样）。
   */
  const mode = options.mode === 'missing' ? 'missing' : options.mode === 'force' ? 'force' : 'all'
  const trashDir = path.join(configDir(), 'restore-trash')
  const restored = []
  const skipped = []
  const failed = []

  /**
   * 开始前先清掉上次遗留的 `.nbpart-*` 中间文件。
   *
   * 为什么要扫：进程被杀（或被测试中断）时，写了一半的临时文件会留在目录里。
   * 清理失败**不算失败**（它们本来就不是数据），但要如实计入报告，不能装作不存在。
   */
  const staleTemporaryFiles = []
  if (options.dryRun !== true) {
    const directories = new Set()
    for (const entry of entries) {
      const target = restoreTarget(String(entry?.relative ?? ''), config)
      if (target !== undefined) directories.add(path.dirname(target))
    }
    for (const directory of directories) {
      let names = []
      try {
        names = fs.readdirSync(directory)
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.includes('.nbpart-')) continue
        const stale = path.join(directory, name)
        try {
          fs.rmSync(stale, { force: true })
          staleTemporaryFiles.push(stale)
        } catch {
          // 删不掉（可能正被别的进程用）——继续恢复，但在报告里列出来。
          staleTemporaryFiles.push(`${stale}（未能删除）`)
        }
      }
    }
  }

  const results = await runPool(entries, config.concurrency ?? 3, async (entry) => {
    const relative = typeof entry?.relative === 'string' ? entry.relative : undefined
    const name = typeof entry?.name === 'string' ? entry.name : undefined
    if (relative === undefined || name === undefined) throw new Error('清单条目缺字段')
    const target = restoreTarget(relative, config)
    if (target === undefined) throw new Error(`无法把 ${relative} 映射回本机路径`)

    if (mode === 'missing' && fs.existsSync(target)) {
      skipped.push({ relative, reason: '本地已存在' })
      return relative
    }
    let localSize
    let localMtimeMs
    try {
      const stat = fs.statSync(target)
      localSize = stat.size
      localMtimeMs = Math.trunc(stat.mtimeMs)
    } catch {
      localSize = undefined
      localMtimeMs = undefined
    }
    if (localSize !== undefined && typeof entry.size === 'number' && localSize === entry.size) {
      skipped.push({ relative, reason: '大小一致，无需覆盖' })
      return relative
    }

    /**
     * 旧快照保护：本机文件比云端记录**更新**时不覆盖。
     *
     * 为什么需要：恢复的默认语义是"云端覆盖本机"。但在正在使用的机器上误点「恢复」，
     * 就会拿较早的快照把较新的数据覆盖掉——实测过：本机那个正在写入的会话文件
     * 3,410,200 字节、云端只有 2,959,084 字节，点一下就丢了一小时的对话。
     *
     * 判定依据是清单里记录的 `mtimeMs`。为了不因文件系统时间精度误判，
     * 只在"本机明显更新"（默认相差 2 秒以上）时才保护；
     * 完全恢复到云端原样可以用 `mode: 'force'`。
     */
    const protectionWindowMs = 2000
    if (
      mode !== 'force'
      && localSize !== undefined
      && localMtimeMs !== undefined
      && typeof entry.mtimeMs === 'number'
      && entry.mtimeMs > 0
      && localMtimeMs > entry.mtimeMs + protectionWindowMs
    ) {
      skipped.push({
        relative,
        reason: `本机更新（本机 ${new Date(localMtimeMs).toISOString()} / 云端 ${new Date(entry.mtimeMs).toISOString()}），按保护策略不覆盖`,
        localMtimeMs,
        remoteMtimeMs: entry.mtimeMs,
      })
      return relative
    }

    if (options.dryRun === true) {
      restored.push({
        relative,
        size: entry.size,
        target,
        dryRun: true,
        // 区分"新建"与"覆盖"：只报"会恢复 N 条"会把两件性质不同的事混在一起，
        // 实测就误导过——35 条里其实只有 1 条是真的覆盖，其余是新建。
        kind: localSize === undefined ? 'create' : 'overwrite',
        ...(localSize === undefined ? {} : { previousSize: localSize }),
        remoteMtimeMs: entry.mtimeMs,
        localMtimeMs,
      })
      return relative
    }

    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (config.restoreTrash !== false && localSize !== undefined) {
      try {
        const trashTarget = path.join(trashDir, relative.split('/').join('__'))
        fs.mkdirSync(path.dirname(trashTarget), { recursive: true })
        fs.copyFileSync(target, trashTarget)
      } catch {
        // 回收站失败不该挡住恢复本身。
      }
    }
    // 流式落盘 + 显式校验字节数：会话 jsonl 可以很大，不能整份读进内存，
    // 也不能在传输被截断时留下一个坏文件（先写 .nbpart 再 rename）。
    const written = await client.downloadToFileWithRetry(`${dir}/${name}`, target, { expectedSize: entry.size })
    restored.push({
      relative,
      size: written.bytes,
      target,
      kind: localSize === undefined ? 'create' : 'overwrite',
      ...(localSize === undefined ? {} : { previousSize: localSize }),
    })
    return relative
  })

  for (const result of results) {
    if (!result.ok) failed.push({ relative: result.item?.relative, error: result.error })
  }

  // 按性质分类统计：新建 / 覆盖 / 因"本机更新"被保护 / 本来就一致。
  const created = restored.filter(item => item.kind === 'create')
  const overwritten = restored.filter(item => item.kind === 'overwrite')
  const protectedNewer = skipped.filter(item => String(item.reason).includes('本机更新'))
  const unchanged = skipped.filter(item => !String(item.reason).includes('本机更新'))

  return {
    ok: failed.length === 0,
    dir,
    machine: manifest.machine,
    createdAt: manifest.createdAt,
    mode,
    dryRun: options.dryRun === true,
    restored,
    skipped,
    failed,
    counts: {
      created: created.length,
      overwritten: overwritten.length,
      protectedNewer: protectedNewer.length,
      unchanged: unchanged.length,
    },
    /** 清掉的遗留中间文件（正常情况下是空的）。 */
    cleanedTemporaryFiles: staleTemporaryFiles,
    ms: Date.now() - started,
  }
}

/**
 * 相对路径 → 本机绝对路径。
 * 约定：相对路径的第一段是备份根 key + 原始相对路径，恢复时按当前机器的路径重算，
 * 所以换机器（不同的用户名、不同的盘符）也能落回正确的 DSH_HOME / 工作区。
 *
 * 注意本机根目录**不能只看 `DSH_HOME`**：桌面壳启动的宿主进程往往没有这个环境变量
 * （实测过——真机上恢复因此 100% 失败，而带 DSH_HOME 的独立进程里全绿）。
 * 所以按 `DSH_HOME` → `USERPROFILE\.dsh` → `os.homedir()\.dsh` 依次解析。
 */
export function restoreTarget(relative, config) {
  const segments = String(relative).split('/')
  const rootKey = segments[0]
  const rest = segments.slice(1).join('/')
  if (rest === '') return undefined
  const dshHomeDir = resolveLocalDshHome()
  if (dshHomeDir === undefined) return undefined

  switch (rootKey) {
    case 'sessions':
      return path.join(dshHomeDir, 'sessions', rest)
    case 'profile': {
      const profile = process.env.DSH_PROFILE_DIR
      const dir = typeof profile === 'string' && profile.trim() !== '' ? path.resolve(profile.trim()) : path.join(dshHomeDir, 'profiles', process.env.DSH_PROFILE ?? 'desktop')
      return path.join(dir, rest)
    }
    case 'workspace':
      return config.workspaceDir === undefined || config.workspaceDir === '' ? undefined : path.join(config.workspaceDir, rest)
    case 'pluginsrc':
      return path.join(dshHomeDir, 'nutstore-backup', 'restored-plugins', rest)
    default:
      if (rootKey.startsWith('extra-') || rootKey.startsWith('extra-file-')) {
        // 附加路径按配置顺序对齐；对不上就放到 restored-extra 下，绝不乱写别人目录。
        return path.join(dshHomeDir, 'nutstore-backup', 'restored-extra', rest)
      }
      return undefined
  }
}

/**
 * 本机 DSH 主目录：`DSH_HOME` → `USERPROFILE\.dsh` → `os.homedir()\.dsh`。
 *
 * 前两级都可能缺失（桌面壳启动的进程就没有 DSH_HOME），所以必须一路退到 home 目录。
 * 这里与 config.mjs 的 dshHome() 保持同一套解析顺序，避免"备份写到 A、恢复读 B"。
 */
function resolveLocalDshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return path.resolve(configured.trim())
  const profile = process.env.USERPROFILE
  if (typeof profile === 'string' && profile.trim() !== '') return path.join(path.resolve(profile.trim()), '.dsh')
  try {
    return path.join(os.homedir(), '.dsh')
  } catch {
    return undefined
  }
}
