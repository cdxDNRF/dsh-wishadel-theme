import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

const assets = {
  sidebar: 'assets/sidebar-w.jpg',
  conversation: 'assets/conversation-w.jpg',
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

const css = await readFile(resolve(root, 'src/theme.css'), 'utf8')
const runtime = await readFile(resolve(root, 'src/runtime.js'), 'utf8')
const host = await readFile(resolve(root, 'src/host.js'), 'utf8')
await mkdir(resolve(root, 'lib'), { recursive: true })

const client = `window.__ModuleLoader__.load({
  id: "@cdxdnrf/dsh-client-ui-skin-wishadel",
  factory: () => {
    const module = { exports: {} };
    const WISHADEL_ASSETS = ${JSON.stringify(encoded)};
    const WISHADEL_CSS = ${JSON.stringify(css)};
${runtime.split('\n').map((line) => line ? `    ${line}` : '').join('\n')}
    return module.exports;
  },
});
`

await writeFile(resolve(root, 'lib/client.js'), client)
await writeFile(resolve(root, 'lib/index.js'), host)

console.log(`built lib/client.js (${Buffer.byteLength(client)} bytes)`)
