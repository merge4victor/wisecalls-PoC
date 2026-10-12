[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$agentMapRoot = Split-Path -Parent $PSScriptRoot
$required = @(
  "backend\app.py",
  "backend\tests\test_app.py",
  "frontend\package.json",
  "frontend\index.html",
  "frontend\src\main.js",
  "frontend\src\styles.css",
  "frontend\public\config.example.js",
  "frontend\public\wisecalls_logo.jpg",
  "infrastructure\template.yaml",
  "infrastructure\parameters.example.json",
  "docs\deployment.md"
)
$missing = $required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $agentMapRoot $_)) }
if ($missing.Count) { throw "Missing agent-map files: $($missing -join ', ')" }

Get-Content -Raw -LiteralPath (Join-Path $agentMapRoot "infrastructure\parameters.example.json") | ConvertFrom-Json | Out-Null
& python -m unittest discover -s (Join-Path $agentMapRoot "backend\tests") -p "test_*.py"
if ($LASTEXITCODE -ne 0) { throw "Python unit tests failed." }

Push-Location (Join-Path $agentMapRoot "frontend")
try {
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw "Frontend build failed." }
} finally {
  Pop-Location
}

if (Get-Command sam -ErrorAction SilentlyContinue) {
  & sam validate --lint --template-file (Join-Path $agentMapRoot "infrastructure\template.yaml")
  if ($LASTEXITCODE -ne 0) { throw "SAM template validation failed." }
} else {
  Write-Warning "SAM CLI is not installed; template lint was skipped. Claude must run sam validate --lint before deployment."
}
Write-Host "Agent-map local validation passed."
