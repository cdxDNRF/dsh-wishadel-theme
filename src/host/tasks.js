// 任务看板引擎：任务持久化、cron 调度、真实 DSH 智能体会话执行与状态回写。

const TASK_STATUSES = ['planned', 'todo', 'running', 'done', 'failed']

const TASK_INPUT_SCHEMA = z.object({
  title: z.string().min(1, '标题不能为空').max(200),
  description: z.string().max(4000).default(''),
  prompt: z.string().max(20000).default(''),
  cron: z.string().max(200).default(''),
  cronEnabled: z.boolean().default(false),
  status: z.enum(TASK_STATUSES).default('planned'),
  preset: z.string().max(100).default(''),
  cwd: z.string().max(1000).default(''),
})

const TASKS_FILE = 'tasks.json'

// ── cron 解析（5 段：分 时 日 月 周，支持 * /n a-b a,b 与周名缩写）─────────
const DOW_NAMES = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 }

function resolveCronValue(text, min, max, names) {
  const named = names && text in names ? names[text] : undefined
  const value = named !== undefined ? named : Number(text)
  if (!Number.isInteger(value)) throw new Error(`cron 值无效: "${text}"`)
  return value
}

function parseCronField(field, min, max, names) {
  const out = new Set()
  for (const rawPart of String(field).split(',')) {
    const part = rawPart.trim().toUpperCase()
    if (!part) continue
    let base = part
    let step = 1
    const slashAt = part.indexOf('/')
    if (slashAt >= 0) {
      base = part.slice(0, slashAt)
      step = Number(part.slice(slashAt + 1))
      if (!Number.isInteger(step) || step < 1) throw new Error(`cron 步长无效: "${part}"`)
    }
    let lo
    let hi
    if (base === '*') { lo = min; hi = max } else if (base.includes('-')) {
      const [a, b] = base.split('-')
      lo = resolveCronValue(a, min, max, names)
      hi = resolveCronValue(b, min, max, names)
    } else { lo = resolveCronValue(base, min, max, names); hi = lo }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron 范围无效: "${part}"`)
    for (let value = lo; value <= hi; value += step) out.add(value)
  }
  return out
}

const cronCache = new Map()
function parseCron(expr) {
  const trimmed = String(expr ?? '').trim()
  if (!trimmed) throw new Error('cron 表达式为空')
  const cached = cronCache.get(trimmed)
  if (cached) return cached
  const fields = trimmed.split(/\s+/)
  if (fields.length !== 5) throw new Error('cron 需要 5 段（分 时 日 月 周），如 "0 23 * * *"')
  const minute = parseCronField(fields[0], 0, 59)
  const hour = parseCronField(fields[1], 0, 23)
  const dom = parseCronField(fields[2], 1, 31)
  const month = parseCronField(fields[3], 1, 12)
  const dow = parseCronField(fields[4], 0, 7, DOW_NAMES)
  if (dow.has(7)) { dow.delete(7); dow.add(0) }
  const parsed = {
    minute, hour, dom, month, dow,
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  }
  cronCache.set(trimmed, parsed)
  return parsed
}

function cronMatches(parsed, date) {
  const dayOk = parsed.domRestricted && parsed.dowRestricted
    ? (parsed.dom.has(date.getDate()) || parsed.dow.has(date.getDay()))
    : parsed.domRestricted ? parsed.dom.has(date.getDate())
    : parsed.dowRestricted ? parsed.dow.has(date.getDay())
    : true
  return parsed.minute.has(date.getMinutes()) && parsed.hour.has(date.getHours())
    && dayOk && parsed.month.has(date.getMonth() + 1)
}

function nextCronTime(expr, fromMs) {
  const parsed = parseCron(expr)
  const cursor = new Date(fromMs)
  cursor.setSeconds(0, 0)
  for (let i = 0; i < 600000; i++) {
    cursor.setTime(cursor.getTime() + 60000)
    if (cronMatches(parsed, cursor)) return cursor.getTime()
  }
  return null
}

// ── 任务存取 ────────────────────────────────────────────────────────────────
let tasksCache = null

function loadTasks() {
  if (tasksCache === null) {
    const raw = readJson(TASKS_FILE, { tasks: [] })
    tasksCache = Array.isArray(raw?.tasks) ? { tasks: raw.tasks } : { tasks: [] }
  }
  return tasksCache
}

function saveTasks() {
  writeJson(TASKS_FILE, loadTasks())
}

function createTaskEngine(services) {
  const running = new Set()
  const taskListeners = new Set()
  const notify = () => { for (const listener of taskListeners) { try { listener() } catch { /* noop */ } } }

  const list = () => [...loadTasks().tasks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const get = (id) => loadTasks().tasks.find((task) => task.id === id)

  function mutate(id, fn) {
    const task = get(id)
    if (!task) throw new Error('任务不存在')
    fn(task)
    task.updatedAt = now()
    saveTasks()
    notify()
    return task
  }

  function create(input) {
    const parsed = TASK_INPUT_SCHEMA.parse(input ?? {})
    if (parsed.cron.trim()) {
      parseCron(parsed.cron)
      if (!parsed.cronEnabled) parsed.cronEnabled = true
    }
    const task = {
      id: `task-${randomUUID().slice(0, 8)}`,
      ...parsed,
      status: parsed.status === 'running' ? 'todo' : parsed.status,
      sessionId: null,
      lastRunAt: null,
      lastResult: null,
      nextRunAt: parsed.cron.trim() && parsed.cronEnabled ? nextCronTime(parsed.cron, now()) : null,
      startedAt: null,
      finishedAt: null,
      createdAt: now(),
      updatedAt: now(),
      order: list().length,
    }
    loadTasks().tasks.push(task)
    saveTasks()
    notify()
    return task
  }

  function update(id, patch) {
    const task = get(id)
    if (!task) throw new Error('任务不存在')
    const merged = { ...task, ...(patch ?? {}) }
    const parsed = TASK_INPUT_SCHEMA.parse({
      title: merged.title,
      description: merged.description,
      prompt: merged.prompt,
      cron: merged.cron,
      cronEnabled: merged.cronEnabled,
      status: merged.status,
      preset: merged.preset,
      cwd: merged.cwd,
    })
    // 只有真正在执行中的任务（本进程 running 集合）才禁止被改出 running；
    // 旧版允许拖进「进行中」产生的无 agent 僵尸 running 任务允许改回其它状态。
    const engineOwned = task.status === 'running' && running.has(id) && parsed.status !== 'running' ? 'running' : parsed.status
    if (parsed.cron.trim()) parseCron(parsed.cron)
    mutate(id, (target) => {
      Object.assign(target, parsed, { status: engineOwned })
      if (target.cron.trim() && target.cronEnabled) target.nextRunAt = nextCronTime(target.cron, target.lastRunAt ?? now())
      else target.nextRunAt = null
    })
    return get(id)
  }

  function remove(id) {
    const task = get(id)
    if (!task) throw new Error('任务不存在')
    if (task.status === 'running') throw new Error('任务正在执行中，无法删除（可等待完成后再删）')
    const before = loadTasks().tasks.length
    loadTasks().tasks = loadTasks().tasks.filter((item) => item.id !== id)
    if (loadTasks().tasks.length !== before) {
      saveTasks()
      notify()
    }
    return { removed: true }
  }

  // ── 执行 ────────────────────────────────────────────────────────────────────
  function buildTaskPrompt(task) {
    const body = (task.prompt || '').trim() || (task.description || '').trim() || task.title
    return `【任务看板执行】${task.title}\n\n${body}\n\n请独立完成上述任务。完成后用简短的中文汇报执行结果。`
  }

  async function readEvents(sessionId) {
    const live = services.sessions?.get(sessionId)
    if (live) return [...live.events]
    const snapshot = await services.sessionQuery?.readSession(sessionId)
    return snapshot?.events ?? []
  }

  async function lastTurnKind(sessionId) {
    const events = await readEvents(sessionId)
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'turn/end') return events[i].data?.reason?.kind ?? 'error'
    }
    return 'error'
  }

  function collectText(content, out) {
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') out.push(block.text)
    }
  }

  async function sessionSummary(sessionId) {
    const events = await readEvents(sessionId)
    const parts = []
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event.type === 'assistant/message') {
        collectText(event.data?.message?.content, parts)
        if (parts.length) break
      }
    }
    const text = parts.join('\n').trim()
    return text ? text.slice(0, 2000) : '（无文本输出）'
  }

  async function settle(task, handle, error) {
    running.delete(task.id)
    try {
      await sleep(300)
      let result
      let status = 'failed'
      if (error) {
        result = `运行错误：${String(error?.message ?? error)}`
      } else {
        const kind = await lastTurnKind(task.sessionId)
        status = kind === 'completed' ? 'done' : 'failed'
        result = await sessionSummary(task.sessionId)
        if (status === 'failed') result = `任务未正常完成（${kind}）。\n\n${result}`
      }
      // 任务可能已在执行期间被删除：结算写回必须容错，绝不能向调用方抛
      // （settle 由 whenIdle 分离驱动，未处理的拒绝会击穿整个 dsh 进程）。
      try {
        mutate(task.id, (target) => {
          target.status = status
          target.lastResult = result
          target.lastRunAt = now()
          target.finishedAt = now()
          if (target.cron.trim() && target.cronEnabled) target.nextRunAt = nextCronTime(target.cron, now())
        })
      } catch (missing) {
        console.warn(`wishadel: 任务 ${task.id} 已被删除，跳过状态回写`)
      }
    } catch (settleError) {
      console.warn(`wishadel: 任务 ${task.id} 结算失败: ${String(settleError?.message ?? settleError)}`)
    } finally {
      try { await handle.dispose() } catch { /* 会话已随进程/手动关闭 */ }
    }
  }

  async function cancel(id) {
    const task = get(id)
    if (!task) throw new Error('任务不存在')
    if (!running.has(id) || task.status !== 'running') return get(id)
    const agent = task.sessionId ? services.agents?.get?.(task.sessionId) : undefined
    if (!agent || typeof agent.cancel !== 'function') throw new Error('任务执行会话不可用')
    agent.cancel({ kind: 'user' })
    return get(id)
  }

  async function run(id) {
    const task = get(id)
    if (!task) throw new Error('任务不存在')
    if (running.has(id)) throw new Error('任务正在执行中')
    running.add(id)
    mutate(id, (target) => {
      target.status = 'running'
      target.sessionId = null
      target.lastResult = null
      target.startedAt = now()
    })
    try {
      const presetId = (task.preset || '').trim() || undefined
      const presets = services.agentPresets
      const resolvedId = presets ? (await presets.resolve(presetId)).id : undefined
      const selection = services.agentDefaultModel?.currentSelection?.()
      const agentOptions = selection?.provider ? { provider: selection.provider, model: selection.model } : undefined
      const cwd = (task.cwd || '').trim() || services.sandboxPolicy?.workspaceRoot || process.cwd()
      const sessionId = `wishadel-task-${task.id}-${Math.floor(Date.now() / 1000)}`
      const handle = await services.agents.create({
        sessionId,
        agentOptions,
        meta: { cwd, ...(resolvedId ? { agentPreset: resolvedId } : {}) },
        setup: async (agentCtx) => { if (presets) await presets.mount(agentCtx, resolvedId) },
      })
      mutate(task.id, (target) => { target.sessionId = sessionId })
      const agent = handle.agent
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: buildTaskPrompt(task) }],
        source: { kind: 'user' },
      })
      agent.whenIdle().then(
        () => settle(task, handle, null),
        (error) => settle(task, handle, error),
      )
      return get(id)
    } catch (error) {
      running.delete(id)
      // 任务可能已在启动期间被删除：写回失败只记录，不抛出。
      try {
        mutate(id, (target) => {
          target.status = 'failed'
          target.lastResult = `启动失败：${String(error?.message ?? error)}`
          target.lastRunAt = now()
          target.finishedAt = now()
        })
      } catch (missing) {
        console.warn(`wishadel: 任务 ${id} 已被删除，跳过启动失败回写`)
      }
      throw error
    }
  }

  function cronTick() {
    const settings = loadSettings()
    if (!settings.taskboard.enabled) return
    const timestamp = now()
    for (const task of list()) {
      if (task.status === 'running') continue
      if (!task.cronEnabled || !(task.cron || '').trim()) continue
      // 并发删除防护：每次 mutate 都可能撞上"任务已被删除"，失败只记录。
      if (task.nextRunAt == null) {
        try {
          mutate(task.id, (target) => { target.nextRunAt = nextCronTime(target.cron, timestamp) })
        } catch { /* 任务已删除 */ }
        continue
      }
      if (timestamp >= task.nextRunAt) {
        const due = task.nextRunAt
        try {
          mutate(task.id, (target) => { target.nextRunAt = nextCronTime(target.cron, due) })
        } catch { continue /* 任务已删除 */ }
        run(task.id).catch(() => { /* run 内部已落库失败状态 */ })
      }
    }
  }

  function recoverInterrupted() {
    let changed = false
    for (const task of list()) {
      if (task.status === 'running') {
        task.status = 'failed'
        task.lastResult = '任务因 harness 重启而中断。'
        task.finishedAt = now()
        task.updatedAt = now()
        changed = true
      }
    }
    if (changed) { saveTasks(); notify() }
  }

  return {
    list, get, create, update, remove, run, cancel, cronTick, recoverInterrupted,
    onChanged: (listener) => { taskListeners.add(listener); return () => taskListeners.delete(listener) },
    nextCronTime,
    parseCronForPreview: (expr) => nextCronTime(expr, now()),
  }
}
