// 会话「文件」标签页：在对话/轨迹标签后注入「文件」标签，
// 展示当前会话工作区的 git 变更文件（本会话的改动），支持：
//  - 审查：展开该文件的 diff；
//  - 还原：丢弃该文件的改动（回到 HEAD / 删除未跟踪文件）；
//  - 认可：把当前变更标记为已认可，从列表隐藏；文件再次变化会重新出现。
// 会话定位：侧栏选中行标题 → 宿主 /sessions-index（id + cwd）。

const filesUi = (() => {
  let state = { open: false }
  const listeners = new Set()
  const notify = () => listeners.forEach((fn) => fn())
  return {
    getSnapshot: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    open() { if (!state.open) { state = { open: true }; notify() } },
    close() { if (state.open) { state = { open: false }; notify() } },
  }
})()

const sessionMetaStore = (() => {
  let state = { map: new Map(), ready: false }
  const listeners = new Set()
  const notify = () => listeners.forEach((fn) => fn())
  return {
    getSnapshot: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    setMap(map) { state = { map, ready: true }; notify() },
  }
})()

let lastResolvedRoot = null

async function refreshSessionMeta() {
  try {
    const data = await api('GET', '/sessions-index')
    const map = new Map()
    for (const s of data.sessions ?? []) {
      if (typeof s?.title === 'string' && typeof s?.id === 'string') {
        map.set(s.title, { id: s.id, cwd: typeof s.cwd === 'string' ? s.cwd : undefined })
      }
    }
    sessionMetaStore.setMap(map)
  } catch { /* 宿主尚未更新路由时静默 */ }
}

function selectedRowTitle() {
  const row = document.querySelector('[role="treeitem"][aria-selected="true"]')
  if (!row) return null
  const titleEl = row.querySelector('[class*="title"]')
  const text = titleEl ? titleEl.textContent.trim() : null
  return text || null
}

function currentSessionMeta() {
  const title = selectedRowTitle()
  const meta = title ? sessionMetaStore.getSnapshot().map.get(title) : undefined
  if (meta && typeof meta.cwd === 'string' && meta.cwd.length > 0) lastResolvedRoot = meta.cwd
  return { id: meta?.id ?? '', root: meta?.cwd ?? lastResolvedRoot }
}

// ── 标签注入 ────────────────────────────────────────────────────────────
// 新版 DSH 每条消息尾部已有原生“产出文件”行：本标签页默认关闭（设置卡 superseded.sessionFiles 开启）。
function ensureFileTab() {
  if (!wishadelSuperseded('sessionFiles')) {
    document.querySelectorAll('.wsh-session-files-tab').forEach((tab) => tab.remove())
    return
  }
  const tablist = document.querySelector('[role="tablist"]')
  if (!tablist) return
  let tab = tablist.querySelector('.wsh-session-files-tab')
  if (!tab) {
    tab = document.createElement('button')
    tab.type = 'button'
    tab.className = 'wsh-session-files-tab'
    tab.setAttribute('role', 'tab')
    tab.textContent = '文件'
    tab.addEventListener('click', (event) => {
      event.stopPropagation()
      if (filesUi.getSnapshot().open) filesUi.close()
      else filesUi.open()
    })
    tablist.appendChild(tab)
  }
  tab.setAttribute('aria-selected', filesUi.getSnapshot().open ? 'true' : 'false')
}

function installFileTabWatch(ctx) {
  let timer = null
  const schedule = () => {
    if (timer !== null) return
    timer = setTimeout(() => { timer = null; ensureFileTab() }, 120)
  }
  const onDocClick = (event) => {
    // 点击宿主「对话/轨迹」标签时关闭文件视图
    const tab = event.target instanceof Element ? event.target.closest('[role="tab"]') : null
    if (tab && !tab.classList.contains('wsh-session-files-tab')) filesUi.close()
  }
  document.addEventListener('click', onDocClick, true)
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })
  schedule()
  // 设置变化时即时注入/移除「文件」标签。
  const unsubscribeSettings = runtimeRefs.settings?.subscribe?.(() => schedule()) ?? null
  const unsubscribe = filesUi.subscribe(() => schedule())
  ctx.effect(() => () => {
    observer.disconnect()
    if (unsubscribeSettings) unsubscribeSettings()
    unsubscribe()
    document.removeEventListener('click', onDocClick, true)
    if (timer !== null) clearTimeout(timer)
    document.querySelectorAll('.wsh-session-files-tab').forEach((tab) => tab.remove())
  }, 'wishadel: session files tab')
}

// ── 文件视图 ────────────────────────────────────────────────────────────
const KIND_LABEL = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R' }

function SessionFilesView() {
  const open = useExternal(filesUi, (state) => state.open)
  const enabled = useExternal(runtimeRefs.settings, (state) => state?.superseded?.sessionFiles === true)
  const metaReady = useExternal(sessionMetaStore, (state) => state.ready)
  const viewRef = React.useRef(null)
  const [state, setState] = React.useState({ loading: false, files: [], isRepo: true, branch: '', error: null, message: null, detailPath: null, detailDiff: '', detailBusy: false })

  const load = React.useCallback(async () => {
    const meta = currentSessionMeta()
    if (!meta.root) {
      setState((prev) => ({ ...prev, loading: false, files: [], error: '未定位到会话工作区（侧栏选中行无 cwd）' }))
      return
    }
    setState((prev) => ({ ...prev, loading: true, error: null }))
    try {
      const data = await api('GET', '/session-files', undefined, { root: meta.root, sessionId: meta.id })
      setState((prev) => ({ ...prev, loading: false, files: data.files ?? [], isRepo: data.isRepo !== false, branch: data.branch ?? '', error: null, detailPath: null, detailDiff: '' }))
    } catch (cause) {
      setState((prev) => ({ ...prev, loading: false, error: String(cause?.message ?? cause) }))
    }
  }, [])

  // 打开/会话就绪时加载 + 位置同步
  React.useLayoutEffect(() => {
    if (!open || !metaReady) return
    load()
    const update = () => {
      const view = viewRef.current
      if (!view) return
      const sc = document.querySelector('[data-conversation-scroll]')
      if (!sc) { view.style.display = 'none'; return }
      const rect = sc.getBoundingClientRect()
      view.style.display = 'block'
      view.style.left = rect.left + 'px'
      view.style.top = rect.top + 'px'
      view.style.width = rect.width + 'px'
      view.style.height = rect.height + 'px'
    }
    update()
    document.addEventListener('scroll', update, { passive: true, capture: true })
    window.addEventListener('resize', update)
    const interval = setInterval(update, 400)
    return () => {
      document.removeEventListener('scroll', update, { passive: true, capture: true })
      window.removeEventListener('resize', update)
      clearInterval(interval)
    }
  }, [open, metaReady, load])

  if (!open || !enabled) return null

  const showDiff = async (file) => {
    const repo = file.repo ?? currentSessionMeta().root
    if (!repo) return
    setState((prev) => ({ ...prev, detailPath: file.path, detailBusy: true }))
    try {
      const diff = await api('GET', '/git/diff', undefined, { root: repo, path: file.repoPath ?? file.path, staged: file.staged ? '1' : '0' })
      const text = diff?.text ?? diff?.error ?? ''
      setState((prev) => ({ ...prev, detailDiff: text || '(无差异文本)', detailBusy: false }))
    } catch (cause) {
      setState((prev) => ({ ...prev, detailDiff: String(cause?.message ?? cause), detailBusy: false }))
    }
  }

  const acceptFile = async (file) => {
    const meta = currentSessionMeta()
    if (!meta.root) return
    try {
      await api('POST', '/file-accept', { root: meta.root, repo: file.repo, sessionId: meta.id, path: file.repoPath ?? file.path })
      setState((prev) => ({ ...prev, message: `已认可 ${file.path}`, files: prev.files.filter((f) => f.path !== file.path) }))
    } catch (cause) {
      setState((prev) => ({ ...prev, message: `认可失败：${cause?.message ?? cause}` }))
    }
  }

  const revertFile = async (file) => {
    const meta = currentSessionMeta()
    if (!meta.root) return
    try {
      const result = await api('POST', '/file-revert', { root: meta.root, repo: file.repo, path: file.repoPath ?? file.path })
      if (result?.ok) {
        setState((prev) => ({ ...prev, message: `已还原 ${file.path}`, files: prev.files.filter((f) => f.path !== file.path), detailPath: prev.detailPath === file.path ? null : prev.detailPath }))
      } else {
        setState((prev) => ({ ...prev, message: `还原失败：${result?.error ?? '未知错误'}` }))
      }
    } catch (cause) {
      setState((prev) => ({ ...prev, message: `还原失败：${cause?.message ?? cause}` }))
    }
  }

  const pending = state.files.filter((f) => !f.accepted)
  const acceptedCount = state.files.length - pending.length

  return React.createElement('div', { ref: viewRef, className: 'wsh-files-view wsh-surface', role: 'region', 'aria-label': '会话文件' },
    React.createElement('div', { className: 'wsh-files-head' },
      React.createElement('span', { className: 'wsh-files-title' }, `文件 FILES // ${state.branch || 'WORKTREE'}`),
      React.createElement('span', { className: 'wsh-files-count' }, `${pending.length} 待处理${acceptedCount > 0 ? ` · ${acceptedCount} 已认可` : ''}`),
      React.createElement('span', { className: 'wsh-spacer' }),
      state.message ? React.createElement('span', { className: 'wsh-hint', style: { color: 'var(--w-cyan)' } }, state.message) : null,
      React.createElement('button', { type: 'button', className: 'wsh-btn mini', onClick: load }, '刷新'),
      React.createElement('button', { type: 'button', className: 'wsh-btn mini', onClick: () => filesUi.close() }, '关闭')),
    state.error ? React.createElement('div', { className: 'wsh-hint', style: { padding: '10px 14px', color: 'var(--w-red-hot)' } }, state.error) : null,
    !state.error && !state.isRepo ? React.createElement('div', { className: 'wsh-hint', style: { padding: '10px 14px' } }, '当前工作区不是 Git 仓库，无法追踪文件变更。') : null,
    !state.error && state.isRepo && state.loading ? React.createElement('div', { className: 'wsh-hint', style: { padding: '10px 14px' } }, '加载中…') : null,
    !state.error && state.isRepo && !state.loading && pending.length === 0 && acceptedCount === 0
      ? React.createElement('div', { className: 'wsh-hint', style: { padding: '10px 14px' } }, '工作区干净，本会话暂无文件变更。')
      : null,
    React.createElement('div', { className: 'wsh-files-list' },
      pending.map((file) => React.createElement('div', { key: file.path, className: 'wsh-file-row' + (state.detailPath === file.path ? ' open' : '') },
        React.createElement('span', { className: `wsh-file-kind k-${file.kind}` }, KIND_LABEL[file.kind] ?? '?'),
        React.createElement('span', { className: 'wsh-file-path', title: file.path }, file.path),
        React.createElement('span', { className: 'wsh-file-actions' },
          React.createElement('button', { type: 'button', className: 'wsh-btn mini', onClick: () => showDiff(file) }, state.detailPath === file.path ? '收起' : '审查'),
          React.createElement('button', { type: 'button', className: 'wsh-btn mini', onClick: () => revertFile(file), title: '丢弃该文件的改动' }, '还原'),
          React.createElement('button', { type: 'button', className: 'wsh-btn mini primary', onClick: () => acceptFile(file), title: '标记为已认可' }, '认可')),
        state.detailPath === file.path
          ? React.createElement('pre', { className: 'wsh-file-diff' }, state.detailBusy ? '加载 diff…' : state.detailDiff)
          : null)),
      acceptedCount > 0 ? React.createElement('div', { className: 'wsh-hint', style: { padding: '8px 14px' } }, `${acceptedCount} 个文件已认可（改动再次变化时会重新出现）`) : null))
}

function installSessionFiles(ctx) {
  const slots = ctx.get('slots')
  installFileTabWatch(ctx)
  refreshSessionMeta()
  const metaTimer = setInterval(() => refreshSessionMeta(), 30000)
  if (slots !== undefined) {
    ctx.effect(() => slots.inject('shell.overlay', () => slots.register({
      name: 'shell.overlay',
      id: 'wishadel-session-files',
      order: 50,
      label: '会话文件',
    }, SessionFilesView)), 'wishadel: session files view')
  }
  ctx.effect(() => () => clearInterval(metaTimer), 'wishadel: session files meta timer')
}
