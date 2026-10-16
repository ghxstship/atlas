from __future__ import annotations

import json
import unittest

from xos_sdk import parse_signature_header, sign_webhook_payload, verify_webhook_signature

SECRET = "whsec_contract_test"
PAYLOAD = json.dumps({"type": "record.state_changed", "data": {"id": "r1"}})


class WebhookTest(unittest.TestCase):
    def test_sign_and_verify(self) -> None:
        header = sign_webhook_payload(PAYLOAD, SECRET, 1_760_000_000)
        self.assertRegex(header, r"^t=1760000000,v1=[0-9a-f]{64}$")
        result = verify_webhook_signature(PAYLOAD, header, SECRET, now=1_760_000_100)
        self.assertTrue(result.valid)
        self.assertEqual(result.timestamp, 1_760_000_000)
        self.assertTrue(verify_webhook_signature(PAYLOAD.encode(), sign_webhook_payload(PAYLOAD, SECRET), SECRET).valid)

    def test_matches_the_typescript_signature(self) -> None:
        # Same input as packages/sdk-ts/test/webhooks.test.ts; both SDKs must agree byte for byte.
        header = sign_webhook_payload("{}", "s", 1)
        self.assertEqual(header, "t=1,v1=" + __import__("hmac").new(b"s", b"1.{}", "sha256").hexdigest())

    def test_rejections(self) -> None:
        header = sign_webhook_payload(PAYLOAD, SECRET, 1_760_000_000)
        now = 1_760_000_000
        self.assertEqual(verify_webhook_signature(PAYLOAD + " ", header, SECRET, now=now).reason, "signature_mismatch")
        self.assertEqual(verify_webhook_signature(PAYLOAD, header, SECRET, now=now + 301).reason, "timestamp_out_of_tolerance")
        self.assertTrue(verify_webhook_signature(PAYLOAD, header, SECRET, now=now + 600, tolerance_seconds=900).valid)
        self.assertEqual(verify_webhook_signature(PAYLOAD, "v1=abc", SECRET, now=now).reason, "malformed_header")

    def test_parse(self) -> None:
        self.assertEqual(parse_signature_header("t=1,v1=" + "a" * 64).signatures, ["a" * 64])  # type: ignore[union-attr]
        self.assertIsNone(parse_signature_header("t=1"))
        self.assertIsNone(parse_signature_header("t=x,v1=" + "a" * 64))
        self.assertIsNone(parse_signature_header("t=1,v1=short"))
        self.assertIsNone(parse_signature_header("garbage"))


if __name__ == "__main__":
    unittest.main()
