# Personal no-API profile, separate from .env and the live server on 8787.
# Usage: powershell -File infra\run-no-api.ps1 -Brain codex|local [-Port 8788]
param(
  [ValidateSet('codex', 'local')][string]$Brain = 'codex',
  [ValidateRange(1024, 65535)][int]$Port = 8788,
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
$NoApiLines = @(
  "PORT=$Port", 'HOST=127.0.0.1', "LLM_PROVIDER=$Brain", 'CODEX_MODEL=gpt-6-luna',
  'OLLAMA_BASE_URL=http://127.0.0.1:11435', 'OLLAMA_MODEL=qwen3.5:9b-q4_K_M', 'OLLAMA_CONTEXT=131072',
  'STT_PROVIDER=whisper', 'WHISPER_MODEL=Xenova/whisper-base', 'HF_ENDPOINT=https://huggingface.co',
  'WHISPER_DEVICE=cpu', 'WHISPER_DTYPE=q8', 'TTS_PROVIDER=windows',
  "JARVIS_DATA_DIR=$DataPath", "DATABASE_URL=pglite://$DataPath/pgdata",
  'JARVIS_PRODUCT_MODE=0', 'JARVIS_PRIMARY_LLM=0', 'JARVIS_SUBSCRIPTION_FALLBACK=0',
  'ANTHROPIC_API_KEY=', 'OPENAI_API_KEY=', 'CODEX_API_KEY=', 'ELEVENLABS_API_KEY=', 'YANDEX_API_KEY=',
  'DEEPGRAM_API_KEY=', 'BRAVE_SEARCH_API_KEY=', 'CLAUDE_CODE_OAUTH_TOKEN=',
  'JARVIS_AMBIENT_TELEGRAM=0', 'JARVIS_AMBIENT_MAIL=0', 'JARVIS_AMBIENT_CALENDAR=0', 'JARVIS_SKILL_DISTILL=0'
)
[IO.File]::WriteAllLines($EnvFile, $NoApiLines, (New-Object Text.UTF8Encoding($false)))
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
