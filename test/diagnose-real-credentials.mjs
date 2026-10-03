/**
 * 真实凭据文件上的"干跑"验证：把桥的输出与**用户真实** `.credentials.yaml` 对比，
 * 证明它只是"原样保留 + 多一条记录"，且在提交前就能看清 diff。
 *
 * 本脚本**不修改真实文件**：只在副本上写，然后打印 diff。
 * 用法：node test/diagnose-real-credentials.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { pluginDir } from './helpers/paths.mjs'

const realFile = path.join(os.homedir(), '.dsh', '.credentials.yaml')
if (!fs.existsSync(realFile)) {
  console.log(`真实凭据文件不存在：${realFile}（这台机器还没登录过任何东西？）`)
  process.exit(0)
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nsb-real-cred-'))
const dshHome = path.join(sandbox, '.dsh')
const copyFile = path.join(dshHome, '.credentials.yaml')
fs.mkdirSync(dshHome, { recursive: true })
const originalText = fs.readFileSync(realFile, 'utf8')
fs.writeFileSync(copyFile, originalText, { mode: 0o600 })

const lib = (file) => pathToFileURL(path.join(pluginDir, 'lib', file)).href
const { createCredentialBridge, CREDENTIAL_RECORD } = await import(lib('credential-store.mjs'))

const bridge = createCredentialBridge({ file: copyFile, profileDir: 'C:/Users/yang2/.dsh/profiles/desktop' })
console.log('桥可用 =', bridge.unsupported !== true, bridge.reason ?? '')
console.log('真实文件 =', realFile)
console.log('副本     =', copyFile)
console.log('')

// 先记录"原有记录都有哪些"
const before = new Map()
for (const line of originalText.split(/\r?\n/u)) {
  const match = /^ {2}([a-z][a-z0-9-]*\/[a-z][a-z0-9-]*):\s*$/u.exec(line)
  if (match !== null) before.set(match[1], line)
}
console.log('原有记录：')
for (const key of before.keys()) console.log(`  - ${key}`)

await bridge.modifyRecord(CREDENTIAL_RECORD, async () => ({
  kind: 'grant',
  payload: { version: 1, password: 'DUMMY-NOT-A-REAL-PASSWORD', updatedAt: '2026-01-01T00:00:00.000Z' },
}))

const afterText = fs.readFileSync(copyFile, 'utf8')
const afterLines = afterText.split(/\r?\n/u)

console.log('\n写入后的 diff（只列新增/删除行）：')
const beforeLines = new Set(originalText.split(/\r?\n/u))
const afterSet = new Set(afterLines)
for (const line of afterLines) if (!beforeLines.has(line)) console.log(`  + ${line}`)
for (const line of originalText.split(/\r?\n/u)) if (!afterSet.has(line)) console.log(`  - ${line}`)

console.log('\n检查：')
let problems = 0
for (const [key, line] of before) {
  if (!afterText.includes(line)) { console.log(`  ✗ 原有记录行被改动：${key}`); problems += 1 }
}
const originalBody = originalText.replace(/\s+$/u, '')
const afterBody = afterText.replace(/\s+$/u, '')
if (!afterBody.startsWith(originalBody.split(/\r?\n/u).slice(0, 1)[0])) { console.log('  ✗ 首行变了'); problems += 1 }
if (!afterText.includes(`  ${CREDENTIAL_RECORD}:`)) { console.log('  ✗ 新记录没写进去'); problems += 1 }
const addedLines = afterLines.filter(line => !beforeLines.has(line)).length
const removedLines = originalText.split(/\r?\n/u).filter(line => !afterSet.has(line)).length
console.log(`  新增 ${addedLines} 行，删除 ${removedLines} 行`)
if (removedLines !== 0) { console.log('  ✗ 有行被删除，应当只有新增'); problems += 1 }

console.log('')
if (problems === 0) {
  console.log('✅ 干净插入：原有内容一行未改，只多了一条记录；风格与原有记录一致（同样是 2/4 空格缩进）。')
} else {
  console.log(`❌ 发现 ${problems} 处问题，提交前必须先修。`)
  process.exitCode = 1
}

fs.rmSync(sandbox, { recursive: true, force: true })
