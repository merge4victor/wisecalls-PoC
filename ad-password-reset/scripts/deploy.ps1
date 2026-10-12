param(
  [Parameter(Mandatory=$true)][string]$StackName,
  [Parameter(Mandatory=$true)][string]$Region,
  [Parameter(Mandatory=$true)][string]$S3Bucket,
  [Parameter(Mandatory=$true)][string]$ParameterFile,
  [string]$Profile,
  [switch]$Execute
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$template = Join-Path $root 'infrastructure\template.yaml'
$packaged = Join-Path $env:TEMP "$StackName-packaged.yaml"
$parameters = Get-Content -Raw -LiteralPath $ParameterFile | ConvertFrom-Json
$overrides = @()
foreach ($item in $parameters) { $overrides += "$($item.ParameterKey)=$($item.ParameterValue)" }
$common = @('--region', $Region)
if ($Profile) { $common += @('--profile', $Profile) }

Write-Host "Stack: $StackName"
Write-Host "Template: $template"
Write-Host "Parameters: $($overrides -join ', ')"
if (-not $Execute) {
  Write-Host 'DRY RUN: no AWS changes made. Re-run with -Execute after reviewing the values.'
  exit 0
}
sam build --template-file $template --build-dir (Join-Path $root '.aws-sam\build')
sam package --template-file (Join-Path $root '.aws-sam\build\template.yaml') --s3-bucket $S3Bucket --output-template-file $packaged @common
aws cloudformation deploy --template-file $packaged --stack-name $StackName --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND --parameter-overrides @overrides @common
aws cloudformation describe-stacks --stack-name $StackName --query 'Stacks[0].Outputs' @common
