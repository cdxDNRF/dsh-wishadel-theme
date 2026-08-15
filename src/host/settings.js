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
    defaultWidth: z.number().int().min(260).max(900).default(380),
    defaultCollapsed: z.boolean().default(false),
    maxPreviewBytes: z.number().int().min(65536).max(20000000).default(2000000),
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

function getPanelState(root) {
  return loadPanelState().byRoot[root] ?? null
}

function putPanelState(root, state) {
  const doc = loadPanelState()
  doc.byRoot[root] = {
    width: Number.isFinite(state?.width) ? Math.min(900, Math.max(260, Math.round(state.width))) : undefined,
    collapsed: Boolean(state?.collapsed),
  }
  writeJson(PANEL_STATE_FILE, doc)
  return doc.byRoot[root]
}
