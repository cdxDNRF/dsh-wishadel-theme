import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

const assets = {
  sidebar: 'assets/sidebar-w.jpg',
  conversation: 'assets/conversation-w.jpg',
  chibi: 'assets/wishadel-chibi-256.png',
  board: 'assets/wishadel-board-800.png',
  git: 'assets/wishadel-git-384.png',
  boardOverlay: 'assets/wishadel-board-overlay.jpg',
  gitOverlay: 'assets/wishadel-git-overlay.jpg',
  treeBg: 'assets/wishadel-tree-bg.jpg',
}

const mime = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

const encoded = {}
for (const [name, relativePath] of Object.entries(assets)) {
  const bytes = await readFile(resolve(root, relativePath))
  const mediaType = mime[extname(relativePath).toLowerCase()]
  if (!mediaType) throw new Error(`unsupported asset type: ${relativePath}`)
  encoded[name] = `data:${mediaType};base64,${bytes.toString('base64')}`
}

/**
 * Client sources, concatenated in order inside ONE factory scope:
 * every file sees the same module-level bindings, so cross-file references
 * work without imports. `src/client/runtime.js` stays the entry that exports
 * `apply` (it is the last file).
 */
const clientParts = [
  'src/client/theme-core.js',
  'src/client/skin-registry.js',
  'src/client/workbench-registry.js',
  'src/client/api.js',
  'src/client/flow-watch.js',
  'src/client/settings-card.js',
  'src/client/taskboard.js',
  'src/client/sidebar-pin.js',
  'src/client/sidebar-nav.js',
  'src/client/session-files.js',
  'src/client/gitgraph.js',
  'src/client/panel.js',
  'src/client/scroll-dock.js',
  'src/client/composer-watch.js',
  'src/client/conversation-tools.js',
  'src/client/workspace-flow.js',
  'src/client/runtime.js',
]

const clientStyles = [
  'src/theme.css',
  'src/client.css',
]

/**
 * Host sources, concatenated in order into ONE ESM module: the first part
 * carries the import lines, the last part carries `export function apply`.
 */
const hostParts = [
  'src/host/imports.js',
  'src/host/store.js',
  'src/host/settings.js',
  'src/host/pinned.js',
  'src/host/session-files.js',
  'src/host/fs-service.js',
  'src/host/git-service.js',
  'src/host/folder-picker.js',
  'src/host/tasks.js',
  'src/host/terminal-service.js',
  'src/host/routes.js',
  'src/host/apply.js',
]

async function readPart(path) {
  const text = await readFile(resolve(root, path), 'utf8')
  return text.replace(/\s+$/, '')
}

const css = (await Promise.all(clientStyles.map(readPart))).join('\n')

const clientBody = []
for (const part of clientParts) {
  clientBody.push(`//#region ${part}`)
  clientBody.push(await readPart(part))
  clientBody.push(`//#endregion ${part}`)
}

const hostBody = []
for (const part of hostParts) {
  hostBody.push(`//#region ${part}`)
  hostBody.push(await readPart(part))
  hostBody.push(`//#endregion ${part}`)
}

await mkdir(resolve(root, 'lib'), { recursive: true })

// 客户端工厂整体兜底：factory 抛错会让 dsh 客户端加载器把整个 UI 打成
// "Failed to load plugins"（历史对话无法加载）。任何主题侧异常都降级为
// 空插件，让官方界面继续可用。
const client = `window.__ModuleLoader__.load({
  id: "@cdxdnrf/dsh-client-ui-skin-wishadel",
  factory: (require) => {
    const module = { exports: {} };
    try {
      const React = require("react");
      const ReactDOM = require("react-dom");
      const WISHADEL_ASSETS = ${JSON.stringify(encoded)};
      const WISHADEL_CSS = ${JSON.stringify(css)};
${clientBody.map((line) => line ? `    ${line}` : '').join('\n')}
    } catch (error) {
      console.error("[wishadel] 主题客户端加载失败，已降级为空插件（官方界面与历史对话不受影响）。请运行 pnpm run build 重建后刷新页面。", error);
      module.exports.apply = () => {};
      module.exports.inject = [];
    }
    return module.exports;
  },
});
`

// 宿主端守卫包装：真实模块放进 lib/host.impl.js，lib/index.js 用顶层 await
// 动态导入并逐项转发。impl 导入失败（语法错误/依赖缺失）或 apply 抛错时，
// 只放弃 wishadel 功能并打印诊断，dsh 服务器继续启动。
const host = `// 本文件由 scripts/build.mjs 生成：wishadel 宿主守卫包装。
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
`

const hostImpl = `${hostBody.join('\n\n')}\n`

await writeFile(resolve(root, 'lib/client.js'), client)
await writeFile(resolve(root, 'lib/index.js'), host)
await writeFile(resolve(root, 'lib/host.impl.js'), hostImpl)

console.log(`built lib/client.js (${Buffer.byteLength(client)} bytes)`)
console.log(`built lib/index.js guard wrapper (${Buffer.byteLength(host)} bytes)`)
console.log(`built lib/host.impl.js (${Buffer.byteLength(hostImpl)} bytes)`)
