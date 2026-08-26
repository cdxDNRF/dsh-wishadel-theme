// 工作区目录选择（WSL ↔ Windows 桥接）：
// DSH 官方目录选择 seam 在 WSL(Linux) 下需要 zenity/kdialog + 图形会话才走 native，
// 组合默认会落回应用内浏览（browse）或手输路径。这里补一条 WSL/Windows 桥：
// 通过 powershell.exe（WSL interop）打开 Windows 原生“选择文件夹”窗口，
// 再把选中的 Windows 路径经 wslpath 转换为 WSL 路径。
// 所有函数均为纯逻辑/注入式参数，冒烟测试可以不弹真实窗口直接验证。

const FOLDER_PICKER_PS1 = `param([string]$InitialDirectory = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择工作区目录（选中后自动转换为 WSL 路径）'
$dialog.ShowNewFolderButton = $true
if ($InitialDirectory -and (Test-Path -LiteralPath $InitialDirectory)) {
  $dialog.SelectedPath = $InitialDirectory
}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output $dialog.SelectedPath
  exit 0
}
exit 255
`

// 运行 wslpath 的小工具；测试可以注入替代实现。
function runWslpath(args) {
  try {
    const result = spawnSync('wslpath', args, { encoding: 'utf8', windowsHide: true, timeout: 15000 })
    return result.status === 0 && result.stdout ? result.stdout.trim() : null
  } catch { return null }
}

function winPathToWsl(winPath, wslpath = runWslpath) {
  let value = String(winPath ?? '').trim()
  if (!value) return null
  // UNC: \\wsl$\Ubuntu\home\... / \\wsl.localhost\Ubuntu\... → /home/...
  const unc = value.match(/^\\\\wsl(?:\.localhost)?\$\\[^\\]+\\?(.*)$/i)
  if (unc) {
    const tail = String(unc[1] ?? '').replace(/\\/g, '/')
    return tail.startsWith('/') ? `/${tail}` : tail
  }
  const converted = wslpath(['-u', value])
  if (converted) return converted
  // wslpath 对含引号或尾斜杠的路径偶有失败，再剥一层重试。
  const retry = wslpath(['-u', value.replace(/[\\/]+$/, '')])
  return retry
}

function wslPathToWin(wslPath, wslpath = runWslpath) {
  const value = String(wslPath ?? '').trim()
  if (!value) return null
  const converted = wslpath(['-w', value])
  return converted
}

// 是否具备弹出 Windows 文件夹窗口的条件：原生 Windows，或带 interop 的 WSL。
function folderDialogAvailable(env = process.env) {
  if (process.platform === 'win32') return true
  if (process.platform === 'linux') {
    const distro = String(env?.WSL_DISTRO_NAME ?? '').trim()
    if (!distro) return false
    try { return existsSync('/mnt/c/Windows') } catch { return false }
  }
  return false
}

function folderPickerCapability(env = process.env) {
  if (folderDialogAvailable(env)) {
    return {
      kind: 'windows-dialog',
      note: '通过 Windows 原生“选择文件夹”窗口选取目录，选中后自动转换为 WSL 路径。',
    }
  }
  return {
    kind: 'unavailable',
    note: '当前宿主环境无法弹出系统文件夹窗口；仍可使用已注册工作区或手动输入路径。',
  }
}

function windowsHomeDir(env = process.env) {
  if (env?.USERPROFILE) return String(env.USERPROFILE)
  if (env?.HOMEDRIVE && env?.HOMEPATH) return String(env.HOMEDRIVE) + String(env.HOMEPATH)
  const home = typeof homedir === 'function' ? homedir() : ''
  if (!home) return ''
  if (process.platform === 'win32') return home.replace(/\//g, '\\')
  return wslPathToWin(home) ?? ''
}

function wishadelTmpDir(env = process.env) {
  return env?.TMPDIR || env?.TEMP || env?.TMP || '/tmp'
}

// 打开 Windows 选择窗口。返回 { result: Promise<string|null>, cancel() }。
// resolve(null) = 用户取消；reject(Error) = 启动失败/超时/异常退出。
function spawnWindowsPicker({ initialWindowsDir = '', timeoutMs = 12 * 60 * 1000 } = {}) {
  const scriptPath = join(wishadelTmpDir(), `wishadel-pick-folder-${process.pid}-${Date.now()}.ps1`)
  const fail = (message) => ({ result: Promise.reject(new Error(message)), cancel() {} })
  try {
    writeFileSync(scriptPath, FOLDER_PICKER_PS1, 'utf8')
  } catch (error) {
    return fail(`无法准备选择脚本: ${String(error?.message ?? error)}`)
  }
  const scriptArg = process.platform === 'win32' ? scriptPath : (wslPathToWin(scriptPath) ?? scriptPath)
  const args = ['-NoProfile', '-Sta', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', scriptArg, initialWindowsDir ?? '']
  let child
  try {
    child = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  } catch (error) {
    try { unlinkSync(scriptPath) } catch { /* 临时文件清理失败不阻断 */ }
    return fail(`无法启动 powershell.exe: ${String(error?.message ?? error)}`)
  }
  let stdout = ''
  let stderr = ''
  let finished = false
  const result = new Promise((resolvePicker, reject) => {
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true
        try { child.kill() } catch { /* 进程可能已退出 */ }
        reject(new Error('文件夹选择窗口长时间未响应，已自动取消'))
      }
    }, timeoutMs)
    child.on('error', (error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      try { unlinkSync(scriptPath) } catch { /* 清理失败不阻断 */ }
      reject(new Error(`无法启动文件夹选择窗口: ${String(error?.message ?? error)}`))
    })
    child.on('close', (code) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      try { unlinkSync(scriptPath) } catch { /* 清理失败不阻断 */ }
      if (code === 255) return resolvePicker(null)
      if (code !== 0) return reject(new Error(stderr.trim() || `文件夹选择失败（退出码 ${code}）`))
      resolvePicker(stdout.trim())
    })
  })
  return {
    result,
    cancel() {
      if (!finished) {
        finished = true
        try { child.kill() } catch { /* 进程可能已退出 */ }
      }
    },
  }
}

// 手动输入/选中路径的统一标准化：~ 展开、Windows 路径转 WSL、相对路径按主目录解析，
// 最后校验目录真实存在。
function normalizeDirectoryPath(input, home) {
  const base = home || (typeof homedir === 'function' ? homedir() : undefined)
  let value = String(input ?? '').trim()
  if (!value) throw new Error('路径为空')
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    if (!base) throw new Error('无法定位用户主目录')
    value = value === '~' ? base : join(base, value.slice(2).replace(/^[\\/]+/, ''))
  } else if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)) {
    const converted = winPathToWsl(value)
    if (!converted) throw new Error('Windows 路径转换失败，请改用 WSL 路径（如 /mnt/c/…）')
    value = converted
  } else if (!isAbsolute(value)) {
    value = resolve(base || process.cwd(), value)
  }
  if (!existsSync(value)) throw new Error(`目录不存在: ${value}`)
  if (!statSync(value).isDirectory()) throw new Error(`路径不是目录: ${value}`)
  return value
}

// 弹窗返回的 Windows 路径 → WSL 路径并校验。
function resolveSelectedDir(winPath, home) {
  const converted = winPathToWsl(winPath)
  if (!converted) throw new Error('无法把所选目录转换为 WSL 路径')
  return normalizeDirectoryPath(converted, home)
}