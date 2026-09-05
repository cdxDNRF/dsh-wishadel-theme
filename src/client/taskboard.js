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

// 看板卡片长按拖动：pending（按住未松开）→ dragging（跟随指针 + 目标栏高亮）。
// 拖放结果由 TaskBoardPanel 异步提交 PATCH 后刷新轮询源（宿主持久化到 tasks.json）。
const boardDragUi = (() => {
  let state = { dragging: null, over: null, x: 0, y: 0, droppedAt: 0 }
  const listeners = new Set()
  const notify = () => listeners.forEach((fn) => fn())
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    start(id, title, x, y) { state = { dragging: { id, title }, over: null, x, y, droppedAt: 0 }; notify() },
    move(x, y, over) {
      if (state.dragging === null) return
      if (state.x === x && state.y === y && state.over === over) return
      state = { ...state, x, y, over }
      notify()
    },
    end() {
      if (state.dragging === null) return
      state = { dragging: null, over: null, x: 0, y: 0, droppedAt: Date.now() }
      notify()
    },
    cancel() { state = { dragging: null, over: null, x: 0, y: 0, droppedAt: 0 }; notify() },
  }
})()

function formatTime(ms) {
  if (!ms) return '—'
  const date = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function TaskBoardTrigger(props) {
  const boardState = useExternal(boardUi, (state) => state)
  const settings = useExternal(runtimeRefs.settings, (state) => state)
  const enabled = settings?.taskboard?.enabled !== false
  const wide = props.wide !== false
  if (!enabled) return null
  return React.createElement('button', {
    type: 'button',
    className: `wsh-sidebar-action wsh-surface${wide ? '' : ' wsh-sidebar-action-rail'}`,
    title: '任务看板：规划、执行与定时任务',
    'aria-label': '任务看板',
    onClick: () => boardUi.toggle(),
    'aria-pressed': boardState.open,
  },
    wide
      ? React.createElement(React.Fragment, null,
        React.createElement('span', { className: 'wsh-label' }, '任务看板'),
        boardState.open ? React.createElement('span', { className: 'wsh-tag live' }, 'OPEN') : null)
      : React.createElement('span', { className: 'wsh-sidebar-action-icon', 'aria-hidden': 'true' }, '▦'))
}

function TaskColumn({ column, tasks, live, onRun, onCard, onDropColumn, overColumn }) {
  const list = tasks.filter((task) => task.status === column.id)
  // 进行中列：自动展示当前运行中的对话（不与任务卡片重复）。
  const liveRows = column.id === 'running' ? (live ?? []) : []
  const count = list.length + liveRows.length
  return React.createElement('section', { className: `wsh-column${overColumn === column.id ? ' drag-over' : ''}`, 'data-col': column.id },
    React.createElement('div', { className: 'wsh-column-head' },
      React.createElement('span', { className: 'wsh-dot' }),
      React.createElement('span', { className: 'wsh-label' }, column.label),
      React.createElement('span', { className: 'wsh-column-count' }, String(count).padStart(2, '0'))),
    React.createElement('div', { className: 'wsh-column-body' },
      list.map((task) => React.createElement(TaskCard, { key: task.id, task, onRun, onCard, onDropColumn })),
      liveRows.map((row) => React.createElement(LiveCard, { key: `live-${row.sessionId}`, live: row })),
      column.id === 'planned' ? React.createElement(AddTaskCard, null) : null))
}

// 运行中的对话卡片：自动上板、自动消失，点击跳转会话。
function LiveCard({ live }) {
  return React.createElement('div', {
    className: 'wsh-task-card live',
    onClick: () => openSession(live.sessionId),
    role: 'button',
    title: live.preview,
  },
    React.createElement('div', { className: 'wsh-task-title' }, live.title),
    React.createElement('div', { className: 'wsh-task-meta' },
      React.createElement('span', { className: `wsh-tag${live.status === 'running' ? ' live' : ''}` }, live.status === 'running' ? '执行中' : '对话就绪'),
      live.preset ? React.createElement('span', { className: 'wsh-hint' }, live.preset) : null,
      live.cwd ? React.createElement('span', { className: 'wsh-hint', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 90 } }, live.cwd) : null),
    live.preview ? React.createElement('div', { className: 'wsh-task-preview' }, live.preview) : null,
    React.createElement('div', { className: 'wsh-task-actions' },
      React.createElement('button', {
        className: 'wsh-btn mini primary',
        onClick: (event) => { event.stopPropagation(); openSession(live.sessionId) },
      }, '打开会话')))
}

function TaskCard({ task, onRun, onCard, onDropColumn }) {
  // 长按（约 260ms 不动）后开始拖动；短击仍打开详情，拖动结束抑制随后的 click。
  const dragRef = React.useRef(null)
  const suppressClickRef = React.useRef(0)
  const columnAt = (x, y) => {
    const element = document.elementFromPoint(x, y)
    const column = element?.closest?.('[data-col]')
    // 「进行中」只能通过「执行」按钮进入，不作为拖放目标。
    if (!column || column.dataset.col === 'running') return null
    return column.dataset.col
  }
  const startDrag = (event) => {
    if (event.button !== 0) return
    if (event.target.closest('button')) return
    if (dragRef.current !== null) return
    const drag = { phase: 'pending', timer: null }
    dragRef.current = drag
    const begin = () => {
      if (dragRef.current !== drag) return
      // pointer 可能已经抬起：只读当前按键状态无法可靠判断，改用 short interval 检查
      drag.phase = 'dragging'
      boardDragUi.start(task.id, task.title, event.clientX, event.clientY)
      document.body.classList.add('wsh-dragging-task')
    }
    const onPointerMove = (moveEvent) => {
      if (dragRef.current !== drag) return
      if (drag.phase === 'pending') return
      boardDragUi.move(moveEvent.clientX, moveEvent.clientY, columnAt(moveEvent.clientX, moveEvent.clientY))
    }
    const onPointerUp = () => {
      if (dragRef.current !== drag) return
      const wasDragging = drag.phase === 'dragging'
      clearTimeout(drag.timer)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      document.body.classList.remove('wsh-dragging-task')
      dragRef.current = null
      if (wasDragging) {
        const over = boardDragUi.getSnapshot().over
        boardDragUi.end()
        suppressClickRef.current = Date.now()
        if (over && over !== task.status) onDropColumn(task.id, over)
      }
    }
    drag.timer = setTimeout(begin, 260)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
  }
  return React.createElement('div', {
    className: `wsh-task-card${task.status === 'running' ? ' running' : ''}`,
    onClick: () => { if (Date.now() - suppressClickRef.current < 400) return; onCard(task.id) },
    onPointerDown: startDrag,
    role: 'button',
    title: '点击查看详情；按住约半秒后拖动可换栏',
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

// 常用定时表达式：让用户直接选固定时间/区间，而非手写 cron。
const CRON_PRESETS = [
  { label: '每 5 分钟', value: '*/5 * * * *' },
  { label: '每 30 分钟', value: '*/30 * * * *' },
  { label: '每小时', value: '0 * * * *' },
  { label: '每 2 小时', value: '0 */2 * * *' },
  { label: '每天 00:00', value: '0 0 * * *' },
  { label: '每天 09:00', value: '0 9 * * *' },
  { label: '每天 12:00', value: '0 12 * * *' },
  { label: '每天 18:00', value: '0 18 * * *' },
  { label: '工作日 08:30', value: '30 8 * * 1-5' },
  { label: '每周一 09:00', value: '0 9 * * 1' },
  { label: '每月 1 日 09:00', value: '0 9 1 * *' },
]

function TaskDetail({ task, onClose }) {
  const [draft, setDraft] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [cronPreview, setCronPreview] = React.useState(null)
  const [options, setOptions] = React.useState({ dirs: [], presets: [], loaded: false })
  const current = draft ?? task
  const tasksSource = runtimeRefs.tasks
  const dirList = options.dirs ?? []

  // 工作目录与预设选择只在打开详情时读取一次。
  React.useEffect(() => {
    let cancelled = false
    api('GET', '/task-options').then((data) => {
      if (!cancelled) setOptions({ dirs: Array.isArray(data?.dirs) ? data.dirs : [], presets: Array.isArray(data?.presets) ? data.presets : [], loaded: true })
    }).catch(() => { if (!cancelled) setOptions((prev) => ({ ...prev, loaded: true })) })
    return () => { cancelled = true }
  }, [task.id])

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

  const cancel = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api('POST', '/tasks/cancel', { id: task.id })
      await tasksSource.refresh()
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
      React.createElement('div', { className: 'wsh-settings-row', style: { alignItems: 'flex-start' } },
        React.createElement('span', null,
          React.createElement('strong', null, '定时执行'),
          React.createElement('small', { style: { display: 'block', color: 'var(--w-muted)' } }, '从常用时间中选择，或选「自定义」手写 cron')),
        React.createElement('label', { className: 'wsh-settings-field' },
          React.createElement('input', { className: 'wsh-check', type: 'checkbox', checked: current.cronEnabled !== false, onChange: (event) => field('cronEnabled', event.target.checked) }),
          React.createElement('strong', null, '启用'))),
      React.createElement('div', { className: 'wsh-task-form-grid' },
        React.createElement('select', {
          value: CRON_PRESETS.some((item) => item.value === (current.cron ?? '')) ? (current.cron ?? '') : (current.cron ?? '').trim() ? '__custom__' : '',
          onChange: (event) => {
            if (event.target.value === '__custom__') { field('cron', current.cron ?? ''); return }
            field('cron', event.target.value)
            setCronPreview(null)
          },
          'aria-label': '常用定时时间',
        },
          React.createElement('option', { value: '' }, '（不定时）'),
          CRON_PRESETS.map((item) => React.createElement('option', { key: item.value, value: item.value }, item.label)),
          React.createElement('option', { value: '__custom__' }, '自定义…')),
        React.createElement('input', {
          type: 'text', value: current.cron ?? '', placeholder: '0 23 * * *（分 时 日 月 周）',
          onChange: (event) => field('cron', event.target.value),
          onBlur: () => { if ((current.cron ?? '').trim()) previewCron() },
          'aria-label': '自定义 cron 表达式',
        }),
        React.createElement('button', { type: 'button', className: 'wsh-btn mini', onClick: previewCron, disabled: !(current.cron ?? '').trim() }, '预览下次执行'),
        cronPreview ? React.createElement('span', { className: 'wsh-hint wsh-task-form-full' }, `下次执行：${cronPreview}`) : null),
      React.createElement('div', { className: 'wsh-settings-row' },
        React.createElement('span', { className: 'wsh-label' }, '状态'),
        React.createElement('select', {
          value: current.status,
          onChange: (event) => field('status', event.target.value),
          style: { background: '#101216', border: '1px solid var(--w-line)', padding: '3px 8px' },
        },
          BOARD_COLUMNS.filter((column) => column.id !== 'running').map((column) => React.createElement('option', { key: column.id, value: column.id }, column.label)))),
      React.createElement('div', { className: 'wsh-settings-row', style: { alignItems: 'flex-start', flexDirection: 'column', gap: 6 } },
        React.createElement('span', null,
          React.createElement('strong', null, '预设'),
          React.createElement('small', { style: { display: 'block', color: 'var(--w-muted)' } }, '执行任务时挂载的智能体角色配置（对应 harness 的 agent preset）。留空 = 使用 DSH 当前默认预设。')),
        React.createElement('select', {
          value: options.presets.some((item) => item.id === (current.preset ?? '')) ? (current.preset ?? '') : (current.preset ?? '').trim() ? '__custom__' : '',
          onChange: (event) => { if (event.target.value === '__custom__') { field('preset', current.preset ?? ''); return } field('preset', event.target.value || '') },
          style: { background: '#101216', border: '1px solid var(--w-line)', padding: '3px 8px' },
          'aria-label': '选择预设',
        },
          React.createElement('option', { value: '' }, '（默认预设）'),
          options.presets.map((item) => React.createElement('option', { key: item.id, value: item.id }, `${item.name}（${item.id}）`)),
          React.createElement('option', { value: '__custom__' }, '自定义…')),
        React.createElement('input', {
          type: 'text', value: current.preset ?? '', placeholder: '自定义预设 id',
          onChange: (event) => field('preset', event.target.value),
          style: { background: '#101216', border: '1px solid var(--w-line)', padding: '3px 8px' },
          'aria-label': '自定义预设 id',
        })),
      React.createElement('div', { className: 'wsh-settings-row', style: { alignItems: 'flex-start', flexDirection: 'column', gap: 6 } },
        React.createElement('span', null,
          React.createElement('strong', null, '工作目录'),
          React.createElement('small', { style: { display: 'block', color: 'var(--w-muted)' } }, '执行任务的智能体起始文件夹：从 DSH 已注册的工作区中选择，或选「自定义」手动输入。')),
        React.createElement('select', {
          value: dirList.includes(current.cwd ?? '') ? (current.cwd ?? '') : (current.cwd ?? '').trim() ? '__custom__' : '',
          onChange: (event) => { if (event.target.value === '__custom__') { field('cwd', current.cwd ?? ''); return } field('cwd', event.target.value || '') },
          style: { background: '#101216', border: '1px solid var(--w-line)', padding: '3px 8px' },
          'aria-label': '选择工作目录',
        },
          React.createElement('option', { value: '' }, '（使用当前工作区）'),
          dirList.map((dir) => React.createElement('option', { key: dir, value: dir }, dir)),
          React.createElement('option', { value: '__custom__' }, '自定义…')),
        React.createElement('input', {
          type: 'text', value: current.cwd ?? '', placeholder: '自定义绝对路径',
          onChange: (event) => field('cwd', event.target.value),
          style: { background: '#101216', border: '1px solid var(--w-line)', padding: '3px 8px' },
          'aria-label': '自定义工作目录',
        })),
      current.lastResult ? React.createElement('div', null,
        React.createElement('span', { className: 'wsh-label' }, '上次执行结果'),
        React.createElement('div', { className: 'wsh-result' }, current.lastResult)) : null,
      current.sessionId ? React.createElement('div', null,
        React.createElement('span', { className: 'wsh-label' }, '执行会话'),
        React.createElement('div', null,
          React.createElement('span', { className: 'wsh-link', onClick: () => openSession(current.sessionId) }, `打开会话 ${current.sessionId}`))) : null,
      error ? React.createElement('div', { className: 'wsh-hint', style: { color: 'var(--w-red-hot)' } }, error) : null,
      React.createElement('div', { className: 'wsh-task-actions', style: { justifyContent: 'flex-end' } },
        current.status === 'running'
          ? React.createElement('button', { className: 'wsh-btn danger', onClick: cancel, disabled: busy }, busy ? '停止中…' : '停止执行')
          : React.createElement('button', { className: 'wsh-btn primary', onClick: run, disabled: busy }, '执行'),
        React.createElement('button', { className: 'wsh-btn', onClick: save, disabled: busy || draft === null }, '保存修改'),
        React.createElement('button', { className: 'wsh-btn danger', onClick: remove, disabled: busy || current.status === 'running' }, current.status === 'running' ? '执行中不可删' : '删除'),
        React.createElement('button', { className: 'wsh-btn', onClick: onClose }, '关闭'))))
}

function TaskBoardPanel() {
  const ui = useExternal(boardUi, (state) => state)
  const drag = useExternal(boardDragUi, (state) => state)
  const settings = useExternal(runtimeRefs.settings, (state) => state)
  const boardData = useExternal(runtimeRefs.tasks, (state) => state)
  const [error, setError] = React.useState(null)
  const tasks = boardData?.tasks ?? []
  const live = boardData?.live ?? []

  // 全局 Escape 关闭（焦点可能在面板外，需 window 级监听；仅打开时响应）。
  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      if (boardDragUi.getSnapshot().dragging !== null) boardDragUi.cancel()
      else if (boardUi.getSnapshot().open) boardUi.toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 拖动换栏：PATCH 状态后刷新轮询源（宿主持久化 tasks.json，重启后保留）。
  const moveTaskStatus = (id, status) => {
    setError(null)
    api('PATCH', `/tasks/${id}`, { patch: { status } })
      .then(() => runtimeRefs.tasks.refresh())
      .catch((cause) => setError(`拖动换栏失败：${String(cause?.message ?? cause)}`))
  }

  if (!ui.open) return null
  if (settings?.taskboard?.enabled === false) {
    return React.createElement('div', { className: 'wsh-overlay-root wsh-centered wsh-surface', onClick: () => boardUi.toggle() },
      React.createElement('div', { className: 'wsh-overlay-panel', style: { width: 'auto', height: 'auto', padding: 24 } },
        React.createElement('p', null, '任务看板已在「设置 > 插件配置」中停用。'),
        React.createElement('button', { className: 'wsh-btn', onClick: () => boardUi.toggle() }, '关闭')))
  }
  const active = ui.detailId ? (tasks ?? []).find((task) => task.id === ui.detailId) : undefined
  // 过滤：已有任务卡片挂载的会话不再重复显示。
  const ownedSessionIds = new Set((tasks ?? []).map((task) => task.sessionId).filter(Boolean))
  const liveRows = (live ?? []).filter((row) => !ownedSessionIds.has(row.sessionId))
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
    onClick: (event) => { if (Date.now() - boardDragUi.getSnapshot().droppedAt < 400) return; if (event.target === event.currentTarget) boardUi.toggle() },
  },
    React.createElement('div', { className: 'wsh-overlay-panel wsh-taskboard-panel wsh-surface', style: { position: 'relative' } },
      React.createElement('div', { className: 'wsh-overlay-head' },
        React.createElement('h2', null, '任务看板 TASK BOARD'),
        React.createElement('span', { className: 'wsh-tag', style: { marginLeft: 4 } }, 'LIVE + SCHEDULED'),
        drag.dragging ? React.createElement('span', { className: 'wsh-tag amber' }, '拖动卡片到目标栏（进行中由“执行”进入）') : null,
        React.createElement('span', { className: 'wsh-spacer' }),
        error ? React.createElement('span', { className: 'wsh-hint', style: { color: 'var(--w-red-hot)' } }, error) : null,
        React.createElement('button', { className: 'wsh-btn mini', onClick: reload }, '刷新'),
        React.createElement('button', { className: 'wsh-btn', onClick: () => boardUi.toggle() }, '关闭')),
      boardData === null ? React.createElement('div', { className: 'wsh-overlay-body' },
        React.createElement('div', { className: 'wsh-tree-empty' }, '任务服务不可用（请重启 dsh web 以加载插件宿主半边）。'),
        serviceError ? React.createElement('div', { className: 'wsh-tree-empty' }, serviceError) : null)
        : React.createElement('div', { className: 'wsh-overlay-body' },
          React.createElement('div', { className: 'wsh-board' },
            BOARD_COLUMNS.map((column) => React.createElement(TaskColumn, {
              key: column.id, column, tasks: tasks ?? [], live: liveRows,
              onRun: run,
              onCard: (id) => boardUi.openDetail(id),
              onDropColumn: moveTaskStatus,
              overColumn: drag.over,
            })))),
      drag.dragging ? React.createElement('div', { className: 'wsh-task-ghost', style: { left: drag.x + 10, top: drag.y + 12 } }, drag.dragging.title) : null,
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
