"""Amazon Connect Lambda: map caller number to a candidate and send a one-time code."""

from __future__ import annotations

import json
import logging
import os
import secrets
import uuid
from typing import Any

from common import connect_parameters, epoch, keyed_hash, mask_phone, normalize_phone, secret_key

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    import boto3
    from botocore.exceptions import ClientError

    params = connect_parameters(event)
    phone = normalize_phone(params.get("callerPhone"))
    generic = {"candidateFound": "false", "resetSessionId": "", "maskedPhone": ""}
    if not phone:
        return generic

    key = secret_key()
    phone_hash = keyed_hash("phone", phone, key)
    dynamodb = boto3.resource("dynamodb")
    users = dynamodb.Table(os.environ["USER_TABLE"])
    sessions = dynamodb.Table(os.environ["SESSION_TABLE"])
    user = users.get_item(Key={"phoneHash": phone_hash}, ConsistentRead=True).get("Item")
    if not eligible_user(user, phone):
        LOGGER.info(json.dumps({"event": "RESET_CANDIDATE_REJECTED", "contactId": params.get("contactId")}))
        return generic

    now = epoch()
    try:
        users.update_item(
            Key={"phoneHash": phone_hash},
            UpdateExpression="SET lastOtpAt=:now",
            ConditionExpression="attribute_not_exists(lastOtpAt) OR lastOtpAt <= :threshold",
            ExpressionAttributeValues={":now": now, ":threshold": now - int(os.environ.get("MIN_OTP_INTERVAL_SECONDS", "60"))},
        )
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return {**generic, "lookupOutcome": "RATE_LIMITED"}
        raise

    code = f"{secrets.randbelow(1_000_000):06d}"
    session_id = str(uuid.uuid4())
    expires_at = now + int(os.environ.get("OTP_TTL_SECONDS", "300"))
    sessions.put_item(
        Item={
            "sessionId": session_id,
            "phoneHash": phone_hash,
            "otpHash": keyed_hash(f"otp:{session_id}", code, key),
            "contactId": str(params.get("contactId") or ""),
            "createdAt": now,
            "expiresAt": expires_at,
            "attempts": 0,
        },
        ConditionExpression="attribute_not_exists(sessionId)",
    )

    sns_args = {
        "PhoneNumber": user["phoneE164"],
        "Message": f"WiseCalls verification code: {code}. It expires in 5 minutes. Do not share this code.",
        "MessageAttributes": {
            "AWS.SNS.SMS.SMSType": {"DataType": "String", "StringValue": "Transactional"}
        },
    }
    sender_id = os.environ.get("SMS_SENDER_ID", "").strip()
    if sender_id:
        sns_args["MessageAttributes"]["AWS.SNS.SMS.SenderID"] = {"DataType": "String", "StringValue": sender_id}
    boto3.client("sns").publish(**sns_args)
    LOGGER.info(json.dumps({"event": "RESET_OTP_SENT", "contactId": params.get("contactId"), "sessionId": session_id}))
    return {
        "candidateFound": "true",
        "resetSessionId": session_id,
        "maskedPhone": mask_phone(user["phoneE164"]),
        "lookupOutcome": "OTP_SENT",
    }


def eligible_user(user: dict[str, Any] | None, expected_phone: str | None = None) -> bool:
    registered_phone = normalize_phone((user or {}).get("phoneE164"))
    return bool(
        user
        and user.get("status") == "ACTIVE"
        and user.get("passwordResetAllowed") is True
        and user.get("privilegedAccount") is not True
        and user.get("directoryUserName")
        and registered_phone
        and (expected_phone is None or registered_phone == expected_phone)
    )
