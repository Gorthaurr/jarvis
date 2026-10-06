# Personal no-API profile, separate from .env and the live server on 8787.
# Usage: powershell -File infra\run-no-api.ps1 -Brain codex|local [-Port 8788] [-OfflineAudio]
param(
  [ValidateSet('codex', 'local')][string]$Brain = 'codex',
  [ValidateRange(1024, 65535)][int]$Port = 8788,
  [switch]$OfflineAudio,
  [string]$OllamaBin = "$env:LOCALAPPDATA\Jarvis\runtime\ollama-v0.40.0\ollama.exe"
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$DataDir = Join-Path $Root 'apps\server\data\no-api'
$EnvFile = Join-Path $Root '.env.no-api'
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  throw "Port $Port is busy. Choose a free -Port; this script will not stop another server."
}
$OllamaProcess = $null
$PushedLocation = $false
try {
if ($Brain -eq 'local') {
  try { $null = Invoke-RestMethod 'http://127.0.0.1:11435/api/version' -TimeoutSec 2 }
  catch {
    if (-not (Test-Path -LiteralPath $OllamaBin)) { throw "Ollama binary missing: $OllamaBin. Install Ollama and pass -OllamaBin." }
    $PreviousHost = $env:OLLAMA_HOST
    try {
      $env:OLLAMA_HOST = '127.0.0.1:11435'
      $OllamaProcess = Start-Process -FilePath $OllamaBin -ArgumentList 'serve' -WindowStyle Hidden -PassThru
    } finally { $env:OLLAMA_HOST = $PreviousHost }
    for ($i = 0; $i -lt 30; $i++) {
      try { $null = Invoke-RestMethod 'http://127.0.0.1:11435/api/version' -TimeoutSec 1; break }
      catch { Start-Sleep -Milliseconds 300 }
    }
  }
  $Models = (Invoke-RestMethod 'http://127.0.0.1:11435/api/tags').models.name
  if ($Models -notcontains 'qwen3.5:9b-q4_K_M') { throw 'Model missing. Pull qwen3.5:9b-q4_K_M on OLLAMA_HOST=127.0.0.1:11435 first.' }
}
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$DataPath = $DataDir.Replace('\', '/')
$AudioMode = if ($OfflineAudio) { 'offline' } else { 'preserve' }
node (Join-Path $Root 'infra\no-api-profile.mjs') $Brain $Port $AudioMode
if ($LASTEXITCODE -ne 0) { throw 'Profile generation failed' }
$env:JARVIS_ENV_PATH = $EnvFile
$env:DATABASE_URL = "pglite://$DataPath/pgdata"
Push-Location $Root
$PushedLocation = $true
  node infra\migrate.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Database migration failed' }
  Write-Host "Jarvis ${Brain}: ws://127.0.0.1:$Port/ws. Start the client with PORT=$Port. Ctrl+C stops this server."
  pnpm --filter @jarvis/server start
} finally {
  if ($PushedLocation) { Pop-Location }
  if ($OllamaProcess -and -not $OllamaProcess.HasExited) { & taskkill /PID $OllamaProcess.Id /T /F | Out-Null }
}
