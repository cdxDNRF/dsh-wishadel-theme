// 宿主半边冒烟测试：用 mock Cordis Context 装载 lib/index.js，
// 捕获注册的 HTTP 路由后直接驱动请求，验证设置/任务/cron/文件/Git 全链路。
// 用法：node scripts/smoke-host.mjs
import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const { apply } = await import(pathToFileURL(resolve(root, 'lib/index.js')).href)

const captured = { routes: [], effects: [], intervals: [] }
const streamModes = { mode: 'default' }

const ctx = {
  get(name) {
    switch (name) {
      case 'webServer': return { register: (route) => { captured.routes.push(route); return () => {} } }
      case 'agents': return {
        create: async () => { throw new Error('mock: agents.create 未在冒烟测试中使用') },
        get: () => undefined,
        list: () => [],
      }
      case 'sessions': return {
        get: (id) => id === 'optimize-session' ? {
          requestHeader: () => ({ config: { provider: 'mock-provider', model: 'mock-model', reasoningEffort: 'low' } }),
          events: [],
        } : undefined,
        list: () => [],
      }
      case 'llm': return {
        resolveCallConfig: async (config) => config,
        async *stream(options) {
          captured.optimizeOptions = options
          if (streamModes.mode === 'block-end-only') {
            yield { type: 'block-end', index: 0, block: { type: 'text', text: '块级优化的提示词' } }
          } else if (streamModes.mode === 'empty') {
            yield { type: 'finish', reason: { kind: 'stop' } }
          } else if (streamModes.mode === 'reasoning-only') {
            yield { type: 'reasoning-delta', index: 0, text: '思考过程得出' }
            yield { type: 'reasoning-delta', index: 0, text: '的优化稿正文' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          } else {
            yield { type: 'text-delta', index: 0, text: '优化后的提示词' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          }
        },
      }
      case 'sessionQuery': return { readSession: async () => ({ events: [] }) }
      case 'agentPresets': return { list: async () => [{ id: 'cordis', name: 'Cordis' }], resolve: async (id) => ({ id: id ?? 'cordis' }), mount: async () => {} }
      case 'agentDefaultModel': return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) }
      case 'sandboxPolicy': return { workspaceRoot: root, resolve: () => ({ mode: 'workspace-write' }) }
      case 'workspaceRegistry': return { list: () => [{ path: root }, { path: '/mnt/d/AIagent' }] }
      case 'folderPickerOverride': return async (body) => (body?.mockCancel ? null : String(body?.mockPath ?? ''))
      default: return undefined
    }
  },
  effect(fn, label) { captured.effects.push(label); const dispose = fn(); return dispose }
  ,
  setInterval(fn, ms) { captured.intervals.push(ms); return () => {} },
  timer: { interval: (fn, ms) => { captured.intervals.push(ms); return () => {} } },
  logger: { info: () => {}, warn: console.warn, error: console.error },
  on: () => () => {},
  inject(names, callback) {
    if (names.includes('settings')) callback({ settings: { register: (key) => { captured.settingsKey = key } } })
  },
}

apply(ctx)
if (captured.settingsKey !== 'wishadel') { console.error(`FAIL: settings namespace 未注册: ${captured.settingsKey}`); process.exit(1) }
console.log('PASS: rc.7 settings namespace wishadel 已注册')
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
r = await call('POST', '/wishadel/prompt-optimize', { sessionId: 'optimize-session', text: '请帮我整理这个需求' })
await check('模型提示词优化', r.body.text, '优化后的提示词')
await check('优化使用当前模型', { provider: captured.optimizeOptions.provider, model: captured.optimizeOptions.model, reasoningEffort: captured.optimizeOptions.reasoningEffort }, { provider: 'mock-provider', model: 'mock-model', reasoningEffort: 'low' })
await check('优化不构造会话消息', captured.optimizeOptions.messages[0].content[0].text.includes('请帮我整理这个需求'), true)
await check('增强模板含补全要素', typeof captured.optimizeOptions.system === 'string' && captured.optimizeOptions.system.includes('补全缺失的要素') && captured.optimizeOptions.system.includes('仅输出优化后的指令本身'), true)
streamModes.mode = 'block-end-only'
r = await call('POST', '/wishadel/prompt-optimize', { sessionId: 'optimize-session', text: '块级流' })
await check('块级流聚合', r.body.text, '块级优化的提示词')
streamModes.mode = 'reasoning-only'
r = await call('POST', '/wishadel/prompt-optimize', { sessionId: 'optimize-session', text: '思考型模型' })
await check('仅推理流回退正文', r.body.text, '思考过程得出的优化稿正文')
streamModes.mode = 'empty'
r = await call('POST', '/wishadel/prompt-optimize', { sessionId: 'optimize-session', text: '空输出诊断' })
await check('空输出给出诊断', typeof r.body.error === 'string' && r.body.error.includes('模型未返回优化结果') && r.body.error.includes('mock-provider/mock-model'), true)
streamModes.mode = 'default'
r = await call('GET', '/wishadel/task-options')
await check('任务选项返回目录与预设', { hasRoot: Array.isArray(r.body.dirs) && r.body.dirs.includes(root), presets: r.body.presets?.map?.((item) => item.id) }, { hasRoot: true, presets: ['cordis'] })

// 2) 设置写入 + 读取
r = await call('POST', '/wishadel/settings', { patch: { theme: 'wishadel', gitgraph: { enabled: false } } })
await check('settings 写回', r.body.settings.gitgraph.enabled, false)
r = await call('GET', '/wishadel/settings')
await check('settings 读取', { theme: r.body.settings.theme, gitgraph: r.body.settings.gitgraph.enabled }, { theme: 'wishadel', gitgraph: false })
r = await call('POST', '/wishadel/settings', { patch: { gitgraph: { enabled: true } } })
await check('settings 恢复', r.body.settings.gitgraph.enabled, true)

// 2b) 原生替代功能默认关闭（新版 DSH 已自带的能力）
r = await call('GET', '/wishadel/settings')
await check('原生替代功能默认全关', r.body.settings.superseded, { historyJump: false, activityTab: false, sidebarNav: false, sessionFiles: false })
r = await call('POST', '/wishadel/settings', { patch: { superseded: { historyJump: true } } })
await check('原生替代功能可重新开启', { historyJump: r.body.settings.superseded.historyJump, activityTab: r.body.settings.superseded.activityTab }, { historyJump: true, activityTab: false })
r = await call('POST', '/wishadel/settings', { patch: { superseded: { historyJump: false } } })
await check('原生替代功能可再次关闭', r.body.settings.superseded.historyJump, false)

// 3) 任务 CRUD + cron 预览 + 运行中对话投影
r = await call('GET', '/wishadel/live-sessions')
await check('live-sessions 接口', Array.isArray(r.body.sessions), true)
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

// 3b) 无 agent 的僵尸 running 任务应允许改出 running（旧版拖拽入「进行中」的遗留物）。
r = await call('POST', '/wishadel/tasks', { title: '僵尸 running 任务' })
const zombieId = r.body.task.id
await call('PATCH', `/wishadel/tasks/${zombieId}`, { patch: { status: 'running' } })
r = await call('PATCH', `/wishadel/tasks/${zombieId}`, { patch: { status: 'planned' } })
await check('僵尸 running 可改回 planned', r.body.task.status, 'planned')
r = await call('DELETE', `/wishadel/tasks/${zombieId}`)
await check('僵尸任务清理', r.body.removed, true)

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

// 8) 面板状态持久化（旧 root 状态兼容 + session key）
r = await call('POST', '/wishadel/panel-state', { root, sessionId: 'smoke-session', state: { width: 420, collapsed: false, tab: 'terminal', bottomTab: 'activity', bottomOpen: true } })
await check('面板状态写入', { width: r.body.state.width, tab: r.body.state.tab, bottomTab: r.body.state.bottomTab, bottomOpen: r.body.state.bottomOpen }, { width: 420, tab: 'terminal', bottomTab: 'activity', bottomOpen: true })
r = await call('GET', `/wishadel/panel-state?root=${encodeURIComponent(root)}&sessionId=smoke-session`)
await check('面板状态读取', { collapsed: r.body.state.collapsed, tab: r.body.state.tab, bottomTab: r.body.state.bottomTab }, { collapsed: false, tab: 'terminal', bottomTab: 'activity' })
r = await call('GET', `/wishadel/panel-state?root=${encodeURIComponent(root)}&sessionId=new-session-without-state`)
await check('新会话不继承 root 面板状态', r.body.state, null)

// 9) 终端 API（spawn 降级通道）
r = await call('POST', '/wishadel/terminal/start', { sessionId: 'smoke-session', cwd: root })
const terminalId = r.body.terminal?.id
await check('终端启动', typeof terminalId, 'string')
if (terminalId) {
  await call('POST', '/wishadel/terminal/write', { id: terminalId, sessionId: 'smoke-session', data: 'echo WISHADEL_SMOKE\\n' })
  await new Promise((resolve) => setTimeout(resolve, 250))
  r = await call('GET', `/wishadel/terminal/read?id=${encodeURIComponent(terminalId)}&sessionId=smoke-session&cursor=0`)
  await check('终端读取', { sessionId: r.body.sessionId, hasCursor: Number.isSafeInteger(r.body.cursor) }, { sessionId: 'smoke-session', hasCursor: true })
  const foreign = await call('GET', `/wishadel/terminal/read?id=${encodeURIComponent(terminalId)}&sessionId=foreign&cursor=0`)
  await check('终端跨会话拒绝', foreign.status >= 400, true)
  await call('POST', '/wishadel/terminal/close', { id: terminalId, sessionId: 'smoke-session' })
}

// 10) 浏览器探测必须拒绝 loopback
r = await call('GET', '/wishadel/browser-probe?url=http%3A%2F%2F127.0.0.1%3A3080')
await check('浏览器 loopback 拒绝', r.status >= 400, true)

// 11) 工作区目录选择增强
r = await call('GET', '/wishadel/workspaces')
await check('已注册工作区快捷列表', { itemCount: r.body.items.length, hasHome: typeof r.body.home === 'string' && r.body.home.length > 0 }, { itemCount: 3, hasHome: true })
r = await call('POST', '/wishadel/folder-picker/expand', { path: '~' })
await check('手动路径 ~ 展开', r.body.path, homedir())
r = await call('POST', '/wishadel/folder-picker/expand', { path: '/does/not/exist-wishadel-smoke' })
await check('不存在的目录拒绝', r.status >= 400, true)
r = await call('POST', '/wishadel/folder-picker/pick', { mockPath: root })
await check('弹窗选择协议（注入实现）', r.body.path, root)
r = await call('POST', '/wishadel/folder-picker/pick', { mockCancel: true })
await check('弹窗取消协议', r.body.cancelled, true)
r = await call('GET', '/wishadel/folder-picker/capability')
await check('弹窗能力探测', { kindIsKnown: r.body.kind === 'windows-dialog' || r.body.kind === 'unavailable', hasHome: typeof r.body.home === 'string' }, { kindIsKnown: true, hasHome: true })

console.log(failures === 0 ? '\nSMOKE ALL PASS' : `\nSMOKE FAILURES: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
