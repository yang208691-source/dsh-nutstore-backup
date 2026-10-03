/**
 * 诊断：恢复时"映射不回本机路径"到底卡在哪一步。
 *
 * 关键怀疑点：宿主进程里 `DSH_HOME` 可能没有值（桌面壳的环境变量未必注入），
 * 而 restoreTarget() 依赖它来算本地根目录。这里把两种情况都打出来。
 *
 * 用法：node test/diagnose-restore-env.mjs
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const module = await import(pathToFileURL('D:/My Agent/dev/dsh-nutstore-backup/lib/backup.mjs').href)
const config = { workspaceDir: 'D:\\My Agent' }
const nested = 'sessions/--D-My~0020Agent--/03e6043f-e974-4e4f-b706-9b24dd0a6456/session.v4.jsonl.zstd'
const flat = 'profile/cordis.patch.yml'

console.log('相对路径：', nested)
console.log('')

console.log('A) DSH_HOME 有值（C:\\Users\\yang2\\.dsh）')
process.env.DSH_HOME = 'C:\\Users\\yang2\\.dsh'
console.log('   会话     →', module.restoreTarget(nested, config))
console.log('   配置     →', module.restoreTarget(flat, config))

console.log('')
console.log('B) DSH_HOME 缺失（模拟宿主进程环境）')
delete process.env.DSH_HOME
console.log('   会话     →', module.restoreTarget(nested, config))
console.log('   配置     →', module.restoreTarget(flat, config))

console.log('')
console.log('C) DSH_HOME 缺失 + 只有 USERPROFILE')
if (process.env.USERPROFILE !== undefined) {
  console.log('   USERPROFILE =', process.env.USERPROFILE)
  console.log('   会话     →', module.restoreTarget(nested, config))
}

console.log('')
console.log('结论：')
console.log('  如果 A 能映射、B 不能，那 50 个失败就是"宿主里 DSH_HOME 缺失"造成的，')
console.log('  与路径深度无关——这正好解释了为什么失败数恰好等于嵌套的会话文件数（50），')
console.log('  而顶层文件在旧代码里也不该受影响（但旧代码同样依赖 DSH_HOME）。')
