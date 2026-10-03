/**
 * 凭据桥测试：这是全项目**风险最高**的一段代码（写的是用户真实凭据文件，
 * 写坏了 DSH 下次启动凭据服务会激活失败）。所以测试按"宁可拒绝也不写坏"的标准来：
 *
 *   ① 与真实 `.credentials.yaml` 同构的文档：写入后**其余记录逐字节不变**；
 *   ② 文档结构非法（未知顶层键 / 记录键不合规 / version 不对）时**拒绝写入**并保持原文件；
 *   ③ 序列化结果用同一个 YAML 实现回读，且必须与内存文档全等；
 *   ④ 写入前留下 .bak 备份；
 *   ⑤ 插件读的正是这个记录：用 credential.mjs 的 loadPassword 跑一遍端到端；
 *   ⑥ 没有 js-yaml 时如实报告 unsupported，而不是硬写。
 *
 * **两条路都要自洽**（血泪教训）：
 *   · 借到 js-yaml → 跑完 ①~⑥ 的完整验证（CI 上 npm install 装了 devDependency，走这条）；
 *   · 借不到 → ①~⑥ 里大多数断言没法做，此时**只验证安全兜底**（拒绝写入、文件不动），
 *     并明确打印"跳过了什么"。早期版本在借不到时直接崩在断言里（`describeRecord` 返回
 *     undefined → TypeError），表现成 0.0 秒失败，非常难查。
 *
 * 用法：node test/credential-bridge-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describeYamlSource, loadYamlForTest } from './helpers/yaml-for-test.mjs'
import { pluginDir } from './helpers/paths.mjs'

const failures = []
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(`${label} ${detail}`)
    console.log(`  FAIL  ${label} ${detail}`)
  }
}

const lib = (file) => pathToFileURL(path.join(pluginDir, 'lib', file)).href
const { createCredentialBridge, CREDENTIAL_RECORD } = await import(lib('credential-store.mjs'))

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nsb-bridge-'))
const dshHome = path.join(sandbox, '.dsh')
const credentialsFile = path.join(dshHome, '.credentials.yaml')
fs.mkdirSync(dshHome, { recursive: true })

/** 与真实文件同构的初始文档（值是我造的假值，结构一致）。 */
const initialDocument = {
  version: 1,
  records: {
    'client-connection/browser-session': { kind: 'grant', payload: { version: 1, secret: 'fake-secret-value-AAAAAAAAAAAAAAAAAAAAAAAA' } },
    'deepseek-account-platform/device': { kind: 'grant', payload: { id: '00000000-1111-2222-3333-444444444444' } },
    'deepseek-account-platform/default': { kind: 'grant', payload: { version: 1, token: 'ZmFrZS10b2tlbi12YWx1ZQ==', issuer: 'https://platform.deepseek.com' } },
  },
}

// js-yaml 按可移植顺序查找：插件自己的 devDependency → 本机 DSH profile → 系统全局。
// 找不到**不假装通过**，而是收窄验证范围并说明原因。
const yamlFound = loadYamlForTest()
const YAML = yamlFound?.module
console.log(`  ${describeYamlSource(yamlFound)}`)
const profileDirForTest = path.join(os.tmpdir(), `nsb-profile-${process.pid}`)
fs.mkdirSync(profileDirForTest, { recursive: true })
const initialText = YAML === undefined
  ? JSON.stringify(initialDocument)
  : YAML.dump(initialDocument, { lineWidth: 120, sortKeys: false })
fs.writeFileSync(credentialsFile, initialText, { mode: 0o600 })

/** ①~⑥ 的完整验证：需要能自己读回 YAML。 */
async function verifyFullBridge() {
  const bridge = createCredentialBridge({ file: credentialsFile, profileDir: profileDirForTest })

  console.log('\n[1] 桥可构造，且识别出记录地址与文件')
  check('桥可用（借到了 js-yaml）', bridge.unsupported !== true, String(bridge.reason ?? ''))
  check('文件路径正确', bridge.file === credentialsFile, String(bridge.file))
  check('记录地址与插件一致', CREDENTIAL_RECORD === 'nutstore-backup/app-password', CREDENTIAL_RECORD)
  check('初始状态未配置', (await bridge.describeRecord(CREDENTIAL_RECORD)).configured === false)

  console.log('\n[2] 写入我们的记录，且不动别人的记录')
  await bridge.modifyRecord(CREDENTIAL_RECORD, async () => ({
    kind: 'grant',
    payload: { version: 1, password: 'fake-app-password-XYZ', updatedAt: new Date().toISOString() },
  }))
  const afterWrite = YAML.load(fs.readFileSync(credentialsFile, 'utf8'))
  check('我们的记录写进去了', afterWrite.records[CREDENTIAL_RECORD]?.payload?.password === 'fake-app-password-XYZ')
  for (const key of Object.keys(initialDocument.records)) {
    check(`原有记录 ${key} 逐项不变`, JSON.stringify(afterWrite.records[key]) === JSON.stringify(initialDocument.records[key]), JSON.stringify(afterWrite.records[key]))
  }
  check('顶层只有 version 与 records', JSON.stringify(Object.keys(afterWrite).sort()) === JSON.stringify(['records', 'version']), JSON.stringify(Object.keys(afterWrite)))
  check('version 仍是 1', afterWrite.version === 1)
  check('留下了 .bak 备份', fs.readdirSync(dshHome).some(name => name.startsWith('.credentials.yaml.bak-')), fs.readdirSync(dshHome).join(','))
  check('备份内容是写入前的原文', fs.readFileSync(path.join(dshHome, fs.readdirSync(dshHome).find(name => name.startsWith('.credentials.yaml.bak-'))), 'utf8') === initialText)

  console.log('\n[3] 插件的 loadPassword 能端到端读回（同一个记录地址）')
  process.env.DSH_HOME = dshHome
  const credential = await import(lib('credential.mjs'))
  const loaded = await credential.loadPassword({ get: (name) => (name === 'credentials' ? bridge : undefined) })
  check('插件读到的正是刚写的密码', loaded.password === 'fake-app-password-XYZ', JSON.stringify(loaded.password))
  check('来源标注为凭据库', String(loaded.source).includes('凭据库'), String(loaded.source))
  const described = await credential.describePassword({ get: (name) => (name === 'credentials' ? bridge : undefined) })
  check('describePassword 报告已配置', described.configured === true, JSON.stringify(described))

  console.log('\n[4] 结构非法的文档一律拒写')
  const cases = [
    ['未知顶层键', { version: 1, records: {}, extra: true }, /未知顶层键/u],
    ['version 不是 1', { version: 2, records: {} }, /version 必须是 1/u],
    ['记录键不是 <scope>/<id>', { version: 1, records: { 'Bad Key': { kind: 'grant', payload: {} } } }, /不是 <scope>\/<id> 形式/u],
    ['记录 kind 非法', { version: 1, records: { 'nutstore-backup/other': { kind: 'weird', payload: {} } } }, /kind 不是/u],
  ]
  for (const [label, document, pattern] of cases) {
    fs.writeFileSync(credentialsFile, YAML.dump(document, { lineWidth: 120 }), { mode: 0o600 })
    const broken = fs.readFileSync(credentialsFile, 'utf8')
    let error
    try {
      await bridge.modifyRecord(CREDENTIAL_RECORD, async () => ({ kind: 'grant', payload: { version: 1, password: 'x' } }))
    } catch (thrown) {
      error = thrown
    }
    check(`拒写：${label}`, error !== undefined && pattern.test(String(error.message)), String(error?.message ?? '没有报错'))
    check(`拒写后原文件不变：${label}`, fs.readFileSync(credentialsFile, 'utf8') === broken)
  }

  console.log('\n[5] 删除记录：只删我们的，别的保留')
  fs.writeFileSync(credentialsFile, YAML.dump(initialDocument, { lineWidth: 120 }), { mode: 0o600 })
  await bridge.modifyRecord(CREDENTIAL_RECORD, async () => ({ kind: 'grant', payload: { version: 1, password: 'again' } }))
  await bridge.deleteRecord(CREDENTIAL_RECORD)
  const afterDelete = YAML.load(fs.readFileSync(credentialsFile, 'utf8'))
  check('已删除', afterDelete.records[CREDENTIAL_RECORD] === undefined)
  check('其余记录仍在', Object.keys(initialDocument.records).every(key => afterDelete.records[key] !== undefined), Object.keys(afterDelete.records).join(','))
  await bridge.deleteRecord(CREDENTIAL_RECORD)
  check('重复删除是 no-op（不报错）', true)

  console.log('\n[6] 空文件 / 不存在的文件也能安全开始')
  fs.writeFileSync(credentialsFile, '', { mode: 0o600 })
  await bridge.modifyRecord(CREDENTIAL_RECORD, async () => ({ kind: 'grant', payload: { version: 1, password: 'from-empty' } }))
  const afterEmpty = YAML.load(fs.readFileSync(credentialsFile, 'utf8'))
  check('从空文件写出合法文档', afterEmpty.version === 1 && afterEmpty.records[CREDENTIAL_RECORD].payload.password === 'from-empty', JSON.stringify(afterEmpty))
  fs.rmSync(credentialsFile)
  await bridge.modifyRecord(CREDENTIAL_RECORD, async () => ({ kind: 'grant', payload: { version: 1, password: 'from-missing' } }))
  check('文件不存在时能创建', YAML.load(fs.readFileSync(credentialsFile, 'utf8')).records[CREDENTIAL_RECORD].payload.password === 'from-missing')

  console.log('\n[7] 借不到 js-yaml 时如实报告 unsupported（不硬写）')
  {
    // 用一个"不可能存在 profiles/node_modules 的目录"当锚点，制造借不到 js-yaml 的场景。
    const hostileProfile = path.join(sandbox, 'no-such-profile')
    const bridgeWithoutYaml = createCredentialBridge({ file: credentialsFile, profileDir: hostileProfile, homeFallback: false })
    // 本机确实有 js-yaml 时锚点回退会找到它，这时不适用本条；两种结果都必须"可解释"。
    if (bridgeWithoutYaml.unsupported === true) {
      check('报告 unsupported 且给出原因', String(bridgeWithoutYaml.reason).includes('js-yaml'), String(bridgeWithoutYaml.reason))
      let error
      try {
        await bridgeWithoutYaml.modifyRecord(CREDENTIAL_RECORD, async () => ({ kind: 'grant', payload: { version: 1, password: 'x' } }))
      } catch (thrown) {
        error = thrown
      }
      check('unsupported 时写操作明确失败（没有静默成功）', error !== undefined, String(error?.message ?? '没有报错'))
    } else {
      check('本机有 js-yaml 可用，锚点回退生效（可解释）', true)
      await bridgeWithoutYaml.modifyRecord(CREDENTIAL_RECORD, async () => ({ kind: 'grant', payload: { version: 1, password: 'via-fallback' } }))
      check('回退路径写出的内容可读回', YAML.load(fs.readFileSync(credentialsFile, 'utf8')).records[CREDENTIAL_RECORD].payload.password === 'via-fallback')
    }
  }
}

/** 借不到 js-yaml 时的收窄验证：桥必须**拒绝写入**，而不是写坏用户的凭据文件。 */
async function verifyRefusalWithoutYaml() {
  console.log('\n[1~6 跳过] 借不到 js-yaml，无法读写验证这些断言——不假装通过')
  console.log('  补齐覆盖的办法：在插件目录跑一次 `npm install`（devDependencies 里有 js-yaml）')

  console.log('\n[安全兜底] unsupported 的桥必须明确拒绝写入，且不动原文件')
  const beforeText = fs.readFileSync(credentialsFile, 'utf8')
  const bridge = createCredentialBridge({ file: credentialsFile, profileDir: profileDirForTest })
  check('如实报告 unsupported', bridge.unsupported === true, String(bridge.reason ?? '(没有 unsupported 标记)'))
  check('原因里说明是缺 js-yaml', String(bridge.reason ?? '').includes('js-yaml'), String(bridge.reason ?? ''))
  let error
  try {
    await bridge.modifyRecord(CREDENTIAL_RECORD, async () => ({ kind: 'grant', payload: { version: 1, password: 'should-not-be-written' } }))
  } catch (thrown) {
    error = thrown
  }
  check('写操作明确失败（没有静默成功）', error !== undefined, String(error?.message ?? '没有报错'))
  check('原文件一个字节都没变', fs.readFileSync(credentialsFile, 'utf8') === beforeText)
  check('没有留下明文回退文件', !fs.existsSync(path.join(dshHome, 'nutstore-backup', 'secret.json')), '')
}

if (YAML === undefined) {
  await verifyRefusalWithoutYaml()
} else {
  await verifyFullBridge()
}

fs.rmSync(sandbox, { recursive: true, force: true })

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} 项失败：`)
  for (const failure of failures) console.log(`   - ${failure}`)
  process.exitCode = 1
} else {
  console.log('\n✅ 全部通过')
}
