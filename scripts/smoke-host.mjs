// 宿主半边冒烟测试：用 mock Cordis Context 装载 lib/index.js，
// 捕获注册的 HTTP 路由后直接驱动请求，验证设置/任务/cron/文件/Git 全链路。
// 用法：node scripts/smoke-host.mjs
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const { apply } = await import(pathToFileURL(resolve(root, 'lib/index.js')).href)

const captured = { routes: [], effects: [], intervals: [] }

const ctx = {
  get(name) {
    switch (name) {
      case 'webServer': return { register: (route) => { captured.routes.push(route); return () => {} } }
      case 'agents': return {
        create: async () => { throw new Error('mock: agents.create 未在冒烟测试中使用') },
        get: () => undefined,
        list: () => [],
      }
      case 'sessions': return { get: () => undefined, list: () => [] }
      case 'sessionQuery': return { readSession: async () => ({ events: [] }) }
      case 'agentPresets': return { resolve: async (id) => ({ id: id ?? 'cordis' }), mount: async () => {} }
      case 'agentDefaultModel': return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) }
      case 'sandboxPolicy': return { workspaceRoot: root, resolve: () => ({ mode: 'workspace-write' }) }
      default: return undefined
    }
  },
  effect(fn, label) { captured.effects.push(label); const dispose = fn(); return dispose }
  ,
  setInterval(fn, ms) { captured.intervals.push(ms); return () => {} },
  timer: { interval: (fn, ms) => { captured.intervals.push(ms); return () => {} } },
  logger: { info: () => {}, warn: console.warn, error: console.error },
  on: () => () => {},
}

apply(ctx)
const route = captured.routes.find((item) => item.path === '/wishadel')
if (!route) { console.error('FAIL: 未注册 /wishadel 路由'); process.exit(1) }
console.log('OK: /wishadel 路由已注册;', captured.effects.length, '个 effect;', captured.intervals.length, '个定时器')

function makeReq(method, path, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = path
  req.destroy = () => {}
  if (body !== undefined) {
    req.push = undefined
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
  } else {
    process.nextTick(() => req.emit('end'))
  }
  return req
}

async function call(method, path, body) {
  const req = makeReq(method, path, body)
  const res = {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers) { this.status = status; this.headers = headers ?? {} },
    end(chunk) { this.body = String(chunk ?? ''); this.headersSent = true },
  }
  await route.handler(req, res)
  let parsed = null
  try { parsed = res.body ? JSON.parse(res.body) : null } catch { parsed = res.body }
  return { status: res.status, body: parsed }
}

let failures = 0
async function check(name, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(actual).slice(0, 140)}`)
  if (!ok) failures += 1
}

// 1) 健康检查
let r = await call('GET', '/wishadel/health')
await check('health', { ok: r.body.ok, git: typeof r.body.git }, { ok: true, git: 'boolean' })

// 2) 设置写入 + 读取
r = await call('POST', '/wishadel/settings', { patch: { theme: 'wishadel', gitgraph: { enabled: false } } })
await check('settings 写回', r.body.settings.gitgraph.enabled, false)
r = await call('GET', '/wishadel/settings')
await check('settings 读取', { theme: r.body.settings.theme, gitgraph: r.body.settings.gitgraph.enabled }, { theme: 'wishadel', gitgraph: false })
r = await call('POST', '/wishadel/settings', { patch: { gitgraph: { enabled: true } } })
await check('settings 恢复', r.body.settings.gitgraph.enabled, true)

// 3) 任务 CRUD + cron 预览
r = await call('POST', '/wishadel/tasks', { title: '冒烟测试任务', prompt: '回复 OK', cron: '0 23 * * *', cronEnabled: true })
const taskId = r.body.task.id
await check('任务创建', { status: r.body.task.status, cron: r.body.task.cron, nextRunAtIsNumber: Number.isFinite(r.body.task.nextRunAt) }, { status: 'planned', cron: '0 23 * * *', nextRunAtIsNumber: true })
r = await call('GET', '/wishadel/cron/next?expr=0 23 * * *')
await check('cron 下次执行', Number.isFinite(r.body.next) && r.body.next > Date.now(), true)
r = await call('PATCH', `/wishadel/tasks/${taskId}`, { patch: { status: 'todo', title: '冒烟测试任务(改)' } })
await check('任务更新', r.body.task.status, 'todo')
r = await call('GET', '/wishadel/tasks')
await check('任务列表', r.body.tasks.some((item) => item.id === taskId && item.status === 'todo'), true)
r = await call('DELETE', `/wishadel/tasks/${taskId}`)
await check('任务删除', r.body.removed, true)

// 4) 非法 cron 应报错
r = await call('POST', '/wishadel/tasks', { title: '坏 cron', cron: '99 * * * *' })
await check('非法 cron 拒绝', typeof r.body.error === 'string' && r.status >= 400, true)

// 5) 文件列表 / 搜索 / 读取
r = await call('POST', '/wishadel/fs/list', { root, path: '.' })
await check('文件列表', { hasPackageJson: r.body.entries.some((entry) => entry.name === 'package.json'), truncated: r.body.truncated }, { hasPackageJson: true, truncated: false })
r = await call('POST', '/wishadel/fs/search', { root, query: 'package.json' })
await check('文件搜索', r.body.matches.some((item) => item.name === 'package.json'), true)
r = await call('GET', `/wishadel/fs/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent('package.json')}`)
await check('文件读取', { kind: r.body.kind, textHasName: r.body.text?.includes('wishadel') }, { kind: 'text', textHasName: true })

// 6) 路径逃逸必须被拒绝
r = await call('POST', '/wishadel/fs/list', { root, path: '..\\..\\Windows' })
await check('路径逃逸拒绝', r.status >= 400, true)

// 7) Git（若可用）
const gitInfo = await call('GET', `/wishadel/git/info?root=${encodeURIComponent(root)}`)
console.log(`INFO git: ${JSON.stringify(gitInfo.body).slice(0, 160)}`)
if (gitInfo.body.isRepo) {
  const log = await call('GET', `/wishadel/git/log?root=${encodeURIComponent(root)}&max=5`)
  await check('git log', Array.isArray(log.body.commits), true)
  const status = await call('GET', `/wishadel/git/status?root=${encodeURIComponent(root)}`)
  await check('git status', { isRepo: status.body.isRepo, changesIsArray: Array.isArray(status.body.changes) }, { isRepo: true, changesIsArray: true })
  const checkout = await call('POST', '/wishadel/git/checkout', { root, branch: 'no-such-branch-xyz' })
  await check('git checkout 失败分支', checkout.body.ok, false)
}

// 8) 面板状态持久化
r = await call('POST', '/wishadel/panel-state', { root, state: { width: 420, collapsed: false } })
await check('面板状态写入', r.body.state.width, 420)
r = await call('GET', `/wishadel/panel-state?root=${encodeURIComponent(root)}`)
await check('面板状态读取', r.body.state.collapsed, false)

console.log(failures === 0 ? '\nSMOKE ALL PASS' : `\nSMOKE FAILURES: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
