// 对话增强：最近两条用户消息回退 + 工程化提示词优化。
// 回退基于 DSH 官方 sessions.fork(atSeq)：创建目标输入之前的分支会话并打开，
// 目标输入之后的模型输出不会出现在新分支中；随后恢复目标输入与图片到输入框。

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
  await wishadelSetComposerText(payload.text)
  if (payload.images.length) await wishadelRestoreImages(payload.images)
}

function wishadelNodeText(node) {
  const blocks = node?.data?.content
  if (!Array.isArray(blocks)) return ''
  return blocks.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('').trim()
}

function wishadelNodeImages(node) {
  const blocks = node?.data?.content
  if (!Array.isArray(blocks)) return []
  return blocks.filter((block) => block?.type === 'image' && block?.attachment).map((block) => block.attachment)
}

function wishadelIsLastTwoUserNodes(snapshot, nodeKey) {
  try {
    const nodes = [...(snapshot?.chat?.nodes?.values?.() ?? [])]
    const userKeys = nodes.filter((item) => item?.kind === 'user').map((item) => item.key)
    if (userKeys.length < 2) return true
    return userKeys.slice(-2).includes(nodeKey)
  } catch { return true }
}

function WishadelUserCell(props) {
  const node = props.node
  if (!node || node.kind !== 'user') return null
  const text = wishadelNodeText(node)
  const [tick, setTick] = React.useState(0)
  const [imageUrls, setImageUrls] = React.useState([])
  React.useEffect(() => {
    const observer = new MutationObserver(() => setTick((value) => value + 1))
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  React.useEffect(() => {
    let cancelled = false
    const attachments = wishadelNodeImages(node)
    if (!attachments.length || typeof props.loadImage !== 'function') return undefined
    Promise.all(attachments.map((attachment) => props.loadImage(attachment).catch(() => null)))
      .then((urls) => { if (!cancelled) setImageUrls(urls.filter(Boolean)) })
    return () => { cancelled = true }
  }, [node, tick])
  const eligible = wishadelIsLastTwoUserNodes(props.useSession ? props.useSession((snapshot) => snapshot) : null, node.key)
  const [busy, setBusy] = React.useState(false)
  const [status, setStatus] = React.useState('')
  const rollback = async () => {
    if (busy || !props.sessions || !props.sessionId) return
    setBusy(true); setStatus('')
    try {
      const childId = await props.sessions.fork({ sessionId: props.sessionId, atSeq: node.anchorSeq, increaseTitle: true })
      props.sessions.open(childId)
      const images = imageUrls.map((url, index) => ({ src: url, name: `image-${index + 1}.png` }))
      await wishadelRestorePayload({ text, images })
      if (text) await wishadelSetComposerText(text)
      setStatus('已回退')
    } catch (cause) {
      const message = String(cause?.message ?? cause)
      setStatus(/fork-unavailable|not completed the turn/i.test(message) ? '等待本轮回复结束后再回退' : `回退失败：${message.slice(0, 80)}`)
      console.error('[wishadel] 回退失败:', cause)
    } finally {
      setBusy(false)
      setTimeout(() => setStatus(''), 4000)
    }
  }
  return React.createElement('div', { className: 'wsh-user-cell', 'data-wishadel-rollback': eligible ? 'true' : 'false' },
    imageUrls.length ? React.createElement('div', { className: 'wsh-user-images' },
      imageUrls.map((url, index) => React.createElement('img', { key: index, className: 'wsh-user-image', src: url, alt: `附件 ${index + 1}` }))) : null,
    text ? React.createElement('div', { className: 'wsh-user-bubble' }, text) : null,
    eligible ? React.createElement(React.Fragment, null,
      React.createElement('button', {
        type: 'button', className: 'wsh-conversation-action', onClick: rollback, disabled: busy,
        title: '回退到这条输入之前（打开新会话分支）', 'aria-label': '回退此输入',
      }, busy ? '回退中…' : '回退'),
      status ? React.createElement('span', { className: 'wsh-rollback-status', role: 'status' }, status) : null) : null)
}

function installRollbackButtons(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  ctx.effect(() => slots.inject('conversation.chat.node', () => slots.register({
    name: 'conversation.chat.node',
    key: 'user',
    priority: -10,
    inject: (sessionId) => ({ sessionId, sessions: ctx.get('sessions') }),
  }, WishadelUserCell)), 'wishadel: conversation rollback cell')
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
