/**
 * 诊断：在"和真实宿主一样的环境变量"下，工作区目录到底解析成了什么。
 * 用法：node test/diagnose-workspace.mjs
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const home = process.env.DSH_HOME ?? 'C:\\Users\\yang2\\.dsh'
process.env.DSH_HOME = home
process.env.DSH_PROFILE = process.env.DSH_PROFILE ?? 'desktop'
process.env.DSH_PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? path.join(home, 'profiles', 'desktop')
delete process.env.DSH_SESSION_CWD

const lib = (file) => pathToFileURL(path.join('D:/My Agent/dev/dsh-nutstore-backup/lib', file)).href
const config = await import(lib('config.mjs'))

console.log('DSH_HOME            =', process.env.DSH_HOME)
console.log('DSH_PROFILE_DIR     =', process.env.DSH_PROFILE_DIR)
console.log('DSH_SESSION_CWD     =', process.env.DSH_SESSION_CWD ?? '(未设置)')
console.log('process.cwd()       =', process.cwd())
console.log('resolveWorkspaceDir =', config.resolveWorkspaceDir())
const loaded = config.loadConfig()
console.log('loadConfig().workspaceDir =', JSON.stringify(loaded.workspaceDir))
console.log('profileDir()        =', config.profileDir())
console.log('dshHome()           =', config.dshHome())
