/**
 * dsh-nutstore-backup —— client 半区（浏览器设置页）。
 *
 * 这里是**传统脚本**，不是 ES module：由宿主按 <script> 直接加载，只能通过
 * window.__ModuleLoader__.load({ id, factory }) 注册，id 必须等于 package.json 的 name。
 *
 * 与 host 半区的通信只用 HTTP 路由（/dsh-nutstore/*），不用 ctx.remote：
 * 第三方插件拿不到 Typert 的生成式描述符，普通路由是唯一可手写的通道。
 * 请求路径一律相对 document.baseURI（反向代理下根绝对路径会 404）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-nutstore-backup',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'dsh-nutstore-backup'
    const ROUTE = '/dsh-nutstore'

    /**
     * 坚果云的「第三方应用授权 WebDAV」官方教程页（含生成应用密码的逐步截图）。
     *
     * 为什么指到教程页而不是某个"账户设置"深链：我实测过 `/d/account/safe`、`/d/account/app`
     * 这类猜测路径全部返回 **501**（不是有效路由），写死它们等于按钮一点就 404——那比没有按钮更糟。
     * 这个教程页实测可用（200），里面有进「账户信息 → 安全选项 → 第三方应用管理」的完整截图，
     * 用户点进去照着点两下即可；页面上同时给出账户入口，登录后从菜单也能到。
     *
     * 顺带说明为什么非要应用密码：实测坚果云 WebDAV 只认 Basic 认证
     * （Bearer / X-Auth-Token / ?access_token= 全部 401 且 `WWW-Authenticate: Basic realm="nutstore"`）。
     * 那种"点一下授权就接入"的 OAuth 走的是坚果云开放平台 API（官方 Obsidian 插件那条路），
     * 需要已注册的第三方应用身份，第三方 WebDAV 插件拿不到。
     */
    const APP_PASSWORD_GUIDE_URL = 'https://help.jianguoyun.com/?p=2064'
    const ACCOUNT_URL = 'https://www.jianguoyun.com/d/account'

    /** 新开标签页打开教程；被拦截时退化为当前页跳转（绝不静默什么都不做，也绝不抛异常）。 */
    function openAppPasswordPage() {
      if (typeof window === 'undefined') return
      try {
        const opened = typeof window.open === 'function'
          ? window.open(APP_PASSWORD_GUIDE_URL, '_blank', 'noopener,noreferrer')
          : null
        if (opened !== null && opened !== undefined) return
        // 弹窗被拦截（或环境里没有 window.open）：退化为当前页跳转。
        // 这里必须容错——某些宿主/测试环境没有可写的 location，
        // 一个未捕获异常会把整个设置页拖崩，那是比"没跳转"严重得多的失败。
        if (window.location !== undefined && window.location !== null) window.location.href = APP_PASSWORD_GUIDE_URL
      } catch {
        // 跳转失败不该影响其它功能；用户可以手动打开教程链接。
      }
    }

    const ZH = {
      nav: '坚果云备份',
      title: '坚果云备份',
      intro: '把本机的会话记录、插件配置与工作区记忆备份到坚果云，换电脑后一键恢复。',
      account: '坚果云账号',
      accountHint: '登录坚果云用的邮箱或手机号。',
      password: '应用密码',
      passwordHint: '只在这一步用到：坚果云不给第三方应用密码登录，必须用「应用密码」。生成一次即可，所有设备共用。',
      passwordPlaceholderStored: '已保存（留空表示不修改）',
      passwordPlaceholderEmpty: '粘贴应用密码',
      openAppPasswordPage: '① 打开坚果云生成应用密码',
      openAppPasswordPageHint: '会新开一个标签页，登录后在「账户信息 → 安全选项 → 第三方应用管理 → 添加应用密码」生成，名字随你填（例如 DSH）。',
      pasteStep: '② 回到这里粘贴，点「保存并登录」（也可以在本页直接按回车）',
      managePassword: '重新生成',
      statusLoggedInAs: '已登录',
      passwordStoredShort: '密码已存进 DSH 凭据库（不回显）',
      server: 'WebDAV 地址',
      remoteRoot: '云端根目录',
      machine: '本机标签',
      machineHint: '云端会按这个标签分目录，便于区分不同电脑的备份。',
      workspace: '工作区目录',
      save: '保存并登录',
      saving: '保存中…',
      test: '测试连接',
      testing: '测试中…',
      backup: '立即备份',
      backingUp: '备份中…',
      listRemote: '查看云端备份',
      loading: '加载中…',
      restoreFrom: '从该备份恢复',
      restore: '恢复',
      restoring: '恢复中…',
      restoreSection: '恢复云端备份',
      restoreThis: '从本机标签的备份恢复',
      restoreHint: '把云端这份备份写回本机：会话记录落到 $DSH_HOME\\sessions，插件配置落到 profile，工作区记忆落回工作区目录。同名文件会先拷到 nutstore-backup/restore-trash。',
      restorePick: '选择要恢复哪一台的备份：',
      restorePickCurrent: '（本机标签：{machine}）',
      restoreNoMachine: '尚未读取云端备份列表；下面的按钮会恢复「本机标签」对应的那份。想恢复别的机器，先点上面的「查看云端备份」。',
      dryRun: '只预览（不写入）',
      forceRestore: '以云端为准（连本机更新的文件也覆盖）',
      forceRestoreHint: '默认会保护比云端更新的本机文件，误点不会用旧快照毁掉新数据；勾上这个才会完全恢复成云端原样。',
      scopes: '备份范围',
      scopeSessions: '会话记录',
      scopeProfile: '插件与配置',
      scopeWorkspace: '工作区记忆',
      scopePlugin: '插件源码',
      statusLoggedIn: '已登录',
      statusLoggedOut: '未登录',
      files: '个文件',
      bytes: '字节',
      noRemote: '云端还没有任何备份。',
      machines: '云端已有备份',
      confirmRestore: '恢复会把云端的文件写回本机（同名文件先备份到 nutstore-backup/restore-trash）。确定继续吗？',
      result: '结果',
      passwordNote: '密码存放在 DSH 凭据库（明文 YAML，仅当前用户可读）；本插件不会把密码回传到页面。',
      restartNote: '恢复完成后建议重启 DSH，让会话与设置重新加载。',
    }

    const EN = {
      nav: 'Nutstore backup',
      title: 'Nutstore backup',
      intro: 'Back up sessions, plugin config and workspace memory to Nutstore (Jianguoyun) over WebDAV, then restore them on another machine.',
      account: 'Nutstore account',
      accountHint: 'The email or phone number you use to sign in to Nutstore.',
      password: 'App password',
      passwordHint: 'Only used here: Nutstore does not let third-party apps sign in with your account password, so an app password is required. Generate it once and every machine can use it.',
      passwordPlaceholderStored: 'Saved (leave blank to keep)',
      passwordPlaceholderEmpty: 'Paste the app password',
      openAppPasswordPage: '① Open Nutstore to create an app password',
      openAppPasswordPageHint: 'Opens in a new tab. Sign in, then Account info → Security options → Third-party apps → Add app password. Any name works (e.g. DSH).',
      pasteStep: '② Come back, paste it and press "Save and sign in" (or just hit Enter here)',
      managePassword: 'Create another',
      statusLoggedInAs: 'Signed in',
      passwordStoredShort: 'Password is stored in the DSH credential store (never shown back)',
      server: 'WebDAV URL',
      remoteRoot: 'Remote root',
      machine: 'Machine label',
      machineHint: 'Remote backups are grouped by this label so machines stay apart.',
      workspace: 'Workspace directory',
      save: 'Save and sign in',
      saving: 'Saving…',
      test: 'Test connection',
      testing: 'Testing…',
      backup: 'Back up now',
      backingUp: 'Backing up…',
      listRemote: 'Browse remote backups',
      loading: 'Loading…',
      restoreFrom: 'Restore from this backup',
      restore: 'Restore',
      restoring: 'Restoring…',
      restoreSection: 'Restore from Nutstore',
      restoreThis: 'Restore from this machine label',
      restoreHint: 'Writes the remote backup back onto this machine: sessions → $DSH_HOME\\sessions, plugin config → profile, workspace memory → the workspace directory. An existing file is copied to nutstore-backup/restore-trash first.',
      restorePick: 'Which machine’s backup should be restored:',
      restorePickCurrent: '(this machine label: {machine})',
      restoreNoMachine: 'The remote list has not been read yet; the button below restores the backup matching this machine label.',
      dryRun: 'Preview only (write nothing)',
      forceRestore: 'Prefer the cloud copy (overwrite even newer local files)',
      forceRestoreHint: 'By default, files that are newer locally than in the backup are protected, so a stray click cannot revert fresh data to an old snapshot. Enable this to make the machine match the snapshot exactly.',
      scopes: 'What to back up',
      scopeSessions: 'Session logs',
      scopeProfile: 'Plugin config',
      scopeWorkspace: 'Workspace memory',
      scopePlugin: 'Plugin source',
      statusLoggedIn: 'Signed in',
      statusLoggedOut: 'Not signed in',
      files: 'files',
      bytes: 'bytes',
      noRemote: 'No remote backup yet.',
      machines: 'Remote backups',
      confirmRestore: 'Restore writes remote files back onto this machine (an existing file is copied to nutstore-backup/restore-trash first). Continue?',
      result: 'Result',
      passwordNote: 'The password lives in the DSH credential store (plaintext YAML readable only by your OS user); this page never reads it back.',
      restartNote: 'Restart DSH after a restore so sessions and settings reload.',
    }

    const CSS = `
.nsb-root{display:flex;flex-direction:column;gap:15px;padding:4px 2px 24px;max-width:760px;font-size:13px;color:var(--dsw-alias-label-primary,#e6e6e6)}
.nsb-title{margin:0;font-size:15px;font-weight:600}
.nsb-intro{margin:0;color:var(--dsw-alias-label-secondary,#a0a0a0);line-height:1.6}
.nsb-card{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:10px;padding:14px 14px 16px;display:flex;flex-direction:column;gap:11px}
.nsb-row{display:flex;flex-direction:column;gap:5px}
.nsb-label{font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.nsb-hint{color:var(--dsw-alias-label-tertiary,#8a8a8a);line-height:1.55}
.nsb-input{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:inherit;font:inherit}
.nsb-input:focus{outline:none;box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) var(--dsw-focus-ring-color,rgba(90,150,255,.55))}
.nsb-pw{display:flex;flex-direction:column;gap:7px}
.nsb-hint-inline{color:var(--dsw-alias-state-business-primary,#3b74f0);text-decoration:none;border-bottom:1px dashed currentColor}
.nsb-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.nsb-btn{padding:6px 12px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:inherit;font:inherit;cursor:pointer}
.nsb-btn:hover:not(:disabled){background:rgba(128,128,128,.14)}
.nsb-btn:disabled{opacity:.5;cursor:default}
.nsb-btn-primary{border-color:transparent;background:var(--dsw-alias-state-business-primary,#3b74f0);color:#fff}
.nsb-btn-primary:hover:not(:disabled){filter:brightness(1.08)}
.nsb-status{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;color:var(--dsw-alias-label-secondary,#a0a0a0)}
.nsb-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}
.nsb-ok{background:#37b26c}.nsb-bad{background:#d0563f}.nsb-idle{background:#8a8a8a}
.nsb-checks{display:flex;flex-wrap:wrap;gap:10px 18px}
.nsb-check{display:flex;gap:6px;align-items:center}
.nsb-out{margin:0;white-space:pre-wrap;word-break:break-word;background:rgba(128,128,128,.12);border-radius:7px;padding:9px 10px;max-height:280px;overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.5}
.nsb-err{color:var(--dsw-alias-state-error-primary,#e5705a)}
.nsb-table{width:100%;border-collapse:collapse}
.nsb-table th,.nsb-table td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));vertical-align:top}
.nsb-table th{font-weight:600;color:var(--dsw-alias-label-secondary,#a0a0a0)}
.nsb-note{color:var(--dsw-alias-label-tertiary,#8a8a8a);line-height:1.6}
`

    /** 注入样式：带上 data-plugin 标记，宿主卸载本插件时会一起清掉。 */
    function installStyle() {
      if (typeof document === 'undefined') return
      const id = `${NS}/settings.css`
      if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.dataset.pluginCss = id
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** 相对 baseURI 的 API 路径（反向代理场景下不能用根绝对路径）。 */
    function api(path) {
      const relative = String(path).replace(/^\/+/u, '')
      if (typeof document === 'undefined') return `/${relative}`
      return new URL(relative, document.baseURI).pathname
    }

    async function call(path, options) {
      const init = { cache: 'no-store', ...(options ?? {}) }
      if (init.body !== undefined && typeof init.body !== 'string') {
        init.headers = { 'Content-Type': 'application/json', ...(init.headers ?? {}) }
        init.body = JSON.stringify(init.body)
      }
      const response = await fetch(api(path), init)
      const text = await response.text()
      let parsed
      try {
        parsed = text === '' ? {} : JSON.parse(text)
      } catch {
        throw new Error(`服务端返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
      }
      if (parsed.ok === false) throw new Error(parsed.error ?? `请求失败（HTTP ${response.status}）`)
      return parsed
    }

    function humanBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const units = ['B', 'KB', 'MB', 'GB']
      let size = value
      let unit = 0
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024
        unit += 1
      }
      return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`
    }

    function field(label, hint, control) {
      return h('div', { className: 'nsb-row' }, [
        h('label', { className: 'nsb-label', key: 'l' }, label),
        control,
        hint === undefined ? null : h('div', { className: 'nsb-hint', key: 'h' }, hint),
      ])
    }

    /**
     * 设置页主体。ownerProps 里有 { close }，本页不使用。
     * t 由 slot 的 locale 选项注入。
     */
    function NutstoreSection(props) {
      const t = props.t ?? ((key) => ZH[key] ?? key)

      const [state, setState] = useState(undefined)
      const [loadError, setLoadError] = useState(undefined)
      const [busy, setBusy] = useState(undefined)
      const [form, setForm] = useState({
        account: '',
        password: '',
        server: 'https://dav.jianguoyun.com/dav',
        remoteRoot: '/dsh-backup',
        machine: '',
        workspaceDir: '',
      })
      const [sources, setSources] = useState({ sessions: true, profileConfig: true, workspaceMemory: true, pluginSource: true })
      const [result, setResult] = useState(undefined)
      const [resultError, setResultError] = useState(false)
      const [machines, setMachines] = useState(undefined)
      const [dryRun, setDryRun] = useState(false)
      /** 「以云端为准」：默认关闭，等于保护比云端更新的本机文件。 */
      const [forceRestore, setForceRestore] = useState(false)
      /** 恢复时选中的远端机器目录；空串表示"用本机标签那份"。 */
      const [restoreMachine, setRestoreMachine] = useState('')
      const passwordTouched = useRef(false)

      const applyState = useCallback((payload) => {
        setState(payload)
        const config = payload.config ?? {}
        setForm((current) => ({
          account: passwordTouched.current ? current.account : (config.account ?? ''),
          password: current.password,
          server: config.server ?? current.server,
          remoteRoot: config.remoteRoot ?? current.remoteRoot,
          machine: config.machine ?? current.machine,
          workspaceDir: config.workspaceDir ?? current.workspaceDir,
        }))
        // 用函数式更新：不要在依赖里放 sources，否则 applyState/reload 每次渲染都换
        // 身份，下面的 useEffect 就会每渲染一次重新拉一次 /state。
        if (config.sources !== undefined) {
          setSources((current) => ({ ...current, ...config.sources }))
        }
      }, [])

      const reload = useCallback(async () => {
        try {
          const payload = await call(`${ROUTE}/state`, { method: 'GET' })
          applyState(payload)
          setLoadError(undefined)
        } catch (error) {
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      }, [applyState])

      useEffect(() => {
        void reload()
        // 只在挂载时拉一次：reload 的身份是稳定的（依赖为空），所以这里不会重复触发。
      }, [reload])

      const report = (label, promise) => {
        setBusy(label)
        setResultError(false)
        setResult(undefined)
        return promise
          .then((payload) => {
            setResult(payload)
            return payload
          })
          .catch((error) => {
            setResultError(true)
            setResult({ error: error instanceof Error ? error.message : String(error) })
            return undefined
          })
          .finally(() => {
            setBusy(undefined)
          })
      }

      const onSave = () => report('save', (async () => {
        const patch = {
          account: form.account.trim(),
          server: form.server.trim(),
          remoteRoot: form.remoteRoot.trim(),
          machine: form.machine.trim(),
          workspaceDir: form.workspaceDir.trim(),
          sources,
        }
        await call(`${ROUTE}/config`, { method: 'POST', body: { patch } })
        if (form.password !== '') {
          const stored = await call(`${ROUTE}/password`, {
            method: 'POST',
            body: { action: 'set', account: form.account.trim(), server: form.server.trim(), password: form.password },
          })
          passwordTouched.current = false
          setForm((current) => ({ ...current, password: '' }))
          await reload()
          return stored
        }
        await reload()
        return { note: '配置已保存（未修改密码）' }
      })())

      const onClearPassword = () => report('clear', (async () => {
        const payload = await call(`${ROUTE}/password`, { method: 'POST', body: { action: 'clear' } })
        passwordTouched.current = false
        setForm((current) => ({ ...current, password: '' }))
        await reload()
        return payload
      })())

      const onTest = () => report('test', call(`${ROUTE}/test`, {
        method: 'POST',
        body: {
          account: form.account.trim(),
          password: form.password,
          server: form.server.trim(),
        },
      }))

      const onBackup = () => report('backup', (async () => {
        const payload = await call(`${ROUTE}/backup`, { method: 'POST', body: { force: false } })
        await reload()
        return payload
      })())

      const onList = () => report('list', (async () => {
        const payload = await call(`${ROUTE}/machines`, { method: 'GET' })
        setMachines(payload.machines ?? [])
        return payload
      })())

      const onRestore = (machine) => {
        const label = machine === undefined || machine === '' ? t('restoreThis') : machine
        const question = `${t('confirmRestore')}\n\n${label}`
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && window.confirm(question) !== true) return
        return report('restore', call(`${ROUTE}/restore`, {
          method: 'POST',
          // 不传 sourceMachine 时由 host 用配置里的"本机标签"（点一下就能恢复本机那份）；
          // 传了就恢复指定那台的备份。
          body: {
            ...(machine === undefined || machine === '' ? {} : { sourceMachine: machine }),
            // force：只有用户明确勾了"以云端为准"才会覆盖比云端更新的本机文件。
            mode: forceRestore === true ? 'force' : 'all',
            dryRun,
          },
        }))
      }

      // 登录态以 host 的 loggedIn 为准（它是"密码记录是否存在"的权威判断）；
      // password.configured 作为兜底，避免旧版 host 没带这个字段时界面显示成未登录。
      const loggedIn = state?.loggedIn === true || state?.password?.configured === true
      const summary = state?.sources
      const statusDot = busy !== undefined ? 'nsb-idle' : (loggedIn ? 'nsb-ok' : 'nsb-bad')

      const button = (label, onClick, options = {}) => h('button', {
        type: 'button',
        className: options.primary === true ? 'nsb-btn nsb-btn-primary' : 'nsb-btn',
        disabled: busy !== undefined || options.disabled === true,
        onClick,
      }, label)

      const inputs = [
        field(t('server'), undefined, h('input', {
          className: 'nsb-input',
          value: form.server,
          spellCheck: false,
          onChange: (event) => setForm((current) => ({ ...current, server: event.target.value })),
        })),
        field(t('account'), t('accountHint'), h('input', {
          className: 'nsb-input',
          value: form.account,
          autoComplete: 'username',
          spellCheck: false,
          onChange: (event) => setForm((current) => ({ ...current, account: event.target.value })),
        })),
        field(t('password'), t('passwordHint'), h('div', { className: 'nsb-pw' }, [
          h('input', {
            key: 'input',
            className: 'nsb-input',
            type: 'password',
            autoComplete: 'new-password',
            value: form.password,
            placeholder: loggedIn ? t('passwordPlaceholderStored') : t('passwordPlaceholderEmpty'),
            onChange: (event) => {
              passwordTouched.current = true
              setForm((current) => ({ ...current, password: event.target.value }))
            },
            // 粘贴完直接回车就保存并测试：少一步点击，也不用去够鼠标。
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                onSave()
              }
            },
          }),
          h('div', { className: 'nsb-actions', key: 'pw-actions' }, [
            h('button', {
              key: 'open',
              type: 'button',
              className: 'nsb-btn',
              onClick: () => openAppPasswordPage(),
            }, t('openAppPasswordPage')),
            h('a', {
              key: 'guide',
              className: 'nsb-hint nsb-hint-inline',
              href: APP_PASSWORD_GUIDE_URL,
              target: '_blank',
              rel: 'noreferrer noopener',
            }, '教程'),
            h('a', {
              key: 'account',
              className: 'nsb-hint nsb-hint-inline',
              href: ACCOUNT_URL,
              target: '_blank',
              rel: 'noreferrer noopener',
            }, '坚果云账户'),
          ]),
          h('div', { className: 'nsb-hint', key: 'step1' }, t('openAppPasswordPageHint')),
          h('div', { className: 'nsb-hint', key: 'step2' }, t('pasteStep')),
        ])),
        h('div', { className: 'nsb-note', key: 'pw-note' }, t('passwordNote')),
        field(t('remoteRoot'), undefined, h('input', {
          className: 'nsb-input',
          value: form.remoteRoot,
          spellCheck: false,
          onChange: (event) => setForm((current) => ({ ...current, remoteRoot: event.target.value })),
        })),
        field(t('machine'), t('machineHint'), h('input', {
          className: 'nsb-input',
          value: form.machine,
          spellCheck: false,
          onChange: (event) => setForm((current) => ({ ...current, machine: event.target.value })),
        })),
        field(t('workspace'), undefined, h('input', {
          className: 'nsb-input',
          value: form.workspaceDir,
          spellCheck: false,
          onChange: (event) => setForm((current) => ({ ...current, workspaceDir: event.target.value })),
        })),
      ]

      const scopeBoxes = [
        ['sessions', t('scopeSessions')],
        ['profileConfig', t('scopeProfile')],
        ['workspaceMemory', t('scopeWorkspace')],
        ['pluginSource', t('scopePlugin')],
      ].map(([key, label]) => h('label', { className: 'nsb-check', key }, [
        h('input', {
          type: 'checkbox',
          key: 'c',
          checked: sources[key] !== false,
          onChange: (event) => setSources((current) => ({ ...current, [key]: event.target.checked })),
        }),
        h('span', { key: 's' }, label),
      ]))

      const machineRows = machines === undefined
        ? null
        : (machines.length === 0
          ? h('div', { className: 'nsb-note' }, t('noRemote'))
          : h('table', { className: 'nsb-table' }, [
            h('thead', { key: 'h' }, h('tr', null, [
              h('th', { key: 'm' }, t('machine')),
              h('th', { key: 'f' }, t('files')),
              h('th', { key: 's' }, t('bytes')),
              h('th', { key: 'a' }, ''),
            ])),
            h('tbody', { key: 'b' }, machines.map((machine) => h('tr', { key: machine.machine }, [
              h('td', { key: 'm' }, [machine.machine, h('div', { className: 'nsb-note', key: 'd' }, machine.createdAt ?? '')]),
              h('td', { key: 'f' }, machine.files === null || machine.files === undefined ? '—' : String(machine.files)),
              h('td', { key: 's' }, humanBytes(machine.bytes)),
              h('td', { key: 'r' }, button(t('restoreFrom'), () => onRestore(machine.machine), { disabled: busy !== undefined })),
            ]))),
          ]))

      return h('div', { className: 'nsb-root' }, [
        h('h2', { className: 'nsb-title', key: 'title' }, t('title')),
        h('p', { className: 'nsb-intro', key: 'intro' }, t('intro')),

        loadError === undefined ? null : h('div', { className: 'nsb-out nsb-err', key: 'loaderr' }, loadError),

        h('div', { className: 'nsb-status', key: 'status' }, [
          h('span', { key: 's' }, [
            h('span', { className: `nsb-dot ${statusDot}`, key: 'd' }),
            busy === undefined
              // 已登录时带上账号：用户一眼能确认"用的是哪个号"，不用去翻配置。
              ? (loggedIn
                ? (state?.account ? `${t('statusLoggedInAs')} · ${state.account}` : t('statusLoggedIn'))
                : t('statusLoggedOut'))
              : `${busy}…`,
          ]),
          loggedIn ? h('span', { className: 'nsb-note', key: 'pw-stored' }, t('passwordStoredShort')) : null,
          summary === undefined ? null : h('span', { key: 'files' }, `${summary.files} ${t('files')} · ${humanBytes(summary.bytes)}`),
          summary === undefined ? null : h('span', { key: 'dir' }, summary.remoteDir ?? ''),
        ]),

        h('div', { className: 'nsb-card', key: 'account-card' }, [
          ...inputs,
          h('div', { className: 'nsb-actions', key: 'actions' }, [
            button(t('save'), onSave, { primary: true }),
            button(t('test'), onTest),
            loggedIn ? button('清除密码', onClearPassword) : null,
          ]),
          h('div', { className: 'nsb-note', key: 'src-label' }, t('scopes')),
          h('div', { className: 'nsb-checks', key: 'scopes' }, scopeBoxes),
        ]),

        h('div', { className: 'nsb-card', key: 'action-card' }, [
          h('div', { className: 'nsb-actions', key: 'a' }, [
            button(busy === 'backup' ? t('backingUp') : t('backup'), onBackup, { primary: true }),
            button(t('listRemote'), onList),
          ]),
          machineRows,
        ]),

        // 恢复独立成一块：之前它只藏在"查看云端备份"表格的行里，用户找不到。
        h('div', { className: 'nsb-card', key: 'restore-card' }, [
          h('div', { className: 'nsb-label', key: 'title' }, t('restoreSection')),
          h('div', { className: 'nsb-note', key: 'hint' }, t('restoreHint')),

          (machines === undefined || machines.length === 0)
            ? h('div', { className: 'nsb-note', key: 'nomachine' }, t('restoreNoMachine'))
            : h('div', { className: 'nsb-row', key: 'pick' }, [
              h('label', { className: 'nsb-label', key: 'l', htmlFor: 'nsb-restore-machine' }, t('restorePick')),
              h('select', {
                id: 'nsb-restore-machine',
                key: 's',
                className: 'nsb-input',
                value: restoreMachine,
                onChange: (event) => setRestoreMachine(event.target.value),
              }, [
                h('option', { key: 'current', value: '' }, `${state?.config?.machine ?? ''} ${t('restorePickCurrent').replace('{machine}', state?.config?.machine ?? '')}`.trim()),
                ...machines.map(machine => h('option', { key: machine.machine, value: machine.machine }, `${machine.machine} · ${machine.files ?? '?'} ${t('files')} · ${machine.createdAt ?? ''}`)),
              ]),
            ]),

          h('div', { className: 'nsb-actions', key: 'buttons' }, [
            button(busy === 'restore' ? t('restoring') : t('restore'), () => onRestore(restoreMachine), { primary: true }),
          ]),

          h('label', { className: 'nsb-check', key: 'dry' }, [
            h('input', {
              type: 'checkbox',
              key: 'c',
              checked: dryRun,
              onChange: (event) => setDryRun(event.target.checked),
            }),
            h('span', { key: 's' }, t('dryRun')),
          ]),
          h('label', { className: 'nsb-check', key: 'force' }, [
            h('input', {
              type: 'checkbox',
              key: 'c',
              checked: forceRestore,
              onChange: (event) => setForceRestore(event.target.checked),
            }),
            h('span', { key: 's' }, t('forceRestore')),
          ]),
          h('div', { className: 'nsb-note', key: 'force-hint' }, t('forceRestoreHint')),
          h('div', { className: 'nsb-note', key: 'note' }, t('restartNote')),
        ]),

        result === undefined ? null : h('div', { className: 'nsb-card', key: 'result' }, [
          h('div', { className: 'nsb-label', key: 'l' }, t('result')),
          h('pre', {
            className: resultError === true ? 'nsb-out nsb-err' : 'nsb-out',
            key: 'pre',
          }, JSON.stringify(result, null, 2)),
        ]),
      ])
    }

    /** 必需的客户端服务：slots 提供注册点，locale 提供 t。 */
    const inject = ['slots', 'locale']

    /**
     * @param ctx 客户端 cordis 上下文。
     */
    function apply(ctx) {
      installStyle()
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-nutstore-backup: dictionaries')
      const t = ctx.locale.bind(NS)

      // settings.section 由 sidebar.settings 的占用者声明；未声明时 inject 不会触发（也不会报错）。
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: NS,
        // 官方分区顺序：account -10 / general 0 / models 10 / plugins 15；
        // 排在 models 之后，用户找得到、又不挤掉官方入口。
        order: 20,
        label: () => t('nav'),
        locale: NS,
      }, NutstoreSection))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
