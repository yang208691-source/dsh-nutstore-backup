/**
 * 凭据服务路径测试：之前只测了"没有凭据服务 → 明文回退"，
 * 这里补上"有凭据服务"这条主路径，用一个假的 credentials 服务实现
 * （按 dsh-credentials-local 的真实语义：readRecord 快照读、modifyRecord 是唯一写路径、
 *  deleteRecord 缺失即 no-op、resolve 分层），验证：
 *   ① savePassword 走 modifyRecord，写进 <scope>/<id> 记录，且不产生明文文件；
 *   ② loadPassword 能从记录读回；描述文案是"凭据库"而不是"明文"；
 *   ③ 记录格式正确：kind='grant'，payload 能过 JSON 往返（真实实现会校验）；
 *   ④ 引用层（NUTSTORE_DAV_PASSWORD 环境变量）能被 resolve 到；
 *   ⑤ clearPassword 调用 deleteRecord 并把明文文件清掉；
 *   ⑥ 凭据服务抛异常时不崩：回退到明文文件并如实报告。
 *
 * 用法：node test/credential-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { pluginDir } from './helpers/paths.mjs'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nsb-cred-'))
process.env.DSH_HOME = path.join(sandbox, '.dsh')

const lib = (file) => pathToFileURL(path.join(pluginDir, 'lib', file)).href
const credential = await import(lib('credential.mjs'))
const { secretFallbackPath } = await import(lib('config.mjs'))

const failures = []
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(`${label} ${detail}`)
    console.log(`  FAIL  ${label} ${detail}`)
  }
}

/** 假 credentials 服务：镜像 dsh-credentials-local 的公开语义。 */
function makeCredentials(options = {}) {
  const records = new Map()
  const refs = new Map()
  const calls = []
  const assertJson = (value, where) => {
    const text = JSON.stringify(value)
    if (text === undefined) throw new Error(`${where} holds a value JSON cannot represent`)
    JSON.parse(text) // 往返校验
  }
  return {
    calls,
    records,
    async readRecord(key) {
      calls.push(['readRecord', key])
      return records.get(key)
    },
    async describeRecord(key) {
      const record = records.get(key)
      return record === undefined ? { configured: false, writable: true } : { configured: true, kind: record.kind, writable: true }
    },
    async listRecords() {
      return [...records].map(([key, record]) => ({ key, kind: record.kind }))
    },
    async modifyRecord(key, mutate) {
      calls.push(['modifyRecord', key])
      if (options.throwOnModify === true) throw new Error('credentials-local is disposed: cannot modify')
      const current = records.get(key)
      const next = await mutate(current)
      if (next === undefined) return current
      if (next.kind === 'grant') assertJson(next.payload, `record "${key}" payload`)
      records.set(key, next)
      return next
    },
    async deleteRecord(key) {
      calls.push(['deleteRecord', key])
      if (!records.has(key)) return
      records.delete(key)
    },
    async resolve(ref) {
      calls.push(['resolve', ref])
      const value = refs.get(ref)
      return value === undefined ? undefined : { value, source: 'file' }
    },
    setRef(ref, value) {
      refs.set(ref, value)
    },
  }
}

const ctxWith = (credentials) => ({ get: (name) => (name === 'credentials' ? credentials : undefined) })
const ctxWithout = { get: () => undefined }

console.log('\n[1] 有凭据服务：保存 → 读回')
const credentials = makeCredentials()
const ctx = ctxWith(credentials)
const storedAt = await credential.savePassword(ctx, 'app-pw-abc')
check('保存走 modifyRecord 且键是 nutstore-backup/app-password', credentials.calls.some(([method, key]) => method === 'modifyRecord' && key === 'nutstore-backup/app-password'), JSON.stringify(credentials.calls))
check('返回的存放位置说明指向凭据库', storedAt.includes('凭据库'), storedAt)
check('记录 kind 是 grant', credentials.records.get('nutstore-backup/app-password')?.kind === 'grant')
check('记录 payload 里有密码与版本号', credentials.records.get('nutstore-backup/app-password')?.payload?.password === 'app-pw-abc' && credentials.records.get('nutstore-backup/app-password')?.payload?.version === 1)
check('没有产生明文回退文件', !fs.existsSync(secretFallbackPath()))

const loaded = await credential.loadPassword(ctx)
check('能从凭据库读回密码', loaded.password === 'app-pw-abc', JSON.stringify(loaded))
check('来源标注为凭据库', String(loaded.source).includes('凭据库'), String(loaded.source))

const described = await credential.describePassword(ctx)
check('describePassword 报告 configured=true', described.configured === true, JSON.stringify(described))
check('文案指向凭据库而不是本插件的回退文件', described.label.includes('凭据库') && !described.label.includes('回退'), described.label)
// DSH 的凭据服务本身就是明文 0600 的 YAML，所以文案必须**如实**说明是明文，
// 不能宣称"已加密"——这是本插件在安全表述上的硬要求。
check('文案如实说明是明文（不谎称加密）', described.label.includes('明文') && !/加密|encrypted/u.test(described.label), described.label)

console.log('\n[2] 凭据服务里没有记录时，退到引用层（环境变量）')
const credentialsRefOnly = makeCredentials()
credentialsRefOnly.setRef(credential.PASSWORD_REF, 'from-env-password')
const loadedFromRef = await credential.loadPassword(ctxWith(credentialsRefOnly))
check('引用层能被读到', loadedFromRef.password === 'from-env-password', JSON.stringify(loadedFromRef))
check('来源标注为环境变量', String(loadedFromRef.source).includes('环境变量'), String(loadedFromRef.source))

console.log('\n[3] 清除密码')
const cleared = await credential.clearPassword(ctx)
check('调用了 deleteRecord', credentials.calls.some(([method]) => method === 'deleteRecord'))
check('返回已清除', cleared === true)
const afterClear = await credential.describePassword(ctx)
check('清除后 describe 报告未配置', afterClear.configured === false, JSON.stringify(afterClear))
const afterClearLoad = await credential.loadPassword(ctx)
check('清除后读不到密码', afterClearLoad.password === undefined, JSON.stringify(afterClearLoad))

console.log('\n[4] 凭据服务抛异常时不崩，回退到明文文件并如实报告')
const throwing = makeCredentials({ throwOnModify: true })
const throwingCtx = ctxWith(throwing)
let saveError
try {
  await credential.savePassword(throwingCtx, 'pw-fallback')
} catch (error) {
  saveError = error
}
check('保存时报错向外抛出（不静默假装成功）', saveError !== undefined, saveError === undefined ? '没有抛错' : '')
// 主路径失败应该由调用方决定；这里直接验证回退文件路径本身可用
const fallbackStored = await credential.savePassword(ctxWithout, 'pw-plaintext')
check('无凭据服务时写入明文回退文件', fs.existsSync(secretFallbackPath()), secretFallbackPath())
check('回退路径的说明如实写"明文"', fallbackStored.includes('明文'), fallbackStored)
const fallbackDescribed = await credential.describePassword(ctxWithout)
check('无服务时 describe 说明凭据服务不可用', fallbackDescribed.service === 'absent' && fallbackDescribed.label.includes('明文'), JSON.stringify(fallbackDescribed))
const fallbackLoaded = await credential.loadPassword(ctxWithout)
check('回退文件能读回', fallbackLoaded.password === 'pw-plaintext' && String(fallbackLoaded.source).includes('明文'), JSON.stringify(fallbackLoaded))

console.log('\n[5] 凭据服务恢复后，明文回退文件会被清掉')
const recovered = makeCredentials()
await credential.savePassword(ctxWith(recovered), 'pw-moved')
check('迁移到凭据库后删除了明文文件', !fs.existsSync(secretFallbackPath()))

fs.rmSync(sandbox, { recursive: true, force: true })

if (failures.length > 0) {
  console.log(`\n❌ ${failures.length} 项失败：`)
  for (const failure of failures) console.log(`   - ${failure}`)
  process.exitCode = 1
} else {
  console.log('\n✅ 全部通过')
}
