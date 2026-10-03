/**
 * 预检：按 DSH app-boot 的解析方式，确认 profile 里新加的 bundle 真的能被解析到。
 *
 * app-boot 的 resolveBundleDir 依次从「安装锚点」和「profile 的 package.json」两个
 * 锚点做 Node 解析（packageDirFromAnchor = createRequire(anchor).resolve(name) 再取目录）。
 * 这里**按同样的方式**验证 dsh-nutstore-backup 能解析、能读到 dsh.bundle.patch，
 * 以免重启后插件被静默 skip。
 *
 * 用法：node test/profile-resolution-test.mjs [profileDir]
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const profileDir = process.argv[2] ?? process.env.DSH_PROFILE_DIR ?? 'C:\\Users\\yang2\\.dsh\\profiles\\desktop'
const packageName = 'dsh-nutstore-backup'

const failures = []
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(`${label} ${detail}`)
    console.log(`  FAIL  ${label} ${detail}`)
  }
}

console.log(`\nprofile: ${profileDir}`)
const profileManifestPath = path.join(profileDir, 'package.json')
check('profile package.json 存在', fs.existsSync(profileManifestPath))

const manifest = JSON.parse(fs.readFileSync(profileManifestPath, 'utf8'))
const bundles = manifest.dsh?.profile?.bundles ?? []
console.log('  bundles:', bundles.join(', '))
check(`${packageName} 已在 dsh.profile.bundles 里`, bundles.includes(packageName))

// app-boot 的解析方式：从 profile 的 package.json 锚点解析
const anchorRequire = createRequire(profileManifestPath)
let packageDir
try {
  packageDir = path.dirname(anchorRequire.resolve(`${packageName}/package.json`))
} catch {
  // 包没有导出 ./package.json 时，退回解析主入口再取目录
  try {
    packageDir = path.dirname(anchorRequire.resolve(packageName))
  } catch (error) {
    packageDir = undefined
    check('能从 profile 锚点解析到插件包', false, error instanceof Error ? error.message : String(error))
  }
}
if (packageDir !== undefined) check('能从 profile 锚点解析到插件包', fs.existsSync(path.join(packageDir, 'package.json')), String(packageDir))
console.log('  resolved:', packageDir)

if (packageDir !== undefined) {
  const pluginManifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
  check('name 与 profile 里登记的一致', pluginManifest.name === packageName, String(pluginManifest.name))
  const bundle = pluginManifest.dsh?.bundle
  check('声明了 dsh.bundle.patch', bundle?.patch !== undefined, JSON.stringify(bundle))
  const patchPaths = (typeof bundle?.patch === 'string' ? [bundle.patch] : bundle?.patch ?? []).map(file => path.join(packageDir, file))
  check('patch 文件真实存在', patchPaths.length > 0 && patchPaths.every(file => fs.existsSync(file)), patchPaths.join(','))
  for (const patchPath of patchPaths) {
    const text = fs.readFileSync(patchPath, 'utf8')
    check(`${path.basename(patchPath)} 里有 insert 条目且 name 正确`,
      /insert:/u.test(text) && new RegExp(`name:\\s*['"]?${packageName}`, 'u').test(text), text.slice(0, 120).replace(/\n/gu, ' '))
  }
  const main = path.join(packageDir, pluginManifest.main ?? 'lib/index.mjs')
  check('主入口文件存在', fs.existsSync(main), main)
  check('host 半区导出 default 或 apply', /export (default|function apply|const apply|\{)/u.test(fs.readFileSync(main, 'utf8')))

  const clientDecl = pluginManifest.dsh?.client
  check('声明了 dsh.client.platform = web', clientDecl?.platform === 'web', JSON.stringify(clientDecl))
  const clientExport = pluginManifest.exports?.['./client']
  const clientRel = typeof clientExport === 'string' ? clientExport : clientExport?.default
  check('exports["./client"] 指向真实文件', typeof clientRel === 'string' && fs.existsSync(path.join(packageDir, clientRel)), String(clientRel))
  check('client 半区是 __ModuleLoader__ 传统脚本', typeof clientRel === 'string' && fs.readFileSync(path.join(packageDir, clientRel), 'utf8').includes('window.__ModuleLoader__.load('))
}

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} 项失败：`)
  for (const failure of failures) console.log(`   - ${failure}`)
  process.exitCode = 1
} else {
  console.log('\n✅ 预检通过：重启后 DSH 能解析并挂载这个 bundle')
}
