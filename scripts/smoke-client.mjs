// 客户端半边加载冒烟测试：在 Node 中用 mock window/React/ctx 执行 lib/client.js 的
// factory 与 apply()，验证插件在页面加载期不会抛错（引用错误、协议错误、hooks 顺序等）。
// 用法：node scripts/smoke-client.mjs
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const source = readFileSync(resolve(root, 'lib/client.js'), 'utf8')

const noop = () => null
const React = {
  createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
  useState(initial) { return [initial, () => {}] },
  useEffect() {},
  useCallback(fn) { return fn },
  useRef(initial) { return { current: initial } },
  useMemo(fn) { return fn() },
  useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
  Fragment: 'fragment',
}

const element = () => ({
  dataset: {},
  style: { setProperty() {}, removeProperty() {} },
  setAttribute() {},
  removeAttribute() {},
  toggleAttribute() {},
  append() {},
  remove() {},
  textContent: '',
})

const document = {
  title: 'test',
  head: { append() {} },
  body: { ...element(), title: '' },
  createElement: (tag) => ({ ...element(), tagName: tag.toUpperCase() }),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
}

const localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
const MutationObserver = class { observe() {} disconnect() {} }
const fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'mock-offline' }) })
const location = { origin: 'http://127.0.0.1:3080' }

const slotInjections = []
const slotsMock = {
  inject(name, register) { slotInjections.push(name); const dispose = register(); return () => dispose() },
  register(_options, _component) { return () => {} },
}

const effects = []
const ctx = {
  get(name) {
    if (name === 'slots') return slotsMock
    if (name === 'sessions') return { fork: async () => 'smoke-child', open() {} }
    return undefined
  },
  effect(fn, label) { effects.push(label); const dispose = fn(); return dispose },
  on: () => () => {},
  provide(name, value) { if (name === 'wishadelWorkbench') globalThis.__wishadelWorkbench = value },
}

globalThis.window = { __ModuleLoader__: { load(entry) {
  try {
    globalThis.__loadedModule = entry.factory((name) => (name === 'react' ? React : undefined))
  } catch (error) {
    globalThis.__factoryError = error
  }
} } }
globalThis.React = React
globalThis.document = document
globalThis.localStorage = localStorage
globalThis.MutationObserver = MutationObserver
globalThis.fetch = fetch
globalThis.location = location

let failures = 0
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures += 1
}

;(0, eval)(source)

if (globalThis.__factoryError) {
  console.log('FACTORY 执行失败:', String(globalThis.__factoryError?.stack ?? globalThis.__factoryError))
  process.exit(1)
}

check('factory 执行', globalThis.__loadedModule && typeof globalThis.__loadedModule.apply === 'function')
check('皮肤注册表暴露', typeof globalThis.window.__dshSkins?.register === 'function')
check('rc.7 设置槽使用 key', globalThis.__loadedModule && source.includes("key: 'wishadel'"))

try {
  globalThis.__loadedModule.apply(ctx)
  check('apply(ctx) 不抛错', true)
  check('工作台服务已发布', typeof globalThis.__wishadelWorkbench?.registerTab === 'function' && typeof globalThis.__wishadelWorkbench?.registerFileViewer === 'function')
} catch (error) {
  check(`apply(ctx) 不抛错（实际: ${String(error?.message ?? error)}）`, false)
}

const expectedSlots = [
  'settings.plugin.item',
  'sidebar.footer.action',
  'shell.overlay',
  'conversation.input.dock',
  'conversation.input.right',
  'conversation.session.header.actions',
]
for (const slot of expectedSlots) {
  check(`注册 slot ${slot}`, slotInjections.includes(slot))
}
check('不抢占官方目录选择槽位', !slotInjections.includes('conversation.hero.workspace.directoryFlow') && !slotInjections.includes('sidebar.workspaces.directoryFlow'))
check('shell.overlay 五个条目', slotInjections.filter((name) => name === 'shell.overlay').length === 5)
check('侧栏入口含添加工作区', slotInjections.filter((name) => name === 'sidebar.footer.action').length === 2)
check('effect 注册数', effects.length >= 6, true)

console.log(failures === 0 ? '\nCLIENT SMOKE ALL PASS' : `\nCLIENT SMOKE FAILURES: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
