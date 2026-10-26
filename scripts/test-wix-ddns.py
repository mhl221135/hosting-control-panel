import importlib.util
import pathlib
import unittest
from unittest.mock import patch


path = pathlib.Path(__file__).with_name("wix-ddns.py")
spec = importlib.util.spec_from_file_location("wix_ddns", path)
wix = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wix)


class WixDdnsTests(unittest.TestCase):
    def setUp(self):
        self.site = {"domain": "example.com", "account_id": "account", "api_key": "secret"}
        self.zone = {"dnsZone": {"records": [
            {"type": "A", "hostName": "example.com", "ttl": 3600, "values": ["192.0.2.1"]},
            {"type": "MX", "hostName": "example.com", "ttl": 3600, "values": ["10 mail.example.com"]},
        ]}}

    def test_unchanged_does_not_patch(self):
        self.zone["dnsZone"]["records"][0]["values"] = ["198.51.100.3"]
        with patch.object(wix, "wix_request", return_value=self.zone) as request:
            wix.update_site(self.site, "198.51.100.3", True)
        self.assertEqual(request.call_count, 1)

    def test_changed_replaces_only_a_record(self):
        with patch.object(wix, "wix_request", return_value=self.zone) as request:
            wix.update_site(self.site, "198.51.100.3", True)
        self.assertEqual(request.call_count, 2)
        payload = request.call_args.args[4]
        self.assertEqual(payload["deletions"], [self.zone["dnsZone"]["records"][0]])
        self.assertEqual(payload["additions"], [{"type": "A", "hostName": "example.com",
                                                  "ttl": 3600, "values": ["198.51.100.3"]}])

    def test_dry_run_does_not_patch(self):
        with patch.object(wix, "wix_request", return_value=self.zone) as request:
            wix.update_site(self.site, "198.51.100.3", False)
        self.assertEqual(request.call_count, 1)

    def test_missing_a_record_fails_closed(self):
        self.zone["dnsZone"]["records"] = []
        with patch.object(wix, "wix_request", return_value=self.zone) as request:
            with self.assertRaises(ValueError):
                wix.update_site(self.site, "198.51.100.3", True)
        self.assertEqual(request.call_count, 1)


if __name__ == "__main__":
    unittest.main()
