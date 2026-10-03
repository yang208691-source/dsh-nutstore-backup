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
 * 设计要点：
 *   · **两种模式**：能捕获输出就捕获（失败时在末尾重放最后 40 行，CI 日志好找原因）；
 *     某些沙箱禁止子进程管道（spawn EPERM），那时自动退回 `stdio: inherit` 直通。
 *     先探测一次再决定，避免"整套测试因为环境限制而挂掉"。
 *   · GitHub Actions 上把汇总写进 `$GITHUB_STEP_SUMMARY`，失败原因显示在运行页面摘要里。
 *   · 开头打印运行环境，CI 与本机不同时一眼能看出来。
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
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

/** 失败时重放多少行输出——够看出断言与堆栈，又不至于淹掉日志。 */
const TAIL_LINES = 40

/**
 * 能不能捕获子进程输出？
 *
 * 有些沙箱（例如把命令包在受限容器里跑）禁止子进程管道，`spawn` 会直接抛 EPERM。
 * 探测一次，别让"环境限制"把整套测试变成失败。
 */
function canCaptureChildOutput() {
  try {
    const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8', timeout: 20000 })
    return probe.error === undefined && probe.status === 0 && String(probe.stdout).includes('ok')
  } catch {
    return false
  }
}

const capture = canCaptureChildOutput()

console.log('══════════ 运行环境 ══════════')
console.log(`  node            ${process.version}`)
console.log(`  platform        ${process.platform} (${process.arch})`)
console.log(`  tmpdir          ${os.tmpdir()}`)
console.log(`  DSH_HOME        ${process.env.DSH_HOME ?? '(未设置)'}`)
console.log(`  DSH_PROFILE_DIR ${process.env.DSH_PROFILE_DIR ?? '(未设置)'}`)
console.log(`  GITHUB_ACTIONS  ${process.env.GITHUB_ACTIONS ?? '(不在 CI 里)'}`)
console.log(`  输出模式        ${capture ? '捕获（失败时重放日志尾部）' : '直通（当前环境禁止子进程管道，无法重放尾部）'}`)
const homeProfile = path.join(os.homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE ?? 'desktop')
console.log(`  本机 profile     ${homeProfile} ${fs.existsSync(homeProfile) ? '(存在)' : '(不存在，相关套件会跳过)'}`)
console.log('')

/** 跑一个套件；捕获模式下返回它的完整输出。 */
function runSuite(suite) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, suite)], {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    })
    if (!capture) {
      child.on('error', () => resolve({ code: 1, output: '' }))
      child.on('exit', (code) => resolve({ code: code ?? 1, output: '' }))
      return
    }
    let output = ''
    const collect = (chunk) => {
      const text = chunk.toString()
      output += text
      process.stdout.write(text)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (error) => resolve({ code: 1, output: `${output}\n[启动失败] ${error.message}` }))
    child.on('exit', (code) => resolve({ code: code ?? 1, output }))
  })
}

const results = []
for (const suite of suites) {
  console.log(`\n══════════ ${suite} ══════════`)
  const started = Date.now()
  const { code, output } = await runSuite(suite)
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  results.push({ suite, code, seconds, tail: output.split('\n').slice(-TAIL_LINES).join('\n') })
  if (code !== 0) console.log(`  → ${suite} 失败（exit=${code}，${seconds}s）`)
}

const failed = results.filter(result => result.code !== 0)

console.log('\n══════════ 汇总 ══════════')
for (const result of results) {
  console.log(`  ${result.code === 0 ? '✅' : '❌'} ${result.suite.padEnd(28)} ${result.seconds}s`)
}

// 失败详情放在**末尾**：CI 日志默认展开最后一部分，不用往上翻。
let summary
if (failed.length === 0) {
  summary = `✅ ${suites.length} 个测试套件全部通过`
} else {
  const lines = [
    `❌ ${failed.length}/${suites.length} 个测试套件失败：${failed.map(result => result.suite).join(', ')}`,
    '',
  ]
  for (const result of failed) {
    lines.push(`───── ${result.suite}（exit=${result.code}，${result.seconds}s）最后 ${TAIL_LINES} 行 ─────`)
    lines.push(result.tail.trimEnd() === '' ? '(本环境无法捕获输出；请在终端里直接跑该套件看详情)' : result.tail.trimEnd())
    lines.push('')
  }
  summary = lines.join('\n')
  process.exitCode = 1
}
console.log(`\n${summary}`)

// GitHub Actions：把汇总写进运行页面摘要，失败原因一眼可见。
if (typeof process.env.GITHUB_STEP_SUMMARY === 'string' && process.env.GITHUB_STEP_SUMMARY !== '') {
  const table = results.map(result => `| ${result.code === 0 ? '✅' : '❌'} | \`${result.suite}\` | ${result.seconds}s |`).join('\n')
  const detail = failed
    .filter(result => result.tail.trim() !== '')
    .map(result => `**${result.suite}**\n\n\`\`\`\n${result.tail.trimEnd()}\n\`\`\``)
    .join('\n\n')
  const body = [
    '## 测试套件结果',
    '',
    '| | 套件 | 耗时 |',
    '| --- | --- | --- |',
    table,
    '',
    failed.length === 0 ? '**全部通过**' : `**失败：${failed.map(result => result.suite).join(', ')}**`,
    '',
    detail,
    '',
  ].join('\n')
  try {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${body}\n`)
  } catch {
    // 写摘要失败不影响测试结论。
  }
}

// 兜底：任何残留 handle 都不该让整套测试挂着。
setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref()
