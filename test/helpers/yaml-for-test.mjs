/**
 * 测试用工具：可移植地拿到 js-yaml。
 *
 * 为什么需要：插件在真机上是从 DSH 自己的 profile 里**借** js-yaml 的
 * （为了让凭据文件的 YAML 格式与 DSH 完全一致），而 CI 上没有 DSH，
 * 过去测试里写死了 `C:\Users\<作者>\.dsh\profiles\desktop`，
 * 结果在 GitHub runner 上直接抛错、那几条最关键的"写进凭据库"断言等于没跑。
 *
 * 现在按优先级找：插件自己的 node_modules（devDependency） → 本机 DSH profile → 系统全局。
 * 全都找不到时返回 undefined，调用方据此**跳过**相关断言并打印原因，而不是假装通过。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
/** 插件根目录（test/helpers → test → 插件根）。 */
export const pluginDir = path.dirname(path.dirname(here))

/** 依次尝试的锚点：越靠前越优先。 */
export function yamlAnchors() {
  const anchors = [path.join(pluginDir, 'package.json')]
  const homes = []
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '') homes.push(path.resolve(process.env.DSH_HOME.trim()))
  homes.push(path.join(os.homedir(), '.dsh'))
  for (const home of homes) {
    anchors.push(path.join(home, 'package.json'))
    try {
      for (const entry of fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })) {
        if (entry.isDirectory()) anchors.push(path.join(home, 'profiles', entry.name, 'package.json'))
      }
    } catch {
      // 没有这个目录就算了
    }
  }
  return anchors
}

/**
 * 取 js-yaml。
 * @returns { module, anchor } 或 undefined（附 `tried` 列表便于打印）
 */
export function loadYamlForTest() {
  for (const anchor of yamlAnchors()) {
    try {
      const loaded = createRequire(anchor)('js-yaml')
      return { module: loaded, anchor }
    } catch {
      // 换下一个锚点
    }
  }
  return undefined
}

/** 打印"在哪找到的 / 都没找到时试过哪些"，让跳过的原因可追。 */
export function describeYamlSource(found) {
  if (found !== undefined) return `js-yaml 来自 ${found.anchor}`
  return `借不到 js-yaml；试过：\n    ${yamlAnchors().join('\n    ')}\n    在插件目录跑一次 npm ci（devDependencies 里有 js-yaml）即可补齐这条覆盖。`
}
