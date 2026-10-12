param(
  [Parameter(Mandatory=$true)][string]$Region,
  [Parameter(Mandatory=$true)][string]$ConnectInstanceArn,
  [Parameter(Mandatory=$true)][string]$Name,
  [Parameter(Mandatory=$true)][string]$ContentFile,
  [string]$Profile,
  [string]$OrgName = $(if ($env:WISECALLS_ORG_NAME) { $env:WISECALLS_ORG_NAME } else { 'Wise Calls Org' }),
  [switch]$Execute
)
$ErrorActionPreference = 'Stop'
if ($OrgName -match '["\\]') { throw 'OrgName must not contain quotes or backslashes; it is inserted into flow JSON.' }
$instanceId = ($ConnectInstanceArn -split '/')[1]
if (-not $instanceId) { throw 'ConnectInstanceArn is invalid.' }
$awsArgs = @('--region', $Region)
if ($Profile) { $awsArgs += @('--profile', $Profile) }

$substituted = (Get-Content -Raw -LiteralPath $ContentFile).Replace('__ORG_NAME__', $OrgName)
if ($substituted -match '__[A-Z_]+__') {
  throw "Unsubstituted placeholder token remains in content: $($Matches[0])"
}
$tempFile = Join-Path $env:TEMP "$Name-substituted.json"
Set-Content -LiteralPath $tempFile -Value $substituted -NoNewline

Write-Host "Would create contact flow '$Name' (type CONTACT_FLOW) from $ContentFile with OrgName '$OrgName'"
if (-not $Execute) {
  Write-Host "DRY RUN: no AWS changes made. Substituted content written to $tempFile. Re-run with -Execute after reviewing it."
  exit 0
}

$result = aws connect create-contact-flow --instance-id $instanceId --name $Name --type CONTACT_FLOW --content "file://$tempFile" --output json @awsArgs | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'create-contact-flow failed.' }
Write-Host "Created flow. ContactFlowId = $($result.ContactFlowId)"
Write-Host "Record this value into infrastructure/template.yaml's CallbackOutboundFlowId parameter default."
