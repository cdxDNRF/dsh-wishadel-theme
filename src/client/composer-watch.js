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

  // 2) 恢复条（input dock 的第二个条目，session 作用域）
  const slots = ctx.get('slots')
  if (slots !== undefined) {
    ctx.effect(() => slots.inject('conversation.input.dock', () => slots.register({
      name: 'conversation.input.dock',
      id: 'wishadel-composer-watch',
      order: 90,
      label: '附件恢复',
    }, ComposerRecovery)), 'wishadel: composer recovery')
  }

  ctx.effect(() => () => document.removeEventListener('click', onDocClick, true), 'wishadel: composer self-heal')
}
