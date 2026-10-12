param(
  [Parameter(Mandatory=$true)][string]$Region,
  [Parameter(Mandatory=$true)][string]$UserPoolId,
  [string]$Email = $env:WISECALLS_OPERATOR_EMAIL,
  [Parameter(Mandatory=$true)][string]$ConnectUserId,
  [string]$Profile,
  [switch]$Execute
)
$ErrorActionPreference = 'Stop'
if (-not $Email) { throw 'Pass -Email or set WISECALLS_OPERATOR_EMAIL.' }
$awsArgs = @('--region', $Region)
if ($Profile) { $awsArgs += @('--profile', $Profile) }

Write-Host "Would create Cognito user '$Email' in pool $UserPoolId with custom:connect_user_id=$ConnectUserId"
if (-not $Execute) {
  Write-Host 'DRY RUN: no AWS changes made. Re-run with -Execute after reviewing the values.'
  exit 0
}

$userAttributes = @(
  "Name=email,Value=$Email",
  "Name=email_verified,Value=true",
  "Name=custom:connect_user_id,Value=$ConnectUserId"
)
$cognitoArgs = @('cognito-idp', 'admin-create-user', '--user-pool-id', $UserPoolId, '--username', $Email, '--user-attributes') + $userAttributes + @('--desired-delivery-mediums', 'EMAIL') + $awsArgs
aws @cognitoArgs
if ($LASTEXITCODE -ne 0) { throw 'admin-create-user failed.' }
Write-Host 'Agent account created. The agent must complete first-login password change and enroll TOTP MFA before their first sign-in to agent-map.'
