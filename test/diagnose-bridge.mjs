/**
 * 诊断：在"临时 DSH_HOME、只有真实 profile 里有 js-yaml"的条件下，
 * 凭据桥是否还能借到 js-yaml（这是新机器/试装场景的真实情况）。
 *
 * 用法：node test/diagnose-bridge.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { pluginDir } from './helpers/paths.mjs'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nsb-dbg-bridge-'))
process.env.DSH_HOME = sandbox
process.env.DSH_PROFILE = 'desktop'
process.env.DSH_PROFILE_DIR = path.join(sandbox, 'profiles', 'desktop')

const lib = (file) => pathToFileURL(path.join(pluginDir, 'lib', file)).href
const config = await import(lib('config.mjs'))
const { createCredentialBridge } = await import(lib('credential-store.mjs'))

console.log('DSH_HOME        =', process.env.DSH_HOME)
console.log('DSH_PROFILE_DIR =', process.env.DSH_PROFILE_DIR)
console.log('临时 profile 里有 js-yaml？ =', fs.existsSync(path.join(process.env.DSH_PROFILE_DIR, 'node_modules', 'js-yaml')))

const saved = config.saveConfig({ account: 'probe@example.com', server: 'https://dav.jianguoyun.com/dav' })
console.log('account 已保存 =', JSON.stringify(saved.account))

const bridge = createCredentialBridge({ profileDir: process.env.DSH_PROFILE_DIR })
console.log('bridge.unsupported =', bridge.unsupported, bridge.reason ?? '(可用)')
console.log('bridge.file        =', bridge.file)

fs.rmSync(sandbox, { recursive: true, force: true })
