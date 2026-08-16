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
  'src/client/api.js',
  'src/client/flow-watch.js',
  'src/client/settings-card.js',
  'src/client/taskboard.js',
  'src/client/gitgraph.js',
  'src/client/panel.js',
  'src/client/composer-watch.js',
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
  'src/host/fs-service.js',
  'src/host/git-service.js',
  'src/host/tasks.js',
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

const client = `window.__ModuleLoader__.load({
  id: "@cdxdnrf/dsh-client-ui-skin-wishadel",
  factory: (require) => {
    const module = { exports: {} };
    const React = require("react");
    const ReactDOM = require("react-dom");
    const WISHADEL_ASSETS = ${JSON.stringify(encoded)};
    const WISHADEL_CSS = ${JSON.stringify(css)};
${clientBody.map((line) => line ? `    ${line}` : '').join('\n')}
    return module.exports;
  },
});
`

const host = `${hostBody.join('\n\n')}\n`

await writeFile(resolve(root, 'lib/client.js'), client)
await writeFile(resolve(root, 'lib/index.js'), host)

console.log(`built lib/client.js (${Buffer.byteLength(client)} bytes)`)
console.log(`built lib/index.js (${Buffer.byteLength(host)} bytes)`)
