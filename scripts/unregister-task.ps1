param(
  [string]$TaskName = "SoupAiSupervisor"
)

Write-Host "Removing Task Scheduler job '$TaskName'."
schtasks.exe /Delete /TN $TaskName /F | Out-Host
