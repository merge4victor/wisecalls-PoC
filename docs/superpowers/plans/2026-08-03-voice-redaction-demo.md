# Voice-to-voice PII Redaction Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a demo-only IVR branch ("credit card related issues") that turns on real-time Contact Lens transcription with built-in PCI/PII redaction (transcript + audio) for exactly the calls that choose it, backed by a Kinesis stream that is only ever created for an operator-chosen demo window and self-deletes afterward.

**Architecture:** A new DTMF option in `connect-flows/wisecalls-voice-v1-dev.json` passes through Amazon Connect's `UpdateContactRecordingAndAnalyticsBehavior` flow action (the "Set recording, analytics and processing behavior" block) before routing to the existing agent queue — this is a one-time, permanent flow change that only has an effect while a demo-window Kinesis stream is associated as the instance's `REAL_TIME_CONTACT_ANALYSIS_SEGMENTS` storage. Two PowerShell scripts create and tear down that stream/association; a small Lambda, invoked once by a one-time EventBridge Scheduler entry, performs the actual teardown so it happens even if the operator forgets.

**Tech Stack:** Amazon Connect classic contact-flow JSON (`Version: "2019-10-30"`), AWS SAM/CloudFormation (existing root `infrastructure/template.yaml`), Node.js Lambda (matching this repo's existing dynamic-`import()`-of-AWS-SDK-v3 convention), PowerShell scripts (matching `scripts/deploy.ps1` / `scripts/provision-agent.ps1` conventions), Python `unittest` for flow-structure tests, Node `node:test` for Lambda pure-function tests.

## Global Constraints

- Account `111122223333`, region `ap-southeast-2`, Connect instance `wise-calls-org` (`arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`), profile `default` for every AWS CLI call.
- This work happens on a **fresh git worktree/branch off `master`** (current tip `247223f`), not mixed into any other feature's worktree. Use `superpowers:using-git-worktrees` to set this up before Task 1.
- Only Contact Lens's **built-in** PCI/PII redaction categories are used — no custom Comprehend-based or Lambda-based second redaction pass (spec decision 3).
- Both the transcript **and** the saved call recording audio are redacted (`AnalyticsRedactionResults: "RedactedOnly"`, not `"RedactedAndOriginal"`) — the unredacted original is not kept (spec decision 4).
- The demo is scoped to exactly one new DTMF branch, not the whole flow — every other menu option must remain byte-for-byte unchanged (spec decision 6; enforced by `connect-flows/validate_flow.py`'s existing regression check).
- The Kinesis stream and EventBridge Scheduler entry are **not** static CloudFormation resources — they are created and destroyed at runtime by the enable/disable scripts, using **fixed, predictable names** (`wisecalls-dev-contact-lens-demo` for the stream, `wisecalls-dev-redaction-demo-teardown` for the schedule) so the CloudFormation-defined IAM permissions can reference them by exact ARN instead of a wildcard.
- Every AWS-CLI call from a new PowerShell script that takes structured/nested parameters must build the value as a PowerShell object and serialize it with `ConvertTo-Json -Compress`, then pass the whole argument list through a single splatted array (`aws @someArgs`) — never hand-interpolate quotes into a single command string. This is a direct, hard-won lesson from this same project: an earlier script (`scripts/provision-agent.ps1`) mixed quoted and unquoted native-argument tokens on one backtick-continued line and silently corrupted arguments on Windows PowerShell, producing a confusing unrelated-looking AWS error. See that fix (commit `0cd4df2` on the now-merged `worktree-agent-map-identity-bridge` branch) for the failure mode this constraint exists to prevent.
- The exact JSON shape of the `UpdateContactRecordingAndAnalyticsBehavior` action (used in Task 5) is a best-effort reconstruction from AWS documentation, not yet confirmed against this account's real behavior. Task 6 pushes it to the real, live `wisecalls-voice-v1-dev` flow and must treat any `InvalidContactFlowException` as authoritative, fixing the JSON to match — the same verification approach this project has already used successfully for other flow-schema additions this session (the `ResponseValidation`, `NoMatchingCondition`, and `TransferToFlow`-`NextAction` issues were all found and fixed this way, by cross-referencing this account's own existing sample flows).
- No new phone number/DID, no custom demo-viewer web page (Connect's own Agent Workspace real-time transcript panel is the viewing surface), no change to the live production contact flow — only `wisecalls-voice-v1-dev.json`, the same flow this session has already extended for every other feature (password reset, voicemail, scheduled callback).
- Full acceptance testing requires a real phone call and cannot be scripted by an agent — Task 6's final step is a documented manual checklist for the human operator to run, gated behind explicit approval before any AWS-mutating deploy step, consistent with how every other AWS-mutating deploy in this project has been handled this session.

---

### Task 1: Redaction-demo teardown Lambda

**Files:**
- Create: `functions/redaction-demo-teardown/index.js`
- Test: `tests/functions.test.js` (add cases)

**Interfaces:**
- Produces: `exports.handler(event)` where `event = { instanceId: string, streamArn: string, streamName: string }`, returning `{ ok: true, disassociated: boolean }`. `exports.findStorageConfigAssociationId(storageConfigs, streamArn)` — pure function, returns the matching `AssociationId` string or `undefined`.
- Consumes: nothing from earlier tasks (this is the first task).

This Lambda is invoked two ways later in this plan: once by an EventBridge Scheduler one-time schedule (Task 3's `enable-redaction-demo.ps1`), and once synchronously via `aws lambda invoke` (Task 4's `disable-redaction-demo.ps1`) — both pass the same `event` shape, so the handler has no need to know which caller invoked it.

- [ ] **Step 1: Write the failing test for the pure function**

Add to `tests/functions.test.js`, near the top with the other `require` lines:

```javascript
const redactionTeardown = require("../functions/redaction-demo-teardown/index.js");
```

Add these test cases anywhere in the file, alongside the other `test(...)` blocks:

```javascript
test("findStorageConfigAssociationId matches by stream ARN", () => {
  const configs = [
    { AssociationId: "assoc-1", KinesisStreamConfig: { StreamArn: "arn:aws:kinesis:ap-southeast-2:111122223333:stream/other" } },
    { AssociationId: "assoc-2", KinesisStreamConfig: { StreamArn: "arn:aws:kinesis:ap-southeast-2:111122223333:stream/wisecalls-dev-contact-lens-demo" } }
  ];
  assert.equal(
    redactionTeardown.findStorageConfigAssociationId(configs, "arn:aws:kinesis:ap-southeast-2:111122223333:stream/wisecalls-dev-contact-lens-demo"),
    "assoc-2"
  );
});

test("findStorageConfigAssociationId returns undefined when no config matches the stream ARN", () => {
  const configs = [
    { AssociationId: "assoc-1", KinesisStreamConfig: { StreamArn: "arn:aws:kinesis:ap-southeast-2:111122223333:stream/other" } }
  ];
  assert.equal(
    redactionTeardown.findStorageConfigAssociationId(configs, "arn:aws:kinesis:ap-southeast-2:111122223333:stream/wisecalls-dev-contact-lens-demo"),
    undefined
  );
});

test("findStorageConfigAssociationId returns undefined when storageConfigs is undefined", () => {
  assert.equal(
    redactionTeardown.findStorageConfigAssociationId(undefined, "arn:aws:kinesis:ap-southeast-2:111122223333:stream/x"),
    undefined
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/validate.mjs`
Expected: FAIL — `Cannot find module '../functions/redaction-demo-teardown/index.js'`

- [ ] **Step 3: Write the Lambda**

Create `functions/redaction-demo-teardown/index.js`:

```javascript
"use strict";

function findStorageConfigAssociationId(storageConfigs, streamArn) {
  const match = (storageConfigs || []).find(
    (config) => config.KinesisStreamConfig && config.KinesisStreamConfig.StreamArn === streamArn
  );
  return match ? match.AssociationId : undefined;
}

async function handler(event) {
  const { instanceId, streamArn, streamName } = event;
  const { ConnectClient, ListInstanceStorageConfigsCommand, DisassociateInstanceStorageConfigCommand } =
    await import("@aws-sdk/client-connect");
  const { KinesisClient, DeleteStreamCommand } = await import("@aws-sdk/client-kinesis");
  const connect = new ConnectClient({});
  const kinesis = new KinesisClient({});

  const listResult = await connect.send(
    new ListInstanceStorageConfigsCommand({
      InstanceId: instanceId,
      ResourceType: "REAL_TIME_CONTACT_ANALYSIS_SEGMENTS"
    })
  );
  const associationId = findStorageConfigAssociationId(listResult.StorageConfigs, streamArn);

  if (associationId) {
    await connect.send(
      new DisassociateInstanceStorageConfigCommand({
        InstanceId: instanceId,
        AssociationId: associationId,
        ResourceType: "REAL_TIME_CONTACT_ANALYSIS_SEGMENTS"
      })
    );
  }

  try {
    await kinesis.send(new DeleteStreamCommand({ StreamName: streamName, EnforceConsumerDeletion: true }));
  } catch (err) {
    if (err.name !== "ResourceNotFoundException") throw err;
  }

  return { ok: true, disassociated: Boolean(associationId) };
}

module.exports = { handler, findStorageConfigAssociationId };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node scripts/validate.mjs`
Expected: all tests pass, including the three new ones, ending in `Local validation passed.`

- [ ] **Step 5: Commit**

```bash
git add functions/redaction-demo-teardown/index.js tests/functions.test.js
git commit -m "Add redaction-demo teardown Lambda with tested association-lookup logic"
```

---

### Task 2: Wire the teardown Lambda into `infrastructure/template.yaml`

**Files:**
- Modify: `infrastructure/template.yaml`

**Interfaces:**
- Consumes: `functions/redaction-demo-teardown/index.js` (Task 1) via `CodeUri`.
- Produces: CloudFormation resources `RedactionDemoTeardownRole`, `RedactionDemoTeardownFunction`, `RedactionDemoTeardownSchedulerRole`, `RedactionDemoTeardownSchedulerPermission`; outputs `RedactionDemoTeardownFunctionArn`, `RedactionDemoSchedulerRoleArn` — both consumed by Task 3 and Task 4's scripts.

- [ ] **Step 1: Add the four resources**

In `infrastructure/template.yaml`'s `Resources:` section, add immediately after the existing `RecordCallbackOutcomeRulePermission` resource (search for `RecordCallbackOutcomeRulePermission:`, that resource block ends the callback feature's resources):

```yaml
  RedactionDemoTeardownRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal: { Service: lambda.amazonaws.com }
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - !Sub "arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
      Policies:
        - PolicyName: TeardownRedactionDemo
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action: [connect:ListInstanceStorageConfigs, connect:DisassociateInstanceStorageConfig]
                Resource: !Ref ConnectInstanceArn
              - Effect: Allow
                Action: kinesis:DeleteStream
                Resource: !Sub "arn:${AWS::Partition}:kinesis:${AWS::Region}:${AWS::AccountId}:stream/${ProjectName}-${Environment}-contact-lens-demo"

  RedactionDemoTeardownFunction:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: !Sub "${ProjectName}-${Environment}-redaction-demo-teardown"
      CodeUri: ../functions/redaction-demo-teardown/
      Handler: index.handler
      Role: !GetAtt RedactionDemoTeardownRole.Arn
      Timeout: 15

  RedactionDemoTeardownSchedulerRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal: { Service: scheduler.amazonaws.com }
            Action: sts:AssumeRole
      Policies:
        - PolicyName: InvokeRedactionDemoTeardown
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action: lambda:InvokeFunction
                Resource: !GetAtt RedactionDemoTeardownFunction.Arn

  RedactionDemoTeardownSchedulerPermission:
    Type: AWS::Lambda::Permission
    Properties:
      Action: lambda:InvokeFunction
      FunctionName: !Ref RedactionDemoTeardownFunction
      Principal: scheduler.amazonaws.com
      SourceArn: !Sub "arn:${AWS::Partition}:scheduler:${AWS::Region}:${AWS::AccountId}:schedule/default/${ProjectName}-${Environment}-redaction-demo-teardown"
```

Note: `RedactionDemoTeardownSchedulerRole` is the role EventBridge Scheduler assumes to invoke the Lambda (passed as `RoleArn` in the schedule's target, in Task 3); `RedactionDemoTeardownSchedulerPermission` is the Lambda-side resource policy granting the Scheduler service principal permission to invoke it for this specific, fixed schedule name — both are required for a Scheduler-to-Lambda target.

- [ ] **Step 2: Add the two outputs**

In `infrastructure/template.yaml`'s `Outputs:` section, add immediately after the existing `RecordCallbackOutcomeFunctionArn` output (search for `RecordCallbackOutcomeFunctionArn:`):

```yaml
  RedactionDemoTeardownFunctionArn:
    Value: !GetAtt RedactionDemoTeardownFunction.Arn
  RedactionDemoSchedulerRoleArn:
    Value: !GetAtt RedactionDemoTeardownSchedulerRole.Arn
```

- [ ] **Step 3: Register the new resource in local validation**

In `scripts/validate.mjs`, find the marker-checking loop (search for `"AgentUserPool:"`, the most recently added marker) and add `"RedactionDemoTeardownFunction:"` to that array:

```javascript
for (const marker of ["ConnectInstanceArn:", "CustomerUserPool:", "CoreDataTable:", "KnowledgeAssistant:", "LocationFrontendDistribution:", "AgentUserPool:", "RedactionDemoTeardownFunction:"]) {
```

- [ ] **Step 4: Validate the template**

```powershell
$env:PATH += ";C:\Program Files\Amazon\AWSSAMCLI\bin"
sam validate --lint --template-file infrastructure\template.yaml --region ap-southeast-2 --profile default
```
Expected: `infrastructure\template.yaml is a valid SAM Template` (or only pre-existing warnings unrelated to this change).

- [ ] **Step 5: Run local validation**

```powershell
node scripts/validate.mjs
```
Expected: `Local validation passed.`

- [ ] **Step 6: Commit**

```bash
git add infrastructure/template.yaml scripts/validate.mjs
git commit -m "Add redaction-demo teardown Lambda infrastructure to template.yaml"
```

---

### Task 3: `scripts/enable-redaction-demo.ps1`

**Files:**
- Create: `scripts/enable-redaction-demo.ps1`

**Interfaces:**
- Consumes: `RedactionDemoTeardownFunctionArn`, `RedactionDemoSchedulerRoleArn` (Task 2's outputs, read live via `aws cloudformation describe-stacks`, matching `scripts/deploy-connect-flow.ps1`'s established pattern rather than a local `stack-outputs.json` file).
- Produces: a real Kinesis stream named `wisecalls-dev-contact-lens-demo`, a real instance storage association, and a real EventBridge Scheduler entry named `wisecalls-dev-redaction-demo-teardown` — only when run with `-Execute`.

- [ ] **Step 1: Write the script**

Create `scripts/enable-redaction-demo.ps1`:

```powershell
param(
  [Parameter(Mandatory=$true)][string]$Region,
  [Parameter(Mandatory=$true)][string]$ConnectInstanceArn,
  [Parameter(Mandatory=$true)][double]$DurationHours,
  [string]$StackName = "wisecalls-connect-dev",
  [string]$Profile,
  [switch]$Execute
)
$ErrorActionPreference = 'Stop'
$instanceId = ($ConnectInstanceArn -split '/')[1]
if (-not $instanceId) { throw 'ConnectInstanceArn is invalid.' }
$awsArgs = @('--region', $Region)
if ($Profile) { $awsArgs += @('--profile', $Profile) }

$streamName = 'wisecalls-dev-contact-lens-demo'
$scheduleName = 'wisecalls-dev-redaction-demo-teardown'

Write-Host "Reading stack outputs from $StackName..."
$describeArgs = @('cloudformation', 'describe-stacks', '--stack-name', $StackName, '--query', 'Stacks[0].Outputs', '--output', 'json') + $awsArgs
$outputsJson = aws @describeArgs
if ($LASTEXITCODE -ne 0) { throw "Could not read stack outputs for $StackName. Has it been deployed?" }
$outputs = $outputsJson | ConvertFrom-Json
$teardownArn = ($outputs | Where-Object { $_.OutputKey -eq 'RedactionDemoTeardownFunctionArn' }).OutputValue
$schedulerRoleArn = ($outputs | Where-Object { $_.OutputKey -eq 'RedactionDemoSchedulerRoleArn' }).OutputValue
if (-not $teardownArn -or -not $schedulerRoleArn) {
  throw 'Stack outputs are missing RedactionDemoTeardownFunctionArn or RedactionDemoSchedulerRoleArn.'
}
Write-Host "  RedactionDemoTeardownFunctionArn = $teardownArn"
Write-Host "  RedactionDemoSchedulerRoleArn    = $schedulerRoleArn"

$expiry = (Get-Date).ToUniversalTime().AddHours($DurationHours)
$expiryExpr = "at($($expiry.ToString('yyyy-MM-ddTHH:mm:ss')))"

Write-Host "Would create Kinesis stream '$streamName', associate it as REAL_TIME_CONTACT_ANALYSIS_SEGMENTS storage, and schedule automatic teardown '$scheduleName' at $($expiry.ToString('u'))."
if (-not $Execute) {
  Write-Host 'DRY RUN: no AWS changes made. Re-run with -Execute after reviewing the values.'
  exit 0
}

Write-Host "Creating Kinesis stream $streamName..."
$createArgs = @('kinesis', 'create-stream', '--stream-name', $streamName, '--stream-mode-details', 'StreamMode=ON_DEMAND') + $awsArgs
aws @createArgs
if ($LASTEXITCODE -ne 0) { throw 'kinesis create-stream failed.' }

Write-Host 'Waiting for the stream to become active...'
$waitArgs = @('kinesis', 'wait', 'stream-exists', '--stream-name', $streamName) + $awsArgs
aws @waitArgs
if ($LASTEXITCODE -ne 0) { throw 'Stream did not become active.' }

$describeStreamArgs = @('kinesis', 'describe-stream-summary', '--stream-name', $streamName, '--query', 'StreamDescriptionSummary.StreamARN', '--output', 'text') + $awsArgs
$streamArn = (aws @describeStreamArgs)
if ($LASTEXITCODE -ne 0 -or -not $streamArn) { throw 'Could not read the new stream ARN.' }
Write-Host "  StreamARN = $streamArn"

Write-Host 'Associating the stream as REAL_TIME_CONTACT_ANALYSIS_SEGMENTS storage...'
$storageConfigJson = (@{ StorageType = 'KINESIS_STREAM'; KinesisStreamConfig = @{ StreamArn = $streamArn } } | ConvertTo-Json -Compress)
$associateArgs = @('connect', 'associate-instance-storage-config', '--instance-id', $instanceId, '--resource-type', 'REAL_TIME_CONTACT_ANALYSIS_SEGMENTS', '--storage-config', $storageConfigJson) + $awsArgs
aws @associateArgs
if ($LASTEXITCODE -ne 0) { throw 'associate-instance-storage-config failed.' }

Write-Host "Scheduling automatic teardown at $($expiry.ToString('u'))..."
$scheduleInput = (@{ instanceId = $instanceId; streamArn = $streamArn; streamName = $streamName } | ConvertTo-Json -Compress)
$targetJson = (@{ Arn = $teardownArn; RoleArn = $schedulerRoleArn; Input = $scheduleInput } | ConvertTo-Json -Compress)
$schedulerArgs = @('scheduler', 'create-schedule', '--name', $scheduleName, '--group-name', 'default', '--schedule-expression', $expiryExpr, '--flexible-time-window', '{"Mode":"OFF"}', '--target', $targetJson, '--action-after-completion', 'DELETE') + $awsArgs
aws @schedulerArgs
if ($LASTEXITCODE -ne 0) { throw 'scheduler create-schedule failed.' }

Write-Host "Demo window active until $($expiry.ToString('u')). Stream: $streamName. Schedule: $scheduleName."
Write-Host 'Run scripts/disable-redaction-demo.ps1 -Execute at any time to end it early.'
```

- [ ] **Step 2: Syntax-check the script**

```powershell
$null = [System.Management.Automation.PSParser]::Tokenize((Get-Content -Raw .\scripts\enable-redaction-demo.ps1), [ref]$null)
```
Expected: no output, no error.

- [ ] **Step 3: Commit**

```bash
git add scripts/enable-redaction-demo.ps1
git commit -m "Add enable-redaction-demo.ps1 to spin up a self-expiring demo-window Kinesis stream"
```

---

### Task 4: `scripts/disable-redaction-demo.ps1`

**Files:**
- Create: `scripts/disable-redaction-demo.ps1`

**Interfaces:**
- Consumes: `RedactionDemoTeardownFunctionArn` (Task 2's output); the fixed `wisecalls-dev-contact-lens-demo` stream name and `wisecalls-dev-redaction-demo-teardown` schedule name (Task 3's naming convention).
- Produces: no new resource — invokes Task 1's already-deployed Lambda directly (so the disassociate/delete logic is written exactly once) and deletes the pending schedule.

- [ ] **Step 1: Write the script**

Create `scripts/disable-redaction-demo.ps1`:

```powershell
param(
  [Parameter(Mandatory=$true)][string]$Region,
  [Parameter(Mandatory=$true)][string]$ConnectInstanceArn,
  [string]$StackName = "wisecalls-connect-dev",
  [string]$Profile,
  [switch]$Execute
)
$ErrorActionPreference = 'Stop'
$instanceId = ($ConnectInstanceArn -split '/')[1]
if (-not $instanceId) { throw 'ConnectInstanceArn is invalid.' }
$awsArgs = @('--region', $Region)
if ($Profile) { $awsArgs += @('--profile', $Profile) }

$streamName = 'wisecalls-dev-contact-lens-demo'
$scheduleName = 'wisecalls-dev-redaction-demo-teardown'

Write-Host "Reading stack outputs from $StackName..."
$describeArgs = @('cloudformation', 'describe-stacks', '--stack-name', $StackName, '--query', 'Stacks[0].Outputs', '--output', 'json') + $awsArgs
$outputsJson = aws @describeArgs
if ($LASTEXITCODE -ne 0) { throw "Could not read stack outputs for $StackName. Has it been deployed?" }
$outputs = $outputsJson | ConvertFrom-Json
$teardownArn = ($outputs | Where-Object { $_.OutputKey -eq 'RedactionDemoTeardownFunctionArn' }).OutputValue
if (-not $teardownArn) { throw 'Stack outputs are missing RedactionDemoTeardownFunctionArn.' }

$describeStreamArgs = @('kinesis', 'describe-stream-summary', '--stream-name', $streamName, '--query', 'StreamDescriptionSummary.StreamARN', '--output', 'text') + $awsArgs
$streamArn = (aws @describeStreamArgs 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $streamArn) {
  Write-Host "No active stream named $streamName found. Nothing to tear down."
  exit 0
}

Write-Host "Would invoke $teardownArn to disassociate storage config and delete stream $streamName, then delete the pending schedule '$scheduleName' if present."
if (-not $Execute) {
  Write-Host 'DRY RUN: no AWS changes made. Re-run with -Execute after reviewing the values.'
  exit 0
}

$payload = (@{ instanceId = $instanceId; streamArn = $streamArn; streamName = $streamName } | ConvertTo-Json -Compress)
$payloadFile = Join-Path $env:TEMP 'redaction-demo-teardown-payload.json'
Set-Content -LiteralPath $payloadFile -Value $payload -NoNewline
$responseFile = Join-Path $env:TEMP 'redaction-demo-teardown-response.json'

Write-Host 'Invoking the teardown Lambda...'
$invokeArgs = @('lambda', 'invoke', '--function-name', $teardownArn, '--payload', "file://$payloadFile", '--cli-binary-format', 'raw-in-base64-out', $responseFile) + $awsArgs
aws @invokeArgs
if ($LASTEXITCODE -ne 0) { throw 'lambda invoke failed.' }
Write-Host 'Teardown Lambda response:'
Get-Content -LiteralPath $responseFile | Write-Host

Write-Host "Deleting scheduled teardown '$scheduleName' if it still exists..."
$deleteArgs = @('scheduler', 'delete-schedule', '--name', $scheduleName, '--group-name', 'default') + $awsArgs
aws @deleteArgs 2>$null
Write-Host 'Done.'
```

- [ ] **Step 2: Syntax-check the script**

```powershell
$null = [System.Management.Automation.PSParser]::Tokenize((Get-Content -Raw .\scripts\disable-redaction-demo.ps1), [ref]$null)
```
Expected: no output, no error.

- [ ] **Step 3: Commit**

```bash
git add scripts/disable-redaction-demo.ps1
git commit -m "Add disable-redaction-demo.ps1 for manual/early teardown"
```

---

### Task 5: Flow content — new "credit card related issues" branch

**Files:**
- Modify: `connect-flows/wisecalls-voice-v1-dev.json`
- Modify: `connect-flows/validate_flow.py`
- Modify: `connect-flows/tests/test_validate_flow.py`

**Interfaces:**
- Produces: new action identifiers `credit-card-notice`, `enable-redaction-analytics` in the flow content; `main-menu` gains DTMF option `"8"`.
- Consumes: nothing from Tasks 1–4 — this task is independent of the Lambda/infra/scripts work and can be done in any order relative to them.

- [ ] **Step 1: Add the new DTMF option to `main-menu`**

In `connect-flows/wisecalls-voice-v1-dev.json`, find the `main-menu` action's `Text` parameter and `Conditions` list. Change the `Text` from:

```
"For our current product rates, press 1. For the nearest branch or ATM, press 2. To speak with an agent, press 3. To share your location securely, press 4. To reset your directory password, press 5. To leave a voicemail message, press 6. To schedule a callback between 2 and 4pm today, press 7."
```

to:

```
"For our current product rates, press 1. For the nearest branch or ATM, press 2. To speak with an agent, press 3. To share your location securely, press 4. To reset your directory password, press 5. To leave a voicemail message, press 6. To schedule a callback between 2 and 4pm today, press 7. For a credit card related issue, press 8."
```

Add a new entry to `main-menu`'s `Transitions.Conditions` array, after the existing `"7"` condition:

```json
{ "NextAction": "credit-card-notice", "Condition": { "Operator": "Equals", "Operands": ["8"] } }
```

- [ ] **Step 2: Add the two new actions**

In `connect-flows/wisecalls-voice-v1-dev.json`'s `Actions` array, add these two new action objects anywhere after `main-menu` (for readability, add them immediately before the `set-target-queue` action, since that's where this branch ends up):

```json
{
  "Identifier": "credit-card-notice",
  "Type": "MessageParticipant",
  "Parameters": { "Text": "For your security, this call will be transcribed and any card details you share will be automatically redacted. Connecting you to an agent now." },
  "Transitions": {
    "NextAction": "enable-redaction-analytics",
    "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "enable-redaction-analytics" } ]
  }
},
{
  "Identifier": "enable-redaction-analytics",
  "Type": "UpdateContactRecordingAndAnalyticsBehavior",
  "Parameters": {
    "RecordingBehavior": { "RecordedParticipants": ["Agent", "Customer"] },
    "AnalyticsBehavior": { "Enabled": "True", "AnalyticsLanguage": "en-US" },
    "AnalyticsRedactionBehavior": "Enabled",
    "AnalyticsRedactionResults": "RedactedOnly",
    "AnalyticsRedactionMaskMode": "EntityType",
    "AnalyticsRedactionEntities": [
      "CREDIT_DEBIT_NUMBER",
      "CREDIT_DEBIT_CVV",
      "CREDIT_DEBIT_EXPIRY",
      "BANK_ACCOUNT_NUMBER",
      "BANK_ROUTING",
      "PIN",
      "SSN"
    ]
  },
  "Transitions": {
    "NextAction": "set-target-queue",
    "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "set-target-queue" } ]
  }
}
```

Note (per this plan's Global Constraints): this JSON shape for `UpdateContactRecordingAndAnalyticsBehavior` is a best-effort reconstruction from AWS documentation search results, not yet confirmed by a real push to this account. Task 6 confirms it for real; if `aws connect update-contact-flow-content` rejects it there, fix the JSON based on the exact `InvalidContactFlowException` message and this account's own existing sample flows, then re-run Task 6's structural and live-push steps — do not come back and "fix" this task's JSON speculatively without a real error message driving the change.

- [ ] **Step 3: Update `validate_flow.py`'s required-options and required-actions sets**

In `connect-flows/validate_flow.py`, change:

```python
REQUIRED_MAIN_MENU_OPTIONS = ("1", "2", "3", "4", "5", "6", "7")
```

to:

```python
REQUIRED_MAIN_MENU_OPTIONS = ("1", "2", "3", "4", "5", "6", "7", "8")
```

Add `"credit-card-notice"` and `"enable-redaction-analytics"` to the `REQUIRED_NEW_ACTIONS` frozenset:

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
    "credit-card-notice",
    "enable-redaction-analytics",
})
```

Do **not** add `credit-card-notice` or `enable-redaction-analytics` to the `unchanged_ids` list inside `main()` — that list only protects actions that existed in the pre-session baseline flow; these two are brand new, so there is no prior baseline to regress against.

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
    "credit-card-notice",
    "enable-redaction-analytics",
]
```

Add a new condition to `_minimal_valid_content()`'s `main-menu` `Conditions` list, after the existing `"7"` condition:

```python
{"NextAction": "credit-card-notice", "Condition": {"Operator": "Equals", "Operands": ["8"]}},
```

Add two new test methods, mirroring the existing `test_main_menu_missing_option_7_detected` and `test_missing_callback_action_detected` patterns:

```python
    def test_main_menu_missing_option_8_detected(self):
        content = _minimal_valid_content()
        main_menu = next(a for a in content["Actions"] if a["Identifier"] == "main-menu")
        main_menu["Transitions"]["Conditions"] = [
            c for c in main_menu["Transitions"]["Conditions"]
            if c["Condition"]["Operands"] != ["8"]
        ]
        errors = validate_flow.validate(content)
        self.assertTrue(any("'8'" in e for e in errors))

    def test_missing_redaction_analytics_action_detected(self):
        content = _minimal_valid_content()
        content["Actions"] = [a for a in content["Actions"] if a["Identifier"] != "enable-redaction-analytics"]
        main_menu = next(a for a in content["Actions"] if a["Identifier"] == "main-menu")
        main_menu["Transitions"]["Conditions"] = [
            c for c in main_menu["Transitions"]["Conditions"] if c["NextAction"] != "enable-redaction-analytics"
        ]
        errors = validate_flow.validate(content)
        self.assertTrue(any("enable-redaction-analytics" in e for e in errors))
```

- [ ] **Step 5: Run the Python tests**

```powershell
py -3.11 -m unittest discover -s connect-flows/tests -v
```
Expected: all tests pass, including the two new ones.

- [ ] **Step 6: Run structural validation on the real flow file**

```powershell
py -3.11 connect-flows/validate_flow.py connect-flows/wisecalls-voice-v1-dev.json
```
Expected: `Flow content is structurally valid.` (This checks JSON structure only — it does not call AWS, so it cannot catch a real `InvalidContactFlowException`. That check happens in Task 6.)

- [ ] **Step 7: Commit**

```bash
git add connect-flows/wisecalls-voice-v1-dev.json connect-flows/validate_flow.py connect-flows/tests/test_validate_flow.py
git commit -m "Add credit-card-related-issues DTMF branch with real-time redaction analytics"
```

---

### Task 6: Deploy and verify

**Files:** none — uses Tasks 1–5's template, scripts, and flow content.

**Interfaces:** none new.

- [ ] **Step 1: Dry-run the infrastructure deploy**

```powershell
.\scripts\deploy.ps1 -Region ap-southeast-2 -ArtifactBucket wisecalls-connect-cfn-artifacts-111122223333 -ParametersPath .\deployment-parameters.local.json -StackName wisecalls-connect-dev -Profile default
```
Expected: dry-run parameter echo, no AWS changes. (This deploy needs no new parameters — Tasks 1–2 only added a Lambda, its roles, and outputs, all with no new required CloudFormation parameters.)

**STOP and get explicit operator approval before executing** — this modifies the same live stack every other feature this session has deployed to. Review the actual CloudFormation change set (not just the parameter echo), the same way every other AWS-mutating deploy in this project has been handled: `aws cloudformation package` + `aws cloudformation deploy ... --no-execute-changeset` + `aws cloudformation describe-change-set`. Confirm the change set shows only `Add` for `RedactionDemoTeardownRole`, `RedactionDemoTeardownFunction`, `RedactionDemoTeardownSchedulerRole`, `RedactionDemoTeardownSchedulerPermission` — packaging may also show benign `Code`-only `Modify` entries on pre-existing Lambda functions (a known, harmless side effect of `cloudformation package` re-zipping local source on every run, already seen and documented earlier this session) — but no `Remove` of anything.

- [ ] **Step 2: Execute the infrastructure deploy**

```powershell
.\scripts\deploy.ps1 -Region ap-southeast-2 -ArtifactBucket wisecalls-connect-cfn-artifacts-111122223333 -ParametersPath .\deployment-parameters.local.json -StackName wisecalls-connect-dev -Profile default -Execute
```
Expected: `Deployment complete. Outputs written to stack-outputs.json.`

- [ ] **Step 3: Push the updated flow content**

```powershell
.\scripts\deploy-connect-flow.ps1 -Region ap-southeast-2 -ConnectInstanceArn arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee -FlowId 790c287e-1663-4dcf-844c-f180891bca52 -AdPasswordResetStackName wisecalls-dev-ad-reset -Profile default -Execute
```

If this fails with `InvalidContactFlowException`, the error message names the exact problem. Per this plan's Global Constraints, fix `enable-redaction-analytics`'s JSON in `connect-flows/wisecalls-voice-v1-dev.json` based on that message (cross-referencing `aws connect describe-contact-flow` on any of this account's existing sample flows that use recording/analytics behavior, the same way earlier features this session resolved `NoMatchingCondition`/`ResponseValidation` schema errors), re-run Task 5 Step 6's structural validation, and retry this step. Do not proceed to Step 4 until this push succeeds.

- [ ] **Step 4: Verify the flow push landed**

```powershell
$live = aws connect describe-contact-flow --instance-id aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee --contact-flow-id 790c287e-1663-4dcf-844c-f180891bca52 --output json --region ap-southeast-2 --profile default | ConvertFrom-Json
if ($live.ContactFlow.Content -notmatch 'enable-redaction-analytics') { throw 'Post-deploy verification failed: live content does not contain the new enable-redaction-analytics action.' }
Write-Host 'Deploy verified: live content now contains the credit-card-related-issues branch.'
```

- [ ] **Step 5: Confirm normal routing with no active demo window**

Before ever running `enable-redaction-demo.ps1`, call the number, choose option 8, and confirm the call still routes to an agent normally (per this plan's Global Constraints, this exercises the documented assumption that Contact Lens simply has nowhere to deliver analytics without an associated storage config, rather than erroring the flow — confirm this directly rather than assuming it).

- [ ] **Step 6: Run the demo-window acceptance checklist**

**STOP and get explicit operator approval before running `enable-redaction-demo.ps1 -Execute`** — this creates real, billed AWS resources (a Kinesis stream) for the duration you choose.

```powershell
.\scripts\enable-redaction-demo.ps1 -Region ap-southeast-2 -ConnectInstanceArn arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee -DurationHours 1 -Profile default -Execute
```

Then, per the spec's Test Plan, record pass/fail for each of the following 6 checks (a real phone call is required for checks 1–5; this cannot be scripted by an agent):

1. Call in, choose option 8 ("credit card related issues"), speak a test card number — confirm the Agent Workspace's real-time transcript panel shows it redacted live.
2. After the call, confirm the saved recording in `wise-calls-org-voicemails/recordings` has that moment of audio redacted, not the original unredacted speech.
3. Call in through any other existing menu option during the same demo window — confirm it is not analyzed by Contact Lens.
4. Let the demo window expire naturally, or run:
   ```powershell
   .\scripts\disable-redaction-demo.ps1 -Region ap-southeast-2 -ConnectInstanceArn arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee -Profile default -Execute
   ```
   — confirm afterward (via `aws kinesis describe-stream-summary --stream-name wisecalls-dev-contact-lens-demo`, expecting a `ResourceNotFoundException`, and `aws connect list-instance-storage-configs --instance-id aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee --resource-type REAL_TIME_CONTACT_ANALYSIS_SEGMENTS`, expecting an empty list) that the stream, the storage association, and the schedule are all gone.
5. Call in through option 8 again after teardown — confirm the call still routes normally to an agent, without analytics.

Do not consider this feature ready to demo until all 6 checks (including Step 5's pre-demo-window check) pass.
