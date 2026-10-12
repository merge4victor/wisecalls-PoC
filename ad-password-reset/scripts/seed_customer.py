#!/usr/bin/env python3
"""Seed one registered customer using the same HMAC lookup key as Lambda."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path

import boto3


def stack_outputs(client, stack_name: str) -> dict[str, str]:
    stack = client.describe_stacks(StackName=stack_name)["Stacks"][0]
    return {item["OutputKey"]: item["OutputValue"] for item in stack.get("Outputs", [])}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stack-name", required=True)
    parser.add_argument("--region", default="ap-southeast-2")
    parser.add_argument("--profile")
    parser.add_argument("--customer", default=str(Path(__file__).parents[1] / "config" / "seed-customer.example.json"))
    parser.add_argument(
        "--phone",
        default=os.environ.get("WISECALLS_OPERATOR_PHONE"),
        help="Registered mobile in E.164 form. Defaults to WISECALLS_OPERATOR_PHONE, then the customer file.",
    )
    parser.add_argument("--apply", action="store_true", help="Actually write the DynamoDB record.")
    args = parser.parse_args()

    customer = json.loads(Path(args.customer).read_text(encoding="utf-8"))
    if args.phone:
        customer["phoneE164"] = args.phone
    phone = customer.get("phoneE164", "")
    if not phone.startswith("+") or not phone[1:].isdigit():
        raise ValueError("Set --phone or WISECALLS_OPERATOR_PHONE to an E.164 number, for example +61491570156")

    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    outputs = stack_outputs(session.client("cloudformation"), args.stack_name)

    secret = session.client("secretsmanager").get_secret_value(
        SecretId=outputs["ResetHmacSecretArn"]
    )["SecretString"]
    key = json.loads(secret)["key"].encode("utf-8")
    customer["phoneHash"] = hmac.new(
        key, f"phone:{phone}".encode("utf-8"), hashlib.sha256
    ).hexdigest()

    safe = {**customer, "phoneHash": customer["phoneHash"][:8] + "…", "phoneE164": "••••••" + phone[-4:]}
    print(json.dumps({"table": outputs["CustomerDirectoryTableName"], "item": safe}, indent=2))
    if not args.apply:
        print("DRY RUN: add --apply to write this record.")
        return
    session.resource("dynamodb").Table(outputs["CustomerDirectoryTableName"]).put_item(
        Item=customer,
        ConditionExpression="attribute_not_exists(phoneHash)",
    )
    print("Customer record created. No secret values were printed.")


if __name__ == "__main__":
    main()
