param(
  [Parameter(Mandatory=$true)][string]$Region,
  [Parameter(Mandatory=$true)][string]$ConnectInstanceArn,
  [Parameter(Mandatory=$true)][string]$FlowId,
  [Parameter(Mandatory=$true)][string]$AdPasswordResetStackName,
  [string]$ContentFile = (Join-Path (Split-Path -Parent $PSScriptRoot) 'connect-flows\wisecalls-voice-v1-dev.json'),
  [string]$Profile,
  [string]$MainStackName = "wisecalls-connect-dev",
  [string]$OrgName = $(if ($env:WISECALLS_ORG_NAME) { $env:WISECALLS_ORG_NAME } else { 'Wise Calls Org' }),
  [switch]$Execute
)
$ErrorActionPreference = 'Stop'
if ($OrgName -match '["\\]') { throw 'OrgName must not contain quotes or backslashes; it is inserted into flow JSON.' }
$root = Split-Path -Parent $PSScriptRoot
$instanceId = ($ConnectInstanceArn -split '/')[1]
if (-not $instanceId) { throw 'ConnectInstanceArn is invalid.' }
$awsArgs = @('--region', $Region)
if ($Profile) { $awsArgs += @('--profile', $Profile) }

Write-Host "Validating $ContentFile structurally..."
py -3.11 (Join-Path $root 'connect-flows\validate_flow.py') $ContentFile
if ($LASTEXITCODE -ne 0) { throw 'Flow content failed structural validation.' }

Write-Host "Reading ad-password-reset stack outputs from $AdPasswordResetStackName..."
$outputsJson = aws cloudformation describe-stacks --stack-name $AdPasswordResetStackName --query 'Stacks[0].Outputs' --output json @awsArgs
if ($LASTEXITCODE -ne 0) { throw "Could not read stack outputs for $AdPasswordResetStackName. Has it been deployed?" }
$outputs = $outputsJson | ConvertFrom-Json
$identifyArn = ($outputs | Where-Object { $_.OutputKey -eq 'IdentifyCallerFunctionArn' }).OutputValue
$lexAliasArn = ($outputs | Where-Object { $_.OutputKey -eq 'LexBotAliasArn' }).OutputValue
if (-not $identifyArn -or -not $lexAliasArn) {
  throw 'Stack outputs are missing IdentifyCallerFunctionArn or LexBotAliasArn.'
}
Write-Host "  IdentifyCallerFunctionArn = $identifyArn"
Write-Host "  LexBotAliasArn            = $lexAliasArn"

Write-Host "Reading main stack outputs from $MainStackName..."
$mainOutputsJson = aws cloudformation describe-stacks --stack-name $MainStackName --query 'Stacks[0].Outputs' --output json @awsArgs
if ($LASTEXITCODE -ne 0) { throw "Could not read stack outputs for $MainStackName. Has it been deployed?" }
$mainOutputs = $mainOutputsJson | ConvertFrom-Json
$getSlotArn = ($mainOutputs | Where-Object { $_.OutputKey -eq 'GetNextOpenSlotFunctionArn' }).OutputValue
$bookSlotArn = ($mainOutputs | Where-Object { $_.OutputKey -eq 'BookCallbackSlotFunctionArn' }).OutputValue
if (-not $getSlotArn -or -not $bookSlotArn) {
  throw 'Main stack outputs are missing GetNextOpenSlotFunctionArn or BookCallbackSlotFunctionArn.'
}
Write-Host "  GetNextOpenSlotFunctionArn = $getSlotArn"
Write-Host "  BookCallbackSlotFunctionArn = $bookSlotArn"
Write-Host "  OrgName                     = $OrgName"

$rawContent = Get-Content -Raw -LiteralPath $ContentFile
$substituted = $rawContent.Replace('__IDENTIFY_CALLER_FUNCTION_ARN__', $identifyArn).Replace('__PASSWORD_RESET_BOT_ALIAS_ARN__', $lexAliasArn).Replace('__GET_NEXT_OPEN_SLOT_FUNCTION_ARN__', $getSlotArn).Replace('__BOOK_CALLBACK_SLOT_FUNCTION_ARN__', $bookSlotArn).Replace('__ORG_NAME__', $OrgName)
if ($substituted -match '__[A-Z_]+__') {
  throw "Unsubstituted placeholder token remains in content: $($Matches[0])"
}
$tempFile = Join-Path $env:TEMP "$FlowId-substituted.json"
Set-Content -LiteralPath $tempFile -Value $substituted -NoNewline

Write-Host "Re-validating substituted content..."
py -3.11 (Join-Path $root 'connect-flows\validate_flow.py') $tempFile
if ($LASTEXITCODE -ne 0) { throw 'Substituted flow content failed structural validation.' }

Write-Host "Current live content for flow $FlowId (for comparison):"
aws connect describe-contact-flow --instance-id $instanceId --contact-flow-id $FlowId --query 'ContactFlow.{Name:Name,Status:Status}' --output json @awsArgs

if (-not $Execute) {
  Write-Host "DRY RUN: substituted content written to $tempFile. Re-run with -Execute after reviewing it."
  exit 0
}

Write-Host "Pushing new content to flow $FlowId..."
aws connect update-contact-flow-content --instance-id $instanceId --contact-flow-id $FlowId --content "file://$tempFile" @awsArgs
if ($LASTEXITCODE -ne 0) { throw 'update-contact-flow-content failed.' }

Write-Host "Verifying the new content is live..."
$live = aws connect describe-contact-flow --instance-id $instanceId --contact-flow-id $FlowId --output json @awsArgs | ConvertFrom-Json
if ($live.ContactFlow.Content -notmatch 'transfer-to-voicemail') {
  throw 'Post-deploy verification failed: live content does not contain the new transfer-to-voicemail action.'
}
Write-Host 'Deploy verified: live content now contains the password-reset and voicemail branches.'
