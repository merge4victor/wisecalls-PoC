"use strict";

const SLOT_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}#\d{2}:\d{2}$/;
const PHONE_PATTERN = /^\+\d{6,15}$/;
const REASON_CATEGORIES = new Set(["GENERAL_ENQUIRY", "PRODUCT_OR_ACCOUNT", "EXISTING_CASE", "OTHER"]);
const ALLOWLIST_ENV_VAR = "CALLBACK_ALLOWED_PHONE_PREFIXES";
const SLOT_TAKEN = "SLOT_TAKEN";
const RETRYABLE_CODES = new Set([SLOT_TAKEN]);

// Comma-separated E.164 prefixes. A full-length entry such as "+61491570156" is
// an exact match; "+614" widens to every Australian mobile. An unset or empty
// value yields an empty list, and `some` over an empty list is false — the
// allowlist therefore fails closed rather than open.
function allowedPrefixes() {
  return String(process.env[ALLOWLIST_ENV_VAR] || "")
    .split(",")
    .map((prefix) => prefix.trim())
    .filter(Boolean);
}

function isPhoneAllowed(phoneE164, prefixes = allowedPrefixes()) {
  return prefixes.some((prefix) => phoneE164.startsWith(prefix));
}

// The contact flow reads this as $.External.retryable. Only a lost race for a
// slot is worth re-offering another time; every other failure is permanent for
// this caller, and looping on it would walk them through the whole day's slots.
function isRetryable(code) {
  return RETRYABLE_CODES.has(code);
}

function parametersFromEvent(event = {}) {
  return { ...event, ...(event.Details?.Parameters || {}) };
}

function trustedPhoneFromEvent(event) {
  return event.Details?.ContactData?.CustomerEndpoint?.Address;
}

function slotKeyToEpochSeconds(slotKey) {
  const [datePart, timePart] = slotKey.split("#");
  const isoLocal = `${datePart}T${timePart}:00+10:00`;
  return Math.floor(new Date(isoLocal).getTime() / 1000);
}

function buildBookingItem(input, nowSeconds) {
  const slotKey = String(input.slotKey || "");
  if (!SLOT_KEY_PATTERN.test(slotKey)) throw new Error("INVALID_SLOT_KEY");
  const phoneE164 = String(input.phoneE164 || "");
  if (!PHONE_PATTERN.test(phoneE164)) throw new Error("INVALID_PHONE");
  if (!isPhoneAllowed(phoneE164)) throw new Error("PHONE_NOT_ALLOWED");
  const requestedCategory = String(input.reasonCategory || "OTHER").toUpperCase();
  const reasonCategory = REASON_CATEGORIES.has(requestedCategory) ? requestedCategory : "OTHER";

  return {
    slotKey,
    phoneE164,
    reasonCategory,
    status: "PENDING",
    retryCount: 0,
    dueAt: slotKeyToEpochSeconds(slotKey),
    createdAt: nowSeconds
  };
}

async function handler(event) {
  const input = parametersFromEvent(event);
  input.phoneE164 = trustedPhoneFromEvent(event);

  let item;
  try {
    item = buildBookingItem(input, Math.floor(Date.now() / 1000));
  } catch (error) {
    return { ok: false, code: error.message, retryable: isRetryable(error.message) };
  }

  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, PutCommand } = await import("@aws-sdk/lib-dynamodb");
  const { ConditionalCheckFailedException } = await import("@aws-sdk/client-dynamodb");
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  try {
    await db.send(new PutCommand({
      TableName: process.env.CALLBACK_BOOKING_TABLE,
      Item: item,
      ConditionExpression: "attribute_not_exists(slotKey)"
    }));
    return { ok: true, booked: true, retryable: true };
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException || error?.name === "ConditionalCheckFailedException") {
      return { ok: true, booked: false, code: SLOT_TAKEN, retryable: isRetryable(SLOT_TAKEN) };
    }
    throw error;
  }
}

module.exports = {
  handler,
  buildBookingItem,
  slotKeyToEpochSeconds,
  parametersFromEvent,
  trustedPhoneFromEvent,
  allowedPrefixes,
  isPhoneAllowed,
  isRetryable
};
