/**
 * 备份范围（"备份什么"）的唯一事实来源：host 工具、HTTP 路由、设置页摘要都读这里。
 *
 * 设计约束：远端不做压缩、不打包整目录，而是**一文件一对象**，因为
 *  ① 增量同步靠比对单个文件的大小，压缩包每次都要整包重传；
 *  ② 恢复可以只挑一个文件（比如某个会话 jsonl）修回来，不用解整包；
 *  ③ 不引入 zip 依赖，插件在新机器上零依赖即可运行。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EXCLUDED_DIR_NAMES,
  MAX_FILE_BYTES,
  configDir,
  dshHome,
  profileDir,
  profileName,
} from './config.mjs'

/** 备份根：把绝对路径映射成与机器无关的相对路径，换机恢复才有意义。 */
export function backupRoots(config) {
  const home = dshHome()
  const roots = []
  const sources = config.sources ?? {}

  if (sources.sessions !== false) {
    roots.push({
      key: 'sessions',
      label: '会话记录',
      dir: path.join(home, 'sessions'),
      /** 单文件放行，不做扩展名过滤。 */
      match: () => true,
    })
  }

  if (sources.profileConfig !== false) {
    roots.push({
      key: 'profile',
      label: `插件与配置（profile: ${profileName()}）`,
      dir: profileDir(),
      /**
       * node_modules / .pnpm / .plugin-manager 是安装产物，一台新机器上
       * `dsh plugin add` 会重新装，把它们塞进备份只会让备份膨胀几十倍。
       */
      match: (rel) => {
        const top = rel.split('/')[0]
        if (top === 'node_modules') return false
        if (top.startsWith('.')) return false
        if (rel.startsWith('nutstore-backup/')) return false
        return true
      },
    })
  }

  if (sources.workspaceMemory !== false && typeof config.workspaceDir === 'string' && config.workspaceDir !== '') {
    roots.push({
      key: 'workspace',
      label: '工作区记忆',
      dir: config.workspaceDir,
      /**
       * 只收"记忆类"的东西：memory/ 目录 + 根目录下的几个记忆文件 + 知识图谱。
       * 工作区里的文档/档案属于大文件，按用户选择不进来。
       */
      match: (rel) => {
        if (rel.startsWith('memory/')) return true
        if (rel === 'SOUL.md' || rel === 'USER.md' || rel === 'knowledge-graph.json') return true
        if (rel === '.mcp.json') return true
        return false
      },
    })
  } else if (sources.workspaceMemory !== false) {
    // 解析不出工作区就不要瞎猜：显式记一条"未配置"，让状态页看得出来漏了东西。
    roots.push({ key: 'workspace', label: '工作区记忆（未配置工作区目录）', dir: '', missing: true })
  }

  for (const [index, extra] of (config.extraPaths ?? []).entries()) {
    let stat
    try {
      stat = fs.statSync(extra)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      roots.push({
        key: `extra-${index}`,
        label: `附加目录 ${path.basename(extra)}`,
        dir: extra,
        match: () => true,
      })
    } else if (stat.isFile()) {
      roots.push({
        key: `extra-file-${index}`,
        label: `附加文件 ${path.basename(extra)}`,
        file: extra,
      })
    }
  }

  return roots
}

/** 插件自身源码目录（换机后没有它就无法把插件装回去）。 */
export function pluginSourceDir() {
  // 必须用 fileURLToPath：路径里有空格时 import.meta.url 是 %20 编码的，
  // 直接取 pathname 会指向一个不存在的目录（"My%20Agent"）。
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)))
}

/**
 * 遍历一个根目录，产出相对路径（POSIX 分隔符）。
 * 符号链接不跟随（避免把整个盘卷进来），深度上限 24 层。
 *
 * `prefix` 是"从根目录到当前目录"的相对路径：必须显式往下传，
 * 否则递归里用 path.relative(rootDir, absolute) 得到的是**相对子目录**的路径，
 * 会把 nested/b.jsonl 写成 b.jsonl，并让按前缀匹配的目录（如 memory/）整棵被丢掉。
 */
function walkDirectory(rootDir, match, out, prefix = '', depth = 0) {
  if (depth > 24) return
  let entries
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const absolute = path.join(rootDir, entry.name)
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue
      if (!match(`${relative}/`)) continue
      walkDirectory(absolute, match, out, relative, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    if (!match(relative)) continue
    let stat
    try {
      stat = fs.statSync(absolute)
    } catch {
      continue
    }
    if (stat.size > MAX_FILE_BYTES) continue
    out.push({
      absolute,
      relative,
      size: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
      // 文件身份：给"元数据快路径"用，识别"换了文件但大小与 mtime 恰好相同"的情况。
      dev: typeof stat.dev === 'number' ? stat.dev : undefined,
      ino: typeof stat.ino === 'number' ? stat.ino : undefined,
    })
  }
}

/**
 * 扫描出这一轮要备份的全部文件。
 * @returns {{ files: Array<{absolute,relative,size,mtimeMs,root,rootKey}>, skipped: Array<{path,reason}>, roots: Array<{key,label,dir,file,count,bytes}> }}
 */
export function scanBackupFiles(config) {
  const files = []
  const skipped = []
  const roots = backupRoots(config)
  // 插件源码单独处理：它可能在 node_modules 里（安装产物），也可能在开发目录里。
  if (config.sources?.pluginSource !== false) {
    const source = pluginSourceDir()
    roots.push({ key: 'pluginsrc', label: '插件源码（本插件）', dir: source, match: () => true, internal: true })
  }

  const summary = []
  for (const root of roots) {
    const bucket = []
    if (typeof root.dir === 'string') {
      if (!fs.existsSync(root.dir)) {
        summary.push({ key: root.key, label: root.label, dir: root.dir, count: 0, bytes: 0, missing: true })
        continue
      }
      walkDirectory(root.dir, root.match ?? (() => true), bucket)
    } else if (typeof root.file === 'string') {
      try {
        const stat = fs.statSync(root.file)
        if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
          bucket.push({ absolute: root.file, relative: path.basename(root.file), size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) })
        } else {
          skipped.push({ path: root.file, reason: stat.size > MAX_FILE_BYTES ? '超过单文件上限' : '不是普通文件' })
        }
      } catch {
        skipped.push({ path: root.file, reason: '读不到' })
      }
    }
    let bytes = 0
    for (const item of bucket) {
      bytes += item.size
      // 相对路径带上根 key，换机恢复时才能重新映射回本机路径
      // （pluginSourceDir 这种根目录的绝对路径在别的机器上毫无意义）。
      files.push({ ...item, relative: `${root.key}/${item.relative}`, rootKey: root.key, rootLabel: root.label })
    }
    summary.push({ key: root.key, label: root.label, dir: root.dir ?? root.file, count: bucket.length, bytes })
  }

  return { files, skipped, roots: summary }
}

/** 备份数据总览：给设置页显示"本次会传多少、多少文件"。 */
export function describeBackupPlan(config) {
  const scanned = scanBackupFiles(config)
  return {
    machine: config.machine,
    files: scanned.files.length,
    bytes: scanned.files.reduce((total, file) => total + file.size, 0),
    roots: scanned.roots,
    skipped: scanned.skipped,
    workspaceDir: config.workspaceDir,
    configPath: path.join(configDir(), 'config.json'),
  }
}
