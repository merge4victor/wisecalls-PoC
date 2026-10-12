import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).parents[1] / "app.py"
SPEC = importlib.util.spec_from_file_location("agent_map_app", MODULE_PATH)
APP = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(APP)


class AgentMapTests(unittest.TestCase):
    def test_agent_arn_is_reduced_to_connect_user_id(self):
        claims = {"connect_user_id": "arn:aws:connect:ap-southeast-2:111122223333:instance/abc/agent/user-12345"}
        self.assertEqual(APP.connect_user_id_from_claims(claims, "connect_user_id"), "user-12345")

    def test_contact_assignment_is_enforced(self):
        with self.assertRaises(APP.ApiError) as caught:
            APP.verify_agent_assignment({"AgentInfo": {"Id": "other-agent"}}, "expected-agent")
        self.assertEqual(caught.exception.code, "CONTACT_NOT_ASSIGNED")

    def test_customer_id_comes_from_contact_attribute(self):
        contact = {"Attributes": {"customerId": "123456"}}
        self.assertEqual(APP.customer_id_from_contact(contact, "customerId"), "123456")

    def test_nearby_landmark_requires_good_accuracy(self):
        result = APP.describe_approximate_location(
            {"accuracyMeters": 25},
            {"Address": {"Locality": "Richmond"}},
            [{"Title": "Richmond Station", "Distance": 80}],
        )
        self.assertEqual(result["approximateLabel"], "Near Richmond Station, around Richmond")
        low_accuracy = APP.describe_approximate_location(
            {"accuracyMeters": 1500},
            {"Address": {"Locality": "Box Hill"}},
            [{"Title": "Box Hill Institute", "Distance": 50}],
        )
        self.assertEqual(low_accuracy["approximateLabel"], "Approximately around Box Hill")
        self.assertIsNone(low_accuracy["nearbyLandmark"])


if __name__ == "__main__":
    unittest.main()
