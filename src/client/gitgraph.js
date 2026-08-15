// Git 图谱：输入框上方分支选择器（conversation.input.dock），
// 分支菜单 + 提交历史泳道图 overlay（shell.overlay）。

const gitgraphUi = (() => {
  let state = { open: false, root: '', branch: '' }
  const listeners = new Set()
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    open(root, branch) { state = { open: true, root, branch }; listeners.forEach((fn) => fn()) },
    close() { state = { ...state, open: false }; listeners.forEach((fn) => fn()) },
  }
})()

function useExternal(source, selector) {
  return React.useSyncExternalStore(source.subscribe, () => selector(source.getSnapshot()))
}

// 从客户端会话记录里解析工作目录（多形状兼容：扁平 record 带 cwd）。
function sessionRootOf(session) {
  if (!session) return undefined
  return session?.cwd
    ?? session?.header?.cwd
    ?? session?.workspace?.path
    ?? session?.header?.workspace?.path
}

// git 按钮浮动位置（可拖动，按项目持久化到 panel-state）
const gitPositionUi = (() => {
  let state = { floating: false, x: null, y: null, dragging: false }
  const listeners = new Set()
  const notify = () => listeners.forEach((fn) => fn())
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    apply(saved) {
      const git = saved?.git
      state = git?.floating && Number.isFinite(git.x) && Number.isFinite(git.y)
        ? { floating: true, x: git.x, y: git.y, dragging: false }
        : { floating: false, x: null, y: null, dragging: false }
      notify()
    },
    startDrag() { state = { ...state, dragging: true }; notify() },
    move(x, y) { state = { ...state, x, y }; notify() },
    endDrag(x, y) { state = { floating: true, x, y, dragging: false }; notify() },
    reset() { state = { floating: false, x: null, y: null, dragging: false }; notify() },
  }
})()

function GitDock(props) {
  const settings = useExternal(runtimeRefs.settings, (state) => state)
  const position = useExternal(gitPositionUi, (state) => state)
  const enabled = settings?.gitgraph?.enabled !== false
  const sessionId = props.sessionId
  const session = props.useSession ? props.useSession((s) => s) : undefined
  // 列表存储才有 cwd：byId[sessionId].cwd 是权威来源；binding.session 仅作兜底。
  const listedCwd = props.useSessions ? props.useSessions((state) => state?.byId?.[sessionId]?.cwd) : undefined
  const root = listedCwd ?? sessionRootOf(session)
  const [info, setInfo] = React.useState(null)
  const [dirtyCount, setDirtyCount] = React.useState(0)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [actionError, setActionError] = React.useState(null)

  // 载入本项目保存的浮动位置
  React.useEffect(() => {
    if (!root) return
    api('GET', '/panel-state', undefined, { root }).then((data) => {
      gitPositionUi.apply(data.state)
    }).catch(() => {})
  }, [root])

  const savePosition = (x, y, floating) => {
    if (!root) return
    api('POST', '/panel-state', { root, state: { git: { x, y, floating } } }).catch(() => {})
  }

  const suppressClickRef = React.useRef(false)
  const onPointerDown = (event) => {
    if (event.button !== 0) return
    const wrapper = event.currentTarget.closest('.wsh-surface')
    if (!wrapper) return
    const startX = event.clientX
    const startY = event.clientY
    const rect = wrapper.getBoundingClientRect()
    let moved = false
    // 拖动期间直接操作 DOM（避免 React 重渲染导致节点重挂载、指针事件丢失），
    // 松手时才提交状态并持久化。
    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX
      const dy = moveEvent.clientY - startY
      if (!moved && Math.hypot(dx, dy) < 5) return
      moved = true
      wrapper.style.position = 'fixed'
      wrapper.style.left = `${rect.left + dx}px`
      wrapper.style.top = `${rect.top + dy}px`
      wrapper.style.zIndex = '7000'
      moveEvent.preventDefault()
    }
    const onUp = (upEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (moved) {
        const finalRect = wrapper.getBoundingClientRect()
        gitPositionUi.endDrag(Math.round(finalRect.left), Math.round(finalRect.top))
        savePosition(Math.round(finalRect.left), Math.round(finalRect.top), true)
        suppressClickRef.current = true
        upEvent.preventDefault()
      } else {
        // 未拖动 → 视为点击，切换菜单
        setMenuOpen((value) => !value)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  const onClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
  }
  const onDoubleClick = () => {
    gitPositionUi.reset()
    savePosition(0, 0, false)
  }

  const load = React.useCallback(async () => {
    try {
      const [infoData, statusData] = await Promise.all([
        api('GET', '/git/info', undefined, { root }),
        api('GET', '/git/status', undefined, { root }),
      ])
      setInfo(infoData)
      setDirtyCount(statusData.changes?.length ?? 0)
    } catch {
      setInfo(null)
      setDirtyCount(0)
    }
  }, [root])

  React.useEffect(() => {
    if (!enabled || !root) { setInfo(null); return }
    load()
    const timer = setInterval(() => { load() }, 15000)
    return () => { clearInterval(timer) }
  }, [enabled, root, load])

  const checkout = async (branch) => {
    if (busy || branch === info?.branch) { setMenuOpen(false); return }
    setBusy(true)
    setActionError(null)
    try {
      await api('POST', '/git/checkout', { root, branch })
      setMenuOpen(false)
      await load()
    } catch (cause) {
      setActionError(String(cause?.message ?? cause))
    } finally {
      setBusy(false)
    }
  }

  if (!enabled || !root) return null
  const branch = info?.branch || '—'
  const dirty = dirtyCount > 0
  const floating = position.floating || position.dragging
  const chipElement = React.createElement('div', {
    className: 'wsh-surface',
    style: floating ? {
      position: 'fixed',
      left: position.x ?? 0,
      top: position.y ?? 0,
      zIndex: 7000,
      display: 'inline-flex',
    } : { position: 'relative', display: 'inline-flex' },
  },
    React.createElement('button', {
      type: 'button',
      className: `wsh-git-chip${position.dragging ? ' dragging' : ''}`,
      title: floating ? '拖拽移动位置；双击回到输入框上方' : `当前分支 ${branch}（会话 ${sessionId ?? ''}）；可拖拽到任意位置，双击复位`,
      onClick,
      onPointerDown,
    },
      React.createElement('span', { className: 'wsh-label' }, 'GIT'),
      React.createElement('span', { className: 'wsh-dirty', title: dirty ? `${dirtyCount} 项变更` : '工作区干净' }, dirty ? '●' : '○'),
      React.createElement('span', { className: 'wsh-branch-name' }, branch)),
    menuOpen ? React.createElement('div', { className: 'wsh-git-menu' },
      React.createElement('button', { type: 'button', onClick: () => { gitgraphUi.open(root, branch); setMenuOpen(false) } }, '◫ 打开提交图谱'),
      React.createElement('button', { type: 'button', onClick: () => { onDoubleClick(); setMenuOpen(false) } }, '⌖ 复位到输入框上方'),
      actionError ? React.createElement('div', { className: 'wsh-hint', style: { padding: '4px 8px', color: 'var(--w-red-hot)' } }, actionError) : null,
      React.createElement('div', { className: 'wsh-label', style: { padding: '6px 8px 2px' } }, busy ? '切换中…' : '分支'),
      (info?.branches ?? []).map((item) => React.createElement('button', {
        key: item.name, type: 'button',
        className: item.current ? 'current' : '',
        disabled: busy,
        onClick: () => checkout(item.name),
      }, item.name))) : null)
  // 浮动时 portal 到 body，避免被 composer 栈的 transform 影响定位。
  if (floating && typeof ReactDOM !== 'undefined' && ReactDOM.createPortal) {
    return ReactDOM.createPortal(chipElement, document.body)
  }
  return chipElement
}

// ── 泳道图 ─────────────────────────────────────────────────────────────────
// 简化泳道算法：沿 topo 顺序为每条「进行中的边」分配泳道；
// 提交引入的每个父提交占用（或复用）一条泳道，直到该父提交行出现。

function computeLanes(commits, tips) {
  const tipLane = new Map()
  let nextLane = 0
  const free = []
  const take = () => (free.length ? free.shift() : nextLane++)
  const release = (lane) => free.push(lane)
  const active = [] // { lane, target }
  const rows = []

  for (const commit of commits) {
    const ending = active.filter((edge) => edge.target === commit.hash)
    const rest = active.filter((edge) => edge.target !== commit.hash)
    let lane
    if (ending.length > 0) {
      lane = ending[0].lane
      for (const edge of ending.slice(1)) release(edge.lane)
    } else if (tips.has(commit.hash) && !tipLane.has(commit.hash)) {
      lane = take()
      tipLane.set(commit.hash, lane)
    } else {
      lane = take()
    }
    rows.push({ commit, lane, edges: rest, ends: ending.length > 0, refs: [...(tips.get(commit.hash) ?? [])] })
    const newActive = [...rest]
    for (const parent of commit.parents) {
      if (newActive.some((edge) => edge.target === parent)) continue
      newActive.push({ lane: take(), target: parent })
    }
    if (commit.parents.length === 0) release(lane)
    active.splice(0, active.length, ...newActive)
  }
  return { rows, lanes: nextLane }
}

function GraphRow({ row, lanes, refs, selected, onSelect }) {
  const commit = row.commit
  const size = 30
  const width = Math.max(2, lanes) * 16
  const centerY = size / 2
  const xOf = (lane) => lane * 16 + 8
  const elements = []
  let key = 0
  // 进行中的边：竖线
  for (const edge of row.edges) {
    elements.push(React.createElement('line', {
      key: `e${key++}`, x1: xOf(edge.lane), x2: xOf(edge.lane), y1: 0, y2: size,
      stroke: 'rgba(244,240,237,.22)', strokeWidth: 1.5,
    }))
  }
  // 提交点 + 父边起点
  const x = xOf(row.lane)
  elements.push(React.createElement('circle', {
    key: `c${key++}`, cx: x, cy: centerY, r: 4,
    fill: row.ends ? '#f12b3e' : '#9a9699',
  }))
  for (const parent of commit.parents) {
    elements.push(React.createElement('path', {
      key: `p${key++}`, d: `M ${x} ${centerY} C ${x} ${size - 2}, ${x} ${size - 6}, ${x} ${size}`,
      stroke: 'rgba(241,43,62,.5)', strokeWidth: 1.5, fill: 'none',
    }))
  }
  const refEls = (refs ?? []).map((name, index) => React.createElement('span', {
    key: `r${index}`,
    className: `wsh-graph-ref${name.startsWith('HEAD') || index === 0 ? ' head' : ''}`,
  }, name))
  return React.createElement('div', {
    className: `wsh-graph-row${selected ? ' selected' : ''}`,
    onClick: () => onSelect(commit.hash),
  },
    React.createElement('div', { className: 'wsh-graph-canvas', style: { width } },
      React.createElement('svg', { width, height: size, style: { display: 'block' } }, elements)),
    React.createElement('div', { className: 'wsh-graph-info' },
      React.createElement('div', { className: 'wsh-graph-subject' }, commit.subject || '(无标题)'),
      React.createElement('div', { className: 'wsh-graph-meta' },
        React.createElement('span', { className: 'wsh-graph-hash' }, commit.hash.slice(0, 8)),
        React.createElement('span', null, commit.author),
        React.createElement('span', null, new Date(commit.time).toLocaleString())),
      refEls.length ? React.createElement('div', { className: 'wsh-graph-refs' }, refEls) : null))
}

function GitGraphOverlay() {
  const ui = useExternal(gitgraphUi, (state) => state)
  const settings = useExternal(runtimeRefs.settings, (state) => state)
  const [state, setState] = React.useState({ commits: [], info: null, error: null, detail: null, selected: null })
  const max = settings?.gitgraph?.maxCommits ?? 200

  React.useEffect(() => {
    if (!ui.open) return
    const load = async () => {
      try {
        const [info, log] = await Promise.all([
          api('GET', '/git/info', undefined, { root: ui.root }),
          api('GET', '/git/log', undefined, { root: ui.root, branch: ui.branch, max }),
        ])
        setState((prev) => ({ ...prev, info, commits: log.commits ?? [], error: log.error ?? null }))
      } catch (cause) {
        setState((prev) => ({ ...prev, error: String(cause?.message ?? cause) }))
      }
    }
    load()
  }, [ui.open, ui.root, ui.branch, max])

  // 全局 Escape 关闭（仅打开时响应）。
  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape' && gitgraphUi.getSnapshot().open) gitgraphUi.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!ui.open) return null
  if (settings?.gitgraph?.enabled === false) return null

  const tips = new Map()
  for (const item of state.info?.branches ?? []) {
    const hash = item.tip
    if (!hash) continue
    if (!tips.has(hash)) tips.set(hash, [])
    tips.get(hash).push(item.name)
  }
  const { rows, lanes } = computeLanes(state.commits ?? [], tips)

  const select = async (hash) => {
    setState((prev) => ({ ...prev, selected: hash, detail: null }))
    try {
      const detail = await api('GET', '/git/commit', undefined, { root: ui.root, hash })
      setState((prev) => ({ ...prev, detail }))
    } catch { /* 详情失败不影响图谱 */ }
  }

  return React.createElement('div', {
    className: 'wsh-overlay-root',
    role: 'dialog',
    'aria-label': 'Git 提交图谱',
    onClick: (event) => { if (event.target === event.currentTarget) gitgraphUi.close() },
  },
    React.createElement('div', { className: 'wsh-overlay-panel wsh-surface' },
      React.createElement('div', { className: 'wsh-overlay-head' },
        React.createElement('h2', null, '提交图谱 COMMIT GRAPH'),
        React.createElement('span', { className: 'wsh-tag' }, `BRANCH ${ui.branch || '—'}`),
        React.createElement('span', { className: 'wsh-spacer' }),
        state.error ? React.createElement('span', { className: 'wsh-hint', style: { color: 'var(--w-red-hot)' } }, state.error) : null,
        React.createElement('button', { className: 'wsh-btn', onClick: () => gitgraphUi.close() }, '关闭')),
      React.createElement('div', { className: 'wsh-overlay-body', style: { display: 'flex', flexDirection: 'column' } },
        React.createElement('div', { className: 'wsh-graph-toolbar' },
          state.info && !state.info.isRepo
            ? React.createElement('span', { className: 'wsh-hint', style: { color: 'var(--w-amber)' } }, '当前目录不是 Git 仓库。')
            : React.createElement(React.Fragment, null,
              React.createElement('span', { className: 'wsh-label' }, `${rows.length} 提交 / ${lanes} 泳道`),
              React.createElement('span', { className: 'wsh-hint' }, '点击提交查看详情；红色节点为分支头'))),
        React.createElement('div', { className: 'wsh-graph-scroll' },
          React.createElement('div', { className: 'wsh-graph' },
            rows.map((row) => React.createElement(GraphRow, {
              key: row.commit.hash, row, lanes,
              refs: tips.get(row.commit.hash),
              selected: state.selected === row.commit.hash,
              onSelect: select,
            })))),
        state.detail ? React.createElement('div', { className: 'wsh-graph-detail' },
          React.createElement('div', { className: 'wsh-graph-meta' },
            React.createElement('span', { className: 'wsh-graph-hash' }, state.detail.commit.hash),
            React.createElement('span', null, `${state.detail.commit.author} <${state.detail.commit.email}>`),
            React.createElement('span', null, new Date(state.detail.commit.time).toLocaleString())),
          React.createElement('div', { style: { marginTop: 4, fontWeight: 600 } }, state.detail.commit.subject),
          state.detail.commit.body ? React.createElement('pre', null, state.detail.commit.body) : null,
          state.detail.files?.length ? React.createElement('pre', null, state.detail.files.join('\n')) : null) : null)))
}

function installGitGraph(ctx, settingsStore) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  ctx.effect(() => slots.inject('conversation.input.dock', () => slots.register({
    name: 'conversation.input.dock',
    id: 'wishadel-gitdock',
    order: 5,
    label: 'Git 分支',
  }, GitDock)), 'wishadel: git dock')
  ctx.effect(() => slots.inject('shell.overlay', () => slots.register({
    name: 'shell.overlay',
    id: 'wishadel-gitgraph-overlay',
    order: 30,
    label: '提交图谱',
  }, GitGraphOverlay)), 'wishadel: git graph overlay')
}
