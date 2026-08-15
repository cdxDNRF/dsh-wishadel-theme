// 右侧面板：文件树 + 多格式预览 + Git 变更（SCM）。
// 通过 conversation.session.header.actions 的开关按钮与 shell.overlay 的停靠容器协作；
// 宽度可拖拽（双击复位），折叠与宽度按项目（workspace root）持久化到宿主。

const panelUi = (() => {
  let state = { sessionId: null, root: '', open: false, width: 380, collapsed: false, tab: 'preview', ready: false }
  const listeners = new Set()
  let persistTimer = null
  let pendingAttach = null
  const notify = () => listeners.forEach((fn) => fn())
  const persist = () => {
    if (!state.root) return
    clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      api('POST', '/panel-state', { root: state.root, state: { width: state.width, collapsed: state.collapsed } }).catch(() => {})
    }, 400)
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    attach: (sessionId, root, defaults) => {
      if (state.sessionId === sessionId && state.root === root && state.ready) return
      if (pendingAttach !== null && pendingAttach.key === `${sessionId}\x00${root}`) return
      const operation = (async () => {
        let saved = null
        try {
          const data = await api('GET', '/panel-state', undefined, { root })
          saved = data.state
        } catch { /* 使用默认值 */ }
        state = {
          sessionId,
          root,
          tab: 'preview',
          ready: true,
          width: saved?.width ?? defaults?.defaultWidth ?? 380,
          collapsed: saved ? Boolean(saved.collapsed) : Boolean(defaults?.defaultCollapsed ?? false),
          open: saved ? !saved.collapsed : !(defaults?.defaultCollapsed ?? false),
        }
        pendingAttach = null
        notify()
      })()
      pendingAttach = { key: `${sessionId}\x00${root}`, operation }
    },
    detach: () => {
      if (!state.sessionId && !state.root) return
      state = { ...state, sessionId: null, root: '', ready: false, open: false }
      notify()
    },
    toggle: () => { state = { ...state, open: !state.open }; notify() },
    setCollapsed: (collapsed) => { state = { ...state, collapsed, open: !collapsed }; notify(); persist() },
    setWidth: (width) => { state = { ...state, width }; notify(); persist() },
    resetWidth: (defaultWidth) => { state = { ...state, width: defaultWidth ?? 380 }; notify(); persist() },
    setTab: (tab) => { state = { ...state, tab }; notify() },
    syncDefaults: (defaults) => {
      if (state.width === undefined) { state = { ...state, width: defaults?.defaultWidth ?? 380 }; notify() }
    },
  }
})()

function useExternal(source, selector) {
  return React.useSyncExternalStore(source.subscribe, () => selector(source.getSnapshot()))
}

function PanelToggle(props) {
  const settings = useExternal(runtimeRefs.settings, (state) => state)
  const ui = useExternal(panelUi, (state) => state)
  const enabled = settings?.panel?.enabled !== false
  const sessionId = props.sessionId
  const session = props.useSession ? props.useSession((s) => s) : undefined
  // 列表存储才有 cwd：byId[sessionId].cwd 是权威来源；binding.session 仅作兜底。
  const listedCwd = props.useSessions ? props.useSessions((state) => state?.byId?.[sessionId]?.cwd) : undefined
  const root = listedCwd ?? sessionRootOf(session)

  React.useEffect(() => {
    if (!enabled) { panelUi.detach(); return }
    if (root) panelUi.attach(sessionId, root, settings?.panel)
    else panelUi.detach()
  }, [enabled, sessionId, root])

  if (!enabled || !root) return null
  return React.createElement('button', {
    type: 'button',
    className: 'wsh-btn mini wsh-surface',
    title: ui.open ? '收起右侧面板' : '展开右侧面板（预览 / 文件与变更）',
    onClick: () => panelUi.toggle(),
    'aria-pressed': ui.open,
  }, ui.open ? '▮ 面板' : '面板')
}

// ── 文件树 ─────────────────────────────────────────────────────────────────
function FileTree({ root, onOpen, activePath }) {
  const [tree, setTree] = React.useState({ entries: [], path: '.', truncated: false })
  const [childrenCache, setChildrenCache] = React.useState({})
  const [expanded, setExpanded] = React.useState(() => new Set())
  const [filter, setFilter] = React.useState('')
  const [error, setError] = React.useState(null)
  const [searching, setSearching] = React.useState(null)

  const load = async (path, intoCache) => {
    try {
      const data = await api('POST', '/fs/list', { root, path })
      if (intoCache) setChildrenCache((cache) => ({ ...cache, [path]: data }))
      else setTree(data)
      setError(null)
    } catch (cause) {
      setError(String(cause?.message ?? cause))
    }
  }
  React.useEffect(() => { load('.', false) }, [root])

  const toggleDir = async (entry) => {
    const path = entry.name.startsWith('./') ? entry.name : joinPath(tree.path, entry.name)
    const next = new Set(expanded)
    if (next.has(path)) { next.delete(path); setExpanded(next); return }
    next.add(path)
    setExpanded(next)
    if (!childrenCache[path]) await load(path, true)
  }

  const search = async () => {
    if (!filter.trim()) { setSearching(null); return }
    setSearching([])
    try {
      const data = await api('POST', '/fs/search', { root, query: filter.trim() })
      setSearching(data.matches ?? [])
    } catch (cause) {
      setError(String(cause?.message ?? cause))
    }
  }

  const renderRows = (entries, depth) => entries.map((entry) => {
    const full = joinPath(tree.path, entry.name)
    const isDir = entry.type === 'directory'
    const isOpen = expanded.has(full)
    const kids = childrenCache[full]?.entries ?? []
    return React.createElement(React.Fragment, { key: full },
      React.createElement('div', {
        className: `wsh-tree-row${activePath === full ? ' selected' : ''}`,
        style: { paddingLeft: 10 + depth * 12 },
        onClick: () => (isDir ? toggleDir(entry) : onOpen(full, entry.size)),
      },
        React.createElement('span', { className: 'wsh-tree-icon' }, isDir ? (isOpen ? '▾' : '▸') : '·'),
        React.createElement('span', { className: 'wsh-tree-name' }, entry.name),
        entry.size !== undefined ? React.createElement('span', { className: 'wsh-tree-size' }, humanSize(entry.size)) : null),
      isDir && isOpen ? renderRows(kids, depth + 1) : null)
  })

  const visible = searching ?? tree.entries
  return React.createElement('div', { className: 'wsh-tree-wrap', style: { display: 'flex', flexDirection: 'column', minHeight: 0 } },
    React.createElement('div', { className: 'wsh-search' },
      React.createElement('input', {
        type: 'search', placeholder: '搜索文件名…', value: filter,
        onChange: (event) => { setFilter(event.target.value); if (searching !== null) setSearching(null) },
        onKeyDown: (event) => { if (event.key === 'Enter') search() },
      }),
      React.createElement('button', { className: 'wsh-btn mini', onClick: search }, searching !== null ? '清除' : '搜索')),
    error ? React.createElement('div', { className: 'wsh-tree-empty' }, error) : null,
    searching !== null && searching.length === 0 ? React.createElement('div', { className: 'wsh-tree-empty' }, '没有匹配的文件。') : null,
    React.createElement('div', { className: 'wsh-tree' },
      renderRows(Array.isArray(visible) ? visible : [], 0)),
    tree.truncated ? React.createElement('div', { className: 'wsh-tree-empty' }, '目录过大，仅显示前 2000 项。') : null)
}

function humanSize(bytes) {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  return `${(bytes / 1024 / 1024).toFixed(1)}M`
}

function joinPath(base, name) {
  if (base === '.' || base === '') return name
  return `${base.replace(/\/+$/, '')}/${name}`
}

// ── 极简 Markdown 渲染（无第三方依赖）──────────────────────────────────────
function renderInline(text) {
  const nodes = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  for (const match of text.matchAll(re)) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('**')) nodes.push(React.createElement('strong', { key: nodes.length }, token.slice(2, -2)))
    else if (token.startsWith('`')) nodes.push(React.createElement('code', { key: nodes.length }, token.slice(1, -1)))
    else {
      const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(token)
      nodes.push(React.createElement('a', { key: nodes.length, href: link[2], target: '_blank', rel: 'noreferrer' }, link[1]))
    }
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function MarkdownView({ text }) {
  const blocks = []
  let list = null
  let para = null
  const flushPara = () => {
    if (para === null) return
    blocks.push(React.createElement('p', { key: blocks.length }, para))
    para = null
  }
  const flushList = () => {
    if (list === null) return
    blocks.push(React.createElement('ul', { key: blocks.length }, list))
    list = null
  }
  for (const line of text.split('\n')) {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    const codeStart = /^```/.exec(line)
    const item = /^[-*]\s+(.*)$/.exec(line)
    if (heading) {
      flushPara(); flushList()
      const level = heading[1].length
      blocks.push(React.createElement(level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3', { key: blocks.length }, heading[2]))
    } else if (item) {
      flushPara()
      if (list === null) list = []
      list.push(React.createElement('li', { key: list.length }, renderInline(item[1])))
    } else if (codeStart) {
      // 简化：代码块内容原样保留为段落
      flushPara()
    } else if (line.trim() === '') {
      flushPara(); flushList()
    } else {
      flushList()
      if (para === null) para = []
      para.push(para.length ? ' ' : '', renderInline(line))
    }
  }
  flushPara(); flushList()
  return React.createElement('div', { className: 'wsh-preview-md' }, blocks)
}

// ── 预览 ────────────────────────────────────────────────────────────────────
function CsvView({ text }) {
  const rows = []
  let header = null
  let index = 0
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue
    const cells = raw.split(',').map((cell) => cell.replace(/^"|"$/g, ''))
    if (header === null) {
      header = cells
      continue
    }
    rows.push(cells)
    index += 1
    if (index > 500) break
  }
  return React.createElement('table', { style: { borderCollapse: 'collapse', fontSize: 11.5, margin: 10 } },
    React.createElement('thead', null,
      React.createElement('tr', null, (header ?? []).map((cell, i) => React.createElement('th', { key: i, style: { border: '1px solid var(--w-line)', padding: '3px 8px', textAlign: 'left' } }, cell)))),
    React.createElement('tbody', null,
      rows.map((row, r) => React.createElement('tr', { key: r }, row.map((cell, c) => React.createElement('td', { key: c, style: { border: '1px solid var(--w-line)', padding: '3px 8px' } }, cell))))))
}

// diff/patch 文件按行着色渲染。
function DiffView({ text }) {
  const lines = text.split('\n').map((line, index) => {
    let cls = null
    if (line.startsWith('+') && !line.startsWith('+++')) cls = 'wsh-preview-diff-line-add'
    else if (line.startsWith('-') && !line.startsWith('---')) cls = 'wsh-preview-diff-line-del'
    return React.createElement('div', { key: index, className: cls }, line || ' ')
  })
  return React.createElement('div', { className: 'wsh-preview-code', style: { whiteSpace: 'pre' } }, lines)
}

function PreviewArea({ root, openFiles, activePath, onMode, onSave, onClose, savedAt }) {
  const file = openFiles.find((item) => item.path === activePath)
  if (!file || !file.data) {
    return React.createElement('div', { className: 'wsh-tree-empty' }, '点击左侧文件即可预览。')
  }
  const data = file.data
  const mode = file.mode ?? 'source'
  return React.createElement('div', { className: 'wsh-preview' },
    React.createElement('div', { className: 'wsh-preview-bar' },
      React.createElement('span', { className: 'wsh-preview-name', title: file.path }, file.path),
      data.kind === 'text' ? React.createElement(React.Fragment, null,
        React.createElement('button', { className: `wsh-btn mini${mode === 'source' ? ' primary' : ''}`, onClick: () => onMode('source') }, '源码'),
        /\.(md|markdown)$/i.test(file.path) ? React.createElement('button', { className: `wsh-btn mini${mode === 'md' ? ' primary' : ''}`, onClick: () => onMode('md') }, '预览') : null,
        /\.(md|markdown)$/i.test(file.path) ? React.createElement('button', { className: `wsh-btn mini${mode === 'split' ? ' primary' : ''}`, onClick: () => onMode('split') }, '分屏') : null,
        React.createElement('button', { className: `wsh-btn mini${mode === 'edit' ? ' primary' : ''}`, onClick: () => onMode('edit') }, '编辑')) : null,
      data.kind === 'text' && (mode === 'edit' || mode === 'split') ? React.createElement('button', { className: 'wsh-btn mini primary', onClick: () => onSave(file) }, '保存') : null,
      savedAt ? React.createElement('span', { className: 'wsh-tag done' }, '已保存') : null,
      React.createElement('button', { className: 'wsh-btn mini', style: { marginLeft: 'auto' }, onClick: () => onClose(file.path) }, '×')),
    data.kind === 'text' ? React.createElement('div', { className: mode === 'split' ? 'wsh-preview-body wsh-split' : 'wsh-preview-body' },
      mode === 'md' ? React.createElement(MarkdownView, { text: data.text })
        : mode === 'split' ? React.createElement(React.Fragment, null,
          React.createElement('div', { className: 'wsh-preview-body' }, React.createElement(MarkdownView, { text: data.text })),
          React.createElement('div', { className: 'wsh-editor-wrap' },
            React.createElement('span', { className: 'wsh-label' }, '编辑'),
            React.createElement('textarea', {
              className: 'wsh-editor', defaultValue: data.text, spellCheck: false,
              onInput: (event) => onSave.draft(file, event.target.value),
            })))
        : mode === 'edit' ? React.createElement('textarea', {
          className: 'wsh-editor', defaultValue: data.text, spellCheck: false,
          onInput: (event) => onSave.draft(file, event.target.value),
        })
        : /\.(diff|patch)$/i.test(file.path) ? React.createElement(DiffView, { text: data.text })
        : React.createElement('pre', { className: 'wsh-preview-code' }, data.text),
      data.truncated ? React.createElement('div', { className: 'wsh-tree-empty' }, '文件过大，已截断预览。') : null)
      : data.kind === 'image' ? React.createElement('div', { className: 'wsh-preview-body' },
        React.createElement('img', { className: 'wsh-preview-img', src: data.dataUrl, alt: data.name }))
      : data.kind === 'binary' && data.base64 ? React.createElement('div', { className: 'wsh-preview-body' },
        data.mime === 'application/pdf'
          ? React.createElement('iframe', { className: 'wsh-preview-frame', title: data.name, src: `data:application/pdf;base64,${data.base64}` })
          : React.createElement('div', { className: 'wsh-tree-empty' },
            '该格式暂不支持内嵌预览。',
            React.createElement('br'),
            React.createElement('a', {
              className: 'wsh-link',
              href: `data:${data.mime ?? 'application/octet-stream'};base64,${data.base64}`,
              download: data.name,
            }, '下载文件')))
      : React.createElement('div', { className: 'wsh-tree-empty' }, '该文件类型不支持预览。'))
}

// ── SCM（变更面板）──────────────────────────────────────────────────────────
function ScmPanel({ root }) {
  const [status, setStatus] = React.useState(null)
  const [diff, setDiff] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [selected, setSelected] = React.useState(null)

  const loadStatus = React.useCallback(async () => {
    try {
      const data = await api('GET', '/git/status', undefined, { root })
      setStatus(data)
      setError(null)
    } catch (cause) {
      setStatus({ isRepo: false, changes: [] })
      setError(String(cause?.message ?? cause))
    }
  }, [root])
  React.useEffect(() => { loadStatus() }, [loadStatus])

  const showDiff = async (path) => {
    setSelected(path)
    setDiff(null)
    const change = status.changes.find((item) => item.path === path)
    try {
      const data = await api('GET', '/git/diff', undefined, { root, path, staged: change?.staged ? '1' : '0' })
      setDiff(data)
    } catch (cause) {
      setError(String(cause?.message ?? cause))
    }
  }

  const act = async (op, change) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (op === 'stage') await api('POST', '/git/stage', { root, paths: [change.path] })
      if (op === 'unstage') await api('POST', '/git/unstage', { root, paths: [change.path] })
      if (op === 'discard') await api('POST', '/git/discard', { root, changes: [change] })
      setSelected(null)
      setDiff(null)
      await loadStatus()
    } catch (cause) {
      setError(String(cause?.message ?? cause))
    } finally {
      setBusy(false)
    }
  }

  if (!status) return React.createElement('div', { className: 'wsh-tree-empty' }, '正在读取仓库状态…')
  if (!status.isRepo) return React.createElement('div', { className: 'wsh-tree-empty' }, '当前目录不是 Git 仓库。')
  const groups = [
    { label: '已暂存', items: status.changes.filter((change) => change.staged) },
    { label: '未暂存', items: status.changes.filter((change) => change.worktree && !change.staged && !change.untracked) },
    { label: '未跟踪', items: status.changes.filter((change) => change.untracked) },
  ]
  return React.createElement('div', { className: 'wsh-scm' },
    React.createElement('div', { className: 'wsh-scm-head' },
      React.createElement('span', { className: 'wsh-label' }, `分支 ${status.branch || '—'}`),
      React.createElement('span', { className: 'wsh-tag' }, `${status.changes.length} 项变更`),
      React.createElement('span', { className: 'wsh-spacer' }),
      React.createElement('button', { className: 'wsh-btn mini', onClick: loadStatus, disabled: busy }, '刷新')),
    error ? React.createElement('div', { className: 'wsh-tree-empty' }, error) : null,
    React.createElement('div', { className: 'wsh-scm-list' },
      status.changes.length === 0 ? React.createElement('div', { className: 'wsh-scm-empty' }, '工作区干净。') : null,
      groups.filter((group) => group.items.length).map((group) => React.createElement(React.Fragment, { key: group.label },
        React.createElement('div', { className: 'wsh-label', style: { padding: '6px 9px 2px' } }, group.label),
        group.items.map((change) => React.createElement('div', {
          key: change.path,
          className: `wsh-scm-file${selected === change.path ? ' selected' : ''}`,
          onClick: () => showDiff(change.path),
        },
          React.createElement('span', { className: `wsh-code${change.staged ? ' staged' : change.untracked ? ' untracked' : ' modified'}` }, change.staged ? 'A' : change.untracked ? '?' : 'M'),
          React.createElement('span', { className: 'wsh-scm-name', title: change.path }, change.path),
          React.createElement('span', { className: 'wsh-scm-actions', onClick: (event) => event.stopPropagation() },
            change.staged
              ? React.createElement('button', { className: 'wsh-btn mini', title: '取消暂存', onClick: () => act('unstage', change) }, 'unstage')
              : React.createElement('button', { className: 'wsh-btn mini', title: '暂存', onClick: () => act('stage', change) }, 'stage'),
            React.createElement('button', { className: 'wsh-btn mini danger', title: '放弃更改', onClick: () => act('discard', change) }, 'discard'))))))),
    selected ? React.createElement('div', { className: 'wsh-scm-diff' },
      React.createElement('div', { className: 'wsh-scm-head' },
        React.createElement('span', { className: 'wsh-preview-name' }, selected),
        React.createElement('button', { className: 'wsh-btn mini', onClick: () => setSelected(null) }, '×')),
      diff ? React.createElement('pre', null, diff.text || '（无差异）') : React.createElement('div', { className: 'wsh-tree-empty' }, '读取差异中…')) : null)
}

// ── 面板容器 ────────────────────────────────────────────────────────────────
function PanelContainer() {
  const ui = useExternal(panelUi, (state) => state)
  const settings = useExternal(runtimeRefs.settings, (state) => state)
  const [openFiles, setOpenFiles] = React.useState([])
  const [activePath, setActivePath] = React.useState(null)
  const [savedAt, setSavedAt] = React.useState(null)
  const draftRef = React.useRef(null)

  if (!ui.sessionId || !ui.ready) return null
  if (settings?.panel?.enabled === false) return null

  const openFile = async (path, size) => {
    setActivePath(path)
    if (openFiles.some((item) => item.path === path)) return
    setOpenFiles((files) => [...files, { path, mode: 'source', data: null }])
    try {
      const data = await api('GET', '/fs/read', undefined, { root: ui.root, path })
      setOpenFiles((files) => files.map((item) => (item.path === path ? { ...item, data } : item)))
    } catch (cause) {
      setOpenFiles((files) => files.map((item) => (item.path === path ? { ...item, data: { kind: 'error', error: String(cause?.message ?? cause) } } : item)))
    }
  }

  const closeFile = (path) => {
    setOpenFiles((files) => {
      const next = files.filter((item) => item.path !== path)
      if (activePath === path) setActivePath(next[next.length - 1]?.path ?? null)
      return next
    })
  }

  const setMode = (mode) => {
    setOpenFiles((files) => files.map((item) => (item.path === activePath ? { ...item, mode } : item)))
  }

  const saveFile = async (file) => {
    try {
      await api('POST', '/fs/write', { root: ui.root, path: file.path, content: draftRef.current ?? file.data?.text ?? '' })
      setSavedAt(Date.now())
      setTimeout(() => setSavedAt(null), 2500)
    } catch (cause) {
      console.error('[wishadel] 保存失败:', cause)
    }
  }
  saveFile.draft = (file, text) => { draftRef.current = text }

  const handleDrag = (event) => {
    event.preventDefault()
    const move = (moveEvent) => {
      panelUi.setWidth(Math.min(900, Math.max(260, window.innerWidth - moveEvent.clientX)))
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  if (ui.collapsed || !ui.open) {
    return React.createElement('div', {
      className: 'wsh-surface wsh-panel',
      style: { position: 'fixed', top: 0, right: 0, bottom: 0, width: 26, zIndex: 8000, cursor: 'pointer' },
      onClick: () => panelUi.setCollapsed(false),
      title: '展开右侧面板',
    },
      React.createElement('div', { className: 'wsh-label', style: { writingMode: 'vertical-rl', margin: '10px auto', color: 'var(--w-red-hot)' } }, 'PANEL ▮'))
  }

  return React.createElement('div', {
    className: 'wsh-surface wsh-panel',
    style: { position: 'fixed', top: 0, right: 0, bottom: 0, width: ui.width, zIndex: 8000 },
    role: 'region', 'aria-label': '项目面板',
  },
    React.createElement('div', { className: 'wsh-panel-handle', onPointerDown: handleDrag, onDoubleClick: () => panelUi.resetWidth(settings?.panel?.defaultWidth ?? 380), title: '拖拽调整宽度，双击复位' }),
    React.createElement('div', { className: 'wsh-panel-head' },
      React.createElement('button', { className: `wsh-panel-tab${ui.tab === 'preview' ? ' active' : ''}`, onClick: () => panelUi.setTab('preview') }, '预览'),
      React.createElement('button', { className: `wsh-panel-tab${ui.tab === 'scm' ? ' active' : ''}`, onClick: () => panelUi.setTab('scm') }, '文件/变更'),
      React.createElement('button', { className: 'wsh-btn mini', title: '收起面板', onClick: () => panelUi.setCollapsed(true) }, '›')),
    React.createElement('div', { className: 'wsh-panel-body' },
      ui.tab === 'preview' ? React.createElement('div', { style: { display: 'flex', minHeight: 0 } },
        React.createElement('div', { style: { width: '46%', minWidth: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--w-line)' } },
          React.createElement(FileTree, { root: ui.root, onOpen: openFile, activePath })),
        React.createElement('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } },
          openFiles.length ? React.createElement('div', { className: 'wsh-panel-head', style: { padding: '4px 6px 0', overflowX: 'auto' } },
            openFiles.map((file) => React.createElement('button', {
              key: file.path,
              className: `wsh-panel-tab${activePath === file.path ? ' active' : ''}`,
              style: { flex: 'none', maxWidth: 150, overflow: 'hidden' },
              title: file.path,
              onClick: () => setActivePath(file.path),
            }, file.path.split('/').pop()))) : null,
          React.createElement(PreviewArea, {
            root: ui.root, openFiles, activePath,
            onMode: setMode, onSave: saveFile, onClose: closeFile, savedAt,
          })))
        : React.createElement(ScmPanel, { root: ui.root })))
}

function installPanel(ctx, settingsStore) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  ctx.effect(() => slots.inject('conversation.session.header.actions', () => slots.register({
    name: 'conversation.session.header.actions',
    id: 'wishadel-panel-toggle',
    order: 60,
    label: '右侧面板',
  }, PanelToggle)), 'wishadel: panel toggle')
  ctx.effect(() => slots.inject('shell.overlay', () => slots.register({
    name: 'shell.overlay',
    id: 'wishadel-panel-overlay',
    order: 10,
    label: '右侧面板',
  }, PanelContainer)), 'wishadel: panel container')
}
