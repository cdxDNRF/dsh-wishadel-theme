// 会话置顶（侧栏）：
// 宿主的「...」菜单没有扩展槽（rename/fork/archive 写死），行 DOM 也不携带会话 id。
// 方案：宿主导出 /wishadel/sessions-index（id↔标题）与 /wishadel/pinned（置顶列表）；
// 客户端给每个会话行注入置顶按钮（hover 显示，置顶后常驻红色），
// 并按组头把置顶行的 wrapper 移到组内顶部（DOM 重排 + MutationObserver 自愈，
// 行列表由宿主按 key 渲染，时间标签等更新不会串行）。

const pinState = (() => {
  let state = { ids: [], order: [], index: new Map(), ready: false }
  const listeners = new Set()
  const notify = () => listeners.forEach((fn) => fn())
  return {
    getSnapshot: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    setIds(ids) { state = { ...state, ids, ready: true }; notify() },
    setIndex(index, order) { state = { ...state, index, order: order ?? state.order }; notify() },
  }
})()

const PIN_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.6 1.4l5 5c.2.2.2.5 0 .7l-2.2 2.2-.6 4.6c0 .2-.2.4-.4.4-.1 0-.2 0-.3-.1l-3-1.9-2.7 2.7c-.2.2-.5.2-.7 0L3.3 13.6c-.2-.2-.2-.5 0-.7l2.7-2.7-1.9-3c-.1-.1-.1-.2-.1-.3 0-.2.2-.4.4-.4l4.6-.6 2.2-2.2c.2-.2.5-.2.7 0z" fill="currentColor"/></svg>'

function sidebarRoot() {
  return document.querySelector('[data-wishadel-pane="sidebar"]') ?? document.body
}

// 行 → 会话 id：优先解析宿主「...」按钮 aria-label（会话“标题”的操作），
// 兜底用行内标题元素文本，再对照宿主索引。
// 注意排除我们自己注入的置顶按钮。
function rowIdOf(row) {
  const ell = [...row.querySelectorAll('button')].find((btn) => !btn.classList.contains('wsh-pin-btn'))
  const label = ell?.getAttribute('aria-label') ?? ''
  let match = /会话[“"]([^”"]+)[”"]的操作/.exec(label)
  let title = match ? match[1] : null
  if (title === null) {
    const titleEl = row.querySelector('[class*="title"]')
    title = titleEl ? titleEl.textContent.trim() : null
  }
  if (!title) return null
  return pinState.getSnapshot().index.get(title) ?? null
}

function isPinnedId(id) {
  return id !== null && pinState.getSnapshot().ids.includes(id)
}

function ensurePinButtons() {
  for (const row of document.querySelectorAll('[role="treeitem"]')) {
    if (String(row.className).includes('projectRow')) continue
    const ell = [...row.querySelectorAll('button')].find((btn) => !btn.classList.contains('wsh-pin-btn'))
    if (!ell) continue
    let btn = ell.parentElement.querySelector('.wsh-pin-btn')
    if (!btn) {
      btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'wsh-pin-btn'
      btn.title = '置顶 / 取消置顶'
      btn.setAttribute('aria-label', '置顶 / 取消置顶')
      btn.innerHTML = PIN_SVG
      btn.addEventListener('click', (event) => {
        event.stopPropagation()
        event.preventDefault()
        togglePin(rowIdOf(row))
      })
      ell.parentElement.insertBefore(btn, ell)
    }
    btn.classList.toggle('wsh-pinned', isPinnedId(rowIdOf(row)))
  }
}

async function togglePin(id) {
  if (!id) return
  const pinned = pinState.getSnapshot().ids.includes(id)
  if (pinned) {
    // 取消置顶：登记待归位，随后 applyPinOrder 按宿主最新序放回未置顶区
    if (!demoteQueue.includes(id)) demoteQueue.push(id)
  }
  try {
    const data = await api('POST', '/pinned', { sessionId: id, pinned: !pinned })
    pinState.setIds(data.ids ?? [])
  } catch { /* 宿主尚未更新路由时静默 */ }
}

// 取消置顶时登记的待归位会话 id：applyPinOrder 对其所在组的未置顶区按宿主序重排
const demoteQueue = []
function applyPinOrder() {
  const snapshot = pinState.getSnapshot()
  if (!snapshot.ready) return
  const pinnedSet = new Set(snapshot.ids)
  const containers = new Set()
  for (const row of document.querySelectorAll('[role="treeitem"]')) {
    const wrapper = row.parentElement
    if (wrapper && wrapper.parentElement) containers.add(wrapper.parentElement)
  }
  if (snapshot.ids.length > 0) {
    for (const container of containers) {
      // 第一遍：按组头分段收集置顶 wrapper
      const groups = []
      for (const child of [...container.children]) {
        const row = child.querySelector ? child.querySelector('[role="treeitem"]') : null
        if (!row) continue
        if (String(row.className).includes('projectRow')) { groups.push({ header: child, pinned: [] }); continue }
        if (groups.length === 0) continue
        const id = rowIdOf(row)
        if (id !== null && pinnedSet.has(id)) groups[groups.length - 1].pinned.push(child)
      }
      // 第二遍：每个组把置顶 wrapper 按置顶序插到组头之后
      for (const group of groups) {
        if (group.pinned.length === 0) continue
        const ordered = [...group.pinned].sort((a, b) => {
          const aId = rowIdOf(a.querySelector('[role="treeitem"]'))
          const bId = rowIdOf(b.querySelector('[role="treeitem"]'))
          return snapshot.ids.indexOf(aId) - snapshot.ids.indexOf(bId)
        })
        let anchor = group.header.nextElementSibling
        for (const wrapper of ordered) {
          if (anchor === wrapper) { anchor = anchor.nextElementSibling; continue }
          container.insertBefore(wrapper, anchor)
        }
      }
    }
  }
  // 第三遍：归位 —— 含待归位行的组，把未置顶区按宿主最新序重排
  const demoteSet = new Set(demoteQueue)
  if (demoteSet.size > 0) {
    const rankOf = (wrapper) => {
      const id = rowIdOf(wrapper.querySelector('[role="treeitem"]'))
      return id === null ? -1 : snapshot.order.indexOf(id)
    }
    for (const container of containers) {
      let header = null
      let lastPinned = null
      let groupUnpinned = []
      let hasDemote = false
      const flush = () => {
        if (!header || !hasDemote || groupUnpinned.length === 0) return
        const ordered = [...groupUnpinned].sort((a, b) => {
          const ra = rankOf(a)
          const rb = rankOf(b)
          if (ra < 0 && rb < 0) return 0
          if (ra < 0) return 1
          if (rb < 0) return -1
          return ra - rb
        })
        let anchor = (lastPinned ?? header).nextElementSibling
        for (const wrapper of ordered) {
          if (anchor === wrapper) { anchor = anchor.nextElementSibling; continue }
          container.insertBefore(wrapper, anchor)
        }
      }
      for (const child of [...container.children]) {
        const row = child.querySelector ? child.querySelector('[role="treeitem"]') : null
        if (!row) continue
        if (String(row.className).includes('projectRow')) {
          flush()
          header = child
          lastPinned = null
          groupUnpinned = []
          hasDemote = false
          continue
        }
        if (!header) continue
        const id = rowIdOf(row)
        if (id === null) continue
        if (pinnedSet.has(id)) { lastPinned = child; continue }
        groupUnpinned.push(child)
        if (demoteSet.has(id)) hasDemote = true
      }
      flush()
    }
    demoteQueue.length = 0
  }
}

async function refreshIndex() {
  try {
    const data = await api('GET', '/sessions-index')
    const map = new Map()
    const order = []
    for (const s of data.sessions ?? []) {
      if (typeof s?.title === 'string' && typeof s?.id === 'string') {
        map.set(s.title, s.id)
        order.push(s.id)
      }
    }
    pinState.setIndex(map, order)
  } catch { /* 宿主尚未更新路由时静默 */ }
}

function installSidebarPin(ctx) {
  let disposed = false
  let timer = null
  const run = () => {
    timer = null
    if (disposed) return
    ensurePinButtons()
    applyPinOrder()
  }
  const schedule = () => { if (timer === null) timer = setTimeout(run, 150) }

  const root = sidebarRoot()
  const observer = new MutationObserver(schedule)
  observer.observe(root, { childList: true, subtree: true })
  run()

  const unsubscribe = pinState.subscribe(() => schedule())
  refreshIndex()
  api('GET', '/pinned').then((data) => pinState.setIds(data.ids ?? [])).catch(() => {})
  const indexTimer = setInterval(() => refreshIndex(), 30000)

  ctx.effect(() => () => {
    disposed = true
    observer.disconnect()
    unsubscribe()
    clearInterval(indexTimer)
    if (timer !== null) clearTimeout(timer)
    for (const btn of document.querySelectorAll('.wsh-pin-btn')) btn.remove()
  }, 'wishadel: sidebar pin')
}
