param([switch]$SkipFirewall)

$ErrorActionPreference = "Stop"
$SourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallDir = Join-Path $env:LOCALAPPDATA "NestLive"
$WebDir = Join-Path $InstallDir "web"
$ProductionWebDir = Join-Path $InstallDir "web-production"
$LogDir = Join-Path $InstallDir "logs"
$InstallLog = Join-Path $LogDir "install.log"
$ServiceExe = Join-Path $InstallDir "NestLiveService.exe"

function Log([string]$Message) {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
  Write-Host $Message
  Add-Content -Path $InstallLog -Value $line -Encoding UTF8
}

try {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  New-Item -ItemType Directory -Force -Path $WebDir | Out-Null
  New-Item -ItemType Directory -Force -Path $ProductionWebDir | Out-Null
  Set-Content -Path $InstallLog -Value "NestLive installer" -Encoding UTF8

  @("NestLiveService","NestLiveAudioNode","NestLiveProductionNode","MusicScaleLiveNode","MillionsNestLiveNode") |
    ForEach-Object {
      Get-Process $_ -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
    }

  foreach ($name in @("NestLiveService.exe","NestLiveAudioNode.exe","NestLiveProductionNode.exe")) {
    $source = Join-Path $SourceDir $name
    if (-not (Test-Path $source)) { throw "$name nao foi encontrado no pacote." }
    Copy-Item $source (Join-Path $InstallDir $name) -Force
  }

  $SourceWeb = Join-Path $SourceDir "web"
  $SourceProductionWeb = Join-Path $SourceDir "web-production"
  if (-not (Test-Path (Join-Path $SourceWeb "index.html"))) {
    throw "A interface web do NestLive nao foi encontrada."
  }
  if (-not (Test-Path (Join-Path $SourceProductionWeb "index.html"))) {
    throw "A interface de producao do NestLive nao foi encontrada."
  }
  Remove-Item (Join-Path $WebDir "*") -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $ProductionWebDir "*") -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $SourceWeb "*") $WebDir -Recurse -Force
  Copy-Item (Join-Path $SourceProductionWeb "*") $ProductionWebDir -Recurse -Force

  $RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  New-Item -Path $RunKey -Force | Out-Null
  Remove-ItemProperty -Path $RunKey -Name "MusicScaleLiveNode" -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path $RunKey -Name "MillionsNestLiveNode" -ErrorAction SilentlyContinue
  Set-ItemProperty -Path $RunKey -Name "NestLive" -Value ('"' + $ServiceExe + '"')

  if (-not $SkipFirewall) {
    $cmd = @"
netsh advfirewall firewall delete rule name="NestLive Gateway" >NUL 2>&1
netsh advfirewall firewall delete rule name="NestLive Discovery" >NUL 2>&1
netsh advfirewall firewall add rule name="NestLive Gateway" dir=in action=allow protocol=TCP localport=4317 profile=private
netsh advfirewall firewall add rule name="NestLive Discovery" dir=in action=allow protocol=UDP localport=4318 profile=private
"@
    $temp = Join-Path $env:TEMP "nestlive-firewall.cmd"
    Set-Content -Path $temp -Value $cmd -Encoding ASCII
    try {
      Start-Process -FilePath "cmd.exe" -ArgumentList ('/c "' + $temp + '"') -Verb RunAs -Wait | Out-Null
    } finally {
      Remove-Item $temp -Force -ErrorAction SilentlyContinue
    }
  }

  Log "Iniciando NestLive..."
  $stdout = Join-Path $LogDir "service.stdout.log"
  $stderr = Join-Path $LogDir "service.stderr.log"
  $service = Start-Process -FilePath $ServiceExe -WorkingDirectory $InstallDir -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru

  $healthy = $false
  for ($i=0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if ($service.HasExited) {
      $err = if (Test-Path $stderr) { Get-Content $stderr -Raw } else { "" }
      throw "NestLive encerrou durante a inicializacao. $err"
    }
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:4317/health" -TimeoutSec 2
      if ($response.StatusCode -eq 200) { $healthy = $true; break }
    } catch {}
  }

  if (-not $healthy) { throw "NestLive nao respondeu na verificacao local." }

  Log "NestLive online. Gateway 4317; producao profunda permanece loopback-only."
  Start-Process "http://127.0.0.1:4317/local"
  Write-Host ""
  Write-Host "NESTLIVE INSTALADO COM SUCESSO" -ForegroundColor Green
  exit 0
} catch {
  Log ("ERRO: " + $_.Exception.Message)
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
