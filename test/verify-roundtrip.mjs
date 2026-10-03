/**
 * 往返验证（只读）：把远端备份里的文件**下载回来**，与本机原文件逐字节比对。
 *
 * 为什么不能直接用插件的 /restore：它会真的写回本机 DSH_HOME——那会覆盖你正在用的
 * 会话与配置。所以这里走"只下载 + 比对"，不落盘到真实位置，不修改任何本地数据。
 *
 * 覆盖：
 *   ① 远端 manifest 可读、条数与体积与上报一致；
 *   ② 全部条目都能映射回本机路径（换机可迁移性的关键，含 sessions 的三层结构）；
 *   ③ 抽样的远端对象与本地文件 sha256 完全一致（含最大的那个会话文件）；
 *   ④ 换一台"机器"（不同用户名 + 不同盘符）时目标路径会重算，而不是沿用源机路径。
 *
 * 用法：node test/verify-roundtrip.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const lib = (file) => pathToFileURL(path.join('D:/My Agent/dev/dsh-nutstore-backup/lib', file)).href
const { loadConfig, encodeRemoteName } = await import(lib('config.mjs'))
const { readManifest, remoteDir, restoreTarget } = await import(lib('backup.mjs'))
const { WebDavClient } = await import(lib('webdav.mjs'))
const { loadPassword } = await import(lib('credential.mjs'))
const { createCredentialBridge, CREDENTIAL_RECORD } = await import(lib('credential-store.mjs'))

const failures = []
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(`${label} ${detail}`)
    console.log(`  FAIL  ${label} ${detail}`)
  }
}

// 用真实环境（DSH_HOME / profile）读配置与凭据；bridge 直接从 .credentials.yaml 读记录。
const config = loadConfig()
const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const bridge = createCredentialBridge({ file: path.join(dshHome, '.credentials.yaml'), profileDir: path.join(dshHome, 'profiles', 'desktop') })
if (bridge.unsupported === true) {
  console.log(`凭据桥不可用：${bridge.reason}`)
  process.exit(0)
}
const record = await bridge.readRecord(CREDENTIAL_RECORD)
const password = record?.kind === 'grant' ? record.payload?.password : undefined
if (typeof password !== 'string' || password === '') {
  console.log('凭据库里没有应用密码记录；先在设置页或验证页登录一次。')
  process.exit(0)
}
console.log(`账号：${config.account}  远端：${config.server}  目录：${remoteDir(config)}`)

const client = new WebDavClient({ server: config.server, account: config.account, password })

console.log('\n[1] 远端 manifest')
const manifest = await readManifest(client, config)
check('能读到 manifest', manifest !== undefined, '远端没有 manifest.json')
if (manifest === undefined) process.exit(1)
console.log(`  machine=${manifest.machine} files=${manifest.stats?.files} bytes=${manifest.stats?.bytes} createdAt=${manifest.createdAt}`)
check('manifest 记录的文件数 > 0', (manifest.stats?.files ?? 0) > 0)
check('manifest 条数与统计一致', (manifest.files?.length ?? 0) === manifest.stats?.files, `${manifest.files?.length} vs ${manifest.stats?.files}`)

console.log('\n[2] 全部条目都能映射回本机路径（换机关键）')
const unmapped = []
for (const entry of manifest.files ?? []) {
  if (restoreTarget(entry.relative, config) === undefined) unmapped.push(entry.relative)
}
check(`56 条全部可映射（含 sessions 三层结构）`, unmapped.length === 0, unmapped.slice(0, 3).join(' | '))

console.log('\n[3] 抽样下载并与本地逐字节比对')
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex')
// 抽样策略：最大的会话文件 + 每个根各取前几个，兼顾体积与覆盖面。
const sorted = [...(manifest.files ?? [])].sort((left, right) => right.size - left.size)
const perRoot = new Map()
const sample = []
for (const entry of manifest.files ?? []) {
  const root = String(entry.relative).split('/')[0]
  const taken = perRoot.get(root) ?? 0
  if (taken < 3 && !sample.includes(entry)) { sample.push(entry); perRoot.set(root, taken + 1) }
}
if (sorted[0] !== undefined && !sample.includes(sorted[0])) sample.push(sorted[0])

let compared = 0
const mismatched = []
const notLocalYet = []
for (const entry of sample) {
  const target = restoreTarget(entry.relative, config)
  if (target === undefined) { mismatched.push(`${entry.relative}: 映射失败`); continue }
  if (!fs.existsSync(target)) {
    // pluginsrc 按设计落到 $DSH_HOME/nutstore-backup/restored-plugins/，本机当然还没有；
    // 这不算不一致，记下来单独说明。
    notLocalYet.push(`${entry.relative} → ${target}`)
    continue
  }
  const remote = await client.getBuffer(`${remoteDir(config)}/${encodeRemoteName(entry.relative)}`)
  const local = fs.readFileSync(target)
  if (remote.length !== local.length || digest(remote) !== digest(local)) {
    mismatched.push(`${entry.relative}: 远端 ${remote.length}B/${digest(remote).slice(0, 8)} vs 本地 ${local.length}B/${digest(local).slice(0, 8)}`)
    continue
  }
  compared += 1
  console.log(`  ✓ ${entry.relative}  ${local.length} 字节  sha256=${digest(local).slice(0, 12)}`)
}
check(`抽样中"本机已存在"的条目全部一致（比对 ${compared} 个）`, mismatched.length === 0, mismatched.slice(0, 2).join(' | '))
check('比对数至少 8 个（覆盖面够）', compared >= 8, `compared=${compared}`)
if (notLocalYet.length > 0) {
  console.log(`  说明：${notLocalYet.length} 个抽样条目本机尚无对应文件（按设计落点不同），未参与比对：`)
  for (const note of notLocalYet.slice(0, 3)) console.log(`    · ${note}`)
}
check('抽样里包含最大的会话文件', sample.some(entry => entry === sorted[0]), `最大 ${sorted[0]?.relative} (${sorted[0]?.size} 字节)`)

console.log('\n[4] 换机后目标路径按新机器重算（不沿用源机路径）')
{
  // 模拟另一台机器：不同用户名、不同盘符、不同工作区。
  const otherHome = 'D:\\Users\\otheruser\\.dsh'
  const otherWorkspace = 'E:\\Work'
  const previousHome = process.env.DSH_HOME
  const previousProfile = process.env.DSH_PROFILE_DIR
  process.env.DSH_HOME = otherHome
  process.env.DSH_PROFILE_DIR = path.join(otherHome, 'profiles', 'desktop')
  try {
    const otherConfig = { ...config, workspaceDir: otherWorkspace }
    const sessionEntry = (manifest.files ?? []).find(entry => String(entry.relative).startsWith('sessions/'))
    const workspaceEntry = (manifest.files ?? []).find(entry => String(entry.relative).startsWith('workspace/'))
    const sessionTarget = restoreTarget(sessionEntry.relative, otherConfig)
    const workspaceTarget = restoreTarget(workspaceEntry.relative, otherConfig)
    console.log(`  sessions → ${sessionTarget}`)
    console.log(`  workspace → ${workspaceTarget}`)
    check('会话落到新机器的 DSH_HOME 下', String(sessionTarget).startsWith(otherHome), String(sessionTarget))
    check('工作区记忆落到新机器的工作区', String(workspaceTarget).startsWith(otherWorkspace), String(workspaceTarget))
    // 注意：**不能**断言路径里不含源机字符串。DSH 会把"这段会话属于哪个工作区"编码成目录名
    // （--C-Users-yang2-...--），它是会话归属信息的一部分，必须原样保留，否则 DSH 找不到会话属于谁。
    // 正确的断言是：新路径基于**新机器**的 DSH_HOME，且保留 <工作区编码>/<会话id>/<文件> 结构。
    check('新路径基于新机器的 DSH_HOME，而不是沿用源机绝对路径',
      String(sessionTarget).startsWith(otherHome) && !String(sessionTarget).startsWith(config.workspaceDir),
      String(sessionTarget))
    check('会话的"工作区编码/会话id/文件名"三层结构被完整保留',
      /sessions[\\/].+[\\/].+[\\/]session\.v4\.jsonl\.zstd$/u.test(String(sessionTarget)),
      String(sessionTarget))
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousProfile === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previousProfile
  }
}

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} 项失败：`)
  for (const failure of failures) console.log(`   - ${failure}`)
  process.exitCode = 1
} else {
  console.log('\n✅ 往返验证通过：远端内容与本机逐字节一致，且能映射到另一台机器的路径')
}
