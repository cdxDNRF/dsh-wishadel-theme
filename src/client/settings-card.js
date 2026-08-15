// 设置卡：注册到「设置 > 插件 > 插件配置」。
// 通过 /wishadel/settings 读写宿主持久化设置，保存即时生效。
// 包含：主题选择（皮肤注册表）、主题选项、任务看板/Git 图谱/右侧面板开关与参数。

const NS = 'settings.pluginInventory' // 占位，防止误用；卡片自带文案

function Field({ label, hint, children }) {
  return React.createElement('label', { className: 'wsh-settings-field' },
    React.createElement('span', { className: 'wsh-settings-copy' },
      React.createElement('strong', null, label),
      hint ? React.createElement('small', null, hint) : null),
    children)
}

function SectionTitle({ code, text }) {
  return React.createElement('div', { className: 'wsh-settings-head' },
    React.createElement('strong', null, text),
    React.createElement('span', null, code))
}

function SelectField({ label, hint, value, options, onChange }) {
  return React.createElement('div', { className: 'wsh-settings-row' },
    React.createElement('span', { className: 'wsh-settings-copy' },
      React.createElement('strong', null, label),
      hint ? React.createElement('small', null, hint) : null),
    React.createElement('select', { value, onChange: (event) => onChange(event.target.value) },
      options.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label))))
}

function NumberField({ label, hint, value, onChange, min, max }) {
  return React.createElement('div', { className: 'wsh-settings-row' },
    React.createElement('span', { className: 'wsh-settings-copy' },
      React.createElement('strong', null, label),
      hint ? React.createElement('small', null, hint) : null),
    React.createElement('input', {
      type: 'number', min, max, value,
      onChange: (event) => onChange(Number(event.target.value)),
    }))
}

function TextField({ label, hint, value, onChange, placeholder }) {
  return React.createElement('div', { className: 'wsh-settings-row' },
    React.createElement('span', { className: 'wsh-settings-copy' },
      React.createElement('strong', null, label),
      hint ? React.createElement('small', null, hint) : null),
    React.createElement('input', {
      type: 'text', value, placeholder,
      onChange: (event) => onChange(event.target.value),
    }))
}

function CheckField({ label, hint, checked, onChange }) {
  return React.createElement('label', { className: 'wsh-settings-field' },
    React.createElement('input', { className: 'wsh-check', type: 'checkbox', checked, onChange: (event) => onChange(event.target.checked) }),
    React.createElement('span', { className: 'wsh-settings-copy' },
      React.createElement('strong', null, label),
      hint ? React.createElement('small', null, hint) : null))
}

function WishadelSettingsCard({ useWishadelSettings, actions }) {
  const settings = useWishadelSettings((snapshot) => snapshot)
  const [draft, setDraft] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)

  const current = draft ?? settings
  if (!current) {
    return React.createElement('li', { className: 'wsh-settings-card wsh-surface' },
      React.createElement('div', { className: 'wsh-settings-head' },
        React.createElement('strong', null, '维什戴尔终端'),
        React.createElement('span', null, "WIS'ADEL // CONTROL")),
      React.createElement('p', { style: { margin: '0 0 8px' } }, '无法读取插件配置（宿主服务未就绪或未重启 dsh web）。'),
      React.createElement('button', { className: 'wsh-btn', onClick: () => actions.refresh() }, '重试'))
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

  return React.createElement('li', { className: 'wsh-settings-card wsh-surface' },
    React.createElement(SectionTitle, { code: "WIS'ADEL // CONTROL", text: '维什戴尔终端' }),
    React.createElement('div', { className: 'wsh-settings-fields' },
      React.createElement(SelectField, {
        label: '主题', hint: '选择生效的皮肤；「默认外观」停用本插件皮肤。',
        value: current.theme ?? 'wishadel',
        options: [{ value: 'none', label: '默认外观（无皮肤）' }, ...skins.map((skin) => ({ value: skin.id, label: skin.name }))],
        onChange: setTheme,
      }),
      current.theme !== 'none' ? React.createElement(React.Fragment, null,
        React.createElement(CheckField, { label: '终端装饰与遥测', hint: '右侧遥测文字、编号与斜向状态线。', checked: themeOptions.chrome !== false, onChange: (value) => patch('themeOptions', 'chrome', value) }),
        React.createElement(CheckField, { label: '侧栏角色图', hint: '左侧导航栏的角色背景。', checked: themeOptions.sidebarArt !== false, onChange: (value) => patch('themeOptions', 'sidebarArt', value) }),
        React.createElement(CheckField, { label: '会话背景', hint: '会话区域的角色群像背景。', checked: themeOptions.conversationArt !== false, onChange: (value) => patch('themeOptions', 'conversationArt', value) })) : null,
      React.createElement(CheckField, { label: '启用任务看板', hint: '侧栏底部「任务看板」入口与定时执行引擎。', checked: taskboard.enabled !== false, onChange: (value) => patch('taskboard', 'enabled', value) }),
      React.createElement(NumberField, { label: '调度轮询间隔（毫秒）', hint: 'cron 到点检测频率，最小 5000。', value: taskboard.cronTickMs ?? 30000, min: 5000, max: 600000, onChange: (value) => patch('taskboard', 'cronTickMs', value) }),
      React.createElement(TextField, { label: '任务默认预设', hint: '留空使用部署默认预设。', value: taskboard.defaultPreset ?? '', placeholder: '(默认)', onChange: (value) => patch('taskboard', 'defaultPreset', value) }),
      React.createElement(TextField, { label: '任务默认目录', hint: '留空使用当前工作区。', value: taskboard.defaultCwd ?? '', placeholder: '(当前工作区)', onChange: (value) => patch('taskboard', 'defaultCwd', value) }),
      React.createElement(CheckField, { label: '启用 Git 图谱', hint: '输入框上方分支选择器与提交泳道图。', checked: gitgraph.enabled !== false, onChange: (value) => patch('gitgraph', 'enabled', value) }),
      React.createElement(NumberField, { label: '图谱提交上限', hint: '单次拉取的提交数量。', value: gitgraph.maxCommits ?? 200, min: 10, max: 2000, onChange: (value) => patch('gitgraph', 'maxCommits', value) }),
      React.createElement(CheckField, { label: '启用右侧面板', hint: '文件树、多格式预览与 Git 变更面板。', checked: panel.enabled !== false, onChange: (value) => patch('panel', 'enabled', value) }),
      React.createElement(NumberField, { label: '面板默认宽度（像素）', hint: '双击把手复位到该宽度。', value: panel.defaultWidth ?? 380, min: 320, max: 1100, onChange: (value) => patch('panel', 'defaultWidth', value) }),
      React.createElement(NumberField, { label: '预览大小上限（字节）', hint: '超过后截断文本 / 拒绝二进制预览。', value: panel.maxPreviewBytes ?? 2000000, min: 65536, max: 20000000, onChange: (value) => patch('panel', 'maxPreviewBytes', value) })),
    dirty ? React.createElement('div', { className: 'wsh-settings-savebar' },
      React.createElement('button', { className: 'wsh-btn primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
      React.createElement('button', { className: 'wsh-btn', onClick: discard }, '放弃'),
      React.createElement('span', { className: 'wsh-note' }, '保存后即时生效，并持久化到宿主配置。'),
      error ? React.createElement('span', { className: 'wsh-error' }, error) : null) : null)
}

function installSettingsCard(ctx, settingsStore) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  ctx.effect(() => slots.inject('settings.plugin.item', () => slots.register({
    name: 'settings.plugin.item',
    id: 'wishadel-theme',
    order: 30,
    label: '维什戴尔终端',
    inject: () => ({
      hooks: { wishadelSettings: settingsStore },
      actions: { save: (patch) => settingsStore.save(patch), refresh: () => settingsStore.refresh() },
    }),
  }, WishadelSettingsCard)), 'wishadel: settings card')
}

