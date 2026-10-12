[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)][string]$Region,
  [Parameter(Mandatory = $true)][string]$StackName,
  [string]$Profile,
  [string]$DataPath = (Join-Path (Split-Path -Parent $PSScriptRoot) "config\seed-data.json"),
  [switch]$Execute
)

$ErrorActionPreference = "Stop"
$awsBase = @("--region", $Region, "--no-cli-pager")
if ($Profile) { $awsBase += @("--profile", $Profile) }
$tableName = & aws @awsBase cloudformation describe-stacks --stack-name $StackName --query "Stacks[0].Outputs[?OutputKey=='CoreDataTableName'].OutputValue | [0]" --output text
if ($LASTEXITCODE -ne 0 -or -not $tableName) { throw "Could not resolve CoreDataTableName." }
$items = Get-Content -Raw -LiteralPath $DataPath | ConvertFrom-Json

if (-not $Execute) {
  Write-Host "Dry run: would write $($items.Count) sample items to $tableName. Add -Execute to continue."
  exit 0
}

$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("connect-seed-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
try {
  $index = 0
  foreach ($item in $items) {
    $index++
    $itemPath = Join-Path $temporaryDirectory "item-$index.json"
    $item | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $itemPath
    if ($PSCmdlet.ShouldProcess("$tableName item $index", "Put DynamoDB item")) {
      & aws @awsBase dynamodb put-item --table-name $tableName --item "file://$itemPath" --condition-expression "attribute_not_exists(PK) AND attribute_not_exists(SK)"
      if ($LASTEXITCODE -ne 0) { throw "Failed to seed item $index." }
    }
  }
} finally {
  Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
}
Write-Host "Seed data loaded."
