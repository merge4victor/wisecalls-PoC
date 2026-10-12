[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)][string]$Region,
  [Parameter(Mandatory = $true)][string]$ArtifactBucket,
  [Parameter(Mandatory = $true)][string]$ParametersPath,
  [string]$StackName = "wisecalls-agent-map-dev",
  [string]$Profile,
  [switch]$Execute,
  [switch]$WhatIf
)

$ErrorActionPreference = "Stop"
$agentMapRoot = Split-Path -Parent $PSScriptRoot
$template = Join-Path $agentMapRoot "infrastructure\template.yaml"
$packaged = Join-Path $agentMapRoot "packaged-template.yaml"
$parameters = Get-Content -Raw -LiteralPath $ParametersPath | ConvertFrom-Json
$overrides = @($parameters | ForEach-Object { "$($_.ParameterKey)=$($_.ParameterValue)" })
$displayOverrides = @($parameters | ForEach-Object {
  if ($_.ParameterKey -match "Audience|Secret|Token") { "$($_.ParameterKey)=***" } else { "$($_.ParameterKey)=$($_.ParameterValue)" }
})
$awsBase = @("--region", $Region, "--no-cli-pager")
if ($Profile) { $awsBase += @("--profile", $Profile) }

Write-Host "Stack: $StackName"
Write-Host "Region: $Region"
Write-Host "Template: $template"
Write-Host "Parameters: $($displayOverrides -join ', ')"
if (-not $Execute) {
  Write-Host "Dry run only. Add -Execute; optionally add -WhatIf to create but not execute the change set."
  exit 0
}

if ($PSCmdlet.ShouldProcess($StackName, "Package and prepare the agent-map CloudFormation stack")) {
  Push-Location (Split-Path -Parent $template)
  try {
    & aws @awsBase cloudformation package `
      --template-file (Split-Path -Leaf $template) `
      --s3-bucket $ArtifactBucket `
      --s3-prefix "$StackName/artifacts" `
      --output-template-file $packaged
    if ($LASTEXITCODE -ne 0) { throw "CloudFormation package failed." }
  } finally {
    Pop-Location
  }

  $deployArgs = @(
    "cloudformation", "deploy",
    "--template-file", $packaged,
    "--stack-name", $StackName,
    "--capabilities", "CAPABILITY_IAM", "CAPABILITY_AUTO_EXPAND",
    "--no-fail-on-empty-changeset",
    "--parameter-overrides"
  ) + $overrides
  if ($WhatIf) { $deployArgs += "--no-execute-changeset" }
  & aws @awsBase @deployArgs
  if ($LASTEXITCODE -ne 0) { throw "CloudFormation deploy/change-set creation failed." }

  if ($WhatIf) {
    Write-Host "Change set created but not executed. Review it in CloudFormation before deployment."
    exit 0
  }
  & aws @awsBase cloudformation describe-stacks --stack-name $StackName --query "Stacks[0].Outputs" --output json |
    Set-Content -LiteralPath (Join-Path $agentMapRoot "stack-outputs.json") -Encoding utf8NoBOM
  Write-Host "Agent-map infrastructure deployed. Next run deploy-frontend.ps1."
}
