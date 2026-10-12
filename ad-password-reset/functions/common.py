"""Shared helpers for the WiseCalls directory password-reset PoC."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
from typing import Any

E164 = re.compile(r"^\+[1-9][0-9]{7,14}$")
_cached_hmac_key: bytes | None = None


def normalize_phone(value: Any) -> str | None:
    digits = re.sub(r"[^0-9+]", "", str(value or ""))
    if digits.startswith("04") and len(digits) == 10:
        digits = "+61" + digits[1:]
    elif digits.startswith("61"):
        digits = "+" + digits
    return digits if E164.fullmatch(digits) else None


def secret_key(secrets_client: Any | None = None) -> bytes:
    global _cached_hmac_key
    if _cached_hmac_key is not None:
        return _cached_hmac_key
    if secrets_client is None:
        import boto3
        secrets_client = boto3.client("secretsmanager")
    response = secrets_client.get_secret_value(SecretId=os.environ["RESET_HMAC_SECRET_ARN"])
    raw = response.get("SecretString")
    if raw is None:
        raw = base64.b64decode(response["SecretBinary"]).decode("utf-8")
    try:
        parsed = json.loads(raw)
        raw = parsed.get("key", raw)
    except json.JSONDecodeError:
        pass
    _cached_hmac_key = str(raw).encode("utf-8")
    return _cached_hmac_key


def keyed_hash(purpose: str, value: str, key: bytes) -> str:
    return hmac.new(key, f"{purpose}:{value}".encode("utf-8"), hashlib.sha256).hexdigest()


def mask_phone(phone: str) -> str:
    return f"••••••{phone[-4:]}"


def epoch() -> int:
    return int(time.time())


def connect_parameters(event: dict[str, Any]) -> dict[str, Any]:
    parameters = dict(event.get("Details", {}).get("Parameters") or {})
    contact = event.get("Details", {}).get("ContactData") or {}
    parameters["callerPhone"] = (contact.get("CustomerEndpoint") or {}).get("Address")
    parameters["contactId"] = contact.get("ContactId")
    return parameters

