param(
  [Parameter(Mandatory=$true)][string]$Region,
  [Parameter(Mandatory=$true)][string]$ConnectInstanceArn,
  [Parameter(Mandatory=$true)][double]$DurationHours,
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
$schedulerRoleArn = ($outputs | Where-Object { $_.OutputKey -eq 'RedactionDemoSchedulerRoleArn' }).OutputValue
if (-not $teardownArn -or -not $schedulerRoleArn) {
  throw 'Stack outputs are missing RedactionDemoTeardownFunctionArn or RedactionDemoSchedulerRoleArn.'
}
Write-Host "  RedactionDemoTeardownFunctionArn = $teardownArn"
Write-Host "  RedactionDemoSchedulerRoleArn    = $schedulerRoleArn"

$expiry = (Get-Date).ToUniversalTime().AddHours($DurationHours)
$expiryExpr = "at($($expiry.ToString('yyyy-MM-ddTHH:mm:ss')))"

Write-Host "Would create Kinesis stream '$streamName', associate it as REAL_TIME_CONTACT_ANALYSIS_SEGMENTS storage, and schedule automatic teardown '$scheduleName' at $($expiry.ToString('u'))."
if (-not $Execute) {
  Write-Host 'DRY RUN: no AWS changes made. Re-run with -Execute after reviewing the values.'
  exit 0
}

Write-Host "Creating Kinesis stream $streamName..."
$createArgs = @('kinesis', 'create-stream', '--stream-name', $streamName, '--stream-mode-details', 'StreamMode=ON_DEMAND') + $awsArgs
aws @createArgs
if ($LASTEXITCODE -ne 0) { throw 'kinesis create-stream failed.' }

Write-Host 'Waiting for the stream to become active...'
$waitArgs = @('kinesis', 'wait', 'stream-exists', '--stream-name', $streamName) + $awsArgs
aws @waitArgs
if ($LASTEXITCODE -ne 0) { throw 'Stream did not become active.' }

$describeStreamArgs = @('kinesis', 'describe-stream-summary', '--stream-name', $streamName, '--query', 'StreamDescriptionSummary.StreamARN', '--output', 'text') + $awsArgs
$streamArn = (aws @describeStreamArgs)
if ($LASTEXITCODE -ne 0 -or -not $streamArn) { throw 'Could not read the new stream ARN.' }
Write-Host "  StreamARN = $streamArn"

Write-Host 'Associating the stream as REAL_TIME_CONTACT_ANALYSIS_SEGMENTS storage...'
$storageConfigJson = (@{ StorageType = 'KINESIS_STREAM'; KinesisStreamConfig = @{ StreamArn = $streamArn } } | ConvertTo-Json -Compress)
$associateArgs = @('connect', 'associate-instance-storage-config', '--instance-id', $instanceId, '--resource-type', 'REAL_TIME_CONTACT_ANALYSIS_SEGMENTS', '--storage-config', $storageConfigJson) + $awsArgs
aws @associateArgs
if ($LASTEXITCODE -ne 0) { throw 'associate-instance-storage-config failed.' }

Write-Host "Scheduling automatic teardown at $($expiry.ToString('u'))..."
$scheduleInput = (@{ instanceId = $instanceId; streamArn = $streamArn; streamName = $streamName } | ConvertTo-Json -Compress)
$targetJson = (@{ Arn = $teardownArn; RoleArn = $schedulerRoleArn; Input = $scheduleInput } | ConvertTo-Json -Compress)
$schedulerArgs = @('scheduler', 'create-schedule', '--name', $scheduleName, '--group-name', 'default', '--schedule-expression', $expiryExpr, '--flexible-time-window', '{"Mode":"OFF"}', '--target', $targetJson, '--action-after-completion', 'DELETE') + $awsArgs
aws @schedulerArgs
if ($LASTEXITCODE -ne 0) { throw 'scheduler create-schedule failed.' }

Write-Host "Demo window active until $($expiry.ToString('u')). Stream: $streamName. Schedule: $scheduleName."
Write-Host 'Run scripts/disable-redaction-demo.ps1 -Execute at any time to end it early.'
