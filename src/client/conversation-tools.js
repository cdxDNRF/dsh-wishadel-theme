// 对话增强：编辑器内使用当前会话模型进行提示词优化。

function wishadelComposerTextarea() {
  return document.querySelector('[data-composer-card] textarea[placeholder="给智能体发消息"], [data-composer-card] textarea')
}

async function wishadelSetComposerText(text) {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    const input = wishadelComposerTextarea()
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      if (setter) setter.call(input, text)
      else input.value = text
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      input.focus()
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
  const input = () => wishadelComposerTextarea()
  const openEditor = () => {
    const text = input()?.value ?? ''
    setSource(text)
    setOptimized('')
    setError('')
    setOpen(true)
  }
  const optimize = async () => {
    const text = source.trim() || input()?.value?.trim() || ''
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
  return React.createElement('span', { className: 'wsh-prompt-tool' },
    React.createElement('button', { type: 'button', className: 'wsh-prompt-optimize', onClick: openEditor, title: '使用当前会话模型在输入框内优化提示词', 'aria-label': '使用当前模型优化提示词' }, '提示词优化'),
    open ? React.createElement('div', { className: 'wsh-prompt-popover', role: 'dialog', 'aria-label': '当前模型提示词优化' },
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
        React.createElement('button', { type: 'button', className: 'primary', onClick: apply, disabled: loading || !optimized.trim() }, '确认替换输入'))
    ) : null)
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
