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

REQUIRED_MAIN_MENU_OPTIONS = ("1", "2", "3", "4", "5", "6", "7", "8")

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
    "check-book-blocked",
    "check-location-eligibility",
    "location-sharing-unavailable-message",
    "credit-card-notice",
    "enable-redaction-analytics",
    "set-olivia-voice",
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
