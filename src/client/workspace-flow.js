// 工作区目录选择增强：
// - 侧栏底部「添加工作区」按钮（始终可见的确定性入口）；
// - 面板提供三条添加路径：Windows 文件夹弹窗（WSL interop）、已注册工作区快捷列表、手动输入；
// - 同时向官方 directoryFlow 单一槽位注册同一套面板：若组合里没有其他目录选择流程
//   （或本插件先注册），DSH 自带的「添加工作区…」也会打开它。
// 选中目录后由官方客户端服务物化工作区（workspaces.create + connectWorkspace + sessions.open），
// 与 DSH 的 New Session 流程完全一致，不绕过注册表状态。

function wishadelFolderBackdrop(props) {
  return React.createElement('div', {
    className: 'wsh-folder-backdrop',
    onMouseDown: (event) => { if (event.target === event.currentTarget) props.onCancel() },
  },
    React.createElement('div', { className: 'wsh-folder-modal wsh-surface', role: 'dialog', 'aria-label': '添加工作区' },
      React.createElement('div', { className: 'wsh-folder-head' },
        React.createElement('strong', null, '添加工作区'),
        React.createElement('button', { type: 'button', onClick: props.onCancel, title: '关闭' }, '×')),
      React.createElement('div', { className: 'wsh-folder-body' }, props.children),
      React.createElement('div', { className: 'wsh-folder-actions' },
        React.createElement('button', { type: 'button', onClick: props.onCancel, disabled: props.locked }, '取消'))))
}

function WishadelFolderPanel(props) {
  const runtime = props.runtime
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
      if (listResult.status === 'fulfilled' && Array.isArray(listResult.value?.items)) setItems(listResult.value.items)
      else setLoadError('读取工作区信息失败，仍可使用手动输入。')
    })
    return () => { cancelled = true }
  }, [])

  React.useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape' && !busy) cancelRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy])
  const cancelRef = React.useRef(() => {})
  cancelRef.current = () => { props.onClose?.() }

  const fail = (text) => {
    setBusy(false)
    setError(String(text))
    setNotice('')
  }

  const adopt = async (path) => {
    const workspaces = runtime?.workspaces
    const sessions = runtime?.sessions
    setBusy(true)
    setError('')
    setNotice('正在登记工作区…')
    try {
      if (!workspaces || typeof workspaces.create !== 'function') throw new Error('工作区服务未就绪，请重启 dsh web 后再试')
      const result = await workspaces.create({ path })
      if (!result?.ok) throw new Error(String(result?.error?.message ?? '创建工作区失败'))
      const workspaceId = result?.value?.workspace?.workspaceId
      if (!workspaceId) throw new Error('宿主未返回工作区标识')
      const sessionId = await workspaces.connectWorkspace(workspaceId)
      if (typeof sessions?.open === 'function') sessions.open(sessionId)
      else if (typeof runtime?.openSession === 'function') runtime.openSession(sessionId)
      setBusy(false)
      setNotice('✓ 工作区已打开')
    } catch (cause) {
      fail(String(cause?.message ?? cause))
    }
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
      await adopt(String(result.path))
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
      await adopt(String(result?.path ?? ''))
    } catch (cause) {
      fail(String(cause?.message ?? cause))
    }
  }

  const locked = busy
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
          onClick: () => adopt(item.path),
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

// 官方 directoryFlow 槽位说明：其 owner 由 ui-workspace 声明（single kind）。
// 动态（loader）插件的 slots.register 会被 runner 强制分配 shadowing priority，
// 已占用槽位上直接再注册会触发前端 loader 冲突错误，进而整个包 apply 失败。
// 因此本包不抢占官方目录选择槽位——DSH 自带流程保持不变，我们的确定性入口
// 是侧栏底部的「添加工作区」按钮（sidebar.footer.action，list 槽，增量渲染）。

// 侧栏底部「添加工作区」入口（自托管面板）。
function WorkspaceAddTrigger(props) {
  const [open, setOpen] = React.useState(false)
  const wide = props.wide !== false
  return React.createElement(React.Fragment, null,
    React.createElement('button', {
      type: 'button',
      className: `wsh-sidebar-action wsh-surface${wide ? '' : ' wsh-sidebar-action-rail'}`,
      title: '添加工作区：系统文件夹选择、已注册工作区或手动路径',
      'aria-label': '添加工作区',
      'aria-pressed': open,
      onClick: () => setOpen((value) => !value),
    },
      wide
        ? React.createElement(React.Fragment, null,
          React.createElement('span', { className: 'wsh-label' }, '添加工作区'),
          open ? React.createElement('span', { className: 'wsh-tag live' }, 'OPEN') : null)
        : React.createElement('span', { className: 'wsh-sidebar-action-icon', 'aria-hidden': 'true' }, '▤')),
    open ? React.createElement(WishadelFolderPanel, { runtime: props.runtime, onClose: () => setOpen(false) }) : null)
}

function installWorkspaceFlow(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  const runtime = { workspaces: ctx.get('workspaces'), sessions: ctx.get('sessions') }

  // 侧栏底部确定性入口（list 槽：与任务看板并列，不受单一槽位遮蔽语义影响）。
  ctx.effect(() => slots.inject('sidebar.footer.action', () => slots.register({
    name: 'sidebar.footer.action',
    id: 'wishadel-workspace-add',
    order: 55,
    label: '添加工作区',
  }, (props) => React.createElement(WorkspaceAddTrigger, { ...props, runtime }))), 'wishadel: workspace add action')
}