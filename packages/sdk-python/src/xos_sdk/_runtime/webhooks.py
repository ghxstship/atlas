"""Webhook signatures (ADR 0003): HMAC-SHA256 over ``{timestamp}.{body}``, sent as
``XOS-Signature: t={unix},v1={hex}``."""

from __future__ import annotations

import hashlib
import hmac
import re
import time
from dataclasses import dataclass
from typing import List, Optional, Union

SIGNATURE_HEADER = "XOS-Signature"
DEFAULT_TOLERANCE_SECONDS = 300

_HEX = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class ParsedSignature:
    timestamp: int
    signatures: List[str]


@dataclass(frozen=True)
class WebhookVerification:
    valid: bool
    #: When invalid: ``malformed_header``, ``timestamp_out_of_tolerance`` or ``signature_mismatch``.
    reason: Optional[str] = None
    timestamp: Optional[int] = None


def _mac(secret: str, message: bytes) -> str:
    return hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


def _bytes(payload: Union[str, bytes]) -> bytes:
    return payload.encode("utf-8") if isinstance(payload, str) else payload


def parse_signature_header(header: str) -> Optional[ParsedSignature]:
    """Parse ``t={unix},v1={hex}[,v1={hex}]``; None when the header is malformed."""
    timestamp: Optional[int] = None
    signatures: List[str] = []
    for part in header.split(","):
        key, sep, value = part.strip().partition("=")
        if not sep or not key:
            return None
        if key == "t":
            if not value.isdigit():
                return None
            timestamp = int(value)
        elif key == "v1":
            if not _HEX.match(value):
                return None
            signatures.append(value)
    if timestamp is None or not signatures:
        return None
    return ParsedSignature(timestamp=timestamp, signatures=signatures)


def sign_webhook_payload(payload: Union[str, bytes], secret: str, timestamp: Optional[int] = None) -> str:
    """Build the ``XOS-Signature`` value for a payload. Use it to test your webhook endpoint."""
    ts = int(time.time()) if timestamp is None else timestamp
    return f"t={ts},v1={_mac(secret, str(ts).encode('ascii') + b'.' + _bytes(payload))}"


def verify_webhook_signature(
    payload: Union[str, bytes],
    header: str,
    secret: str,
    *,
    tolerance_seconds: int = DEFAULT_TOLERANCE_SECONDS,
    now: Optional[int] = None,
) -> WebhookVerification:
    """Verify a delivery. Pass the raw request body exactly as received."""
    parsed = parse_signature_header(header)
    if parsed is None:
        return WebhookVerification(valid=False, reason="malformed_header")
    current = int(time.time()) if now is None else now
    if abs(current - parsed.timestamp) > tolerance_seconds:
        return WebhookVerification(valid=False, reason="timestamp_out_of_tolerance")
    expected = _mac(secret, str(parsed.timestamp).encode("ascii") + b"." + _bytes(payload))
    if any(hmac.compare_digest(s, expected) for s in parsed.signatures):
        return WebhookVerification(valid=True, timestamp=parsed.timestamp)
    return WebhookVerification(valid=False, reason="signature_mismatch")
