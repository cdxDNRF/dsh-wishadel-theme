// 删除竞态回归：运行中的任务不可删除；无论时序如何，结算不得击穿进程。
// 用法：node scripts/e2e-race.mjs [--base http://127.0.0.1:3081]
const args = process.argv.slice(2)
let BASE = 'http://127.0.0.1:3080'
{
  const eq = args.findIndex((arg) => arg.startsWith('--base='))
  const space = args.findIndex((arg) => arg === '--base')
  if (eq >= 0) BASE = args[eq].slice(7)
  else if (space >= 0 && args[space + 1]) BASE = args[space + 1]
}
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

async function api(method, path, body) {
  const sendBody = method !== 'GET' && body !== undefined
  const response = await fetch(`${BASE}/wishadel${path}`, {
    method,
    headers: sendBody ? { 'content-type': 'application/json' } : undefined,
    body: sendBody ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  const data = text && !text.trim().startsWith('<') ? JSON.parse(text) : {}
  return { status: response.status, data }
}

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const created = await api('POST', '/tasks', {
  title: '删除竞态测试',
  prompt: '这是自动化回归测试。请直接回复「完成」两个字，不要调用任何工具，不要读取、修改或删除任何文件。',
})
const id = created.data.task?.id
check('任务创建', Boolean(id), id)
await api('POST', '/tasks/run', { id })
const immediate = await api('DELETE', `/tasks/${id}`)
check('运行中删除被拒绝', immediate.status === 409 && /执行中/.test(immediate.data.error ?? ''), `HTTP ${immediate.status} ${immediate.data.error ?? ''}`)

let final = null
for (let i = 0; i < 20; i++) {
  await sleep(3000)
  const list = await api('GET', '/tasks')
  final = list.data.tasks.find((task) => task.id === id)
  if (final.status !== 'running') break
}
check('任务正常结算', final.status === 'done', final.status)
const health = await api('GET', '/health')
check('服务器存活', health.data.ok === true, JSON.stringify(health.data))
await api('DELETE', `/tasks/${id}`)
console.log(failures === 0 ? '\nRACE REGRESSION PASS' : `\nRACE FAILURES: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
