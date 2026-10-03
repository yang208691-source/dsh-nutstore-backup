/**
 * 可复用的 mock WebDAV 服务器（测试用）。
 *
 * 刻意做成"严格"的假服务器：真实坚果云不接受的东西它也不接受。
 * 宽松的 mock 会让 bug 在测试里看起来是通过的——本项目已经因此漏过一次
 * "静默空上传"和一个"重试挂住"的问题。
 *
 * 支持的演练开关（通过环境变量）：
 *   NSB_FLAKY_DAV=1     每个 key 的第一次 PUT 回 503 + Retry-After（验证退避重试）
 *   NSB_TRUNCATE_DAV=1  对指定 key 只回一半字节但声明完整长度（验证不写坏文件）
 *   cutKeys             通过返回值设置：这些 key 的第一次 PUT 会在读走一部分后掐断连接
 */
import http from 'node:http'

/** FACT.md 的 base64url 对象名：截断演练要按**远端对象名**匹配，不能用原始相对路径。 */
export const FACT_OBJECT_KEY = 'd29ya3NwYWNlL21lbW9yeS9GQUNULm1k'

export async function startMockDav(options = {}) {
  const store = new Map([['/', Buffer.alloc(0)]])
  const requests = { count: 0, byMethod: {} }
  const putAttempts = []
  const cutKeys = new Set()
  const cutReceived = new Map()
  const cutDone = new Set()

  const server = http.createServer((req, res) => {
    const method = req.method ?? 'GET'
    requests.count += 1
    requests.byMethod[method] = (requests.byMethod[method] ?? 0) + 1

    if (options.requireAuth !== false && !String(req.headers.authorization ?? '').startsWith('Basic ')) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="mock"' })
      res.end('unauthorized')
      return
    }

    let key = decodeURIComponent(new URL(req.url ?? '/', 'http://mock').pathname)
    if (key.startsWith('/dav')) key = key.slice('/dav'.length)
    if (key === '') key = '/'

    const chunks = []
    let cutBytes = 0
    let cutTriggered = false
    req.on('data', (chunk) => {
      chunks.push(chunk)
      cutBytes += chunk.length
      if (method === 'PUT' && cutKeys.has(key) && !cutDone.has(key) && !cutTriggered && cutBytes > (options.cutAfterBytes ?? 16 * 1024)) {
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
    // 掐断连接必然让服务端也收到 error；不接住会打断测试进程。
    req.on('error', () => { /* 演练用的断线，忽略 */ })

    req.on('end', () => {
      const body = Buffer.concat(chunks)

      if (method === 'PROPFIND') {
        const isRoot = key === '/'
        const dirKey = key.endsWith('/') ? key : `${key}/`
        if (!isRoot && !store.has(dirKey)) {
          res.writeHead(404)
          res.end('not found')
          return
        }
        const depth = String(req.headers.depth ?? '1')
        const entries = [{ href: isRoot ? '/' : key, collection: true }]
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
        // 截断演练：故意只发一半并声明完整长度。
        if (process.env.NSB_TRUNCATE_DAV === '1' && key.endsWith(`/${FACT_OBJECT_KEY}`)) {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': value.length })
          res.end(value.subarray(0, Math.max(1, Math.floor(value.length / 2))))
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

  await new Promise(resolve => server.listen(0, options.host ?? '127.0.0.1', resolve))
  const port = server.address().port

  return {
    url: `http://${options.host ?? '127.0.0.1'}:${port}/dav`,
    port,
    store,
    requests,
    putAttempts,
    cutKeys,
    cutReceived,
    /** 关掉服务器（等待连接释放，避免测试进程挂着）。 */
    async close() {
      await new Promise(resolve => server.close(resolve))
    },
  }
}
