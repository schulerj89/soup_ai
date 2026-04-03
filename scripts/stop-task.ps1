param(
  [string]$TaskName = "SoupAiSupervisor"
)

Write-Host "Stopping Task Scheduler job '$TaskName' if it is running."

try {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  Write-Host "Stop request sent for '$TaskName'."
} catch {
  Write-Warning "Stop-ScheduledTask failed or task was not running. Falling back to schtasks. Error: $($_.Exception.Message)"
  schtasks.exe /End /TN $TaskName | Out-Host

  if ($LASTEXITCODE -ne 0) {
    Write-Warning "schtasks /End returned exit code $LASTEXITCODE."
  }
}

try {
  Get-ScheduledTask -TaskName $TaskName | Format-List TaskName,State,Author,Description | Out-Host
} catch {
  Write-Warning "Task '$TaskName' was not found."
}
