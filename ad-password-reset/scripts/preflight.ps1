param(
  [Parameter(Mandatory=$true)][string]$Region,
  [Parameter(Mandatory=$true)][string]$ConnectInstanceArn,
  [string]$Profile
)
$ErrorActionPreference = 'Stop'
$awsArgs = @('--region', $Region)
if ($Profile) { $awsArgs += @('--profile', $Profile) }
$instanceId = ($ConnectInstanceArn -split '/')[1]
if (-not $instanceId) { throw 'ConnectInstanceArn is invalid.' }
aws sts get-caller-identity @awsArgs
aws connect describe-instance --instance-id $instanceId @awsArgs
aws ds describe-directories @awsArgs
aws sns get-sms-attributes @awsArgs
Write-Host 'Preflight completed. Confirm two private subnets in different Availability Zones and SNS production access before deployment.'
