param(
  [string]$TaskName = "SoupAiSupervisor",
  [int]$IntervalMinutes = 1
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $projectRoot "scripts\run-supervisor.cmd"
$taskCommand = "`"$runner`""
$userId = "$env:USERDOMAIN\$env:USERNAME"
$startAt = (Get-Date).AddMinutes(1)
$interval = New-TimeSpan -Minutes $IntervalMinutes
$duration = New-TimeSpan -Days 3650

Write-Host "Registering Task Scheduler job '$TaskName' to run every $IntervalMinutes minute(s)."
$action = New-ScheduledTaskAction -Execute $runner -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -Once -At $startAt -RepetitionInterval $interval -RepetitionDuration $duration
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 72)

try {
  $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType S4U
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Runs Soup AI supervisor once per minute." `
    -Force `
    -ErrorAction Stop | Out-Null

  Write-Host "Registered background task for $userId using S4U logon."
} catch {
  Write-Warning "Background S4U registration failed for $userId. Falling back to basic schtasks registration. Error: $($_.Exception.Message)"
  schtasks.exe /Create /SC MINUTE /MO $IntervalMinutes /TN $TaskName /TR $taskCommand /F | Out-Host

  if ($LASTEXITCODE -ne 0) {
    throw "schtasks fallback registration failed with exit code $LASTEXITCODE."
  }

  Write-Warning "Registered a basic Task Scheduler job. It may remain interactive-only and may not start on battery power unless you recreate it from an elevated PowerShell session."
}

Get-ScheduledTask -TaskName $TaskName | Format-List TaskName,State,Author,Description | Out-Host
