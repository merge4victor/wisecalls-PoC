[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)][string]$Region,
  [Parameter(Mandatory = $true)][string]$ArtifactBucket,
  [Parameter(Mandatory = $true)][string]$ParametersPath,
  [string]$StackName = "connect-secure-service-dev",
  [string]$Profile,
  [switch]$CreateArtifactBucket,
  [switch]$Execute
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$template = Join-Path $root "infrastructure\template.yaml"
$packaged = Join-Path $root "packaged-template.yaml"
$parameters = Get-Content -Raw -LiteralPath $ParametersPath | ConvertFrom-Json
$overrides = @()
foreach ($parameter in $parameters) {
  $value = $parameter.ParameterValue
  if ($parameter.ParameterKey -eq "CallbackAllowedPhonePrefixes" -and -not $value -and $env:WISECALLS_OPERATOR_PHONE) {
    $value = $env:WISECALLS_OPERATOR_PHONE
  }
  $overrides += "$($parameter.ParameterKey)=$value"
}
$awsBase = @("--region", $Region, "--no-cli-pager")
if ($Profile) { $awsBase += @("--profile", $Profile) }

if (-not $Execute) {
  Write-Host "Dry run only. Add -Execute to package and deploy."
  Write-Host "Stack: $StackName"
  Write-Host "Region: $Region"
  Write-Host "Artifact bucket: $ArtifactBucket"
  Write-Host "Parameters: $($overrides -join ', ')"
  exit 0
}

if ($CreateArtifactBucket) {
  & aws @awsBase s3api head-bucket --bucket $ArtifactBucket 2>$null
  if ($LASTEXITCODE -ne 0) {
    if ($Region -eq "us-east-1") {
      & aws @awsBase s3api create-bucket --bucket $ArtifactBucket
    } else {
      & aws @awsBase s3api create-bucket --bucket $ArtifactBucket --create-bucket-configuration "LocationConstraint=$Region"
    }
    if ($LASTEXITCODE -ne 0) { throw "Could not create artifact bucket." }
    & aws @awsBase s3api put-public-access-block --bucket $ArtifactBucket --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
    if ($LASTEXITCODE -ne 0) { throw "Could not secure artifact bucket." }
  }
}

if ($PSCmdlet.ShouldProcess($StackName, "Package and deploy CloudFormation stack")) {
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

  & aws @awsBase cloudformation deploy `
    --template-file $packaged `
    --stack-name $StackName `
    --s3-bucket $ArtifactBucket `
    --s3-prefix "$StackName/artifacts" `
    --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND `
    --no-fail-on-empty-changeset `
    --parameter-overrides @overrides
  if ($LASTEXITCODE -ne 0) { throw "CloudFormation deploy failed." }

  & aws @awsBase cloudformation describe-stacks `
    --stack-name $StackName `
    --query "Stacks[0].Outputs" `
    --output json |
    Set-Content -LiteralPath (Join-Path $root "stack-outputs.json")
  Write-Host "Deployment complete. Outputs written to stack-outputs.json."
}
