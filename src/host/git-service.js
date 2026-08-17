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

function gitCommit(root, message) {
  const text = String(message ?? '').trim()
  if (!text) throw new Error('提交信息不能为空')
  const res = runGit(root, ['commit', '-m', text])
  return { ok: res.ok, output: res.stdout.trim(), error: res.ok ? undefined : (res.stderr || res.error || '提交失败').trim() }
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
