"""Agent-only current-location API for the WiseCalls Amazon Connect workspace app."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)

CONTACT_ID_PATTERN = re.compile(r"^[A-Za-z0-9-]{8,256}$")
CUSTOMER_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{6,128}$")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _response(status: int, body: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store, max-age=0",
            "pragma": "no-cache",
        },
        "body": json.dumps(body, default=_json_default),
    }


def _json_default(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    raise TypeError(f"Unsupported value: {type(value)!r}")


def jwt_claims(event: dict[str, Any]) -> dict[str, Any]:
    return event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})


def connect_user_id_from_claims(claims: dict[str, Any], claim_name: str) -> str:
    value = str(claims.get(claim_name, "")).strip()
    if value.startswith("arn:") and "/agent/" in value:
        value = value.rsplit("/agent/", 1)[1]
    if not CONTACT_ID_PATTERN.fullmatch(value):
        raise ApiError(403, "AGENT_IDENTITY_NOT_MAPPED", "Agent identity is not mapped to an Amazon Connect user.")
    return value


def customer_id_from_contact(contact: dict[str, Any], attribute_name: str) -> str:
    value = str((contact.get("Attributes") or {}).get(attribute_name, "")).strip()
    if not CUSTOMER_ID_PATTERN.fullmatch(value):
        raise ApiError(404, "CUSTOMER_NOT_LINKED", "The active contact is not linked to a verified customer.")
    return value


def verify_agent_assignment(contact: dict[str, Any], connect_user_id: str) -> None:
    assigned = str((contact.get("AgentInfo") or {}).get("Id", ""))
    if assigned != connect_user_id:
        raise ApiError(403, "CONTACT_NOT_ASSIGNED", "Location is available only to the agent assigned to this contact.")


def describe_approximate_location(location: dict[str, Any], reverse: dict[str, Any] | None,
                                  nearby: list[dict[str, Any]]) -> dict[str, Any]:
    address = (reverse or {}).get("Address") or {}
    locality = address.get("Locality") or address.get("District") or (reverse or {}).get("Title")
    accuracy = float(location["accuracyMeters"])
    candidates = [item for item in nearby if item.get("Title") and _finite_number(item.get("Distance"))]
    candidates.sort(key=lambda item: float(item["Distance"]))
    landmark = candidates[0] if candidates else None
    distance = float(landmark["Distance"]) if landmark else None
    reliable = accuracy <= 150 and distance is not None and distance <= max(250, accuracy * 2)

    if reliable:
        label = f"Near {landmark['Title']}" + (f", around {locality}" if locality else "")
        confidence = "LANDMARK_APPROXIMATE"
    elif locality:
        label = f"Approximately around {locality}"
        confidence = "LOCALITY_APPROXIMATE" if accuracy <= 500 else "LOW_ACCURACY"
    else:
        label = f"Current GPS received with approximately {round(accuracy)} metres accuracy"
        confidence = "COORDINATES_ONLY"

    return {
        "approximateLabel": label,
        "confidence": confidence,
        "locality": locality,
        "nearbyLandmark": landmark.get("Title") if reliable else None,
    }


def _finite_number(value: Any) -> bool:
    try:
        number = float(value)
        return number == number and number not in (float("inf"), float("-inf"))
    except (TypeError, ValueError):
        return False


def _audit(table: Any, *, agent_id: str, contact_id: str, customer_id: str | None,
           outcome: str) -> None:
    if table is None:
        return
    now = int(time.time())
    customer_ref = hashlib.sha256((customer_id or "unknown").encode("utf-8")).hexdigest()[:16]
    table.put_item(Item={
        "auditId": str(uuid.uuid4()),
        "eventType": "AGENT_LOCATION_VIEW",
        "agentId": agent_id,
        "contactId": contact_id,
        "customerRef": customer_ref,
        "outcome": outcome,
        "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "expiresAt": now + int(os.environ.get("AUDIT_TTL_DAYS", "365")) * 86400,
    })


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    contact_id = str((event.get("queryStringParameters") or {}).get("contactId", "")).strip()
    if not CONTACT_ID_PATTERN.fullmatch(contact_id):
        return _response(400, {"ok": False, "code": "INVALID_CONTACT_ID", "message": "A valid active contact is required."})

    claims = jwt_claims(event)
    agent_id = "unmapped"
    customer_id: str | None = None
    audit_table = None
    try:
        agent_id = connect_user_id_from_claims(claims, os.environ.get("AGENT_ID_CLAIM", "connect_user_id"))

        import boto3
        connect = boto3.client("connect")
        dynamodb = boto3.resource("dynamodb")
        current_table = dynamodb.Table(os.environ["CURRENT_LOCATION_TABLE"])
        audit_name = os.environ.get("AUDIT_TABLE", "")
        audit_table = dynamodb.Table(audit_name) if audit_name else None

        described = connect.describe_contact(
            InstanceId=os.environ["CONNECT_INSTANCE_ID"],
            ContactId=contact_id,
        )
        contact = described.get("Contact") or {}
        verify_agent_assignment(contact, agent_id)
        customer_id = customer_id_from_contact(
            contact,
            os.environ.get("CUSTOMER_ID_ATTRIBUTE", "customerId"),
        )

        result = current_table.get_item(Key={"customerId": customer_id}, ConsistentRead=True)
        location = result.get("Item")
        now = int(time.time())
        if not location or int(location.get("expiresAt", 0)) <= now:
            raise ApiError(404, "LOCATION_NOT_AVAILABLE", "No current consented location is available.")

        reverse_item = None
        nearby_items: list[dict[str, Any]] = []
        try:
            places = boto3.client("geo-places")
            position = [float(location["longitude"]), float(location["latitude"])]
            reverse = places.reverse_geocode(
                QueryPosition=position, MaxResults=1, Language="en-AU", IntendedUse="SingleUse"
            )
            nearby = places.search_nearby(
                QueryPosition=position,
                QueryRadius=min(max(float(location["accuracyMeters"]) * 3, 250), 2000),
                MaxResults=5,
                Language="en-AU",
                IntendedUse="SingleUse",
            )
            reverse_item = (reverse.get("ResultItems") or [None])[0]
            nearby_items = nearby.get("ResultItems") or []
        except Exception as error:  # Map remains usable when place enrichment is unavailable.
            LOGGER.warning(json.dumps({"event": "LOCATION_ENRICHMENT_FAILED", "type": type(error).__name__}))

        approximate = describe_approximate_location(location, reverse_item, nearby_items)
        _audit(audit_table, agent_id=agent_id, contact_id=contact_id, customer_id=customer_id, outcome="ALLOWED")
        return _response(200, {
            "ok": True,
            "location": {
                "latitude": float(location["latitude"]),
                "longitude": float(location["longitude"]),
                "accuracyRadiusMeters": float(location["accuracyMeters"]),
                "altitudeMeters": float(location["altitudeMeters"]) if location.get("altitudeMeters") is not None else None,
                "verticalAccuracyMeters": float(location["verticalAccuracyMeters"]) if location.get("verticalAccuracyMeters") is not None else None,
                "observedAt": location.get("observedAt"),
                "expiresAt": int(location["expiresAt"]),
                **approximate,
            },
            "notice": "Approximate, customer-consented location. Do not use as proof of identity.",
        })
    except ApiError as error:
        try:
            _audit(audit_table, agent_id=agent_id, contact_id=contact_id, customer_id=customer_id, outcome=error.code)
        except Exception:
            LOGGER.warning(json.dumps({"event": "LOCATION_AUDIT_FAILED"}))
        return _response(error.status, {"ok": False, "code": error.code, "message": error.message})
    except Exception as error:
        LOGGER.exception("Agent location request failed", extra={"errorType": type(error).__name__})
        return _response(500, {"ok": False, "code": "INTERNAL_ERROR", "message": "Location could not be loaded."})

