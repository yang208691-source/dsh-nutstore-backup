/**
 * 用**真实 manifest** 预演一遍"旧快照保护"的效果（只读，不落盘）。
 *
 * 回答的问题：现在点「恢复」会覆盖哪些文件？其中有多少会被新保护拦住？
 *
 * 用法：node test/verify-restore-protection.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const lib = (file) => pathToFileURL(path.join('D:/My Agent/dev/dsh-nutstore-backup/lib', file)).href
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
const manifest = await readManifest(new WebDavClient({ server: config.server, account: config.account, password }), config)
console.log(`云端快照生成于 ${manifest.createdAt}（这是"上一次备份时"的状态）`)
console.log('')

const PROTECTION_WINDOW_MS = 2000
const wouldOverwrite = []
const wouldProtect = []
const wouldSkipSameSize = []
const noEntryMtime = []

for (const entry of manifest.files ?? []) {
  const target = restoreTarget(entry.relative, config)
  if (target === undefined) continue
  let stat
  try {
    stat = fs.statSync(target)
  } catch {
    continue // 本机没有 → 会新建，不算"覆盖"
  }
  if (stat.size === entry.size) {
    wouldSkipSameSize.push(entry.relative)
    continue
  }
  if (typeof entry.mtimeMs !== 'number' || entry.mtimeMs <= 0) {
    noEntryMtime.push(entry.relative)
    wouldOverwrite.push({ relative: entry.relative, localSize: stat.size, remoteSize: entry.size, localMtimeMs: Math.trunc(stat.mtimeMs) })
    continue
  }
  const localMtimeMs = Math.trunc(stat.mtimeMs)
  if (localMtimeMs > entry.mtimeMs + PROTECTION_WINDOW_MS) {
    wouldProtect.push({ relative: entry.relative, localSize: stat.size, remoteSize: entry.size, localMtimeMs, remoteMtimeMs: entry.mtimeMs })
  } else {
    wouldOverwrite.push({ relative: entry.relative, localSize: stat.size, remoteSize: entry.size, localMtimeMs, remoteMtimeMs: entry.mtimeMs })
  }
}

console.log(`大小相同、本来就会跳过        ${wouldSkipSameSize.length} 个`)
console.log(`大小不同、会被新保护拦住      ${wouldProtect.length} 个   ← 这些不会再用旧快照覆盖本机`)
console.log(`大小不同、确实会被云端覆盖    ${wouldOverwrite.length} 个   ← 云端那份更新，覆盖是正确方向`)
if (noEntryMtime.length > 0) console.log(`（其中 ${noEntryMtime.length} 个清单条目没有 mtime，无法判断，按覆盖处理）`)
console.log('')

if (wouldProtect.length > 0) {
  console.log('被保护的文件（本机更新，保持不动）：')
  for (const item of wouldProtect) {
    const minutes = Math.round((item.localMtimeMs - item.remoteMtimeMs) / 60000)
    console.log(`  ${item.relative}`)
    console.log(`    本机 ${String(item.localSize).padStart(9)} 字节 / 云端 ${String(item.remoteSize).padStart(9)} 字节，本机比云端新约 ${minutes} 分钟`)
  }
  console.log('')
}

if (wouldOverwrite.length > 0) {
  console.log('会被云端覆盖的文件（云端更新，方向正确）：')
  for (const item of wouldOverwrite.slice(0, 10)) console.log(`  ${item.relative}`)
  if (wouldOverwrite.length > 10) console.log(`  …还有 ${wouldOverwrite.length - 10} 条`)
  console.log('')
}

console.log('结论：')
if (wouldProtect.length > 0) {
  console.log('  有本机更新的文件。默认「恢复」会跳过它们，所以误点不会再丢新数据；')
  console.log('  要完全回到云端原样，得显式勾上「以云端为准」。')
} else {
  console.log('  没有"本机更新"的文件，默认恢复不会往旧方向覆盖。')
}
