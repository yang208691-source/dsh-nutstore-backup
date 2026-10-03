/**
 * 凭据桥：让**独立验证服务器**（没有宿主 ctx）也能把应用密码写进 DSH 的凭据库。
 *
 * 为什么要这个：DSH 的客户端半区要重启才加载，而登录这件事不该被重启挡住。
 * 这里按 dsh-credentials-local 的真实文档格式（`version: 1` + `records:`
 * + `<scope>/<id>` 的 grant 记录）写入同一个文件、同一个记录地址，
 * 所以插件重启后 `describeRecord('nutstore-backup/app-password')` 直接就是"已登录"。
 *
 * 安全前提（这个文件是用户真实凭据，写坏会让 DSH 下次启动时凭据服务激活失败）：
 *  ① 只改一个键，其余内容从原文件读进来原样保留；
 *  ② 序列化后**用同一个 YAML 实现严格回读**，结构与原文件逐项比对，不一致就拒写；
 *  ③ 写前把原文件备份成 `.credentials.yaml.bak-<时间戳>`；
 *  ④ 全程原子写（临时文件 + rename），失败不动原文件；
 *  ⑤ 文件权限 0600（Windows 上权限位语义弱，但仍按 0600 创建）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

/** 插件读的那个记录地址；scope 必须是插件自身名字的小写连字符形式。 */
export const CREDENTIAL_RECORD = 'nutstore-backup/app-password'

/** 从 profile 里借 js-yaml（DSH 自己就用它解析凭据文件，保证格式一致）。 */
function loadYaml(profileDir, homeFallback = true) {
  for (const anchor of yamlAnchors(profileDir, homeFallback)) {
    try {
      const require = createRequire(anchor)
      const module = require('js-yaml')
      if (typeof module?.load === 'function' && typeof module?.dump === 'function') return module
    } catch {
      // 这个锚点没有，换下一个。
    }
  }
  return undefined
}

/**
 * js-yaml 的候选锚点。
 *
 * 为什么不能只用 profile 锚点：这个插件常常跑在**临时 DSH_HOME**（验证、测试、试装）里，
 * 那种 profile 目录下没有 js-yaml；而解析凭据文件又**必须**用与 DSH 同源的 YAML 实现，
 * 所以按"本 profile → 本 DSH_HOME 的各个 profile → 用户常规 ~/.dsh 的各个 profile"依次找。
 */
function yamlAnchors(profileDir, homeFallback = true) {
  const anchors = [
    path.join(profileDir, 'noop.js'),
    path.join(profileDir, 'package.json'),
  ]
  const homes = []
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') homes.push(path.resolve(configured.trim()))
  const conventional = path.join(os.homedir(), '.dsh')
  if (homeFallback && !homes.some(home => home.toLowerCase() === conventional.toLowerCase())) homes.push(conventional)
  for (const home of homes) {
    anchors.push(path.join(home, 'package.json'))
    const profiles = path.join(home, 'profiles')
    try {
      for (const entry of fs.readdirSync(profiles, { withFileTypes: true })) {
        if (entry.isDirectory()) anchors.push(path.join(profiles, entry.name, 'package.json'))
      }
    } catch {
      // 读不到 profiles 目录就算了。
    }
  }
  return anchors
}

/** 严格结构校验：必须是 version:1 + records: 映射。 */
function assertDocumentShape(document, where) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`${where} 不是一个映射（YAML mapping）`)
  }
  if (document.version !== 1) throw new Error(`${where} 的 version 必须是 1，实际是 ${JSON.stringify(document.version)}`)
  for (const key of Object.keys(document)) {
    if (key !== 'version' && key !== 'records' && key !== 'refs') {
      throw new Error(`${where} 里有未知顶层键 ${JSON.stringify(key)}；为安全起见不写入`)
    }
  }
  if (document.records !== undefined && (document.records === null || typeof document.records !== 'object' || Array.isArray(document.records))) {
    throw new Error(`${where} 的 records 不是映射`)
  }
  for (const [key, value] of Object.entries(document.records ?? {})) {
    const segments = String(key).split('/')
    if (segments.length !== 2 || segments.some(segment => !/^[a-z][a-z0-9-]*$/u.test(segment))) {
      throw new Error(`${where} 里的记录键 ${JSON.stringify(key)} 不是 <scope>/<id> 形式；为安全起见不写入`)
    }
    if (value === null || typeof value !== 'object') throw new Error(`${where} 里记录 ${key} 不是映射`)
    if (value.kind !== 'grant' && value.kind !== 'api-key') throw new Error(`${where} 里记录 ${key} 的 kind 不是 grant/api-key`)
  }
}

/**
 * 造一个"只实现插件用到的那几个方法"的凭据服务。
 * @param options.file 凭据文件路径（默认 $DSH_HOME/.credentials.yaml）
 * @param options.profileDir 用于借 js-yaml 的 profile 目录
 * @returns 服务对象。若 js-yaml 不可用则返回带 `unsupported` 说明的对象（调用方据此回退明文文件）。
 */
export function createCredentialBridge(options = {}) {
  const file = options.file ?? path.join(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '.', '.dsh'), '.credentials.yaml')
  const profileDir = options.profileDir ?? path.dirname(file)
  const yaml = loadYaml(profileDir, options.homeFallback !== false)
  if (yaml === undefined) {
    return {
      unsupported: true,
      reason: `借不到 js-yaml（找的是 ${profileDir}/package.json 的解析路径），为避免写坏凭据文件而不写入凭据库`,
    }
  }

  /** 读原文件（不存在就当作空文档）。任何结构问题都在这里暴露。 */
  function readDocument() {
    if (!fs.existsSync(file)) return { version: 1, records: {} }
    const text = fs.readFileSync(file, 'utf8')
    if (text.trim() === '') return { version: 1, records: {} }
    const parsed = yaml.load(text)
    assertDocumentShape(parsed, file)
    return parsed
  }

  /** 序列化 → 严格回读 → 与原文档比对；写盘并留备份。 */
  function writeDocument(next, previousText) {
    const text = yaml.dump(next, { lineWidth: 120, noRefs: true, sortKeys: false })
    const reparsed = yaml.load(text)
    assertDocumentShape(reparsed, `${file}（刚序列化的内容）`)
    if (JSON.stringify(reparsed) !== JSON.stringify(next)) {
      throw new Error('序列化后的凭据文档回读结果与原文档不一致；已放弃写入')
    }
    const directory = path.dirname(file)
    fs.mkdirSync(directory, { recursive: true })
    const backup = previousText === undefined ? undefined : `${file}.bak-${Date.now()}`
    if (backup !== undefined) fs.writeFileSync(backup, previousText, { encoding: 'utf8', mode: 0o600 })
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, file)
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      // Windows 上 chmod 语义有限，失败不影响正确性。
    }
    // 写后从磁盘回读再核对一次：这是对"序列化器与我理解的一致"的最终背书。
    // 一旦对不上，立刻还原（有备份用备份，没有就把刚建的文件删掉），宁可这次登录失败。
    try {
      const onDisk = yaml.load(fs.readFileSync(file, 'utf8'))
      assertDocumentShape(onDisk, `${file}（写后回读）`)
      if (JSON.stringify(onDisk) !== JSON.stringify(next)) throw new Error('写后回读的凭据文档与预期不一致')
    } catch (error) {
      try {
        if (backup !== undefined) fs.copyFileSync(backup, file)
        else fs.rmSync(file, { force: true })
      } catch {
        // 还原失败也要把原始错误抛出去，不能静默。
      }
      throw new Error(`凭据文件写入后校验失败，已尝试还原：${error instanceof Error ? error.message : String(error)}`)
    }
    return text
  }

  return {
    unsupported: false,
    file,
    async readRecord(key) {
      return readDocument().records?.[key]
    },
    async describeRecord(key) {
      const record = readDocument().records?.[key]
      return record === undefined ? { configured: false, writable: true } : { configured: true, kind: record.kind, writable: true }
    },
    async listRecords() {
      return Object.entries(readDocument().records ?? {}).map(([key, record]) => ({ key, kind: record.kind }))
    },
    async modifyRecord(key, mutate) {
      const previousText = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined
      const document = readDocument()
      const current = document.records?.[key]
      const next = await mutate(current)
      if (next === undefined) return current
      const records = { ...(document.records ?? {}), [key]: next }
      writeDocument({ ...document, records }, previousText)
      return next
    },
    async deleteRecord(key) {
      const previousText = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined
      const document = readDocument()
      if (document.records?.[key] === undefined) return
      const records = { ...document.records }
      delete records[key]
      writeDocument({ ...document, records }, previousText)
    },
    /** 桥里没有"引用层"；环境变量那层由插件自己按进程环境解析。 */
    async resolve() {
      return undefined
    },
  }
}
