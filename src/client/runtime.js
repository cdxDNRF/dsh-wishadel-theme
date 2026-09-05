// 客户端入口：组装设置存储、主题、皮肤注册表与四大功能模块。
// 故障隔离：任何一个安装器抛错只跳过该功能并打印诊断，绝不让异常
// 冒泡到 dsh 客户端插件加载器——否则整个 Web UI 会进入
// "Failed to load plugins" 白屏（历史对话无法加载）。

function safeInstall(label, install) {
  try {
    return install()
  } catch (error) {
    console.error(`[wishadel] ${label} 安装失败（其余功能与官方界面继续运行）:`, error)
    return null
  }
}

function apply(ctx) {
  try {
    runtimeRefs.ctx = ctx
    if (typeof ctx.provide === 'function') ctx.provide('wishadelWorkbench', workbenchRegistry)

    // 宿主设置通道（持久化 + 即时生效）。
    const settingsStore = createSettingsStore()
    settingsStore.refresh().catch(() => {})

    // 任务 + 运行中对话轮询源（看板打开时由 createPollingSource 内部按需起停）。
    const tasksSource = createPollingSource(
      async () => {
        const [tasksData, liveData] = await Promise.all([
          api('GET', '/tasks'),
          api('GET', '/live-sessions'),
        ])
        let activityData = { rows: [] }
        try { activityData = await api('GET', '/activity') } catch { /* older host bundle: activity is optional */ }
        return { tasks: tasksData.tasks ?? [], live: liveData.sessions ?? [], activity: activityData.rows ?? [] }
      },
      5000,
    )

    // 主题核心（视觉 + DOM 标记）。
    const theme = safeInstall('主题核心', () => installTheme(ctx, settingsStore))

    // 皮肤注册表：注册本皮肤，设置变化时激活对应皮肤。
    // 宿主不可达（settings 为 null）时保持默认启用，避免刷新后界面回退。
    if (theme && typeof theme.applyVisuals === 'function') {
      installWishadelSkin(theme.applyVisuals)
    }
    const unsubscribeSkin = settingsStore.subscribe((settings) => {
      const legacy = readLegacyConfig()
      const active = settings == null || settings.theme === 'wishadel'
      const options = settings?.themeOptions ?? {
        chrome: legacy.showChrome !== false,
        sidebarArt: legacy.showSidebarArt !== false,
        conversationArt: legacy.showConversationArt !== false,
      }
      activateSkin(active ? 'wishadel' : null, options)
    })
    ctx.effect(() => unsubscribeSkin, 'wishadel: skin activation')

    // 四大功能 + 附件卡死修复 + 消息存在性侦测（空状态隐藏 dock 气泡）。
    safeInstall('flow-watch', () => installFlowWatch(ctx))
    safeInstall('settings-card', () => installSettingsCard(ctx, settingsStore))
    safeInstall('taskboard', () => installTaskboard(ctx, settingsStore, tasksSource))
    safeInstall('sidebar-pin', () => installSidebarPin(ctx))
    safeInstall('sidebar-navigation', () => installSidebarNavigation(ctx))
    safeInstall('session-files', () => installSessionFiles(ctx))
    safeInstall('gitgraph', () => installGitGraph(ctx, settingsStore))
    safeInstall('panel', () => installPanel(ctx, settingsStore))
    safeInstall('scroll-dock', () => installScrollDock(ctx))
    safeInstall('composer-watch', () => installComposerWatch(ctx))
    safeInstall('conversation-tools', () => installConversationTools(ctx))
    safeInstall('workspace-flow', () => installWorkspaceFlow(ctx))
  } catch (error) {
    console.error('[wishadel] 客户端 apply 失败（官方界面不受影响）:', error)
  }
}
module.exports.apply = apply
module.exports.inject = []
