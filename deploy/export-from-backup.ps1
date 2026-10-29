# Export every diary in plaintext from a LOCAL backup copy.
#
# This is the "the server is gone" path: it needs nothing but this repo, Node and
# the db + key that pull-backup.ps1 already pulled down to this PC. It never
# talks to the server and never writes to the live database.
#
#   pwsh -File deploy\export-from-backup.ps1
#   pwsh -File deploy\export-from-backup.ps1 -Db D:\liangchao-backup\2026-10-29\liangchao.db `
#        -KeyEnv D:\liangchao-backup\2026-10-29\ld-key.env -Out D:\liangchao-export
#
# Output: one <account>-<stamp>.json (lossless) and .md (readable) per account.
# Files are written where you asked and stay there: they are plaintext diaries.
param(
  [string]$Db,
  [string]$KeyEnv,
  [string]$Out,
  [string]$BackupRoot = 'D:\liangchao-backup'
)

$ErrorActionPreference = 'Continue'

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $Db) { $Db = Join-Path $BackupRoot 'latest\liangchao.db' }
if (-not $KeyEnv) { $KeyEnv = Join-Path $BackupRoot 'latest\ld-key.env' }
if (-not $Out) { $Out = Join-Path $BackupRoot ("export-" + (Get-Date -Format 'yyyy-MM-dd')) }

if (-not (Test-Path $Db)) { throw "db not found: $Db" }
if (-not (Test-Path $KeyEnv)) { throw "key file not found: $KeyEnv" }
if (-not (Test-Path (Join-Path $repo 'server\cli.mjs'))) { throw "run this from the site repo: $repo" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node not found in PATH' }

$match = Select-String -Path $KeyEnv -Pattern '^LD_DATA_KEY=([0-9a-fA-F]{64})\s*$' | Select-Object -First 1
if (-not $match) { throw "no 64 hex chars after LD_DATA_KEY= in $KeyEnv" }
$key = $match.Matches[0].Groups[1].Value

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('lc-export-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
Copy-Item -LiteralPath $Db -Destination (Join-Path $tmp 'liangchao.db') -Force
New-Item -ItemType Directory -Path $Out -Force | Out-Null

Push-Location $repo
$env:LD_DATA_DIR = $tmp
$env:LD_DATA_KEY = $key
$env:LD_LOG = '0'
& node 'server\cli.mjs' export-all $Out
$code = $LASTEXITCODE
Remove-Item Env:\LD_DATA_DIR, Env:\LD_DATA_KEY, Env:\LD_LOG -ErrorAction SilentlyContinue
Pop-Location
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue

if ($code -eq 0) {
  # Plaintext diaries: keep them readable by this user only.
  Get-ChildItem -LiteralPath $Out -Filter '*.json' | ForEach-Object {
    icacls $_.FullName /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null
  }
  Get-ChildItem -LiteralPath $Out -Filter '*.md' | ForEach-Object {
    icacls $_.FullName /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null
  }
  Write-Host "ok: exported to $Out"
  Get-ChildItem -LiteralPath $Out | Select-Object Name, Length | Format-Table -AutoSize
} else {
  Write-Host "export failed with exit code $code"
  exit $code
}