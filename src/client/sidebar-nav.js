// 侧栏键盘导航：补齐 rc.6 treeitem 的 roving tabindex 与常用方向键。
// 宿主行本身是 role=treeitem 但没有 tabindex/Arrow 导航；这里仅作用于
// Wishadel 标记的侧栏区域，不抢占输入框、菜单按钮和其他控件的按键。
// 新版 DSH 侧栏行已自带键盘处理：本补丁默认关闭（设置卡 superseded.sidebarNav 开启）。

function sidebarNavEnabled() {
  return wishadelSuperseded('sidebarNav')
}

function sidebarNavRoot() {
  return document.querySelector('[data-wishadel-pane="sidebar"]') ?? document.body
}

function navRows(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return []
  return [...root.querySelectorAll('[role="treeitem"]')].filter((row) => {
    const rect = row.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && getComputedStyle(row).visibility !== 'hidden'
  })
}

function isWorkspaceRow(row) {
  return String(row.className).includes('projectRow')
}

function syncRoving(root, active) {
  const rows = navRows(root)
  const selected = active ?? rows.find((row) => row.getAttribute('aria-selected') === 'true') ?? rows[0]
  for (const row of rows) {
    const value = row === selected ? '0' : '-1'
    if (row.getAttribute('tabindex') !== value) row.setAttribute('tabindex', value)
  }
}

function focusRow(root, row) {
  if (!row) return
  syncRoving(root, row)
  row.focus({ preventScroll: true })
  row.scrollIntoView({ block: 'nearest' })
}

function installSidebarNavigation(ctx) {
  let timer = null
  const root = sidebarNavRoot()
  const schedule = () => {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      // 默认关闭：移除历史会话注入的 tabindex 后直接返回。
      if (!sidebarNavEnabled()) {
        for (const row of navRows(root)) row.removeAttribute('tabindex')
        return
      }
      syncRoving(root)
    }, 80)
  }
  const onFocusIn = (event) => {
    if (!sidebarNavEnabled()) return
    const target = event.target
    if (!(target instanceof Element)) return
    const row = target.closest('[role="treeitem"]')
    if (row && root.contains(row)) syncRoving(root, row)
  }
  const onKeyDown = (event) => {
    if (!sidebarNavEnabled()) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('input, textarea, select, button, [contenteditable="true"], [role="menu"]')) return
    const row = target.closest('[role="treeitem"]')
    if (!row || !root.contains(row)) return
    const rows = navRows(root)
    const index = rows.indexOf(row)
    if (index < 0) return
    let next = null
    if (event.key === 'ArrowDown') next = rows[index + 1] ?? rows[0]
    else if (event.key === 'ArrowUp') next = rows[index - 1] ?? rows[rows.length - 1]
    else if (event.key === 'Home') next = rows[0]
    else if (event.key === 'End') next = rows[rows.length - 1]
    else if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault()
      row.focus({ preventScroll: true })
      row.click()
      return
    } else if (event.key === 'ArrowRight' && isWorkspaceRow(row)) {
      if (row.getAttribute('aria-expanded') !== 'true') {
        event.preventDefault()
        row.focus({ preventScroll: true })
        row.click()
        return
      }
      next = rows[index + 1] ?? row
    } else if (event.key === 'ArrowLeft') {
      if (isWorkspaceRow(row) && row.getAttribute('aria-expanded') === 'true') {
        event.preventDefault()
        row.focus({ preventScroll: true })
        row.click()
        return
      }
      for (let i = index - 1; i >= 0; i--) {
        if (isWorkspaceRow(rows[i])) { next = rows[i]; break }
      }
    }
    if (!next) return
    event.preventDefault()
    focusRow(root, next)
  }
  const observer = new MutationObserver(schedule)
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected', 'aria-expanded'] })
  if (sidebarNavEnabled()) syncRoving(root)
  // 设置变化（开启/关闭）时即时同步 tabindex 状态。
  const unsubscribeSettings = runtimeRefs.settings?.subscribe?.(() => schedule()) ?? null
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('keydown', onKeyDown, true)
  ctx.effect(() => () => {
    observer.disconnect()
    if (unsubscribeSettings) unsubscribeSettings()
    document.removeEventListener('focusin', onFocusIn, true)
    document.removeEventListener('keydown', onKeyDown, true)
    if (timer !== null) clearTimeout(timer)
    for (const row of root.querySelectorAll('[role="treeitem"]')) row.removeAttribute('tabindex')
  }, 'wishadel: sidebar keyboard navigation')
}
