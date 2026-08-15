// HTTP 通道：/wishadel 前缀路由，供浏览器端设置卡、任务看板、Git 图谱与右侧面板调用。
// 同源 fetch，无需跨域头。路由注册进 ctx.effect，插件卸载时自动移除。

const MAX_BODY_BYTES = 20 * 1024 * 1024

function sendJson(res, status, payload) {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req) {
  const raw = await readBody(req)
  if (raw.length === 0) return undefined
  try { return JSON.parse(raw.toString('utf8')) } catch { throw new Error('请求体不是合法 JSON') }
}

function requireRoot(query, body) {
  const root = (body?.root ?? query.get('root') ?? '').trim()
  if (!root) throw new Error('缺少 root 参数')
  if (!isAbsolute(root)) throw new Error('root 必须是绝对路径')
  if (!existsSync(root)) throw new Error(`目录不存在: ${root}`)
  if (!statSync(root).isDirectory()) throw new Error('root 不是目录')
  return root
}

function createRoutes(ctx, services) {
  const handleRequest = async (rest, method, query, body, res) => {
    // 任务看板
    if (rest === '/tasks' && method === 'GET') return sendJson(res, 200, { tasks: services.tasks.list() })
    if (rest === '/tasks' && method === 'POST') return sendJson(res, 200, { task: services.tasks.create(body) })
    if (rest === '/tasks/run' && method === 'POST') {
      const id = String(body?.id ?? '')
      if (!id) throw new Error('缺少任务 id')
      return sendJson(res, 200, { task: await services.tasks.run(id) })
    }
    let match = /^\/tasks\/([^/]+)$/.exec(rest)
    if (match && method === 'PATCH') return sendJson(res, 200, { task: services.tasks.update(match[1], body?.patch ?? body) })
    if (match && method === 'DELETE') return sendJson(res, 200, services.tasks.remove(match[1]))

    // cron 预览
    if (rest === '/cron/next' && method === 'GET') {
      const expr = query.get('expr') ?? ''
      if (!expr) throw new Error('缺少 expr 参数')
      const next = services.tasks.nextCronTime(expr, now())
      return sendJson(res, 200, { next })
    }

    // 设置
    if (rest === '/settings' && method === 'GET') {
      return sendJson(res, 200, { settings: loadSettings() })
    }
    if (rest === '/settings' && method === 'POST') {
      const next = updateSettings(body?.patch ?? body)
      return sendJson(res, 200, { settings: next })
    }

    // 面板状态（按项目持久化）
    if (rest === '/panel-state' && method === 'GET') {
      const root = requireRoot(query, undefined)
      return sendJson(res, 200, { state: getPanelState(root), defaults: loadSettings().panel })
    }
    if (rest === '/panel-state' && method === 'POST') {
      const root = requireRoot(undefined, body)
      return sendJson(res, 200, { state: putPanelState(root, body?.state ?? {}) })
    }

    // 文件树与预览
    if (rest === '/fs/list' && method === 'POST') {
      const root = requireRoot(undefined, body)
      return sendJson(res, 200, dirEntries(root, body?.path ?? '.'))
    }
    if (rest === '/fs/search' && method === 'POST') {
      const root = requireRoot(undefined, body)
      return sendJson(res, 200, searchFiles(root, body?.query ?? ''))
    }
    if (rest === '/fs/read' && method === 'GET') {
      const root = requireRoot(query, undefined)
      const maxBytes = loadSettings().panel.maxPreviewBytes
      return sendJson(res, 200, readForPreview(root, query.get('path') ?? '.', maxBytes))
    }
    if (rest === '/fs/write' && method === 'POST') {
      const root = requireRoot(undefined, body)
      const content = body?.content
      if (typeof content !== 'string') throw new Error('缺少 content')
      const outcome = writeFileText(services, root, body?.path ?? '.', content)
      return sendJson(res, 200, outcome)
    }
    if (rest === '/fs/delete' && method === 'POST') {
      const root = requireRoot(undefined, body)
      return sendJson(res, 200, deleteFile(services, root, body?.path ?? '.'))
    }

    // Git
    if (rest === '/git/info' && method === 'GET') return sendJson(res, 200, gitRepoInfo(requireRoot(query, undefined)))
    if (rest === '/git/status' && method === 'GET') return sendJson(res, 200, gitStatus(requireRoot(query, undefined)))
    if (rest === '/git/diff' && method === 'GET') {
      const root = requireRoot(query, undefined)
      const path = query.get('path') ?? '.'
      const staged = query.get('staged') === '1'
      return sendJson(res, 200, gitDiff(root, path, staged))
    }
    if (rest === '/git/stage' && method === 'POST') {
      const root = requireRoot(undefined, body)
      const paths = Array.isArray(body?.paths) ? body.paths.map(String) : []
      if (!paths.length) throw new Error('缺少 paths')
      return sendJson(res, 200, gitStage(root, paths))
    }
    if (rest === '/git/checkout' && method === 'POST') {
      const root = requireRoot(undefined, body)
      return sendJson(res, 200, gitCheckout(root, body?.branch ?? ''))
    }
    if (rest === '/git/unstage' && method === 'POST') {
      const root = requireRoot(undefined, body)
      const paths = Array.isArray(body?.paths) ? body.paths.map(String) : []
      if (!paths.length) throw new Error('缺少 paths')
      return sendJson(res, 200, gitUnstage(root, paths))
    }
    if (rest === '/git/discard' && method === 'POST') {
      const root = requireRoot(undefined, body)
      const changes = Array.isArray(body?.changes) ? body.changes : []
      if (!changes.length) throw new Error('缺少 changes')
      return sendJson(res, 200, gitDiscard(root, changes))
    }
    if (rest === '/git/log' && method === 'GET') {
      const root = requireRoot(query, undefined)
      const max = Math.min(loadSettings().gitgraph.maxCommits, Number(query.get('max') || 200) || 200)
      return sendJson(res, 200, gitLog(root, query.get('branch') ?? '', max))
    }
    if (rest === '/git/commit' && method === 'GET') {
      const root = requireRoot(query, undefined)
      const hash = query.get('hash') ?? ''
      if (!hash) throw new Error('缺少 hash')
      return sendJson(res, 200, gitCommitDetail(root, hash))
    }

    if (rest === '/health' && method === 'GET') {
      return sendJson(res, 200, { ok: true, git: gitAvailable(), version: '0.6.0' })
    }

    // 诊断：活体会话状态（调试用）
    if (rest === '/debug/agents' && method === 'GET') {
      const list = services.agents?.list?.() ?? []
      const rows = list.map((agent) => {
        const events = agent.session?.events ?? []
        const tail = events.slice(-6).map((event) => event.type)
        return { id: agent.id, status: agent.status, eventCount: events.length, tail }
      })
      return sendJson(res, 200, { agents: rows })
    }
    sendJson(res, 404, { error: `未知接口: ${method} ${rest}` })
  }

  ctx.effect(() => services.webServer.register({
    kind: 'prefix',
    path: '/wishadel',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rest = url.pathname.slice('/wishadel'.length) || '/'
        const method = req.method ?? 'GET'
        const body = method === 'GET' || method === 'HEAD' ? undefined : await readJsonBody(req)
        await handleRequest(rest, method, url.searchParams, body, res)
      } catch (error) {
        const message = String(error?.message ?? error)
        let status = 500
        if (message.includes('执行中')) status = 409
        else if (message.includes('不存在') || message.includes('超出') || message.includes('只读模式') || message.includes('无效') || message.includes('为空')) status = 400
        console.warn(`wishadel route error: ${message}`)
        sendJson(res, status, { error: message })
      }
    },
  }), 'wishadel: /wishadel route')
}
