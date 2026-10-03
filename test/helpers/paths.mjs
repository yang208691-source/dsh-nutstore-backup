/**
 * 测试用的路径解析：**任何测试文件都不该写死绝对路径**。
 *
 * 血泪教训：早先十几个测试文件里写着
 *   `const lib = (file) => pathToFileURL(path.join('<作者本机的源码目录>/lib', file)).href`
 * 在我本机（Windows，源码就在那个目录）一切正常，但到了 GitHub 的 Ubuntu runner 上，
 * 那个路径不存在 → 动态 import 立刻抛 ERR_MODULE_NOT_FOUND → 套件 0.0 秒失败。
 * 表现是"本机全绿、CI 一跑就崩"，而且崩得很快、看不出原因。
 *
 * 正确做法只有一个：**从当前模块的位置推算插件根目录**。
 * 这个文件在 test/helpers/ 里，所以要往上走两层。
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** 插件根目录（test/helpers → test → 插件根）。 */
export const pluginDir = path.dirname(path.dirname(here))

/** lib/index.mjs 等模块的 file:// URL，可直接用于 `await import()`。 */
export function libUrl(file) {
  return pathToFileURL(path.join(pluginDir, 'lib', file)).href
}

/** 插件根目录下的任意文件的 file:// URL。 */
export function pluginUrl(file) {
  return pathToFileURL(path.join(pluginDir, file)).href
}
