[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Region,
  [Parameter(Mandatory = $true)][string]$ConnectInstanceArn,
  [string]$Profile,
  [string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) "connect-backup")
)

$ErrorActionPreference = "Stop"
$instanceId = ($ConnectInstanceArn -split "/")[-1]
$awsBase = @("--region", $Region, "--no-cli-pager")
if ($Profile) { $awsBase += @("--profile", $Profile) }
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

& aws @awsBase connect list-contact-flows --instance-id $instanceId --output json |
  Set-Content -LiteralPath (Join-Path $OutputDirectory "contact-flows.json")
if ($LASTEXITCODE -ne 0) { throw "Unable to list contact flows." }

$flows = Get-Content -Raw -LiteralPath (Join-Path $OutputDirectory "contact-flows.json") | ConvertFrom-Json
foreach ($flow in $flows.ContactFlowSummaryList) {
  & aws @awsBase connect describe-contact-flow --instance-id $instanceId --contact-flow-id $flow.Id --output json |
    Set-Content -LiteralPath (Join-Path $OutputDirectory ("flow-" + $flow.Id + ".json"))
  if ($LASTEXITCODE -ne 0) { throw "Unable to export flow $($flow.Id)." }
}

& aws @awsBase connect list-integration-associations --instance-id $instanceId --output json |
  Set-Content -LiteralPath (Join-Path $OutputDirectory "integration-associations.json")
Write-Host "Read-only Connect backup written to $OutputDirectory."
