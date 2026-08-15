// 任务看板：五列状态看板，任务由真实 DSH 智能体会话执行，支持 cron 定时。

const BOARD_COLUMNS = [
  { id: 'planned', label: '待规划', hint: '尚未就绪的任务' },
  { id: 'todo', label: '待办', hint: '就绪、等待执行' },
  { id: 'running', label: '进行中', hint: '智能体正在执行' },
  { id: 'done', label: '已完成', hint: '正常完成的任务' },
  { id: 'failed', label: '已失败', hint: '出错或中断' },
]

const boardUi = (() => {
  let state = { open: false, detailId: null }
  const listeners = new Set()
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    toggle() { state = { ...state, open: !state.open, detailId: state.open ? null : state.detailId }; listeners.forEach((fn) => fn()) },
    openDetail(id) { state = { ...state, detailId: id }; listeners.forEach((fn) => fn()) },
    closeDetail() { state = { ...state, detailId: null }; listeners.forEach((fn) => fn()) },
  }
})()

function useExternal(source, selector) {
  return React.useSyncExternalStore(source.subscribe, () => selector(source.getSnapshot()))
}

function formatTime(ms) {
  if (!ms) return '—'
  const date = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function TaskBoardTrigger() {
  const boardState = useExternal(boardUi, (state) => state)
  const settings = useExternal(runtimeRefs.settings, (state) => state)
  const enabled = settings?.taskboard?.enabled !== false
  if (!enabled) return null
  return React.createElement('button', {
    type: 'button',
    className: 'wsh-sidebar-action wsh-surface',
    title: '任务看板：规划、执行与定时任务',
    onClick: () => boardUi.toggle(),
    'aria-pressed': boardState.open,
  },
    React.createElement('span', { className: 'wsh-chibi-icon', 'aria-hidden': 'true' }),
    React.createElement('span', { className: 'wsh-label' }, '任务看板'),
    boardState.open ? React.createElement('span', { className: 'wsh-tag live' }, 'OPEN') : null)
}

function TaskColumn({ column, tasks, onRun, onCard }) {
  const list = tasks.filter((task) => task.status === column.id)
  return React.createElement('section', { className: 'wsh-column', 'data-col': column.id },
    React.createElement('div', { className: 'wsh-column-head' },
      React.createElement('span', { className: 'wsh-dot' }),
      React.createElement('span', { className: 'wsh-label' }, column.label),
      React.createElement('span', { className: 'wsh-column-count' }, String(list.length).padStart(2, '0'))),
    React.createElement('div', { className: 'wsh-column-body' },
      list.map((task) => React.createElement(TaskCard, { key: task.id, task, onRun, onCard })),
      column.id === 'planned' ? React.createElement(AddTaskCard, null) : null))
}

function TaskCard({ task, onRun, onCard }) {
  return React.createElement('div', {
    className: `wsh-task-card${task.status === 'running' ? ' running' : ''}`,
    onClick: () => onCard(task.id),
    role: 'button',
  },
    React.createElement('div', { className: 'wsh-task-title' }, task.title),
    React.createElement('div', { className: 'wsh-task-meta' },
      task.cronEnabled && task.cron ? React.createElement('span', { className: 'wsh-task-cron', title: `下次执行 ${formatTime(task.nextRunAt)}` }, `⏱ ${task.cron}`) : null,
      task.sessionId ? React.createElement('span', { className: 'wsh-tag live' }, '会话已挂载') : null,
      task.status === 'running' ? React.createElement('span', { className: 'wsh-tag live' }, '执行中') : null),
    React.createElement('div', { className: 'wsh-task-actions' },
      (task.status === 'planned' || task.status === 'todo' || task.status === 'failed' || task.status === 'done')
        ? React.createElement('button', {
          className: 'wsh-btn primary mini',
          onClick: (event) => { event.stopPropagation(); onRun(task.id) },
        }, task.status === 'done' || task.status === 'failed' ? '重跑' : '执行')
        : null,
      React.createElement('span', { className: 'wsh-hint', style: { marginLeft: 'auto' } }, formatTime(task.lastRunAt))))
}

function AddTaskCard() {
  const [open, setOpen] = React.useState(false)
  const [title, setTitle] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const tasksSource = runtimeRefs.tasks
  if (!open) {
    return React.createElement('button', { className: 'wsh-add-task', onClick: () => setOpen(true) }, '+ 新建任务')
  }
  const submit = async () => {
    if (!title.trim() || busy) return
    setBusy(true)
    try {
      await api('POST', '/tasks', { title: title.trim() })
      setTitle('')
      setOpen(false)
      await tasksSource.refresh()
    } finally {
      setBusy(false)
    }
  }
  return React.createElement('div', { className: 'wsh-task-card' },
    React.createElement('input', {
      autoFocus: true, type: 'text', placeholder: '任务标题', value: title,
      style: { width: '100%', background: '#101216', border: '1px solid var(--w-line)', padding: '5px 8px' },
      onChange: (event) => setTitle(event.target.value),
      onKeyDown: (event) => { if (event.key === 'Enter') submit() },
    }),
    React.createElement('div', { className: 'wsh-task-actions' },
      React.createElement('button', { className: 'wsh-btn primary mini', onClick: submit, disabled: busy || !title.trim() }, '创建'),
      React.createElement('button', { className: 'wsh-btn mini', onClick: () => setOpen(false) }, '取消')))
}

function TaskDetail({ task, onClose }) {
  const [draft, setDraft] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [cronPreview, setCronPreview] = React.useState(null)
  const current = draft ?? task
  const tasksSource = runtimeRefs.tasks

  const field = (key, value) => setDraft({ ...(draft ?? task), [key]: value })

  const save = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api('PATCH', `/tasks/${task.id}`, { patch: draft })
      setDraft(null)
      await tasksSource.refresh()
    } catch (cause) {
      setError(String(cause?.message ?? cause))
    } finally {
      setBusy(false)
    }
  }

  const run = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api('POST', '/tasks/run', { id: task.id })
      await tasksSource.refresh()
      onClose()
    } catch (cause) {
      setError(String(cause?.message ?? cause))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (busy) return
    setBusy(true)
    try {
      await api('DELETE', `/tasks/${task.id}`)
      await tasksSource.refresh()
      onClose()
    } catch (cause) {
      setError(String(cause?.message ?? cause))
    } finally {
      setBusy(false)
    }
  }

  const previewCron = async () => {
    try {
      const data = await api('GET', '/cron/next', undefined, { expr: current.cron })
      setCronPreview(data.next ? formatTime(data.next) : '（无未来命中）')
    } catch (cause) {
      setCronPreview(`无效表达式：${String(cause?.message ?? cause)}`)
    }
  }

  return React.createElement('div', { className: 'wsh-detail', onClick: (event) => { if (event.target === event.currentTarget) onClose() } },
    React.createElement('div', { className: 'wsh-detail-card wsh-surface' },
      React.createElement('h3', null, current.title),
      React.createElement('label', null,
        React.createElement('span', { className: 'wsh-label' }, '任务指令（发送给智能体）'),
        React.createElement('textarea', { rows: 4, value: current.prompt ?? '', onChange: (event) => field('prompt', event.target.value) })),
      React.createElement('label', null,
        React.createElement('span', { className: 'wsh-label' }, '描述'),
        React.createElement('textarea', { rows: 2, value: current.description ?? '', onChange: (event) => field('description', event.target.value) })),
      React.createElement('div', { className: 'wsh-settings-row' },
        React.createElement('span', null,
          React.createElement('strong', null, '定时执行（cron）'),
          React.createElement('small', { style: { display: 'block', color: 'var(--w-muted)' } }, '分 时 日 月 周，如 0 23 * * * 每天 23:00')),
        React.createElement('label', { className: 'wsh-settings-field' },
          React.createElement('input', { className: 'wsh-check', type: 'checkbox', checked: current.cronEnabled !== false, onChange: (event) => field('cronEnabled', event.target.checked) }),
          React.createElement('strong', null, '启用'))),
      React.createElement('label', null,
        React.createElement('input', {
          type: 'text', value: current.cron ?? '', placeholder: '0 23 * * *',
          style: { width: '100%', background: '#101216', border: '1px solid var(--w-line)', padding: '5px 9px' },
          onChange: (event) => field('cron', event.target.value),
          onBlur: () => { if ((current.cron ?? '').trim()) previewCron() },
        }),
        cronPreview ? React.createElement('span', { className: 'wsh-hint' }, `下次执行：${cronPreview}`) : null),
      React.createElement('div', { className: 'wsh-settings-row' },
        React.createElement('span', { className: 'wsh-label' }, '状态'),
        React.createElement('select', {
          value: current.status,
          onChange: (event) => field('status', event.target.value),
          style: { background: '#101216', border: '1px solid var(--w-line)', padding: '3px 8px' },
        },
          BOARD_COLUMNS.filter((column) => column.id !== 'running').map((column) => React.createElement('option', { key: column.id, value: column.id }, column.label)))),
      React.createElement('div', { className: 'wsh-settings-row' },
        React.createElement('span', { className: 'wsh-label' }, '预设'),
        React.createElement('input', {
          type: 'text', value: current.preset ?? '', placeholder: '(默认)',
          style: { background: '#101216', border: '1px solid var(--w-line)', padding: '3px 8px', maxWidth: 160 },
          onChange: (event) => field('preset', event.target.value) })),
      React.createElement('div', { className: 'wsh-settings-row' },
        React.createElement('span', { className: 'wsh-label' }, '工作目录'),
        React.createElement('input', {
          type: 'text', value: current.cwd ?? '', placeholder: '(当前工作区)',
          style: { background: '#101216', border: '1px solid var(--w-line)', padding: '3px 8px', maxWidth: 220 },
          onChange: (event) => field('cwd', event.target.value) })),
      current.lastResult ? React.createElement('div', null,
        React.createElement('span', { className: 'wsh-label' }, '上次执行结果'),
        React.createElement('div', { className: 'wsh-result' }, current.lastResult)) : null,
      current.sessionId ? React.createElement('div', null,
        React.createElement('span', { className: 'wsh-label' }, '执行会话'),
        React.createElement('div', null,
          React.createElement('span', { className: 'wsh-link', onClick: () => openSession(current.sessionId) }, `打开会话 ${current.sessionId}`))) : null,
      error ? React.createElement('div', { className: 'wsh-hint', style: { color: 'var(--w-red-hot)' } }, error) : null,
      React.createElement('div', { className: 'wsh-task-actions', style: { justifyContent: 'flex-end' } },
        React.createElement('button', { className: 'wsh-btn primary', onClick: run, disabled: busy || current.status === 'running' },
          current.status === 'running' ? '执行中…' : '执行'),
        React.createElement('button', { className: 'wsh-btn', onClick: save, disabled: busy || draft === null }, '保存修改'),
        React.createElement('button', { className: 'wsh-btn danger', onClick: remove, disabled: busy || current.status === 'running' }, current.status === 'running' ? '执行中不可删' : '删除'),
        React.createElement('button', { className: 'wsh-btn', onClick: onClose }, '关闭'))))
}

function TaskBoardPanel() {
  const ui = useExternal(boardUi, (state) => state)
  const settings = useExternal(runtimeRefs.settings, (state) => state)
  const tasks = useExternal(runtimeRefs.tasks, (state) => state)
  const [error, setError] = React.useState(null)

  // 全局 Escape 关闭（焦点可能在面板外，需 window 级监听；仅打开时响应）。
  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape' && boardUi.getSnapshot().open) boardUi.toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!ui.open) return null
  if (settings?.taskboard?.enabled === false) {
    return React.createElement('div', { className: 'wsh-overlay-root wsh-centered wsh-surface', onClick: () => boardUi.toggle() },
      React.createElement('div', { className: 'wsh-overlay-panel', style: { width: 'auto', height: 'auto', padding: 24 } },
        React.createElement('p', null, '任务看板已在「设置 > 插件配置」中停用。'),
        React.createElement('button', { className: 'wsh-btn', onClick: () => boardUi.toggle() }, '关闭')))
  }
  const active = ui.detailId ? (tasks ?? []).find((task) => task.id === ui.detailId) : undefined
  const serviceError = runtimeRefs.tasks.getError()
  const reload = async () => {
    setError(null)
    await runtimeRefs.tasks.refresh().catch(() => {})
  }
  const run = async (id) => {
    setError(null)
    try {
      await api('POST', '/tasks/run', { id })
      await runtimeRefs.tasks.refresh()
    } catch (cause) {
      setError(String(cause?.message ?? cause))
    }
  }
  // 全局 Escape 与点击背景关闭（焦点可能在面板外，需 window 级监听）。
  return React.createElement('div', {
    className: 'wsh-overlay-root',
    role: 'dialog',
    'aria-label': '任务看板',
    onClick: (event) => { if (event.target === event.currentTarget) boardUi.toggle() },
  },
    React.createElement('div', { className: 'wsh-overlay-panel wsh-surface', style: { position: 'relative' } },
      React.createElement('div', { className: 'wsh-overlay-head' },
        React.createElement('h2', null, '任务看板 TASK BOARD'),
        React.createElement('span', { className: 'wsh-tag', style: { marginLeft: 4 } }, 'DSH EXEC'),
        React.createElement('span', { className: 'wsh-spacer' }),
        error ? React.createElement('span', { className: 'wsh-hint', style: { color: 'var(--w-red-hot)' } }, error) : null,
        React.createElement('button', { className: 'wsh-btn mini', onClick: reload }, '刷新'),
        React.createElement('button', { className: 'wsh-btn', onClick: () => boardUi.toggle() }, '关闭')),
      tasks === null ? React.createElement('div', { className: 'wsh-overlay-body' },
        React.createElement('div', { className: 'wsh-tree-empty' }, '任务服务不可用（请重启 dsh web 以加载插件宿主半边）。'),
        serviceError ? React.createElement('div', { className: 'wsh-tree-empty' }, serviceError) : null)
        : React.createElement('div', { className: 'wsh-overlay-body' },
          React.createElement('div', { className: 'wsh-board' },
            BOARD_COLUMNS.map((column) => React.createElement(TaskColumn, {
              key: column.id, column, tasks: tasks ?? [],
              onRun: run,
              onCard: (id) => boardUi.openDetail(id),
            })))),
      active ? React.createElement(TaskDetail, { task: active, onClose: () => boardUi.closeDetail() }) : null))
}

// settingsStore / tasksSource 由 runtime.js 注入后引用（共享 runtimeRefs）。
function installTaskboard(ctx, settingsStore, tasksSource) {
  runtimeRefs.settings = settingsStore
  runtimeRefs.tasks = tasksSource
  const slots = ctx.get('slots')
  if (slots === undefined) return
  ctx.effect(() => slots.inject('sidebar.footer.action', () => slots.register({
    name: 'sidebar.footer.action',
    id: 'wishadel-taskboard',
    order: 40,
    label: '任务看板',
  }, TaskBoardTrigger)), 'wishadel: taskboard trigger')
  ctx.effect(() => slots.inject('shell.overlay', () => slots.register({
    name: 'shell.overlay',
    id: 'wishadel-taskboard-overlay',
    order: 20,
    label: '任务看板',
  }, TaskBoardPanel)), 'wishadel: taskboard overlay')
}
