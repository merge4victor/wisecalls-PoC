[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory = $true)][string]$Region,
  [Parameter(Mandatory = $true)][string]$StackName,
  [string]$Profile,
  [string]$KnowledgePath = (Join-Path (Split-Path -Parent $PSScriptRoot) "knowledge"),
  [switch]$Execute
)

$ErrorActionPreference = "Stop"
$awsBase = @("--region", $Region, "--no-cli-pager")
if ($Profile) { $awsBase += @("--profile", $Profile) }
$knowledgeBaseId = & aws @awsBase cloudformation describe-stacks --stack-name $StackName --query "Stacks[0].Outputs[?OutputKey=='KnowledgeBaseId'].OutputValue | [0]" --output text
if ($LASTEXITCODE -ne 0 -or -not $knowledgeBaseId -or $knowledgeBaseId -eq "None") {
  throw "KnowledgeBaseId is unavailable. Enable knowledge resources in the stack."
}

$candidateFiles = Get-ChildItem -LiteralPath $KnowledgePath -Recurse -File | Where-Object { $_.Extension -in @(".txt", ".md", ".html", ".pdf", ".docx") }
$files = @()
foreach ($candidate in $candidateFiles) {
  $metadataPath = $candidate.FullName + ".metadata.json"
  if (-not (Test-Path -LiteralPath $metadataPath)) {
    Write-Warning "Skipping $($candidate.FullName): metadata sidecar is missing."
    continue
  }
  $metadata = Get-Content -Raw -LiteralPath $metadataPath | ConvertFrom-Json
  if ($metadata.status -ne "APPROVED") {
    Write-Warning "Skipping $($candidate.FullName): status is not APPROVED."
    continue
  }
  $files += $candidate
}
if (-not $Execute) {
  Write-Host "Dry run: would upload $($files.Count) knowledge files to $knowledgeBaseId. Add -Execute to continue."
  $files.FullName
  exit 0
}

foreach ($file in $files) {
  $relativeName = [System.IO.Path]::GetRelativePath($KnowledgePath, $file.FullName).Replace("\", "/")
  $metadata = Get-Content -Raw -LiteralPath ($file.FullName + ".metadata.json") | ConvertFrom-Json
  if ($PSCmdlet.ShouldProcess($relativeName, "Upload to Connect knowledge base")) {
    $contentType = switch ($file.Extension.ToLowerInvariant()) {
      ".html" { "text/html" }
      ".pdf" { "application/pdf" }
      ".docx" { "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }
      default { "text/plain" }
    }
    $upload = & aws @awsBase qconnect start-content-upload --knowledge-base-id $knowledgeBaseId --content-type $contentType | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "Could not start upload for $relativeName." }
    $headers = @{}
    if ($upload.headersToInclude) {
      $upload.headersToInclude.psobject.Properties | ForEach-Object { $headers[$_.Name] = $_.Value }
    }
    Invoke-WebRequest -Method Put -Uri $upload.url -InFile $file.FullName -ContentType $contentType -Headers $headers | Out-Null
    $title = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
    & aws @awsBase qconnect create-content `
      --knowledge-base-id $knowledgeBaseId `
      --name $relativeName `
      --title $title `
      --upload-id $upload.uploadId `
      --metadata "status=$($metadata.status),product=$($metadata.product),jurisdiction=$($metadata.jurisdiction),audience=$($metadata.audience),sourcePath=$relativeName"
    if ($LASTEXITCODE -ne 0) { throw "Could not create content for $relativeName." }
  }
}
Write-Host "Knowledge content uploaded."
