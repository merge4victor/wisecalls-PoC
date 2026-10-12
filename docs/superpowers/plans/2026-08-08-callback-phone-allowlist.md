# Callback Phone Allowlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict who can book a scheduled callback on `wisecalls-voice-v1-dev` to an operator-configured list of E.164 phone prefixes, so nuisance callers cannot turn free inbound calls into billed outbound ones.

**Architecture:** A new `CALLBACK_ALLOWED_PHONE_PREFIXES` environment variable holds a comma-separated list of E.164 prefixes. `book-callback-slot` checks the carrier-supplied ANI against that list inside its existing pure `buildBookingItem` function and throws `PHONE_NOT_ALLOWED` on a miss. Lambda responses gain a `retryable` flag so the contact flow can tell a permanently-refused booking apart from a slot that was merely taken, and one new `Compare` block routes the refused case to the existing "not available today" message instead of the slot-retry loop.

**Tech Stack:** Node.js 22 (CommonJS Lambdas, `node:test` + `node:assert/strict`), AWS SAM / CloudFormation YAML, Amazon Connect classic contact-flow JSON, Python 3.11 `unittest` for the flow validator.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-08-callback-phone-allowlist-design.md`. Every requirement there is in scope for this plan.
- **Fail closed.** An unset, empty, or whitespace-only allowlist must deny every number. Never default to "allow all".
- **Prefix matching only.** Use `String.prototype.startsWith`. Do not introduce a regex read from an environment variable.
- The phone number checked is always the carrier ANI from `Details.ContactData.CustomerEndpoint.Address` via the existing `trustedPhoneFromEvent`. Never trust a phone number arriving through `Details.Parameters`.
- Enforcement is in `book-callback-slot` **only**. Do not add checks to `get-next-open-slot` or `callback-poller` — the operator deliberately scoped them out.
- Do not add any new caller-facing prompt text. Blocked callers reuse the existing `callback-unavailable-message` action.
- Default parameter value through the demo: `+61491570156`. The post-demo widening value is `+614`.
- Node test suite must stay green: `node --test tests/functions.test.js` currently reports **36 passing, 0 failing**.
- Flow validator suite must stay green: run from `connect-flows/tests`, `python test_validate_flow.py` currently reports **15 tests, OK**.
- Commit after each task. Do not deploy anything; this plan ends at committed, locally-validated code.

---

### Task 1: Allowlist enforcement in `book-callback-slot`

**Files:**
- Modify: `functions/book-callback-slot/index.js`
- Test: `tests/functions.test.js:209-261` (the `bookSlot` section)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `allowedPrefixes(): string[]` — parses `process.env.CALLBACK_ALLOWED_PHONE_PREFIXES` into trimmed, non-empty prefixes.
  - `isPhoneAllowed(phoneE164: string, prefixes?: string[]): boolean`
  - `isRetryable(code: string): boolean` — `true` only for `"SLOT_TAKEN"`.
  - `buildBookingItem` now throws `new Error("PHONE_NOT_ALLOWED")` for a non-allowlisted number.
  - The handler's failure responses gain a `retryable` boolean. Task 2's flow block reads it as `$.External.retryable`.

- [ ] **Step 1: Write the failing tests**

Open `tests/functions.test.js`. Immediately after the line `const bookSlot = require("../functions/book-callback-slot/index.js");` (currently line 209), insert this helper:

```js
function withAllowlist(value, fn) {
  const previous = process.env.CALLBACK_ALLOWED_PHONE_PREFIXES;
  if (value === undefined) delete process.env.CALLBACK_ALLOWED_PHONE_PREFIXES;
  else process.env.CALLBACK_ALLOWED_PHONE_PREFIXES = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.CALLBACK_ALLOWED_PHONE_PREFIXES;
    else process.env.CALLBACK_ALLOWED_PHONE_PREFIXES = previous;
  }
}
```

Then rewrite the two existing tests that build a *successful* item so they run under an explicit allowlist. Replace the whole of the existing test starting `test("buildBookingItem produces a PENDING item due at the slot's own start time"` with:

```js
test("buildBookingItem produces a PENDING item due at the slot's own start time", () => {
  const item = withAllowlist("+61491570156", () => bookSlot.buildBookingItem(
    { slotKey: "2026-08-03#14:15", phoneE164: "+61491570156", reasonCategory: "GENERAL_ENQUIRY" },
    1754190000
  ));
  assert.equal(item.slotKey, "2026-08-03#14:15");
  assert.equal(item.phoneE164, "+61491570156");
  assert.equal(item.reasonCategory, "GENERAL_ENQUIRY");
  assert.equal(item.status, "PENDING");
  assert.equal(item.retryCount, 0);
  assert.equal(item.createdAt, 1754190000);
  assert.equal(typeof item.dueAt, "number");
});
```

And replace the whole of the existing test starting `test("buildBookingItem defaults an unrecognized reason category to OTHER"` with:

```js
test("buildBookingItem defaults an unrecognized reason category to OTHER", () => {
  const item = withAllowlist("+61491570156", () => bookSlot.buildBookingItem(
    { slotKey: "2026-08-03#14:15", phoneE164: "+61491570156", reasonCategory: "nonsense" }, 1754190000
  ));
  assert.equal(item.reasonCategory, "OTHER");
});
```

Leave the two existing rejection tests (`rejects a malformed slotKey`, `rejects an invalid phone number`) unchanged — both fail validation before the allowlist is consulted, so they are allowlist-independent by construction.

Now append these new tests directly after the `trustedPhoneFromEvent returns undefined...` test (currently ending at line 261), before the `const poller = require(...)` line:

```js
test("buildBookingItem rejects a number outside an exact-match allowlist", () => {
  assert.throws(
    () => withAllowlist("+61491570156", () => bookSlot.buildBookingItem(
      { slotKey: "2026-08-03#14:15", phoneE164: "+61400111222", reasonCategory: "OTHER" }, 1754190000
    )),
    { message: "PHONE_NOT_ALLOWED" }
  );
});

test("buildBookingItem accepts any Australian mobile once the allowlist is widened to a prefix", () => {
  const item = withAllowlist("+614", () => bookSlot.buildBookingItem(
    { slotKey: "2026-08-03#14:15", phoneE164: "+61400111222", reasonCategory: "OTHER" }, 1754190000
  ));
  assert.equal(item.phoneE164, "+61400111222");
});

test("buildBookingItem still rejects a non-Australian number under the +614 prefix", () => {
  assert.throws(
    () => withAllowlist("+614", () => bookSlot.buildBookingItem(
      { slotKey: "2026-08-03#14:15", phoneE164: "+6421234567", reasonCategory: "OTHER" }, 1754190000
    )),
    { message: "PHONE_NOT_ALLOWED" }
  );
});

test("buildBookingItem accepts a number matching any entry in a multi-prefix allowlist", () => {
  const item = withAllowlist("+61491570156,+614", () => bookSlot.buildBookingItem(
    { slotKey: "2026-08-03#14:15", phoneE164: "+61400111222", reasonCategory: "OTHER" }, 1754190000
  ));
  assert.equal(item.phoneE164, "+61400111222");
});

test("an unset, empty, or whitespace-only allowlist denies every number", () => {
  for (const value of [undefined, "", "   ", " , , "]) {
    assert.throws(
      () => withAllowlist(value, () => bookSlot.buildBookingItem(
        { slotKey: "2026-08-03#14:15", phoneE164: "+61491570156", reasonCategory: "OTHER" }, 1754190000
      )),
      { message: "PHONE_NOT_ALLOWED" },
      `expected denial for allowlist value ${JSON.stringify(value)}`
    );
  }
});

test("allowedPrefixes trims entries and drops empty ones", () => {
  withAllowlist(" +61491570156 , , +614 ", () => {
    assert.deepEqual(bookSlot.allowedPrefixes(), ["+61491570156", "+614"]);
  });
});

test("isPhoneAllowed reads the environment when no prefix list is passed", () => {
  withAllowlist("+614", () => {
    assert.equal(bookSlot.isPhoneAllowed("+61400111222"), true);
    assert.equal(bookSlot.isPhoneAllowed("+6421234567"), false);
  });
});

test("only SLOT_TAKEN is retryable; allowlist and validation failures are terminal", () => {
  assert.equal(bookSlot.isRetryable("SLOT_TAKEN"), true);
  assert.equal(bookSlot.isRetryable("PHONE_NOT_ALLOWED"), false);
  assert.equal(bookSlot.isRetryable("INVALID_PHONE"), false);
  assert.equal(bookSlot.isRetryable("INVALID_SLOT_KEY"), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from the repository root:

```powershell
node --test tests/functions.test.js
```

Expected: FAIL. The new tests error with `TypeError: bookSlot.allowedPrefixes is not a function` / `bookSlot.isRetryable is not a function`, and the `PHONE_NOT_ALLOWED` throw assertions fail because `buildBookingItem` currently accepts any well-formed number. The two rewritten success tests still pass.

- [ ] **Step 3: Implement the allowlist**

In `functions/book-callback-slot/index.js`, add these constants and functions after the existing `REASON_CATEGORIES` constant (currently line 5):

```js
const ALLOWLIST_ENV_VAR = "CALLBACK_ALLOWED_PHONE_PREFIXES";
const RETRYABLE_CODES = new Set(["SLOT_TAKEN"]);

// Comma-separated E.164 prefixes. A full-length entry such as "+61491570156" is
// an exact match; "+614" widens to every Australian mobile. An unset or empty
// value yields an empty list, and `some` over an empty list is false — the
// allowlist therefore fails closed rather than open.
function allowedPrefixes() {
  return String(process.env[ALLOWLIST_ENV_VAR] || "")
    .split(",")
    .map((prefix) => prefix.trim())
    .filter(Boolean);
}

function isPhoneAllowed(phoneE164, prefixes = allowedPrefixes()) {
  return prefixes.some((prefix) => phoneE164.startsWith(prefix));
}

// The contact flow reads this as $.External.retryable. Only a lost race for a
// slot is worth re-offering another time; every other failure is permanent for
// this caller, and looping on it would walk them through the whole day's slots.
function isRetryable(code) {
  return RETRYABLE_CODES.has(code);
}
```

In `buildBookingItem`, add the allowlist check immediately after the existing `PHONE_PATTERN` line, so the currently-final phone validation line becomes:

```js
  const phoneE164 = String(input.phoneE164 || "");
  if (!PHONE_PATTERN.test(phoneE164)) throw new Error("INVALID_PHONE");
  if (!isPhoneAllowed(phoneE164)) throw new Error("PHONE_NOT_ALLOWED");
```

In `handler`, change the `buildBookingItem` catch block from `return { ok: false, code: error.message };` to:

```js
    return { ok: false, code: error.message, retryable: isRetryable(error.message) };
```

and change the `ConditionalCheckFailedException` branch from `return { ok: true, booked: false, code: "SLOT_TAKEN" };` to:

```js
      return { ok: true, booked: false, code: "SLOT_TAKEN", retryable: isRetryable("SLOT_TAKEN") };
```

Finally, extend the export list at the bottom of the file to:

```js
module.exports = {
  handler,
  buildBookingItem,
  slotKeyToEpochSeconds,
  parametersFromEvent,
  trustedPhoneFromEvent,
  allowedPrefixes,
  isPhoneAllowed,
  isRetryable
};
```

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
node --test tests/functions.test.js
```

Expected: PASS, `# pass 44` / `# fail 0` (36 existing plus 8 new).

- [ ] **Step 5: Commit**

```bash
git add functions/book-callback-slot/index.js tests/functions.test.js
git commit -m "Restrict callback booking to allowlisted phone prefixes"
```

---

### Task 2: Route blocked bookings out of the slot-retry loop

**Files:**
- Modify: `connect-flows/wisecalls-voice-v1-dev.json:530-551`
- Modify: `connect-flows/validate_flow.py:20-40`
- Test: `connect-flows/tests/test_validate_flow.py:12-32` and a new test method

**Interfaces:**
- Consumes: `$.External.retryable` from Task 1's `book-callback-slot` responses. Connect stringifies Lambda response values, so the boolean `false` arrives as the string `"false"` — the same convention `check-slot-available` and `check-book-result` already use for `"true"`.
- Produces: a new flow action `check-book-blocked`, required by `validate_flow.py`.

- [ ] **Step 1: Write the failing validator test**

In `connect-flows/tests/test_validate_flow.py`, add `"check-book-blocked"` to the `REQUIRED_NEW_ACTIONS` list, immediately after the `"call-book-slot"` entry:

```python
    "call-book-slot",
    "check-book-blocked",
```

Then add this test method to `ValidateFlowTests`, directly after `test_missing_callback_action_detected`:

```python
    def test_missing_book_blocked_action_detected(self):
        content = _minimal_valid_content()
        content["Actions"] = [a for a in content["Actions"] if a["Identifier"] != "check-book-blocked"]
        errors = validate_flow.validate(content)
        self.assertTrue(any("check-book-blocked" in e for e in errors))
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `connect-flows/tests`:

```powershell
python test_validate_flow.py
```

Expected: FAIL. `test_missing_book_blocked_action_detected` fails because `validate_flow.REQUIRED_NEW_ACTIONS` does not yet contain `check-book-blocked`, so removing the action produces no error. `test_real_flow_file_is_structurally_valid` still passes at this point.

- [ ] **Step 3: Add the identifier to the validator**

In `connect-flows/validate_flow.py`, add the entry to the `REQUIRED_NEW_ACTIONS` frozenset, immediately after `"call-book-slot",`:

```python
    "call-book-slot",
    "check-book-blocked",
```

- [ ] **Step 4: Run the tests to confirm the new test passes and the real flow now fails**

```powershell
python test_validate_flow.py
```

Expected: `test_missing_book_blocked_action_detected` now passes, and `test_real_flow_file_is_structurally_valid` now FAILS with an error listing `check-book-blocked` — the real flow file has not been updated yet. This is the intended red state for Step 5.

- [ ] **Step 5: Add the flow block**

In `connect-flows/wisecalls-voice-v1-dev.json`, change the `call-book-slot` action's `NextAction` from `check-book-result` to `check-book-blocked`. Its `Errors` transition stays pointed at `callback-unavailable-message`. The action becomes:

```json
    {
      "Identifier": "call-book-slot",
      "Type": "InvokeLambdaFunction",
      "Parameters": {
        "LambdaFunctionARN": "__BOOK_CALLBACK_SLOT_FUNCTION_ARN__",
        "InvocationTimeLimitSeconds": "8",
        "LambdaInvocationAttributes": { "slotKey": "$.Attributes.currentSlotKey", "reasonCategory": "$.Attributes.reasonCategory" }
      },
      "Transitions": {
        "NextAction": "check-book-blocked",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "callback-unavailable-message" } ]
      }
    },
```

Then insert this new action immediately after `call-book-slot` and before `check-book-result`:

```json
    {
      "Identifier": "check-book-blocked",
      "Type": "Compare",
      "Parameters": { "ComparisonValue": "$.External.retryable" },
      "Transitions": {
        "NextAction": "check-book-result",
        "Conditions": [ { "NextAction": "callback-unavailable-message", "Condition": { "Operator": "Equals", "Operands": ["false"] } } ],
        "Errors": [ { "ErrorType": "NoMatchingCondition", "NextAction": "check-book-result" } ]
      }
    },
```

Leave `check-book-result` and `booking-confirmed-message` exactly as they are. Both the default `NextAction` and the `NoMatchingCondition` error fall through to `check-book-result`, so a missing or unexpected `retryable` value degrades to today's behaviour rather than to a hard refusal.

- [ ] **Step 6: Run both test suites to verify they pass**

From `connect-flows/tests`:

```powershell
python test_validate_flow.py
```

Expected: `Ran 16 tests`, `OK`.

From the repository root:

```powershell
node --test tests/functions.test.js
```

Expected: PASS, `# pass 44` / `# fail 0` (unchanged by this task).

- [ ] **Step 7: Commit**

```bash
git add connect-flows/wisecalls-voice-v1-dev.json connect-flows/validate_flow.py connect-flows/tests/test_validate_flow.py
git commit -m "Route non-retryable callback booking failures to the unavailable message"
```

---

### Task 3: Surface the allowlist as a deployable parameter

**Files:**
- Modify: `infrastructure/template.yaml:106-109` (Parameters) and `infrastructure/template.yaml:1059-1065` (`BookCallbackSlotFunction`)
- Modify: `infrastructure/parameters.example.json`
- Modify: `scripts/validate.mjs:47`
- Modify: `docs/03-deployment-runbook.md:37`

**Interfaces:**
- Consumes: the `CALLBACK_ALLOWED_PHONE_PREFIXES` environment variable name read by Task 1's `allowedPrefixes()`.
- Produces: CloudFormation parameter `CallbackAllowedPhonePrefixes`. Nothing later in this plan depends on it.

- [ ] **Step 1: Write the failing validator check**

In `scripts/validate.mjs`, add the new parameter to the template marker list (currently line 47) so a future edit cannot silently drop it:

```js
for (const marker of ["ConnectInstanceArn:", "CustomerUserPool:", "CoreDataTable:", "KnowledgeAssistant:", "LocationFrontendDistribution:", "AgentUserPool:", "RedactionDemoTeardownFunction:", "CallbackAllowedPhonePrefixes:"]) {
```

- [ ] **Step 2: Run the validator to verify it fails**

```powershell
node .\scripts\validate.mjs
```

Expected: FAIL with `Error: Template marker missing: CallbackAllowedPhonePrefixes:`. Note this runs after the Node test suite, so you should see the 44 passing tests scroll past first.

- [ ] **Step 3: Add the parameter and wire it to the Lambda**

In `infrastructure/template.yaml`, add this parameter immediately after the existing `CallbackOutboundFlowId` parameter (which ends with its `Description:` line, currently line 109) and before the `Conditions:` block:

```yaml
  CallbackAllowedPhonePrefixes:
    Type: String
    Default: "+61491570156"
    Description: "Comma-separated E.164 prefixes permitted to book a scheduled callback. The default restricts booking to the operator's own number for the demo; set to '+614' afterwards to allow any Australian mobile. An empty value denies all bookings."
```

Then give `BookCallbackSlotFunction` its own environment block. The resource becomes:

```yaml
  BookCallbackSlotFunction:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: !Sub "${ProjectName}-${Environment}-book-callback-slot"
      CodeUri: ../functions/book-callback-slot/
      Handler: index.handler
      Role: !GetAtt BookCallbackSlotRole.Arn
      Environment:
        Variables:
          CALLBACK_ALLOWED_PHONE_PREFIXES: !Ref CallbackAllowedPhonePrefixes
```

SAM merges function-level `Environment.Variables` with the `Globals` block rather than replacing it, so `CALLBACK_BOOKING_TABLE` and the other shared variables are retained. `CallbackPollerFunction` in this same template already depends on that merge.

- [ ] **Step 4: Add the parameter to the example parameter file**

In `infrastructure/parameters.example.json`, add this entry after the `SecondaryServicePhoneNumberDisplay` line, remembering to add the trailing comma to that preceding line:

```json
  { "ParameterKey": "SecondaryServicePhoneNumberDisplay", "ParameterValue": "02 5550 0001" },
  { "ParameterKey": "CallbackAllowedPhonePrefixes", "ParameterValue": "+61491570156" }
```

- [ ] **Step 5: Document the parameter and the two-step deploy**

In `docs/03-deployment-runbook.md`, insert this paragraph immediately after the `AgentCognitoDomainPrefix` paragraph (currently line 37) and before the `## Phase B — local validation` heading:

```markdown
`CallbackAllowedPhonePrefixes` controls who may book a scheduled callback on option 7. It holds comma-separated E.164 prefixes; a full-length entry such as `+61491570156` is an exact match, and `+614` widens the feature to every Australian mobile. An empty value denies all bookings, so the allowlist fails closed. Changing this value takes effect through a stack update alone. Introducing the allowlist for the first time also requires republishing `wisecalls-voice-v1-dev` with `scripts/deploy-connect-flow.ps1`, because a blocked caller is routed by the `check-book-blocked` flow action; applying only the stack update leaves those callers looping through the day's remaining slots, and applying only the flow update leaves the allowlist unenforced. See `docs/superpowers/specs/2026-08-08-callback-phone-allowlist-design.md`.
```

- [ ] **Step 6: Run full local validation to verify it passes**

```powershell
node .\scripts\validate.mjs
```

Expected: the Node suite reports `# pass 44` / `# fail 0`, then `Local validation passed.`

Also re-run the flow validator from `connect-flows/tests` to confirm nothing regressed:

```powershell
python test_validate_flow.py
```

Expected: `Ran 16 tests`, `OK`.

- [ ] **Step 7: Commit**

```bash
git add infrastructure/template.yaml infrastructure/parameters.example.json scripts/validate.mjs docs/03-deployment-runbook.md
git commit -m "Expose callback allowlist as CallbackAllowedPhonePrefixes parameter"
```

---

## Deployment (operator, not part of implementation)

Both steps are required and neither is safe alone:

1. `scripts/deploy.ps1` — stack update carrying the new parameter and Lambda environment variable. Follow the repository's mandatory order in `CLAUDE.md`: dry run, then `-Execute -WhatIf` and change-set review, then `-Execute` only after explicit operator approval.
2. `scripts/deploy-connect-flow.ps1` — republish `wisecalls-voice-v1-dev`, which now contains `check-book-blocked`.

Manual acceptance after deploying, from the spec's test plan:

- Call from `+61491570156`, press 7, book a slot — confirmation plays and the outbound call fires as before.
- Call from any other number, press 7, accept a slot — the caller hears "Scheduled callbacks aren't available for the rest of today" and lands in the agent queue, and no new row appears in `CallbackBookingTable`.
- Regression: options 1-6 and 8 behave identically.

To widen after the demo: set `CallbackAllowedPhonePrefixes` to `+614` and rerun `scripts/deploy.ps1`. No code change, no flow change, no republish.
