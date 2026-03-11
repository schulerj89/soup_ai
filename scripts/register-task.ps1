param(
  [string]$TaskName = "SoupAiSupervisor",
  [int]$IntervalMinutes = 1
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $projectRoot "scripts\run-supervisor.cmd"
$taskCommand = "`"$runner`""

Write-Host "Registering Task Scheduler job '$TaskName' to run every $IntervalMinutes minute(s)."
schtasks.exe /Create /SC MINUTE /MO $IntervalMinutes /TN $TaskName /TR $taskCommand /F | Out-Host
