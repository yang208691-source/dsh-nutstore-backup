/**
 * 诊断：从坚果云账号页里找出「第三方应用管理 / 应用密码」的真实地址。
 *
 * 为什么要找：插件要一键把用户送到生成应用密码的页面。写死一个猜的路径
 * 会让按钮点下去 404——那比没有按钮更糟。这里从页面里把候选链接抠出来，逐个探活。
 *
 * 用法：node test/diagnose-nutstore-url.mjs
 */
import https from 'node:https'

function get(path) {
  return new Promise((resolve) => {
    const request = https.request({
      host: 'www.jianguoyun.com',
      path,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
    }, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode, location: response.headers.location ?? '', body }))
    })
    request.setTimeout(20_000, () => { request.destroy(); resolve({ status: 'timeout', location: '', body: '' }) })
    request.on('error', (error) => resolve({ status: `err:${error.code}`, location: '', body: '' }))
    request.end()
  })
}

const landing = await get('/d/account')
console.log(`/d/account → ${landing.status}（${landing.body.length} 字节）`)

const keywords = ['safe', 'security', 'app', 'third', 'oauth', 'token', 'password', 'pwd', 'authorize']
const found = new Set()
const pattern = /['"]([^'"\s]{2,120})['"]/gu
for (const match of landing.body.matchAll(pattern)) {
  const candidate = match[1]
  if (!candidate.startsWith('/') && !candidate.startsWith('http')) continue
  const lower = candidate.toLowerCase()
  if (!keywords.some(keyword => lower.includes(keyword))) continue
  found.add(candidate)
}

console.log(`\n候选链接（${found.size} 个）：`)
for (const candidate of [...found].slice(0, 40)) console.log(`  ${candidate}`)

// 逐个探活（只看状态码，不跟随后续交互）
const probes = [...found].filter(candidate => candidate.startsWith('/')).slice(0, 12)
if (probes.length > 0) {
  console.log('\n探活：')
  for (const candidate of probes) {
    const result = await get(candidate)
    const note = result.location === '' ? '' : ` → ${result.location}`
    console.log(`  ${String(result.status).padEnd(6)} ${candidate}${note}`)
  }
}

// 另外直接试几个"看起来像"的固定路径
console.log('\n固定路径试探：')
for (const candidate of ['/d/account/safe', '/d/account/safety', '/d/account/app', '/d/account/apps', '/d/account/third-party', '/d/app', '/d/account#safe']) {
  if (!candidate.startsWith('/d/account/')) continue
  const result = await get(candidate)
  console.log(`  ${String(result.status).padEnd(6)} ${candidate}`)
}
