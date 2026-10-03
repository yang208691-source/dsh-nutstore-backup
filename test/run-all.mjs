/**
 * 一把跑完全部测试套件。
 *
 *   node test/run-all.mjs
 *
 * ① mock-dav-test.mjs           — WebDAV 客户端 + 备份范围扫描 + 增量 + 恢复（对着本地 mock DAV）
 * ② host-apply-test.mjs         — 真实 apply()：工具注册 + 全部 HTTP 路由走一遍
 * ③ client-half-test.mjs        — 设置页组件：注册、渲染、点击、请求
 * ④ credential-test.mjs         — 应用密码：凭据服务路径 + 明文回退路径
 * ⑤ credential-bridge-test.mjs  — 凭据桥：写 DSH 凭据库的安全性
 * ⑥ workspace-test.mjs          — 工作区解析 + 恢复路径映射（含"宿主没有 DSH_HOME"）
 * ⑦ server-test.mjs             — 独立验证服务器（免重启）：页面 + 全部接口 + 仅本机校验
 * ⑧ profile-resolution-test.mjs — 预检：profile 里登记的 bundle 能被真正解析、挂载
 * ⑨ package-check.mjs           — 发布前自检：元数据、挂载声明、客户端半区、打包内容
 *
 * 想逐个看输出就跑 node test/<name>.mjs；这里为了不互相干扰，子进程输出直接透传。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const suites = [
  'mock-dav-test.mjs',
  'host-apply-test.mjs',
  'client-half-test.mjs',
  'credential-test.mjs',
  'credential-bridge-test.mjs',
  'workspace-test.mjs',
  'server-test.mjs',
  'profile-resolution-test.mjs',
  'package-check.mjs',
]

const results = []
for (const suite of suites) {
  console.log(`\n══════════ ${suite} ══════════`)
  const started = Date.now()
  const code = await new Promise((resolve) => {
    // stdio: 'inherit' 让每个套件自己打印；它们都会在结束时主动退出，
    // 不会因为残留 handle 把 run-all 挂住（每个套件都有兜底 process.exit）。
    const child = spawn(process.execPath, [path.join(here, suite)], { stdio: 'inherit' })
    child.on('exit', (exitCode) => resolve(exitCode ?? 1))
    child.on('error', () => resolve(1))
  })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  results.push({ suite, code, seconds })
  if (code !== 0) console.log(`  → ${suite} 失败（exit=${code}，${seconds}s）`)
}

const failed = results.filter(result => result.code !== 0)

console.log('\n══════════ 汇总 ══════════')
for (const result of results) {
  console.log(`  ${result.code === 0 ? '✅' : '❌'} ${result.suite.padEnd(28)} ${result.seconds}s`)
}
if (failed.length === 0) {
  console.log(`\n✅ ${suites.length} 个测试套件全部通过`)
} else {
  console.log(`\n❌ ${failed.length}/${suites.length} 个测试套件失败：${failed.map(result => result.suite).join(', ')}`)
  process.exitCode = 1
}
// 兜底：任何残留 handle 都不该让整套测试挂着。
setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref()
