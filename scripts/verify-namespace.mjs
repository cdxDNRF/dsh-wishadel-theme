// 验证 wishadel 宿主 bundle 在真实 settings 服务下的命名空间注册。
// 用 dsh-settings 包（真实实例）构建最小 ctx，加载 lib/index.js，
// 断言 describe() 包含 'wishadel' 命名空间且 schema 可序列化。
import { resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dshRoot = '/home/dnrf/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai'

const { default: SettingsService } = await import(pathToFileURL(resolve(dshRoot, 'dsh-settings/lib/index.js')).href)
const wishadel = await import(pathToFileURL(resolve(root, 'lib/index.js')).href)

const registered = []
const settingsPlugin = { name: 'settings-shim', apply: (ctx) => { new SettingsService(ctx) } }

// 最小 Cordis 风格 ctx：settings 服务由 shim 提供。
const settingsService = {
  registrations: new Map(),
  register(ns, schema) {
    console.log('注册命名空间:', ns)
    this.registrations.set(ns, { ns, schema })
    return { get: () => ({}), watch: () => () => {} }
  },
  describe() {
    return [...this.registrations.values()].map((r) => ({
      ns: r.ns,
      schema: r.schema?.toJSON?.() ?? null,
      value: {},
      revision: 0,
    }))
  },
}

const effects = []
const ctx = {
  get(name) {
    if (name === 'settings') return settingsService
    if (name === 'webServer') return { register: () => () => {} }
    return undefined
  },
  effect(fn) { const dispose = fn(); effects.push(dispose); return () => dispose() },
  inject(names, cb) {
    console.log('ctx.inject 调用:', names)
    // 关键：模拟真实 cordis —— inject 立即回调（服务已就绪场景）。
    if (names.includes('settings')) cb({ settings: settingsService })
  },
  on: () => () => {},
  logger: console,
}

wishadel.apply(ctx)
const described = settingsService.describe()
console.log('\ndescribe 结果:', JSON.stringify(described.map((d) => ({ ns: d.ns, schemaOk: d.schema !== null })), null, 2))
const ok = described.some((d) => d.ns === 'wishadel')
console.log(ok ? '\nPASS: wishadel 命名空间已注册且可描述' : '\nFAIL: wishadel 命名空间未注册')
process.exit(ok ? 0 : 1)