/**
 * 独立验证服务器的页面：纯 HTML + 原生 JS，无依赖、无构建。
 *
 * 刻意做成"一页走完全部验证步骤"：
 *   ① 测试连接（PROPFIND + 读根目录）
 *   ② 立即备份（真实上传）
 *   ③ 查看云端备份（列出机器与清单）
 *   ④ 只预览恢复 → ⑤ 真正恢复（可选，默认不点）
 * 每一步都显示原始 JSON 返回，方便判断到底是哪一环不对。
 */
import path from 'node:path'

/** 把命令行传进来的工作区目录收敛成绝对路径。 */
export function parseWorkspaceOverride(value) {
  return path.resolve(String(value).trim())
}

function escapeHtml(value) {
  return String(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;')
}

export function renderVerificationPage(options = {}) {
  const port = options.port ?? 19731
  const packageRoot = String(options.packageRoot ?? '')
  const credential = options.credential ?? { mode: 'plaintext', reason: '未提供凭据服务' }
  const credentialBlock = credential.mode === 'store'
    ? `<div>密码去向：<strong>DSH 凭据库</strong>（与插件读的是同一个记录，重启后设置页直接显示"已登录"）
        <div class="mono">文件：${escapeHtml(String(credential.file ?? ''))}</div>
        <div class="mono">记录：${escapeHtml(String(credential.record ?? ''))}</div>
        <div class="hint">写入前会备份原文件；序列化后会严格回读校验，不一致就不落盘。本页面<strong>不回显</strong>已保存的密码。</div>
      </div>`
    : `<div>密码去向：<strong>0600 明文回退文件</strong>（凭据库不可用：${escapeHtml(String(credential.reason ?? ''))}）
        <div class="hint">这个模式下密码是明文，页面如实标注、不谎称加密。装进 DSH 设置页后密码会进 DSH 凭据库。本页面<strong>不回显</strong>已保存的密码。</div>
      </div>`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>坚果云备份 · 验证</title>
<style>
  :root { color-scheme: light dark; --fg:#1c1c1e; --muted:#6b6b70; --line:#d8d8dc; --bg:#fff; --card:#fafafb; --accent:#2f6fed; --err:#c0392b; --ok:#1e8e4e; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8e8ea; --muted:#9a9aa2; --line:#3a3a40; --bg:#161618; --card:#1e1e21; --accent:#5b8cf7; --err:#f0785f; --ok:#4ac57e; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif; }
  main { max-width:860px; margin:0 auto; padding:28px 20px 60px; }
  h1 { font-size:19px; margin:0 0 6px; }
  .sub { color:var(--muted); margin:0 0 18px; }
  .note { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:11px 13px; color:var(--muted); margin-bottom:18px; }
  .card { border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:16px; background:var(--card); }
  .card h2 { font-size:14px; margin:0 0 12px; }
  .row { display:flex; flex-direction:column; gap:5px; margin-bottom:11px; }
  label { font-weight:600; font-size:13px; }
  .hint { color:var(--muted); font-size:12px; }
  input[type=text], input[type=password] { width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); font:inherit; }
  input:focus { outline:2px solid var(--accent); outline-offset:0; border-color:transparent; }
  .actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  button { padding:7px 13px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--fg); font:inherit; cursor:pointer; }
  button:hover:not(:disabled) { background:rgba(128,128,128,.13); }
  button:disabled { opacity:.55; cursor:default; }
  button.primary { background:var(--accent); border-color:transparent; color:#fff; }
  button.danger { color:var(--err); }
  pre { background:rgba(128,128,128,.12); border-radius:8px; padding:10px 11px; overflow:auto; max-height:320px; font:12px/1.55 ui-monospace,Consolas,monospace; white-space:pre-wrap; word-break:break-word; margin:0; }
  .status { display:flex; flex-wrap:wrap; gap:6px 14px; color:var(--muted); margin-bottom:14px; }
  .dot { width:8px; height:8px; border-radius:50%; display:inline-block; margin-right:6px; background:#999; }
  .dot.ok { background:var(--ok); } .dot.bad { background:var(--err); }
  .checks { display:flex; flex-wrap:wrap; gap:8px 16px; }
  .check { display:flex; gap:6px; align-items:center; font-size:13px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:600; }
  .mono { font-family:ui-monospace,Consolas,monospace; font-size:12px; }
</style>
</head>
<body>
<main>
  <h1>坚果云备份 · 配置与验证</h1>
  <p class="sub">这个页面跑的是<strong>和插件同一份代码</strong>（lib/routes.mjs、lib/backup.mjs、lib/webdav.mjs），
     只是不需要重启 DSH。验证通过后，DSH 里的「设置 → 坚果云备份」是同一套行为。</p>

  <div class="note">
    <div>插件目录：<span class="mono">${escapeHtml(packageRoot)}</span></div>
    <div>监听：<span class="mono">http://127.0.0.1:${escapeHtml(String(port))}</span>（仅本机；关掉这个窗口/终端即停止）</div>
    ${credentialBlock}
  </div>

  <div class="status">
    <span><span id="dot" class="dot"></span><span id="loginState">读取中…</span></span>
    <span id="scanInfo"></span>
    <span id="remoteDir" class="mono"></span>
  </div>

  <div class="card">
    <h2>1 · 账号与应用密码</h2>
    <div class="row">
      <label for="server">WebDAV 地址</label>
      <input id="server" type="text" spellcheck="false" />
    </div>
    <div class="row">
      <label for="account">坚果云账号（邮箱或手机号）</label>
      <input id="account" type="text" spellcheck="false" autocomplete="username" />
    </div>
    <div class="row">
      <label for="password">应用密码</label>
      <input id="password" type="password" autocomplete="new-password" placeholder="粘贴应用密码" />
      <span class="hint">坚果云不给第三方应用密码登录，所以这一步必须用「应用密码」：生成一次，之后所有设备共用。
        <strong>不是网页登录密码。</strong>（实测坚果云 WebDAV 只认 Basic 认证，OAuth 单点登录走的是坚果云开放平台 API，
        需要注册的第三方应用身份，第三方 WebDAV 客户端拿不到。）</span>
      <div class="actions">
        <button type="button" id="open-guide">① 打开坚果云生成应用密码</button>
        <a class="hint mono" href="https://help.jianguoyun.com/?p=2064" target="_blank" rel="noreferrer noopener">教程</a>
        <a class="hint mono" href="https://www.jianguoyun.com/d/account" target="_blank" rel="noreferrer noopener">坚果云账户</a>
      </div>
      <span class="hint">② 回到这里粘贴，直接按回车（或点「保存配置 + 存密码」）。</span>
    </div>
    <div class="row">
      <label for="remoteRoot">云端根目录</label>
      <input id="remoteRoot" type="text" spellcheck="false" />
    </div>
    <div class="row">
      <label for="machine">本机标签</label>
      <input id="machine" type="text" spellcheck="false" />
    </div>
    <div class="row">
      <label for="workspaceDir">工作区目录（备份 memory / SOUL.md / USER.md）</label>
      <input id="workspaceDir" type="text" spellcheck="false" />
    </div>
    <div class="row">
      <label>备份范围</label>
      <div class="checks">
        <label class="check"><input type="checkbox" id="scope-sessions" /> 会话记录</label>
        <label class="check"><input type="checkbox" id="scope-profileConfig" /> 插件与配置</label>
        <label class="check"><input type="checkbox" id="scope-workspaceMemory" /> 工作区记忆</label>
        <label class="check"><input type="checkbox" id="scope-pluginSource" /> 插件源码</label>
      </div>
    </div>
    <div class="actions">
      <button class="primary" id="save">保存配置 + 存密码</button>
      <button id="test">测试连接</button>
    </div>
  </div>

  <div class="card">
    <h2>2 · 备份</h2>
    <div class="actions">
      <button class="primary" id="backup">立即备份</button>
      <button id="machines">查看云端备份</button>
      <button id="clear">清除已保存密码</button>
    </div>
    <div id="machineBox" style="margin-top:12px"></div>
  </div>

  <div class="card">
    <h2>3 · 在新机器上恢复（在这台机器上试也没问题）</h2>
    <div class="actions">
      <button id="dryRun">只预览（不写入）</button>
      <button class="danger" id="restore">真的恢复</button>
      <span class="hint">恢复会把同名文件先拷到 <span class="mono">$DSH_HOME/nutstore-backup/restore-trash/</span></span>
    </div>
  </div>

  <div class="card">
    <h2>结果</h2>
    <pre id="out">（还没有操作）</pre>
  </div>
</main>

<script>
(function () {
  const ROUTE = '/dsh-nutstore'
  const $ = (id) => document.getElementById(id)
  let busy = false

  function setBusy(value, label) {
    busy = value
    for (const button of document.querySelectorAll('button')) button.disabled = value
    if (label) $('loginState').textContent = label
  }

  async function call(path, body) {
    const init = body === undefined
      ? { method: 'GET', cache: 'no-store' }
      : { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    const response = await fetch(path, init)
    const text = await response.text()
    let parsed
    try { parsed = JSON.parse(text) } catch (error) { throw new Error('返回不是 JSON：' + text.slice(0, 200)) }
    if (parsed.ok === false) { const failure = new Error(parsed.error || '请求失败'); failure.payload = parsed; throw failure }
    return parsed
  }

  function show(value, isError) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    $('out').textContent = text
    $('out').style.color = isError ? 'var(--err)' : ''
  }

  function fill(config) {
    $('server').value = config.server || ''
    $('account').value = config.account || ''
    $('remoteRoot').value = config.remoteRoot || ''
    $('machine').value = config.machine || ''
    $('workspaceDir').value = config.workspaceDir || ''
    const sources = config.sources || {}
    for (const key of ['sessions', 'profileConfig', 'workspaceMemory', 'pluginSource']) {
      $('scope-' + key).checked = sources[key] !== false
    }
  }

  function patchFromForm() {
    return {
      server: $('server').value.trim(),
      account: $('account').value.trim(),
      remoteRoot: $('remoteRoot').value.trim(),
      machine: $('machine').value.trim(),
      workspaceDir: $('workspaceDir').value.trim(),
      sources: {
        sessions: $('scope-sessions').checked,
        profileConfig: $('scope-profileConfig').checked,
        workspaceMemory: $('scope-workspaceMemory').checked,
        pluginSource: $('scope-pluginSource').checked,
      },
    }
  }

  async function refresh() {
    try {
      const payload = await call(ROUTE + '/state', undefined)
      fill(payload.config || {})
      const dot = $('dot')
      dot.className = 'dot ' + (payload.loggedIn ? 'ok' : 'bad')
      // 已登录时带上账号：用户一眼确认"用的是哪个号"。
      $('loginState').textContent = payload.loggedIn
        ? ('已登录' + (payload.account ? ' · ' + payload.account : '') + '（密码已存进凭据库，不回显）')
        : '未保存密码'
      const sources = payload.sources || {}
      $('scanInfo').textContent = (sources.files || 0) + ' 个文件 · ' + humanBytes(sources.bytes)
      $('remoteDir').textContent = sources.remoteDir || ''
      if ($('password').value === '') $('password').placeholder = payload.loggedIn ? '已保存（留空表示不修改）' : '粘贴应用密码'
    } catch (error) {
      $('dot').className = 'dot bad'
      $('loginState').textContent = '读取状态失败'
      show(String(error.message), true)
    }
  }

  function humanBytes(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '—'
    const units = ['B', 'KB', 'MB', 'GB']
    let size = value, unit = 0
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1 }
    return (unit === 0 || size >= 10 ? Math.round(size) : size.toFixed(1)) + ' ' + units[unit]
  }

  async function run(label, work) {
    if (busy) return
    setBusy(true, label)
    try {
      const payload = await work()
      show(payload, false)
      return payload
    } catch (error) {
      show(error.payload || { error: String(error.message) }, true)
      return undefined
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  $('save').onclick = () => run('保存中…', async () => {
    await call(ROUTE + '/config', { patch: patchFromForm() })
    const password = $('password').value
    if (password === '') return { note: '配置已保存（未修改密码）', config: patchFromForm() }
    const result = await call(ROUTE + '/password', { action: 'set', account: $('account').value.trim(), server: $('server').value.trim(), password })
    $('password').value = ''
    return result
  })

  // ① 一键打开坚果云的教程页（含生成应用密码的逐步截图）。
  // 指到教程页而不是猜「账户设置」深链：实测 /d/account/safe 这类路径返回 501，写死会 404。
  $('open-guide').onclick = () => {
    const url = 'https://help.jianguoyun.com/?p=2064'
    const opened = window.open(url, '_blank', 'noopener,noreferrer')
    if (!opened) window.location.href = url
  }

  // ② 密码框回车即保存并测试：少一次点击。
  $('password').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    $('save').click()
  })

  $('test').onclick = () => run('测试中…', () => call(ROUTE + '/test', {
    account: $('account').value.trim(),
    password: $('password').value,
    server: $('server').value.trim(),
  }))

  $('backup').onclick = () => run('备份中…', () => call(ROUTE + '/backup', {}))

  $('clear').onclick = () => run('清除中…', async () => {
    const payload = await call(ROUTE + '/password', { action: 'clear' })
    $('password').value = ''
    return payload
  })

  $('machines').onclick = () => run('读取云端…', async () => {
    const payload = await call(ROUTE + '/machines', undefined)
    const box = $('machineBox')
    box.innerHTML = ''
    if (!payload.machines || payload.machines.length === 0) {
      box.innerHTML = '<div class="hint">云端还没有备份。先点「立即备份」。</div>'
      return payload
    }
    const table = document.createElement('table')
    table.innerHTML = '<thead><tr><th>机器</th><th>文件</th><th>体积</th><th>备份时间</th></tr></thead>'
    const tbody = document.createElement('tbody')
    for (const machine of payload.machines) {
      const tr = document.createElement('tr')
      tr.innerHTML = '<td class="mono">' + machine.machine + '</td><td>' + (machine.files ?? '—') + '</td><td>' + humanBytes(machine.bytes) + '</td><td class="mono">' + (machine.createdAt || '') + '</td>'
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    box.appendChild(table)
    return payload
  })

  $('dryRun').onclick = () => run('预览中…', () => call(ROUTE + '/restore', { dryRun: true }))

  $('restore').onclick = () => {
    if (!window.confirm('恢复会把云端的文件写回本机（同名文件先拷到 restore-trash）。确定继续吗？')) return
    return run('恢复中…', () => call(ROUTE + '/restore', {}))
  }

  refresh()
})()
</script>
</body>
</html>
`
}
