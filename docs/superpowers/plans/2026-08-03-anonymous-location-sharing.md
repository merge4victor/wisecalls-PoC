# Anonymous SMS-link Location Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Cognito sign-in requirement from the IVR's one-time, SMS-linked location share (option 4), replacing it with a registered-customer gate plus the existing single-use session token, while leaving the separate authenticated `/location/current` (Android) path untouched.

**Architecture:** A new `Compare` action in `wisecalls-voice-v1-dev.json` gates option 4 on the caller's already-computed `identify_found` contact attribute before reaching the existing (external, unmodified) location flow module. A per-route SAM `Auth` override removes the Cognito JWT requirement from just the `POST /location` API Gateway route. The Lambda's outbound SMS text is updated to stop promising a sign-in step. Documentation is updated to match.

**Tech Stack:** Amazon Connect classic contact-flow JSON (`Version: "2019-10-30"`), AWS SAM/CloudFormation (`infrastructure/template.yaml`), Node.js Lambda (`functions/location-session/index.js`), Python `unittest` for flow-structure tests.

## Global Constraints

- Account `111122223333`, region `ap-southeast-2`, Connect instance `wise-calls-org` (`arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`), profile `default` for every AWS CLI call.
- This work happens on the **already-created** worktree at `C:/project/amazon-connect/wisecalls-PoC/.claude/worktrees/anonymous-location-sharing`, branch `worktree-anonymous-location-sharing`, branched from `master` at `118339c` — do not create another worktree.
- **Only `/location` loses authentication.** `POST /location/current` (the separate, authenticated Android "current location" feature) is explicitly out of scope and must keep requiring the Cognito JWT — no task in this plan touches its authorizer, its Lambda logic, or its customer-ID derivation.
- **Known limitation:** `call-create-location-module` (Connect flow module ID `1f300764-1c7f-4f41-9a4c-221f3f49c3c0`) is external to this repository — no task can see or modify its internals. The registered-customer gate this plan builds lives entirely in `wisecalls-voice-v1-dev.json`, upstream of that module, and is sufficient on its own: the module is only ever reached when the gate has already passed.
- The registered-customer gate reuses the `$.Attributes.identify_found` contact attribute the flow already computes for every caller via the existing `call-identify-module` step, at the very start of the call — no new DynamoDB lookup is added anywhere in this plan.
- **Coordination requirement:** a separate, concurrently-active feature branch (`worktree-voice-redaction-demo`, not yet merged to `master`) has, as of this plan's writing, a live AWS Kinesis stream associated with this same Connect instance's real-time analytics storage, created for that branch's own acceptance testing, and has already pushed its own flow-content changes (a "credit card related issues" option 8) directly to the live `wisecalls-voice-v1-dev` flow. This plan's final deploy task must check whether that work is still live before pushing anything, and must not silently overwrite it — see Task 5 Step 1.

---

### Task 1: Registered-customer gate in the contact flow

**Files:**
- Modify: `connect-flows/wisecalls-voice-v1-dev.json`
- Modify: `connect-flows/validate_flow.py`
- Modify: `connect-flows/tests/test_validate_flow.py`

**Interfaces:**
- Produces: new action identifiers `check-location-eligibility`, `location-sharing-unavailable-message` in the flow content.
- Consumes: the existing `identify_found` contact attribute, already set by the existing `call-identify-module` step earlier in the same flow (no code changes needed to produce it — it already exists in the deployed flow).

- [ ] **Step 1: Redirect option 4 through the new gate**

In `connect-flows/wisecalls-voice-v1-dev.json`, find the `main-menu` action's `Transitions.Conditions` array (search for `"call-create-location-module"`). Change the condition currently pointing option `"4"` at `call-create-location-module`:

```json
{ "NextAction": "call-create-location-module", "Condition": { "Operator": "Equals", "Operands": ["4"] } }
```

to point at the new gate instead:

```json
{ "NextAction": "check-location-eligibility", "Condition": { "Operator": "Equals", "Operands": ["4"] } }
```

Do not change the `main-menu` action's `Text` — the spoken menu wording for option 4 does not need to change.

- [ ] **Step 2: Add the two new actions**

In `connect-flows/wisecalls-voice-v1-dev.json`'s `Actions` array, add these two new action objects immediately before the existing `call-create-location-module` action (search for `"Identifier": "call-create-location-module"`):

```json
{
  "Identifier": "check-location-eligibility",
  "Type": "Compare",
  "Parameters": { "ComparisonValue": "$.Attributes.identify_found" },
  "Transitions": {
    "NextAction": "location-sharing-unavailable-message",
    "Conditions": [ { "NextAction": "call-create-location-module", "Condition": { "Operator": "Equals", "Operands": ["true"] } } ],
    "Errors": [ { "ErrorType": "NoMatchingCondition", "NextAction": "location-sharing-unavailable-message" } ]
  }
},
{
  "Identifier": "location-sharing-unavailable-message",
  "Type": "MessageParticipant",
  "Parameters": { "Text": "I can only text a location link to a registered number. I'll transfer you to an agent." },
  "Transitions": {
    "NextAction": "set-target-queue",
    "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "set-target-queue" } ]
  }
},
```

(Note the trailing comma — this is inserted before an existing array element, not appended at the end.)

- [ ] **Step 3: Update `validate_flow.py`'s required-actions set**

In `connect-flows/validate_flow.py`, add `"check-location-eligibility"` and `"location-sharing-unavailable-message"` to the `REQUIRED_NEW_ACTIONS` frozenset:

```python
REQUIRED_NEW_ACTIONS = frozenset({
    "call-identify-caller-reset",
    "check-reset-candidate",
    "reset-unavailable-message",
    "set-reset-attributes",
    "reset-otp-prompt",
    "invoke-reset-bot",
    "check-reset-outcome",
    "reset-success-message",
    "reset-failed-message",
    "transfer-to-voicemail",
    "call-get-next-slot",
    "check-slot-available",
    "save-slot-attributes",
    "call-book-slot",
    "check-location-eligibility",
    "location-sharing-unavailable-message",
})
```

Do **not** add either new identifier to the `unchanged_ids` list inside `main()` — that list only protects actions that existed in the pre-session baseline flow; these two are brand new. Also do not remove `call-create-location-module` or `location-result-message` from `unchanged_ids` — this plan does not change either action's own content, only what points at `call-create-location-module` (from `main-menu`, which is not itself in `unchanged_ids`).

- [ ] **Step 4: Update `test_validate_flow.py` to match**

In `connect-flows/tests/test_validate_flow.py`, add the two new identifiers to the module-level `REQUIRED_NEW_ACTIONS` list:

```python
REQUIRED_NEW_ACTIONS = [
    "call-identify-caller-reset",
    "check-reset-candidate",
    "reset-unavailable-message",
    "set-reset-attributes",
    "reset-otp-prompt",
    "invoke-reset-bot",
    "check-reset-outcome",
    "reset-success-message",
    "reset-failed-message",
    "transfer-to-voicemail",
    "call-get-next-slot",
    "check-slot-available",
    "save-slot-attributes",
    "call-book-slot",
    "check-location-eligibility",
    "location-sharing-unavailable-message",
]
```

Add a new test method, mirroring the existing `test_missing_callback_action_detected` pattern (which filters `main-menu`'s conditions by `NextAction`, a no-op in this fixture since `_minimal_valid_content()`'s option `"4"` already points at `"end-call"`, not at any of these action names — this exact mirroring, including the no-op filter, was already reviewed and accepted for the equivalent option-7/option-8 tests earlier in this same project):

```python
    def test_missing_location_eligibility_action_detected(self):
        content = _minimal_valid_content()
        content["Actions"] = [a for a in content["Actions"] if a["Identifier"] != "check-location-eligibility"]
        main_menu = next(a for a in content["Actions"] if a["Identifier"] == "main-menu")
        main_menu["Transitions"]["Conditions"] = [
            c for c in main_menu["Transitions"]["Conditions"] if c["NextAction"] != "check-location-eligibility"
        ]
        errors = validate_flow.validate(content)
        self.assertTrue(any("check-location-eligibility" in e for e in errors))
```

- [ ] **Step 5: Run the Python tests**

```powershell
py -3.11 -m unittest discover -s connect-flows/tests -v
```
Expected: all tests pass, including the new one.

- [ ] **Step 6: Run structural validation on the real flow file**

```powershell
py -3.11 connect-flows/validate_flow.py connect-flows/wisecalls-voice-v1-dev.json
```
Expected: `Flow content is structurally valid.`

- [ ] **Step 7: Commit**

```bash
git add connect-flows/wisecalls-voice-v1-dev.json connect-flows/validate_flow.py connect-flows/tests/test_validate_flow.py
git commit -m "Gate option 4 location sharing on registered-customer identify_found"
```

---

### Task 2: Update the outbound SMS text

**Files:**
- Modify: `functions/location-session/index.js`

**Interfaces:**
- Consumes: none new.
- Produces: none new — this is a string-only change inside the existing `handler`'s `action === "create"` branch.

- [ ] **Step 1: Remove the "sign-in required" phrase**

In `functions/location-session/index.js`, find this line inside the `handler` function's `if (input.action === "create")` block:

```javascript
        Message: `WiseCalls: share your current location securely here (sign-in required, link expires soon): ${locationUrl}`
```

Change it to:

```javascript
        Message: `WiseCalls: share your current location securely here (link expires soon): ${locationUrl}`
```

- [ ] **Step 2: Verify the phrase is gone**

```powershell
Select-String -Path functions\location-session\index.js -Pattern "sign-in required"
```
Expected: no matches (empty output).

- [ ] **Step 3: Run the full local test suite**

```powershell
node scripts/validate.mjs
```
Expected: `Local validation passed.` (this file's only currently-tested export, `validateCoordinates`, is untouched by this change, so no test should change behavior).

- [ ] **Step 4: Commit**

```bash
git add functions/location-session/index.js
git commit -m "Remove sign-in-required wording from location-share SMS text"
```

---

### Task 3: Remove Cognito auth from the `/location` API Gateway route

**Files:**
- Modify: `infrastructure/template.yaml`

**Interfaces:**
- Consumes: none new.
- Produces: `POST /location` no longer requires the `CognitoJwt` authorizer; `POST /location/current` is unaffected.

- [ ] **Step 1: Add a per-route Auth override**

In `infrastructure/template.yaml`, find `LocationSessionFunction`'s `Events.SubmitLocation` block (search for `SubmitLocation:`):

```yaml
      Events:
        SubmitLocation:
          Type: HttpApi
          Properties:
            ApiId: !Ref LocationApi
            Path: /location
            Method: POST
        SubmitCurrentMobileLocation:
          Type: HttpApi
          Properties:
            ApiId: !Ref LocationApi
            Path: /location/current
            Method: POST
```

Change only the `SubmitLocation` block, adding an `Auth` override; leave `SubmitCurrentMobileLocation` completely unchanged:

```yaml
      Events:
        SubmitLocation:
          Type: HttpApi
          Properties:
            ApiId: !Ref LocationApi
            Path: /location
            Method: POST
            Auth:
              Authorizer: NONE
        SubmitCurrentMobileLocation:
          Type: HttpApi
          Properties:
            ApiId: !Ref LocationApi
            Path: /location/current
            Method: POST
```

- [ ] **Step 2: Validate the template**

```powershell
$env:PATH += ";C:\Program Files\Amazon\AWSSAMCLI\bin"
sam validate --lint --template-file infrastructure\template.yaml --region ap-southeast-2 --profile default
```
Expected: `infrastructure\template.yaml is a valid SAM Template` (or only pre-existing warnings unrelated to this change, e.g. the known `FrontendCertificateArn` warning already present before this change).

- [ ] **Step 3: Run local validation**

```powershell
node scripts/validate.mjs
```
Expected: `Local validation passed.`

- [ ] **Step 4: Commit**

```bash
git add infrastructure/template.yaml
git commit -m "Remove Cognito JWT requirement from the POST /location route only"
```

---

### Task 4: Update frontend documentation

**Files:**
- Modify: `docs/10-location-frontend.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Rewrite the customer-flow section**

In `docs/10-location-frontend.md`, replace the `## Customer flow` section (currently a single numbered list mixing both the session-based and current-location-update paths) with two separate, clearly-scoped lists:

```markdown
## Customer flow

### Session-based share (from the IVR's "share your location" option)

1. The customer opens the CloudFront HTTPS URL with a `?session=...` value
   created by the contact flow.
2. The page reads the purpose notice and the customer selects explicit
   consent. No sign-in step: the single-use, short-lived session token in the
   URL is the only credential this path uses.
3. The browser requests foreground geolocation permission.
4. The page sends latitude, longitude, horizontal accuracy, observation time,
   and optional altitude/vertical accuracy to API Gateway over HTTPS, along
   with the session token.
5. After the API accepts the position, the page opens the device phone app
   with the configured WiseCalls number. The customer still confirms the
   call.
6. The session token can only be used once — a repeat submission with the
   same token is rejected.

### Authenticated current-location update (separate feature, e.g. the Android app)

1. The customer opens the CloudFront HTTPS URL with no `?session=...` value.
2. The page redirects to Cognito managed login using authorization code with
   PKCE. The supplied user pool requires TOTP MFA.
3. Cognito returns to the exact CloudFront root URL.
4. The page stores the short-lived ID token in browser session storage only.
5. The customer reads the purpose notice and selects explicit consent.
6. The browser requests foreground geolocation permission.
7. The page sends latitude, longitude, horizontal accuracy, observation time,
   and optional altitude/vertical accuracy to API Gateway over HTTPS.
8. API Gateway validates the JWT. Lambda derives the immutable customer ID
   from `custom:customer_id`; no customer ID is accepted from page input.
9. DynamoDB retains the latest authenticated current location until TTL
   expiry.
```

Remove the old paragraph that began "If the URL contains a valid `?session=...` value..." immediately after the old numbered list — its content is now folded into the two lists above.

- [ ] **Step 2: Update the acceptance checks list**

In the same file's `## Acceptance checks` section, find this line:

```
- Successful sign-in shows only a masked customer ID.
```

Change it to make clear this applies only to the authenticated path:

```
- Successful sign-in (authenticated current-location path only) shows only a masked customer ID.
- The session-based share path never shows a sign-in screen.
```

- [ ] **Step 3: Commit**

```bash
git add docs/10-location-frontend.md
git commit -m "Document the split session-based vs authenticated location-sharing flows"
```

---

### Task 5: Deploy and verify

**Files:** none — uses Tasks 1–4's flow content, Lambda, and template.

**Interfaces:** none new.

- [ ] **Step 1: Check for the concurrently-active redaction-demo work before touching anything live**

This plan's Global Constraints note a separate, unmerged branch may have live AWS state on this same stack/flow. Check both:

```powershell
aws --region ap-southeast-2 --profile default connect list-instance-storage-configs --instance-id aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee --resource-type REAL_TIME_CONTACT_ANALYSIS_SEGMENTS --output json
aws --region ap-southeast-2 --profile default cloudformation describe-stacks --stack-name wisecalls-connect-dev --query "Stacks[0].Outputs[?starts_with(OutputKey,'RedactionDemo')]" --output table
```

If the first command returns a non-empty `StorageConfigs` list, a redaction-demo window is still active — **STOP and confirm with the operator** how to proceed before continuing (do not tear it down yourself; that is not this plan's work to manage). If the second command shows `RedactionDemo*` outputs already present in the stack (regardless of whether the storage config is currently associated), that branch's `infrastructure/template.yaml` changes and flow-content changes have already been merged/deployed — before pushing this branch's own flow content in Step 4, this branch must first be reconciled with whatever is currently live, the same way this project has already handled two branches independently modifying `infrastructure/template.yaml` earlier this session: merge the other branch (or current `master`, if it has been merged there by the time this task runs) into this one, verify with `node scripts/validate.mjs` and a marker-uniqueness check (grep each resource name — this plan's own `check-location-eligibility`/`location-sharing-unavailable-message` and the other branch's own action names — appears in the merged flow file exactly once each), before proceeding.

- [ ] **Step 2: Dry-run the infrastructure deploy**

```powershell
.\scripts\deploy.ps1 -Region ap-southeast-2 -ArtifactBucket wisecalls-connect-cfn-artifacts-111122223333 -ParametersPath .\deployment-parameters.local.json -StackName wisecalls-connect-dev -Profile default
```
Expected: dry-run parameter echo, no AWS changes. (This deploy needs no new parameters — Task 3 only added a per-route `Auth` override to an existing event, no new CloudFormation parameters.)

**STOP and get explicit operator approval before executing** — this modifies the same live stack every other feature this session has deployed to. Review the actual CloudFormation change set: `aws cloudformation package` + `aws cloudformation deploy ... --no-execute-changeset` + `aws cloudformation describe-change-set`. Confirm the change set shows only a `Modify` on `LocationSessionFunction` (or no resource-level change at all, if the `Auth` override doesn't require a resource replacement — check the actual `Details` in the change set rather than assuming) — no `Add` or `Remove` of anything else. Packaging may also show benign `Code`-only `Modify` entries on other pre-existing Lambda functions, a known, harmless side effect already documented earlier this session.

- [ ] **Step 3: Execute the infrastructure deploy**

```powershell
.\scripts\deploy.ps1 -Region ap-southeast-2 -ArtifactBucket wisecalls-connect-cfn-artifacts-111122223333 -ParametersPath .\deployment-parameters.local.json -StackName wisecalls-connect-dev -Profile default -Execute
```
Expected: `Deployment complete. Outputs written to stack-outputs.json.`

- [ ] **Step 4: Push the updated flow content**

```powershell
.\scripts\deploy-connect-flow.ps1 -Region ap-southeast-2 -ConnectInstanceArn arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee -FlowId 790c287e-1663-4dcf-844c-f180891bca52 -AdPasswordResetStackName wisecalls-dev-ad-reset -Profile default -Execute
```

If this fails with `InvalidContactFlowException`, the error message names the exact problem — fix `wisecalls-voice-v1-dev.json` based on that message, re-run Task 1 Step 6's structural validation, and retry this step. (The `Compare`/`MessageParticipant` action types used in Task 1 are already proven patterns elsewhere in this same flow file, so a schema rejection here would be unexpected, unlike the genuinely novel action type used by the concurrently-active redaction-demo feature.)

- [ ] **Step 5: Verify the flow push landed**

```powershell
$live = aws connect describe-contact-flow --instance-id aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee --contact-flow-id 790c287e-1663-4dcf-844c-f180891bca52 --output json --region ap-southeast-2 --profile default | ConvertFrom-Json
if ($live.ContactFlow.Content -notmatch 'check-location-eligibility') { throw 'Post-deploy verification failed: live content does not contain the new check-location-eligibility action.' }
Write-Host 'Deploy verified: live content now contains the location-sharing eligibility gate.'
```

- [ ] **Step 6: Run the acceptance checklist**

A real phone call is required for checks 1–2; this cannot be scripted by an agent. Record pass/fail for each:

1. Call in from a number that matches a registered customer, select option 4, confirm the SMS arrives and the linked page works with **no sign-in prompt of any kind**.
2. Call in from a number that does **not** match any registered customer, select option 4, confirm a decline message plays, the call routes to an agent, and **no SMS is sent**.
3. Confirm `POST /location/current` still rejects a request with no (or an invalid) Cognito JWT — this is a regression check that the per-route override in Task 3 did not accidentally loosen the wrong route:
   ```powershell
   $apiUrl = (aws cloudformation describe-stacks --stack-name wisecalls-connect-dev --query "Stacks[0].Outputs[?OutputKey=='CurrentMobileLocationApiUrl'].OutputValue" --output text --region ap-southeast-2 --profile default)
   Invoke-WebRequest -Uri $apiUrl -Method POST -Body '{}' -ContentType 'application/json' -SkipHttpErrorCheck
   ```
   Expected: an HTTP 401 (Unauthorized) response, not a 200 or a Lambda-level error — confirming API Gateway is still rejecting the request before it ever reaches the Lambda.
4. Confirm an expired or already-used session link is still rejected with the existing `EXPIRED_OR_USED` response — this behavior is unchanged by this work and must not regress. (Reuse a session ID from check 1 by submitting a second, different location update against the same link after the first succeeded.)

Do not consider this feature ready to use until all 4 checks pass.
