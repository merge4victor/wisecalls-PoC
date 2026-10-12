# Agent customer-location map deployment

## 1. Security model

The application receives only the active `contactId` from the Amazon Connect Agent Workspace SDK. Its backend independently:

1. validates the agent JWT at API Gateway;
2. reads the Connect user ID from the configured JWT claim;
3. calls `DescribeContact` and confirms that user is the assigned agent;
4. reads the verified `customerId` from the contact’s server-side attributes;
5. returns only a non-expired item from the existing current-location table;
6. records agent/contact/time/outcome in the audit table without coordinates.

The customer’s home address remains in the core profile table. It is not returned by this app.

## 2. Prerequisites and operator inputs

- AWS CLI, SAM CLI, Python 3.13-compatible tooling, Node.js 22+ and npm.
- Existing WiseCalls core stack outputs: `CurrentLocationTableName`, `ToolAuditTableName`.
- Existing Amazon Connect instance ARN and ID in the same account and Region.
- Encrypted deployment-artifact S3 bucket.
- An **agent** OIDC public client with authorization-code + PKCE. Prefer the same identity provider used by Connect for SSO. Do not use the customer user pool.
- A stable JWT claim such as `connect_user_id` whose value is the Connect user ID or full agent ARN.
- The IdP must allow the final `AgentMapUrl` as an exact callback URL. Its token endpoint must support calls from the CloudFront origin for this browser-based PKCE implementation.
- The contact flow must populate the `customerId` user-defined contact attribute only after the customer has been verified.

Create the local parameter file:

```powershell
Copy-Item .\infrastructure\parameters.example.json .\deployment-parameters.local.json
```

Replace every placeholder. Keep the local file out of version control.

## 3. Validate locally

From `agent-map`:

```powershell
.\scripts\validate.ps1
```

If SAM CLI is absent the script reports that template lint was skipped. Claude must install/use SAM CLI and run the lint before deployment.

## 4. Review and deploy the stack

Print the planned inputs without making AWS changes:

```powershell
.\scripts\deploy-stack.ps1 `
  -Region ap-southeast-2 `
  -ArtifactBucket REPLACE_ENCRYPTED_ARTIFACT_BUCKET `
  -ParametersPath .\deployment-parameters.local.json
```

Create an unexecuted change set:

```powershell
.\scripts\deploy-stack.ps1 `
  -Region ap-southeast-2 `
  -ArtifactBucket REPLACE_ENCRYPTED_ARTIFACT_BUCKET `
  -ParametersPath .\deployment-parameters.local.json `
  -Execute -WhatIf
```

Review IAM, AppIntegrations, Connect association, S3, CloudFront, API Gateway, Lambda and Amazon Location changes. Execute only after approval. If the unexecuted change set is not executed in the console, delete it and rerun with `-Execute` without `-WhatIf`.

## 5. Finish IdP configuration

Read the `AgentMapUrl` output. Add that exact URL, including the trailing slash, to the agent OIDC client’s allowed callbacks and logout URLs.

Map a non-editable agent identity attribute to the access-token claim configured as `AgentIdClaim`. It must equal either:

- the assigned Connect user ID; or
- the full Connect agent ARN ending in `/agent/<ConnectUserId>`.

The access token’s `iss` and `aud` must exactly match `AgentOidcIssuer` and `AgentOidcAudience`. Require MFA through the enterprise IdP. Do not put identity mapping in browser configuration.

## 6. Build and upload the frontend

Dry run:

```powershell
.\scripts\deploy-frontend.ps1 `
  -Region ap-southeast-2 `
  -ParametersPath .\deployment-parameters.local.json
```

Reviewed upload:

```powershell
.\scripts\deploy-frontend.ps1 `
  -Region ap-southeast-2 `
  -ParametersPath .\deployment-parameters.local.json `
  -Execute
```

The script installs the exact dependency versions declared in `package.json`, creates a production build, retrieves the referrer-restricted map-key value, creates `dist/config.js`, syncs the private S3 bucket and invalidates CloudFront. Commit the generated lock file after the first successful trusted build. The key is intentionally available to the browser but authorises only Amazon Location map reads from this exact CloudFront origin.

## 7. Configure Amazon Connect safely

The CloudFormation stack creates and associates the contact-scoped application named **WiseCalls Customer Location** with namespace `wisecalls.agent-map`.

1. Open Amazon Connect administration → Users → Security profiles.
2. Create or select a test-agent security profile.
3. Under Agent applications, grant `ACCESS`/View only for `wisecalls.agent-map`.
4. Do not grant supervisors or broad agent groups until acceptance testing and privacy approval pass.
5. Open the default Agent Workspace (`/agent-app-v2`) and select the app from the launcher while a test contact is active.

In a new version of each applicable flow, after successful authentication only, set:

```text
customerId = <verified customer ID from the trusted lookup Lambda>
```

Never set coordinates, home address, access tokens or unverified customer identifiers as contact attributes.

## 8. Acceptance tests

Run all tests with synthetic customers and test agents:

| Test | Expected result |
|---|---|
| App opened with no selected contact | No map; instruction to select an active contact |
| Agent JWT missing/expired | Sign-in shown or API returns 401; no location |
| JWT lacks mapped Connect ID | 403 `AGENT_IDENTITY_NOT_MAPPED` |
| Agent opens another agent’s contact ID | 403 `CONTACT_NOT_ASSIGNED`; audit denial |
| Contact has no verified `customerId` | 404 `CUSTOMER_NOT_LINKED` |
| Location expired or absent | 404 `LOCATION_NOT_AVAILABLE` |
| Current location is present | Marker, accuracy circle, observation age and approximate wording shown |
| Low-accuracy GPS | No nearby-landmark claim; low-accuracy/locality wording shown |
| Contact closes | Iframe is destroyed, map is removed and token is cleared |
| Raw-coordinate log search | No raw latitude/longitude in Lambda or frontend logs |
| Map key used from a different Referer | Amazon Location rejects the request |
| Security profile without app access | App does not appear in its launcher |

Verify that the audit item contains agent ID, contact ID, hashed customer reference, outcome and time—but no raw coordinates.

## 9. Operational guardrails

- Default location TTL remains 15 minutes in the core stack.
- Refresh is limited to once per minute in the agent app.
- The map displays an accuracy circle and never presents GPS as exact.
- Location is not identity evidence and is not sent to generative AI.
- Agents must not copy location into free-text case comments unless an approved operational procedure requires it.
- Define a break-glass/emergency workflow separately; this PoC is not an emergency location system.
- Review CloudTrail, API access logs and application audit events without enabling request-body logging.
- Rotate the Amazon Location key under change control even though it has a referrer restriction.

## 10. Rollback

1. Remove `wisecalls.agent-map` access from all security profiles immediately.
2. Disassociate the application from the Connect instance if required.
3. Disable the CloudFront distribution or deploy a maintenance page.
4. Roll back the new contact-flow version that sets the verified `customerId` attribute only if that attribute is no longer used elsewhere.
5. Delete the add-on stack only after reviewing retained S3 versions and confirming the core current-location and audit tables are external resources and will not be deleted.

The add-on has read/write permissions to existing core tables but does not own them.
