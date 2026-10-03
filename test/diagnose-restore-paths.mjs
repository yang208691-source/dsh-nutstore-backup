/**
 * 诊断：把远端 manifest 里的每一条 relative 都过一遍 restoreTarget()，
 * 列出"映射不出本机路径"的条目。这是换机恢复能否成功的关键——
 * 之前只测了单层 sessions/xxx.jsonl，漏掉了真实的三层结构
 * `sessions/<工作区编码>/<会话id>/session.v4.jsonl.zstd`。
 *
 * 只读：不下载、不写盘。
 * 用法：node test/diagnose-restore-paths.mjs [machine]
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const lib = (file) => pathToFileURL(path.join('D:/My Agent/dev/dsh-nutstore-backup/lib', file)).href
const { loadConfig } = await import(lib('config.mjs'))
const { readManifest, remoteDir } = await import(lib('backup.mjs'))
const { WebDavClient } = await import(lib('webdav.mjs'))
const { loadPassword } = await import(lib('credential.mjs'))
const { restoreTarget } = await import(lib('backup.mjs'))

process.env.DSH_HOME = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '.', '.dsh')
process.env.DSH_PROFILE = process.env.DSH_PROFILE ?? 'desktop'

const config = loadConfig()
// 独立进程里没有宿主 ctx：明文回退文件也没有 → 直接从 .credentials.yaml 读
const credentialsFile = path.join(process.env.DSH_HOME, '.credentials.yaml')
const { createCredentialBridge } = await import(lib('credential-store.mjs'))
const bridge = createCredentialBridge({ file: credentialsFile, profileDir: path.join(process.env.DSH_HOME, 'profiles', 'desktop') })
const { password } = await loadPassword({ get: (name) => (name === 'credentials' && bridge.unsupported !== true ? bridge : undefined) })
if (password === undefined) {
  console.log('读不到应用密码（凭据文件里没有记录？）')
  process.exit(0)
}

const client = new WebDavClient({ server: config.server, account: config.account, password })
const manifest = await readManifest(client, config)
if (manifest === undefined) {
  console.log(`读不到远端 manifest（${remoteDir(config)}/manifest.json）`)
  process.exit(0)
}

console.log(`远端目录：${remoteDir(manifest.machine === config.machine ? config : { ...config, machine: manifest.machine })}`)
console.log(`manifest：machine=${manifest.machine} files=${manifest.stats?.files} bytes=${manifest.stats?.bytes}`)
console.log(`本机：DSH_HOME=${process.env.DSH_HOME} 工作区=${config.workspaceDir}`)
console.log('')

const byRoot = new Map()
const unmapped = []
for (const entry of manifest.files ?? []) {
  const root = String(entry.relative).split('/')[0]
  byRoot.set(root, (byRoot.get(root) ?? 0) + 1)
  const target = restoreTarget(entry.relative, config)
  if (target === undefined) unmapped.push(entry.relative)
}

console.log('按备份根统计：')
for (const [root, count] of byRoot) console.log(`  ${root.padEnd(12)} ${count} 个文件`)
console.log('')
console.log(`映射不出本机路径的条目：${unmapped.length} / ${manifest.files?.length ?? 0}`)
for (const relative of unmapped.slice(0, 10)) console.log(`  ${relative}`)
if (unmapped.length > 10) console.log(`  …还有 ${unmapped.length - 10} 条`)

console.log('\n能映射的样例（前 5 条）：')
for (const entry of (manifest.files ?? []).slice(0, 5)) {
  const target = restoreTarget(entry.relative, config)
  console.log(`  ${entry.relative}\n    → ${target ?? '(映射失败)'}`)
}
