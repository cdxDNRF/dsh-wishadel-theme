// 附件卡死修复（composer watch）：
// 现象：选了不支持图片的模型后，附图发送被宿主拒绝，图片留在对话框里删不掉
// （X 点击被错误提示弹层遮挡/吞掉），发送也一直失败，只能刷新页面。
// 修复：
// 1) 自愈：捕获附件移除按钮的点击，若 250ms 后按钮仍在 DOM（说明点击没生效），
//    直接对按钮再派发一次程序化 click —— 绕过遮挡层，React 的移除处理照常执行。
// 2) 恢复条：会话出现 promptError 且仍有图片附件时，在输入框上方显示恢复条，
//    提供「移除全部附件」与「重试发送」。

function railRemoveButtons() {
  const card = document.querySelector('[data-composer-card]')
  if (!card) return []
  return [...card.querySelectorAll('button')].filter((btn) => {
    const label = btn.getAttribute('aria-label') ?? ''
    return /移除|remove/i.test(label)
  })
}

function directClick(btn) {
  try { btn.click() } catch { /* noop */ }
}

function ComposerRecovery(props) {
  const promptError = props.useSession ? props.useSession((s) => s?.promptError) : null
  const input = props.input
  const imageCount = input?.imageIds?.length ?? 0
  if (!promptError || imageCount === 0) return null
  const reason = promptError.error?.details?.reason
  const message = reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES'
    ? '当前模型不支持图片：请移除图片附件，或切换回支持图片的模型。'
    : `发送失败（${promptError.error?.code ?? 'unknown'}）：可尝试移除图片附件后重试。`
  const clearAll = () => {
    for (const btn of railRemoveButtons()) directClick(btn)
  }
  const retrySend = () => {
    const send = document.querySelector('[data-composer-card] button[aria-label="发送消息"]')
    if (send) directClick(send)
  }
  return React.createElement('div', {
    className: 'wsh-recovery wsh-surface',
    role: 'status',
  },
    React.createElement('span', { className: 'wsh-recovery-text' }, message),
    React.createElement('button', { className: 'wsh-btn mini primary', onClick: clearAll }, '移除全部附件'),
    React.createElement('button', { className: 'wsh-btn mini', onClick: retrySend }, '重试发送'))
}

// ── 历史消息跳转：点第几个就跳到第几条用户消息 ────────────────────────────
function HistoryJump(props) {
  const sessionId = props.sessionId
  const [open, setOpen] = React.useState(false)
  const [items, setItems] = React.useState([])
  if (!sessionId) return null

  const scan = () => {
    const nodes = [...document.querySelectorAll('[data-chat-flow-kind="user"]')]
    return nodes
      .map((node) => ({
        node,
        text: (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
      }))
      .filter((item) => item.text)
  }

  const toggle = () => {
    if (!open) setItems(scan())
    setOpen((value) => !value)
  }

  return React.createElement('div', { className: 'wsh-surface', style: { position: 'relative', display: 'inline-flex' } },
    React.createElement('button', {
      type: 'button',
      className: 'wsh-history-btn',
      title: '跳转到某条历史消息',
      onClick: toggle,
    },
      React.createElement('span', { className: 'wsh-label' }, '历史'),
      React.createElement('span', { className: 'wsh-history-count' }, String(items.length || '')),
      React.createElement('span', { className: 'wsh-history-caret' }, '▾')),
    open ? React.createElement('div', { className: 'wsh-git-menu wsh-history-menu' },
      items.length === 0 ? React.createElement('div', { className: 'wsh-hint', style: { padding: '6px 10px' } }, '暂无历史消息') : null,
      items.map((item, index) => React.createElement('button', {
        key: index,
        type: 'button',
        title: item.text,
        onClick: () => {
          item.node.scrollIntoView({ behavior: 'smooth', block: 'start' })
          setOpen(false)
        },
      },
        React.createElement('span', { className: 'wsh-history-index' }, `${index + 1}.`),
        React.createElement('span', { className: 'wsh-history-text' }, item.text))),
      items.length > 0 ? React.createElement('button', {
        type: 'button',
        onClick: () => {
          const nodes = [...document.querySelectorAll('[data-chat-flow-kind="user"]')]
          const last = nodes[nodes.length - 1]
          if (last) last.scrollIntoView({ behavior: 'smooth', block: 'start' })
          setOpen(false)
        },
      }, '⇣ 跳到最新一条') : null) : null)
}

function installComposerWatch(ctx) {
  // 1) 自愈（捕获阶段，不影响默认行为）
  const onDocClick = (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const btn = target.closest ? target.closest('button[aria-label]') : null
    if (!btn) return
    const label = btn.getAttribute('aria-label') ?? ''
    if (!/移除|remove/i.test(label)) return
    setTimeout(() => {
      if (!btn.isConnected) return
      // 默认点击未生效（按钮仍存在）→ 程序化直点补一刀
      directClick(btn)
    }, 250)
  }
  document.addEventListener('click', onDocClick, true)

  // 2) 恢复条 + 3) 历史跳转（input dock 条目，session 作用域）
  const slots = ctx.get('slots')
  if (slots !== undefined) {
    ctx.effect(() => slots.inject('conversation.input.dock', () => slots.register({
      name: 'conversation.input.dock',
      id: 'wishadel-composer-watch',
      order: 90,
      label: '附件恢复',
    }, ComposerRecovery)), 'wishadel: composer recovery')
    ctx.effect(() => slots.inject('conversation.input.dock', () => slots.register({
      name: 'conversation.input.dock',
      id: 'wishadel-history-jump',
      order: 60,
      label: '历史跳转',
    }, HistoryJump)), 'wishadel: history jump')
  }

  ctx.effect(() => () => document.removeEventListener('click', onDocClick, true), 'wishadel: composer self-heal')
}
