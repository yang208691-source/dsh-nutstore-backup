/**
 * 路由与共享辅助：**host 半区（lib/index.mjs）和独立验证服务器（lib/server.mjs）
 * 共用同一份逻辑**，避免"能跑的那个"和"装进 DSH 的那个"分叉。
 *
 * buildRouteHandlers(ctx) 返回 { '/dsh-nutstore/xxx': handler(req, res, body) }，
 * handler 只管业务，不写响应头——响应封装由调用方负责（DSH 走 webServer.register，
 * 独立服务器走 node:http）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebDavClient, DavError } from './webdav.mjs'
import {
  configDir,
  dshHome,
  loadConfig,
  profileDir,
  profileName,
  saveConfig,
} from './config.mjs'
import { describeBackupPlan } from './plan.mjs'
import {
  MANIFEST_NAME,
  listRemoteMachines,
  readManifest,
  remoteDir,
  runBackup,
  runRestore,
} from './backup.mjs'
import {
  PASSWORD_REF,
  clearPassword,
  describePassword,
  loadPassword,
  savePassword,
} from './credential.mjs'

export const PLUGIN_ID = 'dsh-nutstore-backup'
/** 路由前缀：与包名一致，界面和诊断日志能一眼对上。 */
export const ROUTE_PREFIX = '/dsh-nutstore'

/**
 * 运行版本探针：取几个核心源文件 mtime 的最大值做一个短指纹。
 *
 * 为什么需要：host 半区**不会热加载**——改了磁盘上的代码但没重启时，运行中的进程仍是旧代码。
 * 这会让人把"代码里的 bug"和"跑的是旧代码"混在一起（我自己就踩过：恢复路径映射明明修好了，
 * 实测仍报 50 个失败，因为那次重启发生在修复之前）。有了指纹，`/state` 与设置页能直接说清
 * 当前跑的是哪一份，不必靠猜。
 */
export const BUILD_FINGERPRINT = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const files = ['index.mjs', 'routes.mjs', 'backup.mjs', 'webdav.mjs', 'plan.mjs', 'config.mjs', 'credential.mjs']
    const stamps = files.map((file) => {
      try {
        return Math.trunc(fs.statSync(path.join(here, file)).mtimeMs)
      } catch {
        return 0
      }
    })
    const newest = Math.max(...stamps)
    return {
      files: files.length,
      newestMs: newest,
      newestAt: newest === 0 ? 'unknown' : new Date(newest).toISOString(),
      /** 短指纹：同一份代码两次启动得到同一个值，改过任何一个文件就会变。 */
      short: newest === 0 ? 'unknown' : (newest % 0xffffff).toString(16).padStart(6, '0'),
    }
  } catch {
    return { files: 0, newestMs: 0, newestAt: 'unknown', short: 'unknown' }
  }
})()

/** 当前可用的备份源摘要（设置页用）。 */
export function sourceSummary(config) {
  const plan = describeBackupPlan(config)
  return {
    machine: config.machine,
    server: config.server,
    account: config.account,
    remoteRoot: config.remoteRoot,
    remoteDir: remoteDir(config),
    workspaceDir: config.workspaceDir,
    profile: profileName(),
    profileDir: profileDir(),
    dshHome: dshHome(),
    configDir: configDir(),
    files: plan.files,
    bytes: plan.bytes,
    roots: plan.roots,
    skipped: plan.skipped,
  }
}

/** 组一个已登录的客户端；没登录就抛可读错误。 */
export async function requireClient(ctx, config) {
  const account = typeof config.account === 'string' ? config.account.trim() : ''
  if (account === '') throw new Error('还没填坚果云账号（邮箱/手机号）。请到 设置 → 坚果云备份 里登录。')
  const { password, source } = await loadPassword(ctx)
  if (password === undefined) {
    throw new Error(`还没有坚果云应用密码。请到 设置 → 坚果云备份 里填写（也可以把 ${PASSWORD_REF} 放进环境变量）。`)
  }
  const client = new WebDavClient({ server: config.server, account, password })
  return { client, passwordSource: source }
}

/** 去掉不该回传给浏览器的字段（密码永远不出去）。 */
export async function publicStatus(ctx, config) {
  const password = await describePassword(ctx)
  // 登录态只有一个事实来源：密码记录是否存在。凭据服务不可用时看明文回退文件。
  let loggedIn = password.configured === true
  if (password.service !== 'available') {
    const loaded = await loadPassword(ctx)
    loggedIn = loaded.password !== undefined
  }
  return {
    ok: true,
    plugin: PLUGIN_ID,
    loggedIn,
    /** 当前运行的代码指纹：改了插件源码但没重启时，这里不会变（host 半区不热加载）。 */
    build: BUILD_FINGERPRINT,
    /** 已登录时把账号一起回给界面："已登录 · 邮箱"能让用户一眼认得出用的是哪个号。 */
    account: typeof config.account === 'string' ? config.account : '',
    password,
    config,
    sources: sourceSummary(config),
  }
}

/** 判断请求是否来自本机（写操作一律只允许本机）。 */
export function isLoopbackRequest(req) {
  const host = String(req.headers.host ?? '').toLowerCase()
  const address = req.socket?.remoteAddress ?? ''
  const loopbackAddress = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!loopbackAddress) return false
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

/** 读 JSON 请求体（上限 1MB）。 */
export function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 构造全部路由处理器。
 * @param ctx 宿主上下文（只需要可选的 `get('credentials')`；缺省也能工作，会走明文回退）
 * @returns Record<path, { mutating: boolean, handle: (body, req) => Promise<object> }>
 */
export function buildRouteHandlers(ctx) {
  return {
    [`${ROUTE_PREFIX}/state`]: {
      mutating: false,
      async handle() {
        const config = loadConfig()
        return await publicStatus(ctx, config)
      },
    },

    [`${ROUTE_PREFIX}/plan`]: {
      mutating: false,
      async handle() {
        const config = loadConfig()
        return { sources: sourceSummary(config), manifestName: MANIFEST_NAME }
      },
    },

    [`${ROUTE_PREFIX}/password`]: {
      mutating: true,
      async handle(body) {
        const action = String(body.action ?? '')
        if (action === 'clear') {
          await clearPassword(ctx)
          return { cleared: true, password: await describePassword(ctx) }
        }
        const password = typeof body.password === 'string' ? body.password : ''
        if (password === '') throw new Error('应用密码不能为空')
        const patch = {}
        if (typeof body.account === 'string' && body.account.trim() !== '') patch.account = body.account.trim()
        if (typeof body.server === 'string' && body.server.trim() !== '') patch.server = body.server.trim()
        if (Object.keys(patch).length > 0) saveConfig(patch)
        const storedAt = await savePassword(ctx, password)
        let checked = false
        let checkError
        let server
        try {
          const config = loadConfig()
          const client = new WebDavClient({ server: config.server, account: config.account, password })
          const check = await client.check()
          checked = true
          server = check.server
        } catch (error) {
          checkError = error instanceof Error ? error.message : String(error)
        }
        return { storedAt, checked, checkError, server, password: await describePassword(ctx) }
      },
    },

    [`${ROUTE_PREFIX}/config`]: {
      mutating: true,
      async handle(body) {
        const config = saveConfig(body.patch ?? {})
        return { config, sources: sourceSummary(config) }
      },
    },

    [`${ROUTE_PREFIX}/test`]: {
      mutating: false,
      async handle(body) {
        const config = loadConfig()
        const account = (typeof body.account === 'string' && body.account.trim() !== '' ? body.account.trim() : config.account)
        let password = typeof body.password === 'string' ? body.password : ''
        let source = '表单输入的密码（未保存）'
        if (password === '') {
          const stored = await loadPassword(ctx)
          password = stored.password ?? ''
          source = stored.source
        }
        if (account === '') throw new Error('请先填写坚果云账号')
        if (password === '') throw new Error('请先填写应用密码')
        const server = typeof body.server === 'string' && body.server.trim() !== '' ? body.server.trim() : config.server
        const client = new WebDavClient({ server, account, password })
        const check = await client.check()
        const info = await client.stat(config.remoteRoot)
        return {
          checked: true,
          server,
          account,
          passwordSource: source,
          remoteRoot: config.remoteRoot,
          remoteRootExists: info !== undefined,
          ms: check.ms,
        }
      },
    },

    [`${ROUTE_PREFIX}/backup`]: {
      mutating: true,
      async handle(body) {
        const config = loadConfig()
        const { client, passwordSource } = await requireClient(ctx, config)
        const result = await runBackup({ client, config, force: body.force === true })
        return {
          ok: result.ok,
          dir: result.dir,
          uploaded: result.uploaded,
          skipped: result.skipped,
          uploadedBytes: result.uploadedBytes,
          scannedFiles: result.scanned.files,
          failed: result.failed.slice(0, 50),
          roots: result.scanned.roots,
          ms: result.ms,
          passwordSource,
        }
      },
    },

    [`${ROUTE_PREFIX}/restore`]: {
      mutating: true,
      async handle(body) {
        const config = loadConfig()
        const { client } = await requireClient(ctx, config)
        const result = await runRestore({
          client,
          config,
          sourceMachine: typeof body.sourceMachine === 'string' && body.sourceMachine.trim() !== '' ? body.sourceMachine.trim() : undefined,
          mode: body.mode === 'missing' ? 'missing' : 'all',
          dryRun: body.dryRun === true,
        })
        return {
          ok: result.ok,
          dir: result.dir,
          machine: result.machine,
          createdAt: result.createdAt,
          mode: result.mode,
          dryRun: result.dryRun,
          restoredCount: result.restored.length,
          skippedCount: result.skipped.length,
          /**
           * 按性质拆开统计：只报"会恢复 N 条"会把"新建"与"覆盖"混在一起。
           * 实测误导过一次——35 条里其实只有 1 条是真覆盖，其余是本机还没有的文件。
           */
          counts: result.counts,
          restored: result.restored.slice(0, 200),
          skipped: result.skipped.slice(0, 200),
          failed: result.failed.slice(0, 50),
          ms: result.ms,
        }
      },
    },

    [`${ROUTE_PREFIX}/machines`]: {
      mutating: false,
      async handle() {
        const config = loadConfig()
        const { client } = await requireClient(ctx, config)
        const machines = await listRemoteMachines(client, config)
        const detailed = []
        for (const machine of machines) {
          const manifest = await readManifest(client, { ...config, machine: machine.name, perMachineDir: true })
          detailed.push({
            machine: machine.name,
            modified: machine.modified,
            files: manifest?.stats?.files ?? null,
            bytes: manifest?.stats?.bytes ?? null,
            createdAt: manifest?.createdAt ?? null,
          })
        }
        return { remoteRoot: config.remoteRoot, machines: detailed }
      },
    },
  }
}

/**
 * 把处理器包成 DSH webServer 需要的 (req, res)：负责方法体读取、本机校验、JSON 输出。
 * @param handlers buildRouteHandlers() 的结果
 * @param path 路由路径
 */
export function wrapRouteHandler(handlers, path) {
  const route = handlers[path]
  if (route === undefined) throw new Error(`unknown route ${path}`)
  return async (req, res) => {
    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(payload))
    }
    try {
      if (route.mutating === true && !isLoopbackRequest(req)) {
        json(403, { ok: false, error: '只允许从本机操作（防止跨站请求写入你的坚果云凭据）' })
        return
      }
      const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readJsonBody(req)
      const result = await route.handle(body, req)
      json(200, { ok: true, ...result })
    } catch (error) {
      json(200, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        status: error instanceof DavError ? error.status : undefined,
        hint: error instanceof DavError ? error.hint : undefined,
      })
    }
  }
}

/** 把工具返回值渲染成一段文本（结构化值仍在 value 里，模型能读到）。 */
export function renderToolText(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

/** 统一工具定义：参数 + JSON 输出 schema + 文本渲染。 */
export function defineNutstoreTool(definition) {
  return {
    ...definition,
    output: {
      schema: definition.outputSchema,
      render: (_args, value) => renderToolText(value),
    },
  }
}
