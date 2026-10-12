# IVR password-reset + voicemail menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add DTMF options 5 (password reset) and 6 (voicemail) to the existing, not-yet-live `wisecalls-voice-v1-dev` Connect flow, per `docs/superpowers/specs/2026-08-02-ivr-password-reset-menu-design.md`.

**Architecture:** A single new JSON file (`connect-flows/wisecalls-voice-v1-dev.json`) becomes the source of truth for the flow's content, replacing the current unversioned, only-in-AWS content. A Python validator checks structural integrity and regression-protects options 1-4 before anything is pushed. A PowerShell deploy script substitutes live ARNs from the `ad-password-reset` stack outputs and calls `aws connect update-contact-flow-content`, dry-run by default.

**Tech Stack:** Amazon Connect classic Contact Flow JSON (`Version: 2019-10-30`), Python 3.11 (validator + tests, stdlib only — no new dependency), PowerShell 7 (deploy script), AWS CLI v2.

## Global Constraints

- This directory is **not a git repository** (confirmed at plan-writing time). Skip every `git add`/`git commit` step below — save files to disk and move on. If a repository has since been initialized, ask the operator before starting to commit rather than assuming this plan's steps should now include it.
- Never put the full phone, directory username, OTP, password, home address, or customer ID into contact attributes, Lex slots, transcripts, CTRs, agent notes, prompts, or logs (`ad-password-reset/docs/security.md`, `docs/connect-flow.md`).
- Fail closed: any Lambda/Lex error or timeout in the new branch routes to the same agent queue used by option 3 (`set-target-queue` → `escalate-to-queue`), never to a success state.
- Do not edit `wise-calls-org-voicemail-ivr` (Id `05d92d19-1fc1-4540-a3f5-91dda3584ec5`) in place — reference it only via `TransferToFlow`.
- Do not assign the live Wise Calls Org phone number to `wisecalls-voice-v1-dev` (Id `790c287e-1663-4dcf-844c-f180891bca52`) without explicit operator approval after acceptance testing (Task 5).
- **Hard prerequisite:** the `ad-password-reset` SAM stack must already be deployed — Task 3's ARN substitution reads its CloudFormation outputs (`IdentifyCallerFunctionArn`, `LexBotAliasArn`) and Tasks 3-4 will fail with a clear `describe-stacks` error if it isn't deployed yet. That deployment is tracked separately in this session, not by this plan.
- Account/region for every AWS CLI call: `111122223333` / `ap-southeast-2`, profile `default`.
- Connect instance ARN: `arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`.

---

### Task 1: Flow-content validator

**Files:**
- Create: `connect-flows/validate_flow.py`
- Test: `connect-flows/tests/test_validate_flow.py`

**Interfaces:**
- Produces: `validate_flow.load_actions(content: dict) -> dict[str, dict]`, `validate_flow.validate(content: dict) -> list[str]` (empty list = valid), `validate_flow.unchanged_actions(new_content: dict, original_content: dict, identifiers: list[str]) -> list[str]` (returns identifiers whose action body differs), `validate_flow.main() -> int` (CLI entry point, exit 0/1/2).
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing tests**

Create `connect-flows/tests/test_validate_flow.py`:

```python
import importlib
import json
import os
import sys
import unittest

FLOWS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
REPO_ROOT = os.path.abspath(os.path.join(FLOWS_DIR, ".."))
sys.path.insert(0, FLOWS_DIR)
validate_flow = importlib.import_module("validate_flow")

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
]

EXISTING_UNCHANGED_ACTIONS = [
    "start-logging", "set-public-state", "call-identify-module", "check-identify-result",
    "greeting-known", "call-start-otp-module", "collect-otp", "save-otp-input",
    "call-verify-otp-module", "check-verify-result", "set-verified-true", "verified-message",
    "verification-failed-message", "greeting-unknown", "invalid-input", "invoke-product-rate",
    "call-product-rate-module", "call-create-location-module", "location-result-message",
    "rate-result-message", "invoke-atm-locator", "set-target-queue", "escalate-to-queue",
    "end-call",
]


def _stub(identifier, next_action="end-call", text=""):
    action = {
        "Identifier": identifier,
        "Type": "MessageParticipant",
        "Parameters": {"Text": text},
        "Transitions": {"NextAction": next_action, "Errors": []},
    }
    return action


def _minimal_valid_content():
    actions = [_stub(i) for i in REQUIRED_NEW_ACTIONS]
    actions.append({
        "Identifier": "main-menu",
        "Type": "GetParticipantInput",
        "Parameters": {"Text": "menu"},
        "Transitions": {
            "NextAction": "end-call",
            "Conditions": [
                {"NextAction": "end-call", "Condition": {"Operator": "Equals", "Operands": ["1"]}},
                {"NextAction": "end-call", "Condition": {"Operator": "Equals", "Operands": ["2"]}},
                {"NextAction": "end-call", "Condition": {"Operator": "Equals", "Operands": ["3"]}},
                {"NextAction": "end-call", "Condition": {"Operator": "Equals", "Operands": ["4"]}},
                {"NextAction": "call-identify-caller-reset", "Condition": {"Operator": "Equals", "Operands": ["5"]}},
                {"NextAction": "transfer-to-voicemail", "Condition": {"Operator": "Equals", "Operands": ["6"]}},
            ],
            "Errors": [],
        },
    })
    actions.append({
        "Identifier": "end-call",
        "Type": "DisconnectParticipant",
        "Parameters": {},
        "Transitions": {},
    })
    return {"Version": "2019-10-30", "StartAction": "main-menu", "Actions": actions}


class ValidateFlowTests(unittest.TestCase):
    def test_valid_minimal_content_passes(self):
        self.assertEqual(validate_flow.validate(_minimal_valid_content()), [])

    def test_dangling_reference_detected(self):
        content = _minimal_valid_content()
        content["Actions"].append(_stub("dangling", next_action="does-not-exist"))
        errors = validate_flow.validate(content)
        self.assertTrue(any("does-not-exist" in e for e in errors))

    def test_duplicate_identifier_raises(self):
        content = _minimal_valid_content()
        content["Actions"].append(_stub("main-menu"))
        with self.assertRaises(ValueError):
            validate_flow.load_actions(content)

    def test_main_menu_missing_option_detected(self):
        content = _minimal_valid_content()
        main_menu = next(a for a in content["Actions"] if a["Identifier"] == "main-menu")
        main_menu["Transitions"]["Conditions"] = [
            c for c in main_menu["Transitions"]["Conditions"]
            if c["Condition"]["Operands"] != ["6"]
        ]
        errors = validate_flow.validate(content)
        self.assertTrue(any("'6'" in e for e in errors))

    def test_forbidden_text_substring_detected(self):
        content = _minimal_valid_content()
        leaky = next(a for a in content["Actions"] if a["Identifier"] == "reset-otp-prompt")
        leaky["Parameters"]["Text"] = "Your session is $.External.resetSessionId"
        errors = validate_flow.validate(content)
        self.assertTrue(any("resetSessionId" in e for e in errors))

    def test_missing_required_action_detected(self):
        content = _minimal_valid_content()
        content["Actions"] = [a for a in content["Actions"] if a["Identifier"] != "transfer-to-voicemail"]
        main_menu = next(a for a in content["Actions"] if a["Identifier"] == "main-menu")
        main_menu["Transitions"]["Conditions"] = [
            c for c in main_menu["Transitions"]["Conditions"]
            if c["NextAction"] != "transfer-to-voicemail"
        ]
        errors = validate_flow.validate(content)
        self.assertTrue(any("transfer-to-voicemail" in e for e in errors))

    def test_unchanged_actions_detects_regression(self):
        original = _minimal_valid_content()
        original["Actions"].append(_stub("invoke-product-rate", text="original"))
        changed = _minimal_valid_content()
        changed["Actions"].append(_stub("invoke-product-rate", text="mutated"))
        diffs = validate_flow.unchanged_actions(changed, original, ["invoke-product-rate"])
        self.assertEqual(diffs, ["invoke-product-rate"])

    def test_real_flow_file_is_structurally_valid(self):
        real_path = os.path.join(FLOWS_DIR, "wisecalls-voice-v1-dev.json")
        if not os.path.exists(real_path):
            self.skipTest("Task 2 has not created connect-flows/wisecalls-voice-v1-dev.json yet")
        content = json.loads(open(real_path, encoding="utf-8").read())
        self.assertEqual(validate_flow.validate(content), [])

    def test_real_flow_file_preserves_existing_options(self):
        real_path = os.path.join(FLOWS_DIR, "wisecalls-voice-v1-dev.json")
        backup_path = os.path.join(
            REPO_ROOT, "connect-backup", "flow-790c287e-1663-4dcf-844c-f180891bca52.json"
        )
        if not (os.path.exists(real_path) and os.path.exists(backup_path)):
            self.skipTest("Task 2 has not created connect-flows/wisecalls-voice-v1-dev.json yet")
        new_content = json.loads(open(real_path, encoding="utf-8").read())
        backup_wrapper = json.loads(open(backup_path, encoding="utf-8").read())
        original_content = json.loads(backup_wrapper["ContactFlow"]["Content"])
        diffs = validate_flow.unchanged_actions(new_content, original_content, EXISTING_UNCHANGED_ACTIONS)
        self.assertEqual(diffs, [])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m unittest connect-flows.tests.test_validate_flow -v` (from repo root)
Expected: `ModuleNotFoundError: No module named 'validate_flow'` (the module doesn't exist yet).

- [ ] **Step 3: Write the validator**

Create `connect-flows/validate_flow.py`:

```python
"""Structural validator for Amazon Connect classic contact-flow JSON."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

FORBIDDEN_TEXT_SUBSTRINGS = (
    "resetSessionId",
    "otpHash",
    "directoryUserName",
    "phoneE164",
    "homeAddress",
)

REQUIRED_MAIN_MENU_OPTIONS = ("1", "2", "3", "4", "5", "6")

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
})


def load_actions(content: dict[str, Any]) -> dict[str, dict[str, Any]]:
    actions: dict[str, dict[str, Any]] = {}
    for action in content.get("Actions", []):
        identifier = action["Identifier"]
        if identifier in actions:
            raise ValueError(f"Duplicate Identifier: {identifier}")
        actions[identifier] = action
    return actions


def referenced_targets(action: dict[str, Any]) -> list[str]:
    targets: list[str] = []
    transitions = action.get("Transitions", {})
    if "NextAction" in transitions:
        targets.append(transitions["NextAction"])
    for condition in transitions.get("Conditions", []):
        targets.append(condition["NextAction"])
    for error in transitions.get("Errors", []):
        targets.append(error["NextAction"])
    return targets


def validate(content: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    actions = load_actions(content)

    start = content.get("StartAction")
    if start not in actions:
        errors.append(f"StartAction '{start}' is not a defined Identifier")

    for identifier, action in actions.items():
        for target in referenced_targets(action):
            if target not in actions:
                errors.append(f"{identifier}: transition target '{target}' is not a defined Identifier")
        text = action.get("Parameters", {}).get("Text", "") or ""
        for forbidden in FORBIDDEN_TEXT_SUBSTRINGS:
            if forbidden in text:
                errors.append(f"{identifier}: spoken Text references forbidden value '{forbidden}'")

    main_menu = actions.get("main-menu")
    if main_menu is None:
        errors.append("main-menu action is missing")
    else:
        operands = {
            condition["Condition"]["Operands"][0]
            for condition in main_menu.get("Transitions", {}).get("Conditions", [])
        }
        missing = set(REQUIRED_MAIN_MENU_OPTIONS) - operands
        if missing:
            errors.append(f"main-menu is missing DTMF options: {sorted(missing)}")

    missing_actions = REQUIRED_NEW_ACTIONS - actions.keys()
    if missing_actions:
        errors.append(f"Missing required password-reset/voicemail actions: {sorted(missing_actions)}")

    return errors


def unchanged_actions(
    new_content: dict[str, Any], original_content: dict[str, Any], identifiers: list[str]
) -> list[str]:
    """Return identifiers whose action body differs between new_content and original_content."""
    new_actions = load_actions(new_content)
    original_actions = load_actions(original_content)
    return [i for i in identifiers if new_actions.get(i) != original_actions.get(i)]


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: validate_flow.py <flow-content.json> [original-content.json]", file=sys.stderr)
        return 2
    content = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    errors = validate(content)
    if len(sys.argv) >= 3:
        original = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
        unchanged_ids = [
            "start-logging", "set-public-state", "call-identify-module", "check-identify-result",
            "greeting-known", "call-start-otp-module", "collect-otp", "save-otp-input",
            "call-verify-otp-module", "check-verify-result", "set-verified-true", "verified-message",
            "verification-failed-message", "greeting-unknown", "invalid-input", "invoke-product-rate",
            "call-product-rate-module", "call-create-location-module", "location-result-message",
            "rate-result-message", "invoke-atm-locator", "set-target-queue", "escalate-to-queue",
            "end-call",
        ]
        changed = unchanged_actions(content, original, unchanged_ids)
        if changed:
            errors.append(f"Regression: these existing actions changed unexpectedly: {changed}")
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print("Flow content is structurally valid.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m unittest connect-flows.tests.test_validate_flow -v` (from repo root)
Expected: `test_real_flow_file_is_structurally_valid` and `test_real_flow_file_preserves_existing_options` report `skipped` (Task 2 not done yet); the other 6 tests `PASS`.

- [ ] **Step 5: Save checkpoint**

No git repository is present (see Global Constraints) — nothing to commit. Move to Task 2.

---

### Task 2: Author the updated flow content

**Files:**
- Create: `connect-flows/wisecalls-voice-v1-dev.json`

**Interfaces:**
- Consumes: `connect-flows/validate_flow.py` (Task 1) to self-check before this task is considered done.
- Produces: the exact JSON payload Task 3/4 will substitute ARNs into and push via `update-contact-flow-content`.

- [ ] **Step 1: Write the file**

Create `connect-flows/wisecalls-voice-v1-dev.json`. This is the full current content of live flow `790c287e-1663-4dcf-844c-f180891bca52` (pulled 2026-08-02 via read-only `describe-contact-flow`, preserved verbatim in `connect-backup/flow-790c287e-1663-4dcf-844c-f180891bca52.json`) with: `main-menu`'s `Text` and `Transitions.Conditions` extended for options 5/6, and ten new actions appended. Two tokens — `__IDENTIFY_CALLER_FUNCTION_ARN__` and `__PASSWORD_RESET_BOT_ALIAS_ARN__` — are placeholders Task 3's script substitutes from live CloudFormation stack outputs at deploy time; they are not secrets and are not guesses, they're resolved mechanically from `ad-password-reset`'s `IdentifyCallerFunctionArn` / `LexBotAliasArn` stack outputs (see `ad-password-reset/infrastructure/template.yaml` Outputs).

```json
{
  "Version": "2019-10-30",
  "StartAction": "start-logging",
  "Metadata": {
    "Annotations": [
      {
        "type": "default",
        "id": "note-ai-agent-voice",
        "content": "OPTIONAL ENHANCEMENT: replace this DTMF menu with the Amazon Q in Connect AI Agent (voice conversational self-service) block. AI Agent resources already exist and are published: Public Self Service = 44c11800-b308-46c9-b2bf-a4ca6db48891 (before verification), Authenticated Self Service = 03a8ea78-c09b-41ea-b8e2-7e34b2f3d1eb (after verification). Both use assistant 7cfe1848-2fa2-4cf5-9799-40c474ec2a8f and knowledge base 1ee99728-47f1-4b3c-a0d7-0bb3bcf61384. Console step: add the AI Agent block, pick the matching agent ID, and associate the wisecalls-* flow modules as its tools. Cases lookup (get_recent_cases) additionally needs a Customer Profiles profileArn resolution step not yet built here.",
        "actionId": "main-menu",
        "isFolded": false
      },
      {
        "type": "default",
        "id": "note-verify",
        "content": "Real Lambda-based verification is wired here: identify_by_phone looks up the caller's ANI in CoreDataTable (GSI1 PHONE#<e164>), start_otp_verification sends a 6-digit SMS OTP via SNS to the phone on file (90s TTL, enforced server-side in the Lambda regardless of DynamoDB's own TTL sweep timing), verify_otp checks it and only then sets customerVerified=true. NOTE: this account's SNS SMS is in sandbox mode ($1/month limit) — add real test numbers as verified sandbox destinations or request production SMS access before testing with arbitrary numbers.",
        "actionId": "call-identify-module",
        "isFolded": false
      },
      {
        "type": "default",
        "id": "note-password-reset",
        "content": "Password reset (option 5) calls ad-password-reset's IdentifyCallerFunction Lambda and PasswordResetBot Lex V2 alias directly. This is a SEPARATE identify+OTP pipeline from the generic CoreDataTable verification above (call-identify-module/collect-otp/etc): it checks CustomerDirectoryTable fields (status, passwordResetAllowed, privilegedAccount, directoryUserName) the generic verification never sees. A caller may be asked for two different OTPs in the same call if they use both features — that is intentional, not a bug. See ad-password-reset/docs/connect-flow.md and docs/superpowers/specs/2026-08-02-ivr-password-reset-menu-design.md. Option 6 hands off entirely to the live wise-calls-org-voicemail-ivr flow via TransferToFlow — that flow's own content is never modified by this file.",
        "actionId": "call-identify-caller-reset",
        "isFolded": false
      }
    ]
  },
  "Actions": [
    {
      "Identifier": "start-logging",
      "Type": "UpdateFlowLoggingBehavior",
      "Parameters": { "FlowLoggingBehavior": "Enabled" },
      "Transitions": { "NextAction": "set-public-state" }
    },
    {
      "Identifier": "set-public-state",
      "Type": "UpdateContactAttributes",
      "Parameters": {
        "Attributes": { "customerVerified": "false", "trustState": "PUBLIC", "phone": "$.CustomerEndpoint.Address" },
        "TargetContact": "Current"
      },
      "Transitions": {
        "NextAction": "call-identify-module",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "call-identify-module" } ]
      }
    },
    {
      "Identifier": "call-identify-module",
      "Type": "InvokeFlowModule",
      "Parameters": { "FlowModuleId": "2eb549de-406f-49dd-91cf-fa8219e49cb4" },
      "Transitions": {
        "NextAction": "check-identify-result",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "greeting-unknown" } ]
      }
    },
    {
      "Identifier": "check-identify-result",
      "Type": "Compare",
      "Parameters": { "ComparisonValue": "$.Attributes.identify_found" },
      "Transitions": {
        "NextAction": "greeting-unknown",
        "Conditions": [ { "NextAction": "greeting-known", "Condition": { "Operator": "Equals", "Operands": ["true"] } } ],
        "Errors": [ { "ErrorType": "NoMatchingCondition", "NextAction": "greeting-unknown" } ]
      }
    },
    {
      "Identifier": "greeting-known",
      "Type": "MessageParticipant",
      "Parameters": { "Text": "Thanks for calling WiseCalls, $.Attributes.identify_firstName. To verify it's really you, we'll text a code to the mobile number on file." },
      "Transitions": {
        "NextAction": "call-start-otp-module",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "main-menu" } ]
      }
    },
    {
      "Identifier": "call-start-otp-module",
      "Type": "InvokeFlowModule",
      "Parameters": { "FlowModuleId": "d2b36350-dff2-4f95-a5a2-f10abbafbe90" },
      "Transitions": {
        "NextAction": "collect-otp",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "main-menu" } ]
      }
    },
    {
      "Identifier": "collect-otp",
      "Type": "GetParticipantInput",
      "Parameters": {
        "Text": "Please enter the 6 digit code we just texted you, then press pound. It expires in 90 seconds.",
        "StoreInput": "True",
        "InputTimeLimitSeconds": "90",
        "InputValidation": { "CustomValidation": { "MaximumLength": "6" } }
      },
      "Transitions": {
        "NextAction": "save-otp-input",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "main-menu" } ]
      }
    },
    {
      "Identifier": "save-otp-input",
      "Type": "UpdateContactAttributes",
      "Parameters": { "Attributes": { "otp_entered": "$.StoredCustomerInput" }, "TargetContact": "Current" },
      "Transitions": {
        "NextAction": "call-verify-otp-module",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "main-menu" } ]
      }
    },
    {
      "Identifier": "call-verify-otp-module",
      "Type": "InvokeFlowModule",
      "Parameters": { "FlowModuleId": "9f61f43c-3b3c-49c8-b5b4-013064ee700e" },
      "Transitions": {
        "NextAction": "check-verify-result",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "main-menu" } ]
      }
    },
    {
      "Identifier": "check-verify-result",
      "Type": "Compare",
      "Parameters": { "ComparisonValue": "$.Attributes.otp_verified" },
      "Transitions": {
        "NextAction": "verification-failed-message",
        "Conditions": [ { "NextAction": "set-verified-true", "Condition": { "Operator": "Equals", "Operands": ["true"] } } ],
        "Errors": [ { "ErrorType": "NoMatchingCondition", "NextAction": "verification-failed-message" } ]
      }
    },
    {
      "Identifier": "set-verified-true",
      "Type": "UpdateContactAttributes",
      "Parameters": { "Attributes": { "customerVerified": "true", "customerId": "$.Attributes.identify_customerId" }, "TargetContact": "Current" },
      "Transitions": {
        "NextAction": "verified-message",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "main-menu" } ]
      }
    },
    {
      "Identifier": "verified-message",
      "Type": "MessageParticipant",
      "Parameters": { "Text": "Thanks, $.Attributes.identify_firstName. You're verified." },
      "Transitions": {
        "NextAction": "main-menu",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "main-menu" } ]
      }
    },
    {
      "Identifier": "verification-failed-message",
      "Type": "MessageParticipant",
      "Parameters": { "Text": "Sorry, that code didn't match or has expired. I'll continue without verifying you for now." },
      "Transitions": {
        "NextAction": "main-menu",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "main-menu" } ]
      }
    },
    {
      "Identifier": "greeting-unknown",
      "Type": "MessageParticipant",
      "Parameters": { "Text": "Thanks for calling WiseCalls." },
      "Transitions": {
        "NextAction": "main-menu",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "main-menu" } ]
      }
    },
    {
      "Identifier": "main-menu",
      "Type": "GetParticipantInput",
      "Parameters": {
        "StoreInput": "False",
        "InputTimeLimitSeconds": "8",
        "Text": "For our current product rates, press 1. For the nearest branch or ATM, press 2. To speak with an agent, press 3. To share your location securely, press 4. To reset your directory password, press 5. To leave a voicemail message, press 6."
      },
      "Transitions": {
        "NextAction": "invalid-input",
        "Conditions": [
          { "NextAction": "invoke-product-rate", "Condition": { "Operator": "Equals", "Operands": ["1"] } },
          { "NextAction": "invoke-atm-locator", "Condition": { "Operator": "Equals", "Operands": ["2"] } },
          { "NextAction": "set-target-queue", "Condition": { "Operator": "Equals", "Operands": ["3"] } },
          { "NextAction": "call-create-location-module", "Condition": { "Operator": "Equals", "Operands": ["4"] } },
          { "NextAction": "call-identify-caller-reset", "Condition": { "Operator": "Equals", "Operands": ["5"] } },
          { "NextAction": "transfer-to-voicemail", "Condition": { "Operator": "Equals", "Operands": ["6"] } }
        ],
        "Errors": [
          { "ErrorType": "InputTimeLimitExceeded", "NextAction": "set-target-queue" },
          { "ErrorType": "NoMatchingCondition", "NextAction": "invalid-input" },
          { "ErrorType": "NoMatchingError", "NextAction": "set-target-queue" }
        ]
      }
    },
    {
      "Identifier": "invalid-input",
      "Type": "MessageParticipant",
      "Parameters": { "Text": "Sorry, I did not get that." },
      "Transitions": {
        "NextAction": "main-menu",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "set-target-queue" } ]
      }
    },
    {
      "Identifier": "invoke-product-rate",
      "Type": "UpdateContactAttributes",
      "Parameters": { "Attributes": { "productCode": "CAR_LOAN_STANDARD" }, "TargetContact": "Current" },
      "Transitions": {
        "NextAction": "call-product-rate-module",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "set-target-queue" } ]
      }
    },
    {
      "Identifier": "call-product-rate-module",
      "Type": "InvokeFlowModule",
      "Parameters": { "FlowModuleId": "672c33e4-d41e-4aff-ad52-a9883aff6c6e" },
      "Transitions": {
        "NextAction": "rate-result-message",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "set-target-queue" } ]
      }
    },
    {
      "Identifier": "call-create-location-module",
      "Type": "InvokeFlowModule",
      "Parameters": { "FlowModuleId": "1f300764-1c7f-4f41-9a4c-221f3f49c3c0" },
      "Transitions": {
        "NextAction": "location-result-message",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "set-target-queue" } ]
      }
    },
    {
      "Identifier": "location-result-message",
      "Type": "MessageParticipant",
      "Parameters": { "Text": "We've texted you a secure link to the mobile number on file. Open it, sign in, and grant location permission to share your current position with us." },
      "Transitions": {
        "NextAction": "end-call",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "end-call" } ]
      }
    },
    {
      "Identifier": "rate-result-message",
      "Type": "MessageParticipant",
      "Parameters": { "Text": "One moment while I retrieve the current published rate for our standard car loan product. An agent can confirm the exact figures, or this will be read by the voice AI agent once configured." },
      "Transitions": {
        "NextAction": "end-call",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "end-call" } ]
      }
    },
    {
      "Identifier": "invoke-atm-locator",
      "Type": "MessageParticipant",
      "Parameters": { "Text": "To find your nearest branch or ATM, please stay on the line and an agent will assist, or use our mobile app to share your location." },
      "Transitions": {
        "NextAction": "end-call",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "end-call" } ]
      }
    },
    {
      "Identifier": "call-identify-caller-reset",
      "Type": "InvokeLambdaFunction",
      "Parameters": {
        "LambdaFunctionARN": "__IDENTIFY_CALLER_FUNCTION_ARN__",
        "InvocationTimeLimitSeconds": "8",
        "ResponseValidation": "STRING_MAP"
      },
      "Transitions": {
        "NextAction": "check-reset-candidate",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "reset-unavailable-message" } ]
      }
    },
    {
      "Identifier": "check-reset-candidate",
      "Type": "Compare",
      "Parameters": { "ComparisonValue": "$.External.candidateFound" },
      "Transitions": {
        "NextAction": "reset-unavailable-message",
        "Conditions": [ { "NextAction": "set-reset-attributes", "Condition": { "Operator": "Equals", "Operands": ["true"] } } ],
        "Errors": [ { "ErrorType": "NoMatchingCondition", "NextAction": "reset-unavailable-message" } ]
      }
    },
    {
      "Identifier": "reset-unavailable-message",
      "Type": "MessageParticipant",
      "Parameters": { "Text": "Automated password reset isn't available for that request right now. I'll transfer you to an agent." },
      "Transitions": {
        "NextAction": "set-target-queue",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "set-target-queue" } ]
      }
    },
    {
      "Identifier": "set-reset-attributes",
      "Type": "UpdateContactAttributes",
      "Parameters": {
        "Attributes": { "resetSessionId": "$.External.resetSessionId", "maskedPhone": "$.External.maskedPhone" },
        "TargetContact": "Current"
      },
      "Transitions": {
        "NextAction": "reset-otp-prompt",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "reset-unavailable-message" } ]
      }
    },
    {
      "Identifier": "reset-otp-prompt",
      "Type": "MessageParticipant",
      "Parameters": { "Text": "For your security, enter the code sent to the mobile ending $.Attributes.maskedPhone." },
      "Transitions": {
        "NextAction": "invoke-reset-bot",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "invoke-reset-bot" } ]
      }
    },
    {
      "Identifier": "invoke-reset-bot",
      "Type": "ConnectParticipantWithLexBot",
      "Parameters": {
        "Text": "Enter the six digit code now.",
        "LexV2Bot": { "AliasArn": "__PASSWORD_RESET_BOT_ALIAS_ARN__" },
        "LexSessionAttributes": { "resetSessionId": "$.Attributes.resetSessionId" }
      },
      "Transitions": {
        "NextAction": "check-reset-outcome",
        "Errors": [
          { "ErrorType": "InputTimeLimitExceeded", "NextAction": "reset-failed-message" },
          { "ErrorType": "NoMatchingError", "NextAction": "reset-failed-message" }
        ]
      }
    },
    {
      "Identifier": "check-reset-outcome",
      "Type": "Compare",
      "Parameters": { "ComparisonValue": "$.Lex.SessionAttributes.resetOutcome" },
      "Transitions": {
        "NextAction": "reset-failed-message",
        "Conditions": [ { "NextAction": "reset-success-message", "Condition": { "Operator": "Equals", "Operands": ["SUCCESS"] } } ],
        "Errors": [ { "ErrorType": "NoMatchingCondition", "NextAction": "reset-failed-message" } ]
      }
    },
    {
      "Identifier": "reset-success-message",
      "Type": "MessageParticipant",
      "Parameters": { "Text": "Your temporary password has been sent to your registered mobile. Change it immediately after signing in. Goodbye." },
      "Transitions": {
        "NextAction": "end-call",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "end-call" } ]
      }
    },
    {
      "Identifier": "reset-failed-message",
      "Type": "MessageParticipant",
      "Parameters": { "Text": "We couldn't verify that request automatically. I'll transfer you to an agent." },
      "Transitions": {
        "NextAction": "set-target-queue",
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "set-target-queue" } ]
      }
    },
    {
      "Identifier": "transfer-to-voicemail",
      "Type": "TransferToFlow",
      "Parameters": {
        "ContactFlowId": "arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/contact-flow/05d92d19-1fc1-4540-a3f5-91dda3584ec5"
      },
      "Transitions": {
        "Errors": [ { "ErrorType": "NoMatchingError", "NextAction": "set-target-queue" } ]
      }
    },
    {
      "Identifier": "set-target-queue",
      "Type": "UpdateContactTargetQueue",
      "Parameters": { "QueueId": "arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/queue/dcc369d7-d5c2-4ee3-9a52-0d10b0219a60" },
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

- [ ] **Step 2: Run the validator directly against the new file**

Run: `python connect-flows/validate_flow.py connect-flows/wisecalls-voice-v1-dev.json`
Expected: `Flow content is structurally valid.` (exit 0). Note the tokens `__IDENTIFY_CALLER_FUNCTION_ARN__`/`__PASSWORD_RESET_BOT_ALIAS_ARN__` are opaque strings to the validator — it only checks structure, not ARN syntax, so this passes before substitution.

- [ ] **Step 3: Run the validator with the regression check against the real backup**

Run (from repo root, PowerShell, extracting the embedded Content string first):

```powershell
python -c "import json,pathlib; d=json.load(open('connect-backup/flow-790c287e-1663-4dcf-844c-f180891bca52.json',encoding='utf-8')); pathlib.Path('connect-backup/original-content.json').write_text(d['ContactFlow']['Content'], encoding='utf-8')"
python connect-flows/validate_flow.py connect-flows/wisecalls-voice-v1-dev.json connect-backup/original-content.json
```

Expected: `Flow content is structurally valid.` (exit 0) — confirms options 1-4 and the verification chain are byte-identical to the currently deployed content.

- [ ] **Step 4: Run the full test suite from Task 1 and confirm the two previously-skipped tests now pass**

Run: `python -m unittest connect-flows.tests.test_validate_flow -v` (from repo root)
Expected: all 8 tests `PASS`, none skipped.

- [ ] **Step 5: Save checkpoint**

No git repository is present — nothing to commit. Move to Task 3.

---

### Task 3: Deploy script with ARN substitution

**Files:**
- Create: `scripts/deploy-connect-flow.ps1`

**Interfaces:**
- Consumes: `connect-flows/validate_flow.py` (Task 1) as a subprocess check; `connect-flows/wisecalls-voice-v1-dev.json` (Task 2) as the content source; `ad-password-reset` CloudFormation stack outputs `IdentifyCallerFunctionArn`, `LexBotAliasArn`.
- Produces: (when run with `-Execute`) an updated live content for the target Connect flow via `aws connect update-contact-flow-content`.

- [ ] **Step 1: Write the script**

Create `scripts/deploy-connect-flow.ps1`:

```powershell
param(
  [Parameter(Mandatory=$true)][string]$Region,
  [Parameter(Mandatory=$true)][string]$ConnectInstanceArn,
  [Parameter(Mandatory=$true)][string]$FlowId,
  [Parameter(Mandatory=$true)][string]$AdPasswordResetStackName,
  [string]$ContentFile = (Join-Path (Split-Path -Parent $PSScriptRoot) 'connect-flows\wisecalls-voice-v1-dev.json'),
  [string]$Profile,
  [switch]$Execute
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$instanceId = ($ConnectInstanceArn -split '/')[1]
if (-not $instanceId) { throw 'ConnectInstanceArn is invalid.' }
$awsArgs = @('--region', $Region)
if ($Profile) { $awsArgs += @('--profile', $Profile) }

Write-Host "Validating $ContentFile structurally..."
python (Join-Path $root 'connect-flows\validate_flow.py') $ContentFile
if ($LASTEXITCODE -ne 0) { throw 'Flow content failed structural validation.' }

Write-Host "Reading ad-password-reset stack outputs from $AdPasswordResetStackName..."
$outputsJson = aws cloudformation describe-stacks --stack-name $AdPasswordResetStackName --query 'Stacks[0].Outputs' --output json @awsArgs
if ($LASTEXITCODE -ne 0) { throw "Could not read stack outputs for $AdPasswordResetStackName. Has it been deployed?" }
$outputs = $outputsJson | ConvertFrom-Json
$identifyArn = ($outputs | Where-Object { $_.OutputKey -eq 'IdentifyCallerFunctionArn' }).OutputValue
$lexAliasArn = ($outputs | Where-Object { $_.OutputKey -eq 'LexBotAliasArn' }).OutputValue
if (-not $identifyArn -or -not $lexAliasArn) {
  throw 'Stack outputs are missing IdentifyCallerFunctionArn or LexBotAliasArn.'
}
Write-Host "  IdentifyCallerFunctionArn = $identifyArn"
Write-Host "  LexBotAliasArn            = $lexAliasArn"

$rawContent = Get-Content -Raw -LiteralPath $ContentFile
$substituted = $rawContent.Replace('__IDENTIFY_CALLER_FUNCTION_ARN__', $identifyArn).Replace('__PASSWORD_RESET_BOT_ALIAS_ARN__', $lexAliasArn)
if ($substituted -match '__[A-Z_]+__') {
  throw "Unsubstituted placeholder token remains in content: $($Matches[0])"
}
$tempFile = Join-Path $env:TEMP "$FlowId-substituted.json"
Set-Content -LiteralPath $tempFile -Value $substituted -NoNewline

Write-Host "Re-validating substituted content..."
python (Join-Path $root 'connect-flows\validate_flow.py') $tempFile
if ($LASTEXITCODE -ne 0) { throw 'Substituted flow content failed structural validation.' }

Write-Host "Current live content for flow $FlowId (for comparison):"
aws connect describe-contact-flow --instance-id $instanceId --contact-flow-id $FlowId --query 'ContactFlow.{Name:Name,Status:Status}' --output json @awsArgs

if (-not $Execute) {
  Write-Host "DRY RUN: substituted content written to $tempFile. Re-run with -Execute after reviewing it."
  exit 0
}

Write-Host "Pushing new content to flow $FlowId..."
aws connect update-contact-flow-content --instance-id $instanceId --contact-flow-id $FlowId --content "file://$tempFile" @awsArgs
if ($LASTEXITCODE -ne 0) { throw 'update-contact-flow-content failed.' }

Write-Host "Verifying the new content is live..."
$live = aws connect describe-contact-flow --instance-id $instanceId --contact-flow-id $FlowId --output json @awsArgs | ConvertFrom-Json
if ($live.ContactFlow.Content -notmatch 'transfer-to-voicemail') {
  throw 'Post-deploy verification failed: live content does not contain the new transfer-to-voicemail action.'
}
Write-Host 'Deploy verified: live content now contains the password-reset and voicemail branches.'
```

- [ ] **Step 2: Dry-run against the real flow (no AWS mutation)**

Run:

```powershell
.\scripts\deploy-connect-flow.ps1 -Region ap-southeast-2 -ConnectInstanceArn 'arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' -FlowId '790c287e-1663-4dcf-844c-f180891bca52' -AdPasswordResetStackName wisecalls-dev-ad-reset -Profile default
```

Expected: prints the resolved `IdentifyCallerFunctionArn`/`LexBotAliasArn`, both structural validations pass, prints the current live flow's `Name`/`Status`, and ends with `DRY RUN: ...` — no `update-contact-flow-content` call made. If this fails with a `describe-stacks` error, the `ad-password-reset` stack (Task tracked separately, this session) is not deployed yet — stop and resolve that first.

- [ ] **Step 3: Save checkpoint**

No git repository is present — nothing to commit. Move to Task 4.

---

### Task 4: Deploy and verify

**Files:** none (uses Task 3's script and Task 2's content).

**Interfaces:** none new.

- [ ] **Step 1: Get explicit operator approval**

**STOP.** Show the operator the Task 3 Step 2 dry-run output (resolved ARNs, current flow `Status`) and this plan's diff summary (main-menu now has options 5/6; ten new actions added; nothing else in the 24 existing actions changed, confirmed by Task 2 Step 3's regression check). Do not run `-Execute` without an explicit go-ahead — `wisecalls-voice-v1-dev` is not live yet, so the blast radius of this specific step is low, but the resulting content will include real Lambda/Lex ARNs tied to billed resources (the `ad-password-reset` stack), and this is the point after which the flow could theoretically be assigned to the live number.

- [ ] **Step 2: Execute**

Run the same command as Task 3 Step 2 with `-Execute` appended:

```powershell
.\scripts\deploy-connect-flow.ps1 -Region ap-southeast-2 -ConnectInstanceArn 'arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' -FlowId '790c287e-1663-4dcf-844c-f180891bca52' -AdPasswordResetStackName wisecalls-dev-ad-reset -Profile default -Execute
```

Expected: ends with `Deploy verified: live content now contains the password-reset and voicemail branches.`

- [ ] **Step 3: Confirm `wise-calls-org-voicemail-ivr` is untouched**

Run:

```powershell
aws connect describe-contact-flow --instance-id aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee --contact-flow-id 05d92d19-1fc1-4540-a3f5-91dda3584ec5 --region ap-southeast-2 --profile default --query 'ContactFlow.{Name:Name,LastModifiedTime:LastModifiedTime}'
```

Expected: `LastModifiedTime` is unchanged from before Step 2 (this task never calls `update-contact-flow-content` on that flow ID — this is a verification step, not a fix).

---

### Task 5: Test-number assignment and acceptance testing

**Files:** none — this task is a documented manual runbook, not code. Amazon Connect number claiming and live call testing cannot be scripted safely (claiming a number is a real, ongoing-cost AWS action) and must stay operator-gated.

**Interfaces:** none new.

- [ ] **Step 1: Check for an already-claimed, unassigned test number before claiming a new one**

Run:

```powershell
aws connect list-phone-numbers-v2 --target-arn 'arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' --region ap-southeast-2 --profile default --output json
```

Cross-reference against `aws connect list-queues`/flow associations to see if any listed number is not already routed to `wise-calls-org-voicemail-ivr` in production use. If nothing suitable exists, **stop and ask the operator** before running `aws connect claim-phone-number` — claiming a number is a billed, real-world resource change outside this plan's read-only/dry-run pattern.

- [ ] **Step 2: Associate the test number with `wisecalls-voice-v1-dev`**

Once a test number is approved and identified (claimed number ID from Step 1), associate it via the Connect console (Routing → Phone numbers → select number → set Contact flow / IVR to `wisecalls-voice-v1-dev`) rather than a scripted API call, since this is a one-time, low-frequency, high-visibility change best done with the console's built-in confirmation UI.

- [ ] **Step 3: Run the acceptance matrix from the spec**

Call the test number and record pass/fail for each row (from `docs/superpowers/specs/2026-08-02-ivr-password-reset-menu-design.md`'s Test plan):

1. Registered mobile, correct OTP → reset succeeds once.
2. Registered mobile, wrong OTP → generic failure, transferred to agent.
3. Unregistered/anonymous number → no details disclosed, transferred to agent.
4. Replay of an accepted session → rejected.
5. Expired OTP → rejected.
6. Inactive/privileged/`passwordResetAllowed=false` record → rejected.
7. Repeated calls inside 60 seconds → rate-limited.
8. CloudWatch Logs for `IdentifyCallerFunction`/`ResetFulfillmentFunction` contain no OTP, full mobile, HMAC key, or password.
9. Press 6 reaches voicemail; department routing behaves exactly as it does on the live number today.
10. A failed/ineligible password-reset attempt lands the caller on a live agent (not stranded, not silently disconnected, not looped back to the menu).
11. Options 1-4 behave identically to their current published behavior (regression check).

Note case 7 and any live-SMS cases (1, 2) are constrained by the SNS sandbox limitation already flagged in this session (`MonthlySpendLimit: 1`) — either request SNS production access first, or add the test number as a verified sandbox destination, or accept that only cases reachable without new outbound SMS (3, 4, 5, 6, 9, 10, 11) can be fully exercised until that's resolved.

- [ ] **Step 4: Report results, do not cut over**

Summarize pass/fail for all 11 cases to the operator. Cutting the live Wise Calls Org number over to `wisecalls-voice-v1-dev` is an explicit, separate decision requiring its own approval — this plan does not include it and it should not happen automatically after tests pass.

---

## Self-review notes

- **Spec coverage:** every numbered item in the design spec's "Design" and "Test plan" sections maps to a task above (menu text/options → Task 2; identify/OTP/Lex wiring → Task 2; error handling/fail-closed → Task 2 + validator's forbidden-action-missing check; voicemail transfer → Task 2; publishing/rollout gating → Task 4 Step 1 and Task 5; test matrix → Task 5 Step 3).
- **Placeholder scan:** the two `__..._ARN__` tokens are the only placeholder-shaped strings in this plan; they are mechanically substituted by Task 3's script from real stack outputs, not left for a human to "fill in later" — Task 3 Step 1's script fails loudly (`Unsubstituted placeholder token remains`) if substitution didn't happen.
- **Type/identifier consistency:** the ten new action Identifiers are the same list in the spec, the validator's `REQUIRED_NEW_ACTIONS`, the tests' `REQUIRED_NEW_ACTIONS`, and the actual flow JSON — checked by hand across Tasks 1 and 2.
