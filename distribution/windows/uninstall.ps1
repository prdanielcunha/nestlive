$ErrorActionPreference = "Stop"
$InstallDir = Join-Path $env:LOCALAPPDATA "NestLive"

@("NestLiveService","NestLiveAudioNode","NestLiveProductionNode") |
  ForEach-Object {
    Get-Process $_ -ErrorAction SilentlyContinue |
      Stop-Process -Force -ErrorAction SilentlyContinue
  }

$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
Remove-ItemProperty -Path $RunKey -Name "NestLive" -ErrorAction SilentlyContinue

try {
  $cmd = @"
netsh advfirewall firewall delete rule name="NestLive Gateway"
netsh advfirewall firewall delete rule name="NestLive Discovery"
"@
  $temp = Join-Path $env:TEMP "nestlive-firewall-remove.cmd"
  Set-Content -Path $temp -Value $cmd -Encoding ASCII
  Start-Process -FilePath "cmd.exe" -ArgumentList ('/c "' + $temp + '"') -Verb RunAs -Wait | Out-Null
  Remove-Item $temp -Force -ErrorAction SilentlyContinue
} catch {}

Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "NestLive removido."
