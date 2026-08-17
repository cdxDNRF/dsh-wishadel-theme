// 设置中心：宿主侧唯一事实来源（settings.json）。
// 客户端卡片通过 /wishadel/settings 读写；宿主各功能（任务看板/Git/面板）实时读取。

const SETTINGS_SCHEMA = z.object({
  // 主题选择：'wishadel' 为当前皮肤，'none' 还原 DSH 默认外观。
  theme: z.enum(['wishadel', 'none']).default('wishadel'),
  themeOptions: z.object({
    chrome: z.boolean().default(true),
    sidebarArt: z.boolean().default(true),
    conversationArt: z.boolean().default(true),
  }).default({}),
  // 任务看板
  taskboard: z.object({
    enabled: z.boolean().default(true),
    cronTickMs: z.number().int().min(5000).max(600000).default(30000),
    defaultPreset: z.string().default(''),
    defaultCwd: z.string().default(''),
  }).default({}),
  // Git 图谱
  gitgraph: z.object({
    enabled: z.boolean().default(true),
    maxCommits: z.number().int().min(10).max(2000).default(200),
  }).default({}),
  // 右侧面板
  panel: z.object({
    enabled: z.boolean().default(true),
    defaultWidth: z.number().int().min(320).max(1100).default(480),
    defaultCollapsed: z.boolean().default(false),
    maxPreviewBytes: z.number().int().min(65536).max(20000000).default(2000000),
    browserNoSandbox: z.boolean().default(false),
    terminalShell: z.string().max(400).default(''),
  }).default({}),
})

const SETTINGS_FILE = 'settings.json'
let settingsCache = null
const settingsListeners = new Set()

function loadSettings() {
  if (settingsCache === null) {
    settingsCache = SETTINGS_SCHEMA.parse(readJson(SETTINGS_FILE, {}))
  }
  return settingsCache
}

function updateSettings(patch) {
  const next = SETTINGS_SCHEMA.parse(mergeDeep(loadSettings(), patch ?? {}))
  settingsCache = next
  writeJson(SETTINGS_FILE, next)
  for (const listener of settingsListeners) {
    try { listener(next) } catch { /* 监听器异常不影响写入 */ }
  }
  return next
}

function onSettingsChanged(listener) {
  settingsListeners.add(listener)
  return () => settingsListeners.delete(listener)
}

// 右侧面板的宽度/折叠状态：按项目（workspace root）持久化。
const PANEL_STATE_FILE = 'panel-state.json'
let panelStateCache = null

function loadPanelState() {
  if (panelStateCache === null) {
    const raw = readJson(PANEL_STATE_FILE, { byRoot: {} })
    panelStateCache = raw && typeof raw === 'object' && raw.byRoot && typeof raw.byRoot === 'object' ? raw : { byRoot: {} }
  }
  return panelStateCache
}

function panelStateKey(root, sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  return id ? `session:${id}` : `root:${root}`
}

function getPanelState(root, sessionId) {
  const doc = loadPanelState()
  const key = panelStateKey(root, sessionId)
  return doc.byRoot[key] ?? (sessionId ? doc.byRoot[root] ?? null : null)
}

function putPanelState(root, state, sessionId) {
  const doc = loadPanelState()
  const key = panelStateKey(root, sessionId)
  const prev = doc.byRoot[key] ?? (sessionId ? doc.byRoot[root] ?? {} : {})
  const next = {
    width: state?.width !== undefined ? Math.min(1100, Math.max(260, Math.round(state.width))) : prev.width,
    collapsed: state?.collapsed !== undefined ? Boolean(state.collapsed) : prev.collapsed,
    tab: typeof state?.tab === 'string' ? state.tab.slice(0, 32) : prev.tab,
    bottomTab: state?.bottomTab === 'terminal' ? 'terminal' : (prev.bottomTab ?? 'activity'),
    browserUrl: typeof state?.browserUrl === 'string' ? state.browserUrl.slice(0, 2000) : prev.browserUrl,
    openPaths: Array.isArray(state?.openPaths) ? state.openPaths.filter((path) => typeof path === 'string').slice(0, 30) : prev.openPaths,
    activePath: typeof state?.activePath === 'string' ? state.activePath.slice(0, 1000) : prev.activePath,
    bottomOpen: state?.bottomOpen !== undefined ? Boolean(state.bottomOpen) : prev.bottomOpen,
    bottomHeight: state?.bottomHeight !== undefined ? Math.min(560, Math.max(150, Math.round(state.bottomHeight))) : prev.bottomHeight,
  }
  // git 分支按钮的浮动位置（可拖动），与面板状态同文件、按项目持久化。
  if (state?.git !== undefined) {
    next.git = {
      x: Number.isFinite(state.git?.x) ? Math.round(state.git.x) : prev.git?.x,
      y: Number.isFinite(state.git?.y) ? Math.round(state.git.y) : prev.git?.y,
      floating: Boolean(state.git?.floating),
    }
  } else if (prev.git !== undefined) {
    next.git = prev.git
  }
  doc.byRoot[key] = next
  writeJson(PANEL_STATE_FILE, doc)
  return doc.byRoot[key]
}



