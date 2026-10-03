/**
 * 诊断：坚果云 WebDAV 端点支持哪些认证方式。
 *
 * 目的：确认"OAuth / Bearer 令牌能不能直接用于 WebDAV"。
 * 如果只认 Basic，那么"只登录账号、不填应用密码"就必须走别的通道（坚果云开放平台 API），
 * 而不是 WebDAV —— 这决定了本插件的架构。
 *
 * 用法：node test/diagnose-auth-schemes.mjs
 */
import https from 'node:https'

function probe(name, headers) {
  return new Promise((resolve) => {
    const request = https.request({
      host: 'dav.jianguoyun.com',
      path: '/dav/',
      method: 'PROPFIND',
      headers: { Depth: '0', ...headers },
    }, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({
        name,
        status: response.statusCode,
        challenge: response.headers['www-authenticate'] ?? '',
        body: body.slice(0, 80).replace(/\s+/gu, ' '),
      }))
    })
    request.setTimeout(15_000, () => { request.destroy(); resolve({ name, status: 'timeout' }) })
    request.on('error', (error) => resolve({ name, status: `err:${error.code ?? error.message}` }))
    request.end()
  })
}

const cases = [
  ['无认证', {}],
  ['Bearer 假令牌', { Authorization: 'Bearer fake-oauth-token-abcdef' }],
  ['Basic 假凭据', { Authorization: `Basic ${Buffer.from('probe@example.invalid:wrong').toString('base64')}` }],
  ['X-Auth-Token', { 'X-Auth-Token': 'fake-token' }],
  ['access_token 查询参数', {}],
]

const results = []
for (const [name, headers] of cases) results.push(await probe(name, headers))
// 单独测一次把令牌放在 URL 查询参数里
results.push(await new Promise((resolve) => {
  const request = https.request({ host: 'dav.jianguoyun.com', path: '/dav/?access_token=fake', method: 'PROPFIND', headers: { Depth: '0' } }, (response) => {
    let body = ''
    response.on('data', (chunk) => { body += chunk })
    response.on('end', () => resolve({ name: 'URL ?access_token=', status: response.statusCode, challenge: response.headers['www-authenticate'] ?? '', body: body.slice(0, 80) }))
  })
  request.setTimeout(15_000, () => { request.destroy(); resolve({ name: 'URL ?access_token=', status: 'timeout' }) })
  request.on('error', (error) => resolve({ name: 'URL ?access_token=', status: `err:${error.code}` }))
  request.end()
}))

console.log('端点：https://dav.jianguoyun.com/dav/  方法：PROPFIND Depth: 0\n')
for (const result of results) {
  console.log(`${String(result.status).padEnd(10)} ${result.name.padEnd(22)} WWW-Authenticate=${JSON.stringify(result.challenge)}`)
}
console.log('')
const challenged = results.filter(result => result.status === 401)
const bearerRejected = results.find(result => result.name === 'Bearer 假令牌')
console.log('解读：')
console.log(`  401 的响应用来观察它要求什么认证方式：${challenged.map(r => `${r.name} → ${JSON.stringify(r.challenge)}`).join('；') || '（无）'}`)
console.log(`  Bearer 的结果：${bearerRejected.status}（401 且 challenge 只给 Basic，说明 WebDAV 端不认 OAuth 令牌）`)
