/**
 * 对比"本地源码"与"GitHub 仓库"，列出需要重新上传的文件。
 *
 * 为什么要这个：发布是"网页手动上传"，漏传一个文件 CI 会继续红，多传又浪费时间。
 *
 * 关键实现：**用 git blob 哈希比对，而不是逐文件下载内容**。
 * GitHub 的 trees 接口一次就能返回整棵树的 blob sha；本地按同样的算法
 * （`blob <长度>\0<内容>` 的 SHA-1）算出来即可。逐文件拉内容会撞匿名 API 限流
 * （60 次/小时），实测就是这样失败的。
 *
 * 用法：node compare-with-remote.mjs [owner/repo]
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = process.argv[2] ?? 'yang208691-source/dsh-nutstore-backup'
const here = path.dirname(fileURLToPath(import.meta.url))

/** 本地杂物，不参与对比。 */
const SKIP_DIRS = new Set(['node_modules', '.git'])
const SKIP_FILES = new Set(['.test-run.log'])

/** 本文件自己只是个辅助工具，不必上传。 */
const SELF = 'compare-with-remote.mjs'

function listLocal(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name)) return []
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return listLocal(full, rel)
    return [rel]
  })
}

/** git 的 blob 哈希：sha1("blob " + 字节数 + "\0" + 内容)。 */
function gitBlobSha(buffer) {
  return createHash('sha1').update(`blob ${buffer.length}\0`, 'utf8').update(buffer).digest('hex')
}

const headers = { 'User-Agent': 'dsh-compare', Accept: 'application/vnd.github+json' }
const metaRes = await fetch(`https://api.github.com/repos/${repo}`, { headers, signal: AbortSignal.timeout(30000) })
if (!metaRes.ok) {
  console.error(`读仓库失败：HTTP ${metaRes.status}（检查 owner/repo 是否正确）`)
  process.exit(1)
}
const meta = await metaRes.json()
const treeRes = await fetch(`https://api.github.com/repos/${repo}/git/trees/${meta.default_branch}?recursive=1`, { headers, signal: AbortSignal.timeout(30000) })
if (!treeRes.ok) {
  console.error(`读文件树失败：HTTP ${treeRes.status}（匿名 API 限流？等一会儿再试）`)
  process.exit(1)
}
const tree = await treeRes.json()
const remoteBlobs = new Map(
  (tree.tree ?? []).filter(item => item.type === 'blob').map(item => [item.path, item.sha]),
)

const localFiles = listLocal(here).filter(file => file !== SELF).sort()
const missing = []
const changed = []
for (const file of localFiles) {
  const buffer = fs.readFileSync(path.join(here, file))
  const sha = gitBlobSha(buffer)
  const remoteSha = remoteBlobs.get(file)
  if (remoteSha === undefined) missing.push({ file, bytes: buffer.length })
  else if (remoteSha !== sha) changed.push({ file, localBytes: buffer.length })
}
const localSet = new Set(localFiles)
const onlyRemote = [...remoteBlobs.keys()].filter(file => !localSet.has(file)).sort()

console.log(`对比仓库 ${repo}（分支 ${meta.default_branch}）与本地`)
console.log(`  本地 ${localFiles.length} 个文件 / 仓库 ${remoteBlobs.size} 个文件`)
console.log('')

console.log(missing.length === 0
  ? '✅ 仓库里不缺文件'
  : `❌ 仓库里缺 ${missing.length} 个文件（必须上传）：\n${missing.map(item => `   ${item.file}  (${item.bytes} 字节)`).join('\n')}`)
console.log('')

console.log(changed.length === 0
  ? '✅ 共有文件内容全部一致'
  : `⚠️ 内容不同，需要重新上传覆盖（${changed.length} 个）：\n${changed.map(item => `   ${item.file}  (本地 ${item.localBytes} 字节)`).join('\n')}`)
console.log('')

if (onlyRemote.length > 0) {
  console.log(`ℹ️ 只在仓库里有（本地已删，${onlyRemote.length} 个）——不需要上传，必要时在网页上删掉：`)
  for (const file of onlyRemote) console.log(`   ${file}`)
  console.log('')
}

const todo = [...missing.map(item => item.file), ...changed.map(item => item.file)]
console.log(todo.length === 0
  ? '✅ 不需要上传任何文件'
  : `需要上传 ${todo.length} 个文件（网页：Add file → Upload files，保持目录结构）：\n${todo.map(file => `   ${file}`).join('\n')}`)
