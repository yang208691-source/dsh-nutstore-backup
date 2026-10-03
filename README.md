# dsh-nutstore-backup · 坚果云备份

给 DeepSeek Harness 用的坚果云（坚果云 / Nutstore WebDAV）备份插件。

在 **设置 → 坚果云备份** 里填上坚果云账号和应用密码，就能：

- **一键备份**：把本机的**会话记录**、**插件与配置**、**工作区记忆**（memory/、SOUL.md、USER.md、知识图谱）增量同步到坚果云；
- **换机恢复**：在新电脑的 DSH 里登录同一个坚果云，点一下「查看云端备份 → 从该备份恢复」，对话历史与记忆就回来了；
- 也可以直接让模型调用 `nutstore_backup` / `nutstore_restore` 等工具来干这些事。

零第三方依赖：WebDAV 用 Node 自带的 `node:http(s)` 实现，不需要 npm 安装任何东西。

---

## 1. 目录与文件

| 文件 | 作用 |
| --- | --- |
| `lib/index.mjs` | host 半区入口：只做接线（注册 5 个模型工具 + `/dsh-nutstore/*` 路由） |
| `lib/routes.mjs` | 全部路由业务逻辑（host 半区与独立验证服务器**共用**） |
| `lib/webdav.mjs` | 极简 WebDAV 客户端（PROPFIND / MKCOL / PUT / GET / DELETE，Basic 认证） |
| `lib/plan.mjs` | 备份范围：扫描哪些文件、排除什么 |
| `lib/backup.mjs` | 备份/恢复引擎：增量比对、manifest、恢复回收站 |
| `lib/config.mjs` | 配置读写（`$DSH_HOME/nutstore-backup/config.json`，原子写）+ 工作区目录解析 |
| `lib/credential.mjs` | 应用密码存取：优先 DSH 凭据库，退化时用 0600 明文文件 |
| `lib/client.js` | client 半区：设置页（**传统脚本**，由宿主按 `<script>` 加载） |
| `lib/server.mjs` + `lib/verify-page.mjs` | **免重启验证服务器**：browser 里把真实坚果云往返跑一遍 |
| `cordis.patch.yml` | bundle 挂载声明 |
| `test/` | 6 个测试套件（见文末） |

---

## 2. 安装

### 2.1 已经装好的情况（本机）

本机的 `desktop` profile 已经装好了。`C:\Users\yang2\.dsh\profiles\desktop\` 下：

- `node_modules\dsh-nutstore-backup` → 指向本目录的**目录联接**（Junction）；
- `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里各加了一条 `dsh-nutstore-backup`。

**客户端 bundle 是宿主启动时一次性读取并缓存的，所以必须重启 DSH 才会加载这个插件。**
重启后在 **设置 → 坚果云备份** 就能看到新页面。

### 2.2 在一台新电脑上安装

**推荐：从插件市场装**（发布后一行命令，和装其它插件一样）：

```powershell
dsh plugin --profile desktop add dsh-nutstore-backup
```

装完重启 DSH，进 设置 → 坚果云备份，用**同一个坚果云账号**登录，然后
「恢复云端备份」→ 选旧机器 → 「只预览」确认 → 「恢复」。

**当前这台机器（还没发布时）** 用的是本地源码联接，等价做法：

```powershell
# 有 dsh 命令行时
dsh plugin --profile desktop add link:"D:\My Agent\dev\dsh-nutstore-backup"

# 或者手工建联接（当前机器就是这么装的）
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
New-Item -ItemType Junction -Path "$profile\node_modules\dsh-nutstore-backup" `
         -Target "D:\My Agent\dev\dsh-nutstore-backup"
```

手工装还要把包名加进 `$profile\package.json` 的 `dsh.profile.bundles`（`dsh plugin add` 会自动做）。

> **顺序提示**：新机器上要**先装插件、再恢复数据**——恢复动作本身需要插件提供。
> 插件源码也在备份里（根 key `pluginsrc`，34 个文件），恢复后落在
> `$DSH_HOME/nutstore-backup/restored-plugins/`，可以用它当源码装（`dsh plugin add link:<那个目录>`）。
> 之所以不直接恢复进 profile：开发目录里的源码不该被备份覆盖。

---

## 3. 坚果云侧的准备

1. 注册/登录 [坚果云](https://www.jianguoyun.com/) 网页版；
2. 右上角 **账户信息 → 安全选项 → 添加应用密码**，生成一串应用密码；
   **注意：这里要填的是应用密码，不是你的网页登录密码**（坚果云对第三方客户端强制要求应用密码）；
3. 插件里「坚果云账号」填邮箱或手机号，「应用密码」填上一步生成的那串；
4. WebDAV 地址默认 `https://dav.jianguoyun.com/dav`，一般不用改。

---

## 4. 免重启验证（推荐先做这一步）

`设置页属于客户端半区，而客户端 bundle 是宿主启动时读取并缓存的`，所以要等重启才出现
（host 半区会跟着 profile 配置一起加载，实测不用重启就已经在服务了）。但**备份能力本身**可以立刻验证，
不必等重启、也不必等我——起一个独立验证服务器即可，它跑的是**同一份** `lib/routes.mjs` / `lib/backup.mjs` / `lib/webdav.mjs`：

```powershell
cd "D:\My Agent\dev\dsh-nutstore-backup"
node lib/server.mjs --open            # 默认 http://127.0.0.1:19731
# 可选：
#   --port 19999
#   --data-dir "D:\My Agent"                 # 显式指定工作区目录
#   --credentials-file <路径>                # 指定凭据文件（默认 $DSH_HOME/.credentials.yaml）
#   --no-credentials-bridge                  # 不碰凭据库，密码走 0600 明文回退文件
```

页面上按 1→2→3 走：填账号与应用密码 → **保存配置 + 存密码** → **测试连接** → **立即备份** →
**查看云端备份** → 先点 **只预览**，确认会覆盖哪些文件后再决定要不要 **真的恢复**。

**登录一次、不必等我、也不必重启**：这个服务器默认开启**凭据桥**——你**先点一次**
「保存配置 + 存密码」（账号会落进配置文件），之后填的密码就会按 DSH 自己的文档格式写进
`$DSH_HOME/.credentials.yaml` 的 `records["nutstore-backup/app-password"]`，
**正是插件读的那个记录**。所以下次重启 DSH 后，设置页会直接显示"已登录"，不用再输一遍。

凭据桥的安全措施（因为这是你的真实凭据文件，写坏了 DSH 下次启动会激活失败）：

- 只改一个键，其余内容从原文件读进来**原样保留**（实测：相对真实文件只新增 3 行、删除 0 行）；
- 写前把原文件备份成 `.credentials.yaml.bak-<时间戳>`；
- 序列化后**用同一个 YAML 实现（js-yaml，DSH 自己也用它）严格回读**，结构或内容对不上就拒写；
- 写盘后再从磁盘回读核对一次，对不上**自动还原**（有备份用备份，没有就删掉刚建的文件）；
- 文档结构非法（未知顶层键 / `version` 不是 1 / 记录键不合规）一律拒写并保持原文件不动；
- 全程原子写（临时文件 + rename），不留半截文件；
- 本插件**还没有已保存账号**时不碰凭据文件（避免覆盖别人写的同地址记录），退回 0600 明文并在页面标注。

其它约定：

- 只监听 `127.0.0.1`；写接口沿用插件的"仅本机"校验（伪造 Host 会被 403 拒）；
- 页面**不回显**已保存的密码；
- 关掉这个窗口/终端即停止服务。

### 已完成的真机验证（真实坚果云账号 + 真实端点）

**上传（首轮全量）**

```
远端目录   /dsh-backup/yangyang
上传       56 个文件 / 10,433,098 字节（约 10 MB）/ 30.2 秒 / 0 失败
          会话记录 10 个（10.1 MB）· 插件配置 5 个 · 工作区记忆 10 个 · 插件源码 31 个
云端实测   该目录下 58 个对象（56 个文件 + manifest.json + info.json），合计 10,447,213 字节
```

**下载与一致性**

```
抽样 10 个文件（含最大的 2,709,640 字节会话文件）逐个下载回来比对 sha256 → 全部一致
56 条 manifest 条目全部能映射回本机路径
```

**换机走查**：把 `DSH_HOME` 换成 `D:\Users\otheruser\.dsh`、工作区换成 `E:\Work` 后再算一遍目标路径：
会话落到新 `DSH_HOME` 下、工作区记忆落到新工作区，且 `<工作区编码>/<会话id>/<文件名>` 三层结构完整保留
（那个编码目录名是 DSH 的"会话属于哪个工作区"信息，必须原样保留，不能当成源机路径清洗掉）。

**认证与连接**：`/dsh-nutstore/test` 对真实端点返回 `checked: true`、`ms: 225`、
`passwordSource: 凭据库（nutstore-backup/app-password）`；登录后 live 宿主**不用重启**就变成 `loggedIn: true`
（凭据文件有监视）。

**认证方式的实测结论**（决定为什么必须用应用密码）：`https://dav.jianguoyun.com/dav/` 只认 Basic ——
`Bearer` 令牌直接被 400 拒，`X-Auth-Token` 与 `?access_token=` 都是 401 且 `WWW-Authenticate: Basic realm="nutstore"`；
坚果云官方帮助中心也把"第三方应用 + WebDAV"等同于"生成应用密码"。那种"点一下授权"的 OAuth
走的是坚果云**开放平台 API**（官方 Obsidian 插件那条路），需要已注册的第三方应用身份，第三方 WebDAV 客户端拿不到。

> `pluginsrc` 的落点是 `$DSH_HOME/nutstore-backup/restored-plugins/`（**不是**原来的开发目录）——
> 这是有意的：插件源码在开发目录里，恢复时不该覆盖用户正在改的那份。装回 profile 见 §2.2。
>
> **会话是三层结构**：真实布局是 `sessions/<工作区编码>/<会话id>/session.v4.jsonl.zstd`，
> 早期版本只处理 `sessions/<文件>` 这一层，导致恢复时 50 个会话文件"映射不出本机路径"
> （备份是好的，恢复会漏）。现在 `restoreTarget` 对 `sessions/` 下任意深度都按原结构落盘。

---

## 5. 设置页怎么用

| 控件 | 行为 |
| --- | --- |
| **保存并登录** | 写配置（账号/地址/根目录/机器标签/工作区/范围），有填密码就存进 DSH 凭据库，并**立即做一次 WebDAV 自检** |
| **测试连接** | 用当前表单里的账号+密码（没填就用已保存的）做一次 PROPFIND，报告延迟、服务器、云端根目录是否存在 |
| **清除密码** | 从凭据库删掉应用密码（明文回退文件也一起删） |
| **立即备份** | 增量备份：只上传新增或内容变化过的文件 |
| **查看云端备份** | 列出云端各机器目录及其文件数/体积/备份时间（也是恢复时选机器的地方） |
| **恢复云端备份**（独立分区） | 不用先点"查看云端备份"就能直接恢复「本机标签」那份；点过列表后可以用下拉框改选**别的机器**的备份 |
| **只预览（不写入）** | 恢复时只报告会写哪些文件，一个字节都不落盘 |
| 备份范围 | 会话记录 / 插件与配置 / 工作区记忆 / 插件源码，四项可单独关掉 |

状态栏会显示：登录与否（含账号）、本次扫描到多少文件与字节、当前远端目录、以及**当前运行的代码指纹**
（改了插件源码没重启时，指纹不变——这正是"看起来修好了但行为没变"的原因）。

恢复的落点：`sessions` → `$DSH_HOME/sessions`，`profile` → profile 目录，`workspace` → 配置里的工作区目录，
`pluginsrc` → `$DSH_HOME/nutstore-backup/restored-plugins/`。同名文件覆盖前会先拷到
`$DSH_HOME/nutstore-backup/restore-trash/`。

---

## 6. 模型可调用的工具

| 工具 | 说明 |
| --- | --- |
| `nutstore_status` | 只读：登录态、备份范围、远端目录、文件数与体积 |
| `nutstore_login` | 写入账号+应用密码并验证连接（**密码会出现在对话记录里，日常请用设置页**） |
| `nutstore_backup` | 增量备份，`force: true` 可强制全量重传 |
| `nutstore_list` | 列出云端各机器备份及其文件数/体积/时间 |
| `nutstore_restore` | 恢复；`sourceMachine` 指定从哪台机器的备份恢复，`mode: "missing"` 只补本地缺失，`dryRun: true` 只预览 |

---

## 7. 备份了什么（以及没备份什么）

备份根 → 恢复时的落点，**相对路径里带根 key，所以换电脑后会自动映射回本机正确位置**：

| 根 key | 内容 | 恢复落点 |
| --- | --- | --- |
| `sessions` | `$DSH_HOME/sessions/**`（会话 jsonl） | 新机器的 `$DSH_HOME/sessions/` |
| `profile` | profile 除 `node_modules`/`.`* 之外的文件（`cordis.patch.yml`、`package.json`、`pnpm-lock.yaml` 等） | 新机器的 `$DSH_PROFILE_DIR` |
| `workspace` | 工作区里的 `memory/**`、`SOUL.md`、`USER.md`、`knowledge-graph.json`、`.mcp.json` | 新机器配置里填的工作区目录 |
| `pluginsrc` | 本插件自己的源码（`lib/`、`package.json`、`cordis.patch.yml`、`README.md`） | `$DSH_HOME/nutstore-backup/restored-plugins/` |
| `extra-*` | 你自己加进 `extraPaths` 的目录/文件 | `$DSH_HOME/nutstore-backup/restored-extra/` |

刻意**不备份**：`node_modules`、`.git`、`.pnpm`、各种 cache/tmp、`.plugin-manager` 日志、`.dsh-market`、附件二进制、以及工作区里的普通文档（`文档/`、`排故档案/` 等——这些是"资料"不是"记忆"，要的话把目录加进 `extraPaths`）。单个文件上限 64 MB。

---

## 8. 云端目录结构

```
<remoteRoot>/                     默认 /dsh-backup
└── <machine>/                    机器标签，默认取 hostname
    ├── manifest.json             这一轮备份的完整清单（文件、大小、根、时间）
    ├── info.json                 一行摘要，给别的机器快速看
    └── <base64url(相对路径)>      每个文件一个对象，不做压缩打包
```

为什么一文件一对象、不打包成 zip：

1. **增量**：只按大小比对，会话 jsonl 是追加写，所以每轮只传变化过的那几个；
2. **恢复可以只挑一个文件**（比如某个会话坏了单独修），不用解整包；
3. **零依赖**：不需要 zip 库，插件在新机器上直接能跑。

远端对象名是相对路径的 base64url（例如 `sessions/a.jsonl` → `c2Vzc2lvbnMvYS5qc29ubA`）：
避免中文路径与多级目录在 WebDAV 上的建目录问题，也天然唯一。

---

## 9. 凭据与安全（如实说明）

- 应用密码**只写不读**：设置页填完就交给 host 半区，接口从**不回传**密码；
- 存放位置优先 **DSH 凭据库**：`$DSH_HOME/.credentials.yaml` 里的
  `records["nutstore-backup/app-password"]`。文件权限 **0600**，**内容是明文 YAML**
  （DSH 的凭据服务本身不做加密，也没有接 OS 钥匙串；同一 OS 用户下的任何进程都能读它）。
- 如果 profile 里没有装凭据服务，会退化为 `$DSH_HOME/nutstore-backup/secret.json`（0600 明文），
  设置页状态栏会**明确写"明文保存"**，不会假装已加密。
- 也支持环境变量：把 `NUTSTORE_DAV_PASSWORD` 放进启动环境或 `.env` 即可免配置密码。
- 写接口（保存密码/备份/恢复/改配置）**只接受来自本机的请求**（校验 socket 来源 + Host 头），
  防止别的网页跨站往你的坚果云里写东西。

---

## 10. 测试

```powershell
cd "D:\My Agent\dev\dsh-nutstore-backup"
node test/run-all.mjs
```

| 套件 | 覆盖 |
| --- | --- |
| `mock-dav-test.mjs` | 起一个本地 mock WebDAV，验证 PROPFIND/MKCOL/PUT/GET/DELETE、扫描范围（排除 node_modules/大文件）、首轮全量、二轮零上传、改一个文件只传一个、`listRemoteMachines`、dryRun、真实恢复、跨机器恢复、回收站 |
| `host-apply-test.mjs` | 用假 ctx 调真实 `apply()`：5 个工具与全部路由都注册、`/state`→`/config`→`/password`→`/test`→`/backup`→`/machines`→`/restore` 全链路、伪造 Host 的写请求被 403、工具 `execute` 可直调 |
| `client-half-test.mjs` | 模拟宿主 `__ModuleLoader__`/`require`/cordis ctx，用自带的极简 React 运行时**真的渲染并点击**这个设置页：注册形态、`id`/`order`/`label` thunk/locale、首次拉 `/state`、点「测试连接」「保存并登录」「立即备份」发出的请求、错误是否显示 |
| `credential-test.mjs` | 应用密码两条路径：有凭据服务（`modifyRecord` + `<scope>/<id>` 记录 + 引用层环境变量）、无凭据服务（0600 明文回退并如实标注）、清除、服务恢复后清理回退文件 |
| `credential-bridge-test.mjs` | 凭据桥安全性：与真实文件同构时**原有记录逐项不变**、四类非法文档**一律拒写且原文件不动**、写前留 `.bak`、插件的 `loadPassword` 能端到端读回、空文件/不存在也能安全开始、借不到 js-yaml 时如实 `unsupported` |
| `workspace-test.mjs` | 工作区目录解析（含"挑真有记忆的工作区而非 `defaultWorkspaceId`"）+ **恢复路径映射**：`DSH_HOME` 缺失时（桌面壳启动的宿主就是这样）也必须能映射，且显式 `DSH_HOME` 优先 |
| `server-test.mjs` | 把 `lib/server.mjs` 当进程起起来，用真实 HTTP 走页面与全部接口（含真实恢复），验证密码**确实写进** `.credentials.yaml` 且没落明文文件，并用**裸 socket** 伪造 Host 验证"仅本机" |
| `profile-resolution-test.mjs` | 预检：按 `dsh-app-boot` 的解析方式确认 profile 里登记的 bundle 能被解析、patch 与两半入口齐备 |
| `package-check.mjs` | 发布前自检：元数据齐全、`private` 未开、`dsh.bundle.patch` 存在且 name 对得上、`dsh.client.platform === 'web'`、`exports["./client"]` 是传统脚本且只 require 种子模块、`dsh.client.inject` 里的包在 asar 里真实存在、打包内容不含测试与 node_modules |

9 个套件都不需要真实坚果云账号，也不碰你的真实 `.dsh` 数据（各自用临时目录）。
整套跑完约 7 秒。

另外三个是**排查工具**而不是断言，需要时手动跑：

| 脚本 | 用途 |
| --- | --- |
| `test/diagnose-workspace.mjs` | 按真实环境变量打印工作区解析结果（排查"工作区记忆 0 个文件"） |
| `test/diagnose-restore-env.mjs` | 对比"有/无 `DSH_HOME`"下的恢复路径映射（排查恢复全失败） |
| `test/diagnose-real-credentials.mjs` | **只读**：在真实凭据文件的副本上干跑一次写入并打印 diff |

以及两个**对着真实坚果云**跑的验证脚本（需要先登录）：

| 脚本 | 用途 |
| --- | --- |
| `test/verify-roundtrip.mjs` | 抽样把云端文件下载回来比 sha256 + 换机路径走查 |
| `test/verify-restore-mapping-noenv.mjs` | 在"没有 `DSH_HOME`"的环境下用真实 manifest 校验每条都能映射 |
| `test/verify-plugin-backup.mjs` | 确认插件源码（`pluginsrc/`）真的在备份里、以及恢复落点 |
| `test/live-credential-acceptance.mjs` | 往真实凭据文件写一条**假**记录 → 看 live 宿主是否认 → 立刻撤销并逐字节核对 |

### 发布到插件市场前的清单

`node test/package-check.mjs` 已经把可自动检查的部分固化了。人要做的是：

1. `package.json` 里 `name` / `version` / `description` / `license` / `keywords` 就位（`private` 必须是 `false`）；
2. 推到公开仓库（市场与 `dsh plugin add` 都按包名从 npm 取）；
3. `npm publish`（首次发布建议 `0.1.0`，之后按语义化版本）；
4. 装一次验证：`dsh plugin --profile web add dsh-nutstore-backup`，重启后确认 设置 → 坚果云备份 出现；
5. 再往市场提交收录（README 里最好配上设置页截图与"恢复"流程说明）。

> 发布版与开发版的差别只在安装方式：市场版由 `dsh plugin add` 处理依赖与 bundles 登记；
> 本地开发用 `dsh plugin add link:<目录>`。

另外三个是**排查工具**而不是断言，需要时手动跑：

| 脚本 | 用途 |
| --- | --- |
| `test/diagnose-workspace.mjs` | 按真实环境变量打印工作区解析结果（排查"工作区记忆 0 个文件"） |
| `test/diagnose-bridge.mjs` | 在临时 DSH_HOME 下确认凭据桥能否借到 js-yaml |
| `test/diagnose-real-credentials.mjs` | **只读**：在真实凭据文件的副本上干跑一次写入并打印 diff（确认"只新增、不修改"） |
| `test/live-credential-acceptance.mjs` | 往真实凭据文件写一条**假**记录 → 看 live 宿主是否认 → 立刻撤销并逐字节核对；需要一个**能写 `$DSH_HOME`** 的终端 |

---

## 11. 备份是增量的（以及判据是什么）

**每轮只上传"变了"的文件，不会整包重传。** 真实的对照数据：

| 轮次 | 上传 | 跳过 |
| --- | --- | --- |
| 第 1 轮（首轮全量） | 56 个 / 10,433,098 字节 / 30.2 秒 | 0 |
| 第 2 轮（立刻再点一次） | **0 个** | 56 个 |

**判据是两段**：

**第一段 · 元数据快路径（默认开，`trustFileMetadata`）**
`大小 + mtime + 文件身份(dev/ino)` 与上次记录完全一致 → 判定未变，**连读都不读**。
这一段的全部价值就是"没变就别读"：文件多或会话文件大时，每轮全量读取才是主要开销。
代价是 `mtime` 不是内容的凭证——所以：

- mtime 变了（恢复 / 跨盘拷贝 / 同步工具都会碰它）只会退回去算哈希，**不会漏**；
- "同一时刻改回同样长度"的情况，靠 mtime 的亚毫秒精度 + `dev/ino` 一起比来兜；
- 想要"绝不漏"，把 `trustFileMetadata` 设为 `false`，回到每轮全量算哈希。

**第二段 · 内容 sha256**
哈希与上次记录的一致 → 不重传（说明只是 mtime 被碰过），**但会把新的 mtime 写回清单**，下次就走快路径；
不一致 → 重传该文件并更新哈希。清单里始终保留每个文件的 sha256，所以快路径不会把哈希丢掉。

为什么**不能只看大小**：把 `provider: deepseek-account` 换成另一个等长值、把 `true` 改成 `false`、
把一个数字改成同位数——字节数一模一样，只看大小就会判成"没变"，云端永远停在旧版本。
配置文件与记忆文件里这种"改一句同样长的话"极其常见（会话文件是追加写的，本来不会中招）。
回归用例见 `mock-dav-test.mjs` 的 `[5b] 等长内容改动也必须被发现` 与 `[5c] 元数据快路径：没变的文件连读都不读`。

清单里的 `stats` 会如实报告这一轮的构成，便于判断快路径有没有生效：

```json
{ "files": 58, "uploaded": 0, "unchanged": 58, "unchangedByMetadata": 58, "hashed": 0 }
```

**升级是平滑的**：老清单里没有 `sha256` 字段时回落到"大小相同即未变"，
所以第一次带哈希的备份不会突然全量重传；从那一轮起清单里就有哈希了（恢复时也能校验内容，而不只是长度）。

**失败不更新清单**：有文件传失败时 manifest 保持上一轮，下一轮把失败的重新当 pending 重试，
不会谎称"已经在云端了"。

**改了插件源码要重启 DSH 才生效**：host 半区不会热加载。容易误判成"代码里的 bug"，
所以 `/state` 与 `nutstore_status` 会报告**运行版本指纹**（`build.short` / `build.newestAt`）：
拿它和磁盘上 `lib/` 的最新 mtime 比一下，就知道跑的是不是最新代码。

---

## 12. 传输层的取舍（坚果云对并发和抖动都敏感）

- **只有瞬时失败才重试**，最多 3 次，优先听服务端 `Retry-After`，否则 400ms→800ms→1600ms（封顶 8s）。
  瞬时包括两类：
  - HTTP 层：`429 / 500 / 502 / 503 / 504 / 507`；
  - **网络层**：`ECONNRESET / EPIPE / ETIMEDOUT / ENETUNREACH / …`——**上传传到一半断线就属于这一类**，
    早期版本不认它，等于真实抖动下第一次失败就放弃；
  确定性问题（401/403/404/409）立刻抛出，不浪费配额。
- **重试必须重建流**：流是一次性的。上传传到一半断线后，`Content-Length` 已声明但流已消耗，
  复用同一个流去重试会**挂住等一个永远到不了的字节数**（实测卡满 60s 超时）；
  所以带重试的上传传 `filePath`（每次尝试 `createReadStream`），传 `body` 流时客户端会直接拒绝带重试的调用。
  用例见 `mock-dav-test.mjs` 的 `[12] 上传传到一半断线`。
- **内容级校验**：备份后逐文件比对本机与远端的 sha256（只比长度不够——"写了一半""重试丢内容"这类问题会漏过）。
- **上传下载都流式**：不再把文件整份读进内存（会话 jsonl 可以很大）；
- **恢复不写坏文件**：先写 `<目标>.nbpart-<pid>`，校验字节数与 manifest 一致后再改名覆盖；
  字节数对不上就报错并清掉临时文件，宁可这次不恢复，也不留一个被截断的会话文件；
  覆盖前原文件会拷到 `restore-trash/`；
- **失败不更新 manifest**：有文件传失败时清单保持上一轮，下一轮会把它们重新当 pending 重试，
  不会谎称"已经在云端了"（失败记账写在 `$DSH_HOME/nutstore-backup/last-failed.json`）。

---

## 13. 已知边界

- **工作区目录不是猜的**，解析顺序：
  ① `DSH_SESSION_CWD`；② `process.cwd()`（当且仅当它不在 DSH 内部目录里且看起来像工作区）；
  ③ `$DSH_HOME/storages/workspace.json` 里**按「真有 memory/SOUL.md/USER.md/knowledge-graph.json」>
  「会话数」>「最近更新」**排序后取第一个；④ 都拿不到就**留空并跳过工作区**。
  刻意**不**听 `defaultWorkspaceId`：本机实测它指向
  `C:\Users\yang2\Documents\deepseek-harness\default-workspace`，那个目录**是空的**，
  而真正在用的是 `D:\My Agent`（有 memory/、SOUL.md、knowledge-graph.json）——
  听默认值会变成"备份成功但工作区记忆一个文件都没传"。
  `DSH_HOME`、profile 目录、`sessions/`、`storages/`、`attachments/` 一律被排除在工作区之外；
  设置页可以手工覆盖。
- **设置页需要重启 DSH 才出现**（客户端 bundle 表启动时组成），host 半区不用；
- **应用密码存的是明文**（在 0600 的凭据文件里），这是 DSH 凭据服务的现有实现，不是本插件的选择；
- 恢复会**覆盖**本机同名文件，覆盖前的副本在 `$DSH_HOME/nutstore-backup/restore-trash/`；
  恢复后建议重启 DSH，让会话索引与设置重新加载；
- 备份的是**文件**，不导出 SQLite 投影缓存（`storages/session_projcache` 会按需重建）；
- 恢复到的路径按**本机当前**的 `$DSH_HOME` / `$DSH_PROFILE_DIR` / 工作区重算，所以两台机器上的
  用户名或盘符不同也能对上。
