/**
 * client 半区测试：在 Node 里模拟宿主环境，把设置页**真正跑起来**。
 *
 * 磁盘上没有 react 包（React 被打进 DSH 前端 bundle），所以这里实现一个最小
 * React 运行时（useState/useEffect/useCallback/useRef/createElement），
 * 用"函数组件 + 立即渲染"的方式驱动组件，并支持模拟点击/输入，验证真实交互链路：
 *   ① client.js 是传统脚本，只调一次 __ModuleLoader__.load，id == 包名；
 *   ② factory(require) 返回 { apply, inject }；
 *   ③ apply() 注册一条 settings.section（id/order/label thunk/locale/样式）；
 *   ④ 首次挂载会 GET /dsh-nutstore/state，并把机器名/文件数渲染出来；
 *   ⑤ 点击「测试连接」→ POST /dsh-nutstore/test；
 *   ⑥ 点击「保存并登录」→ POST /config 然后 POST /password（密码不回显）；
 *   ⑦ 点击「立即备份」→ POST /backup 并展示结果；
 *   ⑧ 密码框是 type=password、autoComplete=new-password。
 *
 * 用法：node test/client-half-test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.dirname(here)

const failures = []
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(`${label} ${detail}`)
    console.log(`  FAIL  ${label} ${detail}`)
  }
}

// ── 最小 React 运行时 ─────────────────────────────────────────────────────────
let currentInstance = undefined

function createElement(type, props, ...children) {
  const flat = []
  const push = (child) => {
    if (child === null || child === undefined || child === false || child === true) return
    if (Array.isArray(child)) { child.forEach(push); return }
    flat.push(child)
  }
  children.forEach(push)
  return { type, props: props ?? {}, children: flat }
}

const React = {
  createElement,
  useState(initial) {
    const instance = currentInstance
    const index = instance.hookIndex++
    if (!(index in instance.hooks)) instance.hooks[index] = typeof initial === 'function' ? initial() : initial
    const setState = (next) => {
      const previous = instance.hooks[index]
      const value = typeof next === 'function' ? next(previous) : next
      if (Object.is(value, previous)) return
      instance.hooks[index] = value
      instance.dirty = true
    }
    return [instance.hooks[index], setState]
  },
  useEffect(effect) {
    const instance = currentInstance
    const index = instance.hookIndex++
    // 只跑一次，模拟"空依赖数组"的首次挂载语义。
    if (!(index in instance.hooks)) {
      instance.hooks[index] = true
      instance.pendingEffects.push(effect)
    }
  },
  useCallback(callback) {
    const instance = currentInstance
    const index = instance.hookIndex++
    if (!(index in instance.hooks)) instance.hooks[index] = callback
    return instance.hooks[index]
  },
  useMemo(factory) {
    const instance = currentInstance
    const index = instance.hookIndex++
    if (!(index in instance.hooks)) instance.hooks[index] = factory()
    return instance.hooks[index]
  },
  useRef(initial) {
    const instance = currentInstance
    const index = instance.hookIndex++
    if (!(index in instance.hooks)) instance.hooks[index] = { current: initial }
    return instance.hooks[index]
  },
}

/** 节点的宿主替身：用于"点击第 N 个按钮"这类交互。 */
function hostNode(tag, attributes, children) {
  return {
    tag,
    attributes,
    children,
    get text() {
      return children.map(child => (typeof child === 'string' ? child : (child?.text ?? ''))).join('')
    },
  }
}

// ── 渲染成 HTML ──────────────────────────────────────────────────────────────
const VOID_TAGS = new Set(['input', 'br', 'hr', 'img'])
/** 一棵渲染树里出现过的全部宿主节点，供"找按钮"这类查询使用。 */
let hostRegistry = []

function escapeHtml(value) {
  return String(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;')
}

/** 渲染结果：{ html, node }，node 为宿主替身（文本时为字符串），用统一接口收子节点。 */
function renderNode(node) {
  if (node === null || node === undefined || node === false || node === true) return { html: '', node: null }
  if (typeof node === 'string' || typeof node === 'number') return { html: escapeHtml(node), node: String(node) }
  if (Array.isArray(node)) {
    const parts = node.map(renderNode)
    return {
      html: parts.map(part => part.html).join(''),
      node: { tag: '#fragment', attributes: {}, children: parts.map(part => part.node) },
    }
  }

  const { type, props = {}, children } = node
  if (typeof type === 'function') {
    const saved = currentInstance
    const instance = { hooks: [], hookIndex: 0, pendingEffects: [], dirty: false }
    currentInstance = instance
    let element
    try {
      element = type({ ...props, children })
    } finally {
      currentInstance = saved
    }
    return renderNode(element)
  }

  const parts = []
  let html = `<${type}`
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || key === 'key') continue
    if (key === 'className') { html += ` class="${escapeHtml(value)}"`; continue }
    if (key === 'style' && value !== null && typeof value === 'object') continue
    if (typeof value === 'function') { html += ` data-handler="${key}"`; continue }
    if (value === false || value === null || value === undefined) continue
    if (value === true) { html += ` ${key.toLowerCase()}`; continue }
    html += ` ${key.toLowerCase()}="${escapeHtml(value)}"`
  }
  if (VOID_TAGS.has(type)) {
    html += ' />'
    const host = hostNode(type, props, [])
    hostRegistry.push(host)
    return { html, node: host }
  }
  html += '>'
  for (const child of children) {
    const part = renderNode(child)
    html += part.html
    if (part.node !== null) parts.push(part.node)
  }
  html += `</${type}>`
  const host = hostNode(type, props, parts)
  hostRegistry.push(host)
  return { html, node: host }
}

// ── 引导：以"浏览器"的方式执行 client.js ──────────────────────────────────────
const registrations = []
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration)
    },
  },
}

const styleTags = []
globalThis.document = {
  baseURI: 'http://127.0.0.1:19387/',
  head: { appendChild: (tag) => styleTags.push(tag) },
  createElement: () => ({ dataset: {}, textContent: '' }),
  querySelector: () => null,
}

const clientSource = fs.readFileSync(path.join(pluginDir, 'lib', 'client.js'), 'utf8')

console.log('\n[1] 传统脚本形态与注册')
check('不是 ESM（没有顶层 import/export 语句）', !/^\s*(import|export)\s/mu.test(clientSource))
check('引用了 window.__ModuleLoader__.load', clientSource.includes('window.__ModuleLoader__.load('))
// eslint-disable-next-line no-new-func
new Function('window', 'document', clientSource)(globalThis.window, globalThis.document)
check('恰好注册一次', registrations.length === 1, `registrations=${registrations.length}`)
const registration = registrations[0]
check('注册 id 等于包名 dsh-nutstore-backup', registration?.id === 'dsh-nutstore-backup', String(registration?.id))

console.log('\n[2] factory 的导出形状')
const moduleTable = {
  react: React,
  'react/jsx-runtime': { jsx: createElement, jsxs: createElement },
  'react-dom': {},
  '@deepseek-ai/dsh-client-ui-primitives': {},
}
const exported = registration.factory((specifier) => {
  const found = moduleTable[specifier]
  if (found === undefined) throw new Error(`require("${specifier}") missed the module table`)
  return found
})
check('导出 apply 函数', typeof exported.apply === 'function')
check('导出 inject 含 slots 与 locale', Array.isArray(exported.inject) && exported.inject.includes('slots') && exported.inject.includes('locale'), JSON.stringify(exported.inject))

console.log('\n[3] apply() 注册 settings.section')
const dictionaries = []
const injectedSlots = []
const slotRegistrations = []
const fakeClientCtx = {
  effect(callback) { return callback() },
  locale: {
    register(namespace, dicts) { dictionaries.push({ namespace, dicts }) },
    bind() { return (key) => (dictionaries[0]?.dicts?.zh ?? {})[key] ?? key },
  },
  slots: {
    inject(key, callback) { injectedSlots.push(key); callback() },
    register(options, component) { slotRegistrations.push({ options, component }); return () => {} },
  },
}
exported.apply(fakeClientCtx)
check('注册了字典（zh + en）', dictionaries.length === 1 && dictionaries[0].dicts.zh !== undefined && dictionaries[0].dicts.en !== undefined)
check('语言命名空间正确', dictionaries[0]?.namespace === 'dsh-nutstore-backup', String(dictionaries[0]?.namespace))
check('往 settings.section 槽注入', injectedSlots.includes('settings.section'), injectedSlots.join(','))
check('恰好注册一条 settings.section', slotRegistrations.length === 1, `count=${slotRegistrations.length}`)
const options = slotRegistrations[0]?.options ?? {}
check('列表槽带 id', typeof options.id === 'string' && options.id.length > 0, JSON.stringify(options.id))
check('带数字 order', typeof options.order === 'number', String(options.order))
check('label 是 thunk', typeof options.label === 'function')
check('带 locale 命名空间', options.locale === 'dsh-nutstore-backup', String(options.locale))
check('注入了带 data-plugin 标记的样式', styleTags.length === 1 && styleTags[0].dataset.pluginCss !== undefined)

console.log('\n[4] 挂载 + 首次拉取 /state')
const requests = []
let statePayload = {
  ok: true,
  loggedIn: false,
  password: { service: 'available', configured: false, label: '未登录' },
  config: {
    server: 'https://dav.jianguoyun.com/dav',
    account: '',
    remoteRoot: '/dsh-backup',
    machine: 'my-pc',
    workspaceDir: 'D:\\My Agent',
    sources: { sessions: true, profileConfig: true, workspaceMemory: true, pluginSource: true },
  },
  sources: {
    machine: 'my-pc', remoteDir: '/dsh-backup/my-pc', workspaceDir: 'D:\\My Agent',
    profile: 'desktop', dshHome: 'C:\\Users\\x\\.dsh', files: 1234, bytes: 5678901,
    roots: [{ key: 'sessions', label: '会话记录', count: 1200, bytes: 5000000 }], skipped: [],
  },
}
globalThis.fetch = async (url, init) => {
  requests.push({ url, method: init?.method ?? 'GET', body: init?.body })
  return { status: 200, text: async () => JSON.stringify(statePayload) }
}

/** 用最小 React 运行时把组件跑到"稳定"，可选复用同一个实例以保留 state。 */
function mount(component, props, reuse) {
  const instance = reuse ?? { hooks: [], hookIndex: 0, pendingEffects: [], dirty: false }
  const saved = currentInstance
  let tree
  let html = ''
  let node
  for (let pass = 0; pass < 40; pass += 1) {
    currentInstance = instance
    instance.hookIndex = 0
    instance.dirty = false
    instance.pendingEffects = []
    hostRegistry = []
    try {
      tree = component(props)
    } finally {
      currentInstance = saved
    }
    const rendered = renderNode(tree)
    html = rendered.html
    node = rendered.node
    for (const effect of instance.pendingEffects) effect()
    if (!instance.dirty) break
  }
  return { html, node, host: { tag: '#root', attributes: {}, children: [node] }, instance }
}

const t = fakeClientCtx.locale.bind('dsh-nutstore-backup')
let mounted = mount(slotRegistrations[0].component, { t, close: () => {} })
await new Promise(resolve => setTimeout(resolve, 30)) // 等挂载时的 fetch 落地
mounted = mount(slotRegistrations[0].component, { t, close: () => {} }, mounted.instance)
const stateRequestCountAfterMount = requests.length
check('首次挂载发起 GET /dsh-nutstore/state', requests[0]?.url === '/dsh-nutstore/state' && requests[0]?.method === 'GET', JSON.stringify(requests[0]))
check('请求路径是相对 baseURI（反向代理安全）', String(requests[0]?.url).startsWith('/') && !/^https?:/u.test(String(requests[0]?.url)), String(requests[0]?.url))
for (const expected of ['坚果云备份', '应用密码', '立即备份', '查看云端备份', '测试连接', '保存并登录', '备份范围', '只预览']) {
  check(`界面含「${expected}」`, mounted.html.includes(expected))
}
check('密码框是 type=password 且 autoComplete=new-password', mounted.html.includes('type="password"') && mounted.html.includes('autocomplete="new-password"'))

/** 递归找按钮（用渲染时记录的宿主节点，文本由子树拼出）。 */
function findButtons() {
  return hostRegistry.filter(node => node.tag === 'button')
}
function buttonByText(text) {
  return findButtons().find(button => button.text.includes(text))
}

console.log('\n[5] 点击「测试连接」→ POST /test')
let testButton = buttonByText('测试连接')
check('找得到「测试连接」按钮', testButton !== undefined, `buttons=${findButtons().map(b => b.text).join('|')}`)
statePayload = { ok: true, checked: true, server: 'https://dav.jianguoyun.com/dav', account: 'me@example.com', remoteRootExists: false }
testButton?.attributes.onClick?.()
await new Promise(resolve => setTimeout(resolve, 30))
mounted = mount(slotRegistrations[0].component, { t, close: () => {} }, mounted.instance)
check('发起了 POST /dsh-nutstore/test', requests.some(request => request.url === '/dsh-nutstore/test' && request.method === 'POST'), requests.map(r => `${r.method} ${r.url}`).join(','))

console.log('\n[6] 点击「保存并登录」→ POST /config + POST /password')
const accountInput = hostRegistry.find(node => node.tag === 'input' && node.attributes.autoComplete === 'username')
check('找得到账号输入框', accountInput !== undefined)
accountInput?.attributes.onChange?.({ target: { value: 'me@example.com' } })
mounted = mount(slotRegistrations[0].component, { t, close: () => {} }, mounted.instance)
const saveButton = buttonByText('保存并登录')
check('找得到「保存并登录」按钮', saveButton !== undefined)
saveButton?.attributes.onClick?.()
await new Promise(resolve => setTimeout(resolve, 40))
mounted = mount(slotRegistrations[0].component, { t, close: () => {} }, mounted.instance)
check('发起了 POST /dsh-nutstore/config', requests.some(request => request.url === '/dsh-nutstore/config' && request.method === 'POST'))
check('未填密码时不会误提交 password', !requests.some(request => request.url === '/dsh-nutstore/password'))

console.log('\n[7] 填入密码后「保存并登录」→ 一定 POST /password')
const passwordInput = hostRegistry.find(node => node.tag === 'input' && node.attributes.type === 'password')
check('找得到密码输入框', passwordInput !== undefined)
passwordInput?.attributes.onChange?.({ target: { value: 'app-password-xyz' } })
mounted = mount(slotRegistrations[0].component, { t, close: () => {} }, mounted.instance)
buttonByText('保存并登录')?.attributes.onClick?.()
await new Promise(resolve => setTimeout(resolve, 40))
const passwordCall = requests.find(request => request.url === '/dsh-nutstore/password')
check('发起了 POST /dsh-nutstore/password', passwordCall !== undefined)
check('密码只提交给 /password 接口', passwordCall !== undefined && passwordCall.body.includes('app-password-xyz'))

console.log('\n[8] 点击「立即备份」→ POST /backup 并展示结果')
statePayload = { ok: true, dir: '/dsh-backup/my-pc', uploaded: 42, skipped: 1192, uploadedBytes: 204800, scannedFiles: 1234, failed: [], ms: 5120 }
mounted = mount(slotRegistrations[0].component, { t, close: () => {} }, mounted.instance)
const backupButton = buttonByText('立即备份')
check('找得到「立即备份」按钮', backupButton !== undefined)
backupButton?.attributes.onClick?.()
await new Promise(resolve => setTimeout(resolve, 40))
mounted = mount(slotRegistrations[0].component, { t, close: () => {} }, mounted.instance)
check('发起了 POST /dsh-nutstore/backup', requests.some(request => request.url === '/dsh-nutstore/backup' && request.method === 'POST'))
check('备份结果渲染到界面（uploaded=42）', mounted.html.includes('42'), '')

console.log('\n[9] 备份范围复选框与错误展示')
check('四个范围复选框都在', ['会话记录', '插件与配置', '工作区记忆', '插件源码'].every(label => mounted.html.includes(label)))
statePayload = { ok: false, error: '认证失败：坚果云要求使用「应用密码」' }
buttonByText('查看云端备份')?.attributes.onClick?.()
await new Promise(resolve => setTimeout(resolve, 40))
mounted = mount(slotRegistrations[0].component, { t, close: () => {} }, mounted.instance)
check('接口报错时把错误显示出来（而不是静默）', mounted.html.includes('认证失败'), '')
check('未登录时按钮不会因渲染而爆栈', mounted.html.includes('坚果云备份'))

console.log('\n[10] 降低"翻菜单 + 粘贴"摩擦的登录引导')
statePayload = {
  ok: true,
  loggedIn: false,
  account: '',
  password: { service: 'available', configured: false, label: '未登录：还没有保存应用密码' },
  config: { server: 'https://dav.jianguoyun.com/dav', account: '', remoteRoot: '/dsh-backup', machine: 'my-pc', workspaceDir: 'D:\\My Agent', sources: {} },
  sources: { machine: 'my-pc', remoteDir: '/dsh-backup/my-pc', files: 52, bytes: 640000, roots: [], skipped: [] },
}
mounted = mount(slotRegistrations[0].component, { t, close: () => {} }, undefined)
check('有「① 打开坚果云生成应用密码」按钮', buttonByText('① 打开坚果云生成应用密码') !== undefined, findButtons().map(b => b.text).join('|'))
check('有教程与账户两个链接', mounted.html.includes('help.jianguoyun.com/?p=2064') && mounted.html.includes('jianguoyun.com/d/account'), '')
check('链接带 target=_blank 且 rel 含 noreferrer', mounted.html.includes('target="_blank"') && mounted.html.includes('noreferrer'), '')
check('给出两步指引（生成 → 粘贴/回车）', mounted.html.includes('第三方应用管理') && mounted.html.includes('回车'), '')
// 点击按钮应当新开标签页，而不是静默什么都不做。
// 注意：必须**就地改属性**，不能 `globalThis.window = {...}` 换对象——
// 插件脚本在被求值时就把当时的 window 捕获进了闭包，换对象对它无效（真实浏览器里也不会换对象）。
const openedTabs = []
const realWindow = globalThis.window
const realOpen = realWindow.open
const realLocation = realWindow.location
realWindow.open = (...args) => { openedTabs.push(args); return {} }
const openButton = buttonByText('① 打开坚果云生成应用密码')
check('点击前能找到按钮（含 onClick）', openButton !== undefined && typeof openButton.attributes.onClick === 'function', findButtons().map(b => b.text).join('|'))
openButton?.attributes.onClick?.()
check('点按钮会新开标签页打开教程页', openedTabs.length === 1 && String(openedTabs[0][0]).includes('help.jianguoyun.com'), JSON.stringify(openedTabs))

// 弹窗被拦截时必须退化跳转，不允许静默失败
let navigated
realWindow.open = () => null
realWindow.location = { get href() { return 'about:blank' }, set href(value) { navigated = value } }
buttonByText('① 打开坚果云生成应用密码')?.attributes.onClick?.()
check('弹窗被拦截时退化为当前页跳转', String(navigated).includes('help.jianguoyun.com'), String(navigated))

// 连 location 都没有的环境（某些宿主/桩）：不能抛异常把设置页拖崩
let threwWithoutLocation = false
realWindow.location = undefined
try {
  buttonByText('① 打开坚果云生成应用密码')?.attributes.onClick?.()
} catch {
  threwWithoutLocation = true
}
check('没有可写 location 时不抛异常（不影响其它功能）', threwWithoutLocation === false)

// 还原，避免影响后面的用例
realWindow.open = realOpen
realWindow.location = realLocation

console.log('\n[11] 密码框回车即保存（少一次点击）')
mounted = mount(slotRegistrations[0].component, { t, close: () => {} }, undefined)
const enterField = hostRegistry.find(node => node.tag === 'input' && node.attributes.type === 'password')
check('密码框带 onKeyDown', enterField !== undefined && typeof enterField.attributes.onKeyDown === 'function', JSON.stringify(Object.keys(enterField?.attributes ?? {})))
const beforeEnter = requests.filter(request => request.url === '/dsh-nutstore/password').length
// 空密码时回车不该误提交
enterField?.attributes.onKeyDown?.({ key: 'Enter', preventDefault() {} })
await new Promise(resolve => setTimeout(resolve, 40))
const afterEmptyEnter = requests.filter(request => request.url === '/dsh-nutstore/password').length
check('空密码回车不会误提交', afterEmptyEnter === beforeEnter, `before=${beforeEnter} after=${afterEmptyEnter}`)
// 填入密码后回车应当真的提交
enterField?.attributes.onChange?.({ target: { value: 'app-pw-via-enter' } })
mounted = mount(slotRegistrations[0].component, { t, close: () => {} }, mounted.instance)
const filledField = hostRegistry.find(node => node.tag === 'input' && node.attributes.type === 'password')
filledField?.attributes.onKeyDown?.({ key: 'Enter', preventDefault() {} })
await new Promise(resolve => setTimeout(resolve, 60))
const enterCall = requests.filter(request => request.url === '/dsh-nutstore/password').at(-1)
check('填入密码后回车会提交', (requests.filter(request => request.url === '/dsh-nutstore/password').length) > afterEmptyEnter, `count=${requests.filter(r => r.url === '/dsh-nutstore/password').length}`)
check('提交里带的是刚填的密码', String(enterCall?.body ?? '').includes('app-pw-via-enter'), String(enterCall?.body ?? '').slice(0, 120))

console.log('\n[12] 已登录时显示账号，避免"不知道用的是哪个号"')
statePayload = {
  ok: true, loggedIn: true, account: 'me@example.com',
  password: { service: 'available', configured: true, label: '已登录（密码存放在 DSH 凭据库 nutstore-backup/app-password）' },
  config: { server: 'https://dav.jianguoyun.com/dav', account: 'me@example.com', remoteRoot: '/dsh-backup', machine: 'my-pc', workspaceDir: 'D:\\My Agent', sources: {} },
  sources: { machine: 'my-pc', remoteDir: '/dsh-backup/my-pc', files: 5, bytes: 100, roots: [], skipped: [] },
}
mounted = mount(slotRegistrations[0].component, { t, close: () => {} }, undefined)
// 挂载时的 /state 是异步的：给它一拍时间落地，再做断言（前面的用例同理）。
await new Promise(resolve => setTimeout(resolve, 40))
mounted = mount(slotRegistrations[0].component, { t, close: () => {} }, mounted.instance)
check('状态栏显示「已登录 · 账号」', mounted.html.includes('已登录') && mounted.html.includes('me@example.com'), '')
check('说明密码存进凭据库且不回显', mounted.html.includes('不回显'), '')
check('已登录时仍有清除密码入口', buttonByText('清除密码') !== undefined, findButtons().map(b => b.text).join('|'))

console.log('\n[13] 恢复必须是显眼的一等入口（之前只藏在"查看云端备份"的表格行里）')
{
  // 用户反馈：只看得到「立即备份」和「查看云端备份」，找不到恢复。
  // 所以恢复要有自己的分区、自己的标题、一个不需要先"查看云端备份"就能点的按钮。
  mounted = mount(slotRegistrations[0].component, { t, close: () => {} }, undefined)
  await new Promise(resolve => setTimeout(resolve, 40))
  mounted = mount(slotRegistrations[0].component, { t, close: () => {} }, mounted.instance)

  check('界面上有「恢复云端备份」分区', mounted.html.includes('恢复云端备份'), '')
  check('没有读过云端列表时也看得到恢复按钮', buttonByText('恢复') !== undefined, findButtons().map(b => b.text).join('|'))
  check('按钮旁说明了恢复会写到哪、覆盖前会进回收站', mounted.html.includes('restore-trash') && mounted.html.includes('会话记录落到'), '')
  check('未读列表时给出"会恢复本机标签那份"的提示', mounted.html.includes('本机标签'), '')
  check('有"只预览（不写入）"开关', mounted.html.includes('只预览'), '')

  // 不选机器直接点恢复 → 不带 sourceMachine（由 host 用本机标签）
  const before = requests.filter(request => request.url === '/dsh-nutstore/restore').length
  buttonByText('恢复')?.attributes.onClick?.()
  await new Promise(resolve => setTimeout(resolve, 60))
  const firstRestore = requests.filter(request => request.url === '/dsh-nutstore/restore').at(-1)
  check('点击「恢复」发出 POST /restore', requests.filter(request => request.url === '/dsh-nutstore/restore').length > before, '')
  check('未选机器时不传 sourceMachine', firstRestore !== undefined && !String(firstRestore.body).includes('sourceMachine'), String(firstRestore?.body))
  check('默认带上 mode=all', String(firstRestore?.body ?? '').includes('"mode":"all"'), String(firstRestore?.body))
}

console.log('\n[14] 选了具体机器 → 带上 sourceMachine')
{
  // 先让"查看云端备份"填充列表（模拟用户先点了那个按钮）
  globalThis.fetch = async (url, init) => {
    requests.push({ url, method: init?.method ?? 'GET', body: init?.body })
    const payload = String(url).includes('/machines')
      ? { ok: true, remoteRoot: '/dsh-backup', machines: [
        { machine: 'old-laptop', files: 59, bytes: 10942336, createdAt: '2026-10-01T00:00:00.000Z' },
        { machine: 'my-pc', files: 59, bytes: 10942336, createdAt: '2026-10-03T00:00:00.000Z' },
      ] }
      : statePayload
    return { status: 200, text: async () => JSON.stringify(payload) }
  }
  mounted = mount(slotRegistrations[0].component, { t, close: () => {} }, undefined)
  await new Promise(resolve => setTimeout(resolve, 40))
  mounted = mount(slotRegistrations[0].component, { t, close: () => {} }, mounted.instance)
  buttonByText('查看云端备份')?.attributes.onClick?.()
  await new Promise(resolve => setTimeout(resolve, 60))
  mounted = mount(slotRegistrations[0].component, { t, close: () => {} }, mounted.instance)

  const select = hostRegistry.find(node => node.tag === 'select')
  check('列出云端备份后出现机器下拉框', select !== undefined, hostRegistry.map(n => n.tag).join(','))
  check('下拉框里有 old-laptop 与 my-pc', mounted.html.includes('old-laptop') && mounted.html.includes('my-pc'), '')
  check('表格里每行仍有「从该备份恢复」', buttonByText('从该备份恢复') !== undefined, findButtons().map(b => b.text).join('|'))

  select?.attributes.onChange?.({ target: { value: 'old-laptop' } })
  mounted = mount(slotRegistrations[0].component, { t, close: () => {} }, mounted.instance)
  buttonByText('恢复')?.attributes.onClick?.()
  await new Promise(resolve => setTimeout(resolve, 60))
  const picked = requests.filter(request => request.url === '/dsh-nutstore/restore').at(-1)
  check('选中 old-laptop 后带上 sourceMachine', String(picked?.body ?? '').includes('"sourceMachine":"old-laptop"'), String(picked?.body))
}

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} 项失败：`)
  for (const failure of failures) console.log(`   - ${failure}`)
  process.exitCode = 1
} else {
  console.log('\n✅ 全部通过')
}
