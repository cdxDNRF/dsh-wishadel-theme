// 会话置顶列表持久化：storages/wishadel/pinned.json = { ids: [...] }。
// 数组序即置顶序（新置顶插到最前）。

function loadPinned() {
  const data = readJson('pinned.json', { ids: [] })
  const ids = Array.isArray(data?.ids)
    ? data.ids.filter((id) => typeof id === 'string' && id.length > 0)
    : []
  return [...new Set(ids)]
}

function savePinned(ids) {
  writeJson('pinned.json', { ids })
}

function setPinned(sessionId, pinned) {
  const ids = loadPinned().filter((id) => id !== sessionId)
  if (pinned) ids.unshift(sessionId)
  savePinned(ids)
  return ids
}
