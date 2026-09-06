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

function requireSessionId(query, body) {
  const sessionId = String(body?.sessionId ?? query.get('sessionId') ?? '').trim()
  if (!sessionId) throw new Error('缺少 sessionId')
  return sessionId
}

function requireTerminalCwd(query, body) {
  const cwd = String(body?.cwd ?? query.get('cwd') ?? '').trim()
  if (!cwd) throw new Error('缺少 cwd')
  if (!isAbsolute(cwd)) throw new Error('cwd 必须是绝对路径')
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error('cwd 不是目录')
  return cwd
}

function isLoopbackHost(hostname) {
  const value = String(hostname ?? '').toLowerCase()
  return value === 'localhost' || value === '::1' || value === '0.0.0.0'
    || /^127(?:\.\d{1,3}){3}$/.test(value)
    || /^10(?:\.\d{1,3}){3}$/.test(value)
    || /^192\.168(?:\.\d{1,3}){2}$/.test(value)
    || /^172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}$/.test(value)
}

function createRoutes(ctx, services) {
  const handleRequest = async (rest, method, query, body, req, res) => {
    // 编辑器内提示词优化：只调用当前会话模型，不追加任何 session event。
    if (rest === '/prompt-optimize' && method === 'POST') {
      const sessionId = requireSessionId(undefined, body)
      const source = String(body?.text ?? '').trim()
      if (!source) throw new Error('提示词内容为空')
      if (source.length > 20000) throw new Error('提示词内容过长')
      if (services.llm === undefined) throw new Error('模型服务不可用')
      const session = services.sessions?.get?.(sessionId)
      if (session === undefined) throw new Error('会话不存在或尚未加载')
      const requestHeader = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
      const config = requestHeader?.config ?? session.events?.slice?.().reverse?.().find?.((event) => event.type === 'request/header')?.data?.header?.config
      const selected = body?.selection && typeof body.selection === 'object' ? body.selection : {}
      const provider = String(selected.provider ?? config?.provider ?? '')
      const model = String(selected.model ?? config?.model ?? '')
      const reasoningEffort = selected.reasoningEffort === undefined ? config?.reasoningEffort : String(selected.reasoningEffort || '') || undefined
      if (!provider || !model) throw new Error('当前会话尚未选择模型')
      const resolved = typeof services.llm.resolveCallConfig === 'function'
        ? await services.llm.resolveCallConfig({ provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) })
        : { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }

      // ── 提示词增强模板（WorkBuddy「增强提示词」对齐）──────────────────────
      // 双段结构：system 承载「改写方法论 + few-shot」，user 模板承载
      // 「用户输入（{input} 占位符）+ 语言一致性硬约束 + 好坏输出示例」。
      // 输出仅做去首尾引号清洗，不二次加工。
      const system = [
        'You are a Prompt Engineering Expert specializing in improving user prompts for a development code assistant. When given a prompt, analyze and enhance it to create a more effective version while maintaining its core purpose. The requests are being made to an AI assistant that specializes in writing code.',
        '',
        'ANALYSIS PROCESS:',
        '1. Evaluate the original prompt: identify the main objective, note ambiguities or gaps, assess clarity, and check for missing context.',
        '2. Apply prompt engineering principles: clear specific instructions, necessary context, explicit parameters and constraints, structured output format, relevant examples, matched tone/complexity, no redundancy.',
        '3. Create the enhanced version: maintain the original goal, incorporate improvements, ensure clarity and completeness.',
        '',
        'CONSTRAINTS:',
        '- Do NOT request guides/how-tos unless the user asks.',
        '- Do NOT ask for code snippets.',
        '- Do NOT suggest specific technologies unless mentioned in the user\'s prompt.',
        '- Do NOT explain HOW to do things; focus on WHAT.',
        '- Do NOT answer questions; expand/rewrite them to be more detailed.',
        '- Language matching is the highest priority: respond in the EXACT same language as the user\'s input. Chinese in → Chinese out; English in → English out; other language in → same language out. Do not mix languages unless the input itself mixes.',
        '- Keep the enhanced prompt concise: maximum length around 800 characters.',
        'FORMAT: Provide only the enhanced prompt with no additional commentary.',
        '',
        'Example:',
        '"A website for my dog"',
        'Enhanced prompt:',
        '"Design a personalized Next.js website dedicated to showcasing my dog. Include a photo gallery, a biography detailing the breed, age, and personality traits, and a blog for sharing stories. Add a contact form. Ensure the site is visually appealing, easy to navigate, and responsive on desktop and mobile."',
        '',
        'Example:',
        '"Convert this to a friendly tone, maintain technical details but reduce bullets in favor of narrative."',
        'Enhanced prompt:',
        '"Transform the provided content into a friendly narrative format while preserving all technical details. Minimize bullet points in favor of flowing prose. Keep the tone approachable without losing precision."',
      ].join('\n')

      const userTemplate = [
        'You are a prompt enhancement assistant. Improve the user prompt while preserving its intent and language.',
        '',
        'USER INPUT:',
        '{input}',
        '',
        'TASK:',
        'Rewrite the user input into a clearer, more specific prompt for the target AI assistant.',
        '',
        'CRITICAL PRIORITY - LANGUAGE CONSISTENCY:',
        '1. You MUST detect the language of the user input above and write the enhanced prompt in that same language.',
        '2. If the user writes in Chinese, the enhanced prompt MUST be entirely in Chinese.',
        '3. If the user writes in English, the enhanced prompt MUST be entirely in English.',
        '4. If the user writes in any other language, the enhanced prompt MUST use that exact same language.',
        '5. If the user mixes languages, keep a natural matching mix. Do not translate the user\'s intent into a single language.',
        '6. These language rules are behavior instructions only; never include language analysis or language labels in the output.',
        '',
        'ENHANCEMENT REQUIREMENTS:',
        '1. Return only the enhanced prompt text; do not add explanations, prefaces, markdown fences, labels, or analysis.',
        '2. Do not include language labels or meta notes such as "User input is in Chinese".',
        '3. Preserve the user\'s original intent, topic, constraints, and target output type. Do not answer the request.',
        '4. Always make a substantive enhancement when possible: clarify the task, scope, constraints, and expected output.',
        '5. If the original prompt is already clear, lightly polish it instead of returning it unchanged.',
        '6. Keep the enhanced prompt complete and concise. Do not end with an unfinished list or trailing colon.',
        '7. Do not add unrelated requirements, unsupported facts, or unnecessary sections.',
        '',
        'EXAMPLES:',
        'User input (Chinese): "请帮我解释这段代码的功能"',
        'Enhanced prompt: "请解释这段代码的主要功能、执行流程和关键逻辑，并指出可能需要注意的边界情况。"',
        '',
        'User input (English): "Please explain what this code does"',
        'Enhanced prompt: "Explain what this code does, including its main purpose, key control flow, and any important edge cases."',
        '',
        'User input (Mixed): "这段代码有 bug，can you help me fix it?"',
        'Enhanced prompt: "请分析这段代码中的 bug，explain the root cause, and provide a minimal fix with necessary verification steps."',
      ].join('\n')

      const userPrompt = userTemplate.replace('{input}', source)
      const messages = [{
        id: `wishadel-optimize-${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text: userPrompt }],
        source: { kind: 'user' },
      }]
      // 形状无关聚合：文本增量与完整文本块都收集；部分 adapter 只在 block-end 给全文，
      // 部分 thinking 模型可能只回 reasoning 流，作为兜底使用 reasoning 正文。
      const textParts = []
      const reasoningParts = []
      let finishKind = 'none'
      for await (const chunk of services.llm.stream({
        provider: resolved.provider,
        model: resolved.model,
        ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
        messages,
        system,
        maxTokens: Math.min(4096, Math.max(512, source.length * 2)),
      })) {
        if (chunk?.type === 'text-delta') textParts.push(chunk.text)
        else if (chunk?.type === 'reasoning-delta') reasoningParts.push(chunk.text)
        else if (chunk?.type === 'block-end') {
          if (chunk.block?.type === 'text' && textParts.length === 0) textParts.push(chunk.block.text)
          else if (chunk.block?.type === 'reasoning' && reasoningParts.length === 0) reasoningParts.push(chunk.block.text)
        } else if (chunk?.type === 'finish') {
          finishKind = chunk.reason?.kind ?? 'unknown'
          if (finishKind === 'error' || finishKind === 'aborted') {
            const message = chunk.reason?.failure?.message ?? chunk.reason?.failure?.code ?? '模型请求中断'
            throw new Error(`模型调用失败：${message}`)
          }
        }
      }
      let result = textParts.join('').trim()
      if (!result) result = reasoningParts.join('').trim()
      if (!result) throw new Error(`模型未返回优化结果（${provider}/${model}，finish=${finishKind}）${resolved.reasoningEffort ? `，推理等级 ${String(resolved.reasoningEffort)}` : ''}；若该模型是纯思考型，请切换 composer 中的模型后重试`)
      // 输出清洗（WorkBuddy 对齐）：去掉首尾成对的引号，其余原样返回。
      result = result.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '').trim() || result
      return sendJson(res, 200, { text: result, provider: resolved.provider, model: resolved.model, reasoningEffort: resolved.reasoningEffort ?? null })
    }

    // 任务看板
    if (rest === '/tasks' && method === 'GET') return sendJson(res, 200, { tasks: services.tasks.list() })
    if (rest === '/tasks' && method === 'POST') return sendJson(res, 200, { task: services.tasks.create(body) })
    if (rest === '/tasks/run' && method === 'POST') {
      const id = String(body?.id ?? '')
      if (!id) throw new Error('缺少任务 id')
      return sendJson(res, 200, { task: await services.tasks.run(id) })
    }
    if (rest === '/tasks/cancel' && method === 'POST') {
      const id = String(body?.id ?? '')
      if (!id) throw new Error('缺少任务 id')
      return sendJson(res, 200, { task: await services.tasks.cancel(id) })
    }
    let match = /^\/tasks\/([^/]+)$/.exec(rest)
    if (match && method === 'PATCH') return sendJson(res, 200, { task: services.tasks.update(match[1], body?.patch ?? body) })
    if (match && method === 'DELETE') return sendJson(res, 200, services.tasks.remove(match[1]))

    // 任务编辑辅助：DSH 已注册的工作区目录 + 可用 Agent 预设（只读）。
    if (rest === '/task-options' && method === 'GET') {
      const dirs = []
      try {
        const workspaces = services.workspaceRegistry?.list?.() ?? []
        for (const workspace of workspaces) if (typeof workspace?.path === 'string' && workspace.path) dirs.push(workspace.path)
      } catch { /* 只读服务失败时继续 */ }
      const home = typeof homedir === 'function' ? homedir() : ''
      const fallback = services.sandboxPolicy?.workspaceRoot ?? process.cwd()
      for (const dir of [home, fallback]) if (dir && !dirs.includes(dir)) dirs.push(dir)
      const presets = []
      try {
        const roster = await services.agentPresets?.list?.() ?? []
        for (const preset of roster) if (preset?.id) presets.push({ id: String(preset.id), name: String(preset.name ?? preset.id) })
      } catch { /* 只读服务失败时继续 */ }
      return sendJson(res, 200, { dirs: dirs.slice(0, 60), presets })
    }

    // 子代理/后台活动快照：只读取公开的 agent/session 镜像，不改变 DSH 注册表。
    if (rest === '/activity' && method === 'GET') {
      const rows = []
      const agents = (typeof services.agents?.list === 'function' ? services.agents.list() : services.agents?.roots?.()) ?? []
      for (const agent of agents) {
        const session = agent.session
        const header = session?.header ?? {}
        const events = Array.isArray(session?.events) ? session.events : []
        const last = events[events.length - 1]
        const rawJobs = agent.jobs ?? session?.jobs ?? []
        const jobs = Array.isArray(rawJobs) ? rawJobs.slice(0, 100).map((job) => ({
          id: String(job?.id ?? ''),
          status: String(job?.status ?? 'unknown'),
          startedAt: Number.isFinite(job?.startedAt) ? job.startedAt : undefined,
          finishedAt: Number.isFinite(job?.finishedAt) ? job.finishedAt : undefined,
          title: typeof job?.title === 'string' ? job.title.slice(0, 160) : undefined,
        })).filter((job) => job.id) : []
        rows.push({
          id: String(agent.id ?? header.id ?? ''),
          sessionId: String(header.id ?? agent.id ?? ''),
          parentId: header.parentId ?? header.parentSessionId ?? null,
          origin: header.origin ?? null,
          title: String(header.title ?? header.id ?? agent.id ?? '会话'),
          status: String(agent.status ?? 'idle'),
          cwd: header.cwd,
          lastEvent: last?.type ?? null,
          updatedAt: last?.time ?? last?.data?.time ?? header.updatedAt ?? header.createdAt ?? null,
          jobs,
        })
      }
      rows.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
      return sendJson(res, 200, { rows })
    }

    // 后台任务输出：只回放宿主已有事件，不消费模型 cursor。
    if (rest === '/jobs/output' && method === 'GET') {
      const sessionId = requireSessionId(query, undefined)
      const jobId = String(query.get('jobId') ?? '').trim()
      if (!jobId) throw new Error('缺少 jobId')
      const session = services.sessions?.get?.(sessionId)
      const events = Array.isArray(session?.events) ? session.events : []
      const calls = new Map()
      const parts = []
      let read = false
      for (const event of events) {
        const data = event?.data ?? {}
        if (event?.type === 'tool/call' && data.name === 'job_output') {
          let args = data.arguments
          try { args = typeof args === 'string' ? JSON.parse(args) : args } catch { args = null }
          if (typeof data.callId === 'string' && args?.job_id === jobId) calls.set(data.callId, true)
        } else if (event?.type === 'tool/result') {
          const message = data.message ?? data
          const callId = message?.source?.callId ?? message?.callId
          if (!calls.has(callId)) continue
          read = true
          const blocks = Array.isArray(message?.content) ? message.content : []
          for (const block of blocks) if (block?.type === 'text' && typeof block.text === 'string' && !block.text.startsWith('(no new output)')) parts.push(block.text)
        }
      }
      const text = parts.join('\\n')
      const max = 512 * 1024
      return sendJson(res, 200, { text: text.slice(0, max), truncated: text.length > max, read })
    }
    if (rest === '/jobs/kill' && method === 'POST') {
      const sessionId = requireSessionId(undefined, body)
      const jobId = String(body?.jobId ?? '').trim()
      if (!jobId) throw new Error('缺少 jobId')
      if (typeof services.jobs?.kill !== 'function') return sendJson(res, 503, { error: '后台任务服务不可用' })
      try { return sendJson(res, 200, { ok: true, outcome: services.jobs.kill(jobId, services.agents?.get?.(sessionId), 'user requested via wishadel') }) } catch { throw new Error('后台任务不存在或不属于当前会话') }
    }

    // 运行中的对话（自动上板：当前活着的顶层智能体会话）
    if (rest === '/live-sessions' && method === 'GET') {
      const rows = []
      const agents = (typeof services.agents?.roots === 'function' ? services.agents.roots() : services.agents?.list?.()) ?? []
      for (const agent of agents) {
        const session = agent.session
        if (!session) continue
        const events = session.events ?? []
        const firstUser = events.find((event) => event.type === 'user/message')
        const blocks = firstUser?.data?.message?.content ?? firstUser?.data?.content
        const texts = []
        const walk = (items) => {
          if (!Array.isArray(items)) return
          for (const block of items) {
            if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
          }
        }
        walk(blocks)
        const preview = texts.join(' ').trim().slice(0, 120)
        let title = (preview.split('\n')[0] || '').slice(0, 40) || String(session.id)
        try {
          const snapshot = services.sessionTitle?.get?.(session)
          if (snapshot?.title) title = String(snapshot.title).slice(0, 60)
        } catch { /* 标题服务不可用时回退 */ }
        rows.push({
          sessionId: String(agent.id),
          title,
          preview,
          status: agent.status ?? 'idle',
          cwd: session.header?.cwd,
          preset: session.header?.agentPreset,
          createdAt: session.header?.createdAt,
        })
      }
      rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      return sendJson(res, 200, { sessions: rows })
    }

    // 轻量会话终端（spawn 版本，无 node-pty 依赖；输出按 cursor 增量读取）
    if (rest === '/terminal/list' && method === 'GET') {
      const sessionId = requireSessionId(query, undefined)
      return sendJson(res, 200, { terminals: services.terminals?.list(sessionId) ?? [] })
    }
    if (rest === '/terminal/start' && method === 'POST') {
      const sessionId = requireSessionId(undefined, body)
      const cwd = requireTerminalCwd(undefined, body)
      return sendJson(res, 200, { terminal: services.terminals.start(sessionId, cwd, body?.shell) })
    }
    if (rest === '/terminal/read' && method === 'GET') {
      const id = String(query.get('id') ?? '').trim()
      if (!id) throw new Error('缺少 terminal id')
      const data = services.terminals.read(id, Number(query.get('cursor') ?? 0))
      if (String(query.get('sessionId') ?? '').trim() && data.sessionId !== String(query.get('sessionId')).trim()) throw new Error('终端不属于当前会话')
      return sendJson(res, 200, data)
    }
    if (rest === '/terminal/write' && method === 'POST') {
      const id = String(body?.id ?? '').trim()
      if (!id) throw new Error('缺少 terminal id')
      if (typeof body?.data !== 'string') throw new Error('缺少 terminal data')
      const terminal = services.terminals.read(id, 0)
      if (body?.sessionId && terminal.sessionId !== String(body.sessionId).trim()) throw new Error('终端不属于当前会话')
      return sendJson(res, 200, { ok: services.terminals.write(id, body.data) })
    }
    if (rest === '/terminal/resize' && method === 'POST') {
      const id = String(body?.id ?? '').trim()
      if (!id) throw new Error('缺少 terminal id')
      return sendJson(res, 200, { terminal: services.terminals.resize(id, Number(body?.cols), Number(body?.rows)) })
    }
    if (rest === '/terminal/close' && method === 'POST') {
      const id = String(body?.id ?? '').trim()
      if (!id) throw new Error('缺少 terminal id')
      const terminal = services.terminals.read(id, 0)
      if (body?.sessionId && terminal.sessionId !== String(body.sessionId).trim()) throw new Error('终端不属于当前会话')
      return sendJson(res, 200, { terminal: services.terminals.close(id) })
    }

    // 浏览器嵌入探测：仅读取响应头，不代理远端正文；拒绝本机地址以避免 SSRF。
    if (rest === '/browser-probe' && method === 'GET') {
      const raw = String(query.get('url') ?? '').trim()
      let target
      try { target = new URL(raw) } catch { throw new Error('URL 无效') }
      if (!/^https?:$/.test(target.protocol)) throw new Error('仅支持 http/https 地址')
      if (isLoopbackHost(target.hostname)) throw new Error('不允许探测本机地址')
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 8000)
      try {
        let response = await fetch(target, { method: 'HEAD', redirect: 'follow', signal: controller.signal })
        if (response.status === 405 || response.status === 501) response = await fetch(target, { method: 'GET', redirect: 'follow', signal: controller.signal })
        const csp = response.headers.get('content-security-policy') ?? ''
        const xfo = response.headers.get('x-frame-options')
        return sendJson(res, 200, {
          reachable: true, url: response.url, status: response.status,
          xFrameOptions: xfo ?? undefined,
          frameAncestors: csp.match(/(?:^|;)\s*frame-ancestors\s+([^;]+)/i)?.[1]?.trim() ?? undefined,
        })
      } catch { return sendJson(res, 200, { reachable: false })
      } finally { clearTimeout(timeout) }
    }

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

    // 会话置顶（持久化到 pinned.json，数组序即置顶序）
    if (rest === '/pinned' && method === 'GET') {
      return sendJson(res, 200, { ids: loadPinned() })
    }
    if (rest === '/pinned' && method === 'POST') {
      const id = String(body?.sessionId ?? '')
      if (!id) throw new Error('缺少 sessionId')
      return sendJson(res, 200, { ids: setPinned(id, body?.pinned !== false) })
    }

    // 会话索引（id↔标题）：客户端据此把侧栏行 DOM 映射回会话 id。
    // 用 sessionQuery 的全量语料（含未加载的持久化会话），标题从日志折叠。
    if (rest === '/sessions-index' && method === 'GET') {
      const query = services.sessionQuery
      const records = []
      try {
        if (typeof query?.listSessions === 'function') records.push(...(await query.listSessions()) ?? [])
      } catch { /* 查询服务不可用时返回空 */ }
      const ids = records.map((record) => String(record?.header?.id ?? ''))
      const titleById = new Map()
      if (typeof query?.readTitleSnapshots === 'function' && ids.length > 0) {
        try {
          const snapshots = await query.readTitleSnapshots(ids)
          for (const snapshot of snapshots ?? []) {
            // value.title 是标题快照对象：{ title, messageSeqs, source, ... }
            const titleText = snapshot?.status === 'fulfilled' && snapshot.value?.title?.title
              ? snapshot.value.title.title
              : null
            if (typeof titleText === 'string' && titleText.length > 0) {
              titleById.set(String(snapshot.value.session?.id ?? ''), titleText)
            }
          }
        } catch { /* 标题折叠失败时退回 id */ }
      }
      const rows = records.map((record) => {
        const id = String(record?.header?.id ?? '')
        return {
          id,
          cwd: typeof record?.header?.cwd === 'string' ? record.header.cwd : undefined,
          title: (titleById.get(id) ?? id).slice(0, 120),
        }
      })
      return sendJson(res, 200, { sessions: rows })
    }

    // 会话文件审查（「文件」标签页）：变更列表 / 认可 / 还原
    if (rest === '/session-files' && method === 'GET') {
      const root = requireRoot(query, undefined)
      return sendJson(res, 200, listSessionFiles(root, String(query.get('sessionId') ?? '')))
    }
    if (rest === '/file-accept' && method === 'POST') {
      const root = requireRoot(undefined, body)
      const repo = String(body?.repo ?? '').trim() || root
      if (!isAbsolute(repo) || !existsSync(repo)) throw new Error('repo 无效')
      return sendJson(res, 200, acceptSessionFile(repo, String(body?.sessionId ?? ''), String(body?.path ?? '')))
    }
    if (rest === '/file-revert' && method === 'POST') {
      const root = requireRoot(undefined, body)
      const repo = String(body?.repo ?? '').trim() || root
      if (!isAbsolute(repo) || !existsSync(repo)) throw new Error('repo 无效')
      const path = String(body?.path ?? '')
      if (!path) throw new Error('缺少 path')
      const status = gitStatus(repo)
      const change = (status.changes ?? []).find((c) => c.path === path)
      if (!change) return sendJson(res, 200, { ok: false, error: '文件当前没有变更' })
      const result = gitDiscard(repo, [change]).results[0]
      return sendJson(res, 200, result ?? { ok: false, error: '还原失败' })
    }

    // 面板状态（按项目持久化）
    if (rest === '/panel-state' && method === 'GET') {
      const root = requireRoot(query, undefined)
      const sessionId = String(query.get('sessionId') ?? '').trim()
      return sendJson(res, 200, { state: getPanelState(root, sessionId), defaults: loadSettings().panel })
    }
    if (rest === '/panel-state' && method === 'POST') {
      const root = requireRoot(undefined, body)
      const sessionId = String(body?.sessionId ?? '').trim()
      return sendJson(res, 200, { state: putPanelState(root, body?.state ?? {}, sessionId) })
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
    if (rest === '/git/commit' && method === 'POST') {
      const root = requireRoot(undefined, body)
      return sendJson(res, 200, gitCommit(root, body?.message))
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

    // 工作区目录选择增强：
    // - /workspaces            已注册工作区快捷列表（弹窗面板里的“快捷列表”）
    // - /folder-picker/*       Windows 文件夹窗口（WSL interop）与手动路径标准化
    const wishadelHome = () => (typeof homedir === 'function' ? homedir() : '')

    if (rest === '/workspaces' && method === 'GET') {
      const items = []
      try {
        const workspaces = services.workspaceRegistry?.list?.() ?? []
        for (const workspace of workspaces) {
          if (!workspace || typeof workspace.path !== 'string' || !workspace.path) continue
          items.push({
            workspaceId: String(workspace.id ?? ''),
            path: workspace.path,
            title: String(workspace.title ?? basename(workspace.path)),
          })
        }
      } catch { /* 注册表只读失败时退回空列表 */ }
      const home = wishadelHome()
      for (const dir of [home, services.sandboxPolicy?.workspaceRoot, process.cwd()]) {
        if (!dir || typeof dir !== 'string') continue
        if (items.some((item) => item.path === dir)) continue
        try {
          if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
        } catch { continue }
        items.push({ workspaceId: '', path: dir, title: basename(dir) })
      }
      return sendJson(res, 200, { items: items.slice(0, 80), home })
    }

    if (rest === '/folder-picker/capability' && method === 'GET') {
      return sendJson(res, 200, { ...folderPickerCapability(process.env), home: wishadelHome() })
    }

    if (rest === '/folder-picker/expand' && method === 'POST') {
      return sendJson(res, 200, { path: normalizeDirectoryPath(body?.path, wishadelHome()) })
    }

    if (rest === '/folder-picker/pick' && method === 'POST') {
      // 冒烟测试注入的替代实现先行：不弹真实窗口也能走完协议。
      if (typeof services.pickFolderOverride === 'function') {
        const override = await services.pickFolderOverride(body ?? {})
        if (override === null || override === undefined) return sendJson(res, 200, { cancelled: true })
        return sendJson(res, 200, { path: normalizeDirectoryPath(String(override), wishadelHome()) })
      }
      const capability = folderPickerCapability(process.env)
      if (capability.kind !== 'windows-dialog') throw new Error('当前环境无法弹出文件夹选择窗口，请使用手动输入或已注册工作区')
      const home = wishadelHome()
      const initial = body?.initial && typeof body.initial === 'string' ? String(body.initial).trim() : ''
      const initialWin = initial === ''
        ? windowsHomeDir(process.env)
        : (/^[A-Za-z]:[\\/]/.test(initial) || /^\\\\/.test(initial) ? initial : (wslPathToWin(initial) ?? ''))
      const run = spawnWindowsPicker({ initialWindowsDir: initialWin })
      let settled = false
      if (req && typeof req.on === 'function') {
        req.on('close', () => {
          if (!settled && !res.headersSent) {
            settled = true
            run.cancel()
          }
        })
      }
      try {
        const selected = await run.result
        settled = true
        if (!selected) return sendJson(res, 200, { cancelled: true })
        return sendJson(res, 200, { path: resolveSelectedDir(selected, home) })
      } catch (error) {
        settled = true
        throw new Error(`文件夹选择失败: ${String(error?.message ?? error)}`)
      }
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
        await handleRequest(rest, method, url.searchParams, body, req, res)
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
