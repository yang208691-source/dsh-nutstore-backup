# dsh-nutstore-backup · 坚果云备份

给 DeepSeek Harness（DSH）用的第三方坚果云 WebDAV 备份插件。它备份 DSH 的**会话、配置和记忆文件**，不是整盘/整目录备份。

- **会话记录**：`$DSH_HOME/sessions/**`
- **当前 profile 配置**：`package.json`、`cordis.patch.yml`、锁文件等（不含 `node_modules`）
- **工作区记忆文件**：`memory/`、`SOUL.md`、`USER.md`、`knowledge-graph.json`、`.mcp.json`（存在才备）
- **额外路径**：第三方记忆插件、自定义目录/文件
- **本插件源码**：换机后可重新安装

明确**不备份**：工作区普通文档、`~/.dsh/attachments`、`node_modules`、缓存、`AGENTS.md`/`CLAUDE.md`（当前版本）。单文件上限 64 MB，超过会在设置页提示。

> `memory/`、`SOUL.md` 等是常见约定，不是 DSH 内置文件；stock DSH 不会自动生成它们。使用第三方记忆插件时，请把它的数据目录加到「额外路径」。

---

## 安装

从插件市场安装：

```powershell
dsh plugin --profile desktop add dsh-nutstore-backup
```

本地开发用 link：

```powershell
dsh plugin --profile desktop add link:"D:\path\to\dsh-nutstore-backup"
```

装完重启 DSH。

---

## 坚果云准备

1. 登录 [坚果云网页版](https://www.jianguoyun.com/)；
2. 右上角 **账户信息 → 安全选项 → 第三方应用管理 → 添加应用密码**；
3. 复制生成的**应用密码**（不是网页登录密码）。

WebDAV 地址默认 `https://dav.jianguoyun.com/dav`，一般不用改。

---

## 使用

打开 **设置 → 坚果云备份**：

1. 填账号、应用密码，点 **保存并登录**；
2. 点 **立即备份**；
3. 点 **查看云端备份**，确认文件数和体积；
4. 换机时登录同一个坚果云，选旧机器 → **只预览** 确认 → **恢复**。

恢复会把同名文件先拷到 `$DSH_HOME/nutstore-backup/restore-trash/`；恢复后建议重启 DSH。

默认会保护“本机比云端更新”的文件；确实要完全恢复成云端快照时，勾选 **以云端为准**。

---

## 备份范围

| 根 key | 内容 | 恢复到 |
| --- | --- | --- |
| `sessions` | `$DSH_HOME/sessions/**` | 新机器的 `$DSH_HOME/sessions/` |
| `profile` | 当前 profile 的顶层配置（不含 `node_modules`、点目录） | 当前 `$DSH_PROFILE_DIR` |
| `workspace` | 上面的“工作区记忆文件” | 配置里的工作区目录 |
| `pluginsrc` | 本插件源码 | `$DSH_HOME/nutstore-backup/restored-plugins/` |
| `extra-*` | `extraPaths` 里的目录/文件 | 配置里填的同一路径 |

增量规则：大小 + mtime + dev/ino 快路径，再加内容 `sha256`；等长内容改动也能发现。清单缺 `sha256` 时第一轮会重传一次，之后恢复正常。

---

## 额外路径

设置页的 **额外路径** 用于第三方记忆插件或自定义资料目录（改完点 **保存并登录** 生效）：

- 备份时递归扫描该目录/文件；
- 恢复时写回**同一路径**；换机后把同一项改成新机器的路径即可；
- 按列表顺序对应备份里的 `extra-0`、`extra-1`……，**顺序要一致**；
- 配置里删掉或序号对不上时，回退到 `$DSH_HOME/nutstore-backup/restored-extra/`，不会乱写。

注意：如果记忆插件用 SQLite，热拷贝可能不一致；最好让它导出 JSON，或停写后再备份。

---

## 安全与限制

- 应用密码存 DSH 凭据库；DSH 凭据文件本身是 **0600 明文 YAML**，不是加密保险箱；
- 备份内容**明文上传**到坚果云，没有客户端加密；不要往里放密钥/token；
- **没有自动定时备份**：只有点「立即备份」或模型调用 `nutstore_backup` 才传；
- 不清理云端旧对象：本地删了，云端旧文件仍占空间；
- 不备份 `attachments`（会话里的图片/附件会缺）和 `storages/workspace.json`（归档/置顶状态会丢）；
- 不支持整盘/工作区普通文档；要备资料请用坚果云客户端或另加 `extraPaths`。

---

## 模型工具

| 工具 | 作用 |
| --- | --- |
| `nutstore_status` | 查看登录态、备份范围、远端目录 |
| `nutstore_login` | 保存账号 + 应用密码并测试连接（密码会进对话记录，日常请用设置页） |
| `nutstore_backup` | 增量备份，`force: true` 强制全量 |
| `nutstore_list` | 列出云端各机器的备份 |
| `nutstore_restore` | 恢复；`sourceMachine` 选机器，`dryRun: true` 只预览 |

---

## 开发

```powershell
node test/run-all.mjs
```

核心套件：`mock-dav-test`、`host-apply-test`、`client-half-test`、`credential-test`、`credential-bridge-test`、`workspace-test`、`server-test`、`profile-resolution-test`、`package-check`。

`package-check` 在“DSH 打包进 `app.asar`”的机器上可能误报 `@deepseek-ai/dsh-client-*` 找不到；这是检查器读不到 asar，不是插件加载失败。

## License

MIT
