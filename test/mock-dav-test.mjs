/**
 * 本地 mock WebDAV 服务器 + 端到端自测。
 *
 * 目的：在没有真实坚果云账号的前提下，验证
 *   ① WebDAV 客户端（PROPFIND/MKCOL/PUT/GET/DELETE）真的能跑通；
 *   ② 备份范围扫描（sessions / profile / workspace / 插件源码）符合预期；
 *   ③ 增量：第二轮备份不上传任何未变化的文件；
 *   ④ manifest 写入、listRemoteMachines、恢复（含 dryRun）都正确。
 *
 * 用法：node test/mock-dav-test.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.dirname(here)

// ── 测试环境：隔离的 DSH_HOME / PROFILE_DIR / 工作区 ────────────────────────────
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nsb-test-'))
const dshHome = path.join(sandbox, '.dsh')
const profileDir = path.join(dshHome, 'profiles', 'desktop')
const workspace = path.join(sandbox, 'workspace')

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

write(path.join(dshHome, 'sessions', 'a.jsonl'), '{"type":"turn/start"}\n')
write(path.join(dshHome, 'sessions', 'nested', 'b.jsonl'), '{"type":"turn/end"}\n')
write(path.join(profileDir, 'cordis.patch.yml'), '- id: x\n')
write(path.join(profileDir, 'package.json'), '{"name":"p"}\n')
write(path.join(profileDir, 'node_modules', 'big', 'index.js'), 'x'.repeat(4096))
write(path.join(profileDir, '.plugin-manager', 'logs', 'a.txt'), 'skip me')
write(path.join(workspace, 'memory', 'FACT.md'), '# facts\n')
write(path.join(workspace, 'memory', 'JOURNAL.jsonl'), '{"a":1}\n')
write(path.join(workspace, 'SOUL.md'), '# soul\n')
write(path.join(workspace, 'knowledge-graph.json'), '{"nodes":[]}\n')
write(path.join(workspace, '文档', 'big.docx'), 'this should NOT be backed up')

process.env.DSH_HOME = dshHome
process.env.DSH_PROFILE_DIR = profileDir
process.env.DSH_PROFILE = 'desktop'
process.env.DSH_SESSION_CWD = workspace

const libUrl = (file) => pathToFileURL(path.join(pluginDir, 'lib', file)).href
const { WebDavClient } = await import(libUrl('webdav.mjs'))
const { loadConfig, saveConfig, encodeRemoteName } = await import(libUrl('config.mjs'))
const { runBackup, runRestore, listRemoteMachines, readManifest, remoteDir } = await import(libUrl('backup.mjs'))
const { scanBackupFiles, describeBackupPlan } = await import(libUrl('plan.mjs'))

// ── mock WebDAV ───────────────────────────────────────────────────────────────
/** 内存文件系统：Map<绝对路径, Buffer>，目录用结尾带 / 的键表示。 */
const store = new Map()
store.set('/', Buffer.alloc(0))
const requests = { count: 0, byMethod: {} }
/** 每次 PUT 的路径序列，用于验证"瞬时失败会被重试"。 */
const putAttempts = []
/**
 * 上传中断演练状态：
 *  - `cutKeys` 里的路径，第一次 PUT 会在**读走一半请求体之后**销毁连接（模拟真实断线）；
 *  - `cutReceived` 记录每个路径实际收到的字节数序列；
 *  - `cutDone` 记录已经演练过的路径，避免第二次也断。
 */
const cutKeys = new Set()
const cutReceived = new Map()
const cutDone = new Set()

const server = http.createServer((req, res) => {
  requests.count += 1
  const method = req.method ?? 'GET'
  requests.byMethod[method] = (requests.byMethod[method] ?? 0) + 1

  const auth = req.headers.authorization ?? ''
  if (!auth.startsWith('Basic ')) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="mock"' })
    res.end('unauthorized')
    return
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  // 服务地址是 http://host/dav，所以 WebDAV 命名空间是 /dav/ 之后的部分。
  let key = decodeURIComponent(url.pathname)
  if (key.startsWith('/dav')) key = key.slice('/dav'.length)
  if (key === '') key = '/'

  const chunks = []
  let cutBytes = 0
  let cutTriggered = false
  req.on('data', (chunk) => {
    chunks.push(chunk)
    cutBytes += chunk.length
    if (method === 'PUT' && cutKeys.has(key) && !cutDone.has(key) && !cutTriggered && cutBytes > 16 * 1024) {
      cutTriggered = true
      cutDone.add(key)
      const seen = cutReceived.get(key) ?? []
      seen.push(cutBytes)
      cutReceived.set(key, seen)
      // 读走一部分后直接掐断：客户端已声明 Content-Length，此时流很可能已被消耗。
      req.destroy()
      res.destroy()
    }
  })
  // 掐断连接必然让服务端也收到 error；不接住会让这个"服务器"进程被打断。
  req.on('error', () => { /* 演练用的断线，忽略 */ })
  req.on('end', () => {
    const body = Buffer.concat(chunks)

    if (method === 'PROPFIND') {
      const isRoot = key === '/'
      const exists = store.has(key) || store.has(`${key}/`)
      if (!exists && !isRoot) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const depth = String(req.headers.depth ?? '1')
      const dirKey = key.endsWith('/') ? key : `${key}/`
      const entries = []
      const self = isRoot ? '/' : key
      entries.push({ href: self, collection: true })
      if (depth !== '0') {
        for (const [storedKey, value] of store) {
          if (storedKey === dirKey) continue
          if (!storedKey.startsWith(dirKey)) continue
          // rest 对子目录来说是 "name/"，去掉结尾斜杠再判断层级。
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
        // 已经存在：标准行为是 405
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
      // 严格校验：声明了 Content-Length 却收到空 body 的 PUT 必须失败。
      // 真实坚果云不会接受这种请求，而宽松的 mock 会让"静默空上传"这类 bug
      // （例如 req.write(stream) 什么都不写）在测试里看起来是通过的。
      const declared = Number(req.headers['content-length'] ?? '0')
      if (declared > 0 && body.length === 0) {
        res.writeHead(400)
        res.end('empty body for declared content-length')
        return
      }
      if (declared !== body.length) {
        res.writeHead(400)
        res.end(`content-length ${declared} != received ${body.length}`)
        return
      }
      store.set(key, body)
      putAttempts.push(key)
      if (process.env.NSB_FLAKY_DAV === '1' && putAttempts.filter(attempt => attempt === key).length === 1) {
        res.writeHead(503, { 'Retry-After': '0' })
        res.end('service unavailable (mock)')
        return
      }
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
      // 截断演练：故意只发一半并声明完整长度，验证客户端不会写出坏文件。
      // 注意远端对象名是 base64url，不能用原始相对路径去 endsWith。
      if (process.env.NSB_TRUNCATE_DAV === '1' && key.endsWith('/d29ya3NwYWNlL21lbW9yeS9GQUNULm1k')) {
        const half = value.subarray(0, Math.max(1, Math.floor(value.length / 2)))
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': value.length })
        res.end(half)
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': value.length })
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

await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
const port = server.address().port
const serverUrl = `http://127.0.0.1:${port}/dav`

// ── 断言 ──────────────────────────────────────────────────────────────────────
const failures = []
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(`${label} ${detail}`)
    console.log(`  FAIL  ${label} ${detail}`)
  }
}

const client = new WebDavClient({ server: serverUrl, account: 'tester@example.com', password: 'app-password-xyz' })

console.log('\n[1] 连接自检 / PROPFIND')
const checkResult = await client.check()
check('check() 返回 207-multistatus', checkResult.status === 207, `status=${checkResult.status}`)
check('PROPFIND 带上了 Basic 认证', requests.byMethod.PROPFIND >= 1)

console.log('\n[2] 备份范围扫描')
const config = saveConfig({
  server: serverUrl,
  account: 'tester@example.com',
  remoteRoot: '/dsh-backup',
  machine: 'test-machine',
  workspaceDir: workspace,
  perMachineDir: true,
})
const plan = describeBackupPlan(config)
const relatives = scanBackupFiles(config).files.map(file => file.relative).sort()
console.log('  扫描结果：', relatives.join('\n              '))
check('会话文件在范围内', relatives.includes('sessions/a.jsonl') && relatives.includes('sessions/nested/b.jsonl'))
check('profile 配置在范围内', relatives.includes('profile/cordis.patch.yml') && relatives.includes('profile/package.json'))
check('node_modules 被排除', !relatives.some(rel => rel.includes('node_modules')), relatives.filter(r => r.includes('node_modules')).join(','))
check('.plugin-manager 被排除', !relatives.some(rel => rel.includes('.plugin-manager')))
check('工作区 memory 在范围内', relatives.includes('workspace/memory/FACT.md') && relatives.includes('workspace/SOUL.md'))
check('工作区非记忆文件被排除', !relatives.some(rel => rel.includes('big.docx')))
check('插件源码在范围内', relatives.includes('pluginsrc/lib/index.mjs') && relatives.includes('pluginsrc/package.json'))
check('插件源码里的 node_modules 被排除', !relatives.some(rel => rel.startsWith('pluginsrc/node_modules')))
check('node_modules 里的大文件没被算进去', plan.bytes < 1_000_000, `bytes=${plan.bytes}`)

console.log('\n[3] 首次备份（全量）')
const first = await runBackup({ client, config })
console.log(`  dir=${first.dir} uploaded=${first.uploaded} skipped=${first.skipped} bytes=${first.uploadedBytes} failed=${first.failed.length} ms=${first.ms}`)
check('首轮全部上传', first.ok === true && first.uploaded === plan.files, `uploaded=${first.uploaded} expected=${plan.files}`)
check('没有失败项', first.failed.length === 0, JSON.stringify(first.failed))
check('远端写了 manifest', store.has(`${remoteDir(config)}/manifest.json`))
check('远端写了 info.json', store.has(`${remoteDir(config)}/info.json`))
const uploadsAfterFirst = store.size

// 内容级校验：逐文件比对本机 sha256 与远端对象 sha256。
// 只比长度是不够的——"重试时流已耗尽""写了一半"这类 bug 可能长度对不上却没被发现。
{
  const digest = (buffer) => createHash('sha256').update(buffer).digest('hex')
  let compared = 0
  const mismatched = []
  for (const file of scanBackupFiles(config).files) {
    const remote = store.get(`${remoteDir(config)}/${encodeRemoteName(file.relative)}`)
    if (remote === undefined) { mismatched.push(`${file.relative}: 远端没有这个对象`); continue }
    const local = digest(fs.readFileSync(file.absolute))
    if (digest(remote) !== local) mismatched.push(`${file.relative}: 内容不一致（本地 ${local.slice(0, 8)} / 远端 ${digest(remote).slice(0, 8)}）`)
    compared += 1
  }
  check(`逐文件内容哈希一致（比对了 ${compared} 个）`, mismatched.length === 0, mismatched.slice(0, 3).join(' | '))
  check('比对数量等于扫描数量', compared === plan.files, `compared=${compared} files=${plan.files}`)
}

console.log('\n[4] 第二轮备份（增量）')
const second = await runBackup({ client, config })
console.log(`  uploaded=${second.uploaded} skipped=${second.skipped}`)
check('第二轮不上传任何文件', second.uploaded === 0, `uploaded=${second.uploaded}`)
check('第二轮全部跳过', second.skipped === plan.files, `skipped=${second.skipped}`)

console.log('\n[5] 改动一个文件 → 只传那一个')
fs.appendFileSync(path.join(workspace, 'memory', 'JOURNAL.jsonl'), '{"a":2}\n')
const third = await runBackup({ client, config })
check('只重传被改动的文件', third.uploaded === 1, `uploaded=${third.uploaded}`)
check('其余仍然跳过', third.skipped === plan.files - 1, `skipped=${third.skipped}`)

console.log('\n[5b] 等长内容改动也必须被发现（只看大小一定漏）')
{
  // 这正是"只比大小"会漏掉的场景：把 enabled 改成 disable，字节数一模一样。
  const sameSizeRelative = 'workspace/memory/SAME-SIZE.txt'
  const sameSizeTarget = path.join(workspace, 'memory', 'SAME-SIZE.txt')
  fs.writeFileSync(sameSizeTarget, 'enabled\n') // 8 字节
  const firstWithFile = await runBackup({ client, config })
  check('新文件被上传', firstWithFile.uploaded === 1, `uploaded=${firstWithFile.uploaded}`)

  const beforeSize = fs.statSync(sameSizeTarget).size
  fs.writeFileSync(sameSizeTarget, 'disable\n') // 同样 8 字节、内容不同
  const afterSize = fs.statSync(sameSizeTarget).size
  check('构造出的两次内容确实等长', beforeSize === afterSize, `${beforeSize} vs ${afterSize}`)

  const secondWithFile = await runBackup({ client, config })
  check('等长内容改动被识别并重传', secondWithFile.uploaded === 1, `uploaded=${secondWithFile.uploaded}（只看大小这里会是 0）`)
  check('其余文件仍然跳过', secondWithFile.skipped === plan.files, `skipped=${secondWithFile.skipped}（此时共 ${plan.files + 1} 个文件）`)

  const thirdWithFile = await runBackup({ client, config })
  check('内容未变时零上传（哈希判据稳定，不会反复重传）', thirdWithFile.uploaded === 0, `uploaded=${thirdWithFile.uploaded}`)

  const remoteSameSize = store.get(`${remoteDir(config)}/${encodeRemoteName(sameSizeRelative)}`)
  check('远端内容已更新为新内容', remoteSameSize?.toString('utf8') === 'disable\n', JSON.stringify(remoteSameSize?.toString('utf8')))

  const manifestWithHashes = await readManifest(client, config)
  const entry = manifestWithHashes?.files?.find(item => item.relative === sameSizeRelative)
  check('manifest 带 sha256 字段', typeof entry?.sha256 === 'string' && entry.sha256.length === 64, JSON.stringify(entry))
  const expectedHash = createHash('sha256').update('disable\n').digest('hex')
  check('manifest 里的 sha256 与实际内容一致', entry?.sha256 === expectedHash, `${entry?.sha256} vs ${expectedHash}`)
  check('manifest 统计里记录了 unchanged 数', typeof manifestWithHashes?.stats?.unchanged === 'number', JSON.stringify(manifestWithHashes?.stats))

  fs.rmSync(sameSizeTarget, { force: true })
  await runBackup({ client, config }) // 让后续统计回到干净状态
}

console.log('\n[5c] 元数据快路径：没变的文件连读都不读')
{
  // manifest 里的 stats 会告诉本轮有多少文件是"元数据没变、直接跳过（省掉读取+哈希）"的。
  const unchangedManifest = await readManifest(client, config)
  const beforeCount = unchangedManifest?.stats?.unchangedByMetadata

  const metadataRun = await runBackup({ client, config })
  const afterManifest = await readManifest(client, config)
  const stats = afterManifest?.stats ?? {}
  console.log(`  uploaded=${metadataRun.uploaded} unchanged=${stats.unchanged} 其中靠元数据跳过=${stats.unchangedByMetadata} 实际算了哈希=${stats.hashed}`)

  check('本轮零上传', metadataRun.uploaded === 0, `uploaded=${metadataRun.uploaded}`)
  check('全部文件靠元数据跳过（说明没读文件）', stats.unchangedByMetadata === stats.files, `byMetadata=${stats.unchangedByMetadata} files=${stats.files}（上一轮=${beforeCount}）`)
  check('实际算哈希的文件数是 0', stats.hashed === 0, `hashed=${stats.hashed}`)
  check('清单里仍然带着全部 sha256（快路径不会把哈希丢掉）', (afterManifest?.files ?? []).every(entry => typeof entry.sha256 === 'string' && entry.sha256.length === 64))

  // 只有 1 个文件被"碰"过（内容变、mtime 也变）→ 它必须走哈希并被重传，其余仍走快路径
  const oneFile = path.join(workspace, 'memory', 'TOUCHED.txt')
  fs.writeFileSync(oneFile, 'aaa\n')
  await runBackup({ client, config })
  const past = new Date(Date.now() - 60_000)
  fs.utimesSync(oneFile, past, past)   // 让"上一次"的 mtime 明显早于即将写入的值
  await runBackup({ client, config })  // 记录旧的 mtime + 哈希
  fs.writeFileSync(oneFile, 'bbb\n')    // 等长改动，mtime 必然变化
  const partial = await runBackup({ client, config })
  const partialManifest = await readManifest(client, config)
  check('被碰过的那个文件被重传', partial.uploaded === 1, `uploaded=${partial.uploaded}`)
  check('其余文件仍然靠元数据跳过', (partialManifest?.stats?.unchangedByMetadata ?? 0) >= (partialManifest?.stats?.files ?? 0) - 1, JSON.stringify(partialManifest?.stats))

  fs.rmSync(oneFile, { force: true })
  await runBackup({ client, config })
}

console.log('\n[6] listRemoteMachines / 读取清单')
const machines = await listRemoteMachines(client, config)
check('能看到 test-machine 目录', machines.some(machine => machine.name === 'test-machine'), JSON.stringify(machines))
const manifest = await readManifest(client, config)
check('manifest 记录了机器名', manifest?.machine === 'test-machine')
check('manifest 记录了文件数', manifest?.stats?.files === plan.files, `files=${manifest?.stats?.files}`)

console.log('\n[7] 恢复（dryRun）')
const localJournal = path.join(workspace, 'memory', 'JOURNAL.jsonl')
const remoteJournal = `${remoteDir(config)}/${Buffer.from('workspace/memory/JOURNAL.jsonl', 'utf8').toString('base64url')}`
fs.writeFileSync(localJournal, 'LOCAL-DIRTY\n')
const dry = await runRestore({ client, config, dryRun: true })
console.log(`  dryRun restored=${dry.restored.length} skipped=${dry.skipped.length}`)
check('dryRun 报告会覆盖被改动的文件', dry.restored.some(item => item.relative === 'workspace/memory/JOURNAL.jsonl'))
check('dryRun 不会真的写盘', fs.readFileSync(localJournal, 'utf8') === 'LOCAL-DIRTY\n')

console.log('\n[8] 恢复（真实写入）')
fs.rmSync(path.join(workspace, 'memory', 'FACT.md'))
const restored = await runRestore({ client, config })
console.log(`  restored=${restored.restored.length} skipped=${restored.skipped.length} failed=${restored.failed.length}`)
check('恢复成功', restored.ok === true, JSON.stringify(restored.failed))
check('被改动的文件恢复成远端内容', fs.readFileSync(localJournal, 'utf8') === fs.readFileSync(remoteJournalPath(), 'utf8'))
check('被删除的文件被恢复', fs.existsSync(path.join(workspace, 'memory', 'FACT.md')))
check('未变化的文件被跳过', restored.skipped.length > 0, `skipped=${restored.skipped.length}`)
check('覆盖前做了回收站备份', fs.existsSync(path.join(dshHome, 'nutstore-backup', 'restore-trash', 'workspace__memory__JOURNAL.jsonl')))

function remoteJournalPath() {
  // 从远端 store 里取出来落到临时文件，便于比对
  const target = path.join(sandbox, 'remote-JOURNAL.jsonl')
  fs.writeFileSync(target, store.get(remoteJournal))
  return target
}

console.log('\n[9] 从别的机器目录恢复（换机场景）')
saveConfig({ machine: 'new-machine' })
const otherConfig = loadConfig()
const crossDry = await runRestore({ client, config: otherConfig, sourceMachine: 'test-machine', dryRun: true })
check('能指定 sourceMachine 读别的机器清单', crossDry.restored.length + crossDry.skipped.length > 0, JSON.stringify(crossDry.failed))
check('换机后目标路径按本机重算', crossDry.restored.every(item => item.target === undefined || path.isAbsolute(item.target)))

console.log('\n[9b] 恢复结果必须区分"新建"与"覆盖"（只报总数会误导）')
{
  // 这条断言来自一次真实误导：预览说"会恢复 35 条"，其中只有 1 条是真覆盖，
  // 其余 34 条是本机还没有的文件。把两种性质混在一个数字里，会让人不敢点、或误判风险。
  const kinds = crossDry.restored.map(item => item.kind)
  check('每条都标了 kind（create / overwrite）', kinds.every(kind => kind === 'create' || kind === 'overwrite'), JSON.stringify([...new Set(kinds)]))
  check('counts 里有 created / overwritten / protectedNewer / unchanged', crossDry.counts !== undefined
    && typeof crossDry.counts.created === 'number'
    && typeof crossDry.counts.overwritten === 'number'
    && typeof crossDry.counts.protectedNewer === 'number'
    && typeof crossDry.counts.unchanged === 'number', JSON.stringify(crossDry.counts))
  check('created + overwritten = restored 总数', crossDry.counts.created + crossDry.counts.overwritten === crossDry.restored.length,
    `${crossDry.counts.created} + ${crossDry.counts.overwritten} vs ${crossDry.restored.length}`)
  check('protectedNewer + unchanged = skipped 总数', crossDry.counts.protectedNewer + crossDry.counts.unchanged === crossDry.skipped.length,
    `${crossDry.counts.protectedNewer} + ${crossDry.counts.unchanged} vs ${crossDry.skipped.length}`)
  check('覆盖类的条目带上了覆盖前的大小', crossDry.restored.filter(item => item.kind === 'overwrite').every(item => typeof item.previousSize === 'number'), '')
}

console.log('\n[10] 瞬时失败（503 + Retry-After）会被退避重试')
{
  // 让 mock 对每个 key 的第一次 PUT 回 503；重试后才 201。
  process.env.NSB_FLAKY_DAV = '1'
  const before = putAttempts.length
  const flaky = await runBackup({ client, config, force: true })
  const attemptsForOne = putAttempts.length - before
  check('全量重传仍然成功（说明重试生效）', flaky.ok === true && flaky.uploaded === plan.files, `uploaded=${flaky.uploaded} failed=${JSON.stringify(flaky.failed.slice(0, 2))}`)
  check('确实发生了重试（PUT 次数 > 文件数）', attemptsForOne > plan.files, `PUT=${attemptsForOne} files=${plan.files}`)
  delete process.env.NSB_FLAKY_DAV
}

console.log('\n[11] 传输被截断时不写坏文件')
{
  process.env.NSB_TRUNCATE_DAV = '1'
  // mock 在 NSB_TRUNCATE_DAV=1 时对 .../FACT.md 只发一半（但声明完整长度）。
  // 本地先写一份大小不同的内容，迫使恢复真的去下载它。
  const localFact = path.join(workspace, 'memory', 'FACT.md')
  fs.writeFileSync(localFact, 'LOCAL-BEFORE-TRUNCATE\n')
  let truncateError
  let truncated
  try {
    truncated = await runRestore({ client, config })
  } catch (error) {
    truncateError = error
  }
  delete process.env.NSB_TRUNCATE_DAV
  const failedEntry = truncated?.failed?.find(item => item.relative === 'workspace/memory/FACT.md')
  check('恢复把被截断的文件报为失败', truncateError !== undefined || failedEntry !== undefined, JSON.stringify(truncated?.failed ?? String(truncateError)))
  check('被截断的文件没有被写成坏文件（仍是本地原内容）', fs.readFileSync(localFact, 'utf8') === 'LOCAL-BEFORE-TRUNCATE\n', JSON.stringify(fs.readFileSync(localFact, 'utf8')))
  check('没有留下 .nbpart 临时文件', fs.readdirSync(path.dirname(localFact)).every(entry => !entry.includes('.nbpart')), fs.readdirSync(path.dirname(localFact)).join(','))
  const remoteFactName = Buffer.from('workspace/memory/FACT.md', 'utf8').toString('base64url')
  check('远端内容本身是完整的（问题只在传输）', store.get(`${remoteDir(config)}/${remoteFactName}`)?.toString('utf8') === '# facts\n')
  // 恢复正常后同一次恢复应当成功，证明失败是传输态而非数据损坏。
  const recovered = await runRestore({ client, config })
  check('云恢复正常后能补回该文件', recovered.ok === true && fs.readFileSync(localFact, 'utf8') === '# facts\n', JSON.stringify(recovered.failed))
}

console.log('\n[12] 上传传到一半断线：重试必须重建流、把完整内容送出去')
{
  // 造一个"够大、能在中途被切断"的文件（默认只有 16KB 以上的文件才值得演练）。
  const bigRelative = 'workspace/memory/BIG.bin'
  const bigAbsolute = path.join(workspace, 'memory', 'BIG.bin')
  const bigPayload = Buffer.alloc(200 * 1024)
  for (let index = 0; index < bigPayload.length; index += 1) bigPayload[index] = (index * 7) % 251
  fs.writeFileSync(bigAbsolute, bigPayload)

  const bigKey = `${remoteDir(config)}/${encodeRemoteName(bigRelative)}`
  const digest = (buffer) => createHash('sha256').update(buffer).digest('hex')
  cutKeys.add(bigKey)

  const bigBackup = await runBackup({ client, config })
  const received = cutReceived.get(bigKey) ?? []
  const stored = store.get(bigKey)
  console.log(`  中断演练：第一次收到 ${received[0] ?? 0} 字节后被切断；最终上传 ${bigBackup.uploaded} 个文件`)
  check('确实演练了"传一半断线"', received.length > 0 && received[0] > 0 && received[0] < bigPayload.length, JSON.stringify(received))
  check('重试后远端拿到了完整体（长度）', stored !== undefined && stored.length === bigPayload.length, `远端 ${stored?.length ?? '无'} / 本地 ${bigPayload.length}`)
  check('重试后远端内容哈希一致（不是"看起来成功"）', stored !== undefined && digest(stored) === digest(bigPayload), stored === undefined ? '远端没有对象' : `${digest(stored).slice(0, 8)} / ${digest(bigPayload).slice(0, 8)}`)
  check('这次备份没有被计为失败', bigBackup.failed.length === 0, JSON.stringify(bigBackup.failed.slice(0, 2)))

  // 清理，避免影响后面的统计
  fs.rmSync(bigAbsolute, { force: true })
  cutKeys.clear()
}

console.log('\n[13] 旧快照保护：本机比云端新的文件不覆盖')
{
  // 场景：云端快照较早、本机那份更新（本机正在用）。默认恢复必须保护它。
  const guardRelative = 'workspace/memory/GUARD.txt'
  const guardTarget = path.join(workspace, 'memory', 'GUARD.txt')
  fs.writeFileSync(guardTarget, 'OLD\n')
  const anHourAgo = new Date(Date.now() - 3_600_000)
  fs.utimesSync(guardTarget, anHourAgo, anHourAgo)
  await runBackup({ client, config }) // 云端记下这份旧内容与旧 mtime

  // 本机改成新内容（更长，确保大小不同），mtime 是现在
  fs.writeFileSync(guardTarget, 'NEW AND LONGER CONTENT\n')

  const guarded = await runRestore({ client, config })
  const guardedEntry = guarded.skipped.find(item => item.relative === guardRelative)
  check('本机更新的文件被跳过（不是覆盖）', guardedEntry !== undefined, JSON.stringify(guarded.skipped.slice(0, 3)))
  check('跳过原因说明"本机更新"并给出两边时间', String(guardedEntry?.reason).includes('本机更新'), String(guardedEntry?.reason))
  check('报告里带上两边的 mtime（便于判断）', typeof guardedEntry?.localMtimeMs === 'number' && typeof guardedEntry?.remoteMtimeMs === 'number', JSON.stringify(guardedEntry))
  check('本机内容没被旧快照覆盖', fs.readFileSync(guardTarget, 'utf8') === 'NEW AND LONGER CONTENT\n', JSON.stringify(fs.readFileSync(guardTarget, 'utf8')))

  // dryRun 也必须同样保护：预览骗人比不预览更糟
  const guardDry = await runRestore({ client, config, dryRun: true })
  check('dryRun 同样保护本机更新的文件', !guardDry.restored.some(item => item.relative === guardRelative), JSON.stringify(guardDry.restored.map(item => item.relative).slice(0, 3)))

  // force 模式：明确要求"完全恢复成云端原样"时就该覆盖
  const forced = await runRestore({ client, config, mode: 'force' })
  check('force 模式下覆盖成云端内容', fs.readFileSync(guardTarget, 'utf8') === 'OLD\n', JSON.stringify(fs.readFileSync(guardTarget, 'utf8')))
  check('force 模式失败数为 0', forced.failed.length === 0, JSON.stringify(forced.failed.slice(0, 2)))

  fs.rmSync(guardTarget, { force: true })
  await runBackup({ client, config })
}

console.log(`\n请求统计：${requests.count} 次 ${JSON.stringify(requests.byMethod)}`)

// 收尾必须真的关掉 mock 服务器：否则 http.Server 会一直让事件循环活着，
// 进程不退出——表现就是"套件全绿但命令挂着"，很容易被误判成测试卡死。
await new Promise((resolve) => { server.close(resolve) })
await new Promise((resolve) => { server.closeAllConnections?.(); resolve() })
fs.rmSync(sandbox, { recursive: true, force: true })

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} 项失败：`)
  for (const failure of failures) console.log(`   - ${failure}`)
  process.exitCode = 1
} else {
  console.log('\n✅ 全部通过')
}
// 兜底：即使还有残留 handle（keep-alive socket 等），也不让测试进程挂着。
setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref()
