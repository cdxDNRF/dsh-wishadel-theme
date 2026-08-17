// Session-scoped command terminals backed by node:child_process.spawn.
// Output cursors are absolute byte offsets, so readers can recover from a bounded tail.

const terminalSpawn = spawn

const TERMINAL_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const TERMINAL_DEFAULT_COLS = 80
const TERMINAL_DEFAULT_ROWS = 24

function createTerminalService(services = {}) {
  const terminals = new Map()
  let disposed = false
  let nextId = 1

  function terminalOf(id) {
    const terminal = terminals.get(String(id ?? ''))
    if (!terminal) throw new Error('终端不存在')
    return terminal
  }

  function metadata(terminal) {
    return {
      id: terminal.id,
      sessionId: terminal.sessionId,
      cwd: terminal.cwd,
      shell: terminal.shell,
      pid: terminal.child.pid ?? null,
      cols: terminal.cols,
      rows: terminal.rows,
      cursor: terminal.nextCursor,
      closed: terminal.closed,
      exitCode: terminal.exitCode,
      signal: terminal.signal,
      error: terminal.error,
    }
  }

  function append(terminal, chunk) {
    if (chunk === undefined || chunk === null) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    if (bytes.length === 0) return

    const combined = terminal.output.length === 0 ? bytes : Buffer.concat([terminal.output, bytes])
    terminal.nextCursor += bytes.length
    terminal.output = combined.length > TERMINAL_MAX_OUTPUT_BYTES
      ? combined.subarray(combined.length - TERMINAL_MAX_OUTPUT_BYTES)
      : combined
    terminal.baseCursor = terminal.nextCursor - terminal.output.length
  }

  function markClosed(terminal, code, signal) {
    if (terminal.closed) return
    terminal.closed = true
    terminal.exitCode = code ?? terminal.child.exitCode ?? null
    terminal.signal = signal ?? terminal.child.signalCode ?? null
  }

  function stop(terminal) {
    if (terminal.closed) return
    terminal.closing = true
    try { terminal.child.stdin.end() } catch { /* stdin may already be closed */ }
    try { terminal.child.kill() } catch { /* process may already have exited */ }
  }

  function start(sessionId, cwd, shell) {
    if (disposed) throw new Error('终端服务已释放')
    const owner = String(sessionId ?? '').trim()
    if (!owner) throw new Error('缺少 sessionId')
    const directory = String(cwd ?? '').trim() || process.cwd()
    const command = typeof shell === 'string' && shell.trim()
      ? shell.trim()
      : process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/sh')
    const id = `terminal-${nextId++}`
    const child = terminalSpawn(command, [], {
      cwd: directory,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const terminal = {
      id,
      sessionId: owner,
      cwd: directory,
      shell: command,
      child,
      output: Buffer.alloc(0),
      baseCursor: 0,
      nextCursor: 0,
      cols: TERMINAL_DEFAULT_COLS,
      rows: TERMINAL_DEFAULT_ROWS,
      closed: false,
      closing: false,
      exitCode: null,
      signal: null,
      error: undefined,
    }
    terminals.set(id, terminal)

    child.stdout.on('data', (chunk) => append(terminal, chunk))
    child.stderr.on('data', (chunk) => append(terminal, chunk))
    child.once('error', (error) => {
      terminal.error = String(error?.message ?? error)
      markClosed(terminal)
    })
    child.once('close', (code, signal) => markClosed(terminal, code, signal))
    return metadata(terminal)
  }

  function write(id, data) {
    const terminal = terminalOf(id)
    if (terminal.closed || terminal.closing || !terminal.child.stdin.writable) return false
    if (data === undefined || data === null) return false
    try { return terminal.child.stdin.write(data) } catch { return false }
  }

  function read(id, cursor) {
    const terminal = terminalOf(id)
    const requested = Number.isSafeInteger(cursor) ? cursor : terminal.baseCursor
    const startCursor = Math.max(terminal.baseCursor, requested)
    return {
      id: terminal.id,
      sessionId: terminal.sessionId,
      data: terminal.output.subarray(startCursor - terminal.baseCursor).toString('utf8'),
      cursor: terminal.nextCursor,
      closed: terminal.closed,
      exitCode: terminal.exitCode,
      signal: terminal.signal,
      error: terminal.error,
      truncated: requested < terminal.baseCursor,
      availableFrom: terminal.baseCursor,
    }
  }

  function resize(id, cols, rows) {
    const terminal = terminalOf(id)
    if (Number.isInteger(cols) && cols > 0) terminal.cols = cols
    if (Number.isInteger(rows) && rows > 0) terminal.rows = rows
    return metadata(terminal)
  }

  function close(id) {
    const terminal = terminalOf(id)
    stop(terminal)
    return metadata(terminal)
  }

  function list(sessionId) {
    const owner = String(sessionId ?? '')
    return [...terminals.values()]
      .filter((terminal) => terminal.sessionId === owner)
      .map(metadata)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const terminal of terminals.values()) stop(terminal)
    terminals.clear()
  }

  // Keep the argument part of the service contract for future policy hooks.
  void services
  return { start, write, read, resize, close, list, dispose }
}
