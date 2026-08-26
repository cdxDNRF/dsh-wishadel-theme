// 工作区目录选择增强（接管官方「添加工作区…」入口）：
// ui-workspace 在两个 surface 上各声明了一个 single 型 directoryFlow 子槽位：
//   - conversation.hero.workspace.directoryFlow  空地 Hero 的工作区选择器（“添加工作区…”）
//   - sidebar.workspaces.directoryFlow           侧栏工作区浏览区头部的「添加工作区」按钮
// 属主（WorkspacePicker / WorkspaceBrowser）负责触发与接纳：通过 owner 会话
// （open / busy / onPicked / onCancel / onError）与本包交互，选中路径后由属主
// 走官方对象层 createWorkspace({path}) 注册并选中，本包不触碰任何注册表状态。
// single 槽的遮蔽语义：显式 priority 必须与占用方不同（最低者渲染）。
// 官方 browse 后端以默认 priority 0 占用，这里用 -10 显式接管（若组合里
// 没有 browse 后端，槽位空闲时本包就是唯一实现）。注册失败只会记录警告，
// 不会让整个皮肤包加载失败——此时 DSH 自带流程保持原样。

function wishadelFolderBackdrop(props) {
  return React.createElement('div', {
    className: 'wsh-folder-backdrop',
    onMouseDown: (event) => { if (event.target === event.currentTarget && !props.locked) props.onCancel() },
  },
    React.createElement('div', { className: 'wsh-folder-modal wsh-surface', role: 'dialog', 'aria-label': '添加工作区' },
      React.createElement('div', { className: 'wsh-folder-head' },
        React.createElement('strong', null, '添加工作区'),
        React.createElement('button', { type: 'button', onClick: props.onCancel, title: '关闭', disabled: props.locked }, '×')),
      React.createElement('div', { className: 'wsh-folder-body' }, props.children),
      React.createElement('div', { className: 'wsh-folder-actions' },
        React.createElement('button', { type: 'button', onClick: props.onCancel, disabled: props.locked }, '取消'))))
}

function WishadelFolderPanel(props) {
  // props.flow：directoryFlow owner 会话（onPicked/onCancel/onError/busy）。
  // 选中的目录路径一律交给属主接纳（注册 + 列表刷新 + 选中），与官方行为一致。
  const flow = props.flow
  const [capability, setCapability] = React.useState(null)
  const [items, setItems] = React.useState([])
  const [loadError, setLoadError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  const [error, setError] = React.useState('')
  const [manual, setManual] = React.useState('')

  React.useEffect(() => {
    let cancelled = false
    Promise.allSettled([
      api('GET', '/folder-picker/capability'),
      api('GET', '/workspaces'),
    ]).then(([capabilityResult, listResult]) => {
      if (cancelled) return
      if (capabilityResult.status === 'fulfilled') setCapability(capabilityResult.value)
      else setLoadError('读取工作区信息失败，仍可使用手动输入。')
      if (listResult.status === 'fulfilled' && Array.isArray(listResult.value?.items)) setItems(listResult.value.items)
      else setLoadError('读取工作区信息失败，仍可使用手动输入。')
    })
    return () => { cancelled = true }
  }, [])

  const cancelRef = React.useRef(() => {})
  cancelRef.current = () => { flow?.onCancel() }
  React.useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape' && !busy) cancelRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy])

  const fail = (text) => {
    setBusy(false)
    setError(String(text))
    setNotice('')
    if (flow) flow.onError(String(text))
  }

  const emit = (path) => {
    if (flow) flow.onPicked(path)
  }

  const pickFolder = async () => {
    setBusy(true)
    setError('')
    setNotice('已打开 Windows 文件夹选择窗口，请在系统中选取目录…')
    try {
      const result = await api('POST', '/folder-picker/pick', {})
      setNotice('')
      if (result?.cancelled) { setBusy(false); return }
      if (!result?.path) throw new Error('没有选择目录')
      emit(String(result.path))
    } catch (cause) {
      fail(String(cause?.message ?? cause))
    }
  }

  const useManual = async () => {
    const value = manual.trim()
    if (!value || busy) return
    setBusy(true)
    setError('')
    setNotice('正在校验路径…')
    try {
      const result = await api('POST', '/folder-picker/expand', { path: value })
      emit(String(result?.path ?? ''))
    } catch (cause) {
      fail(String(cause?.message ?? cause))
    }
  }

  const locked = busy || Boolean(flow?.busy)
  const canDialog = capability?.kind === 'windows-dialog'
  const bodyParts = []
  if (canDialog) {
    bodyParts.push(React.createElement('button', {
      type: 'button',
      className: 'wsh-btn primary wsh-folder-pick',
      onClick: pickFolder,
      disabled: locked,
    }, busy ? '选择窗口中…' : '📁 选择文件夹…'))
  }
  bodyParts.push(React.createElement('div', { className: 'wsh-folder-note' }, capability?.note ?? '当前环境无法弹出系统文件夹窗口。'))
  if (flow?.busy) bodyParts.push(React.createElement('div', { className: 'wsh-folder-note' }, '正在登记并打开工作区…'))
  if (notice) bodyParts.push(React.createElement('div', { className: 'wsh-folder-ok', role: 'status' }, notice))
  if (error) bodyParts.push(React.createElement('div', { className: 'wsh-folder-error', role: 'alert' }, error))
  if (items.length > 0) {
    bodyParts.push(
      React.createElement('div', { className: 'wsh-folder-label wsh-label' }, '已注册工作区 · 点击直接打开'),
      React.createElement('div', { className: 'wsh-folder-list' },
        items.map((item, index) => React.createElement('button', {
          key: item.path || index,
          type: 'button',
          className: 'wsh-folder-row',
          title: item.path,
          disabled: locked,
          onClick: () => emit(item.path),
        },
          React.createElement('span', { className: 'wsh-folder-title' }, item.title),
          React.createElement('span', { className: 'wsh-folder-path' }, item.path)))))
  } else {
    bodyParts.push(React.createElement('div', { className: 'wsh-hint' }, loadError || '暂无已注册工作区'))
  }
  bodyParts.push(React.createElement('div', { className: 'wsh-folder-label wsh-label' }, '或手动输入目录（支持 ~、Windows 路径与相对路径）'))
  bodyParts.push(React.createElement('div', { className: 'wsh-folder-manual' },
    React.createElement('input', {
      type: 'text',
      value: manual,
      placeholder: '/mnt/c/Users/DFWJ/Projects 或 C:\\Users\\…',
      onChange: (event) => setManual(event.target.value),
      onKeyDown: (event) => { if (event.key === 'Enter') useManual() },
      disabled: locked,
      'aria-label': '工作区路径',
    }),
    React.createElement('button', { type: 'button', className: 'wsh-btn', onClick: useManual, disabled: locked || !manual.trim() }, '使用该路径')))

  const body = React.createElement(React.Fragment, null, bodyParts)
  const modal = React.createElement(wishadelFolderBackdrop, {
    onCancel: () => { if (!locked) cancelRef.current() },
    locked,
  }, body)
  if (typeof ReactDOM !== 'undefined' && ReactDOM.createPortal) return ReactDOM.createPortal(modal, document.body)
  return modal
}

// 官方 directoryFlow owner 会话：open 上升沿渲染本包面板，路径经 onPicked 交属主接纳。
function WishadelDirectoryFlow(props) {
  if (!props.open) return null
  return React.createElement(WishadelFolderPanel, {
    flow: {
      onPicked: props.onPicked,
      onCancel: props.onCancel,
      onError: props.onError,
      busy: Boolean(props.busy),
    },
  })
}

function installWorkspaceFlow(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return

  // 两个 official directoryFlow 洞（single）：显式 priority -10 接管默认的 browse 后端。
  // 注册用 try/catch 包裹：发生槽位冲突时只记录警告，绝不击穿整个皮肤包。
  ctx.effect(() => slots.inject('conversation.hero.workspace.directoryFlow', () => slots.inject('sidebar.workspaces.directoryFlow', function* () {
    for (const slotName of ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow']) {
      try {
        yield slots.register({
          name: slotName,
          id: 'wishadel-workspace-folder-flow',
          priority: -10,
          label: '系统文件夹选择',
        }, (props) => React.createElement(WishadelDirectoryFlow, { ...props }))
      } catch (error) {
        console.warn(`wishadel: 目录选择槽位 ${slotName} 注册让位（${String(error?.message ?? error)}）`)
      }
    }
  })), 'wishadel: workspace folder flow')
}