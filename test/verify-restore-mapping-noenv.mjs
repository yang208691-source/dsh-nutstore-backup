/**
 * 真机接缝验证：**在"没有 DSH_HOME"的环境下**（桌面壳启动的宿主就是这样）
 * 把真实 manifest 的每一条都过一遍 restoreTarget()。
 *
 * 为什么单独做这一步：早期 restoreTarget() 只看 DSH_HOME，拿不到就一律返回 undefined，
 * 于是真机上"恢复"100% 失败，而带环境变量的独立进程/测试里全绿。
 * 这里刻意不设 DSH_HOME，走 USERPROFILE → os.homedir() 的回退。
 *
 * 只读：不下载、不写盘。
 * 用法：node test/verify-restore-mapping-noenv.mjs
 */
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const failures = []
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(`${label} ${detail}`)
    console.log(`  FAIL  ${label} ${detail}`)
  }
}

// 模拟宿主环境：没有 DSH_HOME，只有 USERPROFILE（Windows 桌面上就是这样）
const simulatedUserProfile = process.env.USERPROFILE ?? os.homedir()
delete process.env.DSH_HOME
process.env.USERPROFILE = simulatedUserProfile
process.env.DSH_PROFILE = process.env.DSH_PROFILE ?? 'desktop'
delete process.env.DSH_PROFILE_DIR

const lib = (file) => pathToFileURL(path.join('D:/My Agent/dev/dsh-nutstore-backup/lib', file)).href
const { loadConfig } = await import(lib('config.mjs'))
const { readManifest, restoreTarget } = await import(lib('backup.mjs'))
const { WebDavClient } = await import(lib('webdav.mjs'))
const { createCredentialBridge, CREDENTIAL_RECORD } = await import(lib('credential-store.mjs'))

console.log('模拟宿主环境：')
console.log(`  DSH_HOME      = ${process.env.DSH_HOME ?? '(未设置)'}`)
console.log(`  USERPROFILE   = ${process.env.USERPROFILE}`)
console.log(`  DSH_PROFILE_DIR = ${process.env.DSH_PROFILE_DIR ?? '(未设置)'}`)

const config = loadConfig()
console.log(`  工作区        = ${config.workspaceDir}`)
console.log(`  远端          = ${config.server}${config.remoteRoot}/${config.machine}`)

// 凭据：桥自己会按 DSH_HOME→USERPROFILE 解析凭据文件位置
const expectedHome = path.join(simulatedUserProfile, '.dsh')
const bridge = createCredentialBridge({ file: path.join(expectedHome, '.credentials.yaml'), profileDir: path.join(expectedHome, 'profiles', 'desktop') })
const record = await bridge.readRecord(CREDENTIAL_RECORD)
const password = record?.kind === 'grant' ? record.payload?.password : undefined
if (typeof password !== 'string' || password === '') {
  console.log('凭据里没有应用密码；先登录一次再跑这个脚本。')
  process.exit(0)
}

console.log('\n[1] 真实 manifest')
const manifest = await readManifest(new WebDavClient({ server: config.server, account: config.account, password }), config)
check('读到了 manifest', manifest !== undefined)
if (manifest === undefined) process.exit(1)
console.log(`  files=${manifest.files?.length} bytes=${manifest.stats?.bytes} createdAt=${manifest.createdAt}`)

console.log('\n[2] 没有 DSH_HOME 时，每一条都要能映射回本机路径')
const byRoot = new Map()
const unmapped = []
for (const entry of manifest.files ?? []) {
  const root = String(entry.relative).split('/')[0]
  const bucket = byRoot.get(root) ?? { total: 0, mapped: 0 }
  bucket.total += 1
  const target = restoreTarget(entry.relative, config)
  if (target === undefined) {
    unmapped.push(entry.relative)
  } else {
    bucket.mapped += 1
    // 抽查落点是否在"本机 DSH_HOME / 工作区"里，而不是源机路径
    if (root === 'sessions' || root === 'profile' || root === 'pluginsrc') {
      if (!target.startsWith(expectedHome)) unmapped.push(`${entry.relative} → 落点不在 ${expectedHome}：${target}`)
    }
    if (root === 'workspace' && !target.startsWith(config.workspaceDir)) {
      unmapped.push(`${entry.relative} → 落点不在工作区 ${config.workspaceDir}：${target}`)
    }
  }
  byRoot.set(root, bucket)
}
for (const [root, bucket] of byRoot) {
  console.log(`  ${root.padEnd(11)} ${bucket.mapped}/${bucket.total} 可映射`)
}
check(`${manifest.files?.length} 条全部可映射`, unmapped.length === 0, unmapped.slice(0, 3).join(' | '))
check('落点都基于本机 DSH_HOME（不是源机路径）', unmapped.length === 0, unmapped.slice(0, 2).join(' | '))

console.log('\n[3] 抽样看几个真实落点')
for (const entry of (manifest.files ?? []).slice(0, 4)) {
  console.log(`  ${entry.relative}\n    → ${restoreTarget(entry.relative, config)}`)
}

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} 项失败：`)
  for (const failure of failures) console.log(`   - ${failure}`)
  process.exitCode = 1
} else {
  console.log('\n✅ 在没有 DSH_HOME 的环境下，全部条目都能映射回本机路径')
}
