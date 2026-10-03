/**
 * 持久化配置：非机密字段写 JSON，机密（坚果云应用密码）优先交给宿主 credentials 服务。
 *
 * 为什么两套：DSH 的 `credentials` 服务是抽象服务，是否可用取决于 profile 组成了哪个实现
 * （`@deepseek-ai/dsh-credentials-local` 一般都在）。它可用时密码进凭据库、不落明文；
 * 不可用时退化为受限权限的文件，并且在状态里显式告诉用户"当前是明文"，绝不假装加密。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** DSH 主目录（宿主注入的环境变量优先，回退到 ~/.dsh）。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

/** 本 profile 目录：DSH_PROFILE_DIR 优先，其次 DSH_HOME/profiles/<name>。 */
export function profileDir() {
  const explicit = process.env.DSH_PROFILE_DIR
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit.trim())
  const name = process.env.DSH_PROFILE || 'desktop'
  return path.join(dshHome(), 'profiles', name)
}

/** 当前 profile 名（只用于展示与默认值）。 */
export function profileName() {
  const name = process.env.DSH_PROFILE
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : 'desktop'
}

/**
 * 换机迁移时的默认工作区。
 *
 * 可信来源按优先级：
 *  ① `DSH_SESSION_CWD`：DSH 注入的会话工作目录，最准；
 *  ② 宿主进程的 `process.cwd()`，**但当且仅当**它不在 DSH 内部目录里（见 isDshInternalPath）；
 *  ③ `$DSH_HOME/storages/workspace.json` 注册表里的工作区，按「里面真有可备份的记忆」>「会话数」排序；
 *  ④ 都拿不到就返回 undefined —— 交给调用方留空并跳过工作区。
 *
 * 为什么不一味听 `defaultWorkspaceId`：实测这台机器上它指向
 * `C:\Users\yang2\Documents\deepseek-harness\default-workspace`，那个目录**是空的**，
 * 而用户真正在用的 `D:\My Agent` 里才有 memory/、SOUL.md、USER.md、knowledge-graph.json。
 * 听默认值会导致"备份成功但工作区记忆一个文件都没传"。
 *
 * 为什么不用 process.cwd() 直接兜底：宿主进程的 cwd 可能是 profile 目录，
 * 拿它当工作区会把 profile 再备份一遍、同时静默漏掉真正的记忆。
 */
export function resolveWorkspaceDir() {
  const fromEnv = process.env.DSH_SESSION_CWD
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())

  const cwd = process.cwd()
  if (!isDshInternalPath(cwd) && looksLikeWorkspace(cwd)) return path.resolve(cwd)

  const candidates = workspaceCandidates()
  if (candidates.length === 0) {
    // 最后退一步：cwd 不在 DSH 内部目录里就用它，总比没有强（但仍拒绝 DSH 内部目录）。
    return isDshInternalPath(cwd) || path.parse(cwd).root === cwd ? undefined : path.resolve(cwd)
  }
  return path.resolve(candidates[0].path)
}

/** 路径是否落在 DSH 自己的目录里（那些目录绝不是"用户工作区"）。 */
export function isDshInternalPath(candidate) {
  const target = path.resolve(candidate).toLowerCase()
  const internals = [dshHome(), profileDir(), path.join(dshHome(), 'sessions'), path.join(dshHome(), 'storages'), path.join(dshHome(), 'attachments')]
    .map(entry => path.resolve(entry).toLowerCase())
  return internals.some(internal => target === internal || target.startsWith(`${internal}${path.sep}`))
}

/** 目录里是否有本插件要备份的记忆类内容。 */
export function looksLikeWorkspace(dir) {
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false
  } catch {
    return false
  }
  for (const entry of ['memory', 'SOUL.md', 'USER.md', 'knowledge-graph.json', '.mcp.json']) {
    try {
      if (fs.existsSync(path.join(dir, entry))) return true
    } catch {
      // 读不到的条目当作没有。
    }
  }
  return false
}

/** 注册表里的工作区，按"有记忆" > "会话数" > "最近更新"排序。 */
function workspaceCandidates() {
  const registry = readJson(path.join(dshHome(), 'storages', 'workspace.json'))
  const workspaces = registry?.tables?.workspaces
  if (workspaces === null || typeof workspaces !== 'object') return []
  return Object.entries(workspaces)
    .map(([id, value]) => ({
      id,
      path: typeof value?.path === 'string' ? value.path.trim() : '',
      sessions: Array.isArray(value?.sessionIds) ? value.sessionIds.length : 0,
      updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : '',
    }))
    .filter(entry => entry.path !== '' && !isDshInternalPath(entry.path))
    .map(entry => ({ ...entry, hasMemory: looksLikeWorkspace(entry.path) }))
    .sort((left, right) => {
      if (left.hasMemory !== right.hasMemory) return left.hasMemory ? -1 : 1
      if (left.sessions !== right.sessions) return right.sessions - left.sessions
      return right.updatedAt.localeCompare(left.updatedAt)
    })
}

/** 配置目录：放在 DSH_HOME 下，跟会话一样属于"要跟着人走"的数据。 */
export function configDir() {
  return path.join(dshHome(), 'nutstore-backup')
}

export function configPath() {
  return path.join(configDir(), 'config.json')
}

/** 明文回退时的密码文件（仅当凭据服务不可用）。 */
export function secretFallbackPath() {
  return path.join(configDir(), 'secret.json')
}

/** 远端默认根目录（坚果云里的一级目录）。 */
export const DEFAULT_REMOTE_ROOT = '/dsh-backup'

/**
 * 单文件上限，超过就不进备份。会话 jsonl 与配置都很小，这个上限只是防止
 * 用户误把工作区大文件拖进备份。
 */
export const MAX_FILE_BYTES = 64 * 1024 * 1024

/** 打包时按前缀排除的目录名（相对某个根目录的任意一层）。 */
export const EXCLUDED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.pnpm',
  '.cache',
  'cache',
  'tmp',
  'temp',
  '.dsh-market',
  '.plugin-manager',
  'dsh-runtimes',
])

/** 机器名：优先配置，其次 hostname，最后 'machine'。 */
export function defaultMachineName() {
  const host = os.hostname()
  const cleaned = typeof host === 'string' ? host.trim().replace(/[^A-Za-z0-9._-]+/gu, '-') : ''
  return cleaned === '' ? 'machine' : cleaned
}

/** 默认配置。所有路径都是"这一台机器上"的，恢复时可以改写。 */
export function defaultConfig() {
  const home = dshHome()
  return {
    version: 1,
    server: 'https://dav.jianguoyun.com/dav',
    account: '',
    remoteRoot: DEFAULT_REMOTE_ROOT,
    machine: defaultMachineName(),
    /** 让"备份/恢复"带上远端目录名前缀的机器标签；关掉则所有机器共用一个目录。 */
    perMachineDir: true,
    /** 备份源。switches 关掉后不再打包对应数据。 */
    sources: {
      sessions: true,
      profileConfig: true,
      workspaceMemory: true,
      pluginSource: true,
    },
    /**
     * 工作区根目录（备份 memory/、SOUL.md 等）。解析不出来时留空字符串，
     * 由 plan.mjs 跳过工作区根 —— 不用 process.cwd() 兜底，见 resolveWorkspaceDir()。
     */
    workspaceDir: resolveWorkspaceDir() ?? '',
    /** 额外整目录/整文件（绝对路径），交给用户按需添加。 */
    extraPaths: [],
    /** 原子控制的最大并发上传数。坚果云对并发较敏感，默认压到 3。 */
    concurrency: 3,
    /** 恢复前是否把被覆盖的本地文件备份到 .dsh/nutstore-backup/restore-trash。 */
    restoreTrash: true,
    /**
     * 增量是否走"元数据快路径"：大小 + mtime + 文件身份(dev/ino) 都没变，就不读文件、直接跳过。
     * 默认开（文件多或会话文件大时省掉主要 I/O）；要"绝不漏"就设 false，回到每轮全量算哈希。
     */
    trustFileMetadata: true,
    updatedAt: null,
  }
}

/** 把任意输入收敛成合法配置（未知字段丢弃、类型不对就回默认）。 */
export function normalizeConfig(raw) {
  const base = defaultConfig()
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const out = { ...base }
  if (typeof input.server === 'string' && input.server.trim() !== '') out.server = input.server.trim().replace(/\/+$/u, '')
  if (typeof input.account === 'string') out.account = input.account.trim()
  if (typeof input.remoteRoot === 'string' && input.remoteRoot.trim() !== '') {
    const root = input.remoteRoot.trim()
    out.remoteRoot = root.startsWith('/') ? root.replace(/\/+$/u, '') : `/${root.replace(/\/+$/u, '')}`
  }
  if (typeof input.machine === 'string' && input.machine.trim() !== '') {
    out.machine = input.machine.trim().replace(/[^A-Za-z0-9._-]+/gu, '-')
  }
  if (typeof input.perMachineDir === 'boolean') out.perMachineDir = input.perMachineDir
  if (typeof input.concurrency === 'number' && Number.isFinite(input.concurrency)) {
    out.concurrency = Math.min(8, Math.max(1, Math.trunc(input.concurrency)))
  }
  if (typeof input.restoreTrash === 'boolean') out.restoreTrash = input.restoreTrash
  if (typeof input.trustFileMetadata === 'boolean') out.trustFileMetadata = input.trustFileMetadata
  if (typeof input.workspaceDir === 'string' && input.workspaceDir.trim() !== '') {
    const candidate = path.resolve(input.workspaceDir.trim())
    // 旧版本（或任何把 cwd 当工作区的来源）可能写过 profile 目录 / DSH 主目录 itself；
    // 那种值只会把 profile 再备份一遍、还漏掉真正的记忆，所以判为无效并回退到重新解析。
    const bogus = [path.resolve(dshHome()), path.resolve(profileDir())].some(dir => dir.toLowerCase() === candidate.toLowerCase())
    if (!bogus) out.workspaceDir = candidate
  }

  if (input.sources !== null && typeof input.sources === 'object') {
    for (const key of Object.keys(base.sources)) {
      const value = input.sources[key]
      if (typeof value === 'boolean') out.sources[key] = value
    }
  }

  if (Array.isArray(input.extraPaths)) {
    out.extraPaths = input.extraPaths
      .filter(entry => typeof entry === 'string' && entry.trim() !== '')
      .map(entry => path.resolve(entry.trim()))
      .slice(0, 64)
  }

  if (typeof input.updatedAt === 'string') out.updatedAt = input.updatedAt

  /**
   * 会话级覆盖：独立验证服务器用 --data-dir 时先把它钉进环境变量，
   * 这样即使配置文件写不进去（$DSH_HOME 只读），本次会话也用对的工作区。
   */
  const override = process.env.NUTSTORE_WORKSPACE_DIR
  if (typeof override === 'string' && override.trim() !== '') {
    const candidate = path.resolve(override.trim())
    if (!isDshInternalPath(candidate)) out.workspaceDir = candidate
  }
  return out
}

/** 原子写 JSON（先写临时文件再 rename，避免半个文件）。 */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** 读 JSON，失败返回 undefined。 */
export function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** 读取配置（不存在则给默认值）。 */
export function loadConfig() {
  return normalizeConfig(readJson(configPath()))
}

/** 保存配置，返回落盘后的规范值。 */
export function saveConfig(patch) {
  const current = loadConfig()
  const merged = normalizeConfig({ ...current, ...(patch !== null && typeof patch === 'object' ? patch : {}) })
  merged.updatedAt = new Date().toISOString()
  writeJsonAtomic(configPath(), merged)
  return merged
}

/**
 * 把远端相对路径编码成单层文件名：避免 `/` 带来的建目录与中文路径问题，
 * 且天然唯一（同一路径必得同一名字）。URL-safe base64，无填充。
 */
export function encodeRemoteName(relPath) {
  return Buffer.from(relPath, 'utf8').toString('base64url')
}

/** 反向解码（恢复时校验用）。 */
export function decodeRemoteName(name) {
  try {
    return Buffer.from(name, 'base64url').toString('utf8')
  } catch {
    return undefined
  }
}
