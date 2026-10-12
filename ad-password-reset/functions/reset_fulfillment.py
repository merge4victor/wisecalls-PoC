"""Lex V2 fulfillment: verify OTP, reset directory password, and notify the user."""

from __future__ import annotations

import hmac
import json
import logging
import os
import re
import secrets
import string
from typing import Any

from common import epoch, keyed_hash, secret_key

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)


def slot_value(event: dict[str, Any], name: str) -> str:
    slot = (event.get("sessionState", {}).get("intent", {}).get("slots") or {}).get(name) or {}
    return str((slot.get("value") or {}).get("interpretedValue") or "")


def close(event: dict[str, Any], state: str, message: str, outcome: str) -> dict[str, Any]:
    intent = dict(event.get("sessionState", {}).get("intent") or {})
    intent["state"] = state
    attributes = dict(event.get("sessionState", {}).get("sessionAttributes") or {})
    attributes["resetOutcome"] = outcome
    return {
        "sessionState": {
            "dialogAction": {"type": "Close"},
            "intent": intent,
            "sessionAttributes": attributes,
        },
        "messages": [{"contentType": "PlainText", "content": message}],
    }


def temporary_password(length: int = 20) -> str:
    alphabet = string.ascii_letters + string.digits + "!#%*+-_="
    while True:
        value = "".join(secrets.choice(alphabet) for _ in range(length))
        if re.search(r"[A-Z]", value) and re.search(r"[a-z]", value) and re.search(r"[0-9]", value) and re.search(r"[^A-Za-z0-9]", value):
            return value


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    import boto3
    from botocore.exceptions import ClientError

    attributes = event.get("sessionState", {}).get("sessionAttributes") or {}
    session_id = str(attributes.get("resetSessionId", ""))
    code = re.sub(r"\D", "", slot_value(event, "VerificationCode"))
    if not re.fullmatch(r"[0-9]{6}", code) or not re.fullmatch(r"[0-9a-f-]{36}", session_id):
        return close(event, "Failed", "We could not verify this reset request. I will transfer you to the service desk.", "INVALID_REQUEST")

    dynamodb = boto3.resource("dynamodb")
    sessions = dynamodb.Table(os.environ["SESSION_TABLE"])
    users = dynamodb.Table(os.environ["USER_TABLE"])
    session = sessions.get_item(Key={"sessionId": session_id}, ConsistentRead=True).get("Item")
    now = epoch()
    if not session or int(session.get("expiresAt", 0)) <= now or session.get("completedAt"):
        return close(event, "Failed", "That verification session has expired or was already used. Please start again.", "EXPIRED_OR_USED")
    if int(session.get("attempts", 0)) >= int(os.environ.get("MAX_OTP_ATTEMPTS", "3")):
        return close(event, "Failed", "Verification attempts have been exceeded. I will transfer you to the service desk.", "ATTEMPTS_EXCEEDED")

    expected = str(session.get("otpHash", ""))
    supplied = keyed_hash(f"otp:{session_id}", code, secret_key())
    if not hmac.compare_digest(expected, supplied):
        try:
            sessions.update_item(
                Key={"sessionId": session_id},
                UpdateExpression="ADD attempts :one",
                ConditionExpression="attribute_not_exists(completedAt) AND expiresAt > :now AND attempts < :maximum",
                ExpressionAttributeValues={":one": 1, ":now": now, ":maximum": int(os.environ.get("MAX_OTP_ATTEMPTS", "3"))},
            )
        except ClientError:
            pass
        return close(event, "Failed", "That code could not be verified. Please start again or speak with the service desk.", "OTP_INVALID")

    user = users.get_item(Key={"phoneHash": session["phoneHash"]}, ConsistentRead=True).get("Item")
    if not (
        user and user.get("status") == "ACTIVE" and user.get("passwordResetAllowed") is True
        and user.get("privilegedAccount") is not True and user.get("directoryUserName")
    ):
        return close(event, "Failed", "This account cannot be reset automatically. I will transfer you to the service desk.", "ACCOUNT_INELIGIBLE")

    try:
        sessions.update_item(
            Key={"sessionId": session_id},
            UpdateExpression="SET verifiedAt=:now",
            ConditionExpression="attribute_not_exists(verifiedAt) AND attribute_not_exists(completedAt) AND expiresAt > :now",
            ExpressionAttributeValues={":now": now},
        )
    except ClientError:
        return close(event, "Failed", "This reset request was already processed. Please contact the service desk.", "REPLAY_REJECTED")

    password = temporary_password()
    try:
        if os.environ.get("ALLOW_TEMP_PASSWORD_SMS", "false").lower() != "true":
            raise RuntimeError("Temporary-password SMS delivery is disabled")
        boto3.client("ds").reset_user_password(
            DirectoryId=os.environ["DIRECTORY_ID"],
            UserName=user["directoryUserName"],
            NewPassword=password,
        )
        boto3.client("sns").publish(
            PhoneNumber=user["phoneE164"],
            Message=(
                f"WiseCalls temporary directory password: {password}\n"
                "Sign in and change it immediately. If you did not request this, contact the service desk."
            ),
            MessageAttributes={"AWS.SNS.SMS.SMSType": {"DataType": "String", "StringValue": "Transactional"}},
        )
        sessions.update_item(
            Key={"sessionId": session_id},
            UpdateExpression="SET completedAt=:now REMOVE otpHash",
            ExpressionAttributeValues={":now": epoch()},
        )
        LOGGER.info(json.dumps({"event": "DIRECTORY_PASSWORD_RESET", "sessionId": session_id, "outcome": "SUCCESS"}))
        first_name = str(user.get("firstName", "")).strip()[:64]
        greeting = f"Thanks, {first_name}. " if first_name else ""
        return close(event, "Fulfilled", greeting + "Your temporary password has been sent to your registered mobile. Change it immediately after signing in.", "SUCCESS")
    except Exception as error:
        LOGGER.error(json.dumps({"event": "DIRECTORY_PASSWORD_RESET", "sessionId": session_id, "outcome": "FAILED", "type": type(error).__name__}))
        return close(event, "Failed", "The reset could not be completed. I will transfer you to the service desk.", "RESET_FAILED")
