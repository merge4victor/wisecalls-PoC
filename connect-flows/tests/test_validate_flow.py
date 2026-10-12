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
]

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
                {"NextAction": "call-get-next-slot", "Condition": {"Operator": "Equals", "Operands": ["7"]}},
                {"NextAction": "credit-card-notice", "Condition": {"Operator": "Equals", "Operands": ["8"]}},
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

    def test_missing_book_blocked_action_detected(self):
        content = _minimal_valid_content()
        content["Actions"] = [a for a in content["Actions"] if a["Identifier"] != "check-book-blocked"]
        errors = validate_flow.validate(content)
        self.assertTrue(any("check-book-blocked" in e for e in errors))

    def test_missing_location_eligibility_action_detected(self):
        content = _minimal_valid_content()
        content["Actions"] = [a for a in content["Actions"] if a["Identifier"] != "check-location-eligibility"]
        main_menu = next(a for a in content["Actions"] if a["Identifier"] == "main-menu")
        main_menu["Transitions"]["Conditions"] = [
            c for c in main_menu["Transitions"]["Conditions"] if c["NextAction"] != "check-location-eligibility"
        ]
        errors = validate_flow.validate(content)
        self.assertTrue(any("check-location-eligibility" in e for e in errors))

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

    def test_missing_voice_action_detected(self):
        content = _minimal_valid_content()
        content["Actions"] = [a for a in content["Actions"] if a["Identifier"] != "set-olivia-voice"]
        main_menu = next(a for a in content["Actions"] if a["Identifier"] == "main-menu")
        main_menu["Transitions"]["Conditions"] = [
            c for c in main_menu["Transitions"]["Conditions"] if c["NextAction"] != "set-olivia-voice"
        ]
        errors = validate_flow.validate(content)
        self.assertTrue(any("set-olivia-voice" in e for e in errors))

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
        # The live baseline was captured with the org name "WiseCalls" in place of __ORG_NAME__.
        new_content = json.loads(open(real_path, encoding="utf-8").read().replace("__ORG_NAME__", "WiseCalls"))
        backup_wrapper = json.loads(open(backup_path, encoding="utf-8").read())
        original_content = json.loads(backup_wrapper["ContactFlow"]["Content"])
        diffs = validate_flow.unchanged_actions(new_content, original_content, EXISTING_UNCHANGED_ACTIONS)
        self.assertEqual(diffs, [])


if __name__ == "__main__":
    unittest.main()
