[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)][string]$Region,
  [Parameter(Mandatory = $true)][string]$ParametersPath,
  [string]$StackName = "wisecalls-agent-map-dev",
  [string]$Profile,
  [switch]$Execute
)

$ErrorActionPreference = "Stop"
$agentMapRoot = Split-Path -Parent $PSScriptRoot
$frontend = Join-Path $agentMapRoot "frontend"
$parameters = Get-Content -Raw -LiteralPath $ParametersPath | ConvertFrom-Json
$parameterMap = @{}
foreach ($item in $parameters) { $parameterMap[$item.ParameterKey] = $item.ParameterValue }
$awsBase = @("--region", $Region, "--no-cli-pager")
if ($Profile) { $awsBase += @("--profile", $Profile) }

$outputJson = & aws @awsBase cloudformation describe-stacks --stack-name $StackName --query "Stacks[0].Outputs" --output json
if ($LASTEXITCODE -ne 0) { throw "Could not read outputs for $StackName." }
$outputs = @{}
foreach ($item in ($outputJson | ConvertFrom-Json)) { $outputs[$item.OutputKey] = $item.OutputValue }
$requiredOutputs = @("AgentMapApiUrl", "AgentMapBucketName", "AgentMapDistributionId", "AgentMapUrl", "AgentMapApiKeyName")
$missing = $requiredOutputs | Where-Object { -not $outputs.ContainsKey($_) }
if ($missing.Count) { throw "Missing stack outputs: $($missing -join ', ')" }

$keyJson = & aws @awsBase location describe-key --key-name $outputs.AgentMapApiKeyName --output json
if ($LASTEXITCODE -ne 0) { throw "Could not retrieve the restricted Amazon Location map key." }
$mapKey = ($keyJson | ConvertFrom-Json).Key
if ([string]::IsNullOrWhiteSpace($mapKey)) { throw "Amazon Location did not return a key value." }

Write-Host "Frontend: $frontend"
Write-Host "Destination: s3://$($outputs.AgentMapBucketName)"
Write-Host "Agent Workspace URL: $($outputs.AgentMapUrl)"
if (-not $Execute) {
  Write-Host "Dry run only. Add -Execute to build, generate runtime configuration, upload and invalidate CloudFront."
  exit 0
}

Push-Location $frontend
try {
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw "Frontend build failed." }
} finally {
  Pop-Location
}

$publicConfig = [ordered]@{
  apiBaseUrl = $outputs.AgentMapApiUrl
  awsRegion = $Region
  mapApiKey = $mapKey
  mapStyle = "Standard"
  oidc = [ordered]@{
    authorizationEndpoint = $parameterMap.AgentAuthorizationEndpoint
    tokenEndpoint = $parameterMap.AgentTokenEndpoint
    clientId = $parameterMap.AgentOidcAudience
    redirectUri = $outputs.AgentMapUrl
    scopes = @("openid", "profile")
  }
} | ConvertTo-Json -Depth 5 -Compress
$configPath = Join-Path $frontend "dist\config.js"
"window.WISECALLS_AGENT_MAP_CONFIG = Object.freeze($publicConfig);" |
  Set-Content -LiteralPath $configPath -Encoding utf8NoBOM

if ($PSCmdlet.ShouldProcess($outputs.AgentMapBucketName, "Upload agent map and invalidate CloudFront")) {
  & aws @awsBase s3 sync (Join-Path $frontend "dist") "s3://$($outputs.AgentMapBucketName)" --delete --exclude "config.js" --cache-control "public,max-age=86400,immutable"
  if ($LASTEXITCODE -ne 0) { throw "Agent-map upload failed." }
  & aws @awsBase s3 cp $configPath "s3://$($outputs.AgentMapBucketName)/config.js" --content-type "application/javascript; charset=utf-8" --cache-control "no-store,max-age=0"
  if ($LASTEXITCODE -ne 0) { throw "Agent-map runtime configuration upload failed." }
  & aws @awsBase cloudfront create-invalidation --distribution-id $outputs.AgentMapDistributionId --paths "/*" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "CloudFront invalidation failed." }
}
Write-Host "Frontend uploaded: $($outputs.AgentMapUrl)"
