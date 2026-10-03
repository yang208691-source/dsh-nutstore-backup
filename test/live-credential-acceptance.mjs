/**
 * 真实提交验证：往**真实** `.credentials.yaml` 写一条**假密码**记录，
 * 看正在运行的 DSH 宿主是否认（`/dsh-nutstore/state` 是否变 loggedIn），
 * 然后立刻撤销并逐字节核对文件已还原。
 *
 * 这是"DSH 的凭据解析器接受本插件写入格式"的端到端证明。
 * 风险与防护：写入前有 .bak 备份；本脚本最后会删除记录并核对还原；
 * 记录里放的是显眼的假值，不会被误当成真密码使用。
 *
 * 用法：node test/live-credential-acceptance.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const WEB = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387'
const realFile = path.join(os.homedir(), '.dsh', '.credentials.yaml')

const failures = []
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(`${label} ${detail}`)
    console.log(`  FAIL  ${label} ${detail}`)
  }
}
function recordLines(text) {
  return text.split(/\r?\n/u).filter(line => /^ {2}[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*:\s*$/u.test(line))
}

if (!fs.existsSync(realFile)) {
  console.log(`真实凭据文件不存在：${realFile}；跳过（这台机器还没登录过任何东西）`)
  process.exit(0)
}

const originalText = fs.readFileSync(realFile, 'utf8')
const originalRecords = new Set(recordLines(originalText))
console.log(`真实凭据文件：${realFile}`)
console.log(`原有记录数：${originalRecords.size}`)

const lib = (file) => pathToFileURL(path.join('D:/My Agent/dev/dsh-nutstore-backup/lib', file)).href
const { createCredentialBridge, CREDENTIAL_RECORD } = await import(lib('credential-store.mjs'))
const bridge = createCredentialBridge({ file: realFile, profileDir: path.join(os.homedir(), '.dsh', 'profiles', 'desktop') })
if (bridge.unsupported === true) {
  console.log(`桥不可用：${bridge.reason}`)
  process.exit(0)
}

async function liveState() {
  const response = await fetch(`${WEB}/dsh-nutstore/state`, { cache: 'no-store' })
  return await response.json()
}

console.log('\n[1] 提交前的 live 状态')
const before = await liveState()
console.log(`  loggedIn=${before.loggedIn} password.service=${before.password?.service} label=${before.password?.label}`)
check('凭据服务对 live 宿主可用', before.password?.service === 'available', JSON.stringify(before.password))

console.log('\n[2] 写入一条假密码记录')
let backupFile
try {
  await bridge.modifyRecord(CREDENTIAL_RECORD, async () => ({
    kind: 'grant',
    payload: { version: 1, password: 'DUMMY-NOT-A-REAL-PASSWORD', updatedAt: new Date().toISOString() },
  }))
  const backups = fs.readdirSync(path.dirname(realFile)).filter(name => name.startsWith('.credentials.yaml.bak-'))
  backupFile = backups.length === 0 ? undefined : path.join(path.dirname(realFile), backups.sort().at(-1))
  check('写入成功并留下备份', backupFile !== undefined, String(backupFile))
  check('备份内容 = 写入前原文', backupFile !== undefined && fs.readFileSync(backupFile, 'utf8') === originalText)
  const nowText = fs.readFileSync(realFile, 'utf8')
  check('原有记录一条没少', [...originalRecords].every(line => nowText.includes(line)), recordLines(nowText).join(','))
  check('新记录已写入', nowText.includes(`  ${CREDENTIAL_RECORD}:`))

  console.log('\n[3] 等 live 宿主重新加载凭据文件（它有 chokidar 监视）')
  let accepted = false
  let observed
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 500))
    try {
      observed = await liveState()
      if (observed.loggedIn === true) { accepted = true; break }
    } catch {
      // web 还没起来/短暂失败，继续等。
    }
  }
  console.log(`  观察到的状态：loggedIn=${observed?.loggedIn} label=${observed?.password?.label}`)
  check('live 宿主接受该格式并报告"已登录"（= DSH 凭据解析器认可本插件写入）', accepted, JSON.stringify(observed?.password))
  check('state 里指明了记录地址', String(observed?.password?.label ?? '').includes(CREDENTIAL_RECORD), String(observed?.password?.label))
} finally {
  console.log('\n[4] 撤销：删除假记录并核对文件已还原')
  try {
    await bridge.deleteRecord(CREDENTIAL_RECORD)
  } catch (error) {
    console.log(`  删除时出错：${error instanceof Error ? error.message : String(error)}`)
  }
  const restoredText = fs.readFileSync(realFile, 'utf8')
  check('记录已删除', !restoredText.includes(`  ${CREDENTIAL_RECORD}:`))
  // 允许尾部空行差异：只比对"去掉行尾空白后的正文"
  const normalize = (text) => text.split(/\r?\n/u).map(line => line.replace(/\s+$/u, '')).join('\n').replace(/\n+$/u, '')
  check('文件已逐字节还原为原文（忽略行尾空白）', normalize(restoredText) === normalize(originalText), `\n--- 现在 ---\n${restoredText}\n--- 原来 ---\n${originalText}`)
  check('没有留下 .tmp 临时文件', !fs.readdirSync(path.dirname(realFile)).some(name => name.endsWith('.tmp')), fs.readdirSync(path.dirname(realFile)).join(','))

  console.log('\n[5] 撤销后 live 状态应回到未登录')
  await new Promise(resolve => setTimeout(resolve, 1500))
  const after = await liveState()
  console.log(`  loggedIn=${after.loggedIn}`)
  check('已回到未登录', after.loggedIn === false, JSON.stringify(after.password))
  console.log(`  （备份文件保留以便人工核对：${backupFile ?? '(无)'}）`)
}

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} 项失败：`)
  for (const failure of failures) console.log(`   - ${failure}`)
  process.exitCode = 1
} else {
  console.log('\n✅ live 宿主接受本插件写入的凭据格式，且撤销后文件完好')
}
