# Connect Voice (Olivia/Neural) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set every prompt in the two WiseCalls-owned voice contact flows to speak with Amazon Polly's Olivia voice on the Neural engine, instead of the account's default voice.

**Architecture:** A single new `UpdateContactTextToSpeechVoice` ("Set voice") action is inserted at the very start of each flow, before its first prompt — one action per flow sets the voice for every subsequent text-to-speech prompt in that same flow.

**Tech Stack:** Amazon Connect classic contact-flow JSON (`Version: "2019-10-30"`), Python `unittest` for flow-structure tests.

## Global Constraints

- Account `111122223333`, region `ap-southeast-2`, Connect instance `wise-calls-org` (`arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`), profile `default` for every AWS CLI call.
- This work happens on the **already-created** worktree at `C:/project/amazon-connect/wisecalls-PoC/.claude/worktrees/connect-voice-grace`, branch `worktree-connect-voice-grace`, branched from `master` at `68635d7` — do not create another worktree.
- Voice is **Olivia**, engine is **neural** (not `standard` — Olivia doesn't support it, an unspecified engine defaults to `standard` and the block would take its error branch; not `generative` — real ongoing per-character billing, rejected on cost grounds during brainstorming).
- Scope is exactly the two WiseCalls-owned flows already tracked in this repository: `connect-flows/wisecalls-voice-v1-dev.json` and `connect-flows/wisecalls-callback-outbound-v1-dev.json`. No other flow (AWS sample flows, `VMX3_*`, `Default *`, `wise-calls-org-voicemail-ivr`, the untracked `wisecalls-public-chat-v1-dev`) is touched.
- **The exact JSON `Parameters` field names for `UpdateContactTextToSpeechVoice` are a best-effort reconstruction from AWS documentation, not yet confirmed against this account's real behavior.** Task 2 pushes the change to the real, live flows and must treat any `InvalidContactFlowException` as authoritative, fixing the JSON to match — the same verification approach that already worked for the voice-redaction-demo feature's `UpdateContactRecordingBehavior` action earlier this session (that feature's Type name and one nested field were both wrong on first guess, corrected via real AWS rejection messages and cross-referencing this account's own "Sample recording behavior" flow).
- **No coordination-check step is needed this time.** Every other feature this session needed to check for another concurrently-active branch's live AWS state before deploying; as of this plan, all three prior feature branches have already been merged to `master` and their worktrees cleaned up, so there is nothing else live to reconcile with. This is stated explicitly so a later reader doesn't wonder why the step is missing.
- This plan does not touch `infrastructure/template.yaml` at all — only flow content. There is no CloudFormation deploy step, only a flow-content push via `scripts/deploy-connect-flow.ps1`.

---

### Task 1: Insert the Set Voice action into both flows

**Files:**
- Modify: `connect-flows/wisecalls-voice-v1-dev.json`
- Modify: `connect-flows/wisecalls-callback-outbound-v1-dev.json`
- Modify: `connect-flows/validate_flow.py`
- Modify: `connect-flows/tests/test_validate_flow.py`

**Interfaces:**
- Produces: new action identifier `set-olivia-voice` in both flow files.

- [ ] **Step 1: Insert the action into `wisecalls-voice-v1-dev.json`**

In `connect-flows/wisecalls-voice-v1-dev.json`, find the `start-logging` action (search for `"Identifier": "start-logging"`, near the top of the `Actions` array):

```json
{
  "Identifier": "start-logging",
  "Type": "UpdateFlowLoggingBehavior",
  "Parameters": { "FlowLoggingBehavior": "Enabled" },
  "Transitions": { "NextAction": "set-public-state" }
}
```

Change its `Transitions.NextAction` from `"set-public-state"` to `"set-olivia-voice"`:

```json
{
  "Identifier": "start-logging",
  "Type": "UpdateFlowLoggingBehavior",
  "Parameters": { "FlowLoggingBehavior": "Enabled" },
  "Transitions": { "NextAction": "set-olivia-voice" }
}
```

Immediately after this action (before `set-public-state`), add the new action:

```json
{
  "Identifier": "set-olivia-voice",
  "Type": "UpdateContactTextToSpeechVoice",
  "Parameters": {
    "TextToSpeechVoice": "Olivia",
    "Engine": "neural"
  },
  "Transitions": {
    "NextAction": "set-public-state",
    "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "set-public-state" } ]
  }
},
```

Do not change `set-public-state` itself — its own `Type`/`Parameters`/`Transitions` are untouched, only what points at it (now `set-olivia-voice` instead of `start-logging`).

- [ ] **Step 2: Insert the action into `wisecalls-callback-outbound-v1-dev.json`**

In `connect-flows/wisecalls-callback-outbound-v1-dev.json`, find the `start-logging` action:

```json
{
  "Identifier": "start-logging",
  "Type": "UpdateFlowLoggingBehavior",
  "Parameters": { "FlowLoggingBehavior": "Enabled" },
  "Transitions": { "NextAction": "greeting" }
}
```

Change its `Transitions.NextAction` from `"greeting"` to `"set-olivia-voice"`:

```json
{
  "Identifier": "start-logging",
  "Type": "UpdateFlowLoggingBehavior",
  "Parameters": { "FlowLoggingBehavior": "Enabled" },
  "Transitions": { "NextAction": "set-olivia-voice" }
}
```

Immediately after this action (before `greeting`), add the same new action (identical `Parameters` to Task 1 Step 1, only the `NextAction`/error target differ since this flow's first prompt is `greeting`, not `set-public-state`):

```json
{
  "Identifier": "set-olivia-voice",
  "Type": "UpdateContactTextToSpeechVoice",
  "Parameters": {
    "TextToSpeechVoice": "Olivia",
    "Engine": "neural"
  },
  "Transitions": {
    "NextAction": "greeting",
    "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "greeting" } ]
  }
},
```

This second file has no `validate_flow.py`-based structural test coverage of its own today (that script and its tests only exercise `wisecalls-voice-v1-dev.json`) — this is a pre-existing gap in this repo's tooling, not something this plan closes. Adding coverage for a second flow file is a real, separate piece of test-infrastructure work and is out of scope for a voice-only change; do not build it as a side effect here.

- [ ] **Step 3: Update `validate_flow.py`'s required-actions set and regression list**

In `connect-flows/validate_flow.py`, add `"set-olivia-voice"` to the `REQUIRED_NEW_ACTIONS` frozenset:

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
    "credit-card-notice",
    "enable-redaction-analytics",
    "set-olivia-voice",
})
```

In the same file's `main()` function, find the `unchanged_ids` list (search for `"start-logging", "set-public-state"`). Remove `"start-logging"` from this list — Step 1 intentionally changes its `Transitions.NextAction`, so the existing regression check would otherwise flag this plan's own required change as a false regression. Add a comment explaining why, matching this list's existing comment style:

```python
        unchanged_ids = [
            # Note: start-logging is deliberately excluded from this list. The
            # connect-voice-grace feature changes its Transitions.NextAction to
            # point at the new set-olivia-voice action instead of directly at
            # set-public-state — an intentional change, not a regression.
            "set-public-state", "call-identify-module", "check-identify-result",
            "greeting-known", "call-start-otp-module", "collect-otp", "save-otp-input",
            "call-verify-otp-module", "check-verify-result", "set-verified-true", "verified-message",
            "verification-failed-message", "greeting-unknown", "invalid-input", "invoke-product-rate",
            "call-product-rate-module", "call-create-location-module", "location-result-message",
            "rate-result-message", "invoke-atm-locator", "set-target-queue", "escalate-to-queue",
            "end-call",
            # Note: call-identify-caller-reset and invoke-reset-bot are deliberately excluded
            # here even though they were added by the password-reset change. Both hold
            # deploy-time ARN placeholders (__IDENTIFY_CALLER_FUNCTION_ARN__,
            # __PASSWORD_RESET_BOT_ALIAS_ARN__) in this source file that scripts/deploy-connect-flow.ps1
            # substitutes with real ARNs before deploy — so the live baseline fetched from AWS will
            # always show concrete ARNs there, which is not a genuine content regression. The same
            # exclusion is already reflected in tests/test_validate_flow.py's EXISTING_UNCHANGED_ACTIONS.
            "check-reset-candidate", "reset-unavailable-message",
            "set-reset-attributes", "reset-otp-prompt", "check-reset-outcome",
            "reset-success-message", "reset-failed-message", "transfer-to-voicemail",
        ]
```

- [ ] **Step 4: Update `test_validate_flow.py` to match**

In `connect-flows/tests/test_validate_flow.py`, add `"set-olivia-voice"` to the module-level `REQUIRED_NEW_ACTIONS` list:

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
    "credit-card-notice",
    "enable-redaction-analytics",
    "set-olivia-voice",
]
```

Remove `"start-logging"` from `EXISTING_UNCHANGED_ACTIONS`, mirroring Step 3's change and reasoning:

```python
EXISTING_UNCHANGED_ACTIONS = [
    # Note: start-logging is deliberately excluded — see the matching comment
    # in validate_flow.py's unchanged_ids for why.
    "set-public-state", "call-identify-module", "check-identify-result",
    "greeting-known", "call-start-otp-module", "collect-otp", "save-otp-input",
    "call-verify-otp-module", "check-verify-result", "set-verified-true", "verified-message",
    "verification-failed-message", "greeting-unknown", "invalid-input", "invoke-product-rate",
    "call-product-rate-module", "call-create-location-module", "location-result-message",
    "rate-result-message", "invoke-atm-locator", "set-target-queue", "escalate-to-queue",
    "end-call",
]
```

Add a new test method, mirroring the existing `test_missing_callback_action_detected` pattern:

```python
    def test_missing_voice_action_detected(self):
        content = _minimal_valid_content()
        content["Actions"] = [a for a in content["Actions"] if a["Identifier"] != "set-olivia-voice"]
        main_menu = next(a for a in content["Actions"] if a["Identifier"] == "main-menu")
        main_menu["Transitions"]["Conditions"] = [
            c for c in main_menu["Transitions"]["Conditions"] if c["NextAction"] != "set-olivia-voice"
        ]
        errors = validate_flow.validate(content)
        self.assertTrue(any("set-olivia-voice" in e for e in errors))
```

- [ ] **Step 5: Run the Python tests**

```powershell
py -3.11 -m unittest discover -s connect-flows/tests -v
```
Expected: all tests pass, including the new one.

- [ ] **Step 6: Run structural validation on both real flow files**

```powershell
py -3.11 connect-flows/validate_flow.py connect-flows/wisecalls-voice-v1-dev.json
py -3.11 connect-flows/validate_flow.py connect-flows/wisecalls-callback-outbound-v1-dev.json
```
Expected: `Flow content is structurally valid.` for both.

- [ ] **Step 7: Commit**

```bash
git add connect-flows/wisecalls-voice-v1-dev.json connect-flows/wisecalls-callback-outbound-v1-dev.json connect-flows/validate_flow.py connect-flows/tests/test_validate_flow.py
git commit -m "Set Olivia/Neural voice at the start of both WiseCalls-owned voice flows"
```

---

### Task 2: Deploy and verify

**Files:** none — uses Task 1's flow content.

**Interfaces:** none new.

- [ ] **Step 1: Push the updated main flow content**

```powershell
.\scripts\deploy-connect-flow.ps1 -Region ap-southeast-2 -ConnectInstanceArn arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee -FlowId 790c287e-1663-4dcf-844c-f180891bca52 -AdPasswordResetStackName wisecalls-dev-ad-reset -Profile default
```

Run this once **without** `-Execute` first (the default) to see the dry-run parameter substitution and confirm the script completes structural validation cleanly.

**STOP and get explicit operator approval before executing** — this modifies the same live `wisecalls-voice-v1-dev` flow every other feature this session has deployed to.

```powershell
.\scripts\deploy-connect-flow.ps1 -Region ap-southeast-2 -ConnectInstanceArn arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee -FlowId 790c287e-1663-4dcf-844c-f180891bca52 -AdPasswordResetStackName wisecalls-dev-ad-reset -Profile default -Execute
```

If this fails with `InvalidContactFlowException`, the error message names the exact problem. Per this plan's Global Constraints, fix `set-olivia-voice`'s JSON in both flow files based on that message. If the error is unclear, cross-reference this account's own existing flows for one that already uses a `UpdateContactTextToSpeechVoice` action: `aws connect list-contact-flows --instance-id aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee --region ap-southeast-2 --profile default --query "ContactFlowSummaryList[].{Name:Name,Id:Id}"`, then `aws connect describe-contact-flow --instance-id aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee --contact-flow-id <id> --region ap-southeast-2 --profile default --query "ContactFlow.Content" --output text | grep -A5 UpdateContactTextToSpeechVoice` on any promising candidate (the "Sample inbound flow" and other AWS-provided sample flows are worth checking first, the same way "Sample recording behavior" resolved the equivalent uncertainty for the voice-redaction-demo feature). Re-run Task 1 Step 6's structural validation after any fix, then retry this step. Do not proceed until this push succeeds.

- [ ] **Step 2: Verify the main flow push landed**

```powershell
$live = aws connect describe-contact-flow --instance-id aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee --contact-flow-id 790c287e-1663-4dcf-844c-f180891bca52 --output json --region ap-southeast-2 --profile default | ConvertFrom-Json
if ($live.ContactFlow.Content -notmatch 'set-olivia-voice') { throw 'Post-deploy verification failed: live content does not contain the new set-olivia-voice action.' }
Write-Host 'Deploy verified: live main flow content now sets the Olivia voice.'
```

- [ ] **Step 3: Push the outbound flow content**

This flow has no dedicated deploy script (`scripts/deploy-connect-flow.ps1` is hardcoded to the main flow's substitution needs, and this flow has no `__ARN__`-style placeholders to substitute at all — its content is deployed as-is). Push it directly:

```powershell
aws connect update-contact-flow-content --instance-id aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee --contact-flow-id a2c58810-83c5-42c7-b469-3e8d045190f1 --content "file://connect-flows/wisecalls-callback-outbound-v1-dev.json" --region ap-southeast-2 --profile default
```

If this fails with `InvalidContactFlowException`, apply the same fix-and-retry approach as Step 1 — by this point in the task the correct JSON shape should already be known from fixing the main flow, so this push is expected to succeed on the first attempt using that now-corrected shape.

- [ ] **Step 4: Verify the outbound flow push landed**

```powershell
$liveOutbound = aws connect describe-contact-flow --instance-id aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee --contact-flow-id a2c58810-83c5-42c7-b469-3e8d045190f1 --output json --region ap-southeast-2 --profile default | ConvertFrom-Json
if ($liveOutbound.ContactFlow.Content -notmatch 'set-olivia-voice') { throw 'Post-deploy verification failed: live outbound flow content does not contain the new set-olivia-voice action.' }
Write-Host 'Deploy verified: live outbound flow content now sets the Olivia voice.'
```

- [ ] **Step 5: Run the acceptance checklist**

A real phone call is required for all 3 checks; this cannot be scripted by an agent. Record pass/fail for each:

1. Call the main WiseCalls number, listen through several prompts (the greeting and the main menu) — confirm they sound like Olivia (natural, Australian-accented), not the prior default voice.
2. Trigger a scheduled callback (via IVR option 7) and answer it — confirm the outbound greeting also uses Olivia.
3. Start a chat session — confirm it still works normally, with no visible change (the voice change has no effect on chat, as documented; this is a regression check that nothing else was disturbed).

Do not consider this feature ready to use until all 3 checks pass.
