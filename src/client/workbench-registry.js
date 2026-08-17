// Wishadel 内部工作台注册表：为后续插件贡献 Tab / 文件 viewer 保留稳定 API。
// descriptor.component 接收 { React, tab, scope, api }，返回 ReactNode；注册返回 disposer。
const workbenchRegistry = (() => {
  const tabs = new Map()
  const viewers = new Map()
  const listeners = new Set()
  const notify = () => listeners.forEach((fn) => fn())
  const validateId = (value, kind) => {
    const id = String(value ?? '').trim()
    if (!id) throw new Error(`${kind} id 不能为空`)
    return id
  }
  const register = (map, descriptor, kind) => {
    const id = validateId(descriptor?.id, kind)
    if (map.has(id)) throw new Error(`${kind} 已注册: ${id}`)
    const item = { ...descriptor, id }
    map.set(id, item); notify()
    return () => { if (map.get(id) === item) { map.delete(id); notify() } }
  }
  return {
    getTabs: () => [...tabs.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
    getViewers: () => [...viewers.values()].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
    getTab: (id) => tabs.get(id),
    registerTab: (descriptor) => register(tabs, descriptor, 'Tab'),
    registerFileViewer: (descriptor) => register(viewers, descriptor, '文件 viewer'),
    matchFileViewer(path, head) {
      const lower = String(path ?? '').toLowerCase()
      const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
      for (const viewer of viewers.values()) {
        if (typeof viewer.detect === 'function' && head && viewer.detect(path, head)) return viewer
        if (Array.isArray(viewer.exts) && viewer.exts.map(String).map((value) => value.replace(/^\./, '').toLowerCase()).includes(ext)) return viewer
      }
      return undefined
    },
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
  }
})()
