[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Region,
  [Parameter(Mandatory = $true)][string]$ConnectInstanceArn,
  [string]$Profile
)

$ErrorActionPreference = "Stop"
$instanceId = ($ConnectInstanceArn -split "/")[-1]
$awsArgs = @("--region", $Region, "--no-cli-pager")
if ($Profile) { $awsArgs += @("--profile", $Profile) }

function Invoke-Aws {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  & aws @awsArgs @Arguments
  if ($LASTEXITCODE -ne 0) { throw "AWS command failed: aws $($Arguments -join ' ')" }
}

Write-Host "Checking caller identity..."
Invoke-Aws sts get-caller-identity

Write-Host "Checking existing Connect instance..."
Invoke-Aws connect describe-instance --instance-id $instanceId

Write-Host "Listing current integrations (read-only)..."
Invoke-Aws connect list-integration-associations --instance-id $instanceId

Write-Host "Listing Customer Profiles domains (read-only)..."
Invoke-Aws customer-profiles list-domains

Write-Host "Listing Cases domains (read-only)..."
Invoke-Aws connectcases list-domains

Write-Host "Listing Q/Connect AI assistants (read-only)..."
Invoke-Aws qconnect list-assistants

Write-Host "Preflight discovery complete. Save the IDs in deployment-parameters.local.json."
