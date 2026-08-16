// 会话消息存在性侦测（flow-watch）：
// 新对话的空状态布局会把 composer（连同输入框上方的 dock 行）垂直居中在屏幕中央，
// 此时 GIT / 历史两个 dock 气泡会跟着悬浮在屏幕中间，视觉上像脱离了主操作区。
// 这里侦测会话流中是否已有用户消息：没有消息时隐藏 dock 气泡，
// 第一条消息落地后，它们出现在底部输入框上方的正确位置。
function createFlowActivityStore() {
  let value = false
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      if (next === value) return
      value = next
      for (const fn of [...listeners]) fn()
    },
  }
}

const flowActivity = createFlowActivityStore()

function installFlowWatch(ctx) {
  let timer = null
  const recompute = () => {
    timer = null
    flowActivity.set(document.querySelectorAll('[data-chat-flow-kind="user"]').length > 0)
  }
  // 变更合并：DOM 高频变更时每 120ms 至多重算一次。
  const schedule = () => {
    if (timer === null) timer = setTimeout(recompute, 120)
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })
  schedule()
  ctx.effect(() => () => {
    observer.disconnect()
    if (timer !== null) clearTimeout(timer)
  }, 'wishadel: flow activity watch')
}
