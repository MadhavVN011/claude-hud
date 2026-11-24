param(
  [string]$Server = 'http://127.0.0.1:8787',
  [string]$Name = $env:COMPUTERNAME,
  [string]$DataDir = (Join-Path $env:USERPROFILE '.claude-hud-monitor'),
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$DataDir = [System.IO.Path]::GetFullPath($DataDir)
$taskName = 'Claude HUD Usage Collector'
if ($Uninstall) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Startup task removed. Historical data and credentials retained in $DataDir"
  exit 0
}
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'Install Node.js >=22.18 from https://nodejs.org and rerun.' }
  winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw 'Node installation failed' }
  $nodePath = Join-Path $env:ProgramFiles 'nodejs\node.exe'
} else { $nodePath = $node.Source }
$nodeVersion = (& $nodePath --version).Trim().TrimStart('v')
if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'22.18.0') { throw 'Node.js >=22.18 is required' }
$root = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $root 'monitor\cli.ts'
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $DataDir '/inheritance:r' '/grant:r' "${identity}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to protect collector directory' }
$config = Join-Path $DataDir 'agent.json'
if (-not (Test-Path $config)) {
  & $nodePath $cli init-agent --dir $DataDir --server $Server --name $Name
  if ($LASTEXITCODE -ne 0) { throw 'Configuration failed' }
}
& $nodePath $cli is-enrolled --config $config
if ($LASTEXITCODE -ne 0) {
  # The node process prompts without echoing the token; it is not a command-line argument.
  & $nodePath $cli enroll --config $config
  if ($LASTEXITCODE -ne 0) { throw 'Enrollment failed; create a fresh enrollment in the dashboard and rerun' }
}
if ($cli.Contains('"') -or $config.Contains('"')) { throw 'Unsupported quote in installation path' }
$action = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$cli`" agent --config `"$config`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "Collector installed for $Name. Configuration: $config"
Write-Host 'Optional native quota bridge: node monitor/cli.ts enable-quota'
