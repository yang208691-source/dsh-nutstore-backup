/**
 * 独立验证服务器：**不需要重启 DSH**，用同一个 web 界面把真实坚果云往返跑一遍。
 *
 * 它和插件共用 lib/routes.mjs、lib/backup.mjs、lib/webdav.mjs —— 也就是"装进 DSH 的那份代码"
 * 本身，不是另一套实现。用来在重启前先验证：账号/应用密码对不对、能不能上传、能不能恢复。
 *
 *   node lib/server.mjs                 # http://127.0.0.1:19731
 *   node lib/server.mjs --port 19999
 *   node lib/server.mjs --open          # 顺手打开浏览器
 *   node lib/server.mjs --data-dir D:\My Agent    # 覆盖工作区目录（默认按 DSH 注册表解析）
 *   node lib/server.mjs --credentials-file <path> # 指定凭据文件（默认 $DSH_HOME/.credentials.yaml）
 *   node lib/server.mjs --no-credentials-bridge   # 不碰凭据库，密码走 0600 明文回退文件
 *
 * 凭据桥（默认开启）：本插件**已保存账号**时，页面里填的密码会按 dsh-credentials-local
 * 的真实文档格式写进 `<credentials-file>`，记录地址 `nutstore-backup/app-password`
 * ——也就是插件读的同一个记录。写前备份原文件、序列化后严格回读、写后再回读一次，
 * 对不上就自动还原，绝不留下半坏的文件。
 *
 * 安全：只监听回环地址；写接口沿用插件的"仅本机"校验；密码只写不读、不回显；
 * 页面与接口都不接受外部来源的请求。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig, saveConfig } from './config.mjs'
import { CREDENTIAL_RECORD, createCredentialBridge } from './credential-store.mjs'
import { parseWorkspaceOverride, renderVerificationPage } from './verify-page.mjs'

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** 解析命令行参数。 */
function parseArgs(argv) {
  const options = { port: 19731, host: '127.0.0.1', open: false, dataDir: undefined, bridge: true, credentialsFile: undefined, account: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--port' && argv[index + 1] !== undefined) { options.port = Number(argv[index + 1]); index += 1; continue }
    if (arg === '--host' && argv[index + 1] !== undefined) { options.host = String(argv[index + 1]); index += 1; continue }
    if (arg === '--data-dir' && argv[index + 1] !== undefined) { options.dataDir = String(argv[index + 1]); index += 1; continue }
    if (arg === '--account' && argv[index + 1] !== undefined) { options.account = String(argv[index + 1]).trim(); index += 1; continue }
    if (arg === '--credentials-file' && argv[index + 1] !== undefined) { options.credentialsFile = String(argv[index + 1]); index += 1; continue }
    if (arg === '--open') { options.open = true; continue }
    if (arg === '--no-credentials-bridge') { options.bridge = false; continue }
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
if (options.help === true) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/u, '').trim())
  process.exit(0)
}

// 宿主 ctx 替身：能拿到凭据服务（桥）就用它，否则插件会走 0600 明文回退并在界面标注。
// 桥**按需惰性构建**并在每次取用时重新判断"是否该写凭据库"：
// 页面上的"保存配置 + 存密码"是两次请求，账号是在前一次才落盘的，
// 启动时就把桥定死会导致第一次登录写不进凭据库。
let bridgeCache
function currentCredentialService() {
  if (options.bridge === false) return { unsupported: true, reason: '命令行用了 --no-credentials-bridge' }
  if (bridgeCache !== undefined) return bridgeCache
  let account = typeof options.account === 'string' ? options.account : ''
  if (account === '') {
    try {
      account = String(loadConfig().account ?? '').trim()
    } catch {
      account = ''
    }
  }
  if (account === '') {
    return {
      unsupported: true,
      reason: `还不知道本插件用的坚果云账号（${path.join(process.env.DSH_HOME ?? '.', 'nutstore-backup', 'config.json')} 里 account 为空）；用 --account <邮箱> 指定，或先在页面上点「保存配置 + 存密码」，为安全起见不猜账号去写凭据库`,
    }
  }
  bridgeCache = createCredentialBridge({
    profileDir: process.env.DSH_PROFILE_DIR ?? path.join(process.env.DSH_HOME ?? '.', 'profiles', 'desktop'),
    ...(options.credentialsFile === undefined ? {} : { file: path.resolve(options.credentialsFile) }),
  })
  return bridgeCache
}

const ctx = {
  get(name) {
    if (name !== 'credentials') return undefined
    const service = currentCredentialService()
    return service.unsupported === true ? undefined : service
  },
}

if (typeof options.dataDir === 'string' && options.dataDir.trim() !== '') {
  const override = parseWorkspaceOverride(options.dataDir)
  // 会话内先钉住（即使配置文件写不进去也生效），再尝试持久化。
  process.env.NUTSTORE_WORKSPACE_DIR = override
  try {
    const saved = saveConfig({ workspaceDir: override })
    console.log(`工作区目录已覆盖为：${saved.workspaceDir}`)
  } catch (error) {
    console.warn(`警告：没能把工作区目录写进配置文件（${error instanceof Error ? error.message : String(error)}）`)
    console.warn('      本次会话仍会用它当工作区；只是不会持久化。')
  }
}

const { buildRouteHandlers, wrapRouteHandler } = await import('./routes.mjs')
const handlers = buildRouteHandlers(ctx)

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${options.host}:${options.port}`)

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = renderVerificationPage({
      port: options.port,
      packageRoot,
      credential: (() => {
        const service = currentCredentialService()
        return service.unsupported === true
          ? { mode: 'plaintext', reason: service.reason }
          : { mode: 'store', file: service.file, record: CREDENTIAL_RECORD }
      })(),
    })
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(html)
    return
  }

  if (handlers[url.pathname] === undefined) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: `未知路径 ${url.pathname}` }))
    return
  }

  wrapRouteHandler(handlers, url.pathname)(req, res)
})

// 只监听回环地址：这个服务器持有你的坚果云访问能力，绝不能暴露到局域网。
server.listen(options.port, options.host, () => {
  const address = `http://${options.host}:${options.port}`
  const config = loadConfig()
  console.log('坚果云备份 · 独立验证服务器（与插件共用同一份代码）')
  console.log(`  页面：${address}`)
  console.log(`  工作区：${config.workspaceDir === '' ? '(未解析出，可在页面里填)' : config.workspaceDir}`)
  console.log(`  配置：${path.join(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '.', '.dsh'), 'nutstore-backup')}`)
  const atStartup = currentCredentialService()
  if (atStartup.unsupported === true) {
    console.log(`  密码去向：${atStartup.reason}`)
    console.log('            → 退化为 0600 明文文件，页面会如实标注；在页面上先点「保存配置 + 存密码」即可写入凭据库')
  } else {
    console.log('  密码去向：DSH 凭据库（与插件同一个记录地址）')
    console.log(`            文件：${atStartup.file}`)
    console.log(`            记录：${CREDENTIAL_RECORD}`)
    console.log('            写前会备份原文件，且序列化后会严格回读校验，失败不落盘。')
  }
  if (options.open === true) {
    import('node:child_process').then(({ spawn }) => {
      spawn('cmd', ['/c', 'start', '', address], { stdio: 'ignore', detached: true, windowsHide: true }).unref()
    })
  }
})

process.on('SIGINT', () => {
  console.log('\n已停止验证服务器。')
  server.close(() => process.exit(0))
})
