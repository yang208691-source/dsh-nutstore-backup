/**
 * 回答两个具体问题（只读，不下载内容）：
 *   ① 插件源码到底有没有被备份进去？备份了哪些文件？
 *   ② 恢复时它们会落到哪里？恢复之后插件就能用了吗？
 *
 * 用法：node test/verify-plugin-backup.mjs
 */
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
const client = new WebDavClient({ server: config.server, account: config.account, password })
const manifest = await readManifest(client, config)
if (manifest === undefined) {
  console.log('读不到远端 manifest')
  process.exit(1)
}

const pluginEntries = (manifest.files ?? []).filter(entry => String(entry.relative).startsWith('pluginsrc/'))
console.log(`远端备份：${remoteDir(config)}/manifest.json`)
console.log(`总条目 ${manifest.files?.length}，其中 pluginsrc/ 下 ${pluginEntries.length} 个，合计 ${pluginEntries.reduce((sum, entry) => sum + entry.size, 0)} 字节`)
console.log('')

console.log('① 插件源码被备份的文件（按体积排序，取前 20）：')
for (const entry of [...pluginEntries].sort((left, right) => right.size - left.size).slice(0, 20)) {
  console.log(`   ${String(entry.size).padStart(8)} 字节  ${entry.relative}`)
}
const libs = pluginEntries.filter(entry => entry.relative.startsWith('pluginsrc/lib/'))
console.log(`   …其中 lib/ 下 ${libs.length} 个（核心代码）`)
console.log('')

console.log('② 恢复时会落到的位置（抽样 5 个）：')
for (const entry of pluginEntries.slice(0, 5)) {
  console.log(`   ${entry.relative}`)
  console.log(`     → ${restoreTarget(entry.relative, config)}`)
}
console.log('')

// 关键结论：pluginsrc 的落点是 restored-plugins，不是 profile 的 node_modules
const sample = pluginEntries[0]
const target = restoreTarget(sample.relative, config)
const expectedRoot = path.join(dshHome, 'nutstore-backup', 'restored-plugins')
console.log('③ 结论：')
console.log(`   落点根目录 = ${expectedRoot}`)
console.log(`   实际落点   = ${target}`)
console.log(`   是否落在 restored-plugins 下 = ${String(target).startsWith(expectedRoot)}`)
console.log(`   是否直接落进 profile 的 node_modules = ${String(target).includes(`${path.sep}node_modules${path.sep}`)}`)

// 与远端实际对象数对一下，确认这些对象真的在云端（而不是只在清单里）
const listing = await client.list(`${remoteDir(config)}`, 1)
const objects = listing.filter(entry => !entry.collection)
console.log('')
console.log(`④ 云端实际对象数 = ${objects.length}（清单条目 ${manifest.files?.length} + manifest.json + info.json）`)
