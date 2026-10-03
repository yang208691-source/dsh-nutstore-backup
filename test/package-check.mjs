/**
 * 发布前自检：确认这个包能作为 DSH 插件被正确安装与加载。
 *
 * 为什么单独做：插件市场的使用者只会看到"装完能不能用"。历史上这个项目踩过的坑
 * （bundle patch 缺失、client 入口没声明、dsh.client.inject 指向不存在的包）
 * 都会表现成"装了但设置页不出现"，很难排查。这里把那些要求固化成断言。
 *
 * 用法：node test/package-check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.dirname(here)
const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))

const failures = []
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(`${label} ${detail}`)
    console.log(`  FAIL  ${label} ${detail}`)
  }
}

console.log(`包名 ${manifest.name}@${manifest.version}`)
console.log('')

console.log('[1] 发布必需的元数据')
check('有 name', typeof manifest.name === 'string' && manifest.name.length > 0)
check('有 version', typeof manifest.version === 'string' && manifest.version.length > 0)
check('不是 private（否则 npm publish 会被拒）', manifest.private !== true, `private=${String(manifest.private)}`)
check('有 description（市场列表与搜索会用它）', typeof manifest.description === 'string' && manifest.description.length > 10, String(manifest.description))
check('有 license', typeof manifest.license === 'string', String(manifest.license))
check('keywords 里有 dsh-plugin（便于市场归类）', Array.isArray(manifest.keywords) && manifest.keywords.includes('dsh-plugin'), JSON.stringify(manifest.keywords))

console.log('\n[2] DSH 挂载声明')
check('声明了 dsh.manifestVersion', manifest.dsh?.manifestVersion === 1, JSON.stringify(manifest.dsh?.manifestVersion))
const patch = manifest.dsh?.bundle?.patch
check('声明了 dsh.bundle.patch', typeof patch === 'string', JSON.stringify(patch))
const patchFiles = typeof patch === 'string' ? [patch] : Array.isArray(patch) ? patch : []
check('patch 文件真实存在', patchFiles.length > 0 && patchFiles.every(file => fs.existsSync(path.join(pluginDir, file))), patchFiles.join(','))
for (const file of patchFiles) {
  const text = fs.readFileSync(path.join(pluginDir, file), 'utf8')
  check(`${file} 里有 insert 且 name 与包名一致`, text.includes('insert:') && text.includes(manifest.name), text.slice(0, 80).replace(/\n/gu, ' '))
}

console.log('\n[3] 客户端半区')
check('dsh.client.platform 正好是 web（其它值会被静默当成"没有客户端半区"）', manifest.dsh?.client?.platform === 'web', String(manifest.dsh?.client?.platform))
const clientExport = manifest.exports?.['./client']
const clientRel = typeof clientExport === 'string' ? clientExport : clientExport?.default
check('exports["./client"] 指向真实文件', typeof clientRel === 'string' && fs.existsSync(path.join(pluginDir, clientRel)), String(clientRel))
if (typeof clientRel === 'string' && fs.existsSync(path.join(pluginDir, clientRel))) {
  const source = fs.readFileSync(path.join(pluginDir, clientRel), 'utf8')
  check('client 半区是 __ModuleLoader__ 传统脚本（不是 ESM）', source.includes('window.__ModuleLoader__.load('), '')
  check('client 半区没有顶层 import/export（宿主按 <script> 加载它）', !/^\s*(import|export)\s/mu.test(source), '')
  check('client 注册 id 等于包名（不等会报 loaded without registering）', source.includes(`id: '${manifest.name}'`) || source.includes(`id: "${manifest.name}"`), '')
  check('只 require 种子模块表里的东西（否则运行时会抛 missed the module table）', (() => {
    const requires = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/gu)].map(match => match[1])
    const seed = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit'])
    const unknown = requires.filter(spec => !seed.has(spec))
    return unknown.length === 0
  })(), '')
}

console.log('\n[4] dsh.client.inject 里列的包必须真实存在（写错包名会让客户端半区静默不加载）')
{
  /**
   * 直接在 asar 的文件表里"按路径查找"。
   *
   * 为什么要查 asar：DSH 自带的客户端包（@deepseek-ai/dsh-client-*）在 app.asar 里，
   * 不在 profile 的 node_modules，所以 Node 解析不到 ≠ 包不存在。
   * 这里只做一件事：把依赖名按 / 拆成路径逐级走一遍，走通就存在。
   */
  const asarPath = process.env.DSH_ASAR ?? 'D:\\DeepSeek_harness\\resources\\app.asar'
  let header
  let asarError
  try {
    const fd = fs.openSync(asarPath, 'r')
    try {
      const sizeBuffer = Buffer.alloc(16)
      fs.readSync(fd, sizeBuffer, 0, 16, 0)
      const headerSize = sizeBuffer.readUInt32LE(12)
      const headerBuffer = Buffer.alloc(headerSize)
      fs.readSync(fd, headerBuffer, 0, headerSize, 16)
      header = JSON.parse(headerBuffer.toString('utf8'))
    } finally {
      fs.closeSync(fd)
    }
  } catch (error) {
    asarError = error
  }

  /** 在 asar 里找 `dsh/node_modules/<依赖名>`（依赖名可能带 @scope/）。 */
  const existsInAsar = (dependency) => {
    if (header === undefined) return false
    let node = header
    for (const segment of ['dsh', 'node_modules', ...dependency.split('/')]) {
      node = node?.files?.[segment]
      if (node === undefined) return false
    }
    return true
  }

  /**
   * 本机 profile 的锚点。**不要硬编码用户名**：CI（GitHub runner）上没有这个目录，
   * 硬编码会让这个套件只能在作者机器上跑通。
   */
  const profileManifestAnchor = process.env.DSH_PROFILE_ANCHOR
    ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', 'desktop', 'package.json')

  const profileHasPackage = async (dependency) => {
    if (!fs.existsSync(profileManifestAnchor)) return false
    const { createRequire } = await import('node:module')
    try {
      createRequire(profileManifestAnchor).resolve(`${dependency}/package.json`)
      return true
    } catch {
      return false
    }
  }

  const dependencies = manifest.dsh?.client?.inject ?? []
  const noLocalDsh = header === undefined && !fs.existsSync(profileManifestAnchor)
  if (noLocalDsh) {
    // 典型场景：CI。降级为命名规范检查——它仍然能挡住"包名写错"，只是不能证明真实存在。
    for (const dependency of dependencies) {
      check(`${dependency} 命名形如 @deepseek-ai/dsh-client-*`,
        /^@deepseek-ai\/dsh-(client|api)-[a-z0-9-]+$/u.test(dependency),
        'CI 上无法核对真实存在性，只检查命名规范')
    }
    console.log(`  说明：读不到 asar（${asarError instanceof Error ? asarError.message : '不存在'}）也没有本机 profile，`)
    console.log('        已降级为命名规范检查。发布前请在装有 DSH 的机器上再跑一次本套件。')
  } else {
    for (const dependency of dependencies) {
      const inAsar = existsInAsar(dependency)
      const inProfile = await profileHasPackage(dependency)
      check(`能找到 ${dependency}（asar=${inAsar} profile=${inProfile}）`, inAsar || inProfile,
        '既不在 asar 里也不在 profile 里——包名可能写错了')
    }
  }
}

console.log('\n[5] 主入口')
const main = manifest.main ?? 'lib/index.mjs'
check('main 指向真实文件', fs.existsSync(path.join(pluginDir, main)), main)
if (fs.existsSync(path.join(pluginDir, main))) {
  const source = fs.readFileSync(path.join(pluginDir, main), 'utf8')
  check('导出了 apply（DSH 靠它挂载）', /export (function apply|const apply|\{[^}]*apply)/u.test(source), '')
  check('没有硬依赖 @deepseek-ai/* 运行时包（零依赖，装到新机器不会拉包失败）', !/from ['"]@deepseek-ai\//u.test(source), '')
}

console.log('\n[6] 会打进包里的文件')
const bundled = (manifest.files ?? []).flatMap((entry) => {
  const target = path.join(pluginDir, entry)
  if (!fs.existsSync(target)) return []
  if (fs.statSync(target).isFile()) return [entry]
  const collect = (dir, prefix) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const rel = `${prefix}/${item.name}`
    return item.isDirectory() ? collect(path.join(dir, item.name), rel) : [rel]
  })
  return collect(target, entry)
})
console.log(`  共 ${bundled.length} 个文件：`)
for (const file of bundled) console.log(`    ${file}`)
check('打包内容里包含 cordis.patch.yml 与客户端 bundle', bundled.includes('cordis.patch.yml') && bundled.some(file => file.endsWith('client.js')), '')
check('打包内容里没有测试脚本（免得把测试当产品发布）', !bundled.some(file => file.startsWith('test/')), '')
check('打包内容里没有 node_modules', !bundled.some(file => file.includes('node_modules')), '')

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} 项失败：`)
  for (const failure of failures) console.log(`   - ${failure}`)
  process.exitCode = 1
} else {
  console.log('\n✅ 发布前自检通过')
}
