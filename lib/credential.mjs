/**
 * 坚果云应用密码的存取。
 *
 * 优先走宿主 credentials 服务（`<scope>/<id>` 记录，落盘 $DSH_HOME/.credentials.yaml，0600）。
 * 服务缺失时退化为配置文件同目录下的 secret.json（同样 0600），并且在状态里如实标注
 * "明文保存"——DSH 的凭据服务本身也是明文 YAML，只是权限收紧，两者差别只在命名与位置，
 * 所以状态文案不能宣称"已加密"。
 */
import fs from 'node:fs'
import { readJson, secretFallbackPath, writeJsonAtomic } from './config.mjs'

/** 本插件在凭据服务里的记录地址；scope 必须是插件自身名字的小写连字符形式。 */
export const CREDENTIAL_SCOPE = 'nutstore-backup'
export const CREDENTIAL_ID = 'app-password'
export const CREDENTIAL_RECORD = `${CREDENTIAL_SCOPE}/${CREDENTIAL_ID}`

/** 供配置字段引用的环境变量名：可以用 NUTSTORE_DAV_PASSWORD 直接给，跳过设置页。 */
export const PASSWORD_REF = 'NUTSTORE_DAV_PASSWORD'

/**
 * 读取应用密码。
 * @param ctx 宿主上下文（用 ctx.get 取可选服务）
 * @returns { password, source } 或 { password: undefined, source: 'none' }
 */
export async function loadPassword(ctx) {
  const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined

  if (credentials !== undefined) {
    try {
      // 记录：本插件自己的不透明机密，用 grant 承载。
      const record = await credentials.readRecord(CREDENTIAL_RECORD)
      if (record !== undefined && record.kind === 'grant') {
        const payload = record.payload
        if (payload !== null && typeof payload === 'object' && typeof payload.password === 'string' && payload.password !== '') {
          return { password: payload.password, source: `凭据库（${CREDENTIAL_RECORD}）` }
        }
      }
    } catch {
      // 记录读不到就继续往下试引用层与文件层。
    }
    try {
      // 引用层：允许用环境变量 / .env 里的 NUTSTORE_DAV_PASSWORD 覆盖。
      const resolved = await credentials.resolve(PASSWORD_REF)
      if (resolved !== undefined && resolved.value !== '') {
        return { password: resolved.value, source: `环境变量 ${PASSWORD_REF}（${resolved.source}）` }
      }
    } catch {
      // 忽略：引用层只是可选的便利通道。
    }
  }

  const fallback = readJson(secretFallbackPath())
  if (fallback !== undefined && typeof fallback.password === 'string' && fallback.password !== '') {
    return { password: fallback.password, source: '本地文件（明文，凭据服务不可用时的回退）' }
  }
  return { password: undefined, source: 'none' }
}

/**
 * 写入应用密码。
 * @returns 实际使用的存放位置描述
 */
export async function savePassword(ctx, password) {
  if (typeof password !== 'string' || password === '') throw new Error('应用密码不能为空')
  const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined
  if (credentials !== undefined) {
    await credentials.modifyRecord(CREDENTIAL_RECORD, async () => ({
      kind: 'grant',
      payload: { version: 1, password, updatedAt: new Date().toISOString() },
    }))
    // 如果之前退化成过明文文件，凭据服务一可用就把它清掉。
    try {
      if (fs.existsSync(secretFallbackPath())) fs.rmSync(secretFallbackPath(), { force: true })
    } catch {
      // 删不掉不影响主路径。
    }
    return `凭据库（${CREDENTIAL_RECORD}）`
  }
  writeJsonAtomic(secretFallbackPath(), { version: 1, password, updatedAt: new Date().toISOString() })
  return '本地文件（明文，请确认 DSH_HOME 目录权限）'
}

/** 删除已保存的应用密码。 */
export async function clearPassword(ctx) {
  const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined
  let cleared = false
  if (credentials !== undefined) {
    try {
      await credentials.deleteRecord(CREDENTIAL_RECORD)
      cleared = true
    } catch {
      // 没有记录也算清掉了。
      cleared = true
    }
  }
  try {
    if (fs.existsSync(secretFallbackPath())) {
      fs.rmSync(secretFallbackPath(), { force: true })
      cleared = true
    }
  } catch {
    // 忽略。
  }
  return cleared
}

/** 密码存放位置的一句话说明，用于设置页展示。 */
export async function describePassword(ctx) {
  const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined
  if (credentials === undefined) {
    return { service: 'absent', label: '凭据服务不可用，密码保存在本地明文文件（0600）' }
  }
  try {
    const info = await credentials.describeRecord(CREDENTIAL_RECORD)
    return {
      service: 'available',
      configured: info.configured === true,
      writable: info.writable !== false,
      label: info.configured === true
        ? `已登录（密码存放在 DSH 凭据库 ${CREDENTIAL_RECORD}，文件为明文 0600，仅当前用户可读）`
        : '未登录：还没有保存应用密码',
    }
  } catch (error) {
    return { service: 'error', label: `凭据服务读取失败：${error instanceof Error ? error.message : String(error)}` }
  }
}
