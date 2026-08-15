// 实机端到端验收：宿主上线后一键验证任务看板执行链路与其余接口。
// 前置：dsh web 已重启（宿主半边加载）。
// 用法：node scripts/e2e-live.mjs [--base http://127.0.0.1:3080] [--cron]
//   --cron  附带验证每分钟 cron 定时执行（多等 ~70s）
const args = process.argv.slice(2)
let BASE = 'http://127.0.0.1:3080'
{
  const eq = args.findIndex((arg) => arg.startsWith('--base='))
  const space = args.findIndex((arg) => arg === '--base')
  if (eq >= 0) BASE = args[eq].slice(7)
  else if (space >= 0 && args[space + 1]) BASE = args[space + 1]
}
const WITH_CRON = args.includes('--cron')

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

async function api(method, path, body, params) {
  const url = new URL(`${BASE}/wishadel${path}`)
  if (params) for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  const sendBody = method !== 'GET' && method !== 'HEAD' && body !== undefined
  const response = await fetch(url, {
    method,
    headers: sendBody ? { 'content-type': 'application/json' } : undefined,
    body: sendBody ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  if (text.trim().startsWith('<!doctype') || text.trim().startsWith('<')) {
    throw new Error('宿主未上线：响应是 SPA 页面。请重启 dsh web 后重试。')
  }
  const data = text ? JSON.parse(text) : {}
  if (!response.ok) throw new Error(`${data.error ?? `HTTP ${response.status}`}`)
  return data
}

let failures = 0
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

// 1) 健康检查（宿主是否就绪）
try {
  const health = await api('GET', '/health')
  check('宿主就绪', health.ok === true && typeof health.git === 'boolean', JSON.stringify(health))
} catch (error) {
  check('宿主就绪', false, String(error.message))
  console.log('\n== 宿主未上线，终止验收。请重启 dsh web 后再运行本脚本 ==')
  process.exit(1)
}

// 2) 设置读写
let settings = await api('GET', '/settings')
check('设置读取', settings.settings?.theme === 'wishadel', `theme=${settings.settings?.theme}`)
const saved = await api('POST', '/settings', { patch: { gitgraph: { maxCommits: 150 } } })
check('设置写入', saved.settings.gitgraph.maxCommits === 150)
await api('POST', '/settings', { patch: { gitgraph: { maxCommits: 200 } } })

// 3) 文件服务
const files = await api('POST', '/fs/list', { root: ROOT, path: '.' })
check('文件列表', files.entries.some((entry) => entry.name === 'package.json'), `${files.entries.length} entries`)

// 4) Git
const git = await api('GET', '/git/info', { }, { root: ROOT })
check('Git 仓库', git.isRepo === true, `branch=${git.branch}`)
if (git.isRepo) {
  const log = await api('GET', '/git/log', undefined, { root: ROOT, max: 10 })
  check('提交历史', Array.isArray(log.commits) && log.commits.length > 0, `${log.commits.length} commits`)
  const status = await api('GET', '/git/status', undefined, { root: ROOT })
  check('变更面板数据', Array.isArray(status.changes), `${status.changes.length} changes`)
}

// 5) 任务执行链路（真实 DSH 智能体会话）
console.log('\n== 创建并执行测试任务（真实智能体会话）==')
const created = await api('POST', '/tasks', {
  title: 'E2E 验收任务',
  prompt: '请回复「验收通过」，不要做其他任何操作。',
  status: 'todo',
})
const taskId = created.task.id
check('任务创建', Boolean(taskId), taskId)
const run = await api('POST', '/tasks/run', { id: taskId })
check('任务启动', run.task.status === 'running', `sessionId=${run.task.sessionId ?? '(创建中)'}`)
const sessionId = run.task.sessionId
console.log(`任务会话: ${sessionId}`)

// 轮询状态（最多 4 分钟）
let finalTask = null
for (let i = 0; i < 48; i++) {
  await sleep(5000)
  const list = await api('GET', '/tasks')
  finalTask = list.tasks.find((task) => task.id === taskId)
  if (finalTask.status !== 'running') break
  process.stdout.write('.')
}
process.stdout.write('\n')
check('任务状态回写', finalTask.status === 'done' || finalTask.status === 'failed', `status=${finalTask.status}`)
check('任务会话已挂载', Boolean(finalTask.sessionId), finalTask.sessionId ?? '')
console.log(`结果摘要: ${String(finalTask.lastResult ?? '').slice(0, 200)}`)
check('结果包含验收通过', /验收通过/.test(finalTask.lastResult ?? ''), '')

// 6) cron 定时（可选）
if (WITH_CRON) {
  console.log('\n== cron 每分钟定时验证（等待最多 75s）==')
  const cronTask = await api('POST', '/tasks', {
    title: 'E2E cron 任务',
    prompt: '请回复「cron 通过」。',
    cron: '* * * * *',
    cronEnabled: true,
  })
  check('cron 任务创建', cronTask.task.nextRunAt > Date.now())
  let cronDone = false
  for (let i = 0; i < 15; i++) {
    await sleep(5000)
    const list = await api('GET', '/tasks')
    const task = list.tasks.find((item) => item.id === cronTask.task.id)
    if (task.status === 'done' || task.status === 'failed' || task.status === 'running') {
      cronDone = task.status !== 'planned'
      if (task.status !== 'running') break
    }
  }
  check('cron 到点自动执行', cronDone)
  await api('DELETE', `/tasks/${cronTask.task.id}`)
}

// 清理
await api('DELETE', `/tasks/${taskId}`)
console.log('\n== E2E 完成 ==')
console.log(JSON.stringify(results, null, 2))
process.exit(failures === 0 ? 0 : 1)

