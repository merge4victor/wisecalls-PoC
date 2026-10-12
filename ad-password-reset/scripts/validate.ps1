param([string]$PythonPath)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$root = Split-Path -Parent $PSScriptRoot
if ($PythonPath) {
  $pythonExe = $PythonPath
  $pythonPrefix = @()
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
  $pythonExe = 'py'
  $pythonPrefix = @('-3.13')
} else {
  $pythonExe = 'python'
  $pythonPrefix = @()
}
& $pythonExe @pythonPrefix -m compileall -q (Join-Path $root 'functions') (Join-Path $root 'scripts')
if ($LASTEXITCODE -ne 0) { throw 'Python compilation failed.' }
& $pythonExe @pythonPrefix -m unittest discover -s (Join-Path $root 'tests') -v
if ($LASTEXITCODE -ne 0) { throw 'Python tests failed.' }
Get-Content -Raw (Join-Path $root 'config\seed-customer.example.json') | ConvertFrom-Json | Out-Null
Get-Content -Raw (Join-Path $root 'infrastructure\parameters.example.json') | ConvertFrom-Json | Out-Null
if (Get-Command sam -ErrorAction SilentlyContinue) {
  sam validate --lint --template-file (Join-Path $root 'infrastructure\template.yaml')
} else {
  Write-Warning 'AWS SAM CLI is not installed; SAM/CloudFormation lint was skipped.'
}
Write-Host 'Local validation completed.'
