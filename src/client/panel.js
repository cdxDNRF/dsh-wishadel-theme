// 右侧面板：文件树 + 多格式预览 + Git 变更（SCM）。
// 通过 conversation.session.header.actions 的开关按钮与 shell.overlay 的停靠容器协作；
// 宽度可拖拽（双击复位），折叠与宽度按项目（workspace root）持久化到宿主。

const panelUi = (() => {
  let state = { sessionId: null, root: '', open: false, width: 480, collapsed: false, bottomOpen: false, bottomHeight: 260, bottomTab: 'activity', tab: 'preview', browserUrl: 'https://example.com', openPaths: [], activePath: null, ready: false }
  const listeners = new Set()
  let persistTimer = null
  let pendingAttach = null
  let attachGeneration = 0
  const notify = () => listeners.forEach((fn) => fn())
  const persist = () => {
    if (!state.root) return
    clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      api('POST', '/panel-state', { root: state.root, sessionId: state.sessionId, state: {
        width: state.width, collapsed: state.collapsed, tab: state.tab, bottomTab: state.bottomTab, browserUrl: state.browserUrl,
        openPaths: state.openPaths.slice(0, 30), activePath: state.activePath,
         bottomOpen: state.bottomOpen, bottomHeight: state.bottomHeight,
      } }).catch(() => {})
    }, 400)
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    attach: (sessionId, root, defaults) => {
      if (state.sessionId === sessionId && state.root === root && state.ready) return
      const attachKey = `${sessionId}\u0000${root}`
      if (pendingAttach !== null && pendingAttach.key === attachKey) return
      const generation = ++attachGeneration
      const operation = (async () => {
        let saved = null
        try {
          const data = await api('GET', '/panel-state', undefined, { root, sessionId })
          saved = data.state
        } catch { /* 使用默认值 */ }
        if (generation !== attachGeneration) return
        const collapsed = saved ? Boolean(saved.collapsed) : true
        state = {
          sessionId, root, ready: true,
          tab: saved?.tab === 'scm' ? 'git' : (saved?.tab ?? 'preview'),
          bottomTab: saved?.bottomTab === 'terminal' ? 'terminal' : 'activity',
          browserUrl: typeof saved?.browserUrl === 'string' ? saved.browserUrl : 'https://example.com',
          width: saved?.width ?? defaults?.defaultWidth ?? 480,
          collapsed,
          // 新会话没有自己的持久化状态时默认收起；不因 root/default 状态自动展开。
          open: !collapsed && Boolean(saved),
          openPaths: Array.isArray(saved?.openPaths) ? saved.openPaths.filter((path) => typeof path === 'string').slice(0, 30) : [],
          activePath: typeof saved?.activePath === 'string' ? saved.activePath : null,
          bottomOpen: Boolean(saved?.bottomOpen), bottomHeight: saved?.bottomHeight ?? 260,
        }
        pendingAttach = null
        notify()
      })()
      pendingAttach = { key: attachKey, operation }
    },
    detach: () => {
      if (!state.sessionId && !state.root) return
      attachGeneration += 1
      pendingAttach = null
      state = { ...state, sessionId: null, root: '', ready: false, open: false }
      notify()
    },
    toggle: () => { state = { ...state, open: !state.open, collapsed: state.open ? state.collapsed : false }; notify(); persist() },
    setCollapsed: (collapsed) => { state = { ...state, collapsed, open: !collapsed }; notify(); persist() },
    setWidth: (width) => { state = { ...state, width }; notify(); persist() },
    resetWidth: (defaultWidth) => { state = { ...state, width: defaultWidth ?? 480 }; notify(); persist() },
    setTab: (tab) => { state = { ...state, tab }; notify(); persist() },
     setBottomTab: (bottomTab) => { state = { ...state, bottomTab: bottomTab === 'terminal' ? 'terminal' : 'activity' }; notify(); persist() },
     setBrowserUrl: (browserUrl) => { state = { ...state, browserUrl: String(browserUrl ?? '').slice(0, 2000) }; notify(); persist() },
     setFiles: (openPaths, activePath) => { state = { ...state, openPaths: openPaths.slice(0, 30), activePath: activePath ?? null }; notify(); persist() },
    toggleBottom: () => { state = { ...state, bottomOpen: !state.bottomOpen }; notify(); persist() },
    setBottomHeight: (height) => { state = { ...state, bottomHeight: Math.min(560, Math.max(150, height)) }; notify(); persist() },
    syncDefaults: (defaults) => {
      if (state.width === undefined) { state = { ...state, width: defaults?.defaultWidth ?? 480 }; notify() }
    },
  }
})()

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
    title: ui.collapsed ? '展开右侧面板' : ui.open ? '收起右侧面板' : '展开右侧面板（预览 / 文件与变更）',
    onClick: () => {
      // 折叠态下 toggle 会被 collapsed 吞掉：必须显式展开。
      if (ui.collapsed) panelUi.setCollapsed(false)
      else panelUi.toggle()
    },
    'aria-pressed': ui.open && !ui.collapsed,
  }, ui.open && !ui.collapsed ? '▮ 面板' : '面板')
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

  const toggleDir = async (full, _entry) => {
    const next = new Set(expanded)
    if (next.has(full)) { next.delete(full); setExpanded(next); return }
    next.add(full)
    setExpanded(next)
    if (!childrenCache[full]) await load(full, true)
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

  const renderRows = (entries, depth, parentPath) => entries.map((entry) => {
    const full = joinPath(parentPath, entry.name)
    const isDir = entry.type === 'directory'
    const isOpen = expanded.has(full)
    const kids = childrenCache[full]?.entries ?? []
    return React.createElement(React.Fragment, { key: full },
      React.createElement('div', {
        className: `wsh-tree-row${activePath === full ? ' selected' : ''}`,
        'data-kind': isDir ? 'dir' : 'file',
        'data-ext': isDir ? '' : (entry.name.split('.').pop() ?? '').toLowerCase().slice(0, 8),
        style: { paddingLeft: 10 + depth * 12 },
        onClick: () => (isDir ? toggleDir(full, entry) : onOpen(full, entry.size)),
      },
        React.createElement('span', { className: 'wsh-tree-chevron', 'aria-hidden': 'true' }, isDir ? (isOpen ? '▾' : '▸') : ''),
         React.createElement('span', { className: `wsh-tree-icon${isDir ? ' wsh-tree-folder-icon' : ' wsh-tree-file-icon'}`, 'aria-hidden': 'true' }, isDir ? '■' : '•'),
        React.createElement('span', { className: 'wsh-tree-name' }, entry.name),
        entry.size !== undefined ? React.createElement('span', { className: 'wsh-tree-size' }, humanSize(entry.size)) : null),
      isDir && isOpen ? renderRows(kids, depth + 1, full) : null)
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
      renderRows(Array.isArray(visible) ? visible : [], 0, '.')),
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

// JSON 美化预览（解析失败退回原文）。
function JsonView({ text }) {
  let pretty = text
  try { pretty = JSON.stringify(JSON.parse(text), null, 2) } catch { /* 保持原文 */ }
  return React.createElement('pre', { className: 'wsh-preview-code' }, pretty)
}

function PreviewArea({ root, openFiles, activePath, onMode, onSave, onClose, savedAt }) {
  const file = openFiles.find((item) => item.path === activePath)
  if (!file || !file.data) {
    return React.createElement('div', { className: 'wsh-tree-empty' }, '点击左侧文件即可预览。')
  }
  const data = file.data
  const mode = file.mode ?? 'source'
  const viewer = runtimeRefs.workbench?.matchFileViewer?.(file.path)
  if (viewer?.component && viewer.id !== 'code' && viewer.id !== 'text') {
    try { return viewer.component({ React, path: file.path, title: data.name ?? file.path, content: data.text, data, api }) } catch (cause) { return React.createElement('div', { className: 'wsh-tree-empty' }, `viewer 渲染失败：${String(cause?.message ?? cause)}`) }
  }
  // 读取失败：显示真实原因，而不是误导性的「不支持」。
  if (data.kind === 'error') {
    return React.createElement('div', { className: 'wsh-preview' },
      React.createElement('div', { className: 'wsh-preview-bar' },
        React.createElement('span', { className: 'wsh-preview-name', title: file.path }, file.path),
        React.createElement('button', { className: 'wsh-btn mini', style: { marginLeft: 'auto' }, onClick: () => onClose(file.path) }, '×')),
      React.createElement('div', { className: 'wsh-tree-empty' },
        `读取失败：${data.error ?? '未知错误'}`,
        React.createElement('br'),
        React.createElement('span', { className: 'wsh-hint' }, '若提示宿主服务未就绪，请重启 dsh web 后重试。')))
  }
  return React.createElement('div', { className: 'wsh-preview' },
    React.createElement('div', { className: 'wsh-preview-bar' },
      React.createElement('span', { className: 'wsh-preview-name', title: file.path }, file.path),
      data.size !== undefined ? React.createElement('span', { className: 'wsh-hint' }, humanSize(data.size)) : null,
      data.kind === 'text' ? React.createElement(React.Fragment, null,
        React.createElement('button', { className: `wsh-btn mini${mode === 'source' ? ' primary' : ''}`, onClick: () => onMode('source') }, '源码'),
        /\.(md|markdown)$/i.test(file.path) ? React.createElement('button', { className: `wsh-btn mini${mode === 'md' ? ' primary' : ''}`, onClick: () => onMode('md') }, '预览') : null,
        /\.(md|markdown)$/i.test(file.path) ? React.createElement('button', { className: `wsh-btn mini${mode === 'split' ? ' primary' : ''}`, onClick: () => onMode('split') }, '分屏') : null,
        React.createElement('button', { className: `wsh-btn mini${mode === 'edit' ? ' primary' : ''}`, onClick: () => onMode('edit') }, '编辑')) : null,
      data.kind === 'text' && (mode === 'edit' || mode === 'split') ? React.createElement('button', { className: 'wsh-btn mini primary', onClick: () => onSave(file) }, '保存') : null,
      data.base64 ? React.createElement('a', {
        className: 'wsh-btn mini',
        style: { textDecoration: 'none' },
        href: `data:${data.mime ?? 'application/octet-stream'};base64,${data.base64}`,
        download: data.name,
      }, '下载') : null,
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
        : /\.csv$/i.test(file.path) ? React.createElement(CsvView, { text: data.text })
        : /\.json$/i.test(file.path) ? React.createElement(JsonView, { text: data.text })
        : React.createElement('pre', { className: 'wsh-preview-code' }, data.text),
      data.truncated ? React.createElement('div', { className: 'wsh-tree-empty' }, `文件过大，仅预览前 ${humanSize(Number(data.size) || 0)}（已截断）。`) : null)
      : data.kind === 'image' ? React.createElement('div', { className: 'wsh-preview-body' },
        React.createElement('img', { className: 'wsh-preview-img', src: data.dataUrl, alt: data.name }))
      : data.kind === 'binary' ? React.createElement('div', { className: 'wsh-preview-body' },
        data.mime === 'application/pdf' && data.base64
          ? React.createElement('iframe', { className: 'wsh-preview-frame', title: data.name, src: `data:application/pdf;base64,${data.base64}` })
          : React.createElement('div', { className: 'wsh-tree-empty' },
            `二进制文件（${data.mime ?? 'application/octet-stream'}），浏览器无法内嵌预览。`,
            data.base64 ? React.createElement(React.Fragment, null,
              React.createElement('br'),
              React.createElement('a', {
                className: 'wsh-link',
                href: `data:${data.mime ?? 'application/octet-stream'};base64,${data.base64}`,
                download: data.name,
              }, '下载文件')) : null,
            data.truncated ? React.createElement('div', { className: 'wsh-hint' }, '文件超过预览上限，未载入内容。') : null))
      : React.createElement('div', { className: 'wsh-tree-empty' }, `该文件（${data.name ?? file.path}）暂无可预览内容。`))
}

// ── SCM（变更面板）──────────────────────────────────────────────────────────
function ScmPanel({ root }) {
  const [status, setStatus] = React.useState(null)
  const [diff, setDiff] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [selected, setSelected] = React.useState(null)
  const [commitMessage, setCommitMessage] = React.useState('')

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

  const commit = async () => {
    if (busy || !commitMessage.trim()) return
    setBusy(true); setError(null)
    try {
      const result = await api('POST', '/git/commit', { root, message: commitMessage.trim() })
      if (!result.ok) throw new Error(result.error || '提交失败')
      setCommitMessage(''); await loadStatus()
    } catch (cause) { setError(String(cause?.message ?? cause)) } finally { setBusy(false) }
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
      React.createElement('button', { className: 'wsh-btn mini', onClick: loadStatus, disabled: busy }, '刷新'),
       React.createElement('input', { className: 'wsh-scm-commit-input', value: commitMessage, placeholder: '提交信息…', onChange: (event) => setCommitMessage(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter') commit() } }),
       React.createElement('button', { className: 'wsh-btn mini primary', onClick: commit, disabled: busy || !commitMessage.trim() }, '提交')),
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

// ── Workbench tabs ───────────────────────────────────────────────────────────
const PANEL_TABS = [
  { id: 'preview', label: '文件' },
  { id: 'git', label: 'Git' },
  { id: 'browser', label: '浏览器' },
  { id: 'terminal', label: '终端' },
  { id: 'activity', label: '活动' },
]

function BrowserPanel(props) {
  const initialUrl = props.initialUrl || 'https://example.com'
  const [url, setUrl] = React.useState(initialUrl)
  const [src, setSrc] = React.useState(initialUrl)
  const [history, setHistory] = React.useState([initialUrl])
  const [cursor, setCursor] = React.useState(0)
  const [error, setError] = React.useState(null)
  const settings = useExternal(runtimeRefs.settings, (state) => state)
  const unsafe = settings?.panel?.browserNoSandbox === true
  React.useEffect(() => {
    if (typeof props.initialUrl === 'string' && props.initialUrl !== src) {
      setUrl(props.initialUrl)
      setSrc(props.initialUrl)
      setHistory([props.initialUrl])
      setCursor(0)
    }
  }, [props.initialUrl])
  const navigate = (raw = url) => {
    const value = String(raw ?? '').trim()
    try {
      const parsed = new URL(value)
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('仅支持 http/https 地址')
      if (parsed.hostname === 'localhost' || parsed.hostname === '::1' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(parsed.hostname)) throw new Error('为安全起见不允许访问本机地址')
      const next = parsed.href
      setError(null); setSrc(next); setUrl(next)
      props.onNavigate?.(next)
      setHistory((items) => [...items.slice(0, cursor + 1), next])
      setCursor((value) => value + 1)
    } catch (cause) { setError(String(cause?.message ?? cause)) }
  }
  const go = (delta) => {
    const next = cursor + delta
    if (next < 0 || next >= history.length) return
    setCursor(next); setSrc(history[next]); setUrl(history[next]); setError(null)
  }
  const external = () => { try { window.open(src, '_blank', 'noopener,noreferrer') } catch {} }
  return React.createElement('div', { className: 'wsh-browser' },
    React.createElement('div', { className: 'wsh-browser-toolbar' },
      React.createElement('button', { className: 'wsh-btn mini', onClick: () => go(-1), title: '后退' }, '←'),
      React.createElement('button', { className: 'wsh-btn mini', onClick: () => go(1), title: '前进' }, '→'),
      React.createElement('button', { className: 'wsh-btn mini', onClick: () => setSrc((value) => `${value}`), title: '重新加载' }, '↻'),
      React.createElement('input', { className: 'wsh-browser-url', value: url, onChange: (event) => setUrl(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter') navigate() }, 'aria-label': '浏览器地址' }),
      React.createElement('button', { className: 'wsh-btn mini primary', onClick: navigate }, '打开'),
      React.createElement('button', { className: 'wsh-btn mini', onClick: external, title: '在新窗口打开' }, '↗')),
    error ? React.createElement('div', { className: 'wsh-browser-error' }, error) : null,
    React.createElement('div', { className: unsafe ? 'wsh-browser-warning' : 'wsh-browser-safe' }, unsafe ? '⚠ 浏览器沙箱已关闭，仅访问完全信任的页面。' : 'SANDBOX // OPAQUE ORIGIN'),
     React.createElement('iframe', { className: 'wsh-browser-frame', src, title: '沙盒浏览器', referrerPolicy: 'no-referrer', allow: '', sandbox: unsafe ? undefined : 'allow-forms allow-modals allow-popups allow-downloads allow-scripts allow-popups-to-escape-sandbox' }))
}

function TerminalPanel() {
  const settings = useExternal(runtimeRefs.settings, (state) => state)
  const [terminal, setTerminal] = React.useState(null)
  const [output, setOutput] = React.useState('')
  const [input, setInput] = React.useState('')
  const [error, setError] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const start = async () => {
    if (terminal) return
    setBusy(true); setError(null)
    try { const data = await api('POST', '/terminal/start', { sessionId: panelUi.getSnapshot().sessionId, cwd: panelUi.getSnapshot().root, shell: settings?.panel?.terminalShell || undefined }); setTerminal(data.terminal ?? data); setOutput('') }
    catch (cause) { setError(String(cause?.message ?? cause)) } finally { setBusy(false) }
  }
  React.useEffect(() => {
    let stopped = false
    const poll = async () => {
      if (!terminal || stopped) return
      try { const data = await api('GET', '/terminal/read', undefined, { id: terminal.id, sessionId: panelUi.getSnapshot().sessionId, cursor: terminal.cursor ?? 0 }); if (data.data) { setOutput((value) => value + data.data); setTerminal((current) => ({ ...current, cursor: data.cursor, closed: data.closed })) } }
      catch (cause) { if (!stopped) setError(String(cause?.message ?? cause)) }
    }
    const timer = terminal ? setInterval(poll, 700) : null
    poll()
    return () => { stopped = true; if (timer) clearInterval(timer) }
  }, [terminal])
  const write = async () => { if (!terminal || !input) return; await api('POST', '/terminal/write', { id: terminal.id, sessionId: panelUi.getSnapshot().sessionId, data: `${input}\n` }); setInput('') }
  const close = async () => { if (!terminal) return; await api('POST', '/terminal/close', { id: terminal.id, sessionId: panelUi.getSnapshot().sessionId }).catch(() => {}); setTerminal(null) }
  return React.createElement('div', { className: 'wsh-terminal' },
    React.createElement('div', { className: 'wsh-terminal-toolbar' },
      React.createElement('span', { className: 'wsh-label' }, terminal ? `终端 ${terminal.id}` : '终端未启动'),
      React.createElement('span', { className: 'wsh-spacer' }),
      React.createElement('button', { className: 'wsh-btn mini primary', onClick: start, disabled: busy || Boolean(terminal) }, terminal ? '运行中' : '启动'),
      React.createElement('button', { className: 'wsh-btn mini', onClick: () => setOutput(''), disabled: !output }, '清空'),
      React.createElement('button', { className: 'wsh-btn mini danger', onClick: close, disabled: !terminal }, '停止')),
    error ? React.createElement('div', { className: 'wsh-browser-error' }, error) : null,
    React.createElement('pre', { className: 'wsh-terminal-output', 'aria-live': 'polite' }, output || '等待终端输出…'),
    React.createElement('form', { className: 'wsh-terminal-input', onSubmit: (event) => { event.preventDefault(); write() } },
      React.createElement('span', null, '›'), React.createElement('input', { value: input, onChange: (event) => setInput(event.target.value), placeholder: '输入命令…', disabled: !terminal, 'aria-label': '终端输入' })))
}

function ActivityPanel() {
  const data = useExternal(runtimeRefs.tasks, (state) => state)
  const live = data?.live ?? data?.snapshot?.live ?? []
  const tasks = data?.tasks ?? data?.snapshot?.tasks ?? []
  const activity = data?.activity ?? data?.snapshot?.activity ?? []
  const rows = [...activity.map((item) => ({ ...item, live: item.status === 'running' })), ...live.map((item) => ({ ...item, live: true })), ...tasks.map((item) => ({ ...item, live: false }))]
  const [jobOutput, setJobOutput] = React.useState(null)
  const [jobBusy, setJobBusy] = React.useState(false)
  const [armedJob, setArmedJob] = React.useState(null)
  React.useEffect(() => {
    if (!armedJob) return undefined
    const timer = setTimeout(() => setArmedJob(null), 3000)
    return () => clearTimeout(timer)
  }, [armedJob])
  const killJob = async (sessionId, jobId) => {
    const key = `${sessionId}:${jobId}`
    if (armedJob !== key) { setArmedJob(key); return }
    setJobBusy(true)
    try { await api('POST', '/jobs/kill', { sessionId, jobId }) } catch (cause) { setJobOutput({ sessionId, jobId, error: String(cause?.message ?? cause) }) }
    finally { setArmedJob(null); setJobBusy(false) }
  }
  const loadJob = async (sessionId, jobId) => {
    setJobBusy(true)
    try {
      const result = await api('GET', '/jobs/output', undefined, { sessionId, jobId })
      setJobOutput({ sessionId, jobId, ...result })
    } catch (cause) { setJobOutput({ sessionId, jobId, error: String(cause?.message ?? cause) }) }
    finally { setJobBusy(false) }
  }
  const activityRows = rows.length ? rows.map((item, index) => {
    const label = item.title ?? item.preview ?? item.sessionId ?? item.id
    const jobs = Array.isArray(item.jobs) ? item.jobs : []
    return React.createElement(React.Fragment, { key: item.sessionId ?? item.id ?? index },
      React.createElement('div', { className: 'wsh-activity-row', 'data-session-id': item.sessionId },
        React.createElement('span', { className: `wsh-status-dot${item.status === 'failed' ? ' err' : item.status === 'done' || item.status === 'completed' ? ' ok' : ''}` }),
        React.createElement('span', { className: 'wsh-activity-name', title: label }, label),
        React.createElement('span', { className: 'wsh-tag' }, item.status ?? (item.live ? 'running' : 'queued')),
        item.sessionId ? React.createElement('button', { className: 'wsh-btn mini', onClick: () => openSession(item.sessionId) }, '打开会话') : null),
      jobs.map((job) => React.createElement('div', { className: 'wsh-job-row', key: `${item.sessionId}:${job.id}` },
        React.createElement('span', { className: 'wsh-status-dot' }),
        React.createElement('span', { className: 'wsh-activity-name', title: job.title ?? job.id }, job.title ?? job.id),
        React.createElement('span', { className: 'wsh-tag' }, job.status),
        React.createElement('button', { className: 'wsh-btn mini', onClick: () => loadJob(item.sessionId, job.id), disabled: jobBusy }, '输出'),
        React.createElement('button', { className: 'wsh-btn mini danger', onClick: () => killJob(item.sessionId, job.id), disabled: jobBusy }, armedJob === `${item.sessionId}:${job.id}` ? '再次终止' : '终止'))))
  }) : React.createElement('div', { className: 'wsh-tree-empty' }, '暂无活动会话。')
  return React.createElement('div', { className: 'wsh-activity' },
    React.createElement('div', { className: 'wsh-activity-head' }, React.createElement('span', { className: 'wsh-label' }, '运行时活动'), React.createElement('span', { className: 'wsh-tag live' }, `${live.length} LIVE`)),
    activityRows,
    jobOutput ? React.createElement('div', { className: 'wsh-job-output' },
      React.createElement('div', { className: 'wsh-activity-head' }, React.createElement('span', { className: 'wsh-label' }, `JOB ${jobOutput.jobId}`), React.createElement('button', { className: 'wsh-btn mini', onClick: () => setJobOutput(null) }, '关闭')),
      React.createElement('pre', null, jobOutput.error ?? (jobOutput.read ? (jobOutput.text || '暂无新输出') : '等待模型读取任务输出。'))) : null)
}

// ── 面板容器 ────────────────────────────────────────────────────────────────
function PanelContainer() {
  const ui = useExternal(panelUi, (state) => state)
  const settings = useExternal(runtimeRefs.settings, (state) => state)
  const [openFiles, setOpenFiles] = React.useState([])
  const [activePath, setActivePath] = React.useState(null)
  const [savedAt, setSavedAt] = React.useState(null)
  const draftRef = React.useRef(null)
  const restoringRef = React.useRef(false)
  const restoreKey = `${ui.sessionId}\u0000${ui.root}`
  React.useEffect(() => {
    if (!ui.ready || !ui.sessionId) return
    restoringRef.current = true
    let cancelled = false
    const paths = Array.isArray(ui.openPaths) ? ui.openPaths : []
    setOpenFiles([]); setActivePath(ui.activePath ?? null)
    Promise.all(paths.map(async (path) => {
      try { return { path, mode: 'source', data: await api('GET', '/fs/read', undefined, { root: ui.root, path }) } }
      catch (cause) { return { path, mode: 'source', data: { kind: 'error', error: String(cause?.message ?? cause) } } }
    })).then((files) => { if (!cancelled) { setOpenFiles(files); restoringRef.current = false } })
    return () => { cancelled = true }
  }, [restoreKey])
  React.useEffect(() => {
    if (!ui.ready) return
    const paths = openFiles.map((file) => file.path)
    if (!restoringRef.current && (paths.join('\u0000') !== (ui.openPaths ?? []).join('\u0000') || activePath !== ui.activePath)) {
      panelUi.setFiles(paths, activePath)
    }
  }, [openFiles, activePath, ui.ready])

  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape' && panelUi.getSnapshot().open) panelUi.setCollapsed(true)
      if (event.ctrlKey && event.altKey && /^[1-5]$/.test(event.key)) {
        // 快捷键跟随当前可见标签（「活动」默认关闭时第 5 键落到终端）。
        const tabs = wishadelSuperseded('activityTab') ? PANEL_TABS : PANEL_TABS.filter((tab) => tab.id !== 'activity')
        const target = tabs[Number(event.key) - 1]
        if (target) panelUi.setTab(target.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
      panelUi.setWidth(Math.min(1100, Math.max(320, window.innerWidth - moveEvent.clientX)))
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
      style: { position: 'fixed', top: 0, right: 'var(--wsh-panel-inset, 14px)', bottom: 0, width: 42, zIndex: 10, cursor: 'default' },
      onClick: () => panelUi.setCollapsed(false),
      title: '展开右侧面板',
    },
      React.createElement('button', { className: 'wsh-panel-rail-open', type: 'button', onClick: () => panelUi.setCollapsed(false), title: '展开工作台', 'aria-label': '展开工作台' }, '‹'),
      React.createElement('div', { className: 'wsh-label wsh-panel-rail-label' }, 'WORKBENCH'))
  }

  const renderTab = () => {
    const custom = runtimeRefs.workbench?.getTab?.(ui.tab)
    if (custom?.component) return custom.component({ React, tab: { id: ui.tab, type: ui.tab, title: custom.title ?? ui.tab }, scope: { sessionId: ui.sessionId, cwd: ui.root }, api })
    return ui.tab === 'preview'
    ? React.createElement('div', { className: 'wsh-preview-layout' },
      React.createElement('div', { className: 'wsh-filetree-pane' }, React.createElement(FileTree, { root: ui.root, onOpen: openFile, activePath })),
      React.createElement('div', { className: 'wsh-preview-pane' },
        openFiles.length ? React.createElement('div', { className: 'wsh-file-tabs', role: 'tablist', 'aria-label': '已打开文件' }, openFiles.map((file) => React.createElement('div', { key: file.path, className: `wsh-file-tab${activePath === file.path ? ' active' : ''}` },
          React.createElement('button', { className: 'wsh-file-tab-main', role: 'tab', 'aria-selected': activePath === file.path, title: file.path, onClick: () => setActivePath(file.path) }, file.path.split('/').pop()),
          React.createElement('button', { className: 'wsh-file-tab-close', type: 'button', title: '关闭文件', 'aria-label': `关闭 ${file.path}`, onClick: () => closeFile(file.path) }, '×')))) : null,
        React.createElement(PreviewArea, { root: ui.root, openFiles, activePath, onMode: setMode, onSave: saveFile, onClose: closeFile, savedAt })))
    : ui.tab === 'git' ? React.createElement(ScmPanel, { root: ui.root })
      : ui.tab === 'browser' ? React.createElement(BrowserPanel, { initialUrl: ui.browserUrl, onNavigate: (url) => panelUi.setBrowserUrl(url) })
        : ui.tab === 'terminal' || !activityEnabled ? React.createElement(TerminalPanel)
          : React.createElement(ActivityPanel)

  }

  // 「活动」标签被新版 DSH 原生会话头部任务列表取代：默认关闭（设置卡可开启）。
  const activityEnabled = settings?.superseded?.activityTab === true
  // 底部辅助区域的活动页同样跟随该开关；关闭时固定展示终端。
  const bottomTab = activityEnabled ? ui.bottomTab : 'terminal'
  const customTabs = runtimeRefs.workbench?.getTabs?.() ?? []
  const baseTabs = activityEnabled ? PANEL_TABS : PANEL_TABS.filter((tab) => tab.id !== 'activity')
  const allTabs = [...baseTabs, ...customTabs.filter((tab) => !PANEL_TABS.some((item) => item.id === tab.id)).map((tab) => ({ id: tab.id, label: typeof tab.title === 'function' ? tab.id : (tab.title ?? tab.id) }))]
  const tabButtons = allTabs.map((tab, index) => React.createElement('button', {
    key: tab.id, id: `wsh-tab-${tab.id}`, className: `wsh-panel-tab${ui.tab === tab.id ? ' active' : ''}`,
    role: 'tab', 'aria-selected': ui.tab === tab.id, 'aria-controls': `wsh-panel-${tab.id}`, tabIndex: ui.tab === tab.id ? 0 : -1,
    title: `${tab.label}（Ctrl+Alt+${index + 1}）`, onClick: () => panelUi.setTab(tab.id),
    onKeyDown: (event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); const step = event.key === 'ArrowRight' ? 1 : -1; const next = allTabs[(index + step + allTabs.length) % allTabs.length]; panelUi.setTab(next.id); document.getElementById(`wsh-tab-${next.id}`)?.focus() } },
  }, tab.label))

  return React.createElement('div', {
    className: 'wsh-surface wsh-panel wsh-workbench-root', style: { position: 'fixed', top: 0, right: 'var(--wsh-panel-inset, 14px)', bottom: 0, width: ui.width, zIndex: 10 },
    role: 'region', 'aria-label': '项目工作台面板',
  },
    React.createElement('div', { className: 'wsh-panel-handle', onPointerDown: handleDrag, onDoubleClick: () => panelUi.resetWidth(settings?.panel?.defaultWidth ?? 480), title: '拖拽调整宽度，双击复位' }),
    React.createElement('div', { className: 'wsh-panel-head wsh-workbench-tabs', role: 'tablist', 'aria-label': '工作台视图' },
      tabButtons,
      React.createElement('span', { className: 'wsh-workbench-spacer' }),
       React.createElement('button', { className: 'wsh-panel-collapse', type: 'button', title: '收起工作台', onClick: () => panelUi.setCollapsed(true), 'aria-label': '收起工作台' }, '收起'),
       React.createElement('button', { className: 'wsh-panel-bottom-toggle', type: 'button', title: ui.bottomOpen ? '关闭底部面板' : '打开底部面板', onClick: () => panelUi.toggleBottom(), 'aria-pressed': ui.bottomOpen }, ui.bottomOpen ? '底部 −' : '底部 +')),
    React.createElement('div', { className: 'wsh-panel-body', id: `wsh-panel-${ui.tab}`, role: 'tabpanel', 'aria-labelledby': `wsh-tab-${ui.tab}` }, renderTab()),
    ui.bottomOpen ? React.createElement('div', { className: 'wsh-bottom-panel', style: { height: ui.bottomHeight } },
      React.createElement('div', { className: 'wsh-bottom-resize', onPointerDown: (event) => {
        event.preventDefault(); const start = event.clientY; const initial = ui.bottomHeight
        const move = (moveEvent) => panelUi.setBottomHeight(initial + start - moveEvent.clientY)
        const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop) }
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop)
      } }),
      React.createElement('div', { className: 'wsh-bottom-head' }, React.createElement('span', { className: 'wsh-label' }, '辅助区域'),
        React.createElement('button', { className: `wsh-btn mini${bottomTab === 'terminal' ? ' active' : ''}`, onClick: () => panelUi.setBottomTab('terminal') }, '终端'),
        activityEnabled ? React.createElement('button', { className: `wsh-btn mini${bottomTab === 'activity' ? ' active' : ''}`, onClick: () => panelUi.setBottomTab('activity') }, '活动') : null),
      React.createElement('div', { className: 'wsh-bottom-body' }, bottomTab === 'activity' && activityEnabled ? React.createElement(ActivityPanel) : React.createElement(TerminalPanel))) : null)
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



