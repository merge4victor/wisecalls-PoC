param(
  [Parameter(Mandatory=$true)][string]$Region,
  [Parameter(Mandatory=$true)][string]$ConnectInstanceArn,
  [string]$StackName = "wisecalls-connect-dev",
  [string]$Profile,
  [switch]$Execute
)
$ErrorActionPreference = 'Stop'
$instanceId = ($ConnectInstanceArn -split '/')[1]
if (-not $instanceId) { throw 'ConnectInstanceArn is invalid.' }
$awsArgs = @('--region', $Region)
if ($Profile) { $awsArgs += @('--profile', $Profile) }

$streamName = 'wisecalls-dev-contact-lens-demo'
$scheduleName = 'wisecalls-dev-redaction-demo-teardown'

Write-Host "Reading stack outputs from $StackName..."
$describeArgs = @('cloudformation', 'describe-stacks', '--stack-name', $StackName, '--query', 'Stacks[0].Outputs', '--output', 'json') + $awsArgs
$outputsJson = aws @describeArgs
if ($LASTEXITCODE -ne 0) { throw "Could not read stack outputs for $StackName. Has it been deployed?" }
$outputs = $outputsJson | ConvertFrom-Json
$teardownArn = ($outputs | Where-Object { $_.OutputKey -eq 'RedactionDemoTeardownFunctionArn' }).OutputValue
if (-not $teardownArn) { throw 'Stack outputs are missing RedactionDemoTeardownFunctionArn.' }

$describeStreamArgs = @('kinesis', 'describe-stream-summary', '--stream-name', $streamName, '--query', 'StreamDescriptionSummary.StreamARN', '--output', 'text') + $awsArgs
$streamArn = (aws @describeStreamArgs 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $streamArn) {
  Write-Host "No active stream named $streamName found. Nothing to tear down."
  exit 0
}

Write-Host "Would invoke $teardownArn to disassociate storage config and delete stream $streamName, then delete the pending schedule '$scheduleName' if present."
if (-not $Execute) {
  Write-Host 'DRY RUN: no AWS changes made. Re-run with -Execute after reviewing the values.'
  exit 0
}

$payload = (@{ instanceId = $instanceId; streamArn = $streamArn; streamName = $streamName } | ConvertTo-Json -Compress)
$payloadFile = Join-Path $env:TEMP 'redaction-demo-teardown-payload.json'
Set-Content -LiteralPath $payloadFile -Value $payload -NoNewline
$responseFile = Join-Path $env:TEMP 'redaction-demo-teardown-response.json'

Write-Host 'Invoking the teardown Lambda...'
$invokeArgs = @('lambda', 'invoke', '--function-name', $teardownArn, '--payload', "file://$payloadFile", '--cli-binary-format', 'raw-in-base64-out', $responseFile) + $awsArgs
aws @invokeArgs
if ($LASTEXITCODE -ne 0) { throw 'lambda invoke failed.' }
Write-Host 'Teardown Lambda response:'
Get-Content -LiteralPath $responseFile | Write-Host

Write-Host "Deleting scheduled teardown '$scheduleName' if it still exists..."
$deleteArgs = @('scheduler', 'delete-schedule', '--name', $scheduleName, '--group-name', 'default') + $awsArgs
aws @deleteArgs 2>$null
Write-Host 'Done.'
