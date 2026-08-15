[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [string]$Source = 'git+https://github.com/cdxDNRF/wishadel-theme.git'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
  throw 'dsh was not found on PATH. Install or run DeepSeek Harness first.'
}
if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) {
  throw 'corepack was not found on PATH. Node.js 18+ with Corepack is required.'
}

$shim = Join-Path ([IO.Path]::GetTempPath()) 'wishadel-theme-pnpm-shim'
New-Item -ItemType Directory -Path $shim -Force | Out-Null
$shimFile = Join-Path $shim 'pnpm.cmd'
[IO.File]::WriteAllText($shimFile, "@echo off`r`ncorepack pnpm %*`r`n", [Text.Encoding]::ASCII)
$env:PATH = "$shim;$env:PATH"

Write-Host "Installing Wishadel theme into DSH profile '$Profile'..."
& dsh plugin --profile $Profile add $Source
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed with exit code $LASTEXITCODE" }

Write-Host 'Installed. Restart dsh web, then refresh the browser.'
Write-Host 'Configure the theme under Settings -> Plugins -> Configurable.'
