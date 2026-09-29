// 插件配置界面：同时注册到两代 DSH 的配置槽，互为兼容。
//   · dsh ≥ 0.2.0：`plugins.bundle.config`（keyed，key = 本 bundle 包名）。
//     侧栏「插件」页里点进本 bundle 的详情页，配置区渲染在描述与组件行之间。
//     宿主按 view='summary' 取一行摘要、view='page' 取完整表单（含自己的保存控件）。
//   · dsh ≤ 0.1.5：`settings.plugin.item`（keyed，key='wishadel'），
//     「设置 > 插件 > 插件配置」里的官方 PluginCard 折叠卡。
// 未声明的槽位 inject 会静默等待，不会报错，因此两边都注册是安全的。
// 数据通道不变：仍通过 /wishadel/settings 读写宿主持久化设置。

// 本 bundle 的包名（plugins.bundle.config 的 key 由宿主按包名派发）。
const WISHADEL_PKG = '@cdxdnrf/dsh-client-ui-skin-wishadel'
const WISHADEL_CARD_KEY = 'wishadel'

// ── 官方 PluginCard 风格组件 ─────────────────────────────────────────────
function PluginShell({ title, description, open, onToggle, dirty, children, footer }) {
  return React.createElement('li', { className: `wsh-pcard${open ? ' wsh-pcard-open' : ''}` },
    React.createElement('button', {
      type: 'button',
      className: 'wsh-pcard-header',
      'aria-expanded': open,
      'aria-label': `${open ? '收起' : '展开'}: ${title}`,
      onClick: onToggle,
    },
      React.createElement('span', { className: 'wsh-pcard-headtext' },
        React.createElement('span', { className: 'wsh-pcard-name' }, title),
        React.createElement('span', { className: 'wsh-pcard-desc' }, description)),
      dirty ? React.createElement('span', { className: 'wsh-pcard-pending' }, '未保存') : null,
      React.createElement('span', { className: `wsh-pcard-chevron${open ? ' wsh-pcard-chevron-open' : ''}`, 'aria-hidden': 'true' }, '▾')),
    open ? React.createElement('div', { className: 'wsh-pcard-body' },
      children,
      footer) : null)
}

function FieldRow({ label, hint, badges, children }) {
  return React.createElement('div', { className: 'wsh-pfield' },
    React.createElement('div', { className: 'wsh-pfield-head' },
      React.createElement('span', { className: 'wsh-pfield-label' }, label),
      badges || null),
    hint ? React.createElement('div', { className: 'wsh-pfield-hint' }, hint) : null,
    children)
}

function ToggleRow({ label, hint, checked, onChange }) {
  return React.createElement('div', { className: 'wsh-pfield' },
    React.createElement('div', { className: 'wsh-pfield-head' },
      React.createElement('span', { className: 'wsh-pfield-label' }, label),
      React.createElement('button', {
        type: 'button',
        className: `wsh-pswitch${checked ? ' wsh-pswitch-on' : ''}`,
        role: 'switch',
        'aria-checked': checked,
        onClick: () => onChange(!checked),
      },
        React.createElement('span', { className: 'wsh-pswitch-thumb' }))),
    hint ? React.createElement('div', { className: 'wsh-pfield-hint' }, hint) : null)
}

function InputRow({ label, hint, value, onChange, placeholder, type, min, max }) {
  const isNumber = type === 'number'
  return React.createElement(FieldRow, { label, hint },
    React.createElement('input', {
      className: 'wsh-pinput',
      type: type ?? 'text',
      value: String(value ?? ''),
      placeholder,
      min, max,
      onChange: (event) => onChange(isNumber ? Number(event.target.value) : event.target.value),
    }))
}

function SelectRow({ label, hint, value, options, onChange }) {
  return React.createElement(FieldRow, { label, hint },
    React.createElement('select', { className: 'wsh-pinput', value, onChange: (event) => onChange(event.target.value) },
      options.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label))))
}

function GroupHeading({ text }) {
  return React.createElement('div', { className: 'wsh-pgroup' }, text)
}

// ── 表单状态（两代配置界面共用）──────────────────────────────────────────
function useWishadelConfig(useWishadelSettings, actions) {
  const settings = useWishadelSettings((snapshot) => snapshot)
  const [draft, setDraft] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  // 官方行为：保存成功后自动收起（仅折叠卡用；配置页忽略）。
  const [open, setOpen] = React.useState(false)
  const saveStarted = React.useRef(false)

  React.useEffect(() => {
    if (busy) { saveStarted.current = true; return }
    if (!saveStarted.current) return
    saveStarted.current = false
    if (!draft && !error) setOpen(false)
  }, [busy, draft, error])

  const current = draft ?? settings
  const patch = (section, field, value) => setDraft({
    ...(draft ?? settings),
    [section]: { ...(draft ?? settings)[section], [field]: value },
  })
  const setTheme = (value) => setDraft({ ...(draft ?? settings), theme: value })

  const dirty = draft !== null
  const save = async () => {
    if (!dirty || busy) return
    setBusy(true)
    setError(null)
    try {
      await actions.save(draft)
      setDraft(null)
    } catch (cause) {
      setError(String(cause?.message ?? cause))
    } finally {
      setBusy(false)
    }
  }
  const discard = () => { setDraft(null); setError(null) }

  return { settings, current, patch, setTheme, dirty, busy, error, save, discard, open, setOpen }
}

// 宿主未就绪时的占位（两代界面共用）。
function ConfigUnavailable({ onRetry }) {
  return React.createElement('div', { className: 'wsh-config-missing' },
    React.createElement('p', { className: 'wsh-pfield-hint' }, '无法读取插件配置（宿主服务未就绪或未重启 dsh web）。'),
    React.createElement('button', { type: 'button', className: 'wsh-pbtn wsh-pbtn-save', onClick: onRetry }, '重试'))
}

// ── 字段区（两代界面共用）────────────────────────────────────────────────
function WishadelFields({ state }) {
  const { current, patch, setTheme } = state
  const skins = listSkins()
  const themeOptions = current.themeOptions ?? {}
  const taskboard = current.taskboard ?? {}
  const gitgraph = current.gitgraph ?? {}
  const panel = current.panel ?? {}
  const superseded = current.superseded ?? {}

  return React.createElement(React.Fragment, null,
    React.createElement(SelectRow, {
      label: '主题', hint: '选择生效的皮肤；「默认外观」停用本插件皮肤。',
      value: current.theme ?? 'wishadel',
      options: [{ value: 'none', label: '默认外观（无皮肤）' }, ...skins.map((skin) => ({ value: skin.id, label: skin.name }))],
      onChange: setTheme,
    }),
    current.theme !== 'none' ? React.createElement(React.Fragment, null,
      React.createElement(ToggleRow, { label: '终端装饰与遥测', hint: '右侧遥测文字、编号与斜向状态线。', checked: themeOptions.chrome !== false, onChange: (value) => patch('themeOptions', 'chrome', value) }),
      React.createElement(ToggleRow, { label: '侧栏角色图', hint: '左侧导航栏的角色背景。', checked: themeOptions.sidebarArt !== false, onChange: (value) => patch('themeOptions', 'sidebarArt', value) }),
      React.createElement(ToggleRow, { label: '会话背景', hint: '会话区域的角色群像背景。', checked: themeOptions.conversationArt !== false, onChange: (value) => patch('themeOptions', 'conversationArt', value) })) : null,
    React.createElement(ToggleRow, { label: '启用任务看板', hint: '侧栏底部「任务看板」入口与定时执行引擎。', checked: taskboard.enabled !== false, onChange: (value) => patch('taskboard', 'enabled', value) }),
    React.createElement(InputRow, { label: '调度轮询间隔（毫秒）', hint: 'cron 到点检测频率，最小 5000。', value: taskboard.cronTickMs ?? 30000, type: 'number', min: 5000, max: 600000, onChange: (value) => patch('taskboard', 'cronTickMs', value) }),
    React.createElement(InputRow, { label: '任务默认预设', hint: '留空使用部署默认预设。', value: taskboard.defaultPreset ?? '', placeholder: '(默认)', onChange: (value) => patch('taskboard', 'defaultPreset', value) }),
    React.createElement(InputRow, { label: '任务默认目录', hint: '留空使用当前工作区。', value: taskboard.defaultCwd ?? '', placeholder: '(当前工作区)', onChange: (value) => patch('taskboard', 'defaultCwd', value) }),
    React.createElement(ToggleRow, { label: '启用 Git 图谱', hint: '提交泳道图；提交图谱从工作台「Git」面板的「图谱」按钮打开。', checked: gitgraph.enabled !== false, onChange: (value) => patch('gitgraph', 'enabled', value) }),
    React.createElement(InputRow, { label: '图谱提交上限', hint: '单次拉取的提交数量。', value: gitgraph.maxCommits ?? 200, type: 'number', min: 10, max: 2000, onChange: (value) => patch('gitgraph', 'maxCommits', value) }),
    React.createElement(ToggleRow, { label: '启用右侧面板', hint: 'Git 变更面板与浏览器；文件树、预览与终端已由新版右侧边栏原生提供。', checked: panel.enabled !== false, onChange: (value) => patch('panel', 'enabled', value) }),
    React.createElement(InputRow, { label: '面板默认宽度（像素）', hint: '双击把手复位到该宽度。', value: panel.defaultWidth ?? 380, type: 'number', min: 320, max: 1100, onChange: (value) => patch('panel', 'defaultWidth', value) }),
    React.createElement(InputRow, { label: '预览大小上限（字节）', hint: '超过后截断文本 / 拒绝二进制预览。', value: panel.maxPreviewBytes ?? 2000000, type: 'number', min: 65536, max: 20000000, onChange: (value) => patch('panel', 'maxPreviewBytes', value) }),
    React.createElement(ToggleRow, { label: '浏览器关闭沙箱', hint: '危险：允许嵌入页面访问同源能力，仅对完全信任的页面使用。', checked: panel.browserNoSandbox === true, onChange: (value) => patch('panel', 'browserNoSandbox', value) }),
    React.createElement(InputRow, { label: '终端 Shell', hint: '留空使用系统默认 shell；Windows 可填写 pwsh.exe。', value: panel.terminalShell ?? '', placeholder: '(系统默认)', onChange: (value) => patch('panel', 'terminalShell', value) }),
    React.createElement(GroupHeading, { text: '原生替代功能（新版 DSH 已自带，默认关闭）' }),
    React.createElement(ToggleRow, { label: '历史跳转', hint: '输入框上方的「历史」下拉；新版 DSH 已有原生轮次导航。', checked: superseded.historyJump === true, onChange: (value) => patch('superseded', 'historyJump', value) }),
    React.createElement(ToggleRow, { label: '工作台「活动」标签', hint: '右侧工作台与底部辅助区域的活动页；新版会话头部已原生展示后台任务。', checked: superseded.activityTab === true, onChange: (value) => patch('superseded', 'activityTab', value) }),
    React.createElement(ToggleRow, { label: '工作台「文件」标签', hint: '文件树与多格式预览；新版右侧边栏已原生提供文件树与文档预览。', checked: superseded.panelFiles === true, onChange: (value) => patch('superseded', 'panelFiles', value) }),
    React.createElement(ToggleRow, { label: '工作台「终端」标签', hint: '工作台与底部辅助区域的终端；新版右侧边栏已原生提供终端标签页。', checked: superseded.panelTerminal === true, onChange: (value) => patch('superseded', 'panelTerminal', value) }),
    React.createElement(ToggleRow, { label: 'Git 分支气泡', hint: '输入框上方的浮动 GIT 气泡；新版已在消息尾部原生提供变更文件卡。', checked: superseded.gitDock === true, onChange: (value) => patch('superseded', 'gitDock', value) }),
    React.createElement(ToggleRow, { label: '侧栏会话置顶', hint: '会话行注入置顶按钮；新版侧栏已原生提供搜索与手动排序。', checked: superseded.sidebarPin === true, onChange: (value) => patch('superseded', 'sidebarPin', value) }),
    React.createElement(ToggleRow, { label: '侧栏键盘导航', hint: '方向键/回车在会话列表中移动；新版侧栏已自带键盘处理。', checked: superseded.sidebarNav === true, onChange: (value) => patch('superseded', 'sidebarNav', value) }),
    React.createElement(ToggleRow, { label: '会话文件标签页', hint: '对话区的「文件」标签（git 变更审查/还原）；新版消息尾部已有变更文件卡。', checked: superseded.sessionFiles === true, onChange: (value) => patch('superseded', 'sessionFiles', value) }),
    React.createElement(ToggleRow, { label: '对话迷你滚动条', hint: '会话右缘的自定义拉条；新版 DSH 已有原生对话导航与滚动条。', checked: superseded.scrollRail === true, onChange: (value) => patch('superseded', 'scrollRail', value) }))
}

function ConfigFooter({ state }) {
  return React.createElement('div', { className: 'wsh-pcard-footer' },
    state.error ? React.createElement('p', { className: 'wsh-pcard-failed', role: 'status' }, state.error) : null,
    React.createElement('button', { type: 'button', className: 'wsh-pbtn wsh-pbtn-discard', onClick: state.discard, disabled: !state.dirty || state.busy }, '放弃'),
    React.createElement('button', { type: 'button', className: 'wsh-pbtn wsh-pbtn-save', onClick: state.save, disabled: !state.dirty || state.busy }, state.busy ? '保存中…' : '保存'))
}

const CARD_TITLE = '维什戴尔终端'
const CARD_DESCRIPTION = '主题皮肤、任务看板、Git 图谱、右侧工作台与工作区目录选择'

// 一行摘要（宿主在列表/折叠态取用）。
function wishadelSummary(state) {
  const current = state.current
  if (!current) return '配置不可用（宿主服务未就绪）'
  const theme = current.theme === 'none' ? '默认外观' : (listSkins().find((skin) => skin.id === current.theme)?.name ?? current.theme)
  const on = []
  if (current.taskboard?.enabled !== false) on.push('任务看板')
  if (current.gitgraph?.enabled !== false) on.push('Git 图谱')
  if (current.panel?.enabled !== false) on.push('右侧工作台')
  return `${theme}${on.length ? ' · ' + on.join(' · ') : ''}`
}

// ── dsh ≥ 0.2.0：插件管理器详情页里的配置页 ──────────────────────────────
function WishadelConfigPage(props) {
  const state = useWishadelConfig(props.useWishadelSettings, props.actions)

  if (props.view === 'summary') {
    return React.createElement('span', { className: 'wsh-config-summary' }, wishadelSummary(state))
  }
  if (!state.current) return React.createElement(ConfigUnavailable, { onRetry: () => props.actions.refresh() })

  return React.createElement('section', { className: 'wsh-config', 'aria-label': CARD_TITLE },
    React.createElement('div', { className: 'wsh-config-head' },
      React.createElement('div', { className: 'wsh-pcard-name' }, CARD_TITLE),
      React.createElement('div', { className: 'wsh-pcard-desc' }, CARD_DESCRIPTION)),
    React.createElement(WishadelFields, { state }),
    React.createElement(ConfigFooter, { state }))
}

// ── dsh ≤ 0.1.5：设置里的官方 PluginCard 折叠卡 ──────────────────────────
function WishadelSettingsCard(props) {
  const state = useWishadelConfig(props.useWishadelSettings, props.actions)
  if (!state.current) {
    return React.createElement('li', { className: 'wsh-pcard' },
      React.createElement('div', { className: 'wsh-pcard-body', style: { display: 'block', padding: '14px 16px' } },
        React.createElement(ConfigUnavailable, { onRetry: () => props.actions.refresh() })))
  }
  return React.createElement(PluginShell, {
    title: CARD_TITLE,
    description: CARD_DESCRIPTION,
    open: state.open,
    onToggle: () => state.setOpen((value) => !value),
    dirty: state.dirty,
    footer: React.createElement(ConfigFooter, { state }),
  }, React.createElement(WishadelFields, { state }))
}

function wishadelConfigInject(settingsStore) {
  return () => ({
    hooks: { wishadelSettings: settingsStore },
    actions: { save: (patch) => settingsStore.save(patch), refresh: () => settingsStore.refresh() },
  })
}

function installSettingsCard(ctx, settingsStore) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  const inject = wishadelConfigInject(settingsStore)

  // dsh ≥ 0.2.0：侧栏「插件」→ 本 bundle 详情页的配置区（key = bundle 包名）。
  ctx.effect(() => slots.inject('plugins.bundle.config', () => slots.register({
    name: 'plugins.bundle.config',
    key: WISHADEL_PKG,
    inject,
  }, WishadelConfigPage)), 'wishadel: plugin manager config page')

  // dsh ≤ 0.1.5：设置 → 插件 → 插件配置 的折叠卡（新版该槽位已不存在，注册静默等待）。
  ctx.effect(() => slots.inject('settings.plugin.item', () => slots.register({
    name: 'settings.plugin.item',
    key: WISHADEL_CARD_KEY,
    inject,
  }, WishadelSettingsCard)), 'wishadel: settings card')
}
