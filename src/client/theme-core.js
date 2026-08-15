// 主题核心：样式注入、DOM 语义标记、视觉状态应用。
// 配置来源从旧 localStorage 迁移为宿主 settings（/wishadel/settings），
// localStorage 仅作为服务不可用时的降级缓存。

const SKIN_OWNER = 'wishadel-terminal'
const BODY_ATTR = 'data-dsh-wishadel'
const THEME_TITLE = "WIS'ADEL // DeepSeek Harness"
const OWNED_STYLE = 'dsh-theme-wishadel/theme.css'
const LEGACY_STORAGE_KEY = 'dsh-theme-wishadel-config'

function readLegacyConfig() {
  try { return JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || '{}') } catch { return {} }
}

function createChrome(kind, text) {
  const node = document.createElement('div')
  node.dataset.wishadelChrome = kind
  node.dataset.skinOwner = SKIN_OWNER
  node.setAttribute('aria-hidden', 'true')
  if (text) node.textContent = text
  return node
}

function markSurfaces(decorated) {
  const sidebar = document.querySelector("[data-pane='sidebar'], [class*='_sidebarCol']")
  const conversation = document.querySelector("[data-pane='conversation'], [class*='_centerCol']")
  const details = document.querySelector("[data-pane='details'], [class*='_detailsCol']")
  if (sidebar) { sidebar.dataset.wishadelPane = 'sidebar'; decorated.add(sidebar) }
  if (conversation) { conversation.dataset.wishadelPane = 'conversation'; decorated.add(conversation) }
  if (details) { details.dataset.wishadelPane = 'details'; decorated.add(details) }
  document.querySelectorAll("[role='treeitem'][aria-selected='true']").forEach((row) => {
    row.dataset.wishadelActive = ''
    decorated.add(row)
  })
  document.querySelectorAll("[data-state='running'], [data-cordis-awaiting]").forEach((node) => {
    node.dataset.wishadelLive = ''
    decorated.add(node)
  })
}

function clearDecorations(decorated) {
  decorated.forEach((node) => {
    delete node.dataset.wishadelPane
    delete node.dataset.wishadelActive
    delete node.dataset.wishadelLive
  })
  decorated.clear()
}

// 安装主题核心，返回应用视觉的函数与清理器。
function installTheme(ctx, settingsStore) {
  const body = document.body
  const originalTitle = document.title
  const chromeNodes = new Set()
  const decorated = new Set()
  let observer
  let enabled = false

  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-theme-wishadel'
  style.dataset.pluginCss = OWNED_STYLE
  style.textContent = WISHADEL_CSS
  document.head.append(style)

  function removeChrome() {
    chromeNodes.forEach((node) => node.remove())
    chromeNodes.clear()
  }

  function renderChrome(showChrome) {
    removeChrome()
    if (!enabled || !showChrome) return
    const nodes = [
      createChrome('telemetry', 'W // 03   DEMOLITION LINK'),
      createChrome('index', '03'),
      createChrome('slash'),
    ]
    nodes.forEach((node) => chromeNodes.add(node))
    body.append(...nodes)
  }

  function applyVisuals(active, options) {
    enabled = Boolean(active)
    const opts = options ?? {}
    const showChrome = opts.chrome !== false
    const sidebarArt = opts.sidebarArt !== false
    const conversationArt = opts.conversationArt !== false
    body.toggleAttribute(BODY_ATTR, enabled)
    body.toggleAttribute('data-wishadel-chrome-enabled', enabled && showChrome)
    body.toggleAttribute('data-wishadel-sidebar-art', enabled && sidebarArt)
    body.toggleAttribute('data-wishadel-conversation-art', enabled && conversationArt)
    if (enabled) {
      document.title = THEME_TITLE
      for (const [name, value] of Object.entries(WISHADEL_ASSETS)) body.style.setProperty(`--wishadel-art-${name}`, `url("${value}")`)
      clearDecorations(decorated)
      markSurfaces(decorated)
    } else {
      clearDecorations(decorated)
      for (const name of Object.keys(WISHADEL_ASSETS)) body.style.removeProperty(`--wishadel-art-${name}`)
      if (document.title === THEME_TITLE) document.title = originalTitle
    }
    renderChrome(showChrome)
  }

  // 首次同步（宿主设置加载前先用默认/旧配置兜底）；
  // 之后的响应式驱动由 runtime.js 的皮肤注册表统一负责。
  {
    const legacy = readLegacyConfig()
    const snapshot = settingsStore.getSnapshot()
    applyVisuals(snapshot == null ? true : snapshot.theme === 'wishadel', snapshot?.themeOptions ?? {
      chrome: legacy.showChrome !== false,
      sidebarArt: legacy.showSidebarArt !== false,
      conversationArt: legacy.showConversationArt !== false,
    })
  }

  observer = new MutationObserver(() => {
    if (enabled) {
      clearDecorations(decorated)
      markSurfaces(decorated)
    }
  })
  observer.observe(body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-selected', 'data-state', 'data-cordis-awaiting'],
  })

  ctx.effect(() => () => {
    observer?.disconnect()
    clearDecorations(decorated)
    removeChrome()
    style.remove()
    body.removeAttribute(BODY_ATTR)
    body.removeAttribute('data-wishadel-chrome-enabled')
    body.removeAttribute('data-wishadel-sidebar-art')
    body.removeAttribute('data-wishadel-conversation-art')
    for (const name of Object.keys(WISHADEL_ASSETS)) body.style.removeProperty(`--wishadel-art-${name}`)
    if (document.title === THEME_TITLE) document.title = originalTitle
  }, 'wishadel-theme: visuals')

  return { applyVisuals }
}
