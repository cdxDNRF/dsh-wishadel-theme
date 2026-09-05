// 对话增强：编辑器内使用当前会话模型进行提示词优化。
// dsh 0.1.2 起输入框从 <textarea> 换成 Lexical contentEditable div
// （[data-composer-input]，带 data-lexical-text span）；旧版仍是 textarea。
// 读取：textarea 用 .value，contentEditable 用 .textContent。
// 回填：textarea 用 value setter + input 事件；contentEditable 用全选 +
// execCommand('insertText')（Lexical 监听 beforeinput，状态可靠同步）。

function wishadelComposerTextarea() {
  return document.querySelector('[data-composer-card] textarea[placeholder="给智能体发消息"], [data-composer-card] textarea')
}

function wishadelComposerInput() {
  // 新版 Lexical contentEditable 优先；旧版 textarea 兜底。
  return document.querySelector('[data-composer-card] [data-composer-input][contenteditable="true"]')
    ?? wishadelComposerTextarea()
}

function wishadelReadComposerText() {
  const el = wishadelComposerInput()
  if (!el) return ''
  if (el instanceof HTMLTextAreaElement) return el.value ?? ''
  // contentEditable：textContent 已含全部文本（Lexical 的 <p>/<span> 摊平）。
  return (el.textContent ?? '').replace(/\u00a0/g, ' ')
}

async function wishadelSetComposerText(text) {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    const el = wishadelComposerInput()
    if (el) {
      if (el instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        if (setter) setter.call(el, text)
        else el.value = text
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        el.focus()
        return true
      }
      // Lexical contentEditable：全选现有内容 → execCommand 替换。
      // Lexical 监听 beforeinput，经此路径写入的文本会进入受控状态
      // （发送按钮可用性、mirror 等同步更新，实测验证）。
      el.focus()
      const selection = window.getSelection()
      if (selection) {
        const range = document.createRange()
        range.selectNodeContents(el)
        selection.removeAllRanges()
        selection.addRange(range)
        if (document.execCommand('insertText', false, text)) return true
      }
      // execCommand 不可用时退化为纯 DOM 替换（Lexical 状态可能不同步，仅最后手段）。
      el.textContent = text
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  return false
}

function PromptOptimizer(props) {
  const [open, setOpen] = React.useState(false)
  const [source, setSource] = React.useState('')
  const [optimized, setOptimized] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState('')
  const modelDirectories = props.modelDirectories
  const readInput = () => wishadelReadComposerText()

  // 弹窗期间 Esc 关闭（portal 挂载在 body，焦点可能在面板外）。
  React.useEffect(() => {
    if (!open) return
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const openEditor = () => {
    const text = readInput()
    setSource(text)
    setOptimized('')
    setError('')
    setOpen(true)
  }
  const optimize = async () => {
    const text = source.trim() || readInput().trim() || ''
    if (!text || !props.sessionId || loading) return
    setSource(text); setOptimized(''); setError(''); setLoading(true)
    try {
      let selection
      try {
        const directory = modelDirectories?.directoryFor?.(props.sessionId)
        const current = directory?.store?.getSnapshot?.()?.current
        if (current?.provider && current?.model) selection = { provider: current.provider, model: current.model, ...(current.reasoningEffort ? { reasoningEffort: current.reasoningEffort } : {}) }
      } catch { /* 使用 Host 从会话日志解析的兼容回退 */ }
      const result = await api('POST', '/prompt-optimize', { sessionId: props.sessionId, text, ...(selection ? { selection } : {}) })
      setOptimized(String(result.text ?? '').trim())
      if (!result.text) setError('模型没有返回优化结果')
    } catch (cause) {
      setError(String(cause?.message ?? cause))
    } finally { setLoading(false) }
  }
  const apply = async () => {
    if (!optimized.trim()) return
    await wishadelSetComposerText(optimized.trim())
    setOpen(false)
  }
  const buttonEl = React.createElement('button', { type: 'button', className: 'wsh-prompt-optimize', onClick: openEditor, title: '使用当前会话模型在输入框内优化提示词', 'aria-label': '使用当前模型优化提示词' }, '提示词优化')
  const popoverEl = React.createElement('div', { className: 'wsh-prompt-backdrop', onMouseDown: (event) => { if (event.target === event.currentTarget) setOpen(false) } },
    React.createElement('div', { className: 'wsh-prompt-popover wsh-prompt-modal', role: 'dialog', 'aria-label': '当前模型提示词优化' },
      React.createElement('div', { className: 'wsh-prompt-popover-head' },
        React.createElement('strong', null, '当前模型优化'),
        React.createElement('button', { type: 'button', onClick: () => setOpen(false), title: '关闭' }, '×')),
      React.createElement('div', { className: 'wsh-prompt-model-hint' }, props.sessionId ? '优化请求不会发送到当前对话，也不会写入聊天记录' : '当前没有可用会话'),
      React.createElement('div', { className: 'wsh-prompt-compare' },
        React.createElement('label', null, '原始输入', React.createElement('textarea', { value: source, onChange: (event) => setSource(event.target.value), placeholder: '在对话框输入内容后再打开此面板', 'aria-label': '原始提示词' })),
        React.createElement('label', null, '模型优化稿', React.createElement('textarea', { value: optimized, readOnly: true, placeholder: loading ? '当前会话模型正在优化…' : '点击“使用当前模型优化”生成', 'aria-label': '模型优化后的提示词' }))),
      error ? React.createElement('div', { className: 'wsh-prompt-error', role: 'alert' }, error) : null,
      React.createElement('div', { className: 'wsh-prompt-popover-actions' },
        React.createElement('button', { type: 'button', onClick: optimize, disabled: loading || !source.trim() || !props.sessionId }, loading ? '优化中…' : optimized ? '重新优化' : '使用当前模型优化'),
        React.createElement('button', { type: 'button', onClick: () => setOpen(false) }, '取消'),
        React.createElement('button', { type: 'button', className: 'primary', onClick: apply, disabled: loading || !optimized.trim() }, '确认替换输入'))))
  return React.createElement(React.Fragment, null,
    buttonEl,
    open && typeof ReactDOM !== 'undefined' ? ReactDOM.createPortal(popoverEl, document.body) : null)
}

function installPromptOptimizer(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  const modelDirectories = ctx.get('modelDirectories')
  ctx.effect(() => slots.inject('conversation.input.right', () => slots.register({
    name: 'conversation.input.right',
    id: 'wishadel-prompt-optimizer',
    order: 50,
    label: '提示词优化',
  }, (props) => React.createElement(PromptOptimizer, { ...props, modelDirectories }))), 'wishadel: prompt optimizer')
}

function installConversationTools(ctx) {
  installPromptOptimizer(ctx)
}
