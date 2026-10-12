# 3. Deployment runbook

## Phase A — prepare parameters

Copy the example without committing the local values:

```powershell
Copy-Item .\infrastructure\parameters.example.json .\deployment-parameters.local.json
```

Replace all placeholders. An example:

```json
[
  { "ParameterKey": "ProjectName", "ParameterValue": "connect-secure-service" },
  { "ParameterKey": "Environment", "ParameterValue": "dev" },
  { "ParameterKey": "ConnectInstanceArn", "ParameterValue": "arn:aws:connect:ap-southeast-2:111122223333:instance/abc" },
  { "ParameterKey": "CasesDomainId", "ParameterValue": "cases-domain-id" },
  { "ParameterKey": "CustomerProfilesDomainName", "ParameterValue": "profiles-domain" },
  { "ParameterKey": "ApprovedWebOrigin", "ParameterValue": "https://service.example.com.au" },
  { "ParameterKey": "CognitoDomainPrefix", "ParameterValue": "company-connect-auth-dev-unique" },
  { "ParameterKey": "CognitoCallbackUrls", "ParameterValue": "https://service.example.com.au/auth/callback" },
  { "ParameterKey": "CognitoLogoutUrls", "ParameterValue": "https://service.example.com.au/" },
  { "ParameterKey": "AgentCognitoDomainPrefix", "ParameterValue": "company-agent-auth-dev-unique" },
  { "ParameterKey": "AgentCognitoCallbackUrls", "ParameterValue": "https://localhost/" },
  { "ParameterKey": "AgentCognitoLogoutUrls", "ParameterValue": "https://localhost/" },
  { "ParameterKey": "LocationWebBaseUrl", "ParameterValue": "https://service.example.com.au/location" },
  { "ParameterKey": "LocationSessionTtlHours", "ParameterValue": "1" },
  { "ParameterKey": "CurrentLocationTtlMinutes", "ParameterValue": "15" },
  { "ParameterKey": "EnableKnowledgeResources", "ParameterValue": "true" },
  { "ParameterKey": "EnableLocationFrontend", "ParameterValue": "true" }
]
```

For a first infrastructure-only deployment, `CasesDomainId` may be empty. Update the stack after Cases is enabled.

`AgentCognitoDomainPrefix` provisions the separate `agent-map` identity pool's managed-login domain and must be globally unique and different from `CognitoDomainPrefix`. `AgentCognitoCallbackUrls`/`AgentCognitoLogoutUrls` cannot hold real values yet: `agent-map` is a separate, not-yet-deployed add-on, so its CloudFront URL does not exist at the time this stack is first deployed. Use the `https://localhost/` placeholder shown above and update the stack with the real URL once `agent-map`'s own frontend is deployed (see `docs/superpowers/plans/2026-08-03-agent-map-identity-bridge.md`, Task 4 Step 1, for the documented bootstrapping sequence).

`CallbackAllowedPhonePrefixes` controls who may book a scheduled callback on option 7. It holds comma-separated E.164 prefixes; a full-length entry such as `+61491570156` is an exact match, and `+614` widens the feature to every Australian mobile. An empty value denies all bookings, so the allowlist fails closed. Changing this value takes effect through a stack update alone — but only for widening. Narrowing the allowlist only stops *new* bookings: `callback-poller` never re-checks the allowlist, so any row already `PENDING` in `CallbackBookingTable` under the wider value will still be dialled, and `record-callback-outcome` can revert an unanswered attempt back to `PENDING` for one retry, so a stale row can be dialled twice. For a narrowing to take effect immediately, delete those rows manually; the stack update alone does not do it. When applying both deployment steps below, apply the stack update first, so the control is live for the whole window — applying the flow update first is harmless but leaves a gap, since the flow change is a no-op against the old Lambda. Introducing the allowlist for the first time also requires republishing `wisecalls-voice-v1-dev` with `scripts/deploy-connect-flow.ps1`, because a blocked caller is routed by the `check-book-blocked` flow action; applying only the stack update leaves those callers looping through the day's remaining slots, and applying only the flow update leaves the allowlist unenforced. Before any demo, query `CallbackBookingTable`'s `StatusIndex` for `PENDING` rows and clear any belonging to numbers outside the current allowlist — that is the only remaining path to a billed outbound call to a non-allowlisted number. See `docs/superpowers/specs/2026-08-08-callback-phone-allowlist-design.md`.

## Phase B — local validation

```powershell
node .\scripts\validate.mjs
```

The validator:

- checks required files;
- parses JSON configuration;
- checks Lambda JavaScript syntax;
- runs the unit tests;
- checks critical template markers.

Perform CloudFormation validation after packaging because the source template contains local Lambda paths.

## Phase C — review a dry run

```powershell
.\scripts\deploy.ps1 `
  -Region ap-southeast-2 `
  -ArtifactBucket YOUR-CONTROLLED-CFN-ARTIFACT-BUCKET `
  -ParametersPath .\deployment-parameters.local.json `
  -StackName connect-secure-service-dev `
  -Profile YOUR_PROFILE
```

The script is dry-run by default.

## Phase D — package and deploy

Use a dedicated, encrypted deployment bucket. The script can create and public-block a new bucket, but an organisation-managed bucket is preferable.

```powershell
.\scripts\deploy.ps1 `
  -Region ap-southeast-2 `
  -ArtifactBucket YOUR-CONTROLLED-CFN-ARTIFACT-BUCKET `
  -ParametersPath .\deployment-parameters.local.json `
  -StackName connect-secure-service-dev `
  -Profile YOUR_PROFILE `
  -Execute `
  -WhatIf
```

Review the `-WhatIf` output. Then remove `-WhatIf`:

```powershell
.\scripts\deploy.ps1 `
  -Region ap-southeast-2 `
  -ArtifactBucket YOUR-CONTROLLED-CFN-ARTIFACT-BUCKET `
  -ParametersPath .\deployment-parameters.local.json `
  -StackName connect-secure-service-dev `
  -Profile YOUR_PROFILE `
  -Execute
```

The outputs are written to `stack-outputs.json`.

## Phase E — validate the stack

```powershell
aws cloudformation describe-stacks `
  --stack-name connect-secure-service-dev `
  --region ap-southeast-2 `
  --query "Stacks[0].{Status:StackStatus,Outputs:Outputs}"

aws connect list-integration-associations `
  --instance-id INSTANCE_ID `
  --region ap-southeast-2
```

Confirm:

- stack status is `CREATE_COMPLETE` or `UPDATE_COMPLETE`;
- KMS rotation is enabled;
- all three DynamoDB tables have PITR;
- Cognito deletion protection is active;
- location API requires a valid Cognito JWT;
- Lambda invocation permissions are scoped to the intended Connect instance;
- only new integration associations were added.

## Phase F — deploy the location frontend

With `EnableLocationFrontend=true`, the stack creates the private frontend S3
bucket and HTTPS CloudFront distribution. Upload the static files only after
the stack completes:

```powershell
.\scripts\deploy-frontend.ps1 `
  -Region ap-southeast-2 `
  -StackName connect-secure-service-dev `
  -Profile YOUR_PROFILE `
  -Execute
```

Follow [Location frontend](10-location-frontend.md) to create a test Cognito
customer, enrol MFA and perform browser/API acceptance tests.

## Phase G — load non-production reference data

The supplied seed data is deliberately unusable for customers. Replace every `REPLACE_BEFORE_USE`, `DEMO` and `DRAFT` value before loading.

Dry run:

```powershell
.\scripts\seed-data.ps1 `
  -Region ap-southeast-2 `
  -StackName connect-secure-service-dev `
  -Profile YOUR_PROFILE
```

Execute:

```powershell
.\scripts\seed-data.ps1 `
  -Region ap-southeast-2 `
  -StackName connect-secure-service-dev `
  -Profile YOUR_PROFILE `
  -Execute
```

## Phase H — load approved knowledge

Replace the sample articles with approved content. Dry-run the upload:

```powershell
.\scripts\upload-knowledge.ps1 `
  -Region ap-southeast-2 `
  -StackName connect-secure-service-dev `
  -Profile YOUR_PROFILE
```

Upload:

```powershell
.\scripts\upload-knowledge.ps1 `
  -Region ap-southeast-2 `
  -StackName connect-secure-service-dev `
  -Profile YOUR_PROFILE `
  -Execute
```

Verify every article is searchable and displays the expected citation before attaching it to production agents.

## Phase I — configure Connect

Complete [Connect configuration](04-connect-configuration.md). Create new flows with names ending in `-v1-dev`; never edit the production inbound flow directly.

## Phase J — promote

Promote in this order:

1. isolated development number/widget;
2. internal staff pilot;
3. non-production acceptance;
4. limited production queue or percentage;
5. full cutover.

Keep the previous production flow ID and export until the observation period closes.
