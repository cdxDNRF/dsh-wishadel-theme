// 本文件由 scripts/build.mjs 生成：wishadel 宿主守卫包装。
let impl = null
try {
  impl = await import('./host.impl.js')
} catch (error) {
  console.error('[wishadel] 宿主模块加载失败（dsh 继续运行，wishadel 功能不可用。请在 wishadel-theme 目录运行 pnpm run build 修复后重启 dsh）:', error)
}

export const name = impl?.name ?? 'wishadel'
export const inject = impl?.inject ?? ['webServer']
export const folderPickerCapability = impl?.folderPickerCapability
export const winPathToWsl = impl?.winPathToWsl
export const wslPathToWin = impl?.wslPathToWin
export const windowsHomeDir = impl?.windowsHomeDir
export const normalizeDirectoryPath = impl?.normalizeDirectoryPath
export const resolveSelectedDir = impl?.resolveSelectedDir
export const spawnWindowsPicker = impl?.spawnWindowsPicker

export function apply(ctx) {
  if (impl == null || typeof impl.apply !== 'function') return
  try {
    impl.apply(ctx)
  } catch (error) {
    console.error('[wishadel] 宿主 apply 失败（dsh 继续运行，wishadel HTTP 通道可能不可用）:', error)
  }
}
