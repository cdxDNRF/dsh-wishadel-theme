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
  '.lock', '.patch', '.diff', '.license', '.dockerfile', '.makefile',
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
  if (ext === '.pdf' || ext === '.docx' || ext === '.xlsx' || ext === '.pptx') {
    return { kind: 'binary', name: basename(abs), size, mime: MIME[ext], truncated, base64: truncated ? undefined : bytes.toString('base64') }
  }
  return { kind: 'unsupported', name: basename(abs), size, mime: MIME[ext] ?? 'application/octet-stream' }
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
