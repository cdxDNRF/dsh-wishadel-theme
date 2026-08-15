// 与宿主 /wishadel 通道交互：设置存储（订阅+保存）、任务、文件、Git、面板状态。

const API_BASE = '/wishadel'

async function api(method, path, body, params) {
  const url = new URL(API_BASE + path, location.origin)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    }
  }
  let response
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    throw new Error(`无法连接插件服务（${String(error?.message ?? error)}）`)
  }
  const text = await response.text().catch(() => '')
  let data = {}
  if (text.trim().startsWith('<')) throw new Error('宿主服务未就绪（响应不是 JSON，请重启 dsh web 加载插件宿主半边）')
  if (text) {
    try { data = JSON.parse(text) } catch { throw new Error('宿主响应解析失败') }
  }
  if (!response.ok) throw new Error(data?.error ?? `请求失败 HTTP ${response.status}`)
  return data
}

// ── 设置存储 ────────────────────────────────────────────────────────────────
const SETTINGS_FALLBACK_KEY = 'dsh-theme-wishadel-settings-cache'

function createSettingsStore() {
  let settings = null
  let error = null
  const listeners = new Set()

  const store = {
    getSnapshot() { return settings },
    getError() { return error },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async refresh() {
      try {
        const data = await api('GET', '/settings')
        settings = data.settings
        error = null
        localStorage.setItem(SETTINGS_FALLBACK_KEY, JSON.stringify(settings))
      } catch (cause) {
        error = String(cause?.message ?? cause)
        const cached = localStorage.getItem(SETTINGS_FALLBACK_KEY)
        if (cached && settings === null) {
          try { settings = JSON.parse(cached) } catch { settings = null }
        }
      }
      listeners.forEach((listener) => listener(settings))
      return settings
    },
    async save(patch) {
      const data = await api('POST', '/settings', { patch })
      settings = data.settings
      error = null
      localStorage.setItem(SETTINGS_FALLBACK_KEY, JSON.stringify(settings))
      listeners.forEach((listener) => listener(settings))
      return settings
    },
  }
  return store
}

// ── 运行时共享引用（由 runtime.js 安装后填充，各功能模块读取）──────────────
const runtimeRefs = { ctx: null, settings: null, tasks: null }

// 在界面中打开一个既有会话：优先走客户端 sessions 运行时，逐级降级。
function openSession(sessionId) {
  const sessions = runtimeRefs.ctx?.get('sessions')
  try {
    if (typeof sessions?.open === 'function') { sessions.open(sessionId); return }
  } catch { /* 降级 */ }
  try {
    if (typeof sessions?.select === 'function') { sessions.select(sessionId); return }
  } catch { /* 降级 */ }
  console.warn(`[wishadel] 无法自动打开会话 ${sessionId}，请在左侧会话列表中选择。`)
}

// ── 通用 JSON 轮询封装（任务/面板状态等）────────────────────────────────────
function createPollingSource(load, intervalMs) {
  let value = null
  let error = null
  let timer = null
  const listeners = new Set()
  return {
    getSnapshot() { return value },
    getError() { return error },
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) {
        const tick = async () => {
          try { value = await load(); error = null } catch (cause) { error = String(cause?.message ?? cause) }
          listeners.forEach((fn) => fn(value))
        }
        tick()
        timer = setInterval(tick, intervalMs)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && timer !== null) {
          clearInterval(timer)
          timer = null
        }
      }
    },
    refresh: async () => {
      try { value = await load(); error = null } catch (cause) { error = String(cause?.message ?? cause) }
      listeners.forEach((fn) => fn(value))
      return value
    },
  }
}
