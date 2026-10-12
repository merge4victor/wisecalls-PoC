import importlib
import os
import sys
import unittest
from unittest.mock import patch

FUNCTIONS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "functions"))
sys.path.insert(0, FUNCTIONS)
common = importlib.import_module("common")
identify = importlib.import_module("identify_caller")
reset = importlib.import_module("reset_fulfillment")


class PasswordResetTests(unittest.TestCase):
    def test_phone_normalization(self):
        self.assertEqual(common.normalize_phone("0491 570 156"), "+61491570156")
        self.assertEqual(common.normalize_phone("+61 491 570 156"), "+61491570156")
        self.assertIsNone(common.normalize_phone("anonymous"))

    def test_phone_hash_is_purpose_bound(self):
        key = b"test-key"
        self.assertNotEqual(common.keyed_hash("phone", "+61491570156", key), common.keyed_hash("otp", "+61491570156", key))

    def test_privileged_and_inactive_users_are_rejected(self):
        base = {"status": "ACTIVE", "passwordResetAllowed": True, "privilegedAccount": False, "directoryUserName": "alex.sample", "phoneE164": "+61491570156"}
        self.assertTrue(identify.eligible_user(base))
        self.assertFalse(identify.eligible_user({**base, "privilegedAccount": True}))
        self.assertFalse(identify.eligible_user({**base, "status": "DISABLED"}))
        self.assertTrue(identify.eligible_user(base, "+61491570156"))
        self.assertFalse(identify.eligible_user(base, "+61400000000"))

    def test_temporary_password_has_all_character_classes(self):
        value = reset.temporary_password()
        self.assertGreaterEqual(len(value), 20)
        self.assertRegex(value, r"[A-Z]")
        self.assertRegex(value, r"[a-z]")
        self.assertRegex(value, r"[0-9]")
        self.assertRegex(value, r"[^A-Za-z0-9]")

    def test_lex_close_does_not_return_secrets(self):
        event = {"sessionState": {"intent": {"name": "ResetPassword", "slots": {}}, "sessionAttributes": {"resetSessionId": "abc"}}}
        response = reset.close(event, "Failed", "Try again", "OTP_INVALID")
        self.assertEqual(response["sessionState"]["intent"]["state"], "Failed")
        self.assertEqual(response["messages"][0]["content"], "Try again")


if __name__ == "__main__":
    unittest.main()
