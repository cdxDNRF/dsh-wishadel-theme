// 对话区右侧迷你滚动条（拉条式）：
// 细轨道 + 可拖动滑块，fixed 定位跟随对话面板右缘、垂直居中。
// 点击轨道任意位置 → 滚动到对应比例；拖动滑块 → 按比例实时滚动；
// 只有会话存在消息且流区可滚动时显示。滑块位置/高度随滚动实时同步。

function conversationScroller() {
  // 首选宿主自带的滚动容器标记；兜底沿消息流节点向上找可滚动祖先。
  const marked = document.querySelector('[data-conversation-scroll]')
  if (marked && marked.scrollHeight > marked.clientHeight + 8) return marked
  const flow = document.querySelector('[data-chat-flow-kind]')
  if (flow) {
    let node = flow.parentElement
    while (node && node !== document.body) {
      const cs = getComputedStyle(node)
      const scrollable = cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflow === 'auto' || cs.overflow === 'scroll'
      if (scrollable && node.scrollHeight > node.clientHeight + 8) return node
      node = node.parentElement
    }
  }
  return null
}

function ScrollRail() {
  const hasMessages = useExternal(flowActivity, (state) => state)
  // 任务看板 / 提交图谱 overlay 打开时隐藏滚条，不压在半透明遮罩之上
  const boardOpen = useExternal(boardUi, (state) => state.open)
  const graphOpen = useExternal(gitgraphUi, (state) => state.open)
  const railRef = React.useRef(null)
  const scrollerRef = React.useRef(null)
  const dragRef = React.useRef(null)
  const suppressClickRef = React.useRef(0)
  const [view, setView] = React.useState({ scrollable: false, top: 0, height: 28 })

  React.useLayoutEffect(() => {
    if (!hasMessages) {
      scrollerRef.current = null
      return
    }
    const resolve = () => {
      const current = scrollerRef.current
      if (current && current.isConnected) return current
      const next = conversationScroller()
      scrollerRef.current = next
      return next
    }
    const update = () => {
      const sc = resolve()
      const rail = railRef.current
      const pane = document.querySelector('[data-wishadel-pane="conversation"]')
      if (!rail || !pane) return
      if (!sc) {
        rail.style.display = 'none'
        return
      }
      const rect = pane.getBoundingClientRect()
      // 右侧 wsh 面板是悬浮覆盖式的（不挤压对话面板），可见右缘要扣除面板宽度
      const panel = document.querySelector('.wsh-panel')
      const panelRect = panel ? panel.getBoundingClientRect() : null
      const panelOpen = panelRect !== null && panelRect.width > 8
      const visibleRight = panelOpen ? Math.min(rect.right, panelRect.left) : rect.right
      // 水平位置：取「文字流右缘 +16」与「可见右缘 -12」的中点（两版设计的折中）；
      // 面板展开盖住文字流时，直接贴可见右缘。
      const flow = document.querySelector('[data-chat-flow]')
      const flowRect = flow ? flow.getBoundingClientRect() : null
      const anchorLeft = flowRect !== null && flowRect.width > 0 ? flowRect.right + 16 : visibleRight - 12
      const anchorRight = visibleRight - 12
      const railRight = Math.max(rect.left + 40, anchorRight >= anchorLeft ? Math.round((anchorLeft + anchorRight) / 2) : anchorRight)
      const railHeight = Math.max(140, Math.min(Math.round(rect.height * 0.58), 560))
      rail.style.display = 'block'
      rail.style.right = Math.max(6, window.innerWidth - railRight) + 'px'
      // 垂直位置：轨道中心落在面板高度 44% 处（比正中略偏上）
      rail.style.top = Math.round(rect.top + rect.height * 0.44 - railHeight / 2) + 'px'
      rail.style.height = railHeight + 'px'
      const max = sc.scrollHeight - sc.clientHeight
      const scrollable = max > 8
      const thumbHeight = Math.max(28, Math.min(railHeight, Math.round(railHeight * sc.clientHeight / sc.scrollHeight)))
      const top = max > 0 ? Math.round((sc.scrollTop / max) * (railHeight - thumbHeight)) : 0
      setView((prev) => (
        prev.scrollable === scrollable && prev.top === top && prev.height === thumbHeight
          ? prev
          : { scrollable, top, height: thumbHeight }
      ))
    }
    update()
    // capture 监听全局滚动：会话切换导致滚动容器替换时无需重新挂载监听
    document.addEventListener('scroll', update, { passive: true, capture: true })
    window.addEventListener('resize', update)
    const interval = setInterval(update, 400)
    return () => {
      document.removeEventListener('scroll', update, { passive: true, capture: true })
      window.removeEventListener('resize', update)
      clearInterval(interval)
      scrollerRef.current = null
    }
  }, [hasMessages])

  if (!hasMessages) return null
  if (boardOpen || graphOpen) return null

  const thumbOf = () => {
    const rail = railRef.current
    const sc = scrollerRef.current
    if (!rail || !sc || !sc.isConnected) return null
    const H = rail.getBoundingClientRect().height
    const viewport = sc.clientHeight
    const content = sc.scrollHeight
    return {
      sc,
      H,
      max: content - viewport,
      thumbH: Math.max(28, Math.min(H, Math.round(H * viewport / content))),
    }
  }

  // 点击轨道：跳到点击位置对应的滚动比例。
  // 拖动结束后的 click（指针捕获重定向等边缘情况）在 400ms 内被吞掉，
  // 避免「按下滑块松手」被误判为轨道点击跳转。
  const onRailClick = (event) => {
    if (suppressClickRef.current !== 0 && Date.now() - suppressClickRef.current < 400) {
      suppressClickRef.current = 0
      return
    }
    if (event.target !== event.currentTarget) return
    const geo = thumbOf()
    if (!geo || geo.max <= 0) return
    const rect = railRef.current.getBoundingClientRect()
    const ratio = (event.clientY - rect.top - geo.thumbH / 2) / (geo.H - geo.thumbH)
    geo.sc.scrollTop = Math.max(0, Math.min(geo.max, Math.round(ratio * geo.max)))
  }

  // 拖动滑块：仅左键按下、且位移超过阈值后才开始拖动；
  // 单纯悬停或按下不移动都不会触发任何滚动。
  const onThumbPointerDown = (event) => {
    if (event.button !== 0) return
    const geo = thumbOf()
    if (!geo || geo.max <= 0) return
    event.preventDefault()
    dragRef.current = { startY: event.clientY, startScrollTop: geo.sc.scrollTop, max: geo.max, usable: geo.H - geo.thumbH, moved: false }
    suppressClickRef.current = 0
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* 捕获不可用时移动事件仍跟随指针 */ }
  }
  const onThumbPointerMove = (event) => {
    const drag = dragRef.current
    if (!drag || drag.usable <= 0) return
    const sc = scrollerRef.current
    if (!sc || !sc.isConnected) return
    const dy = event.clientY - drag.startY
    if (!drag.moved) {
      if (Math.abs(dy) < 3) return
      drag.moved = true
      suppressClickRef.current = Date.now()
    }
    sc.scrollTop = Math.max(0, Math.min(drag.max, Math.round(drag.startScrollTop + (dy / drag.usable) * drag.max)))
  }
  const onThumbPointerUp = () => { dragRef.current = null }

  return React.createElement('div', {
    ref: railRef,
    className: 'wsh-scroll-rail wsh-surface',
    role: 'scrollbar',
    'aria-label': '对话滚动条',
    title: '拖动滑块或点击轨道滚动对话',
    onClick: onRailClick,
    style: { display: view.scrollable ? 'block' : 'none' },
  },
    React.createElement('div', {
      className: 'wsh-scroll-thumb',
      style: { top: view.top + 'px', height: view.height + 'px' },
      onPointerDown: onThumbPointerDown,
      onPointerMove: onThumbPointerMove,
      onPointerUp: onThumbPointerUp,
      onPointerCancel: onThumbPointerUp,
    }))
}

function installScrollDock(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  ctx.effect(() => slots.inject('shell.overlay', () => slots.register({
    name: 'shell.overlay',
    id: 'wishadel-scroll-rail',
    order: 25,
    label: '对话滚动条',
  }, ScrollRail)), 'wishadel: scroll rail')
}
