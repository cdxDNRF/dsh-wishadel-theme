// 对话区右侧滚动 dock（上下滚轮）：
// shell.overlay 条目，fixed 定位跟随对话面板右缘、垂直居中。
// 只在会话存在消息且流区可滚动时显示；▲/▼ 每次滚动约 3/4 屏，
// 接近边界时直接跳顶/跳底；按钮在到达边界时置灰。

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

function ScrollDock() {
  const hasMessages = useExternal(flowActivity, (state) => state)
  const dockRef = React.useRef(null)
  const scrollerRef = React.useRef(null)
  const [pos, setPos] = React.useState({ scrollable: false, atTop: true, atBottom: false })

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
      const dock = dockRef.current
      const pane = document.querySelector('[data-wishadel-pane="conversation"]')
      if (dock) dock.style.display = sc ? 'flex' : 'none'
      if (dock && pane) {
        const rect = pane.getBoundingClientRect()
        dock.style.right = Math.max(6, window.innerWidth - rect.right + 22) + 'px'
        dock.style.top = (rect.top + rect.height / 2) + 'px'
      }
      if (!sc) return
      const max = sc.scrollHeight - sc.clientHeight
      const next = {
        scrollable: max > 8,
        atTop: sc.scrollTop <= 8,
        atBottom: sc.scrollTop >= max - 8,
      }
      setPos((prev) => (
        prev.scrollable === next.scrollable && prev.atTop === next.atTop && prev.atBottom === next.atBottom
          ? prev
          : next
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

  const nudge = (direction) => {
    const sc = scrollerRef.current
    if (!sc || !sc.isConnected) return
    const step = Math.round(sc.clientHeight * 0.75)
    const max = sc.scrollHeight - sc.clientHeight
    const target = direction < 0
      ? Math.max(0, sc.scrollTop - step)
      : Math.min(max, sc.scrollTop + step)
    sc.scrollTo({ top: target, behavior: 'smooth' })
  }

  return React.createElement('div', {
    ref: dockRef,
    className: 'wsh-scroll-dock wsh-surface',
    role: 'group',
    'aria-label': '滚动对话',
  },
    React.createElement('button', {
      type: 'button',
      className: 'wsh-scroll-btn',
      title: '向上滚动',
      disabled: !pos.scrollable || pos.atTop,
      onClick: () => nudge(-1),
    }, '▲'),
    React.createElement('button', {
      type: 'button',
      className: 'wsh-scroll-btn',
      title: '向下滚动',
      disabled: !pos.scrollable || pos.atBottom,
      onClick: () => nudge(1),
    }, '▼'))
}

function installScrollDock(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  ctx.effect(() => slots.inject('shell.overlay', () => slots.register({
    name: 'shell.overlay',
    id: 'wishadel-scroll-dock',
    order: 25,
    label: '对话滚动',
  }, ScrollDock)), 'wishadel: scroll dock')
}
