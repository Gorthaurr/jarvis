# Jarvis product-mode instance runner (2026-09-02).
#
# Starts a SECOND server instance in "user path" mode next to the owner's live one:
#   env profile .env.product (JARVIS_ENV_PATH), port 8797, separate data dir and DB.
# The live server on 8787 under the supervisor is not touched.
#
# NOTE: ASCII-only on purpose - PowerShell 5.1 reads BOM-less .ps1 as ANSI and
# Cyrillic comments break parsing (known project pitfall).
#
# Usage (from jarvis/ root):
#   powershell -ExecutionPolicy Bypass -File infra\run-product.ps1            # start server
#   powershell -ExecutionPolicy Bypass -File infra\run-product.ps1 -Migrate   # apply base + product migrations first
#   powershell -ExecutionPolicy Bypass -File infra\run-product.ps1 -EnvFile .env.demo
param(
  [switch]$Migrate,
  [string]$EnvFile = ".env.product"
)

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)  # jarvis/
$EnvPath = Join-Path $Root $EnvFile

if (-not (Test-Path $EnvPath)) {
  Write-Host "Env profile not found: $EnvPath"
  Write-Host "Copy .env.product.example to $EnvFile and fill the secrets first."
  exit 1
}

$env:JARVIS_ENV_PATH = $EnvPath
$env:JARVIS_PRODUCT_MODE = "1"

if ($Migrate) {
  # migrate.mjs reads DATABASE_URL from process env; take it from the profile so the product DB gets migrated.
  foreach ($line in Get-Content $EnvPath) {
    if ($line -match '^\s*DATABASE_URL\s*=\s*(.+?)\s*$') { $env:DATABASE_URL = $Matches[1] }
  }
  Write-Host "Applying base + product migrations to $($env:DATABASE_URL) ..."
  Push-Location $Root
  node infra\migrate.mjs --product
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { Write-Host "Migration failed (exit $code)."; exit $code }
}

Write-Host "Starting Jarvis in PRODUCT MODE with profile $EnvFile ..."
Push-Location (Join-Path $Root "apps\server")
npx tsx src\index.ts
Pop-Location
