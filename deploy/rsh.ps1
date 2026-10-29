param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Command,
  [string]$HostName = '47.111.150.169',
  [string]$User = 'root',
  [string]$KeyPath = 'C:\Users\13739\.ssh\dsh_rsa'
)

# Thin SSH wrapper: the host key is never remembered (UserKnownHostsFile=NUL), so
# StrictHostKeyChecking must be off or ssh blocks on a prompt in a non-tty session.
ssh -i $KeyPath `
  -o LogLevel=ERROR `
  -o StrictHostKeyChecking=no `
  -o UserKnownHostsFile=NUL `
  -o ConnectTimeout=15 `
  "$User@$HostName" $Command
exit $LASTEXITCODE