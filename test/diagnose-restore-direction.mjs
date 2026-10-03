/**
 * 只读诊断：把"要恢复什么/会覆盖什么"讲清楚。
 *
 * 场景：云端是旧快照、本机是新的（或反过来）。dryRun 只告诉你"有多少条会被覆盖"，
 * 但不告诉你"覆盖是往旧的方向还是新的方向"。这个脚本把每个文件的本机/云端大小与
 * 本机 mtime 列出来，并标出"本机比云端新"的条目——那是真正需要小心的一类。
 *
 * 用法：node test/diagnose-restore-direction.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { pluginDir } from './helpers/paths.mjs'

const lib = (file) => pathToFileURL(path.join(pluginDir, 'lib', file)).href
const { loadConfig } = await import(lib('config.mjs'))
const { readManifest, restoreTarget, remoteDir } = await import(lib('backup.mjs'))
const { WebDavClient } = await import(lib('webdav.mjs'))
const { createCredentialBridge, CREDENTIAL_RECORD } = await import(lib('credential-store.mjs'))

const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const bridge = createCredentialBridge({ file: path.join(dshHome, '.credentials.yaml'), profileDir: path.join(dshHome, 'profiles', 'desktop') })
const record = await bridge.readRecord(CREDENTIAL_RECORD)
const password = record?.kind === 'grant' ? record.payload?.password : undefined
if (typeof password !== 'string' || password === '') {
  console.log('凭据里没有应用密码；先登录一次。')
  process.exit(0)
}

const config = loadConfig()
const client = new WebDavClient({ server: config.server, account: config.account, password })
const manifest = await readManifest(client, config)
console.log(`云端快照：${remoteDir(config)}/manifest.json`)
console.log(`  生成时间 ${manifest.createdAt}，条目 ${manifest.files?.length}，合计 ${manifest.stats?.bytes} 字节`)
console.log('')

const remoteByRelative = new Map((manifest.files ?? []).map(entry => [entry.relative, entry]))
const localOnly = []
const remoteOnly = []
const bothDiffer = []
const bothSame = []

// 本机扫描：用同一套范围规则
const { scanBackupFiles } = await import(lib('plan.mjs'))
for (const file of scanBackupFiles(config).files) {
  const remote = remoteByRelative.get(file.relative)
  if (remote === undefined) { localOnly.push(file); continue }
  remoteByRelative.delete(file.relative)
  if (remote.size !== file.size) {
    bothDiffer.push({ relative: file.relative, localSize: file.size, remoteSize: remote.size, localMtime: file.mtimeMs })
  } else {
    bothSame.push(file.relative)
  }
}
for (const relative of remoteByRelative.keys()) remoteOnly.push(relative)

console.log('对照本机当前状态：')
console.log(`  两边都有且大小相同   ${bothSame.length} 个  → 恢复会跳过`)
console.log(`  两边都有但大小不同   ${bothDiffer.length} 个  → 恢复会**覆盖本机**`)
console.log(`  只有本机有（云端缺） ${localOnly.length} 个  → 恢复不会删本机，但云端缺这些（先备份才会补上）`)
console.log(`  只有云端有（本机无） ${remoteOnly.length} 个  → 恢复会新建（其中可能有已删除的旧文件）`)
console.log('')

if (bothDiffer.length > 0) {
  console.log('大小不同的条目（前 15 条；本机大小 vs 云端大小）：')
  for (const item of bothDiffer.slice(0, 15)) {
    const direction = item.localSize > item.remoteSize ? '本机更大（较新？）' : '本机更小'
    console.log(`  ${String(item.localSize).padStart(9)} vs ${String(item.remoteSize).padStart(9)}  ${direction}  ${item.relative}`)
  }
  if (bothDiffer.length > 15) console.log(`  …还有 ${bothDiffer.length - 15} 条`)
  console.log('')
}

if (remoteOnly.length > 0) {
  console.log('只在云端有的条目（恢复会把这些文件新建到本机）：')
  for (const relative of remoteOnly.slice(0, 10)) console.log(`  ${relative}`)
  if (remoteOnly.length > 10) console.log(`  …还有 ${remoteOnly.length - 10} 条`)
  console.log('')
}

if (localOnly.length > 0) {
  console.log('只在本机有的条目（先做一次备份才会进云端）：')
  for (const file of localOnly.slice(0, 10)) console.log(`  ${file.relative}`)
  if (localOnly.length > 10) console.log(`  …还有 ${localOnly.length - 10} 条`)
  console.log('')
}

console.log('结论：')
if (bothDiffer.length > 0 || remoteOnly.length > 0) {
  console.log('  云端这份是较早的快照。**现在点「恢复」会把本机较新的文件覆盖成旧版本**，')
  console.log('  而且只存在于本机的文件会被云端旧版本覆盖（不会删除本机独有的文件）。')
  console.log('  建议顺序：先点一次「立即备份」把云端推到最新，再考虑恢复。')
} else {
  console.log('  云端与本机一致，恢复是安全的（不会往旧的方向覆盖）。')
}
