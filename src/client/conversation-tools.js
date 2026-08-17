// 对话增强：最近两条用户消息回退 + 工程化提示词优化。
// 回退只读取当前 DOM 中宿主已经展示的消息，不持久化 live 会话对象。

function wishadelComposerTextarea() {
  return document.querySelector('[data-composer-card] textarea[placeholder="给智能体发消息"], [data-composer-card] textarea')
}

function wishadelSetComposerText(text) {
  const input = wishadelComposerTextarea()
  if (!input) return false
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (setter) setter.call(input, text)
  else input.value = text
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  input.focus()
  return true
}

function wishadelUserRows() {
  return [...document.querySelectorAll('[data-chat-flow-kind="user"]')]
}

function wishadelUserPayload(row) {
  const text = row.querySelector('[class*="_text_"], [class*="bubble"]')?.textContent ?? ''
  const images = [...row.querySelectorAll('img[src]')].map((img, index) => ({
    src: img.currentSrc || img.src,
    name: img.alt || `image-${index + 1}.png`,
  })).filter((image) => /^blob:|^data:image\//i.test(image.src))
  return { text: text.trim(), images }
}

async function wishadelRestoreImages(images) {
  if (!images.length) return 0
  const files = []
  for (const image of images) {
    try {
      const response = await fetch(image.src)
      if (!response.ok) continue
      const blob = await response.blob()
      const type = blob.type || 'image/png'
      const extension = type.split('/')[1] || 'png'
      const name = /\.[a-z0-9]+$/i.test(image.name) ? image.name : `${image.name}.${extension}`
      files.push(new File([blob], name, { type }))
    } catch { /* 图片 URL 已过期时保留文字回退 */ }
  }
  if (!files.length) return 0
  const input = wishadelComposerTextarea()
  if (!input) return 0
  const transfer = new DataTransfer()
  files.forEach((file) => transfer.items.add(file))
  let pasted = false
  try {
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })
    pasted = input.dispatchEvent(event)
  } catch { /* 某些浏览器禁止构造 ClipboardEvent，继续使用 input fallback */ }
  if (!pasted) {
    try {
      input.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
      pasted = true
    } catch { /* noop */ }
  }
  return pasted ? files.length : 0
}

async function wishadelRestorePayload(payload) {
  wishadelSetComposerText(payload.text)
  if (payload.images.length) await wishadelRestoreImages(payload.images)
}

function WishadelRollbackButton({ payload }) {
  const [busy, setBusy] = React.useState(false)
  const [status, setStatus] = React.useState('')
  const restore = async () => {
    setBusy(true); setStatus('')
    try {
      await wishadelRestorePayload(payload)
      setStatus(payload.images.length ? '已回填文字与图片' : '已回填输入')
    } catch (cause) { setStatus(`回退失败：${String(cause?.message ?? cause)}`) }
    finally { setBusy(false); setTimeout(() => setStatus(''), 2200) }
  }
  return React.createElement(React.Fragment, null,
    React.createElement('button', { type: 'button', className: 'wsh-conversation-action', onClick: restore, disabled: busy, title: '将这条输入回填到对话框', 'aria-label': '回退此输入' }, busy ? '回填中' : '回退'),
    status ? React.createElement('span', { className: 'wsh-conversation-action-status' }, status) : null)
}

function installRollbackButtons(ctx) {
  let timer = null
  const render = () => {
    const rows = wishadelUserRows()
    const eligible = new Set(rows.slice(-2))
    for (const row of rows) {
      const actions = row.querySelector('.p-xYUq_actions')
      if (!actions) continue
      const old = actions.querySelector('.wsh-rollback-host')
      if (!eligible.has(row)) { old?.remove(); continue }
      if (old) continue
      const host = document.createElement('span')
      host.className = 'wsh-rollback-host'
      host.dataset.wishadelOwned = 'true'
      actions.appendChild(host)
      const payload = wishadelUserPayload(row)
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'wsh-conversation-action'
      button.title = '将这条输入回填到对话框'
      button.setAttribute('aria-label', '回退此输入')
      button.textContent = '回退'
      let busy = false
      button.addEventListener('click', async () => {
        if (busy) return
        busy = true; button.disabled = true; button.textContent = '回填中'
        try { await wishadelRestorePayload(payload); button.textContent = payload.images.length ? '已回填图文' : '已回填'; setTimeout(() => { if (button.isConnected) { button.textContent = '回退'; button.disabled = false; busy = false } }, 2200) }
        catch { button.textContent = '回退失败'; setTimeout(() => { if (button.isConnected) { button.textContent = '回退'; button.disabled = false; busy = false } }, 2200) }
      })
      host.appendChild(button)
    }
  }
  const schedule = () => { if (timer !== null) return; timer = setTimeout(() => { timer = null; render() }, 80) }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  schedule()
  ctx.effect(() => () => {
    observer.disconnect(); if (timer !== null) clearTimeout(timer)
    document.querySelectorAll('.wsh-rollback-host').forEach((host) => { try { host._wishadelRoot?.unmount() } catch {} host.remove() })
  }, 'wishadel: conversation rollback buttons')
}

function wishadelEngineerPrompt(text) {
  const source = text.trim()
  if (!source) return ''
  return `请将下面的需求整理为可直接执行的工程任务，并保留原始目标，不要擅自扩大范围：

【目标】
${source}

【请输出】
1. 背景与问题边界
2. 明确的验收标准
3. 实施步骤，按依赖顺序排列
4. 涉及的文件、模块或接口（未知时标记为“待确认”）
5. 风险、兼容性与回滚方案
6. 验证命令或测试场景

【执行约束】
- 先检查现状，再修改
- 保持改动最小且与现有架构一致
- 不要伪造已完成的验证结果
- 遇到歧义先列出假设
- 最终说明改动、测试结果和剩余风险`
}

function PromptOptimizer() {
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState('')
  const input = () => wishadelComposerTextarea()
  const openEditor = () => { setDraft(input()?.value ?? ''); setOpen(true) }
  const apply = () => { wishadelSetComposerText(draft); setOpen(false) }
  const optimize = () => setDraft(wishadelEngineerPrompt(draft || input()?.value || ''))
  return React.createElement('span', { className: 'wsh-prompt-tool' },
    React.createElement('button', { type: 'button', className: 'wsh-prompt-optimize', onClick: openEditor, title: '把当前输入整理成工程化提示词', 'aria-label': '优化提示词' }, '提示词优化'),
    open ? React.createElement('div', { className: 'wsh-prompt-popover', role: 'dialog', 'aria-label': '工程化提示词优化' },
      React.createElement('div', { className: 'wsh-prompt-popover-head' }, React.createElement('strong', null, '工程化提示词'), React.createElement('button', { type: 'button', onClick: () => setOpen(false), title: '关闭' }, '×')),
      React.createElement('textarea', { value: draft, onChange: (event) => setDraft(event.target.value), placeholder: '先输入需求，再点击“生成结构”', 'aria-label': '提示词草稿' }),
      React.createElement('div', { className: 'wsh-prompt-popover-actions' },
        React.createElement('button', { type: 'button', onClick: optimize, disabled: !draft.trim() }, '生成结构'),
        React.createElement('button', { type: 'button', className: 'primary', onClick: apply, disabled: !draft.trim() }, '回填输入框'))
    ) : null)
}

function installPromptOptimizer(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  ctx.effect(() => slots.inject('conversation.input.right', () => slots.register({
    name: 'conversation.input.right',
    id: 'wishadel-prompt-optimizer',
    order: 50,
    label: '提示词优化',
  }, PromptOptimizer)), 'wishadel: prompt optimizer')
}

function installConversationTools(ctx) {
  installRollbackButtons(ctx)
  installPromptOptimizer(ctx)
}
