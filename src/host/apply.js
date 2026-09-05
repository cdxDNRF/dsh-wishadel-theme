// Host 入口：组装服务、注册路由、启动 cron 调度与状态恢复。
// 全部副作用挂在当前 Fiber 上（ctx.effect），停止/更新插件时自动回收。
// inject 声明 webServer：本行在其就绪后才激活（webServer 依赖 webStartup，激活较晚）。
export const name = 'wishadel'
export const inject = ['webServer']

// 工作区目录选择桥接（供冒烟测试直接导入验证，也由 routes 内部复用）。
export { folderPickerCapability, winPathToWsl, wslPathToWin, windowsHomeDir, normalizeDirectoryPath, resolveSelectedDir, spawnWindowsPicker }

// 新版 dsh（rc.7）把 settings.plugin.item 从 list 槽（要求 id）改成 keyed 槽（要求 key），
// 且 ConfigurablePluginsTab 只派发「已服务（served）」的命名空间。这里用一个 schemastery
// 声明把 'wishadel' 登记进 ctx.settings，客户端卡片以 key:'wishadel' 匹配后即可渲染。
// 卡片读写仍走 /wishadel/settings 自建通道，此 schema 仅作命名空间声明，不参与数据读写。
const WISHADEL_NAMESPACE_SCHEMA = Schema.object({
  theme: Schema.union([Schema.const('wishadel'), Schema.const('none')]).default('wishadel'),
  themeOptions: Schema.object({
    chrome: Schema.boolean().default(true),
    sidebarArt: Schema.boolean().default(true),
    conversationArt: Schema.boolean().default(true),
  }),
  taskboard: Schema.object({
    enabled: Schema.boolean().default(true),
    cronTickMs: Schema.number().min(5000).max(600000).default(30000),
    defaultPreset: Schema.string().default(''),
    defaultCwd: Schema.string().default(''),
  }),
  gitgraph: Schema.object({
    enabled: Schema.boolean().default(true),
    maxCommits: Schema.number().min(10).max(2000).default(200),
  }),
  panel: Schema.object({
    enabled: Schema.boolean().default(true),
    defaultWidth: Schema.number().min(320).max(1100).default(480),
    defaultCollapsed: Schema.boolean().default(false),
    maxPreviewBytes: Schema.number().min(65536).max(20000000).default(2000000),
    browserNoSandbox: Schema.boolean().default(false),
    terminalShell: Schema.string().default(''),
  }),
  // 已被新版 DSH 原生功能取代的增强项（默认关闭，设置卡可重新开启）。
  superseded: Schema.object({
    historyJump: Schema.boolean().default(false),
    activityTab: Schema.boolean().default(false),
    sidebarNav: Schema.boolean().default(false),
    sessionFiles: Schema.boolean().default(false),
    scrollRail: Schema.boolean().default(false),
  }),
})

// 故障隔离：apply 抛错会让 dsh 整个插件树加载失败（服务器直接退出）。
// 任何宿主端初始化异常都只降级 wishadel 自身功能，并留下诊断日志。
export function apply(ctx) {
  try {
    const services = {
      ctx,
      agents: ctx.get('agents'),
      sessions: ctx.get('sessions'),
      jobs: ctx.get('jobs'),
      sessionQuery: ctx.get('sessionQuery'),
      sessionTitle: ctx.get('sessionTitle'),
      agentPresets: ctx.get('agentPresets'),
      agentDefaultModel: ctx.get('agentDefaultModel'),
      llm: ctx.get('llm'),
      sandboxPolicy: ctx.get('sandboxPolicy'),
      workspaceRegistry: ctx.get('workspaceRegistry'),
      webServer: ctx.get('webServer'),
      pickFolderOverride: ctx.get('folderPickerOverride'),
    }

    const tasks = createTaskEngine(services)
    services.tasks = tasks
    const terminals = createTerminalService(services)
    services.terminals = terminals

    // 注册 settings 命名空间：让新版「插件配置」标签页把 'wishadel' 视为已服务命名空间，
    // 从而派发 settings.plugin.item 槽并渲染本插件卡片。用 ctx.inject 而非顶层 inject，
    // settings 服务缺失时（如冒烟测试/极简 profile）不阻断本插件加载。
    if (typeof ctx.inject === 'function') {
      ctx.inject(['settings'], (sctx) => {
        sctx.settings.register('wishadel', WISHADEL_NAMESPACE_SCHEMA)
      })
    }

    // 进程重启后，残留的 running 任务一律标记为中断失败。
    tasks.recoverInterrupted()

    if (services.webServer !== undefined) {
      createRoutes(ctx, services)
    } else {
      console.warn('wishadel: webServer 不可用，HTTP 通道未注册')
    }

    // cron 调度：tick 间隔来自设置（默认 30s），最小 5s。
    // 注意：不能访问 ctx.timer/ctx.setInterval（本版本 Cordis 要求声明 inject 才能
    // 读取服务属性），改用原生定时器 + ctx.effect 回收。
    const tick = () => {
      try { tasks.cronTick() } catch (error) { console.warn(`wishadel cron tick: ${String(error)}`) }
    }
    const tickMs = Math.max(5000, loadSettings().taskboard.cronTickMs ?? 30000)
    const intervalHandle = setInterval(tick, tickMs)
    ctx.effect(() => () => clearInterval(intervalHandle), 'wishadel: cron tick')
    ctx.effect(() => () => terminals.dispose(), 'wishadel: terminal processes')

    // 设置热变更时跟随 tick 间隔（读设置是惰性的，无需重挂）。
    const offSettings = onSettingsChanged(() => { /* 保留订阅以保持 settings.json 热同步 */ })
    ctx.effect(() => offSettings, 'wishadel: settings listeners')

    console.info('wishadel host bundle ready')
  } catch (error) {
    console.error('[wishadel] 宿主插件初始化失败（dsh 继续运行，wishadel HTTP 通道可能不可用）:', error)
  }
}
