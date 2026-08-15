//#region src/host/imports.js

// 宿主半边共用导入。构建脚本按顺序拼接本目录文件为一个 ESM 模块，
// 因此所有 import 集中在第一个文件，其余文件共享同一模块作用域。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

//#endregion src/host/imports.js

//#region src/host/store.js

// JSON 持久化：写入 $DSH_HOME/storages/wishadel/ 下，原子替换。
// 不依赖 settings/storage 服务，避免第三方命名空间白名单与 zod 实例跨包兼容问题。

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')
const storeDir = () => join(dshHome(), 'storages', 'wishadel')

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(join(storeDir(), file), 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  mkdirSync(storeDir(), { recursive: true })
  const target = join(storeDir(), file)
  const tmp = `${target}.tmp-${randomUUID()}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, target)
}

// 深度合并：对象递归合并，其余（数组/标量）整体替换。
function mergeDeep(base, patch) {
  if (patch === undefined || patch === null) return base
  if (typeof base !== 'object' || base === null || Array.isArray(base) || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) out[key] = mergeDeep(base[key], value)
  return out
}

function now() { return Date.now() }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

//#endregion src/host/store.js

//#region src/host/settings.js

// 设置中心：宿主侧唯一事实来源（settings.json）。
// 客户端卡片通过 /wishadel/settings 读写；宿主各功能（任务看板/Git/面板）实时读取。

const SETTINGS_SCHEMA = z.object({
  // 主题选择：'wishadel' 为当前皮肤，'none' 还原 DSH 默认外观。
  theme: z.enum(['wishadel', 'none']).default('wishadel'),
  themeOptions: z.object({
    chrome: z.boolean().default(true),
    sidebarArt: z.boolean().default(true),
    conversationArt: z.boolean().default(true),
  }).default({}),
  // 任务看板
  taskboard: z.object({
    enabled: z.boolean().default(true),
    cronTickMs: z.number().int().min(5000).max(600000).default(30000),
    defaultPreset: z.string().default(''),
    defaultCwd: z.string().default(''),
  }).default({}),
  // Git 图谱
  gitgraph: z.object({
    enabled: z.boolean().default(true),
    maxCommits: z.number().int().min(10).max(2000).default(200),
  }).default({}),
  // 右侧面板
  panel: z.object({
    enabled: z.boolean().default(true),
    defaultWidth: z.number().int().min(260).max(900).default(380),
    defaultCollapsed: z.boolean().default(false),
    maxPreviewBytes: z.number().int().min(65536).max(20000000).default(2000000),
  }).default({}),
})

const SETTINGS_FILE = 'settings.json'
let settingsCache = null
const settingsListeners = new Set()

function loadSettings() {
  if (settingsCache === null) {
    settingsCache = SETTINGS_SCHEMA.parse(readJson(SETTINGS_FILE, {}))
  }
  return settingsCache
}

function updateSettings(patch) {
  const next = SETTINGS_SCHEMA.parse(mergeDeep(loadSettings(), patch ?? {}))
  settingsCache = next
  writeJson(SETTINGS_FILE, next)
  for (const listener of settingsListeners) {
    try { listener(next) } catch { /* 监听器异常不影响写入 */ }
  }
  return next
}

function onSettingsChanged(listener) {
  settingsListeners.add(listener)
  return () => settingsListeners.delete(listener)
}

// 右侧面板的宽度/折叠状态：按项目（workspace root）持久化。
const PANEL_STATE_FILE = 'panel-state.json'
let panelStateCache = null

function loadPanelState() {
  if (panelStateCache === null) {
    const raw = readJson(PANEL_STATE_FILE, { byRoot: {} })
    panelStateCache = raw && typeof raw === 'object' && raw.byRoot && typeof raw.byRoot === 'object' ? raw : { byRoot: {} }
  }
  return panelStateCache
}

function getPanelState(root) {
  return loadPanelState().byRoot[root] ?? null
}

function putPanelState(root, state) {
  const doc = loadPanelState()
  doc.byRoot[root] = {
    width: Number.isFinite(state?.width) ? Math.min(900, Math.max(260, Math.round(state.width))) : undefined,
    collapsed: Boolean(state?.collapsed),
  }
  writeJson(PANEL_STATE_FILE, doc)
  return doc.byRoot[root]
}

//#endregion src/host/settings.js

//#region src/host/fs-service.js

// 右侧面板的文件服务：受根目录约束的读写（用户面板操作，非 agent 沙箱动作）。
// 写入仍尊重当前会话的沙箱模式（read-only 时拒绝写）。

const PATH_ESCAPE = new Error('路径超出项目根目录')

function safeJoin(root, relPath) {
  const base = resolve(root)
  const target = resolve(base, relPath ?? '.')
  const relOut = relative(base, target)
  if (relOut.startsWith('..') || isAbsolute(relOut)) throw PATH_ESCAPE
  return { abs: target, rel: relOut === '' ? '.' : relOut }
}

function dirEntries(root, relPath) {
  const { abs } = safeJoin(root, relPath)
  const stat = statSync(abs)
  if (!stat.isDirectory()) throw new Error('不是目录')
  const entries = []
  for (const name of readdirSync(abs)) {
    const full = join(abs, name)
    let type = 'file'
    let size
    try {
      const s = statSync(full)
      if (s.isDirectory()) type = 'directory'
      else if (!s.isFile()) type = 'other'
      size = s.isFile() ? s.size : undefined
    } catch {
      type = 'other'
    }
    entries.push({ name, type, size })
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1))
  const truncated = entries.length > 2000
  return { path: relPath ?? '.', entries: entries.slice(0, 2000), truncated }
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.scss', '.less', '.html', '.htm', '.xml', '.svg',
  '.csv', '.tsv', '.py', '.sh', '.ps1', '.bat', '.cmd', '.rs', '.go', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cc',
  '.vue', '.svelte', '.sql', '.rb', '.php', '.lua', '.log', '.gitignore', '.gitattributes', '.editorconfig',
  '.lock', '.patch', '.diff', '.license', '.dockerfile', '.makefile', '.jsonl', '.ndjson', '.ipynb',
  '.rst', '.tex', '.tf', '.proto', '.graphql', '.prisma', '.dart', '.swift', '.scala', '.cs', '.fs', '.ex', '.exs',
  '.clj', '.erl', '.r', '.jl', '.zig', '.vim', '.gitmodules', '.npmrc', '.yarnrc', '.eslintrc', '.prettierrc',
  '.babelrc', '.htaccess', '.sln', '.csproj', '.vcxproj', '.props', '.targets', '.razor', '.blade.php', '.hbs',
])

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif'])

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.csv': 'text/csv',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

function readForPreview(root, relPath, maxBytes) {
  const { abs } = safeJoin(root, relPath)
  const stat = statSync(abs)
  if (!stat.isFile()) throw new Error('不是文件')
  const size = stat.size
  const ext = extname(abs).toLowerCase()
  const truncated = size > maxBytes
  const readSize = truncated ? maxBytes : size
  const bytes = readFileSync(abs).subarray(0, readSize)
  const looksText = TEXT_EXTENSIONS.has(ext) || !bytes.subarray(0, 8192).includes(0)
  if (IMAGE_EXTENSIONS.has(ext) && !truncated) {
    return { kind: 'image', name: basename(abs), mime: MIME[ext] ?? 'application/octet-stream', size, dataUrl: `data:${MIME[ext] ?? 'application/octet-stream'};base64,${bytes.toString('base64')}` }
  }
  if (looksText) {
    let text
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { text = bytes.toString('utf8') }
    return { kind: 'text', name: basename(abs), size, text, truncated }
  }
  // 其余一律按二进制返回：小文件携带 base64 供内嵌预览（PDF）或下载，超限只报元信息。
  return {
    kind: 'binary',
    name: basename(abs),
    size,
    mime: MIME[ext] ?? 'application/octet-stream',
    truncated,
    base64: truncated ? undefined : bytes.toString('base64'),
  }
}

// sandboxPolicy：resolve({}) 返回 { mode } 之类；read-only 时拒绝写。
function writeModeOf(services) {
  try { return services.sandboxPolicy?.resolve?.({})?.mode ?? 'workspace-write' } catch { return 'workspace-write' }
}

function writeFileText(services, root, relPath, content) {
  const mode = writeModeOf(services)
  if (mode === 'read-only') throw new Error('当前会话为只读模式，拒绝保存文件')
  const { abs } = safeJoin(root, relPath)
  const before = existsSync(abs) ? readFileSync(abs, 'utf8') : null
  writeFileSync(abs, content, 'utf8')
  return { before, after: content }
}

function deleteFile(services, root, relPath) {
  const mode = writeModeOf(services)
  if (mode === 'read-only') throw new Error('当前会话为只读模式，拒绝删除文件')
  const { abs } = safeJoin(root, relPath)
  if (existsSync(abs)) unlinkSync(abs)
  return { deleted: true }
}

// 按文件名递归搜索（深度/命中数受限；默认跳过 node_modules 与 .git）。
const SKIP_DIRS = new Set(['node_modules', '.git', '.pnpm-store', 'dist', 'build'])

function searchFiles(root, query, options = {}) {
  const needle = String(query ?? '').toLowerCase()
  if (!needle) throw new Error('缺少 query')
  const maxDepth = options.maxDepth ?? 12
  const maxHits = options.maxHits ?? 200
  const skipHidden = options.skipHidden !== false
  const matches = []
  const walk = (abs, depth) => {
    if (matches.length >= maxHits || depth > maxDepth) return
    let names
    try { names = readdirSync(abs, { withFileTypes: true }) } catch { return }
    for (const entry of names) {
      if (matches.length >= maxHits) return
      if (skipHidden && entry.name.startsWith('.')) continue
      const full = join(abs, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full, depth + 1)
        continue
      }
      if (entry.name.toLowerCase().includes(needle)) {
        matches.push({ path: relative(resolve(root), full).split('\\').join('/'), name: entry.name })
      }
    }
  }
  walk(resolve(root), 0)
  return { matches, truncated: matches.length >= maxHits }
}

//#endregion src/host/fs-service.js

//#region src/host/git-service.js

// Git 服务：直接调用系统 git（profile bundle 拥有用户级信任）。
// 提供：仓库信息/分支、状态(porcelain)、diff、stage/unstage/discard、日志与提交详情。

let gitCache = null
function gitAvailable() {
  if (gitCache === null) {
    try {
      gitCache = spawnSync('git', ['--version'], { windowsHide: true, encoding: 'utf8' }).status === 0
    } catch {
      gitCache = false
    }
  }
  return gitCache
}

function runGit(root, args) {
  const res = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
  })
  return {
    ok: res.status === 0,
    code: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error ? String(res.error) : undefined,
  }
}

function gitRepoInfo(root) {
  if (!gitAvailable()) return { available: false, isRepo: false, branch: '', branches: [] }
  const probe = runGit(root, ['rev-parse', '--is-inside-work-tree'])
  if (!probe.ok) return { available: true, isRepo: false, branch: '', branches: [] }
  const branchRes = runGit(root, ['branch', '--show-current'])
  const listRes = runGit(root, ['for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(HEAD)', 'refs/heads'])
  const current = branchRes.ok ? branchRes.stdout.trim() : ''
  const branches = []
  if (listRes.ok) {
    for (const line of listRes.stdout.split('\n')) {
      const [name, tip, head] = line.split('\x00')
      if (!name) continue
      branches.push({ name, tip, current: name === current || head === '*' })
    }
  }
  return { available: true, isRepo: true, branch: current, branches }
}

// porcelain v1: "XY path" 或 "XY old -> new"；X=index Y=worktree
function parseStatus(stdout) {
  const changes = []
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.length < 4) continue
    const x = line[0]
    const y = line[1]
    const rest = line.slice(3)
    let path = rest
    if (rest.includes(' -> ')) path = rest.split(' -> ')[1]
    changes.push({
      path,
      staged: x !== ' ' && x !== '?',
      worktree: y !== ' ' && y !== '?',
      untracked: x === '?' && y === '?',
      indexCode: x,
      worktreeCode: y,
    })
  }
  return changes
}

function gitStatus(root) {
  const info = gitRepoInfo(root)
  if (!info.isRepo) return { available: info.available, isRepo: false, branch: '', changes: [] }
  const res = runGit(root, ['status', '--porcelain'])
  return { available: true, isRepo: true, branch: info.branch, changes: res.ok ? parseStatus(res.stdout) : [], error: res.ok ? undefined : res.stderr.trim() }
}

function gitDiff(root, path, staged) {
  const args = ['--no-pager', 'diff', '--no-ext-diff', '--unified=3']
  if (staged) args.push('--cached')
  args.push('--', path)
  const res = runGit(root, args)
  return { ok: res.ok, text: res.stdout, error: res.ok ? undefined : res.stderr.trim() }
}

function gitStage(root, paths) {
  const res = runGit(root, ['add', '--', ...paths])
  return { ok: res.ok, error: res.ok ? undefined : res.stderr.trim() }
}

// 切换分支：优先 git switch（无路径歧义），旧版 git 回退 checkout。
function gitCheckout(root, branch) {
  const name = String(branch ?? '').trim()
  if (!name) throw new Error('缺少 branch')
  let res = runGit(root, ['switch', '--quiet', name])
  if (!res.ok && res.stderr.includes('is not a git command')) {
    res = runGit(root, ['checkout', '--quiet', name])
  }
  return { ok: res.ok, branch: res.ok ? name : undefined, error: res.ok ? undefined : (res.stderr || res.error || '切换失败').trim() }
}

function gitUnstage(root, paths) {
  const res = runGit(root, ['reset', '-q', '--', ...paths])
  return { ok: res.ok, error: res.ok ? undefined : res.stderr.trim() }
}

// discard：未跟踪文件直接删除；已跟踪先 reset 再 checkout。
function gitDiscard(root, changes) {
  const results = []
  for (const change of changes) {
    if (change.untracked) {
      const target = safeJoin(root, change.path)
      try { if (existsSync(target.abs)) unlinkSync(target.abs); results.push({ path: change.path, ok: true }) } catch (error) { results.push({ path: change.path, ok: false, error: String(error?.message ?? error) }) }
      continue
    }
    let res = { ok: true }
    if (change.staged) res = runGit(root, ['reset', '-q', '--', change.path])
    if (res.ok) res = runGit(root, ['checkout', '--', change.path])
    results.push({ path: change.path, ok: res.ok, error: res.ok ? undefined : res.stderr.trim() })
  }
  return { results }
}

// log：%x1f 分隔字段，parent 以空格分隔。branch 为空表示所有分支。
function gitLog(root, branch, max) {
  const args = ['--no-pager', 'log', '--topo-order', `--format=%H%x1f%P%x1f%an%x1f%at%x1f%s`, `-n${max}`, '--']
  if (branch) args.splice(args.length - 1, 0, branch)
  const res = runGit(root, args)
  if (!res.ok) return { ok: false, commits: [], error: res.stderr.trim() }
  const commits = res.stdout.split('\n').filter(Boolean).map((line) => {
    const [hash, parentsRaw, author, time, subject] = line.split('\x1f')
    return {
      hash,
      parents: parentsRaw ? parentsRaw.split(' ').filter(Boolean) : [],
      author,
      time: Number(time) * 1000,
      subject,
    }
  })
  return { ok: true, commits }
}

function gitCommitDetail(root, hash) {
  const showRes = runGit(root, ['--no-pager', 'show', '--no-patch', `--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%B`, hash])
  const filesRes = runGit(root, ['--no-pager', 'show', '--stat', '--name-only', '--format=', hash])
  if (!showRes.ok) return { ok: false, error: showRes.stderr.trim() }
  const [h, parentsRaw, author, email, time, subject, ...bodyParts] = showRes.stdout.split('\x1f')
  return {
    ok: true,
    commit: {
      hash: h,
      parents: parentsRaw ? parentsRaw.split(' ').filter(Boolean) : [],
      author, email,
      time: Number(time) * 1000,
      subject,
      body: bodyParts.join('\x1f').trim(),
    },
    files: filesRes.ok ? filesRes.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : [],
  }
}

//#endregion src/host/git-service.js

//#region src/host/tasks.js

// 任务看板引擎：任务持久化、cron 调度、真实 DSH 智能体会话执行与状态回写。

const TASK_STATUSES = ['planned', 'todo', 'running', 'done', 'failed']

const TASK_INPUT_SCHEMA = z.object({
  title: z.string().min(1, '标题不能为空').max(200),
  description: z.string().max(4000).default(''),
  prompt: z.string().max(20000).default(''),
  cron: z.string().max(200).default(''),
  cronEnabled: z.boolean().default(false),
  status: z.enum(TASK_STATUSES).default('planned'),
  preset: z.string().max(100).default(''),
  cwd: z.string().max(1000).default(''),
})

const TASKS_FILE = 'tasks.json'

// ── cron 解析（5 段：分 时 日 月 周，支持 * /n a-b a,b 与周名缩写）─────────
const DOW_NAMES = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 }

function resolveCronValue(text, min, max, names) {
  const named = names && text in names ? names[text] : undefined
  const value = named !== undefined ? named : Number(text)
  if (!Number.isInteger(value)) throw new Error(`cron 值无效: "${text}"`)
  return value
}

function parseCronField(field, min, max, names) {
  const out = new Set()
  for (const rawPart of String(field).split(',')) {
    const part = rawPart.trim().toUpperCase()
    if (!part) continue
    let base = part
    let step = 1
    const slashAt = part.indexOf('/')
    if (slashAt >= 0) {
      base = part.slice(0, slashAt)
      step = Number(part.slice(slashAt + 1))
      if (!Number.isInteger(step) || step < 1) throw new Error(`cron 步长无效: "${part}"`)
    }
    let lo
    let hi
    if (base === '*') { lo = min; hi = max } else if (base.includes('-')) {
      const [a, b] = base.split('-')
      lo = resolveCronValue(a, min, max, names)
      hi = resolveCronValue(b, min, max, names)
    } else { lo = resolveCronValue(base, min, max, names); hi = lo }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron 范围无效: "${part}"`)
    for (let value = lo; value <= hi; value += step) out.add(value)
  }
  return out
}

const cronCache = new Map()
function parseCron(expr) {
  const trimmed = String(expr ?? '').trim()
  if (!trimmed) throw new Error('cron 表达式为空')
  const cached = cronCache.get(trimmed)
  if (cached) return cached
  const fields = trimmed.split(/\s+/)
  if (fields.length !== 5) throw new Error('cron 需要 5 段（分 时 日 月 周），如 "0 23 * * *"')
  const minute = parseCronField(fields[0], 0, 59)
  const hour = parseCronField(fields[1], 0, 23)
  const dom = parseCronField(fields[2], 1, 31)
  const month = parseCronField(fields[3], 1, 12)
  const dow = parseCronField(fields[4], 0, 7, DOW_NAMES)
  if (dow.has(7)) { dow.delete(7); dow.add(0) }
  const parsed = {
    minute, hour, dom, month, dow,
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  }
  cronCache.set(trimmed, parsed)
  return parsed
}

function cronMatches(parsed, date) {
  const dayOk = parsed.domRestricted && parsed.dowRestricted
    ? (parsed.dom.has(date.getDate()) || parsed.dow.has(date.getDay()))
    : parsed.domRestricted ? parsed.dom.has(date.getDate())
    : parsed.dowRestricted ? parsed.dow.has(date.getDay())
    : true
  return parsed.minute.has(date.getMinutes()) && parsed.hour.has(date.getHours())
    && dayOk && parsed.month.has(date.getMonth() + 1)
}

function nextCronTime(expr, fromMs) {
  const parsed = parseCron(expr)
  const cursor = new Date(fromMs)
  cursor.setSeconds(0, 0)
  for (let i = 0; i < 600000; i++) {
    cursor.setTime(cursor.getTime() + 60000)
    if (cronMatches(parsed, cursor)) return cursor.getTime()
  }
  return null
}

// ── 任务存取 ────────────────────────────────────────────────────────────────
let tasksCache = null

function loadTasks() {
  if (tasksCache === null) {
    const raw = readJson(TASKS_FILE, { tasks: [] })
    tasksCache = Array.isArray(raw?.tasks) ? { tasks: raw.tasks } : { tasks: [] }
  }
  return tasksCache
}

function saveTasks() {
  writeJson(TASKS_FILE, loadTasks())
}

function createTaskEngine(services) {
  const running = new Set()
  const taskListeners = new Set()
  const notify = () => { for (const listener of taskListeners) { try { listener() } catch { /* noop */ } } }

  const list = () => [...loadTasks().tasks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const get = (id) => loadTasks().tasks.find((task) => task.id === id)

  function mutate(id, fn) {
    const task = get(id)
    if (!task) throw new Error('任务不存在')
    fn(task)
    task.updatedAt = now()
    saveTasks()
    notify()
    return task
  }

  function create(input) {
    const parsed = TASK_INPUT_SCHEMA.parse(input ?? {})
    if (parsed.cron.trim()) {
      parseCron(parsed.cron)
      if (!parsed.cronEnabled) parsed.cronEnabled = true
    }
    const task = {
      id: `task-${randomUUID().slice(0, 8)}`,
      ...parsed,
      status: parsed.status === 'running' ? 'todo' : parsed.status,
      sessionId: null,
      lastRunAt: null,
      lastResult: null,
      nextRunAt: parsed.cron.trim() && parsed.cronEnabled ? nextCronTime(parsed.cron, now()) : null,
      startedAt: null,
      finishedAt: null,
      createdAt: now(),
      updatedAt: now(),
      order: list().length,
    }
    loadTasks().tasks.push(task)
    saveTasks()
    notify()
    return task
  }

  function update(id, patch) {
    const task = get(id)
    if (!task) throw new Error('任务不存在')
    const merged = { ...task, ...(patch ?? {}) }
    const parsed = TASK_INPUT_SCHEMA.parse({
      title: merged.title,
      description: merged.description,
      prompt: merged.prompt,
      cron: merged.cron,
      cronEnabled: merged.cronEnabled,
      status: merged.status,
      preset: merged.preset,
      cwd: merged.cwd,
    })
    const engineOwned = task.status === 'running' && parsed.status !== 'running' ? 'running' : parsed.status
    if (parsed.cron.trim()) parseCron(parsed.cron)
    mutate(id, (target) => {
      Object.assign(target, parsed, { status: engineOwned })
      if (target.cron.trim() && target.cronEnabled) target.nextRunAt = nextCronTime(target.cron, target.lastRunAt ?? now())
      else target.nextRunAt = null
    })
    return get(id)
  }

  function remove(id) {
    const task = get(id)
    if (!task) throw new Error('任务不存在')
    if (task.status === 'running') throw new Error('任务正在执行中，无法删除（可等待完成后再删）')
    const before = loadTasks().tasks.length
    loadTasks().tasks = loadTasks().tasks.filter((item) => item.id !== id)
    if (loadTasks().tasks.length !== before) {
      saveTasks()
      notify()
    }
    return { removed: true }
  }

  // ── 执行 ────────────────────────────────────────────────────────────────────
  function buildTaskPrompt(task) {
    const body = (task.prompt || '').trim() || (task.description || '').trim() || task.title
    return `【任务看板执行】${task.title}\n\n${body}\n\n请独立完成上述任务。完成后用简短的中文汇报执行结果。`
  }

  async function readEvents(sessionId) {
    const live = services.sessions?.get(sessionId)
    if (live) return [...live.events]
    const snapshot = await services.sessionQuery?.readSession(sessionId)
    return snapshot?.events ?? []
  }

  async function lastTurnKind(sessionId) {
    const events = await readEvents(sessionId)
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'turn/end') return events[i].data?.reason?.kind ?? 'error'
    }
    return 'error'
  }

  function collectText(content, out) {
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') out.push(block.text)
    }
  }

  async function sessionSummary(sessionId) {
    const events = await readEvents(sessionId)
    const parts = []
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event.type === 'assistant/message') {
        collectText(event.data?.message?.content, parts)
        if (parts.length) break
      }
    }
    const text = parts.join('\n').trim()
    return text ? text.slice(0, 2000) : '（无文本输出）'
  }

  async function settle(task, handle, error) {
    running.delete(task.id)
    try {
      await sleep(300)
      let result
      let status = 'failed'
      if (error) {
        result = `运行错误：${String(error?.message ?? error)}`
      } else {
        const kind = await lastTurnKind(task.sessionId)
        status = kind === 'completed' ? 'done' : 'failed'
        result = await sessionSummary(task.sessionId)
        if (status === 'failed') result = `任务未正常完成（${kind}）。\n\n${result}`
      }
      // 任务可能已在执行期间被删除：结算写回必须容错，绝不能向调用方抛
      // （settle 由 whenIdle 分离驱动，未处理的拒绝会击穿整个 dsh 进程）。
      try {
        mutate(task.id, (target) => {
          target.status = status
          target.lastResult = result
          target.lastRunAt = now()
          target.finishedAt = now()
          if (target.cron.trim() && target.cronEnabled) target.nextRunAt = nextCronTime(target.cron, now())
        })
      } catch (missing) {
        console.warn(`wishadel: 任务 ${task.id} 已被删除，跳过状态回写`)
      }
    } catch (settleError) {
      console.warn(`wishadel: 任务 ${task.id} 结算失败: ${String(settleError?.message ?? settleError)}`)
    } finally {
      try { await handle.dispose() } catch { /* 会话已随进程/手动关闭 */ }
    }
  }

  async function run(id) {
    const task = get(id)
    if (!task) throw new Error('任务不存在')
    if (running.has(id)) throw new Error('任务正在执行中')
    running.add(id)
    mutate(id, (target) => {
      target.status = 'running'
      target.sessionId = null
      target.lastResult = null
      target.startedAt = now()
    })
    try {
      const presetId = (task.preset || '').trim() || undefined
      const presets = services.agentPresets
      const resolvedId = presets ? (await presets.resolve(presetId)).id : undefined
      const selection = services.agentDefaultModel?.currentSelection?.()
      const agentOptions = selection?.provider ? { provider: selection.provider, model: selection.model } : undefined
      const cwd = (task.cwd || '').trim() || services.sandboxPolicy?.workspaceRoot || process.cwd()
      const sessionId = `wishadel-task-${task.id}-${Math.floor(Date.now() / 1000)}`
      const handle = await services.agents.create({
        sessionId,
        agentOptions,
        meta: { cwd, ...(resolvedId ? { agentPreset: resolvedId } : {}) },
        setup: async (agentCtx) => { if (presets) await presets.mount(agentCtx, resolvedId) },
      })
      mutate(task.id, (target) => { target.sessionId = sessionId })
      const agent = handle.agent
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: buildTaskPrompt(task) }],
        source: { kind: 'user' },
      })
      agent.whenIdle().then(
        () => settle(task, handle, null),
        (error) => settle(task, handle, error),
      )
      return get(id)
    } catch (error) {
      running.delete(id)
      // 任务可能已在启动期间被删除：写回失败只记录，不抛出。
      try {
        mutate(id, (target) => {
          target.status = 'failed'
          target.lastResult = `启动失败：${String(error?.message ?? error)}`
          target.lastRunAt = now()
          target.finishedAt = now()
        })
      } catch (missing) {
        console.warn(`wishadel: 任务 ${id} 已被删除，跳过启动失败回写`)
      }
      throw error
    }
  }

  function cronTick() {
    const settings = loadSettings()
    if (!settings.taskboard.enabled) return
    const timestamp = now()
    for (const task of list()) {
      if (task.status === 'running') continue
      if (!task.cronEnabled || !(task.cron || '').trim()) continue
      // 并发删除防护：每次 mutate 都可能撞上"任务已被删除"，失败只记录。
      if (task.nextRunAt == null) {
        try {
          mutate(task.id, (target) => { target.nextRunAt = nextCronTime(target.cron, timestamp) })
        } catch { /* 任务已删除 */ }
        continue
      }
      if (timestamp >= task.nextRunAt) {
        const due = task.nextRunAt
        try {
          mutate(task.id, (target) => { target.nextRunAt = nextCronTime(target.cron, due) })
        } catch { continue /* 任务已删除 */ }
        run(task.id).catch(() => { /* run 内部已落库失败状态 */ })
      }
    }
  }

  function recoverInterrupted() {
    let changed = false
    for (const task of list()) {
      if (task.status === 'running') {
        task.status = 'failed'
        task.lastResult = '任务因 harness 重启而中断。'
        task.finishedAt = now()
        task.updatedAt = now()
        changed = true
      }
    }
    if (changed) { saveTasks(); notify() }
  }

  return {
    list, get, create, update, remove, run, cronTick, recoverInterrupted,
    onChanged: (listener) => { taskListeners.add(listener); return () => taskListeners.delete(listener) },
    nextCronTime,
    parseCronForPreview: (expr) => nextCronTime(expr, now()),
  }
}

//#endregion src/host/tasks.js

//#region src/host/routes.js

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

//#endregion src/host/routes.js

//#region src/host/apply.js

// Host 入口：组装服务、注册路由、启动 cron 调度与状态恢复。
// 全部副作用挂在当前 Fiber 上（ctx.effect），停止/更新插件时自动回收。
// inject 声明 webServer：本行在其就绪后才激活（webServer 依赖 webStartup，激活较晚）。
export const inject = ['webServer']

export function apply(ctx) {
  const services = {
    ctx,
    agents: ctx.get('agents'),
    sessions: ctx.get('sessions'),
    sessionQuery: ctx.get('sessionQuery'),
    agentPresets: ctx.get('agentPresets'),
    agentDefaultModel: ctx.get('agentDefaultModel'),
    sandboxPolicy: ctx.get('sandboxPolicy'),
    webServer: ctx.get('webServer'),
  }

  const tasks = createTaskEngine(services)
  services.tasks = tasks

  // 进程重启后，残留的 running 任务一律标记为中断失败。
  tasks.recoverInterrupted()

  if (services.webServer !== undefined) {
    createRoutes(ctx, services)
  } else {
    console.warn('wishadel: webServer 不可用，HTTP 通道未注册')
  }

  // cron 调度：tick 间隔来自设置（默认 30s），最小 5s。
  // 注意：不能访问 ctx.timer/ctx.setInterval（本版本 Cordis 要求声明 inject 才能
  // 读取服务属性），改用原生定时器 + ctx.effect 回收。
  const tick = () => {
    try { tasks.cronTick() } catch (error) { console.warn(`wishadel cron tick: ${String(error)}`) }
  }
  const tickMs = Math.max(5000, loadSettings().taskboard.cronTickMs ?? 30000)
  const intervalHandle = setInterval(tick, tickMs)
  ctx.effect(() => () => clearInterval(intervalHandle), 'wishadel: cron tick')

  // 设置热变更时跟随 tick 间隔（读设置是惰性的，无需重挂）。
  const offSettings = onSettingsChanged(() => { /* 保留订阅以保持 settings.json 热同步 */ })
  ctx.effect(() => offSettings, 'wishadel: settings listeners')

  console.info('wishadel host bundle ready')
}

//#endregion src/host/apply.js
