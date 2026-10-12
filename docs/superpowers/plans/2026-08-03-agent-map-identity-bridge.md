# agent-map Identity Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated Cognito user pool (`wisecalls-dev-agents`) to the root SAM stack that gives `agent-map` a working OIDC issuer/PKCE client, producing the four parameter values `agent-map/infrastructure/parameters.example.json` expects (`AgentOidcIssuer`, `AgentOidcAudience`, `AgentAuthorizationEndpoint`, `AgentTokenEndpoint`) plus the `AgentIdClaim` name.

**Architecture:** A new `AWS::Cognito::UserPool` + `UserPoolClient` + `UserPoolDomain` trio added to `infrastructure/template.yaml`, mirroring the existing `CustomerUserPool` resources byte-for-byte in style (same MFA type, same password policy, same OAuth flow shape) but with its own pool, its own custom attribute (`custom:connect_user_id` instead of `custom:customer_id`), and its own Hosted UI domain — kept structurally separate from the customer pool per the spec's explicit rule. A small provisioning script wraps `admin-create-user` for the documented manual agent-onboarding runbook.

**Tech Stack:** AWS SAM/CloudFormation (same template as the rest of this repo's core stack), PowerShell for the provisioning script, no new Lambda code.

## Global Constraints

- This work happens on a **fresh git worktree/branch off `master`**, not on `worktree-scheduled-callback` — the two features are unrelated. Use `superpowers:using-git-worktrees` to set this up before Task 1.
- Account `111122223333`, region `ap-southeast-2`, profile `default` for every AWS CLI call.
- Mirror the existing `CustomerUserPool` resource (`infrastructure/template.yaml:370-445`) exactly in structure — same `MfaConfiguration: "ON"` / `EnabledMfas: [SOFTWARE_TOKEN_MFA]` (TOTP, per the spec), same `UserPoolTier: ESSENTIALS`, same `PasswordPolicy`, same `AllowedOAuthFlows: [code]` (Authorization Code Grant — PKCE-compatible, no client secret). Deviate only where the spec requires it (pool name, custom attribute name, domain prefix).
- Never reuse `CustomerUserPool` or its client/domain for agents — this is the spec's explicit, load-bearing constraint.
- The new pool's resources produce CloudFormation Outputs named to match `agent-map`'s own parameter names exactly (`AgentOidcIssuer`, `AgentOidcAudience`, `AgentAuthorizationEndpoint`, `AgentTokenEndpoint`) so the handoff to `agent-map`'s deployment is a direct copy, not a translation.
- Deploying `agent-map` itself is out of scope for this plan — stop once the four output values exist and are verified.

---

### Task 1: Add the Cognito agent pool to `infrastructure/template.yaml`

**Files:**
- Modify: `infrastructure/template.yaml`

**Interfaces:**
- Produces: CloudFormation resources `AgentUserPool`, `AgentUserPoolClient`, `AgentUserPoolDomain`; parameters `AgentCognitoDomainPrefix`, `AgentCognitoCallbackUrls`, `AgentCognitoLogoutUrls`; outputs `AgentUserPoolId`, `AgentUserPoolClientId`, `AgentCognitoManagedLoginDomain`, `AgentOidcIssuer`, `AgentOidcAudience`, `AgentAuthorizationEndpoint`, `AgentTokenEndpoint`.

- [ ] **Step 1: Add three new parameters**

In `infrastructure/template.yaml`'s `Parameters:` section, add immediately after the existing `CognitoLogoutUrls` parameter (search for `CognitoLogoutUrls:`):

```yaml
  AgentCognitoDomainPrefix:
    Type: String
    Description: Globally unique lowercase prefix for the agent Cognito managed-login domain. Must differ from CognitoDomainPrefix.
    AllowedPattern: "^[a-z0-9][a-z0-9-]{2,62}$"
  AgentCognitoCallbackUrls:
    Type: CommaDelimitedList
    Description: HTTPS callback URLs for agent-map authentication. Update this after agent-map's own CloudFront distribution exists (see agent-map/docs/deployment.md step 5) — an initial placeholder value is expected on first deploy.
  AgentCognitoLogoutUrls:
    Type: CommaDelimitedList
    Description: HTTPS logout URLs for agent-map authentication. Same bootstrapping note as AgentCognitoCallbackUrls.
```

- [ ] **Step 2: Add the three Cognito resources**

In `infrastructure/template.yaml`'s `Resources:` section, add immediately after the existing `CustomerUserPoolDomain` resource (search for `CustomerUserPoolDomain:`, the block ends right before `LocationApi:`):

```yaml
  AgentUserPool:
    Type: AWS::Cognito::UserPool
    DeletionPolicy: Retain
    UpdateReplacePolicy: Retain
    Properties:
      UserPoolName: !Sub "${ProjectName}-${Environment}-agents"
      DeletionProtection: ACTIVE
      MfaConfiguration: "ON"
      EnabledMfas: [SOFTWARE_TOKEN_MFA]
      UserPoolTier: ESSENTIALS
      UsernameAttributes: [email]
      AutoVerifiedAttributes: [email]
      AccountRecoverySetting:
        RecoveryMechanisms:
          - Name: verified_email
            Priority: 1
      Policies:
        PasswordPolicy:
          MinimumLength: 14
          RequireLowercase: true
          RequireNumbers: true
          RequireSymbols: true
          RequireUppercase: true
          TemporaryPasswordValidityDays: 1
      UserAttributeUpdateSettings:
        AttributesRequireVerificationBeforeUpdate: [email]
      Schema:
        - Name: connect_user_id
          AttributeDataType: String
          Mutable: false
          Required: false
          StringAttributeConstraints:
            MinLength: "6"
            MaxLength: "256"

  AgentUserPoolClient:
    Type: AWS::Cognito::UserPoolClient
    Properties:
      UserPoolId: !Ref AgentUserPool
      ClientName: !Sub "${ProjectName}-${Environment}-agent-map"
      GenerateSecret: false
      AllowedOAuthFlowsUserPoolClient: true
      AllowedOAuthFlows: [code]
      AllowedOAuthScopes: [openid, email, profile]
      CallbackURLs: !Ref AgentCognitoCallbackUrls
      LogoutURLs: !Ref AgentCognitoLogoutUrls
      SupportedIdentityProviders: [COGNITO]
      EnableTokenRevocation: true
      PreventUserExistenceErrors: ENABLED
      AccessTokenValidity: 15
      IdTokenValidity: 15
      RefreshTokenValidity: 1
      TokenValidityUnits:
        AccessToken: minutes
        IdToken: minutes
        RefreshToken: days

  AgentUserPoolDomain:
    Type: AWS::Cognito::UserPoolDomain
    Properties:
      Domain: !Ref AgentCognitoDomainPrefix
      UserPoolId: !Ref AgentUserPool
```

Note: `connect_user_id`'s `MaxLength: "256"` (wider than `customer_id`'s `128`) because `AgentIdClaim` may hold either a bare Connect user ID (a 36-character UUID) or the full agent ARN (`arn:aws:connect:ap-southeast-2:111122223333:instance/<instance-id>/agent/<user-id>`, well over 100 characters) — the schema must accommodate the longer form.

- [ ] **Step 3: Add the six outputs**

In `infrastructure/template.yaml`'s `Outputs:` section, add immediately after the existing `CognitoManagedLoginDomain` output (search for `CognitoManagedLoginDomain:`):

```yaml
  AgentUserPoolId:
    Value: !Ref AgentUserPool
  AgentUserPoolClientId:
    Value: !Ref AgentUserPoolClient
  AgentCognitoManagedLoginDomain:
    Value: !Sub "https://${AgentCognitoDomainPrefix}.auth.${AWS::Region}.amazoncognito.com"
  AgentOidcIssuer:
    Value: !Sub "https://cognito-idp.${AWS::Region}.amazonaws.com/${AgentUserPool}"
  AgentOidcAudience:
    Value: !Ref AgentUserPoolClient
  AgentAuthorizationEndpoint:
    Value: !Sub "https://${AgentCognitoDomainPrefix}.auth.${AWS::Region}.amazoncognito.com/oauth2/authorize"
  AgentTokenEndpoint:
    Value: !Sub "https://${AgentCognitoDomainPrefix}.auth.${AWS::Region}.amazoncognito.com/oauth2/token"
```

These four output names (`AgentOidcIssuer`, `AgentOidcAudience`, `AgentAuthorizationEndpoint`, `AgentTokenEndpoint`) are deliberately identical to the parameter names `agent-map/infrastructure/parameters.example.json` expects — Task 4's verification step confirms this mapping is exact.

- [ ] **Step 4: Validate the template**

```powershell
$env:PATH += ";C:\Program Files\Amazon\AWSSAMCLI\bin"
sam validate --lint --template-file infrastructure\template.yaml --region ap-southeast-2 --profile default
```
Expected: `infrastructure\template.yaml is a valid SAM Template` (or only pre-existing warnings unrelated to this change).

- [ ] **Step 5: Commit**

No further steps here beyond a plain commit — this repository does not skip commits (unlike the scheduled-callback worktree at an earlier point in this project's history, this is a fresh branch with normal git available).

```bash
git add infrastructure/template.yaml
git commit -m "Add dedicated Cognito user pool for agent-map identity bridge"
```

---

### Task 2: Register the new resource in local validation

**Files:**
- Modify: `scripts/validate.mjs`

**Interfaces:**
- Consumes: none new.
- Produces: none new (this task only strengthens an existing check).

- [ ] **Step 1: Add a marker check**

In `scripts/validate.mjs`, find the `for (const marker of [...])` loop checking `infrastructure/template.yaml` for required resource markers (search for `"KnowledgeAssistant:"`). Add `"AgentUserPool:"` to that array:

```javascript
for (const marker of ["ConnectInstanceArn:", "CustomerUserPool:", "CoreDataTable:", "KnowledgeAssistant:", "LocationFrontendDistribution:", "AgentUserPool:"]) {
```

- [ ] **Step 2: Run validation**

```powershell
node scripts/validate.mjs
```
Expected: `Local validation passed.`

- [ ] **Step 3: Commit**

```bash
git add scripts/validate.mjs
git commit -m "Register AgentUserPool marker in local validation"
```

---

### Task 3: Agent provisioning script

**Files:**
- Create: `scripts/provision-agent.ps1`

**Interfaces:**
- Consumes: `AgentUserPoolId` (Task 1's output, passed as a CLI parameter — this script does not read stack outputs itself, the operator supplies the pool ID directly, matching the manual/documented provisioning decision in the spec).
- Produces: a real Cognito user, only when run with `-Execute`.

- [ ] **Step 1: Write the script**

Create `scripts/provision-agent.ps1`:

```powershell
param(
  [Parameter(Mandatory=$true)][string]$Region,
  [Parameter(Mandatory=$true)][string]$UserPoolId,
  [Parameter(Mandatory=$true)][string]$Email,
  [Parameter(Mandatory=$true)][string]$ConnectUserId,
  [string]$Profile,
  [switch]$Execute
)
$ErrorActionPreference = 'Stop'
$awsArgs = @('--region', $Region)
if ($Profile) { $awsArgs += @('--profile', $Profile) }

Write-Host "Would create Cognito user '$Email' in pool $UserPoolId with custom:connect_user_id=$ConnectUserId"
if (-not $Execute) {
  Write-Host 'DRY RUN: no AWS changes made. Re-run with -Execute after reviewing the values.'
  exit 0
}

aws cognito-idp admin-create-user `
  --user-pool-id $UserPoolId `
  --username $Email `
  --user-attributes Name=email,Value=$Email Name=email_verified,Value=true "Name=custom:connect_user_id,Value=$ConnectUserId" `
  --desired-delivery-mediums EMAIL `
  @awsArgs
if ($LASTEXITCODE -ne 0) { throw 'admin-create-user failed.' }
Write-Host 'Agent account created. The agent must complete first-login password change and enroll TOTP MFA before their first sign-in to agent-map.'
```

- [ ] **Step 2: Syntax-check the script**

No AWS calls needed for this check — parse only:

```powershell
$null = [System.Management.Automation.PSParser]::Tokenize((Get-Content -Raw .\scripts\provision-agent.ps1), [ref]$null)
```
Expected: no output, no error (a parse error would throw and print a message).

- [ ] **Step 3: Commit**

```bash
git add scripts/provision-agent.ps1
git commit -m "Add agent provisioning script for the Cognito identity bridge"
```

---

### Task 4: Deploy and verify

**Files:** none — uses Task 1's template and Task 3's script.

**Interfaces:** none new.

- [ ] **Step 1: Dry-run deploy with the existing root deploy script**

This repo's `scripts/deploy.ps1` already deploys `infrastructure/template.yaml` (used earlier this project for the core stack and, separately, for the scheduled-callback feature). Reuse it. You will need values for the three new parameters — for `AgentCognitoCallbackUrls`/`AgentCognitoLogoutUrls`, use a placeholder HTTPS URL for now (e.g. `https://localhost/`) since `agent-map`'s real CloudFront URL doesn't exist until `agent-map` itself is deployed later (out of scope here) — this matches the bootstrapping sequence `agent-map/docs/deployment.md` §5 already documents ("Read the `AgentMapUrl` output... add that exact URL... to the agent OIDC client's allowed callbacks" — implying the callback list is expected to be updated after the fact). Add the three new parameters to a copy of the existing local parameters file (`deployment-parameters.local.json`, already gitignored) before running:

```powershell
.\scripts\deploy.ps1 -Region ap-southeast-2 -ArtifactBucket wisecalls-connect-cfn-artifacts-111122223333 -ParametersPath .\deployment-parameters.local.json -StackName wisecalls-connect-dev -Profile default
```
Expected: dry-run parameter echo, no AWS changes. Confirm `AgentCognitoDomainPrefix`, `AgentCognitoCallbackUrls`, `AgentCognitoLogoutUrls` are present in the printed parameter list.

**STOP and get explicit operator approval before executing** — this modifies the same live stack the scheduled-callback feature also deployed to. Since this plan's work lives on its own branch, merge or otherwise reconcile with whatever `master`/other branches have already changed in `infrastructure/template.yaml` before this deploy, and review the actual CloudFormation change set (not just the parameter echo) the same way earlier work in this project did — using `aws cloudformation package` + `aws cloudformation deploy ... --no-execute-changeset` + `aws cloudformation describe-change-set` to see the real resource-level diff before approving. Confirm the change set shows only `Add` for `AgentUserPool`, `AgentUserPoolClient`, `AgentUserPoolDomain`, nothing else touched.

- [ ] **Step 2: Execute the deploy**

```powershell
.\scripts\deploy.ps1 -Region ap-southeast-2 -ArtifactBucket wisecalls-connect-cfn-artifacts-111122223333 -ParametersPath .\deployment-parameters.local.json -StackName wisecalls-connect-dev -Profile default -Execute
```
Expected: `Deployment complete. Outputs written to stack-outputs.json.`

- [ ] **Step 3: Verify the four agent-map parameter values**

```powershell
python3 -c "
import json
outputs = json.load(open('stack-outputs.json', encoding='utf-8'))
for o in outputs:
    if o['OutputKey'].startswith('Agent'):
        print(o['OutputKey'], '=', o['OutputValue'])
"
```
Expected: `AgentUserPoolId`, `AgentUserPoolClientId`, `AgentCognitoManagedLoginDomain`, `AgentOidcIssuer`, `AgentOidcAudience`, `AgentAuthorizationEndpoint`, `AgentTokenEndpoint` all present with real values (not empty, not containing unresolved `${...}` template syntax).

- [ ] **Step 4: Provision one test agent (dry run, then execute)**

```powershell
.\scripts\provision-agent.ps1 -Region ap-southeast-2 -UserPoolId <AgentUserPoolId from Step 3> -Email test-agent@example.com -ConnectUserId <a real Connect user ID from this instance> -Profile default
```
Review the dry-run output, then re-run with `-Execute`.

- [ ] **Step 5: Manual verification (requires a human, browser-based — cannot be scripted)**

This is the one step in this plan that needs a person, not a CLI command — matching the same limitation already encountered with the scheduled-callback feature's live-call acceptance testing.

1. Complete the test agent's first-login password change and TOTP enrollment (Cognito will prompt for this automatically on first sign-in via the Hosted UI).
2. Visit `https://<AgentCognitoManagedLoginDomain from Step 3>/oauth2/authorize?client_id=<AgentUserPoolClientId>&response_type=code&scope=openid+email+profile&redirect_uri=<one of the placeholder callback URLs from Step 1>&code_challenge=<a PKCE challenge>&code_challenge_method=S256` (or use any standard OIDC test client/PKCE debugging tool that can walk the flow) and sign in as the test agent.
3. Exchange the returned authorization code at the token endpoint and decode the resulting ID token (e.g. paste it into any JWT decoder).
4. Confirm the decoded token contains a `custom:connect_user_id` claim whose value exactly matches what Task 4 Step 4 provisioned.
5. Confirm sign-in without a valid TOTP code is rejected (MFA is genuinely enforced, not just configured).
6. Confirm `wisecalls-dev-customers` (the customer pool) shows no new users and no configuration changes — this work touched only the new agent pool.

Record pass/fail for each of the 6 checks above. Do not consider this identity bridge ready for `agent-map`'s own deployment until all 6 pass.

## Note for the future agent-map deployment step (not part of this plan)

Verified directly against `agent-map/backend/app.py:55-56` (`connect_user_id_from_claims`): the backend does a plain, literal `claims.get(claim_name, "")` dictionary lookup — `AGENT_ID_CLAIM`/`AgentIdClaim` is fully parameterized, whatever string is configured is used as-is. Cognito emits custom attributes in tokens with the `custom:` prefix (confirmed by this same repo's own existing `custom:customer_id` pattern, referenced in the root `CLAUDE.md`), so the correct value for `AgentIdClaim` is the literal string `custom:connect_user_id` — **not** the bare `connect_user_id` shown in `agent-map/infrastructure/parameters.example.json`'s own placeholder default, which would cause every claim lookup to silently return an empty string and fail with `AGENT_IDENTITY_NOT_MAPPED`. Flagging this now so it isn't rediscovered the hard way during agent-map's own deployment.

There is a second, independent way the same `AGENT_IDENTITY_NOT_MAPPED` symptom will still occur even with the claim name corrected to `custom:connect_user_id`. `agent-map/frontend/src/main.js` stores and sends the Cognito **access_token** as the bearer token (not the id_token), and `agent-map/backend/app.py`'s `connect_user_id_from_claims` reads claims from that access token's JWT claims, as surfaced by the HTTP API JWT authorizer. Cognito does not include custom user-pool attributes such as `custom:connect_user_id` in access tokens by default — only in ID tokens — unless a Pre Token Generation Lambda trigger (`V2_0`) is configured to inject them into the access token. The `AgentUserPool` defined in this branch's `infrastructure/template.yaml` has no such trigger, so `agent-map`, as currently written, will not see the claim it needs even once `AgentIdClaim` itself is set correctly. This gap did not surface during this plan's own Task 4 Step 5 acceptance check because that check decoded the **ID token**, which genuinely does carry the claim — it is specifically the access token, which is what `agent-map` actually uses, that will not.

Two viable resolutions, neither implemented here (both are new work belonging to `agent-map`'s own deployment, out of scope for this plan):

1. Add a `PreTokenGenerationConfig` (`LambdaVersion: V2_0`) to `AgentUserPool` in `infrastructure/template.yaml` to inject `custom:connect_user_id` into the access token. This pool's `ESSENTIALS` Cognito tier supports this trigger, so no tier change would be required — but the Lambda itself and its wiring do not exist yet and would need to be built.
2. Change `agent-map`'s own frontend (`agent-map/frontend/src/main.js`) to send the `id_token` as the bearer token instead of `access_token`, and update its backend/API Gateway authorizer configuration to validate that token type instead of the access token. This is a change to `agent-map`'s own code, not to this repo's identity-bridge infrastructure.

Whoever picks up `agent-map`'s own deployment should pick one of these two before relying on `custom:connect_user_id` claim propagation end to end.

## Self-review notes

- **Spec coverage:** dedicated pool (Task 1), custom claim mirroring the `custom:customer_id` precedent (Task 1 Step 2), TOTP MFA (Task 1 Step 2 `EnabledMfas`), the four agent-map parameter values as named outputs (Task 1 Step 3), manual provisioning runbook (Task 3), no AD link and no automation (absent by construction — no Directory Service permissions, no sync Lambda anywhere in this plan) — every spec section maps to a task.
- **Placeholder scan:** the `https://localhost/` callback-URL placeholder in Task 4 Step 1 is not a "TBD" — it's the documented, intentional bootstrapping value per `agent-map/docs/deployment.md`'s own described sequence (deploy identity infra first, add the real callback URL after `agent-map`'s frontend exists), and Task 4 explicitly names the follow-up action rather than leaving it unstated.
- **Type/identifier consistency:** checked that `AgentOidcIssuer`/`AgentOidcAudience`/`AgentAuthorizationEndpoint`/`AgentTokenEndpoint` are spelled identically in Task 1's Outputs block and in `agent-map/infrastructure/parameters.example.json`'s parameter keys (`AgentOidcIssuer`, `AgentOidcAudience`, `AgentAuthorizationEndpoint`, `AgentTokenEndpoint`) — exact match, confirmed by reading that file directly during planning.
