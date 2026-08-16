// 会话文件审查（「文件」标签页数据）：
// git 工作区变更作为本会话的文件改动来源；「认可修改」按 (sessionId, path) 记录
// 当前变更签名（untracked 取文件内容哈希、tracked 取 diff 哈希），
// 文件再次变化时签名不同会自动重新出现在列表里。

function loadSessionFilesStore() {
  const data = readJson('session-files.json', {})
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
}

function saveSessionFilesStore(store) {
  writeJson('session-files.json', store)
}

function hashText(text) {
  return createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 16)
}

// 变更签名：未跟踪 → 文件内容哈希；已跟踪 → diff 文本哈希。
function fileSignature(root, change) {
  if (change.untracked) {
    const target = safeJoin(root, change.path)
    try { return `u:${hashText(readFileSync(target.abs))}` } catch { return 'u:missing' }
  }
  const diff = gitDiff(root, change.path, change.staged)
  return `d:${hashText(diff.ok ? diff.text : (diff.error ?? ''))}`
}

// 会话工作区往往是仓库的父目录：根不是仓库时，向下扫描子目录仓库（跳过依赖目录）。
function findRepos(root) {
  if (gitRepoInfo(root).isRepo) return [root]
  const out = []
  const scan = (dir, depth) => {
    if (depth > 2 || out.length >= 20) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (existsSync(join(full, '.git'))) { out.push(full); continue }
      scan(full, depth + 1)
    }
  }
  scan(root, 1)
  return out
}

function acceptedKey(repo, path) { return `${repo}\x00${path}` }

function fileKindOf(change) {
  if (change.untracked) return 'added'
  if (change.worktreeCode === 'D' || change.indexCode === 'D') return 'deleted'
  if (change.worktreeCode === 'A' || change.indexCode === 'A') return 'added'
  if (change.worktreeCode === 'R' || change.indexCode === 'R') return 'renamed'
  return 'modified'
}

function listSessionFiles(root, sessionId) {
  const repos = findRepos(root)
  if (repos.length === 0) return { isRepo: false, branch: '', files: [] }
  const store = loadSessionFilesStore()
  const accepted = store[String(sessionId ?? '')] ?? {}
  const files = []
  const branchLabels = []
  for (const repo of repos) {
    const status = gitStatus(repo)
    if (!status.isRepo) continue
    if (status.branch) branchLabels.push(`${basename(repo)}@${status.branch}`)
    for (const change of status.changes ?? []) {
      const displayPath = repo === root ? change.path : `${relative(root, repo)}\\${change.path}`
      const sig = fileSignature(repo, change)
      const acceptedSig = accepted[acceptedKey(repo, change.path)]
      files.push({
        path: displayPath,
        repoPath: change.path,
        repo,
        kind: fileKindOf(change),
        staged: change.staged,
        untracked: change.untracked,
        accepted: acceptedSig !== undefined && acceptedSig === sig,
      })
    }
  }
  return { isRepo: true, branch: branchLabels.join(' · ') || repos.map(basename).join(' · '), files }
}

function acceptSessionFile(repo, sessionId, path) {
  const status = gitStatus(repo)
  const change = (status.changes ?? []).find((c) => c.path === path)
  if (!change) return { ok: false, error: '文件当前没有变更' }
  const sig = fileSignature(repo, change)
  const store = loadSessionFilesStore()
  const key = String(sessionId ?? '')
  store[key] = { ...(store[key] ?? {}), [acceptedKey(repo, path)]: sig }
  saveSessionFilesStore(store)
  return { ok: true }
}
