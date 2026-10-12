# Scheduled Callback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let callers on `wisecalls-voice-v1-dev` (+61370100001) book a 15-minute callback slot between 2-4pm today (DTMF option 7), and have a human agent automatically called back at that time via `BasicQueue`, with one retry on no-answer.

**Architecture:** Two new Lambdas invoked directly from the flow (`get-next-open-slot`, `book-callback-slot`) write to a new `CallbackBookingTable`. A `rate(5 minutes)` EventBridge rule drives a polling Lambda (`callback-poller`) that calls `StartOutboundVoiceContact` for due bookings into a new outbound flow. A second EventBridge rule, subscribed to Connect's native Contact Events on the default event bus, drives an outcome-recording Lambda (`record-callback-outcome`) that reads the `DISCONNECTED` event's `connectedToSystemTimestamp` to detect no-answer and manage the one retry.

**Tech Stack:** Node.js 22.x (arm64) Lambdas via the existing `infrastructure/template.yaml` SAM stack, DynamoDB (PAY_PER_REQUEST), EventBridge rules, Amazon Connect classic Contact Flow JSON, Python 3.11 for `connect-flows/validate_flow.py`, PowerShell for deploy scripts — all matching tooling already used elsewhere in this repo this session.

## Global Constraints

- This directory is **not a git repository**. Skip every `git add`/`git commit` step — save files to disk and move on.
- Never invent an untested Connect flow-language action `Type` or parameter name. Every action type used below (`InvokeLambdaFunction`, `Compare`, `GetParticipantInput`, `UpdateContactAttributes`, `MessageParticipant`, `UpdateContactTargetQueue`, `TransferContactToQueue`, `DisconnectParticipant`) is already proven working in this exact account from the two prior flow changes this session (`connect-flows/wisecalls-voice-v1-dev.json`), so no new action types are introduced here.
- Account `111122223333`, region `ap-southeast-2`, profile `default` for every AWS CLI call.
- Connect instance ARN: `arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee` (instance ID `aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`).
- `BasicQueue` ARN: `arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/queue/dcc369d7-d5c2-4ee3-9a52-0d10b0219a60`.
- `wisecalls-voice-v1-dev` flow ID: `790c287e-1663-4dcf-844c-f180891bca52`, currently live on `+61370100001`.
- No AI-agent-conducted callbacks, no next-day slots, no Connect Cases integration, no capacity >1/slot — all explicitly out of scope per the spec.
- Favor no always-on flat-fee resources (an idle Kinesis stream was removed earlier this session for exactly that reason) — everything here is either request-driven Lambda or EventBridge rules billed per-match, not per-hour.

---

### Task 1: `CallbackBookingTable` and shared environment wiring

**Files:**
- Modify: `infrastructure/template.yaml` (add table resource, add `CALLBACK_BOOKING_TABLE` to `Globals.Function.Environment.Variables`, add `BasicQueueArn` and `ConnectOutboundFlowId` parameters)

**Interfaces:**
- Produces: DynamoDB table with primary key `slotKey` (String), GSI `StatusIndex` (PK `status`, SK `dueAt` — Number), GSI `ContactIdIndex` (PK `contactId`). Attributes used by later tasks: `slotKey`, `phoneE164`, `reasonCategory`, `status` (`PENDING`\|`CALLED`\|`COMPLETED`\|`MISSED`), `retryCount` (Number), `dueAt` (Number, epoch seconds), `contactId`, `createdAt`, `lastAttemptAt`.

- [ ] **Step 1: Add the table resource**

In `infrastructure/template.yaml`, add immediately after the existing `OtpSessionTable` resource (search for the `OtpSessionTable:` resource block):

```yaml
  CallbackBookingTable:
    Type: AWS::DynamoDB::Table
    DeletionPolicy: Retain
    UpdateReplacePolicy: Retain
    Properties:
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: slotKey
          AttributeType: S
        - AttributeName: status
          AttributeType: S
        - AttributeName: dueAt
          AttributeType: N
        - AttributeName: contactId
          AttributeType: S
      KeySchema:
        - AttributeName: slotKey
          KeyType: HASH
      GlobalSecondaryIndexes:
        - IndexName: StatusIndex
          KeySchema:
            - AttributeName: status
              KeyType: HASH
            - AttributeName: dueAt
              KeyType: RANGE
          Projection:
            ProjectionType: ALL
        - IndexName: ContactIdIndex
          KeySchema:
            - AttributeName: contactId
              KeyType: HASH
          Projection:
            ProjectionType: ALL
      PointInTimeRecoverySpecification:
        PointInTimeRecoveryEnabled: true
      SSESpecification:
        SSEEnabled: true
        SSEType: KMS
        KMSMasterKeyId: !GetAtt DataKey.Arn
      Tags:
        - Key: Project
          Value: !Ref ProjectName
        - Key: Environment
          Value: !Ref Environment
```

- [ ] **Step 2: Add the shared environment variable**

In `infrastructure/template.yaml`, find `Globals.Function.Environment.Variables` (the block containing `OTP_SESSION_TABLE: !Ref OtpSessionTable`) and add one line to it:

```yaml
        CALLBACK_BOOKING_TABLE: !Ref CallbackBookingTable
```

- [ ] **Step 3: Add two new parameters used by later tasks**

In the `Parameters:` section of `infrastructure/template.yaml`, add:

```yaml
  BasicQueueArn:
    Type: String
    Default: "arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/queue/dcc369d7-d5c2-4ee3-9a52-0d10b0219a60"
  CallbackOutboundFlowId:
    Type: String
    Default: ""
    Description: "Set after Task 6 creates wisecalls-callback-outbound-v1-dev; empty is valid until then."
```

- [ ] **Step 4: Validate the template parses**

Run (from repo root):
```powershell
cd infrastructure
$env:PATH += ";C:\Program Files\Amazon\AWSSAMCLI\bin"
sam validate --lint --template-file template.yaml --region ap-southeast-2 --profile default
```
Expected: `infrastructure\template.yaml is a valid SAM Template` (or only pre-existing warnings unrelated to this change — no new errors).

- [ ] **Step 5: Save checkpoint**

No git repository is present — nothing to commit. Move to Task 2.

---

### Task 2: `get-next-open-slot` Lambda

**Files:**
- Create: `functions/get-next-open-slot/index.js`
- Modify: `tests/functions.test.js` (append tests)
- Modify: `infrastructure/template.yaml` (Function, Role, Permission, IntegrationAssociation)
- Modify: `scripts/validate.mjs` (register the new file in `required`)

**Interfaces:**
- Consumes: `CALLBACK_BOOKING_TABLE` env var (Task 1).
- Produces: `computeCandidateSlots(now: Date) -> string[]` (slotKeys like `"2026-08-03#14:15"`, only those still bookable today), `nextOpenSlot(candidates: string[], excluded: string[], taken: Set<string>) -> string | undefined`, `formatSlotLabel(slotKey: string) -> string` (e.g. `"2:15pm"`), `handler(event) -> {ok: true, available: true, slotKey, slotLabel} | {ok: true, available: false}`. Task 4's flow JSON calls this via `InvokeLambdaFunction`, reading `$.External.available` and `$.External.slotKey`/`$.External.slotLabel`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/functions.test.js` (after the existing `location` tests, before any trailing code):

```javascript
const nextSlot = require("../functions/get-next-open-slot/index.js");

test("computeCandidateSlots returns only today's 14:00-15:45 slots at or after now, rounded up", () => {
  const now = new Date("2026-08-03T03:22:00.000Z"); // 13:22 AEST (UTC+10, no DST)
  const slots = nextSlot.computeCandidateSlots(now);
  assert.deepEqual(slots, [
    "2026-08-03#14:00", "2026-08-03#14:15", "2026-08-03#14:30", "2026-08-03#14:45",
    "2026-08-03#15:00", "2026-08-03#15:15", "2026-08-03#15:30", "2026-08-03#15:45"
  ]);
});

test("computeCandidateSlots skips slots already in the past today", () => {
  const now = new Date("2026-08-03T04:18:00.000Z"); // 14:18 AEST
  const slots = nextSlot.computeCandidateSlots(now);
  assert.deepEqual(slots, [
    "2026-08-03#14:30", "2026-08-03#14:45", "2026-08-03#15:00",
    "2026-08-03#15:15", "2026-08-03#15:30", "2026-08-03#15:45"
  ]);
});

test("computeCandidateSlots returns no slots after 16:00", () => {
  const now = new Date("2026-08-03T06:05:00.000Z"); // 16:05 AEST
  assert.deepEqual(nextSlot.computeCandidateSlots(now), []);
});

test("nextOpenSlot skips excluded and already-taken slots", () => {
  const candidates = ["2026-08-03#14:00", "2026-08-03#14:15", "2026-08-03#14:30"];
  const result = nextSlot.nextOpenSlot(candidates, ["2026-08-03#14:00"], new Set(["2026-08-03#14:15"]));
  assert.equal(result, "2026-08-03#14:30");
});

test("nextOpenSlot returns undefined when every candidate is excluded or taken", () => {
  const candidates = ["2026-08-03#14:00", "2026-08-03#14:15"];
  const result = nextSlot.nextOpenSlot(candidates, ["2026-08-03#14:00"], new Set(["2026-08-03#14:15"]));
  assert.equal(result, undefined);
});

test("formatSlotLabel renders a 12-hour time", () => {
  assert.equal(nextSlot.formatSlotLabel("2026-08-03#14:15"), "2:15pm");
  assert.equal(nextSlot.formatSlotLabel("2026-08-03#09:00"), "9:00am");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/functions.test.js`
Expected: FAIL — `Cannot find module '../functions/get-next-open-slot/index.js'`.

- [ ] **Step 3: Write the implementation**

Create `functions/get-next-open-slot/index.js`:

```javascript
"use strict";

const START_MINUTES = 14 * 60; // 14:00
const END_MINUTES = 16 * 60; // 16:00, exclusive upper bound for slot starts
const SLOT_MINUTES = 15;
const SYDNEY_OFFSET_MINUTES = 10 * 60; // ap-southeast-2 AEST, no DST handling needed for this PoC

function parametersFromEvent(event = {}) {
  return { ...event, ...(event.Details?.Parameters || {}) };
}

function toSydneyParts(utcDate) {
  const local = new Date(utcDate.getTime() + SYDNEY_OFFSET_MINUTES * 60000);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    minutesSinceMidnight: local.getUTCHours() * 60 + local.getUTCMinutes()
  };
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function computeCandidateSlots(now) {
  const parts = toSydneyParts(now);
  const dateStr = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  const nextBoundary = Math.ceil(parts.minutesSinceMidnight / SLOT_MINUTES) * SLOT_MINUTES;
  const firstSlotMinutes = Math.max(START_MINUTES, nextBoundary);
  const slots = [];
  for (let minutes = firstSlotMinutes; minutes < END_MINUTES; minutes += SLOT_MINUTES) {
    const hh = Math.floor(minutes / 60);
    const mm = minutes % 60;
    slots.push(`${dateStr}#${pad2(hh)}:${pad2(mm)}`);
  }
  return slots;
}

function nextOpenSlot(candidates, excluded, taken) {
  const excludedSet = new Set(excluded);
  return candidates.find((slot) => !excludedSet.has(slot) && !taken.has(slot));
}

function formatSlotLabel(slotKey) {
  const [, time] = slotKey.split("#");
  const [hourStr, minuteStr] = time.split(":");
  const hour24 = Number(hourStr);
  const suffix = hour24 >= 12 ? "pm" : "am";
  const hour12 = ((hour24 + 11) % 12) + 1;
  return `${hour12}:${minuteStr}${suffix}`;
}

async function handler(event) {
  const input = parametersFromEvent(event);
  const excluded = String(input.excludedSlots || "").split(",").map((s) => s.trim()).filter(Boolean);
  const candidates = computeCandidateSlots(new Date());
  if (candidates.length === 0) return { ok: true, available: false };

  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, BatchGetCommand } = await import("@aws-sdk/lib-dynamodb");
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const result = await db.send(new BatchGetCommand({
    RequestItems: {
      [process.env.CALLBACK_BOOKING_TABLE]: {
        Keys: candidates.map((slotKey) => ({ slotKey }))
      }
    }
  }));
  const taken = new Set((result.Responses?.[process.env.CALLBACK_BOOKING_TABLE] || []).map((item) => item.slotKey));

  const slotKey = nextOpenSlot(candidates, excluded, taken);
  if (!slotKey) return { ok: true, available: false };
  return { ok: true, available: true, slotKey, slotLabel: formatSlotLabel(slotKey) };
}

module.exports = { handler, computeCandidateSlots, nextOpenSlot, formatSlotLabel, parametersFromEvent };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/functions.test.js`
Expected: all 6 new tests `pass`, no regressions in existing tests.

- [ ] **Step 5: Wire into the SAM template**

In `infrastructure/template.yaml`, add a dedicated role near `CustomerVerificationRole` (same file region):

```yaml
  GetNextOpenSlotRole:
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
        - !Sub "arn:${AWS::Partition}:iam::aws:policy/AWSXRayDaemonWriteAccess"
      Policies:
        - PolicyName: ReadCallbackBookings
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action: dynamodb:BatchGetItem
                Resource: !GetAtt CallbackBookingTable.Arn
              - Effect: Allow
                Action: [kms:Decrypt, kms:GenerateDataKey, kms:DescribeKey]
                Resource: !GetAtt DataKey.Arn
```

Then add near `ProductRatesFunction`:

```yaml
  GetNextOpenSlotFunction:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: !Sub "${ProjectName}-${Environment}-get-next-open-slot"
      CodeUri: ../functions/get-next-open-slot/
      Handler: index.handler
      Role: !GetAtt GetNextOpenSlotRole.Arn
```

Then near `ProductRatesConnectPermission`:

```yaml
  GetNextOpenSlotConnectPermission:
    Type: AWS::Lambda::Permission
    Properties:
      Action: lambda:InvokeFunction
      FunctionName: !Ref GetNextOpenSlotFunction
      Principal: connect.amazonaws.com
      SourceAccount: !Ref AWS::AccountId
      SourceArn: !Ref ConnectInstanceArn
```

Then near `ProductRatesAssociation`:

```yaml
  GetNextOpenSlotAssociation:
    Type: AWS::Connect::IntegrationAssociation
    Properties:
      InstanceId: !Ref ConnectInstanceArn
      IntegrationType: LAMBDA_FUNCTION
      IntegrationArn: !GetAtt GetNextOpenSlotFunction.Arn
```

Finally, add an Output near `CustomerVerificationFunctionArn`:

```yaml
  GetNextOpenSlotFunctionArn:
    Value: !GetAtt GetNextOpenSlotFunction.Arn
```

- [ ] **Step 6: Register the new file in local validation**

In `scripts/validate.mjs`, add `"functions/get-next-open-slot/index.js",` to the `required` array (alongside the other `functions/*/index.js` entries).

- [ ] **Step 7: Run local validation**

Run: `node scripts/validate.mjs`
Expected: `Local validation passed.`

- [ ] **Step 8: Save checkpoint**

No git repository is present — nothing to commit. Move to Task 3.

---

### Task 3: `book-callback-slot` Lambda

**Files:**
- Create: `functions/book-callback-slot/index.js`
- Modify: `tests/functions.test.js` (append tests)
- Modify: `infrastructure/template.yaml` (Function, Role, Permission, IntegrationAssociation, Output)
- Modify: `scripts/validate.mjs`

**Interfaces:**
- Consumes: `CALLBACK_BOOKING_TABLE` env var; `formatSlotLabel` pattern consistent with Task 2 (not reused directly — duplicated intentionally since these are separate deployable units, matching this repo's existing style of small independent function files rather than a shared internal library).
- Produces: `buildBookingItem(input, nowSeconds) -> object` (the exact DynamoDB item shape used by Task 4's poller and Task 5's outcome recorder — `slotKey`, `phoneE164`, `reasonCategory`, `status: "PENDING"`, `retryCount: 0`, `dueAt`, `createdAt`), `handler(event) -> {ok: true, booked: true} | {ok: true, booked: false, code: "SLOT_TAKEN"} | {ok: false, code: "INVALID_INPUT"}`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/functions.test.js`:

```javascript
const bookSlot = require("../functions/book-callback-slot/index.js");

test("buildBookingItem produces a PENDING item due at the slot's own start time", () => {
  const item = bookSlot.buildBookingItem(
    { slotKey: "2026-08-03#14:15", phoneE164: "+61491570156", reasonCategory: "GENERAL_ENQUIRY" },
    1754190000
  );
  assert.equal(item.slotKey, "2026-08-03#14:15");
  assert.equal(item.phoneE164, "+61491570156");
  assert.equal(item.reasonCategory, "GENERAL_ENQUIRY");
  assert.equal(item.status, "PENDING");
  assert.equal(item.retryCount, 0);
  assert.equal(item.createdAt, 1754190000);
  assert.equal(typeof item.dueAt, "number");
});

test("buildBookingItem rejects a malformed slotKey", () => {
  assert.throws(() => bookSlot.buildBookingItem(
    { slotKey: "not-a-slot", phoneE164: "+61491570156", reasonCategory: "OTHER" }, 1754190000
  ));
});

test("buildBookingItem rejects an invalid phone number", () => {
  assert.throws(() => bookSlot.buildBookingItem(
    { slotKey: "2026-08-03#14:15", phoneE164: "not-a-phone", reasonCategory: "OTHER" }, 1754190000
  ));
});

test("buildBookingItem defaults an unrecognized reason category to OTHER", () => {
  const item = bookSlot.buildBookingItem(
    { slotKey: "2026-08-03#14:15", phoneE164: "+61491570156", reasonCategory: "nonsense" }, 1754190000
  );
  assert.equal(item.reasonCategory, "OTHER");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/functions.test.js`
Expected: FAIL — `Cannot find module '../functions/book-callback-slot/index.js'`.

- [ ] **Step 3: Write the implementation**

Create `functions/book-callback-slot/index.js`:

```javascript
"use strict";

const SLOT_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}#\d{2}:\d{2}$/;
const PHONE_PATTERN = /^\+\d{6,15}$/;
const REASON_CATEGORIES = new Set(["GENERAL_ENQUIRY", "PRODUCT_OR_ACCOUNT", "EXISTING_CASE", "OTHER"]);

function parametersFromEvent(event = {}) {
  return { ...event, ...(event.Details?.Parameters || {}) };
}

function slotKeyToEpochSeconds(slotKey) {
  const [datePart, timePart] = slotKey.split("#");
  const isoLocal = `${datePart}T${timePart}:00+10:00`;
  return Math.floor(new Date(isoLocal).getTime() / 1000);
}

function buildBookingItem(input, nowSeconds) {
  const slotKey = String(input.slotKey || "");
  if (!SLOT_KEY_PATTERN.test(slotKey)) throw new Error("INVALID_SLOT_KEY");
  const phoneE164 = String(input.phoneE164 || "");
  if (!PHONE_PATTERN.test(phoneE164)) throw new Error("INVALID_PHONE");
  const requestedCategory = String(input.reasonCategory || "OTHER").toUpperCase();
  const reasonCategory = REASON_CATEGORIES.has(requestedCategory) ? requestedCategory : "OTHER";

  return {
    slotKey,
    phoneE164,
    reasonCategory,
    status: "PENDING",
    retryCount: 0,
    dueAt: slotKeyToEpochSeconds(slotKey),
    createdAt: nowSeconds
  };
}

async function handler(event) {
  const input = parametersFromEvent(event);
  if (!input.callerPhone && event.Details?.ContactData?.CustomerEndpoint?.Address) {
    input.phoneE164 = event.Details.ContactData.CustomerEndpoint.Address;
  } else if (input.callerPhone) {
    input.phoneE164 = input.callerPhone;
  }

  let item;
  try {
    item = buildBookingItem(input, Math.floor(Date.now() / 1000));
  } catch (error) {
    return { ok: false, code: error.message };
  }

  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, PutCommand } = await import("@aws-sdk/lib-dynamodb");
  const { ConditionalCheckFailedException } = await import("@aws-sdk/client-dynamodb");
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  try {
    await db.send(new PutCommand({
      TableName: process.env.CALLBACK_BOOKING_TABLE,
      Item: item,
      ConditionExpression: "attribute_not_exists(slotKey)"
    }));
    return { ok: true, booked: true };
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException || error?.name === "ConditionalCheckFailedException") {
      return { ok: true, booked: false, code: "SLOT_TAKEN" };
    }
    throw error;
  }
}

module.exports = { handler, buildBookingItem, slotKeyToEpochSeconds, parametersFromEvent };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/functions.test.js`
Expected: all 4 new tests `pass`.

- [ ] **Step 5: Wire into the SAM template**

Add role near `GetNextOpenSlotRole`:

```yaml
  BookCallbackSlotRole:
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
        - !Sub "arn:${AWS::Partition}:iam::aws:policy/AWSXRayDaemonWriteAccess"
      Policies:
        - PolicyName: WriteCallbackBookings
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action: dynamodb:PutItem
                Resource: !GetAtt CallbackBookingTable.Arn
              - Effect: Allow
                Action: [kms:Decrypt, kms:Encrypt, kms:GenerateDataKey, kms:DescribeKey]
                Resource: !GetAtt DataKey.Arn
```

Add function near `GetNextOpenSlotFunction`:

```yaml
  BookCallbackSlotFunction:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: !Sub "${ProjectName}-${Environment}-book-callback-slot"
      CodeUri: ../functions/book-callback-slot/
      Handler: index.handler
      Role: !GetAtt BookCallbackSlotRole.Arn
```

Add permission near `GetNextOpenSlotConnectPermission`:

```yaml
  BookCallbackSlotConnectPermission:
    Type: AWS::Lambda::Permission
    Properties:
      Action: lambda:InvokeFunction
      FunctionName: !Ref BookCallbackSlotFunction
      Principal: connect.amazonaws.com
      SourceAccount: !Ref AWS::AccountId
      SourceArn: !Ref ConnectInstanceArn
```

Add association near `GetNextOpenSlotAssociation`:

```yaml
  BookCallbackSlotAssociation:
    Type: AWS::Connect::IntegrationAssociation
    Properties:
      InstanceId: !Ref ConnectInstanceArn
      IntegrationType: LAMBDA_FUNCTION
      IntegrationArn: !GetAtt BookCallbackSlotFunction.Arn
```

Add output near `GetNextOpenSlotFunctionArn`:

```yaml
  BookCallbackSlotFunctionArn:
    Value: !GetAtt BookCallbackSlotFunction.Arn
```

- [ ] **Step 6: Register and validate**

Add `"functions/book-callback-slot/index.js",` to `scripts/validate.mjs`'s `required` array. Run: `node scripts/validate.mjs` — expected `Local validation passed.`

- [ ] **Step 7: Save checkpoint**

No git repository is present — nothing to commit. Move to Task 4.

---

### Task 4: `callback-poller` Lambda (5-minute EventBridge rule)

**Files:**
- Create: `functions/callback-poller/index.js`
- Modify: `tests/functions.test.js`
- Modify: `infrastructure/template.yaml` (Function, Role, EventBridge Rule, Lambda Permission, Output)
- Modify: `scripts/validate.mjs`

**Interfaces:**
- Consumes: `CALLBACK_BOOKING_TABLE`, `CONNECT_INSTANCE_ARN`, `CALLBACK_QUEUE_ARN`, `CALLBACK_OUTBOUND_FLOW_ID` env vars (the last one is set for real once Task 6 creates the flow — see Task 6 Step 4). Consumes the `CallbackOutboundFlowId` parameter from Task 1.
- Produces: `isDue(item, nowSeconds) -> boolean`, `handler(event)` (EventBridge scheduled invocation, no meaningful input payload — reads DynamoDB and calls Connect directly).

- [ ] **Step 1: Write the failing tests**

Append to `tests/functions.test.js`:

```javascript
const poller = require("../functions/callback-poller/index.js");

test("isDue is true only for PENDING items whose dueAt has arrived", () => {
  assert.equal(poller.isDue({ status: "PENDING", dueAt: 100 }, 150), true);
  assert.equal(poller.isDue({ status: "PENDING", dueAt: 200 }, 150), false);
  assert.equal(poller.isDue({ status: "CALLED", dueAt: 100 }, 150), false);
  assert.equal(poller.isDue({ status: "COMPLETED", dueAt: 100 }, 150), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/functions.test.js`
Expected: FAIL — `Cannot find module '../functions/callback-poller/index.js'`.

- [ ] **Step 3: Write the implementation**

Create `functions/callback-poller/index.js`:

```javascript
"use strict";

function isDue(item, nowSeconds) {
  return item.status === "PENDING" && Number(item.dueAt) <= nowSeconds;
}

async function handler() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, QueryCommand, UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
  const { ConnectClient, StartOutboundVoiceContactCommand } = await import("@aws-sdk/client-connect");
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const connect = new ConnectClient({});

  const due = await db.send(new QueryCommand({
    TableName: process.env.CALLBACK_BOOKING_TABLE,
    IndexName: "StatusIndex",
    KeyConditionExpression: "#s = :pending AND dueAt <= :now",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":pending": "PENDING", ":now": nowSeconds }
  }));

  let triggered = 0;
  for (const item of due.Items || []) {
    if (!isDue(item, nowSeconds)) continue;
    const outcome = await connect.send(new StartOutboundVoiceContactCommand({
      DestinationPhoneNumber: item.phoneE164,
      ContactFlowId: process.env.CALLBACK_OUTBOUND_FLOW_ID,
      InstanceId: process.env.CONNECT_INSTANCE_ARN,
      QueueId: process.env.CALLBACK_QUEUE_ARN,
      Attributes: { reasonCategory: item.reasonCategory || "OTHER", slotKey: item.slotKey }
    }));
    await db.send(new UpdateCommand({
      TableName: process.env.CALLBACK_BOOKING_TABLE,
      Key: { slotKey: item.slotKey },
      UpdateExpression: "SET #s = :called, contactId = :cid, lastAttemptAt = :now",
      ConditionExpression: "#s = :pending",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":called": "CALLED", ":pending": "PENDING", ":cid": outcome.ContactId, ":now": nowSeconds }
    }));
    triggered += 1;
  }
  return { ok: true, triggered };
}

module.exports = { handler, isDue };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/functions.test.js`
Expected: the new test `pass`.

- [ ] **Step 5: Wire into the SAM template**

Add role:

```yaml
  CallbackPollerRole:
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
        - !Sub "arn:${AWS::Partition}:iam::aws:policy/AWSXRayDaemonWriteAccess"
      Policies:
        - PolicyName: DriveCallbackOutboundCalls
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action: [dynamodb:Query, dynamodb:UpdateItem]
                Resource:
                  - !GetAtt CallbackBookingTable.Arn
                  - !Sub "${CallbackBookingTable.Arn}/index/*"
              - Effect: Allow
                Action: [kms:Decrypt, kms:Encrypt, kms:GenerateDataKey, kms:DescribeKey]
                Resource: !GetAtt DataKey.Arn
              - Effect: Allow
                Action: connect:StartOutboundVoiceContact
                Resource: !Ref ConnectInstanceArn
```

Add function (note the extra environment variables beyond the shared `Globals` block, and the longer timeout to allow for looping over multiple due bookings):

```yaml
  CallbackPollerFunction:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: !Sub "${ProjectName}-${Environment}-callback-poller"
      CodeUri: ../functions/callback-poller/
      Handler: index.handler
      Role: !GetAtt CallbackPollerRole.Arn
      Timeout: 30
      Environment:
        Variables:
          CONNECT_INSTANCE_ARN: !Ref ConnectInstanceArn
          CALLBACK_QUEUE_ARN: !Ref BasicQueueArn
          CALLBACK_OUTBOUND_FLOW_ID: !Ref CallbackOutboundFlowId

  CallbackPollerSchedule:
    Type: AWS::Events::Rule
    Properties:
      Name: !Sub "${ProjectName}-${Environment}-callback-poller"
      ScheduleExpression: "rate(5 minutes)"
      State: ENABLED
      Targets:
        - Id: CallbackPollerTarget
          Arn: !GetAtt CallbackPollerFunction.Arn

  CallbackPollerSchedulePermission:
    Type: AWS::Lambda::Permission
    Properties:
      Action: lambda:InvokeFunction
      FunctionName: !Ref CallbackPollerFunction
      Principal: events.amazonaws.com
      SourceArn: !GetAtt CallbackPollerSchedule.Arn
```

Add output:

```yaml
  CallbackPollerFunctionArn:
    Value: !GetAtt CallbackPollerFunction.Arn
```

- [ ] **Step 6: Register and validate**

Add `"functions/callback-poller/index.js",` to `scripts/validate.mjs`. Run `node scripts/validate.mjs` — expected `Local validation passed.`

- [ ] **Step 7: Save checkpoint**

No git repository is present — nothing to commit. Move to Task 5.

---

### Task 5: `record-callback-outcome` Lambda (Contact Events rule)

**Files:**
- Create: `functions/record-callback-outcome/index.js`
- Modify: `tests/functions.test.js`
- Modify: `infrastructure/template.yaml` (Function, Role, EventBridge Rule, Lambda Permission, Output)
- Modify: `scripts/validate.mjs`

**Interfaces:**
- Consumes: `CALLBACK_BOOKING_TABLE` env var.
- Produces: `wasAnswered(eventDetail) -> boolean`, `nextRetryState(retryCount: number, nowSeconds: number) -> {status: "PENDING"|"MISSED", dueAt?: number, retryCount: number}`, `handler(event)` (EventBridge Contact Event payload, `event.detail`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/functions.test.js`:

```javascript
const outcome = require("../functions/record-callback-outcome/index.js");

test("wasAnswered is true only when connectedToSystemTimestamp is present", () => {
  assert.equal(outcome.wasAnswered({ connectedToSystemTimestamp: "2026-08-03T04:15:03.000Z" }), true);
  assert.equal(outcome.wasAnswered({}), false);
});

test("nextRetryState reschedules once, then gives up", () => {
  const firstMiss = outcome.nextRetryState(0, 1000);
  assert.equal(firstMiss.status, "PENDING");
  assert.equal(firstMiss.retryCount, 1);
  assert.equal(firstMiss.dueAt > 1000, true);

  const secondMiss = outcome.nextRetryState(1, 1000);
  assert.equal(secondMiss.status, "MISSED");
  assert.equal(secondMiss.retryCount, 1);
  assert.equal(secondMiss.dueAt, undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/functions.test.js`
Expected: FAIL — `Cannot find module '../functions/record-callback-outcome/index.js'`.

- [ ] **Step 3: Write the implementation**

Create `functions/record-callback-outcome/index.js`:

```javascript
"use strict";

const RETRY_DELAY_SECONDS = 7 * 60;

function wasAnswered(detail) {
  return Boolean(detail.connectedToSystemTimestamp);
}

function nextRetryState(retryCount, nowSeconds) {
  if (retryCount >= 1) return { status: "MISSED", retryCount };
  return { status: "PENDING", retryCount: retryCount + 1, dueAt: nowSeconds + RETRY_DELAY_SECONDS };
}

async function handler(event) {
  const detail = event.detail || {};
  if (detail.initiationMethod !== "API" || detail.channel?.toUpperCase() !== "VOICE") {
    return { ok: true, skipped: true };
  }

  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, QueryCommand, UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const match = await db.send(new QueryCommand({
    TableName: process.env.CALLBACK_BOOKING_TABLE,
    IndexName: "ContactIdIndex",
    KeyConditionExpression: "contactId = :cid",
    ExpressionAttributeValues: { ":cid": detail.contactId }
  }));
  const booking = match.Items?.[0];
  if (!booking) return { ok: true, matched: false };

  const nowSeconds = Math.floor(Date.now() / 1000);
  const update = wasAnswered(detail)
    ? { status: "COMPLETED" }
    : nextRetryState(Number(booking.retryCount || 0), nowSeconds);

  const names = { "#s": "status" };
  const values = { ":calledStatus": "CALLED", ":newStatus": update.status, ":retryCount": update.retryCount };
  let expression = "SET #s = :newStatus, retryCount = :retryCount";
  if (update.dueAt !== undefined) {
    expression += ", dueAt = :dueAt";
    values[":dueAt"] = update.dueAt;
  }

  await db.send(new UpdateCommand({
    TableName: process.env.CALLBACK_BOOKING_TABLE,
    Key: { slotKey: booking.slotKey },
    UpdateExpression: expression,
    ConditionExpression: "#s = :calledStatus",
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values
  })).catch((error) => {
    if (error?.name !== "ConditionalCheckFailedException") throw error;
  });

  return { ok: true, matched: true, newStatus: update.status };
}

module.exports = { handler, wasAnswered, nextRetryState };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/functions.test.js`
Expected: both new tests `pass`.

- [ ] **Step 5: Wire into the SAM template**

Add role:

```yaml
  RecordCallbackOutcomeRole:
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
        - !Sub "arn:${AWS::Partition}:iam::aws:policy/AWSXRayDaemonWriteAccess"
      Policies:
        - PolicyName: RecordCallbackOutcome
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action: [dynamodb:Query, dynamodb:UpdateItem]
                Resource:
                  - !GetAtt CallbackBookingTable.Arn
                  - !Sub "${CallbackBookingTable.Arn}/index/*"
              - Effect: Allow
                Action: [kms:Decrypt, kms:Encrypt, kms:GenerateDataKey, kms:DescribeKey]
                Resource: !GetAtt DataKey.Arn
```

Add function:

```yaml
  RecordCallbackOutcomeFunction:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: !Sub "${ProjectName}-${Environment}-record-callback-outcome"
      CodeUri: ../functions/record-callback-outcome/
      Handler: index.handler
      Role: !GetAtt RecordCallbackOutcomeRole.Arn

  RecordCallbackOutcomeRule:
    Type: AWS::Events::Rule
    Properties:
      Name: !Sub "${ProjectName}-${Environment}-callback-outcome"
      EventPattern:
        source: ["aws.connect"]
        detail-type: ["Amazon Connect Contact Event"]
        detail:
          eventType: ["DISCONNECTED"]
          channel: ["VOICE"]
          initiationMethod: ["API"]
      State: ENABLED
      Targets:
        - Id: RecordCallbackOutcomeTarget
          Arn: !GetAtt RecordCallbackOutcomeFunction.Arn

  RecordCallbackOutcomeRulePermission:
    Type: AWS::Lambda::Permission
    Properties:
      Action: lambda:InvokeFunction
      FunctionName: !Ref RecordCallbackOutcomeFunction
      Principal: events.amazonaws.com
      SourceArn: !GetAtt RecordCallbackOutcomeRule.Arn
```

Add output:

```yaml
  RecordCallbackOutcomeFunctionArn:
    Value: !GetAtt RecordCallbackOutcomeFunction.Arn
```

- [ ] **Step 6: Register and validate**

Add `"functions/record-callback-outcome/index.js",` to `scripts/validate.mjs`. Run `node scripts/validate.mjs` — expected `Local validation passed.`

- [ ] **Step 7: Save checkpoint**

No git repository is present — nothing to commit. Move to Task 6.

---

### Task 6: New outbound flow (`wisecalls-callback-outbound-v1-dev`)

**Files:**
- Create: `connect-flows/wisecalls-callback-outbound-v1-dev.json`
- Create: `scripts/create-contact-flow.ps1`

**Interfaces:**
- Consumes: `BasicQueue` ARN (Global Constraints).
- Produces: a Connect Contact Flow ID, which must be recorded back into `infrastructure/template.yaml`'s `CallbackOutboundFlowId` parameter default (Step 4) so Task 4's poller Lambda can reference it, and read by Task 9's SAM deploy.

- [ ] **Step 1: Write the flow content**

Create `connect-flows/wisecalls-callback-outbound-v1-dev.json`:

```json
{
  "Version": "2019-10-30",
  "StartAction": "start-logging",
  "Metadata": {
    "Annotations": [
      {
        "type": "default",
        "id": "note-purpose",
        "content": "Outbound-only flow: runs once the customer answers a scheduled-callback call placed by callback-poller via StartOutboundVoiceContact. Never assigned to an inbound number. See docs/superpowers/specs/2026-08-02-scheduled-callback-design.md.",
        "actionId": "start-logging",
        "isFolded": false
      }
    ]
  },
  "Actions": [
    {
      "Identifier": "start-logging",
      "Type": "UpdateFlowLoggingBehavior",
      "Parameters": { "FlowLoggingBehavior": "Enabled" },
      "Transitions": { "NextAction": "greeting" }
    },
    {
      "Identifier": "greeting",
      "Type": "MessageParticipant",
      "Parameters": { "Text": "Hello, this is WiseCalls returning your scheduled callback. One moment while I connect you." },
      "Transitions": {
        "NextAction": "set-target-queue",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "set-target-queue" } ]
      }
    },
    {
      "Identifier": "set-target-queue",
      "Type": "UpdateContactTargetQueue",
      "Parameters": {
        "QueueId": "arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/queue/dcc369d7-d5c2-4ee3-9a52-0d10b0219a60"
      },
      "Transitions": {
        "NextAction": "escalate-to-queue",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "escalate-to-queue" } ]
      }
    },
    {
      "Identifier": "escalate-to-queue",
      "Type": "TransferContactToQueue",
      "Parameters": {},
      "Transitions": {
        "NextAction": "end-call",
        "Errors": [
          { "ErrorType": "QueueAtCapacity", "NextAction": "end-call" },
          { "ErrorType": "NoMatchingError", "NextAction": "end-call" }
        ]
      }
    },
    {
      "Identifier": "end-call",
      "Type": "DisconnectParticipant",
      "Parameters": {},
      "Transitions": {}
    }
  ]
}
```

Note: the `reasonCategory` and `slotKey` attributes passed via `StartOutboundVoiceContact`'s `Attributes` (Task 4) are automatically available as contact attributes (`$.Attributes.reasonCategory`) to the queue/agent without any explicit `UpdateContactAttributes` action needed here — they arrive pre-set on the contact.

- [ ] **Step 2: Validate the new flow's structure**

This is a small, self-contained flow (not an edit to the existing `wisecalls-voice-v1-dev.json`), so `connect-flows/validate_flow.py`'s existing checks (which assert specific `main-menu` options and specific required action identifiers from the other flow) do not apply. Confirm it's at least valid JSON and every `NextAction`/`Conditions`/`Errors` target exists:

```powershell
py -3.11 -c "
import json
content = json.load(open('connect-flows/wisecalls-callback-outbound-v1-dev.json', encoding='utf-8'))
ids = {a['Identifier'] for a in content['Actions']}
assert content['StartAction'] in ids
for a in content['Actions']:
    t = a.get('Transitions', {})
    targets = ([t['NextAction']] if 'NextAction' in t else []) + [c['NextAction'] for c in t.get('Conditions', [])] + [e['NextAction'] for e in t.get('Errors', [])]
    for target in targets:
        assert target in ids, f'{a[\"Identifier\"]} -> missing {target}'
print('OK: outbound flow JSON is structurally valid.')
"
```
Expected: `OK: outbound flow JSON is structurally valid.`

- [ ] **Step 3: Write the one-time flow-creation script**

`scripts/deploy-connect-flow.ps1` only updates an *existing* flow's content (`update-contact-flow-content`); this is a brand-new flow, so it needs `create-contact-flow` once. Create `scripts/create-contact-flow.ps1`:

```powershell
param(
  [Parameter(Mandatory=$true)][string]$Region,
  [Parameter(Mandatory=$true)][string]$ConnectInstanceArn,
  [Parameter(Mandatory=$true)][string]$Name,
  [Parameter(Mandatory=$true)][string]$ContentFile,
  [string]$Profile,
  [switch]$Execute
)
$ErrorActionPreference = 'Stop'
$instanceId = ($ConnectInstanceArn -split '/')[1]
if (-not $instanceId) { throw 'ConnectInstanceArn is invalid.' }
$awsArgs = @('--region', $Region)
if ($Profile) { $awsArgs += @('--profile', $Profile) }

Write-Host "Would create contact flow '$Name' (type CONTACT_FLOW) from $ContentFile"
if (-not $Execute) {
  Write-Host 'DRY RUN: no AWS changes made. Re-run with -Execute after reviewing the values.'
  exit 0
}

$result = aws connect create-contact-flow --instance-id $instanceId --name $Name --type CONTACT_FLOW --content "file://$ContentFile" --output json @awsArgs | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'create-contact-flow failed.' }
Write-Host "Created flow. ContactFlowId = $($result.ContactFlowId)"
Write-Host "Record this value into infrastructure/template.yaml's CallbackOutboundFlowId parameter default."
```

- [ ] **Step 4: Create the flow (dry run, then execute), and record its ID**

Dry run:
```powershell
.\scripts\create-contact-flow.ps1 -Region ap-southeast-2 -ConnectInstanceArn 'arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' -Name wisecalls-callback-outbound-v1-dev -ContentFile .\connect-flows\wisecalls-callback-outbound-v1-dev.json -Profile default
```
**STOP and get explicit operator approval before -Execute** — this creates a real, permanent Connect resource. Then:
```powershell
.\scripts\create-contact-flow.ps1 -Region ap-southeast-2 -ConnectInstanceArn 'arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' -Name wisecalls-callback-outbound-v1-dev -ContentFile .\connect-flows\wisecalls-callback-outbound-v1-dev.json -Profile default -Execute
```
Take the printed `ContactFlowId` and update `infrastructure/template.yaml`'s `CallbackOutboundFlowId` parameter `Default:` (Task 1 Step 3) to that value.

- [ ] **Step 5: Save checkpoint**

No git repository is present — nothing to commit. Move to Task 7.

---

### Task 7: Extend `validate_flow.py`, then add option 7 to `wisecalls-voice-v1-dev`

**Files:**
- Modify: `connect-flows/validate_flow.py`
- Modify: `connect-flows/tests/test_validate_flow.py`
- Modify: `connect-flows/wisecalls-voice-v1-dev.json`
- Create: `connect-backup/original-content-v2.json` (new regression baseline — the currently-live content, which already includes the password-reset/voicemail options)

**Interfaces:**
- Consumes: `connect-flows/validate_flow.py`'s existing `validate`, `load_actions`, `unchanged_actions` functions (unchanged signatures) from the password-reset change.
- Produces: `validate_flow.REQUIRED_MAIN_MENU_OPTIONS` extended to `("1", ..., "7")`; `validate_flow.REQUIRED_NEW_ACTIONS` extended with this task's 3 new action identifiers.

- [ ] **Step 1: Export the current live content as the new regression baseline**

The existing regression check in `connect-flows/validate_flow.py`'s `main()` compares against the *original pre-password-reset* backup. For this change, options 1-6 (which now include password-reset and voicemail) must not change — so a fresh baseline is needed:

```powershell
aws connect describe-contact-flow --instance-id aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee --contact-flow-id 790c287e-1663-4dcf-844c-f180891bca52 --region ap-southeast-2 --profile default --output json > connect-backup/flow-790c287e-current.json
py -3.11 -c "
import json
d = json.load(open('connect-backup/flow-790c287e-current.json', encoding='utf-8'))
open('connect-backup/original-content-v2.json', 'w', encoding='utf-8').write(d['ContactFlow']['Content'])
"
```
Expected: `connect-backup/original-content-v2.json` now contains the flow's current live JSON content (34 actions: the original 24 plus the 10 added for password reset/voicemail).

- [ ] **Step 2: Write the failing tests for the extended validator**

In `connect-flows/tests/test_validate_flow.py`, update `REQUIRED_NEW_ACTIONS` and `_minimal_valid_content` to include the 3 new callback actions and option 7, and add new test cases. Replace the top of the file's constants and the `main-menu` block inside `_minimal_valid_content`:

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
    "call-book-slot",
]
```

And in `_minimal_valid_content`, add the new option 7 condition alongside the existing 1-6 and add stub actions for the 3 new identifiers (they're already covered by the `[_stub(i) for i in REQUIRED_NEW_ACTIONS]` line, so only the `main-menu` `Conditions` list needs the extra entry):

```python
                {"NextAction": "call-get-next-slot", "Condition": {"Operator": "Equals", "Operands": ["7"]}},
```
(added after the existing `"6"` condition, before the closing `],` of `Conditions`).

Then add these tests to the `ValidateFlowTests` class:

```python
    def test_main_menu_missing_option_7_detected(self):
        content = _minimal_valid_content()
        main_menu = next(a for a in content["Actions"] if a["Identifier"] == "main-menu")
        main_menu["Transitions"]["Conditions"] = [
            c for c in main_menu["Transitions"]["Conditions"]
            if c["Condition"]["Operands"] != ["7"]
        ]
        errors = validate_flow.validate(content)
        self.assertTrue(any("'7'" in e for e in errors))

    def test_missing_callback_action_detected(self):
        content = _minimal_valid_content()
        content["Actions"] = [a for a in content["Actions"] if a["Identifier"] != "call-book-slot"]
        main_menu = next(a for a in content["Actions"] if a["Identifier"] == "main-menu")
        main_menu["Transitions"]["Conditions"] = [
            c for c in main_menu["Transitions"]["Conditions"] if c["NextAction"] != "call-book-slot"
        ]
        errors = validate_flow.validate(content)
        self.assertTrue(any("call-book-slot" in e for e in errors))
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `py -3.11 -m unittest connect-flows.tests.test_validate_flow -v` (from repo root)
Expected: FAIL — `main-menu is missing DTMF options: ['7']` assertion doesn't match yet because `validate_flow.py`'s `REQUIRED_MAIN_MENU_OPTIONS` still stops at `"6"`, and `REQUIRED_NEW_ACTIONS` in the module doesn't yet know about the 3 new identifiers.

- [ ] **Step 4: Update `connect-flows/validate_flow.py`**

Change:
```python
REQUIRED_MAIN_MENU_OPTIONS = ("1", "2", "3", "4", "5", "6")
```
to:
```python
REQUIRED_MAIN_MENU_OPTIONS = ("1", "2", "3", "4", "5", "6", "7")
```

Change the `REQUIRED_NEW_ACTIONS` frozenset to add the 3 new entries:
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
    "call-book-slot",
})
```

In `main()`, extend the hardcoded `unchanged_ids` list to also protect the 10 password-reset/voicemail actions added by the previous change (since this task's regression baseline, `original-content-v2.json`, now includes them):
```python
        unchanged_ids = [
            "start-logging", "set-public-state", "call-identify-module", "check-identify-result",
            "greeting-known", "call-start-otp-module", "collect-otp", "save-otp-input",
            "call-verify-otp-module", "check-verify-result", "set-verified-true", "verified-message",
            "verification-failed-message", "greeting-unknown", "invalid-input", "invoke-product-rate",
            "call-product-rate-module", "call-create-location-module", "location-result-message",
            "rate-result-message", "invoke-atm-locator", "set-target-queue", "escalate-to-queue",
            "end-call",
            "call-identify-caller-reset", "check-reset-candidate", "reset-unavailable-message",
            "set-reset-attributes", "reset-otp-prompt", "invoke-reset-bot", "check-reset-outcome",
            "reset-success-message", "reset-failed-message", "transfer-to-voicemail",
        ]
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `py -3.11 -m unittest connect-flows.tests.test_validate_flow -v`
Expected: all tests `pass` (the 2 new ones plus the pre-existing 9 from the prior change — `test_real_flow_file_*` tests still pass since `wisecalls-voice-v1-dev.json` hasn't been edited yet in this task, so they're checking against the file as it stood after the password-reset change, which remains valid).

- [ ] **Step 6: Add option 7 to `connect-flows/wisecalls-voice-v1-dev.json`**

Two edits to the existing file.

First, update `main-menu`'s `Text` and add the new `Conditions` entry:

```json
        "Text": "For our current product rates, press 1. For the nearest branch or ATM, press 2. To speak with an agent, press 3. To share your location securely, press 4. To reset your directory password, press 5. To leave a voicemail message, press 6. To schedule a callback between 2 and 4pm today, press 7."
```

and inside `main-menu`'s `Transitions.Conditions` array, add after the existing `"6"` entry (`transfer-to-voicemail`):

```json
          { "NextAction": "call-get-next-slot", "Condition": { "Operator": "Equals", "Operands": ["7"] } }
```

Second, append these 11 new actions to the `Actions` array (after `transfer-to-voicemail`, before `set-target-queue`):

```json
    {
      "Identifier": "call-get-next-slot",
      "Type": "InvokeLambdaFunction",
      "Parameters": {
        "LambdaFunctionARN": "__GET_NEXT_OPEN_SLOT_FUNCTION_ARN__",
        "InvocationTimeLimitSeconds": "8"
      },
      "Transitions": {
        "NextAction": "check-slot-available",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "callback-unavailable-message" } ]
      }
    },
    {
      "Identifier": "check-slot-available",
      "Type": "Compare",
      "Parameters": { "ComparisonValue": "$.External.available" },
      "Transitions": {
        "NextAction": "callback-unavailable-message",
        "Conditions": [ { "NextAction": "offer-slot-message", "Condition": { "Operator": "Equals", "Operands": ["true"] } } ],
        "Errors": [ { "ErrorType": "NoMatchingCondition", "NextAction": "callback-unavailable-message" } ]
      }
    },
    {
      "Identifier": "callback-unavailable-message",
      "Type": "MessageParticipant",
      "Parameters": { "Text": "Scheduled callbacks aren't available for the rest of today. I'll transfer you to an agent." },
      "Transitions": {
        "NextAction": "set-target-queue",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "set-target-queue" } ]
      }
    },
    {
      "Identifier": "offer-slot-message",
      "Type": "MessageParticipant",
      "Parameters": { "Text": "The next available time is $.External.slotLabel. Press 1 to book it, or press 2 to hear another time." },
      "Transitions": {
        "NextAction": "offer-slot-input",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "offer-slot-input" } ]
      }
    },
    {
      "Identifier": "offer-slot-input",
      "Type": "GetParticipantInput",
      "Parameters": { "StoreInput": "False", "InputTimeLimitSeconds": "8", "Text": "Press 1 to book, or press 2 for another time." },
      "Transitions": {
        "NextAction": "offer-slot-message",
        "Conditions": [
          { "NextAction": "reason-category-prompt", "Condition": { "Operator": "Equals", "Operands": ["1"] } },
          { "NextAction": "track-declined-slot", "Condition": { "Operator": "Equals", "Operands": ["2"] } }
        ],
        "Errors": [
          { "ErrorType": "InputTimeLimitExceeded", "NextAction": "set-target-queue" },
          { "ErrorType": "NoMatchingCondition", "NextAction": "offer-slot-message" },
          { "ErrorType": "NoMatchingError", "NextAction": "set-target-queue" }
        ]
      }
    },
    {
      "Identifier": "track-declined-slot",
      "Type": "UpdateContactAttributes",
      "Parameters": {
        "Attributes": { "excludedSlots": "$.Attributes.excludedSlots,$.External.slotKey" },
        "TargetContact": "Current"
      },
      "Transitions": {
        "NextAction": "call-get-next-slot",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "callback-unavailable-message" } ]
      }
    },
    {
      "Identifier": "reason-category-prompt",
      "Type": "GetParticipantInput",
      "Parameters": { "StoreInput": "False", "InputTimeLimitSeconds": "8", "Text": "So the agent has context: for a general enquiry press 1, a product or account question press 2, an existing case press 3, or anything else press 4." },
      "Transitions": {
        "NextAction": "call-book-slot",
        "Conditions": [
          { "NextAction": "set-reason-general", "Condition": { "Operator": "Equals", "Operands": ["1"] } },
          { "NextAction": "set-reason-product", "Condition": { "Operator": "Equals", "Operands": ["2"] } },
          { "NextAction": "set-reason-case", "Condition": { "Operator": "Equals", "Operands": ["3"] } },
          { "NextAction": "set-reason-other", "Condition": { "Operator": "Equals", "Operands": ["4"] } }
        ],
        "Errors": [
          { "ErrorType": "InputTimeLimitExceeded", "NextAction": "set-reason-other" },
          { "ErrorType": "NoMatchingCondition", "NextAction": "set-reason-other" },
          { "ErrorType": "NoMatchingError", "NextAction": "set-reason-other" }
        ]
      }
    },
    {
      "Identifier": "set-reason-general",
      "Type": "UpdateContactAttributes",
      "Parameters": { "Attributes": { "reasonCategory": "GENERAL_ENQUIRY" }, "TargetContact": "Current" },
      "Transitions": {
        "NextAction": "call-book-slot",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "call-book-slot" } ]
      }
    },
    {
      "Identifier": "set-reason-product",
      "Type": "UpdateContactAttributes",
      "Parameters": { "Attributes": { "reasonCategory": "PRODUCT_OR_ACCOUNT" }, "TargetContact": "Current" },
      "Transitions": {
        "NextAction": "call-book-slot",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "call-book-slot" } ]
      }
    },
    {
      "Identifier": "set-reason-case",
      "Type": "UpdateContactAttributes",
      "Parameters": { "Attributes": { "reasonCategory": "EXISTING_CASE" }, "TargetContact": "Current" },
      "Transitions": {
        "NextAction": "call-book-slot",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "call-book-slot" } ]
      }
    },
    {
      "Identifier": "set-reason-other",
      "Type": "UpdateContactAttributes",
      "Parameters": { "Attributes": { "reasonCategory": "OTHER" }, "TargetContact": "Current" },
      "Transitions": {
        "NextAction": "call-book-slot",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "call-book-slot" } ]
      }
    },
    {
      "Identifier": "call-book-slot",
      "Type": "InvokeLambdaFunction",
      "Parameters": {
        "LambdaFunctionARN": "__BOOK_CALLBACK_SLOT_FUNCTION_ARN__",
        "InvocationTimeLimitSeconds": "8"
      },
      "Transitions": {
        "NextAction": "check-book-result",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "callback-unavailable-message" } ]
      }
    },
    {
      "Identifier": "check-book-result",
      "Type": "Compare",
      "Parameters": { "ComparisonValue": "$.External.booked" },
      "Transitions": {
        "NextAction": "track-declined-slot",
        "Conditions": [ { "NextAction": "booking-confirmed-message", "Condition": { "Operator": "Equals", "Operands": ["true"] } } ],
        "Errors": [ { "ErrorType": "NoMatchingCondition", "NextAction": "track-declined-slot" } ]
      }
    },
    {
      "Identifier": "booking-confirmed-message",
      "Type": "MessageParticipant",
      "Parameters": { "Text": "You're booked. An agent will call you back at $.External.slotLabel today. Goodbye." },
      "Transitions": {
        "NextAction": "end-call",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "end-call" } ]
      }
    },
```

Note the `check-book-result` action's `false` path (a booking race condition — `booked=false`) deliberately reuses `track-declined-slot`: it appends the just-lost `slotKey` to `excludedSlots` and loops back to `call-get-next-slot`, exactly like a caller declining a slot, per the spec's "transparent retry" requirement.

Also note the `call-get-next-slot` action's `LambdaFunctionARN` and `call-book-slot`'s `LambdaFunctionARN` use placeholder tokens (`__GET_NEXT_OPEN_SLOT_FUNCTION_ARN__`, `__BOOK_CALLBACK_SLOT_FUNCTION_ARN__`), following the exact same substitution pattern `scripts/deploy-connect-flow.ps1` already uses for the password-reset Lambda/Lex ARNs — Task 9 extends that script rather than reinventing it.

- [ ] **Step 7: Run both validations**

```powershell
py -3.11 connect-flows/validate_flow.py connect-flows/wisecalls-voice-v1-dev.json connect-backup/original-content-v2.json
py -3.11 -m unittest connect-flows.tests.test_validate_flow -v
```
Expected: both `Flow content is structurally valid.` and all unittests `pass` (11 tests total: the 9 from the password-reset change plus the 2 new ones from Step 2, all still exercised against the file as it now stands with option 7).

- [ ] **Step 8: Save checkpoint**

No git repository is present — nothing to commit. Move to Task 8.

---

### Task 8: Extend the deploy script's ARN substitution

**Files:**
- Modify: `scripts/deploy-connect-flow.ps1`

**Interfaces:**
- Consumes: `GetNextOpenSlotFunctionArn` and `BookCallbackSlotFunctionArn` stack outputs (Tasks 2 and 3) — from the **main** `wisecalls-connect-dev` stack, not the `ad-password-reset` stack the script currently reads from exclusively.

- [ ] **Step 1: Add a second stack-outputs source and two more substitutions**

The script currently reads `IdentifyCallerFunctionArn`/`LexBotAliasArn` from a single `-AdPasswordResetStackName` parameter. This task's two new ARNs live in the *main* `wisecalls-connect-dev` stack instead. Modify `scripts/deploy-connect-flow.ps1`: add a new parameter and a second `describe-stacks` lookup.

Add to the `param()` block:
```powershell
  [string]$MainStackName = "wisecalls-connect-dev",
```

After the existing `Write-Host "  LexBotAliasArn            = $lexAliasArn"` line, add:
```powershell
Write-Host "Reading main stack outputs from $MainStackName..."
$mainOutputsJson = aws cloudformation describe-stacks --stack-name $MainStackName --query 'Stacks[0].Outputs' --output json @awsArgs
if ($LASTEXITCODE -ne 0) { throw "Could not read stack outputs for $MainStackName. Has it been deployed?" }
$mainOutputs = $mainOutputsJson | ConvertFrom-Json
$getSlotArn = ($mainOutputs | Where-Object { $_.OutputKey -eq 'GetNextOpenSlotFunctionArn' }).OutputValue
$bookSlotArn = ($mainOutputs | Where-Object { $_.OutputKey -eq 'BookCallbackSlotFunctionArn' }).OutputValue
if (-not $getSlotArn -or -not $bookSlotArn) {
  throw 'Main stack outputs are missing GetNextOpenSlotFunctionArn or BookCallbackSlotFunctionArn.'
}
Write-Host "  GetNextOpenSlotFunctionArn = $getSlotArn"
Write-Host "  BookCallbackSlotFunctionArn = $bookSlotArn"
```

Change the substitution line from:
```powershell
$substituted = $rawContent.Replace('__IDENTIFY_CALLER_FUNCTION_ARN__', $identifyArn).Replace('__PASSWORD_RESET_BOT_ALIAS_ARN__', $lexAliasArn)
```
to:
```powershell
$substituted = $rawContent.Replace('__IDENTIFY_CALLER_FUNCTION_ARN__', $identifyArn).Replace('__PASSWORD_RESET_BOT_ALIAS_ARN__', $lexAliasArn).Replace('__GET_NEXT_OPEN_SLOT_FUNCTION_ARN__', $getSlotArn).Replace('__BOOK_CALLBACK_SLOT_FUNCTION_ARN__', $bookSlotArn)
```

- [ ] **Step 2: Save checkpoint**

No git repository is present — nothing to commit. Move to Task 9.

---

### Task 9: Deploy the main stack, then push the flow content

**Files:** none — uses everything built in Tasks 1-8.

**Interfaces:** none new.

- [ ] **Step 1: Dry-run deploy the main stack with its existing script**

This repo already has `scripts/deploy.ps1` for the main `wisecalls-connect-dev` stack (uses `aws cloudformation package` + `deploy`, not `sam`), and a local `deployment-parameters.local.json` already exists from the original deployment. Reuse both rather than inventing a new deploy path:

```powershell
.\scripts\deploy.ps1 -Region ap-southeast-2 -ArtifactBucket wisecalls-connect-cfn-artifacts-111122223333 -ParametersPath .\deployment-parameters.local.json -StackName wisecalls-connect-dev -Profile default
```
Expected (no `-Execute`, so this is a dry run): prints `Dry run only. Add -Execute to package and deploy.` along with the stack name, region, artifact bucket, and full parameter list for review — confirm `CallbackOutboundFlowId` shows the real flow ID from Task 6 Step 4, not an empty string. **STOP and get explicit operator approval before executing** — this stack also contains everything from prior work in the account; confirm this change set would only add `CallbackBookingTable`, 4 new Lambda functions, 4 new IAM roles, 4 Lambda permissions, 2 `IntegrationAssociation`s, 2 `EventBridge::Rule`s, 2 new parameters, and 6 new outputs, nothing else.

- [ ] **Step 2: Execute the stack update**

```powershell
.\scripts\deploy.ps1 -Region ap-southeast-2 -ArtifactBucket wisecalls-connect-cfn-artifacts-111122223333 -ParametersPath .\deployment-parameters.local.json -StackName wisecalls-connect-dev -Profile default -Execute
```
Expected: `Deployment complete. Outputs written to stack-outputs.json.`

- [ ] **Step 3: Push the updated flow content**

```powershell
.\scripts\deploy-connect-flow.ps1 -Region ap-southeast-2 -ConnectInstanceArn 'arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' -FlowId '790c287e-1663-4dcf-844c-f180891bca52' -AdPasswordResetStackName wisecalls-dev-ad-reset -MainStackName wisecalls-connect-dev -Profile default
```
Review the dry-run output (both stacks' ARNs resolved, structural validation passed twice). **STOP for explicit operator approval** — this flow is live on +61370100001. Then re-run with `-Execute` appended.

- [ ] **Step 4: Verify unrelated flows are untouched**

```powershell
aws connect describe-contact-flow --instance-id aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee --contact-flow-id 05d92d19-1fc1-4540-a3f5-91dda3584ec5 --region ap-southeast-2 --profile default --query 'ContactFlow.{Name:Name,LastModifiedTime:LastModifiedTime}'
```
Expected: `LastModifiedTime` for `wise-calls-org-voicemail-ivr` unchanged from before this task.

- [ ] **Step 5: Run the acceptance matrix from the spec**

From `docs/superpowers/specs/2026-08-02-scheduled-callback-design.md`'s Test plan, adapted for the actual reason-category DTMF menu built in Task 7 (not free-form speech):

1. Call +61370100001 between 2-4pm, press 7, book the offered slot, choose a reason category — confirm the outbound call fires within 5 minutes of the slot start and lands in `BasicQueue`.
2. Book a slot with a second test call to the same slot before the first completes — confirm it's rejected and the next slot is offered instead.
3. Call after 16:00, press 7 — confirm the "not available today" message and transfer to the agent queue (not a silent disconnect).
4. Press 2 (decline) at the slot offer several times in one call — confirm none of the declined slots are re-offered in that session.
5. Let a booked outbound call ring out unanswered — confirm exactly one retry roughly 5-10 minutes later, then `status=MISSED` in `CallbackBookingTable`, no voicemail.
6. Regression: confirm options 1-6 still behave exactly as they did after the password-reset/voicemail change (Task 7's `original-content-v2.json` diff already proves this at the JSON level; this step confirms it live).

Record pass/fail for each. Do not consider this feature demo-ready until all 6 pass.

## Self-review notes

- **Spec coverage:** hours/capacity (Task 7's slot math + conditional `PutItem`), DTMF-only slot picking (Task 7's flow), 5-minute poller (Task 4), no-answer/retry via Contact Events (Task 5), reason context for the agent (Task 7's reason-category menu, resolved from "spoken reason" — see plan header), no Cases integration / no next-day / no capacity>1 (all absent by construction), regression protection for options 1-6 (Task 7's extended validator) — every spec section maps to a task.
- **Placeholder scan:** the two new `__..._ARN__` tokens in Task 7 are mechanically substituted by Task 8's script extension, following the exact precedent of the two existing tokens from the password-reset change — not a "TBD."
- **Type/identifier consistency:** checked the 3 new action identifiers (`call-get-next-slot`, `check-slot-available`, `call-book-slot`) appear identically across the spec-derived flow JSON (Task 7), `validate_flow.py`'s `REQUIRED_NEW_ACTIONS` (Task 7), and its test file (Task 7) — no drift. Checked `CallbackBookingTable` attribute names (`slotKey`, `status`, `dueAt`, `contactId`, `retryCount`, `reasonCategory`) are used identically across Tasks 2, 3, 4, and 5's Lambda code and IAM policies.
