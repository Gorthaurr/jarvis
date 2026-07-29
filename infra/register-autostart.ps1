# Jarvis autostart registration (audit 2026-07-28, P0 "does not live by itself").
#
# Creates Windows Task Scheduler task "JarvisSupervisor": at user logon runs
# `node infra/supervisor.mjs` (hidden window) which keeps the server alive
# (restarts + /healthz watchdog + alerts). The Electron client registers its own
# autostart via env JARVIS_AUTOSTART=1 (login item).
#
# NOTE: ASCII-only on purpose — PowerShell 5.1 reads BOM-less .ps1 as ANSI and
# Cyrillic comments break parsing (known project pitfall).
#
# Usage (from jarvis/ root, per-user task, no admin needed):
#   powershell -ExecutionPolicy Bypass -File infra\register-autostart.ps1          # install
#   powershell -ExecutionPolicy Bypass -File infra\register-autostart.ps1 -Remove  # uninstall
param([switch]$Remove)

$TaskName = "JarvisSupervisor"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)  # jarvis/

if ($Remove) {
  try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    Write-Host "Task $TaskName removed."
  } catch {
    Write-Host "Task $TaskName not found - nothing to remove."
  }
  exit 0
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Error "node not found on PATH - install Node >=20 or add it to PATH."
  exit 1
}

# Bare node.exe in an interactive task would flash a console window at every logon -
# hide it via powershell -WindowStyle Hidden wrapper (supervisor logs to infra/supervisor.log).
$inner = "& '" + $node + "' 'infra\supervisor.mjs'"
$arg = '-NoProfile -WindowStyle Hidden -Command "' + $inner + '"'
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Write-Host "Task $TaskName registered: supervisor starts at Windows logon."
  Write-Host "Start it now: Start-ScheduledTask -TaskName $TaskName"
} catch {
  Write-Error "Failed to register task: $_"
  exit 1
}
