// 设置卡：注册到「设置 > 插件 > 插件配置」。
// 视觉与交互对齐官方 PluginCard（ui-settings-plugins 的标准插件卡）：
// 圆角卡片 + 标题/描述/chevron 折叠头 + 保存成功自动收起 + 底部保存/放弃；
// 字段为分隔行式布局，开关用原生 checkbox（官方用 switch，视觉等价）。
// 数据通道不变：仍通过 /wishadel/settings 读写宿主持久化设置。

const NS = 'settings.pluginInventory' // 占位，防止误用；卡片自带文案

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

// ── 卡片本体 ─────────────────────────────────────────────────────────────
function WishadelSettingsCard({ useWishadelSettings, actions }) {
  const settings = useWishadelSettings((snapshot) => snapshot)
  const [draft, setDraft] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  // 官方行为：保存成功后自动收起
  const [open, setOpen] = React.useState(false)
  const saveStarted = React.useRef(false)

  React.useEffect(() => {
    if (busy) { saveStarted.current = true; return }
    if (!saveStarted.current) return
    saveStarted.current = false
    if (!draft && !error) setOpen(false)
  }, [busy, draft, error])

  const current = draft ?? settings
  if (!current) {
    return React.createElement('li', { className: 'wsh-pcard' },
      React.createElement('div', { className: 'wsh-pcard-body', style: { display: 'block', padding: '14px 16px' } },
        React.createElement('p', { className: 'wsh-pfield-hint', style: { margin: 0, padding: 0 } }, '无法读取插件配置（宿主服务未就绪或未重启 dsh web）。'),
        React.createElement('button', { type: 'button', className: 'wsh-pbtn wsh-pbtn-save', onClick: () => actions.refresh(), style: { marginTop: 10 } }, '重试')))
  }

  const skins = listSkins()
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

  const themeOptions = current.themeOptions ?? {}
  const taskboard = current.taskboard ?? {}
  const gitgraph = current.gitgraph ?? {}
  const panel = current.panel ?? {}
  const superseded = current.superseded ?? {}

  return React.createElement(PluginShell, {
    title: '维什戴尔终端',
    description: '主题皮肤、任务看板、Git 图谱、右侧工作台与工作区目录选择',
    open,
    onToggle: () => setOpen((value) => !value),
    dirty,
    footer: React.createElement('div', { className: 'wsh-pcard-footer' },
      error ? React.createElement('p', { className: 'wsh-pcard-failed', role: 'status' }, error) : null,
      React.createElement('button', { type: 'button', className: 'wsh-pbtn wsh-pbtn-discard', onClick: discard, disabled: !dirty || busy }, '放弃'),
      React.createElement('button', { type: 'button', className: 'wsh-pbtn wsh-pbtn-save', onClick: save, disabled: !dirty || busy }, busy ? '保存中…' : '保存')),
  },
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
    React.createElement(ToggleRow, { label: '启用 Git 图谱', hint: '输入框上方分支选择器与提交泳道图。', checked: gitgraph.enabled !== false, onChange: (value) => patch('gitgraph', 'enabled', value) }),
    React.createElement(InputRow, { label: '图谱提交上限', hint: '单次拉取的提交数量。', value: gitgraph.maxCommits ?? 200, type: 'number', min: 10, max: 2000, onChange: (value) => patch('gitgraph', 'maxCommits', value) }),
    React.createElement(ToggleRow, { label: '启用右侧面板', hint: '文件树、多格式预览与 Git 变更面板。', checked: panel.enabled !== false, onChange: (value) => patch('panel', 'enabled', value) }),
    React.createElement(InputRow, { label: '面板默认宽度（像素）', hint: '双击把手复位到该宽度。', value: panel.defaultWidth ?? 380, type: 'number', min: 320, max: 1100, onChange: (value) => patch('panel', 'defaultWidth', value) }),
    React.createElement(InputRow, { label: '预览大小上限（字节）', hint: '超过后截断文本 / 拒绝二进制预览。', value: panel.maxPreviewBytes ?? 2000000, type: 'number', min: 65536, max: 20000000, onChange: (value) => patch('panel', 'maxPreviewBytes', value) }),
    React.createElement(ToggleRow, { label: '浏览器关闭沙箱', hint: '危险：允许嵌入页面访问同源能力，仅对完全信任的页面使用。', checked: panel.browserNoSandbox === true, onChange: (value) => patch('panel', 'browserNoSandbox', value) }),
    React.createElement(InputRow, { label: '终端 Shell', hint: '留空使用系统默认 shell；Windows 可填写 pwsh.exe。', value: panel.terminalShell ?? '', placeholder: '(系统默认)', onChange: (value) => patch('panel', 'terminalShell', value) }),
    React.createElement(GroupHeading, { text: '原生替代功能（新版 DSH 已自带，默认关闭）' }),
    React.createElement(ToggleRow, { label: '历史跳转', hint: '输入框上方的「历史」下拉；新版 DSH 已有原生轮次导航。', checked: superseded.historyJump === true, onChange: (value) => patch('superseded', 'historyJump', value) }),
    React.createElement(ToggleRow, { label: '工作台「活动」标签', hint: '右侧工作台与底部辅助区域的活动页；新版会话头部已原生展示任务。', checked: superseded.activityTab === true, onChange: (value) => patch('superseded', 'activityTab', value) }),
    React.createElement(ToggleRow, { label: '侧栏键盘导航', hint: '方向键/回车在会话列表中移动；新版侧栏已自带键盘处理。', checked: superseded.sidebarNav === true, onChange: (value) => patch('superseded', 'sidebarNav', value) }),
    React.createElement(ToggleRow, { label: '会话文件标签页', hint: '对话区的「文件」标签（git 变更审查/还原）；新版消息尾部已有产出文件行。', checked: superseded.sessionFiles === true, onChange: (value) => patch('superseded', 'sessionFiles', value) }),
    React.createElement(ToggleRow, { label: '对话迷你滚动条', hint: '会话右缘的自定义拉条；新版 DSH 已有原生对话导航与滚动条。', checked: superseded.scrollRail === true, onChange: (value) => patch('superseded', 'scrollRail', value) }))
}

function installSettingsCard(ctx, settingsStore) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  ctx.effect(() => slots.inject('settings.plugin.item', () => slots.register({
    name: 'settings.plugin.item',
    key: 'wishadel',
    inject: () => ({
      hooks: { wishadelSettings: settingsStore },
      actions: { save: (patch) => settingsStore.save(patch), refresh: () => settingsStore.refresh() },
    }),
  }, WishadelSettingsCard)), 'wishadel: settings card')
}