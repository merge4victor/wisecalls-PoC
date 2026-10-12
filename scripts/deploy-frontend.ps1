[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)][string]$Region,
  [string]$StackName = "connect-secure-service-dev",
  [string]$Profile,
  [switch]$Execute
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root "frontend"
$awsBase = @("--region", $Region, "--no-cli-pager")
if ($Profile) { $awsBase += @("--profile", $Profile) }

$outputJson = & aws @awsBase cloudformation describe-stacks `
  --stack-name $StackName `
  --query "Stacks[0].Outputs" `
  --output json
if ($LASTEXITCODE -ne 0) { throw "Could not read CloudFormation outputs for $StackName." }

$outputs = @{}
foreach ($item in ($outputJson | ConvertFrom-Json)) {
  $outputs[$item.OutputKey] = $item.OutputValue
}

$required = @(
  "LocationFrontendBucketName",
  "LocationFrontendDistributionId",
  "LocationFrontendUrl",
  "CustomerUserPoolClientId",
  "CognitoManagedLoginDomain",
  "LocationApiUrl",
  "CurrentMobileLocationApiUrl",
  "ServicePhoneNumberE164",
  "ServicePhoneNumberDisplay",
  "SecondaryServicePhoneNumberE164",
  "SecondaryServicePhoneNumberDisplay"
)
$missing = $required | Where-Object { -not $outputs.ContainsKey($_) -or [string]::IsNullOrWhiteSpace($outputs[$_]) }
if ($missing.Count -gt 0) {
  throw "Missing frontend stack outputs: $($missing -join ', '). Deploy with EnableLocationFrontend=true first."
}

Write-Host "Frontend source: $source"
Write-Host "S3 destination: s3://$($outputs.LocationFrontendBucketName)"
Write-Host "HTTPS URL: $($outputs.LocationFrontendUrl)"
Write-Host "CloudFront distribution: $($outputs.LocationFrontendDistributionId)"
if (-not $Execute) {
  Write-Host "Dry run only. Add -Execute to generate public configuration, upload files and invalidate CloudFront."
  exit 0
}

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) "wisecalls-frontend-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
try {
  Copy-Item -Path (Join-Path $source "*") -Destination $temporaryRoot -Recurse
  Remove-Item -LiteralPath (Join-Path $temporaryRoot "config.example.js") -ErrorAction SilentlyContinue

  $publicConfig = [ordered]@{
    cognitoDomain = $outputs.CognitoManagedLoginDomain
    clientId = $outputs.CustomerUserPoolClientId
    locationApiUrl = $outputs.LocationApiUrl
    currentLocationApiUrl = $outputs.CurrentMobileLocationApiUrl
    servicePhoneNumbers = @(
      [ordered]@{
        id = "line-03"
        label = "03 service line"
        e164 = $outputs.ServicePhoneNumberE164
        display = $outputs.ServicePhoneNumberDisplay
      },
      [ordered]@{
        id = "line-02"
        label = "02 service line"
        e164 = $outputs.SecondaryServicePhoneNumberE164
        display = $outputs.SecondaryServicePhoneNumberDisplay
      }
    )
  } | ConvertTo-Json -Compress
  $configFile = Join-Path $temporaryRoot "config.js"
  "window.WISECALLS_CONFIG = Object.freeze($publicConfig);" | Set-Content -LiteralPath $configFile -Encoding utf8NoBOM

  if ($PSCmdlet.ShouldProcess($outputs.LocationFrontendBucketName, "Upload static frontend and remove stale objects")) {
    & aws @awsBase s3 sync $temporaryRoot "s3://$($outputs.LocationFrontendBucketName)" `
      --delete `
      --exclude "config.js" `
      --cache-control "public,max-age=86400"
    if ($LASTEXITCODE -ne 0) { throw "Frontend asset upload failed." }

    & aws @awsBase s3 cp $configFile "s3://$($outputs.LocationFrontendBucketName)/config.js" `
      --content-type "application/javascript; charset=utf-8" `
      --cache-control "no-store,max-age=0"
    if ($LASTEXITCODE -ne 0) { throw "Frontend configuration upload failed." }

    & aws @awsBase cloudfront create-invalidation `
      --distribution-id $outputs.LocationFrontendDistributionId `
      --paths "/*" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "CloudFront invalidation failed." }
  }
} finally {
  if (Test-Path -LiteralPath $temporaryRoot) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
}

Write-Host "Frontend deployed: $($outputs.LocationFrontendUrl)"
