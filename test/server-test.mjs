/**
 * 独立验证服务器测试：真的把它当进程起起来，用 HTTP 走一遍页面与接口。
 *
 * 覆盖：
 *   ① 进程能启动，`/` 返回带表单的 HTML，`/dsh-nutstore/state` 可用；
 *   ② 页面与插件共用同一套路由（同一份 routes.mjs）；
 *   ③ 通过页面用到的接口完成：改配置 → 存密码 → 测试连接（对本地 mock DAV）→ 备份 → 列机器 → 预览恢复 → 恢复；
 *   ④ 只监听回环地址（用非回环 Host 头模拟伪造来源被 403 拒）。
 *
 * 用法：node test/server-test.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.dirname(here)

const failures = []
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(`${label} ${detail}`)
    console.log(`  FAIL  ${label} ${detail}`)
  }
}

// ── 隔离环境 ──────────────────────────────────────────────────────────────────
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nsb-server-'))
const dshHome = path.join(sandbox, '.dsh')
const workspace = path.join(sandbox, 'workspace')
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
write(path.join(dshHome, 'sessions', 'a.jsonl'), '{"a":1}\n')
write(path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'), '- id: x\n')
write(path.join(workspace, 'memory', 'FACT.md'), '# facts\n')
write(path.join(workspace, 'SOUL.md'), '# soul\n')

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

// ── mock WebDAV（够真：支持 PROPFIND/MKCOL/PUT/GET/DELETE + Basic 认证） ───────
const store = new Map([['/', Buffer.alloc(0)]])
const dav = http.createServer((req, res) => {
  const method = req.method ?? 'GET'
  if (!String(req.headers.authorization ?? '').startsWith('Basic ')) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="mock"' })
    res.end('unauthorized')
    return
  }
  let key = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  if (key.startsWith('/dav')) key = key.slice('/dav'.length)
  if (key === '') key = '/'
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    if (method === 'PROPFIND') {
      const dirKey = key.endsWith('/') ? key : `${key}/`
      if (key !== '/' && !store.has(dirKey)) { res.writeHead(404); res.end('not found'); return }
      const depth = String(req.headers.depth ?? '1')
      const entries = [{ href: key, collection: true }]
      if (depth !== '0') {
        for (const [storedKey, value] of store) {
          if (storedKey === dirKey || !storedKey.startsWith(dirKey)) continue
          const rest = storedKey.slice(dirKey.length).replace(/\/+$/u, '')
          if (rest === '' || rest.includes('/')) continue
          entries.push({ href: `${dirKey}${rest}`, collection: storedKey.endsWith('/'), size: value.length })
        }
      }
      const xml = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${entries.map(entry => `<D:response><D:href>${entry.href}</D:href><D:propstat><D:prop>${entry.collection ? '<D:resourcetype><D:collection/></D:resourcetype>' : `<D:resourcetype/><D:getcontentlength>${entry.size}</D:getcontentlength>`}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`).join('')}</D:multistatus>`
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' })
      res.end(xml)
      return
    }
    if (method === 'MKCOL') {
      if (store.has(key) || store.has(`${key}/`)) { res.writeHead(405); res.end('exists'); return }
      store.set(`${key}/`, Buffer.alloc(0))
      res.writeHead(201); res.end(); return
    }
    if (method === 'PUT') { store.set(key, body); res.writeHead(201); res.end(); return }
    if (method === 'GET') {
      const value = store.get(key)
      if (value === undefined) { res.writeHead(404); res.end('not found'); return }
      res.writeHead(200, { 'Content-Length': value.length }); res.end(value); return
    }
    if (method === 'DELETE') { store.delete(key); res.writeHead(204); res.end(); return }
    res.writeHead(405); res.end('unsupported')
  })
})
await new Promise((resolve) => dav.listen(0, '127.0.0.1', resolve))
const davUrl = `http://127.0.0.1:${dav.address().port}/dav`

// ── 起独立验证服务器 ──────────────────────────────────────────────────────────
const port = await freePort()
// stdio 用 inherit：DSH 的 Windows 沙箱禁止 Node 通过管道捕获子进程输出（EPERM），
// 让子进程直接打印到本测试的终端即可，不影响断言。
const child = spawn(process.execPath, [
  path.join(pluginDir, 'lib', 'server.mjs'),
  '--port', String(port),
  '--data-dir', workspace,
], {
  env: {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_PROFILE: 'desktop',
    DSH_PROFILE_DIR: path.join(dshHome, 'profiles', 'desktop'),
    DSH_SESSION_CWD: '',
  },
  stdio: 'inherit',
})
const serverLog = '(stdio inherit; 子进程日志直接输出到终端)'

const base = `http://127.0.0.1:${port}`
async function request(pathname, body, headers = {}) {
  const init = body === undefined
    ? { method: 'GET', cache: 'no-store', headers }
    : { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }
  const response = await fetch(`${base}${pathname}`, init)
  const text = await response.text()
  return { status: response.status, text, json: (() => { try { return JSON.parse(text) } catch { return undefined } })() }
}
// 等它起来（最多 10 秒）
let ready = false
for (let attempt = 0; attempt < 50; attempt += 1) {
  try {
    const probe = await request('/dsh-nutstore/state')
    if (probe.status === 200) { ready = true; break }
  } catch { /* 还没起来 */ }
  await new Promise(resolve => setTimeout(resolve, 200))
}

console.log('\n[1] 服务器启动与页面')
check('进程在 10 秒内可服务', ready, serverLog.slice(-400))
const page = await request('/')
check('/ 返回 HTML', page.status === 200 && /<html/u.test(page.text))
check('页面含四个验证步骤', ['1 · 账号与应用密码', '2 · 备份', '3 · 在新机器上恢复', '结果'].every(text => page.text.includes(text)), '')
check('页面含应用密码输入框且是 password 类型', page.text.includes('type="password"'))
check('页面说明了"与插件同一份代码"', page.text.includes('和插件同一份代码'), '')
check('页面含一键打开应用密码教程的按钮', page.text.includes('① 打开坚果云生成应用密码'), '')
check('页面指向已验证可用的教程与账户链接', page.text.includes('help.jianguoyun.com/?p=2064') && page.text.includes('jianguoyun.com/d/account'), '')
check('页面解释了为什么必须用应用密码（Basic-only 实测）', page.text.includes('只认 Basic 认证'), '')
check('密码框支持回车提交', page.text.includes('keydown') && page.text.includes('Enter'), '')

console.log('\n[2] 状态与配置（页面首次加载会调）')
const state = await request('/dsh-nutstore/state')
check('state 返回配置与范围', state.json?.ok === true && state.json.config !== undefined && state.json.sources !== undefined)
check('工作区目录来自 --data-dir 覆盖', state.json?.config?.workspaceDir === workspace, String(state.json?.config?.workspaceDir))
const plan = await request('/dsh-nutstore/plan')
check('plan 能列出备份根', Array.isArray(plan.json?.sources?.roots) && plan.json.sources.roots.length >= 3, JSON.stringify(plan.json?.sources?.roots?.map(r => r.key)))
check('工作区根扫到了 memory/SOUL.md', (plan.json?.sources?.roots?.find(r => r.key === 'workspace')?.count ?? 0) >= 2, JSON.stringify(plan.json?.sources?.roots))

console.log('\n[3] 页面用到的完整链路')
// 启用了凭据桥时，第一次调 /state 时还没有账号 → 页面应如实说是明文回退。
const stateBefore = await request('/dsh-nutstore/state')
const pageBefore = await request('/')
check('没账号时页面如实标注明文回退（不谎称已进凭据库）', pageBefore.text.includes('0600 明文回退文件'), '')
check('没账号时 /state 也报凭据服务不可用', stateBefore.json?.password?.service === 'absent', JSON.stringify(stateBefore.json?.password))

const configured = await request('/dsh-nutstore/config', {
  patch: {
    server: davUrl, account: 'verify@example.com', remoteRoot: '/dsh-verify', machine: 'verify-machine', workspaceDir: workspace,
    sources: { sessions: true, profileConfig: true, workspaceMemory: true, pluginSource: true },
  },
})
check('config 保存成功', configured.json?.ok === true && configured.json.config.machine === 'verify-machine', JSON.stringify(configured.json?.error))

// 账号落盘后再看页面：应当切换为"写 DSH 凭据库"。
const pageAfter = await request('/')
check('有账号后页面改为写明凭据库去向', pageAfter.text.includes('DSH 凭据库') && pageAfter.text.includes('nutstore-backup/app-password'), '')

const stored = await request('/dsh-nutstore/password', { action: 'set', account: 'verify@example.com', server: davUrl, password: 'verify-app-pw' })
check('password 保存并自检通过', stored.json?.ok === true && stored.json?.checked === true, JSON.stringify(stored.json))
check('响应没有回显密码', !stored.text.includes('verify-app-pw'))
// 凭据桥生效的硬证据：记录写进了 .credentials.yaml，且没有落明文回退文件。
const credentialsFile = path.join(dshHome, '.credentials.yaml')
if (fs.existsSync(credentialsFile)) {
  const { createRequire } = await import('node:module')
  const YAML = createRequire('C:\\Users\\yang2\\.dsh\\profiles\\desktop\\package.json')('js-yaml')
  const document = YAML.load(fs.readFileSync(credentialsFile, 'utf8'))
  check('密码写进了 DSH 凭据库（nutstore-backup/app-password）', document?.records?.['nutstore-backup/app-password']?.payload?.password === 'verify-app-pw', JSON.stringify(document))
  check('凭据文档结构合法（version:1 + records）', document?.version === 1 && typeof document.records === 'object', JSON.stringify(document))
  // 这个用例里 .credentials.yaml 原本不存在（全新机器），所以**不该**有备份；
  // 真正存在原文件时会有备份，那条路径由 credential-bridge-test.mjs 覆盖。
  check('原本不存在文件时不产生多余备份', !fs.readdirSync(dshHome).some(name => name.includes('.credentials.yaml.bak-')), fs.readdirSync(dshHome).join(','))
  check('没有留下临时文件', !fs.readdirSync(dshHome).some(name => name.endsWith('.tmp')), fs.readdirSync(dshHome).join(','))
} else {
  check('密码写进了 DSH 凭据库（nutstore-backup/app-password）', false, '没有生成 .credentials.yaml')
}
check('没有落明文回退文件', !fs.existsSync(path.join(dshHome, 'nutstore-backup', 'secret.json')), '')
check('保存后状态显示已配置', (await request('/dsh-nutstore/state')).json?.loggedIn === true, '')

const tested = await request('/dsh-nutstore/test', {})
check('test 连接成功', tested.json?.ok === true && tested.json?.checked === true, JSON.stringify(tested.json))

const backup = await request('/dsh-nutstore/backup', {})
check('backup 真的把文件传上去了', backup.json?.ok === true && backup.json.uploaded > 0, JSON.stringify(backup.json?.failed ?? backup.json?.error))
const second = await request('/dsh-nutstore/backup', {})
check('第二次备份是增量的（0 上传）', second.json?.uploaded === 0, `uploaded=${second.json?.uploaded}`)

const machines = await request('/dsh-nutstore/machines', undefined)
check('machines 能看到 verify-machine', machines.json?.machines?.some(machine => machine.machine === 'verify-machine'), JSON.stringify(machines.json?.machines))

const dirtyFile = path.join(workspace, 'memory', 'FACT.md')
fs.writeFileSync(dirtyFile, 'DIRTY\n')
const dry = await request('/dsh-nutstore/restore', { dryRun: true })
check('dryRun 报告会覆盖 FACT.md', dry.json?.restored?.some(item => item.relative === 'workspace/memory/FACT.md'), JSON.stringify(dry.json?.restored?.map(i => i.relative)))
check('dryRun 没动本地文件', fs.readFileSync(dirtyFile, 'utf8') === 'DIRTY\n')
const restored = await request('/dsh-nutstore/restore', {})
check('真实恢复成功', restored.json?.ok === true && restored.json.restoredCount > 0, JSON.stringify(restored.json?.failed))
check('FACT.md 回到远端内容', fs.readFileSync(dirtyFile, 'utf8') === '# facts\n', JSON.stringify(fs.readFileSync(dirtyFile, 'utf8')))

console.log('\n[4] 只接受本机请求')
// 必须用裸 socket：fetch/undici 不允许调用方覆盖 Host 头，用 fetch 测不出真伪。
const foreign = await new Promise((resolve, reject) => {
  const socket = net.connect(port, '127.0.0.1', () => {
    socket.write([
      'POST /dsh-nutstore/backup HTTP/1.1',
      'Host: evil.example.com',
      'Content-Type: application/json',
      'Content-Length: 2',
      'Connection: close',
      '',
      '{}',
    ].join('\r\n'))
  })
  let text = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => { text += chunk })
  socket.on('end', () => {
    const statusLine = text.split('\r\n')[0] ?? ''
    const match = /HTTP\/1\.1 (\d{3})/u.exec(statusLine)
    resolve({ status: match === null ? 0 : Number(match[1]), text })
  })
  socket.on('error', reject)
})
check('伪造 Host 的写请求被 403 拒绝', foreign.status === 403, `status=${foreign.status} head=${foreign.text.slice(0, 120)}`)
const cleared = await request('/dsh-nutstore/password', { action: 'clear' })
check('清除密码接口可用', cleared.json?.ok === true, JSON.stringify(cleared.json?.error))

// 收尾：Windows 上 child.kill() 未必收得掉整个进程树，用 taskkill /T 兜底，
// 否则会留下一个监听本地端口的孤儿服务器进程（实测发生过）。
try {
  if (process.platform === 'win32') {
    const { spawnSync } = await import('node:child_process')
    spawnSync('taskkill', ['/PID', String(child.pid), '/F', '/T'], { stdio: 'ignore' })
  } else {
    child.kill('SIGKILL')
  }
} catch {
  // 收尾失败不该挡断言流程。
}
await new Promise((resolve) => { dav.close(resolve) })
await new Promise(resolve => setTimeout(resolve, 200))
fs.rmSync(sandbox, { recursive: true, force: true })

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} 项失败：`)
  for (const failure of failures) console.log(`   - ${failure}`)
  process.exitCode = 1
} else {
  console.log('\n✅ 全部通过')
}
// 兜底：残留 handle 不让测试进程挂着。
setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref()
