/**
 * dsh-nutstore-backup —— host 半区。
 *
 * 三件事：
 *  ① 把坚果云 WebDAV 备份能力注册成模型可调用的工具（nutstore_backup / nutstore_restore 等）；
 *  ② 把 `/dsh-nutstore/*` HTTP 路由挂到宿主 webServer，给设置页（client 半区）用；
 *  ③ 应用密码走宿主 credentials 服务，不落进明文配置。
 *
 * 这里**不写对象级 inject**：apply() 必须立刻执行并立刻注册路由，
 * 否则等 webServer/credentials 全部就绪可能永远不 resolve（旧 DSH 上会整插件不加载）。
 * 业务逻辑全部在 routes.mjs / backup.mjs / webdav.mjs，本文件只做接线，
 * 这样"装进 DSH 的那份"和"独立验证服务器那份"永远是同一份代码。
 */
import { loadConfig, saveConfig } from './config.mjs'
import { WebDavClient } from './webdav.mjs'
import {
  MANIFEST_NAME,
  listRemoteMachines,
  readManifest,
  remoteDir,
  runBackup,
  runRestore,
} from './backup.mjs'
import { PASSWORD_REF, savePassword } from './credential.mjs'
import {
  PLUGIN_ID,
  buildRouteHandlers,
  defineNutstoreTool,
  publicStatus,
  requireClient,
  wrapRouteHandler,
} from './routes.mjs'

export const name = 'dsh-nutstore-backup'
export { PLUGIN_ID }

/** 注册 host 半区。 */
export function apply(ctx) {
  const disposers = []
  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 卸载路径上的异常不该再抛出去。
      }
    }
    disposers.length = 0
  }, 'dsh-nutstore-backup: cleanup')

  // ── 工具 ────────────────────────────────────────────────────────────────────
  ctx.inject(['tools'], (toolCtx) => {
    const register = (definition) => {
      disposers.push(toolCtx.tools.register(defineNutstoreTool(definition)))
    }

    register({
      name: 'nutstore_status',
      description: '查看坚果云备份插件的状态：是否已登录、备份范围、远端目录、本轮会备份多少文件与字节。只读，不改任何数据。',
      parameters: {},
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          loggedIn: { type: 'boolean', required: true, description: '是否已保存应用密码' },
          remoteDir: { type: 'string', description: '当前机器的远端备份目录' },
          files: { type: 'integer', description: '本轮将扫描到的文件数' },
          bytes: { type: 'integer', description: '这些文件的总字节数' },
        },
      },
      async execute() {
        const config = loadConfig()
        const status = await publicStatus(ctx, config)
        return {
          loggedIn: status.loggedIn,
          passwordSource: status.password.label,
          server: config.server,
          account: config.account,
          remoteDir: status.sources.remoteDir,
          machine: config.machine,
          workspaceDir: config.workspaceDir === '' ? '（未解析出工作区目录，工作区记忆不会被备份）' : config.workspaceDir,
          files: status.sources.files,
          bytes: status.sources.bytes,
          /** 当前运行的代码指纹：和磁盘不一致就说明这份 host 半区是旧代码，需要重启 DSH。 */
          build: status.build,
          roots: status.sources.roots.map(root => `${root.key}: ${root.count} 个文件 / ${root.bytes} 字节`),
        }
      },
    })

    register({
      name: 'nutstore_login',
      description: '把坚果云账号与应用密码写入 DSH 凭据库，并立即验证 WebDAV 连接。应用密码需要在坚果云网页版「账户信息 → 安全选项 → 添加应用密码」生成，不是网页登录密码。注意：密码会出现在本次对话记录里，日常请优先用 设置 → 坚果云备份 页面填写。',
      parameters: {
        account: { type: 'string', required: true, description: '坚果云账号（邮箱或手机号）' },
        password: { type: 'string', required: true, description: '坚果云「应用密码」' },
        server: { type: 'string', required: false, description: 'WebDAV 地址，默认 https://dav.jianguoyun.com/dav' },
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          storedAt: { type: 'string', required: true },
          checked: { type: 'boolean', required: true },
          error: { type: 'string' },
        },
      },
      async execute(args) {
        const patch = { account: String(args.account ?? '').trim() }
        if (typeof args.server === 'string' && args.server.trim() !== '') patch.server = args.server.trim()
        if (patch.account === '') throw new Error('account 不能为空')
        const config = saveConfig(patch)
        const storedAt = await savePassword(ctx, String(args.password ?? ''))
        try {
          const client = new WebDavClient({ server: config.server, account: config.account, password: String(args.password ?? '') })
          const check = await client.check()
          return { ok: true, storedAt, checked: true, server: check.server ?? config.server }
        } catch (error) {
          return {
            ok: true,
            storedAt,
            checked: false,
            error: `密码已保存，但连接测试失败：${error instanceof Error ? error.message : String(error)}`,
          }
        }
      },
    })

    register({
      name: 'nutstore_backup',
      description: '把本机的 DSH 会话记录、插件配置与工作区记忆增量备份到坚果云。只上传有变化的文件，首次全量。需要先在 设置 → 坚果云备份 登录。',
      parameters: {
        force: { type: 'boolean', required: false, description: 'true 时忽略远端清单，强制全量重传' },
      },
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          dir: { type: 'string', required: true, description: '远端备份目录' },
          uploaded: { type: 'integer', required: true, description: '本轮实际上传的文件数' },
          skipped: { type: 'integer', required: true, description: '大小未变化而跳过的文件数' },
          uploadedBytes: { type: 'integer', required: true },
          failed: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
        },
      },
      async execute(args) {
        const config = loadConfig()
        const { client } = await requireClient(ctx, config)
        const result = await runBackup({ client, config, force: args?.force === true })
        return {
          ok: result.ok,
          dir: result.dir,
          uploaded: result.uploaded,
          skipped: result.skipped,
          uploadedBytes: result.uploadedBytes,
          scannedFiles: result.scanned.files,
          failed: result.failed.slice(0, 50),
          ms: result.ms,
        }
      },
      timeoutMs: 30 * 60 * 1000,
    })

    register({
      name: 'nutstore_list',
      description: '列出坚果云上已有的备份（哪几台机器、各含多少文件与字节）。换新电脑时先用它确认远端有什么。',
      parameters: {},
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          remoteRoot: { type: 'string', required: true },
          machines: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
        },
      },
      async execute() {
        const config = loadConfig()
        const { client } = await requireClient(ctx, config)
        const machines = await listRemoteMachines(client, config)
        const detailed = []
        for (const machine of machines) {
          const manifest = await readManifest(client, { ...config, machine: machine.name, perMachineDir: true })
          detailed.push({
            machine: machine.name,
            modified: machine.modified,
            files: manifest?.stats?.files ?? null,
            bytes: manifest?.stats?.bytes ?? null,
            createdAt: manifest?.createdAt ?? null,
            sources: manifest?.sources ?? null,
          })
        }
        return { ok: true, remoteRoot: config.remoteRoot, dir: remoteDir(config), machines: detailed }
      },
    })

    register({
      name: 'nutstore_restore',
      description: '从坚果云恢复备份到本机（换电脑后的第一步）。默认从本机名对应的目录恢复；可以指定 sourceMachine 从另一台机器的备份恢复。dryRun=true 时只报告会写哪些文件，不落盘。',
      parameters: {
        sourceMachine: { type: 'string', required: false, description: '远端机器目录名；省略则用当前机器名' },
        mode: { type: 'string', required: false, enum: ['all', 'missing'], description: 'all=按需覆盖，missing=只补本地缺失的文件' },
        dryRun: { type: 'boolean', required: false, description: '只预览不写入' },
      },
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          dir: { type: 'string', required: true },
          restored: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          skipped: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
          failed: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
        },
      },
      async execute(args) {
        const config = loadConfig()
        const { client } = await requireClient(ctx, config)
        const result = await runRestore({
          client,
          config,
          sourceMachine: typeof args?.sourceMachine === 'string' ? args.sourceMachine : undefined,
          mode: args?.mode === 'missing' ? 'missing' : 'all',
          dryRun: args?.dryRun === true,
        })
        return {
          ok: result.ok,
          dir: result.dir,
          machine: result.machine,
          createdAt: result.createdAt,
          mode: result.mode,
          dryRun: result.dryRun,
          restoredCount: result.restored.length,
          skippedCount: result.skipped.length,
          restored: result.restored.slice(0, 200),
          skipped: result.skipped.slice(0, 200),
          failed: result.failed.slice(0, 50),
          ms: result.ms,
          note: '恢复后建议重启 DSH，让会话与设置重新加载。',
        }
      },
      timeoutMs: 15 * 60 * 1000,
    })
  })

  // ── HTTP 路由（设置页用） ───────────────────────────────────────────────────
  ctx.inject(['webServer'], (webCtx) => {
    const handlers = buildRouteHandlers(ctx)
    for (const path of Object.keys(handlers)) {
      disposers.push(webCtx.webServer.register({
        kind: 'exact',
        path,
        handler: wrapRouteHandler(handlers, path),
      }))
    }
  })
}

export default { name, apply }
