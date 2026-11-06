"""Offline financial safety checks. No HTTP requests or resources."""
import unittest
from unittest.mock import patch
import guardian


class GuardianSafety(unittest.TestCase):
    def setUp(self):
        self.lease = {"podName": "conveyer-ltx-approved", "deadline": 10000}
        self.pod = {"name": "conveyer-ltx-approved", "status": "RUNNING", "cost": 0.72}

    def test_armed_before_deadline(self):
        self.assertEqual(guardian.observe(self.lease, self.pod, 9000, False), "armed")

    def test_absolute_deadline_and_manual_stop(self):
        self.assertEqual(guardian.observe(self.lease, self.pod, 10000, False), "stop")
        self.assertEqual(guardian.observe(self.lease, self.pod, 1, True), "stop")

    def test_price_cannot_exceed_quote(self):
        for price in (0, 0.73, 2.5, None, "invalid", float("nan")):
            self.assertEqual(guardian.observe(self.lease, {**self.pod, "cost": price}, 1, False), "stop")

    def test_explicit_5090_quote_and_hard_ceiling(self):
        lease = {**self.lease, "approvedGpuRate": 0.99}
        self.assertEqual(guardian.observe(lease, {**self.pod, "cost": 0.99}, 1, False), "armed")
        self.assertEqual(guardian.observe(lease, {**self.pod, "cost": 1.0}, 1, False), "stop")

    def test_foreign_pod_is_never_accepted(self):
        with self.assertRaisesRegex(RuntimeError, "Ownership mismatch"):
            guardian.observe(self.lease, {**self.pod, "name": "production"}, 10000, True)

    def test_exited_is_required_for_stop_confirmation(self):
        self.assertEqual(guardian.observe(self.lease, {**self.pod, "status": "EXITED"}, 1, False), "stopped")
        self.assertEqual(guardian.observe(self.lease, self.pod, 1, False), "armed")

    @patch.dict(guardian.os.environ, {"RUNPOD_API_KEY": "test-only-not-a-credential"})
    @patch("guardian.urllib.request.urlopen")
    def test_stop_uses_bearer_and_fixed_stop_only_endpoint(self, mocked):
        mocked.return_value.__enter__.return_value.read.return_value = b"{}"
        guardian.api("approved123", stop=True)
        request = mocked.call_args.args[0]
        self.assertEqual(request.full_url, "https://rest.runpod.io/v1/pods/approved123/stop")
        self.assertEqual(request.method, "POST")
        self.assertNotIn("test-only", request.full_url)
        self.assertEqual(request.headers["Authorization"], "Bearer test-only-not-a-credential")


if __name__ == "__main__":
    unittest.main()
