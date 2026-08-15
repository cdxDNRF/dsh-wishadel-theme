[CmdletBinding()]
param([string]$Profile = 'web')

$ErrorActionPreference = 'Stop'
$Package = '@cdxdnrf/dsh-client-ui-skin-wishadel'

if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
  throw 'dsh was not found on PATH.'
}
if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) {
  throw 'corepack was not found on PATH. Node.js 18+ with Corepack is required.'
}

$shim = Join-Path ([IO.Path]::GetTempPath()) 'wishadel-theme-pnpm-shim'
New-Item -ItemType Directory -Path $shim -Force | Out-Null
$shimFile = Join-Path $shim 'pnpm.cmd'
[IO.File]::WriteAllText($shimFile, "@echo off`r`ncorepack pnpm %*`r`n", [Text.Encoding]::ASCII)
$env:PATH = "$shim;$env:PATH"

Write-Host "Removing Wishadel theme from DSH profile '$Profile'..."
& dsh plugin --profile $Profile remove $Package
if ($LASTEXITCODE -ne 0) { throw "dsh plugin remove failed with exit code $LASTEXITCODE" }

Write-Host 'Removed. Restart dsh web, then refresh the browser.'
