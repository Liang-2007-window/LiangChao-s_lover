# ============================================================
#  本地一键发布：打包 -> 上传 -> 服务器解包 -> 重启
#  用法：pwsh -File deploy\push.ps1
#  说明：先把 tar 打到本地再 scp，不用管道（Windows 下管道喂 ssh 不可靠）
# ============================================================
param(
  [string]$HostName = '47.111.150.169',
  [string]$User     = 'root',
  [string]$KeyPath  = "$env:USERPROFILE\.ssh\dsh_rsa",
  [string]$RemoteDir = '/srv/liangchao/app'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$tar = Join-Path $env:TEMP "liangchao-$stamp.tar.gz"

$sshOpts = @('-i', $KeyPath, '-o', 'LogLevel=ERROR', '-o', 'StrictHostKeyChecking=no',
             '-o', 'UserKnownHostsFile=NUL', '-o', 'ConnectTimeout=15')
$target = "$User@$HostName"

Write-Host "==> 打包"
Push-Location $root
try {
  tar -czf $tar `
    --exclude='.git' --exclude='.local' --exclude='.data' `
    --exclude='node_modules' --exclude='server/.env' --exclude='*.db*' `
    --exclude='*.log' --exclude='desktop.ini' `
    index.html diary.html css js images audio fonts server tests docs deploy
} finally { Pop-Location }
Write-Host ("    大小 {0:N0} KB" -f ((Get-Item $tar).Length / 1KB))

Write-Host "==> 上传"
& scp @sshOpts $tar "${target}:/tmp/liangchao-upload.tar.gz"

Write-Host "==> 解包并重启"
$remote = @"
set -e
mkdir -p $RemoteDir
tar -xzf /tmp/liangchao-upload.tar.gz -C $RemoteDir
rm -f /tmp/liangchao-upload.tar.gz
chown -R www-data:www-data $RemoteDir
systemctl restart liangchao
sleep 1
systemctl is-active liangchao
curl -fsS http://127.0.0.1/api/health
"@
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remote))
& ssh @sshOpts $target "echo $b64 | base64 -d | bash"

Remove-Item $tar -Force
Write-Host "==> 完成"