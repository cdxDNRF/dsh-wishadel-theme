// 客户端入口：组装设置存储、主题、皮肤注册表与四大功能模块。
function apply(ctx) {
  runtimeRefs.ctx = ctx

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
      return { tasks: tasksData.tasks ?? [], live: liveData.sessions ?? [] }
    },
    5000,
  )

  // 主题核心（视觉 + DOM 标记）。
  const theme = installTheme(ctx, settingsStore)

  // 皮肤注册表：注册本皮肤，设置变化时激活对应皮肤。
  // 宿主不可达（settings 为 null）时保持默认启用，避免刷新后界面回退。
  installWishadelSkin(theme.applyVisuals)
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
  installFlowWatch(ctx)
  installSettingsCard(ctx, settingsStore)
  installTaskboard(ctx, settingsStore, tasksSource)
  installSidebarPin(ctx)
  installSessionFiles(ctx)
  installGitGraph(ctx, settingsStore)
  installPanel(ctx, settingsStore)
  installScrollDock(ctx)
  installComposerWatch(ctx)
}
module.exports.apply = apply
module.exports.inject = []
