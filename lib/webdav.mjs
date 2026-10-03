/**
 * 极简 WebDAV 客户端（坚果云专用，但按标准 WebDAV 实现）。
 *
 * 只用 node:http / node:https：不引入任何第三方依赖，插件装到新机器上不会因为
 * 拉包失败而跑不起来；同时能精确控制 PROPFIND 这类 fetch 不方便发的方法。
 */
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import { URL } from 'node:url'

/** 一次 DAV 请求的结果。 */
class DavError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'DavError'
    this.status = options.status
    this.body = options.body
    this.method = options.method
    this.url = options.url
    this.hint = options.hint
  }
}

/** 把 URL 收敛成 { origin, basePath }，basePath 永远以 / 结尾。 */
function splitServer(server) {
  const url = new URL(server)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new DavError(`坚果云服务器地址必须以 https:// 开头：${server}`)
  }
  let basePath = url.pathname || '/'
  if (!basePath.endsWith('/')) basePath += '/'
  return { origin: `${url.protocol}//${url.host}`, basePath }
}

/** XML 实体反转义（坚果云的 PROPFIND 结果里 href 会出现 &amp; 之类）。 */
function unescapeXml(text) {
  return String(text)
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gu, '&')
}

/** 从路径里取最后一段（不做 URL 解码）。 */
function lastSegment(href) {
  const trimmed = String(href).replace(/\/+$/u, '')
  const index = trimmed.lastIndexOf('/')
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

/** 解码百分号编码，失败就原样返回。 */
function safeDecode(text) {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** 收集响应体（带上限，避免远端异常时把内存吃满）。 */
function readBody(res, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    res.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new DavError('响应体超过上限', { status: res.statusCode }))
        res.destroy()
        return
      }
      chunks.push(chunk)
    })
    res.on('end', () => resolve(Buffer.concat(chunks)))
    res.on('error', reject)
  })
}

/** HTTP 状态码 → 给用户看的中文解释。 */
function hintForStatus(status, method) {
  if (status === 401) return '认证失败：坚果云要求使用「应用密码」（账户信息 → 安全选项 → 添加应用密码），邮箱/手机号填在账号里'
  if (status === 403) return '被拒绝（403）：账号或应用密码没有该目录的权限，或应用密码已被删除'
  if (status === 404) return `远端不存在（404）：${method} 的目标路径尚未建立`
  if (status === 405) return '方法不被支持（405）：服务器地址可能不是 WebDAV 根'
  if (status === 409) return '父目录不存在（409）：创建集合前父级必须已存在'
  if (status === 423) return '资源被锁定（423）'
  if (status === 429) return '请求过于频繁（429）：坚果云对并发有限制，稍后重试'
  if (status === 507) return '坚果云空间不足（507）'
  if (status >= 500) return '坚果云服务端错误，稍后重试'
  return undefined
}

/**
 * 这个错误值不值得重试。
 *
 * 两类都算瞬时：
 *  ① HTTP 层：429 / 5xx / 507（服务端过载、限流、暂时故障）；
 *  ② 网络层：连接被重置、管道断开、超时等——**上传传到一半断线就属于这一类**，
 *     如果不认它，真实抖动下第一次失败就放弃，等于没有重试。
 */
export function isTransient(error) {
  if (error instanceof DavError) {
    const status = error.status
    if (status === undefined) return true // 没有 status 的 DavError 就是网络层/超时
    return status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 507
  }
  // 原生 socket 错误（undici / node:http 抛的都不是 DavError）
  const code = error !== null && typeof error === 'object' ? (error.code ?? error.errno) : undefined
  return TRANSIENT_NETWORK_CODES.has(String(code))
}

/** 值得重试的网络错误码。 */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

/** 退避间隔：优先听服务端 Retry-After，其次指数退避，封顶 8 秒。 */
function backoffMs(attempt, error) {
  const retryAfter = error instanceof DavError ? error.retryAfterSeconds : undefined
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(30_000, Math.round(retryAfter * 1000))
  }
  return Math.min(8_000, 400 * (2 ** (attempt - 1)))
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/**
 * 删除文件，遇到"暂时被占用"就重试几次（同步等待，因为调用方在错误路径上）。
 * @returns 是否确实删掉了（文件已不存在也算成功）
 */
function removeWithRetry(file, attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(file, { force: true })
      return true
    } catch (error) {
      const retryable = error !== null && typeof error === 'object' && ['EACCES', 'EBUSY', 'EPERM'].includes(error.code)
      if (!retryable && attempt === attempts - 1) return !fs.existsSync(file)
      if (!retryable && fs.existsSync(file)) return false
      if (!retryable) return true
      const until = Date.now() + 25 * (attempt + 1)
      while (Date.now() < until) { /* 同步退避 */ }
    }
  }
  return !fs.existsSync(file)
}

/** 跨平台把临时文件改名为目标（Windows 上目标被占用时重试几次）。 */
function renameOverExisting(source, target) {  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(source, target)
      return
    } catch (error) {
      const retryable = error !== null && typeof error === 'object' && ['EACCES', 'EBUSY', 'EPERM'].includes(error.code)
      if (!retryable || attempt >= 8) throw error
      const until = Date.now() + 20 * (attempt + 1)
      while (Date.now() < until) {
        // 同步等待：这里处在写文件的同步路径上，没有更好的选择。
      }
    }
  }
}

/** 单个 WebDAV 客户端。一个实例对应一组服务地址 + 账号 + 应用密码。 */
export class WebDavClient {
  /**
   * @param options.server 例如 https://dav.jianguoyun.com/dav
   * @param options.account 坚果云账号（邮箱/手机号）
   * @param options.password 应用密码
   * @param options.timeoutMs 单请求超时，默认 60s
   */
  constructor(options) {
    const { origin, basePath } = splitServer(options.server)
    this.origin = origin
    this.basePath = basePath
    this.account = options.account
    this.password = options.password
    this.timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 60_000
    this.authorization = `Basic ${Buffer.from(`${options.account}:${options.password}`, 'utf8').toString('base64')}`
  }

  get label() {
    return `${this.origin}${this.basePath}`
  }

  /** 相对 basePath 的远端路径 → 绝对 URL 与请求用的 path。 */
  resolve(remotePath) {
    let suffix = String(remotePath ?? '')
    if (suffix.startsWith('/')) suffix = suffix.slice(1)
    // 结尾的 / 有语义（目录集合 URL），filter 掉空段后再补回来，
    // 否则 PROPFIND /dav/dir/ 会被发成 /dav/dir，坚果云会当成另一个资源。
    const trailingSlash = suffix.endsWith('/')
    const encoded = suffix
      .split('/')
      .filter(segment => segment !== '')
      .map(segment => encodeURIComponent(segment))
      .join('/')
    const requestPath = `${this.basePath}${encoded}${trailingSlash && encoded !== '' ? '/' : ''}`.replace(/\/{2,}/gu, '/')
    return { url: `${this.origin}${requestPath}`, path: requestPath }
  }

  /** 发一次请求，返回 { status, headers, body(Buffer) }。buffer 为 true 时把 body 读进内存。 */
  request(method, remotePath, options = {}) {
    const { url, path: requestPath } = this.resolve(remotePath)
    const target = new URL(url)
    const transport = target.protocol === 'https:' ? https : http
    const headers = {
      Authorization: this.authorization,
      'User-Agent': 'dsh-nutstore-backup/0.1 (+deepseek-harness)',
      Accept: '*/*',
      ...(options.headers ?? {}),
    }
    if (options.depth !== undefined) headers.Depth = String(options.depth)
    if (options.contentLength !== undefined) headers['Content-Length'] = String(options.contentLength)

    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port === '' ? undefined : target.port,
          method,
          path: requestPath,
          headers,
          agent: false,
        },
        (res) => {
          const finish = (body) => {
            const status = res.statusCode ?? 0
            if (status >= 400 && !(options.acceptStatus ?? []).includes(status)) {
              const text = body === undefined ? '' : body.toString('utf8').slice(0, 400)
              const retryAfter = Number(res.headers['retry-after'])
              reject(new DavError(`${method} ${requestPath} 失败：HTTP ${status}${text === '' ? '' : ` — ${text}`}`, {
                status,
                body: text,
                method,
                url,
                retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
                hint: hintForStatus(status, method),
              }))
              return
            }
            resolve({ status, headers: res.headers, body, url, path: requestPath })
          }
          if (options.stream === true) {
            resolve({ status: res.statusCode ?? 0, headers: res.headers, stream: res, url, path: requestPath })
            return
          }
          readBody(res).then(finish, reject)
        },
      )

      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new DavError(`${method} ${requestPath} 超时（${this.timeoutMs}ms）`, { method, url }))
      })
      req.on('error', (error) => {
        if (error instanceof DavError) {
          reject(error)
          return
        }
        const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : undefined
        const detail = cause && cause.message ? `（${cause.message}）` : ''
        reject(new DavError(`${method} ${requestPath} 网络失败：${error.message}${detail}`, { method, url, hint: '检查网络/代理，以及 dns.setDefaultResultOrder("ipv4first") 是否被某个插件关掉了' }))
      })

      if (options.body !== undefined && options.body !== null) {
        const body = options.body
        if (typeof body.pipe === 'function') {
          // 流式请求体（上传大文件）：必须 pipe，`req.write(stream)` 会静默什么都不写，
          // 而上游已经声明了 Content-Length —— 那会变成一次"成功的空上传"。
          body.on('error', (error) => req.destroy(error))
          body.pipe(req)
          return
        }
        req.write(body)
      }
      req.end()
    })
  }

  /** PROPFIND：列一层目录（depth 1）或递归（depth infinity，坚果云不可靠，默认不用）。 */
  async list(remotePath, depth = 1) {
    // 目录 URL 必须以 / 结尾：少了这个斜杠，服务器会把请求当成"资源不存在"或返回非集合，
    // 坚果云/nginx 对 /dav/dir 与 /dav/dir/ 的处理并不一致。
    const target = String(remotePath ?? '')
    const collectionPath = target === '' || target === '/' ? '/' : (target.endsWith('/') ? target : `${target}/`)
    const response = await this.request('PROPFIND', collectionPath, {
      depth,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      body: '<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:"><D:prop><D:getcontentlength/><D:getlastmodified/><D:resourcetype/><D:getetag/></D:prop></D:propfind>',
      acceptStatus: [404],
    })
    if (response.status === 404) return []
    const xml = response.body ? response.body.toString('utf8') : ''
    const entries = []
    const blocks = xml.split(/<D:response[\s>]/iu).slice(1)
    for (const block of blocks) {
      const hrefMatch = /<D:href>([\s\S]*?)<\/D:href>/iu.exec(block)
      if (hrefMatch === null) continue
      const href = unescapeXml(hrefMatch[1]).trim()
      const name = safeDecode(lastSegment(href))
      const isCollection = /<D:collection\s*\/?>/iu.test(block) || /<D:collection>/iu.test(block)
      const sizeMatch = /<D:getcontentlength>(\d+)<\/D:getcontentlength>/iu.exec(block)
      const modifiedMatch = /<D:getlastmodified>([\s\S]*?)<\/D:getlastmodified>/iu.exec(block)
      const etagMatch = /<D:getetag>([\s\S]*?)<\/D:getetag>/iu.exec(block)
      entries.push({
        name,
        href,
        collection: isCollection,
        size: sizeMatch === null ? undefined : Number(sizeMatch[1]),
        modified: modifiedMatch === null ? undefined : unescapeXml(modifiedMatch[1]).trim(),
        etag: etagMatch === null ? undefined : unescapeXml(etagMatch[1]).trim(),
      })
    }
    // 第一项通常是目录自身（href 以请求路径结尾），剔除它。
    // 只有可解析出最后一段的路径才能做这个判断：根目录（'' 或 '/'）的最后一段为空，
    // 用空串去比会把**所有**条目都当成自己。
    const self = String(remotePath).replace(/\/+$/u, '')
    const selfSegments = self.split('/').filter(segment => segment !== '')
    if (selfSegments.length === 0) return entries
    const selfName = safeDecode(selfSegments[selfSegments.length - 1] ?? '')
    const selfHrefTail = selfSegments.map(segment => encodeURIComponent(segment)).join('/')
    return entries.filter((entry) => {
      const tail = String(entry.href).replace(/\/+$/u, '')
      if (tail.endsWith(selfHrefTail)) return false
      if (entry.name !== selfName) return true
      // 同名但在更深的父目录下：只看 href 的父路径是否匹配。
      return !tail.endsWith(`/${selfHrefTail}`)
    })
  }

  /** 判断某个路径是否存在及其类型。 */
  async stat(remotePath) {
    const response = await this.request('PROPFIND', remotePath, {
      depth: 0,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      body: '<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:"><D:prop><D:getcontentlength/><D:resourcetype/></D:prop></D:propfind>',
      acceptStatus: [404],
    })
    if (response.status === 404) return undefined
    const xml = response.body ? response.body.toString('utf8') : ''
    const sizeMatch = /<D:getcontentlength>(\d+)<\/D:getcontentlength>/iu.exec(xml)
    return {
      collection: /<D:collection\s*\/?>/iu.test(xml),
      size: sizeMatch === null ? undefined : Number(sizeMatch[1]),
    }
  }

  /** 建集合；已存在（405）视为成功。 */
  async mkcol(remotePath) {
    await this.request('MKCOL', remotePath, { acceptStatus: [405] })
  }

  /** 逐级建目录，幂等。 */
  async ensureDir(remotePath) {
    const segments = String(remotePath).split('/').filter(segment => segment !== '')
    let current = ''
    for (const segment of segments) {
      current += `/${segment}`
      try {
        await this.mkcol(current)
      } catch (error) {
        if (error instanceof DavError && error.status === 409) {
          // 上一次并发创建的竞态：父级刚建好就 409，重试一次。
          await this.mkcol(current)
          continue
        }
        throw error
      }
    }
  }

  /** 上传缓冲区。 */
  async put(remotePath, buffer) {
    return await this.request('PUT', remotePath, {
      body: buffer,
      contentLength: buffer.length,
      headers: { 'Content-Type': 'application/octet-stream' },
      timeoutMs: this.timeoutMs,
    })
  }

  /** 下载到内存（备份文件都很小；特大文件由调用方按 MAX_FILE_BYTES 拦住）。 */
  async getBuffer(remotePath) {
    const response = await this.request('GET', remotePath)
    return response.body ?? Buffer.alloc(0)
  }

  /** 流式下载，供大文件恢复使用。 */
  async getStream(remotePath) {
    return await this.request('GET', remotePath, { stream: true })
  }

  /**
   * 流式下载到文件：先写 `<目标>.nbpart-<pid>` 再改名为目标。
   *
   * 为什么不直接写目标文件：如果目标正被别的进程占用（DSH 自己可能开着会话 jsonl），
   * 写到一半失败会留下一个**被截断的文件**——那比不恢复更糟。先写临时文件再 rename，
   * 坏掉的中间态不会污染真实文件，且返回前显式校验字节数。
   *
   * @param remotePath 远端路径
   * @param targetPath 本机绝对路径
   * @param options.expectedSize 期望字节数（来自 manifest；对不上就报错）
   * @returns { bytes }
   */
  async downloadToFile(remotePath, targetPath, options = {}) {
    const { stream } = await this.getStream(remotePath)
    const temporary = `${targetPath}.nbpart-${process.pid}-${Date.now()}`
    let bytes = 0
    try {
      await new Promise((resolve, reject) => {
        const sink = fs.createWriteStream(temporary, { flags: 'w' })
        let finished = false
        let closed = false
        const settleIfDone = () => {
          // 必须等 **close** 而不是 finish：finish 只表示"数据都交给内核了"，
          // 文件句柄要到 close 才释放。只等 finish 就去删/改这个文件，
          // 在 Windows 上会撞上短暂的占用（实测导致偶发删不掉、留下 .nbpart 垃圾）。
          if (finished && closed) resolve()
        }
        const fail = (error) => {
          stream.destroy()
          sink.destroy()
          reject(error)
        }
        stream.on('error', fail)
        sink.on('error', fail)
        sink.on('finish', () => { finished = true; settleIfDone() })
        sink.on('close', () => { closed = true; settleIfDone() })
        stream.pipe(sink)
      })
      bytes = fs.statSync(temporary).size
      if (typeof options.expectedSize === 'number' && options.expectedSize >= 0 && bytes !== options.expectedSize) {
        throw new DavError(`下载 ${remotePath} 只拿到 ${bytes} 字节，manifest 记的是 ${options.expectedSize} 字节（传输被截断？）`, { method: 'GET' })
      }
      renameOverExisting(temporary, targetPath)
      return { bytes }
    } catch (error) {
      /**
       * 清理临时文件**必须重试**：Windows 上刚写完/刚读过的文件常被短暂占用，
       * 一次 rmSync 会失败（EBUSY/EPERM）。早期版本把它 `catch {}` 静默吞掉，
       * 结果真机上会留下 `.nbpart` 垃圾文件——而且测试因此偶发失败（实测抓到一次）。
       * 这里做有限重试；仍失败就把临时文件路径写进错误信息，不假装干净。
       */
      const removed = removeWithRetry(temporary)
      if (!removed) {
        throw new DavError(
          `${error instanceof Error ? error.message : String(error)}（另外：临时文件 ${temporary} 没能删掉，请手动清理）`,
          { method: 'GET', status: error instanceof DavError ? error.status : undefined },
        )
      }
      throw error
    }
  }

  /**
   * 把一次尝试真正发出去的请求参数算出来。
   *
   * 关键点：**每次尝试都要新建流**。流是一次性的——如果上传传到一半断线，
   * 流已经被消耗，重试再拿同一个流去写就会出现"Content-Length 声明了 N 字节、
   * 实际只发出去一半"的挂起（实测会一直卡到 60s 超时），而不是干脆失败。
   * 所以重试路径必须传 `filePath`（每次尝试 createReadStream），不要传 `body` 流。
   */
  attemptOptions(options) {
    const resolved = { ...options }
    if (typeof options.filePath === 'string') {
      const size = fs.statSync(options.filePath).size
      resolved.body = fs.createReadStream(options.filePath)
      resolved.contentLength = size
      delete resolved.filePath
    }
    return resolved
  }

  /**
   * 带重试的请求：只重试**瞬时**失败（429/5xx 与网络层错误），
   * 认证失败、404、409 这类确定性错误立刻抛出——重试它们只是浪费时间和配额。
   *
   * 上传文件请用 `filePath` 而不是 `body`：见 attemptOptions 的说明。
   */
  async requestWithRetry(method, remotePath, options = {}) {
    const attempts = typeof options.attempts === 'number' ? options.attempts : 3
    if (typeof options.body?.pipe === 'function' && attempts > 1) {
      throw new DavError(
        `${method} ${remotePath}：带重试的上传必须传 filePath 而不是 body 流——`
        + '流是一次性的，上传中断后重试会挂起等一个永远到不了的 Content-Length',
        { method },
      )
    }
    let lastError
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.request(method, remotePath, this.attemptOptions(options))
      } catch (error) {
        lastError = error
        if (!isTransient(error) || attempt === attempts) throw error
        await delay(backoffMs(attempt, error))
      }
    }
    throw lastError
  }

  /** 上传文件（带重试；每次尝试重建流）。 */
  async putFile(remotePath, filePath, options = {}) {
    return await this.requestWithRetry('PUT', remotePath, {
      filePath,
      headers: { 'Content-Type': 'application/octet-stream' },
      ...options,
    })
  }

  /**
   * 带重试的下载到文件（瞬时失败重来一次，临时文件会被清掉）。
   * 下载天然是幂等的：每次尝试都重新发 GET，不存在"流已消耗"的问题。
   */
  async downloadToFileWithRetry(remotePath, targetPath, options = {}) {
    const attempts = typeof options.attempts === 'number' ? options.attempts : 3
    let lastError
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.downloadToFile(remotePath, targetPath, options)
      } catch (error) {
        lastError = error
        if (!isTransient(error) || attempt === attempts) throw error
        await delay(backoffMs(attempt, error))
      }
    }
    throw lastError
  }

  /** 删除（不存在视为成功）。 */
  async remove(remotePath) {
    await this.request('DELETE', remotePath, { acceptStatus: [404] })
  }

  /** 连接与认证自检。 */
  async check() {
    const started = Date.now()
    const response = await this.request('PROPFIND', '/', {
      depth: 0,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      body: '<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>',
    })
    return {
      ok: true,
      status: response.status,
      server: response.headers.server,
      ms: Date.now() - started,
      dav: response.headers.dav,
    }
  }
}

/** list() 里做自身过滤时用到的 href 提取（保持与解析逻辑一致）。 */
export { DavError }
