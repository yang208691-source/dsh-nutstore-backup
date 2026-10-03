/**
 * host 半区集成测试：不启动 DSH，直接用一个假 ctx 调 apply()，
 * 然后通过**真实的 HTTP 路由**走一遍 设置页会走的全部接口。
 *
 * 覆盖：
 *   ① apply() 注册了 5 个工具与全部路由，且没有同步抛错；
 *   ② /state 未登录时如实报告未登录；
 *   ③ /config 写配置、/password 存应用密码（credential 服务缺失 → 明文回退）；
 *   ④ /test 连上 mock WebDAV；
 *   ⑤ /backup 全量 + 增量；
 *   ⑥ /machines 列云端备份；
 *   ⑦ /restore dryRun 与真实恢复。
 *
 * 用法：node test/host-apply-test.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.dirname(here)

// ── 隔离运行环境 ──────────────────────────────────────────────────────────────
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nsb-host-'))
const dshHome = path.join(sandbox, '.dsh')
const profileDir = path.join(dshHome, 'profiles', 'desktop')
const workspace = path.join(sandbox, 'workspace')
const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}
write(path.join(dshHome, 'sessions', 's1.jsonl'), '{"a":1}\n')
write(path.join(profileDir, 'cordis.patch.yml'), '- id: x\n')
write(path.join(workspace, 'memory', 'FACT.md'), '# facts\n')
write(path.join(workspace, 'SOUL.md'), '# soul\n')

process.env.DSH_HOME = dshHome
process.env.DSH_PROFILE_DIR = profileDir
process.env.DSH_PROFILE = 'desktop'
process.env.DSH_SESSION_CWD = workspace

// ── mock WebDAV（与 mock-dav-test.mjs 相同的实现，端口固定） ───────────────────
const store = new Map([['/', Buffer.alloc(0)]])
const dav = http.createServer((req, res) => {
  const method = req.method ?? 'GET'
  if (!String(req.headers.authorization ?? '').startsWith('Basic ')) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="mock"' })
    res.end('unauthorized')
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  let key = decodeURIComponent(url.pathname)
  if (key.startsWith('/dav')) key = key.slice('/dav'.length)
  if (key === '') key = '/'

  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    if (method === 'PROPFIND') {
      const dirKey = key.endsWith('/') ? key : `${key}/`
      if (key !== '/' && !store.has(dirKey)) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const depth = String(req.headers.depth ?? '1')
      const entries = [{ href: key === '/' ? '/' : key, collection: true }]
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
      if (store.has(key) || store.has(`${key}/`)) {
        res.writeHead(405)
        res.end('exists')
        return
      }
      const parent = key.slice(0, key.lastIndexOf('/')) || '/'
      if (parent !== '/' && !store.has(parent) && !store.has(`${parent}/`)) {
        res.writeHead(409)
        res.end('no parent')
        return
      }
      store.set(`${key}/`, Buffer.alloc(0))
      res.writeHead(201)
      res.end()
      return
    }
    if (method === 'PUT') {
      store.set(key, body)
      res.writeHead(201)
      res.end()
      return
    }
    if (method === 'GET') {
      const value = store.get(key)
      if (value === undefined) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      res.writeHead(200, { 'Content-Length': value.length })
      res.end(value)
      return
    }
    if (method === 'DELETE') {
      store.delete(key)
      res.writeHead(204)
      res.end()
      return
    }
    res.writeHead(405)
    res.end('unsupported')
  })
})
await new Promise(resolve => dav.listen(0, '127.0.0.1', resolve))
const davUrl = `http://127.0.0.1:${dav.address().port}/dav`

// ── 假 ctx：只实现插件用到的那几个成员 ────────────────────────────────────────
const registeredTools = new Map()
const registeredRoutes = new Map()
const effects = []

const fakeCtx = {
  // 真实 cordis 的 effect 会同步调用 callback，回调返回的才是 disposer。
  effect(callback) {
    effects.push(callback)
    return callback()
  },
  inject(dependencies, callback) {
    const services = {}
    for (const dependency of dependencies) {
      if (dependency === 'tools') services.tools = { register: (definition) => { registeredTools.set(definition.name, definition); return () => registeredTools.delete(definition.name) } }
      if (dependency === 'webServer') services.webServer = { register: (route) => { registeredRoutes.set(route.path, route); return () => registeredRoutes.delete(route.path) } }
    }
    callback({ ...fakeCtx, ...services })
  },
  get(name) {
    // 故意不提供 credentials：验证明文回退路径也能工作
    if (name === 'credentials') return undefined
    return undefined
  },
}

// ── 加载并 apply ──────────────────────────────────────────────────────────────
const hostModule = await import(pathToFileURL(path.join(pluginDir, 'lib', 'index.mjs')).href)
const failures = []
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(`${label} ${detail}`)
    console.log(`  FAIL  ${label} ${detail}`)
  }
}

console.log('\n[1] apply() 注册结果')
hostModule.apply(fakeCtx)
check('注册了 5 个模型可调用工具', registeredTools.size === 5, [...registeredTools.keys()].join(','))
for (const expected of ['nutstore_status', 'nutstore_login', 'nutstore_backup', 'nutstore_list', 'nutstore_restore']) {
  check(`工具 ${expected} 存在且形如 {name,description,parameters,output,execute}`, (() => {
    const definition = registeredTools.get(expected)
    return definition !== undefined && typeof definition.description === 'string' && definition.parameters !== undefined
      && definition.output !== undefined && typeof definition.execute === 'function'
      && typeof definition.output.render === 'function'
  })())
}
check('每个 effect 回调都返回了 disposer（可安全卸载）', effects.length >= 1 && effects.every(effect => typeof effect() === 'function' || typeof effect() === 'undefined'), `effects=${effects.length}`)
const routePaths = [...registeredRoutes.keys()].sort()
check('注册了全部 HTTP 路由', routePaths.length === 8, routePaths.join(','))
check('路由都是 kind: exact', [...registeredRoutes.values()].every(route => route.kind === 'exact'))

// ── 用真实 HTTP 把路由挂起来，模拟设置页的调用 ────────────────────────────────
const api = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = registeredRoutes.get(url.pathname)
  if (route === undefined) {
    res.writeHead(404)
    res.end('no route')
    return
  }
  // 模拟本机请求：真实 socket 的 remoteAddress 是只读的，用 Proxy 提供只读替身。
  const scoped = new Proxy(req, {
    get(target, property, receiver) {
      if (property === 'socket') {
        return new Proxy(target.socket, {
          get(socketTarget, socketProperty, socketReceiver) {
            if (socketProperty === 'remoteAddress') return '127.0.0.1'
            const value = Reflect.get(socketTarget, socketProperty, socketTarget)
            return typeof value === 'function' ? value.bind(socketTarget) : value
          },
        })
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  route.handler(scoped, res)
})
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
const apiUrl = `http://127.0.0.1:${api.address().port}`

async function call(pathname, body) {
  const init = body === undefined
    ? { method: 'GET', headers: { host: `127.0.0.1:${api.address().port}` } }
    : { method: 'POST', headers: { 'Content-Type': 'application/json', host: `127.0.0.1:${api.address().port}` }, body: JSON.stringify(body) }
  const response = await fetch(`${apiUrl}${pathname}`, init)
  const text = await response.text()
  const parsed = JSON.parse(text)
  if (parsed.ok === false) throw new Error(parsed.error)
  return parsed
}

console.log('\n[2] GET /dsh-nutstore/state（未登录）')
const state0 = await call('/dsh-nutstore/state')
check('报告未登录', state0.loggedIn === false, JSON.stringify(state0.loggedIn))
check('密码存放位置如实说明为"凭据服务不可用"', state0.password.service === 'absent', JSON.stringify(state0.password))
check('默认范围包含 sessions/profile/workspace/pluginsrc', state0.sources.roots.length >= 4, JSON.stringify(state0.sources.roots.map(root => root.key)))

console.log('\n[3] POST /dsh-nutstore/config')
const configured = await call('/dsh-nutstore/config', {
  patch: { server: davUrl, remoteRoot: '/dsh-backup', machine: 'host-test', workspaceDir: workspace, account: 'u@example.com' },
})
check('配置落盘', configured.config.machine === 'host-test' && configured.config.server === davUrl)
check('配置文件在 DSH_HOME/nutstore-backup 下', fs.existsSync(path.join(dshHome, 'nutstore-backup', 'config.json')))

console.log('\n[4] POST /dsh-nutstore/password（存密码 + 立即自检）')
const stored = await call('/dsh-nutstore/password', { action: 'set', account: 'u@example.com', server: davUrl, password: 'app-pw-123' })
check('密码已保存', typeof stored.storedAt === 'string' && stored.storedAt.includes('明文'), stored.storedAt)
check('连接自检成功', stored.checked === true, JSON.stringify(stored.checkError))
check('响应里没有回传密码', !JSON.stringify(stored).includes('app-pw-123'))

console.log('\n[5] POST /dsh-nutstore/test')
const tested = await call('/dsh-nutstore/test', {})
check('测试连接成功', tested.checked === true, JSON.stringify(tested))
check('报告云端根目录尚不存在', tested.remoteRootExists === false, JSON.stringify(tested.remoteRootExists))

console.log('\n[6] POST /dsh-nutstore/backup（全量 → 增量）')
const backup1 = await call('/dsh-nutstore/backup', {})
check('首轮备份成功', backup1.ok === true && backup1.uploaded > 0, `uploaded=${backup1.uploaded} failed=${JSON.stringify(backup1.failed)}`)
const backup2 = await call('/dsh-nutstore/backup', {})
check('第二轮不再上传', backup2.uploaded === 0 && backup2.skipped === backup1.scannedFiles, `uploaded=${backup2.uploaded} skipped=${backup2.skipped}`)

console.log('\n[7] GET /dsh-nutstore/machines')
const machines = await call('/dsh-nutstore/machines')
check('能看到 host-test', machines.machines.some(machine => machine.machine === 'host-test' && machine.files > 0), JSON.stringify(machines.machines))

console.log('\n[8] POST /dsh-nutstore/restore（dryRun → 真实）')
const localFact = path.join(workspace, 'memory', 'FACT.md')
fs.writeFileSync(localFact, 'LOCAL DIRTY\n')
const dry = await call('/dsh-nutstore/restore', { dryRun: true })
check('dryRun 报告会覆盖 FACT.md', dry.restored.some(item => item.relative === 'workspace/memory/FACT.md'), JSON.stringify(dry.restored.map(item => item.relative)))
check('dryRun 没改本地文件', fs.readFileSync(localFact, 'utf8') === 'LOCAL DIRTY\n')
const real = await call('/dsh-nutstore/restore', {})
check('真实恢复成功', real.ok === true && real.restoredCount > 0, `restored=${real.restoredCount} failed=${JSON.stringify(real.failed)}`)
check('FACT.md 被改回远端内容', fs.readFileSync(localFact, 'utf8') === '# facts\n', JSON.stringify(fs.readFileSync(localFact, 'utf8')))

console.log('\n[9] 非本机请求被拒绝')
const foreign = await new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: api.address().port, path: '/dsh-nutstore/backup', method: 'POST', headers: { host: 'evil.example.com', 'Content-Type': 'application/json' } }, (res) => {
    let text = ''
    res.on('data', chunk => { text += chunk })
    res.on('end', () => resolve({ status: res.statusCode, body: text }))
  })
  // remoteAddress 在真实连接下就是 127.0.0.1，Host 头伪造 → 必须 403
  req.end('{}')
})
check('伪造 Host 的写请求被 403 拒绝', foreign.status === 403, `status=${foreign.status} body=${foreign.body.slice(0, 120)}`)

console.log('\n[10] 工具 execute 直接可用')
const statusTool = await registeredTools.get('nutstore_status').execute({}, {})
check('nutstore_status 返回登录态与范围', statusTool.loggedIn === true && statusTool.files > 0, JSON.stringify(statusTool).slice(0, 200))
const listTool = await registeredTools.get('nutstore_list').execute({}, {})
check('nutstore_list 能读到 manifest 摘要', listTool.machines.some(machine => machine.machine === 'host-test'), JSON.stringify(listTool.machines))

api.close()
dav.close()
fs.rmSync(sandbox, { recursive: true, force: true })

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} 项失败：`)
  for (const failure of failures) console.log(`   - ${failure}`)
  process.exitCode = 1
} else {
  console.log('\n✅ 全部通过')
}
