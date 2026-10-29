# ============================================================
#  把服务器上的日记备份（数据库 + 主密钥）拉回本机
#
#  为什么要这么做：日记正文在服务器上是 AES-256-GCM 密文，解密密钥在
#  /etc/liangchao.env 的 LD_DATA_KEY。**密钥和数据库一起丢了，日记就永久
#  打不开**。所以本机保留一份异地副本，是最便宜也最有效的保险。
#
#  服务器侧每天 03:20 由 /usr/local/bin/liangchao-backup.sh 生成：
#    /var/backups/liangchao/liangchao-YYYYMMDD-HHMMSS.db   （sqlite .backup，已做 integrity_check）
#    /var/backups/liangchao/env-YYYYMMDD-HHMMSS.txt        （含 LD_DATA_KEY，权限 600）
#
#  本脚本由 Windows 任务计划每天调用；也可以手动跑：
#    pwsh -File deploy\pull-backup.ps1
#
#  注意：拉下来的 ld-key.env 里是能解开全部日记的密钥。别放进 git 仓库、
#  别丢进共享文件夹；要更稳就再拷一份到 U 盘或网盘（加密压缩更保险）。
# ============================================================
[CmdletBinding()]
param(
  # 备份落在哪台机器的哪个目录
  [string]$Dest = 'D:\liangchao-backup',
  # 本机保留多少天
  [int]$KeepDays = 30,
  # 免密登录服务器的私钥
  [string]$SshKey = "$env:USERPROFILE\.ssh\dsh_rsa",
  [string]$Server = 'root@47.111.150.169',
  [string]$RemoteDir = '/var/backups/liangchao'
)

$ErrorActionPreference = 'Continue'   # 5.1 下 native 命令的 stderr 会变成终止性错误，这里不能 Stop
$ProgressPreference = 'SilentlyContinue'

function Write-Log([string]$Message) {
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host $line
  if (Test-Path -LiteralPath $Dest) {
    Add-Content -LiteralPath (Join-Path $Dest 'pull.log') -Value $line -Encoding utf8
  }
}

# OpenSSH 在 Windows 上认 UNIX 主机指纹库会出岔子，这里直接给个空文件并关掉校验；
# BatchMode=yes 保证它不会停下来等密码（任务计划里没人给它输入）。
$sshOpts = @(
  '-i', $SshKey,
  '-o', 'BatchMode=yes',
  '-o', 'LogLevel=ERROR',
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=NUL',
  '-o', 'ConnectTimeout=20'
)

try {
  if (-not (Test-Path -LiteralPath $SshKey)) {
    throw "找不到私钥 $SshKey（换电脑了就先把这个文件拷过来）"
  }
  if (-not (Get-Command ssh.exe -ErrorAction SilentlyContinue)) {
    throw '系统里没有 ssh.exe，需要先装 Windows 的 OpenSSH 客户端'
  }
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null

  # ---- 1. 问服务器要最新一份 db 和 env ----
  $remoteCmd = "ls -t $RemoteDir/liangchao-*.db 2>/dev/null | head -n1; ls -t $RemoteDir/env-*.txt 2>/dev/null | head -n1"
  $listing = & ssh @sshOpts $Server $remoteCmd 2>&1
  if ($LASTEXITCODE -ne 0) { throw "ssh 失败（退出码 $LASTEXITCODE）：$listing" }

  $paths = @($listing | Where-Object { $_ -and $_ -notmatch '^(Warning|Permanently)' -and $_.Trim() -ne '' })
  $remoteDb = $paths | Where-Object { $_ -like '*liangchao-*.db' } | Select-Object -First 1
  $remoteEnv = $paths | Where-Object { $_ -like '*env-*.txt' } | Select-Object -First 1
  if (-not $remoteDb) { throw "服务器上 $RemoteDir 里没有 db 备份，先看 /var/log/liangchao-backup.log" }
  if (-not $remoteEnv) { throw "服务器上 $RemoteDir 里没有 env 备份（密钥！）" }

  # ---- 2. 拉到 日期/ 目录，另有 latest/ 方便随手打开 ----
  $dayDir = Join-Path $Dest (Get-Date -Format 'yyyy-MM-dd')
  $latestDir = Join-Path $Dest 'latest'
  New-Item -ItemType Directory -Force -Path $dayDir, $latestDir | Out-Null

  $localDb = Join-Path $dayDir 'liangchao.db'
  $localEnv = Join-Path $dayDir 'ld-key.env'

  & scp @sshOpts "${Server}:$remoteDb" $localDb 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "下载 db 失败（退出码 $LASTEXITCODE）" }
  & scp @sshOpts "${Server}:$remoteEnv" $localEnv 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "下载密钥失败（退出码 $LASTEXITCODE）" }

  # ---- 3. 校验：文件够大、db 头是 SQLite、密钥里有 LD_DATA_KEY ----
  $dbSize = (Get-Item -LiteralPath $localDb).Length
  if ($dbSize -lt 4096) { throw "db 只有 $dbSize 字节，像是不完整" }
  $header = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($localDb)[0..14])
  if ($header -ne 'SQLite format 3') { throw "db 文件头不是 SQLite（读到 '$header'）" }
  $keyText = Get-Content -LiteralPath $localEnv -Raw
  if ($keyText -notmatch 'LD_DATA_KEY=\w{64}') { throw '密钥文件里没有像样的 LD_DATA_KEY' }

  Copy-Item -LiteralPath $localDb -Destination (Join-Path $latestDir 'liangchao.db') -Force
  Copy-Item -LiteralPath $localEnv -Destination (Join-Path $latestDir 'ld-key.env') -Force

  Write-Log ("OK  db={0:N0} KB  key={1} 字节  来自 {2}" -f ($dbSize / 1KB), (Get-Item -LiteralPath $localEnv).Length, $remoteDb)

  # ---- 4. 清理超过 KeepDays 的旧目录 ----
  $cutoff = (Get-Date).Date.AddDays(-$KeepDays)
  Get-ChildItem -LiteralPath $Dest -Directory |
    Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}$' -and [datetime]$_.Name -lt $cutoff } |
    ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Recurse -Force
      Write-Log ("清理旧备份 " + $_.Name)
    }

  # 单份备份记录超过 1 MB 就截断，免得越滚越大
  $logFile = Join-Path $Dest 'pull.log'
  if ((Get-Item -LiteralPath $logFile).Length -gt 1MB) {
    $tail = Get-Content -LiteralPath $logFile -Tail 500
    Set-Content -LiteralPath $logFile -Value $tail -Encoding utf8
  }

  exit 0
}
catch {
  Write-Log ("FAIL " + $_.Exception.Message)
  exit 1
}