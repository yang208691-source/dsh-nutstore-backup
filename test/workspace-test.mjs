/**
 * 工作区解析测试：这是最容易"备份成功但什么都没备份"的地方，必须钉住。
 *
 * 覆盖：
 *   ① DSH_SESSION_CWD 优先；
 *   ② 没有环境变量时，从 workspace.json 里挑「真有记忆」的那个，而不是 defaultWorkspaceId；
 *   ③ 都有记忆时选会话数多的；
 *   ④ cwd 落在 DSH 内部目录（profile / DSH_HOME / sessions）时被拒绝，不被当工作区；
 *   ⑤ 注册表为空时回退到 cwd（但仍是 DSH 内部目录就返回 undefined）；
 *   ⑥ normalizeConfig 拒绝把 profile/DSH_HOME 写进 workspaceDir（旧值的护栏）。
 *
 * 用法：node test/workspace-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const failures = []
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(`${label} ${detail}`)
    console.log(`  FAIL  ${label} ${detail}`)
  }
}

const lib = (file) => pathToFileURL(path.join('D:/My Agent/dev/dsh-nutstore-backup/lib', file)).href
const config = await import(lib('config.mjs'))

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nsb-ws-'))
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }

/** 每个用例一套独立的 DSH_HOME，避免相互污染（config.mjs 每次调用都重读环境变量）。 */
function makeHome(name, workspaces, options = {}) {
  const home = path.join(sandbox, name)
  const profile = path.join(home, 'profiles', 'desktop')
  fs.mkdirSync(profile, { recursive: true })
  if (workspaces !== undefined) {
    write(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: Object.keys(workspaces), defaultWorkspaceId: options.defaultId ?? Object.keys(workspaces)[0] ?? '' },
      tables: { workspaces },
    }))
  }
  process.env.DSH_HOME = home
  process.env.DSH_PROFILE = 'desktop'
  process.env.DSH_PROFILE_DIR = profile
  delete process.env.DSH_SESSION_CWD
  return { home, profile }
}

console.log('\n[1] DSH_SESSION_CWD 优先')
{
  const { home } = makeHome('env-priority', { a: { path: path.join(sandbox, 'other-ws'), sessionIds: ['s1'] } })
  const explicit = path.join(home, 'explicit-workspace')
  fs.mkdirSync(explicit, { recursive: true })
  process.env.DSH_SESSION_CWD = explicit
  check('环境变量直接胜出', config.resolveWorkspaceDir() === path.resolve(explicit), String(config.resolveWorkspaceDir()))
}

console.log('\n[2] 挑「真有记忆」的工作区，而不是 defaultWorkspaceId')
{
  const empty = path.join(sandbox, 'empty-default')
  fs.mkdirSync(empty, { recursive: true })
  const real = path.join(sandbox, 'real-workspace')
  write(path.join(real, 'memory', 'FACT.md'), '# facts\n')
  write(path.join(real, 'SOUL.md'), '# soul\n')
  // defaultId 指向空目录，但真正有记忆的是另一个
  makeHome('prefer-memory', {
    'ws-empty': { path: empty, sessionIds: ['s1', 's2', 's3', 's4', 's5'] },
    'ws-real': { path: real, sessionIds: ['s1'] },
  }, { defaultId: 'ws-empty' })
  const resolved = config.resolveWorkspaceDir()
  check('选中有记忆的那个（哪怕会话数少）', resolved === path.resolve(real), String(resolved))
}

console.log('\n[3] 都有记忆时选会话数多的')
{
  const few = path.join(sandbox, 'few')
  write(path.join(few, 'SOUL.md'), 'x\n')
  const many = path.join(sandbox, 'many')
  write(path.join(many, 'memory', 'FACT.md'), 'x\n')
  makeHome('prefer-sessions', {
    'ws-few': { path: few, sessionIds: ['s1'] },
    'ws-many': { path: many, sessionIds: ['s1', 's2', 's3'] },
  })
  const resolved = config.resolveWorkspaceDir()
  check('选会话数多的', resolved === path.resolve(many), String(resolved))
}

console.log('\n[4] DSH 内部目录永远不被当工作区')
{
  const internalHome = path.join(sandbox, 'internal')
  const internalProfile = path.join(internalHome, 'profiles', 'desktop')
  const { home, profile } = makeHome('internal', {
    'ws-profile': { path: internalProfile, sessionIds: ['s1', 's2', 's3', 's4'] },
    'ws-home': { path: internalHome, sessionIds: ['s1', 's2', 's3', 's4', 's5'] },
  })
  check('profile 目录被过滤', config.resolveWorkspaceDir() !== path.resolve(profile), String(config.resolveWorkspaceDir()))
  check('DSH_HOME 被过滤', config.resolveWorkspaceDir() !== path.resolve(home), String(config.resolveWorkspaceDir()))
  check('isDshInternalPath 对 sessions 子目录也成立', config.isDshInternalPath(path.join(home, 'sessions')) === true)
  check('isDshInternalPath 对外部目录不成立', config.isDshInternalPath(path.join(sandbox, 'external-ws')) === false)
}

console.log('\n[5] 注册表为空时的回退')
{
  const { home } = makeHome('no-registry', undefined)
  const cwd = process.cwd()
  const resolved = config.resolveWorkspaceDir()
  if (config.isDshInternalPath(cwd) || path.parse(cwd).root === cwd) {
    check('cwd 不可用时返回 undefined（而不是瞎猜）', resolved === undefined, String(resolved))
  } else {
    check('cwd 可用时回退到 cwd', resolved === path.resolve(cwd), String(resolved))
  }
  check('回退值绝不是 DSH_HOME', resolved !== path.resolve(home), String(resolved))
}

console.log('\n[6] normalizeConfig 护栏：拒绝 profile / DSH_HOME 作为工作区')
{
  const { home, profile } = makeHome('guardrail', undefined)
  const guarded = config.normalizeConfig({ workspaceDir: profile })
  check('写入 profile 目录被拒（回退到解析结果）', guarded.workspaceDir !== path.resolve(profile), String(guarded.workspaceDir))
  const guardedHome = config.normalizeConfig({ workspaceDir: home })
  check('写入 DSH_HOME 被拒', guardedHome.workspaceDir !== path.resolve(home), String(guardedHome.workspaceDir))
  const real = path.join(sandbox, 'good-ws')
  fs.mkdirSync(real, { recursive: true })
  check('正常目录被接受', config.normalizeConfig({ workspaceDir: real }).workspaceDir === path.resolve(real))
  check('空字符串→解析结果（不落 cwd）', config.normalizeConfig({ workspaceDir: '' }).workspaceDir === config.resolveWorkspaceDir() || config.normalizeConfig({ workspaceDir: '' }).workspaceDir === '')
}

console.log('\n[7] looksLikeWorkspace 判定')
{
  const withMemory = path.join(sandbox, 'has-memory')
  write(path.join(withMemory, 'memory', 'JOURNAL.jsonl'), '{}\n')
  const plain = path.join(sandbox, 'plain-dir')
  fs.mkdirSync(plain, { recursive: true })
  check('有 memory/ 的目录算工作区', config.looksLikeWorkspace(withMemory) === true)
  check('空目录不算工作区', config.looksLikeWorkspace(plain) === false)
  check('不存在的目录不算工作区', config.looksLikeWorkspace(path.join(sandbox, 'nope')) === false)
}

console.log('\n[8] 恢复路径映射：宿主没有 DSH_HOME 时也必须能映射')
{
  // 这是**真机才会暴露**的接缝：桌面壳启动的宿主进程没有 DSH_HOME，
  // 而早期 restoreTarget() 只看 DSH_HOME，拿不到就一律返回 undefined
  // → 真机上"恢复"100% 失败（实测 50/59 条报"无法映射回本机路径"），
  //   而带环境变量的独立进程与我的测试里全绿。
  const backup = await import(lib('backup.mjs'))
  const { home } = makeHome('restore-env', undefined)
  const targetWorkspace = path.join(sandbox, 'restore-workspace')
  fs.mkdirSync(targetWorkspace, { recursive: true })
  const pluginConfig = { workspaceDir: targetWorkspace }
  const nested = 'sessions/--D-My~0020Agent--/abc-123/session.v4.jsonl.zstd'
  const flat = 'profile/cordis.patch.yml'
  // USERPROFILE 指到 <sandbox>\user，于是回退应当是 <sandbox>\user\.dsh
  const userProfile = path.join(sandbox, 'user')
  fs.mkdirSync(userProfile, { recursive: true })

  const savedHome = process.env.DSH_HOME
  const savedProfile = process.env.USERPROFILE
  delete process.env.DSH_HOME
  process.env.USERPROFILE = userProfile

  const nestedTarget = backup.restoreTarget(nested, pluginConfig)
  const flatTarget = backup.restoreTarget(flat, pluginConfig)
  check('没有 DSH_HOME 时嵌套会话路径能映射', typeof nestedTarget === 'string' && nestedTarget.includes('session.v4.jsonl.zstd'), String(nestedTarget))
  check('没有 DSH_HOME 时配置路径能映射', typeof flatTarget === 'string' && flatTarget.includes('cordis.patch.yml'), String(flatTarget))
  check('回退到 USERPROFILE\\.dsh，而不是随便猜一个目录', String(nestedTarget).startsWith(path.join(userProfile, '.dsh')), `${nestedTarget} 期望前缀 ${path.join(userProfile, '.dsh')}`)
  check('工作区记忆仍然落到配置的工作区', String(backup.restoreTarget('workspace/SOUL.md', pluginConfig)).startsWith(targetWorkspace), String(backup.restoreTarget('workspace/SOUL.md', pluginConfig)))

  // 显式 DSH_HOME 必须优先
  process.env.DSH_HOME = home
  const withEnv = backup.restoreTarget(flat, pluginConfig)
  check('显式 DSH_HOME 优先于 USERPROFILE', String(withEnv).startsWith(path.resolve(home)), `${withEnv} 期望前缀 ${path.resolve(home)}`)

  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  if (savedProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = savedProfile
}

fs.rmSync(sandbox, { recursive: true, force: true })

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} 项失败：`)
  for (const failure of failures) console.log(`   - ${failure}`)
  process.exitCode = 1
} else {
  console.log('\n✅ 全部通过')
}
