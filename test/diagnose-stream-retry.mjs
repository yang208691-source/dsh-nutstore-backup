/**
 * 诊断：客户端在"上传传到一半被服务器掐断"后的行为。
 * 只测客户端本身（不涉及备份引擎），把每一步的耗时打出来。
 *
 * 用法：node test/diagnose-stream-retry.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const { WebDavClient } = await import(pathToFileURL('D:/My Agent/dev/dsh-nutstore-backup/lib/webdav.mjs').href)

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nsb-stream-'))
const filePath = path.join(sandbox, 'payload.bin')
const payload = Buffer.alloc(200 * 1024)
for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 7) % 251
fs.writeFileSync(filePath, payload)
const expected = createHash('sha256').update(payload).digest('hex')

const received = []
const cut = new Set(['/dav/cut-once'])
let cutDone = false
const store = new Map()

const server = http.createServer((req, res) => {
  const key = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  const chunks = []
  let bytes = 0
  let triggered = false
  req.on('data', (chunk) => {
    chunks.push(chunk)
    bytes += chunk.length
    if (cut.has(key) && !cutDone && !triggered && bytes > 16 * 1024) {
      triggered = true
      cutDone = true
      received.push(bytes)
      req.destroy()
      res.destroy()
    }
  })
  req.on('error', () => { /* 客户端掐断 */ })
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    received.push(bytes)
    if (Number(req.headers['content-length'] ?? '0') !== body.length) {
      res.writeHead(400)
      res.end('length mismatch')
      return
    }
    store.set(key, body)
    res.writeHead(201)
    res.end('ok')
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const client = new WebDavClient({
  server: `http://127.0.0.1:${server.address().port}/dav`,
  account: 'a',
  password: 'b',
  timeoutMs: 8000,
})

console.log(`payload = ${payload.length} 字节, sha256 = ${expected.slice(0, 12)}`)
console.log('')

const started = Date.now()
try {
  const result = await client.putFile('/cut-once', filePath)
  console.log(`putFile 成功：status=${result.status}，耗时 ${Date.now() - started}ms`)
} catch (error) {
  console.log(`putFile 失败：${String(error.message).slice(0, 160)}，耗时 ${Date.now() - started}ms`)
}
console.log('服务器每次收到的字节数 =', JSON.stringify(received))
const stored = store.get('/dav/cut-once')
console.log(`远端长度 = ${stored?.length ?? '无'}（期望 ${payload.length}）`)
console.log(`远端哈希一致 = ${stored !== undefined && createHash('sha256').update(stored).digest('hex') === expected}`)

server.close()
fs.rmSync(sandbox, { recursive: true, force: true })
