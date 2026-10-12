"use strict";

const OTP_LENGTH = 6;
const OTP_TTL_SECONDS = 90;
const MAX_ATTEMPTS = 3;

function parametersFromEvent(event = {}) {
  return { ...event, ...(event.Details?.Parameters || {}), ...(event.arguments || {}) };
}

function normalizeE164(phone) {
  const digits = String(phone || "").replace(/[^\d+]/g, "");
  return /^\+\d{6,15}$/.test(digits) ? digits : undefined;
}

function generateOtp() {
  const crypto = require("crypto");
  const max = 10 ** OTP_LENGTH;
  return String(crypto.randomInt(0, max)).padStart(OTP_LENGTH, "0");
}

function hashOtp(otp, salt) {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(`${salt}:${otp}`).digest("hex");
}

async function identify(input) {
  const phone = normalizeE164(input.phone);
  if (!phone) return { ok: false, code: "INVALID_PHONE" };

  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, QueryCommand } = await import("@aws-sdk/lib-dynamodb");
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const result = await db.send(new QueryCommand({
    TableName: process.env.CORE_DATA_TABLE,
    IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :pk",
    ExpressionAttributeValues: { ":pk": `PHONE#${phone}` },
    Limit: 1
  }));
  const match = result.Items?.[0];
  if (!match) return { ok: true, found: false };
  return { ok: true, found: true, customerId: match.customerId, firstName: match.firstName };
}

async function start(input) {
  const contactId = input.contactId;
  const customerId = input.customerId;
  if (!/^[A-Za-z0-9-]{8,256}$/.test(contactId || "")) {
    return { ok: false, code: "INVALID_CONTACT_ID" };
  }
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(customerId || "")) {
    return { ok: false, code: "INVALID_CUSTOMER_ID" };
  }

  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, QueryCommand, PutCommand } = await import("@aws-sdk/lib-dynamodb");
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const profile = await db.send(new QueryCommand({
    TableName: process.env.CORE_DATA_TABLE,
    KeyConditionExpression: "PK = :pk AND SK = :sk",
    ExpressionAttributeValues: { ":pk": `CUSTOMER#${customerId}`, ":sk": "PROFILE" }
  }));
  const phone = normalizeE164(profile.Items?.[0]?.phoneE164);
  if (!phone) return { ok: false, code: "NO_PHONE_ON_FILE" };

  const otp = generateOtp();
  const salt = contactId;
  const now = Math.floor(Date.now() / 1000);

  const { SNSClient, PublishCommand } = await import("@aws-sdk/client-sns");
  const sns = new SNSClient({});
  await sns.send(new PublishCommand({
    PhoneNumber: phone,
    Message: `Your WiseCalls verification code is ${otp}. It expires in 90 seconds. Never share this code.`
  }));

  await db.send(new PutCommand({
    TableName: process.env.OTP_SESSION_TABLE,
    Item: {
      contactId,
      customerId,
      otpHash: hashOtp(otp, salt),
      attempts: 0,
      createdAt: new Date().toISOString(),
      expiresAt: now + OTP_TTL_SECONDS
    }
  }));

  return { ok: true, sentToMasked: `••• •${phone.slice(-2)}` };
}

async function verify(input) {
  const contactId = input.contactId;
  const otp = String(input.otp || "").trim();
  if (!/^[A-Za-z0-9-]{8,256}$/.test(contactId || "")) {
    return { ok: false, code: "INVALID_CONTACT_ID" };
  }
  if (!/^\d{6}$/.test(otp)) {
    return { ok: true, verified: false, code: "INVALID_FORMAT" };
  }

  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, GetCommand, UpdateCommand, DeleteCommand } = await import("@aws-sdk/lib-dynamodb");
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const result = await db.send(new GetCommand({
    TableName: process.env.OTP_SESSION_TABLE,
    Key: { contactId },
    ConsistentRead: true
  }));
  const session = result.Item;
  const now = Math.floor(Date.now() / 1000);
  if (!session || Number(session.expiresAt) <= now) {
    return { ok: true, verified: false, code: "EXPIRED_OR_NOT_FOUND" };
  }
  if (Number(session.attempts) >= MAX_ATTEMPTS) {
    return { ok: true, verified: false, code: "TOO_MANY_ATTEMPTS" };
  }

  if (hashOtp(otp, contactId) === session.otpHash) {
    await db.send(new DeleteCommand({
      TableName: process.env.OTP_SESSION_TABLE,
      Key: { contactId }
    }));
    return { ok: true, verified: true, customerId: session.customerId };
  }

  const attempts = Number(session.attempts) + 1;
  await db.send(new UpdateCommand({
    TableName: process.env.OTP_SESSION_TABLE,
    Key: { contactId },
    UpdateExpression: "SET attempts = :attempts",
    ExpressionAttributeValues: { ":attempts": attempts }
  }));
  return { ok: true, verified: false, code: "INCORRECT_CODE", attemptsRemaining: Math.max(0, MAX_ATTEMPTS - attempts) };
}

async function handler(event) {
  const input = parametersFromEvent(event);
  if (!input.contactId && event.Details?.ContactData?.ContactId) {
    input.contactId = event.Details.ContactData.ContactId;
  }
  if (input.action === "identify") return identify(input);
  if (input.action === "start") return start(input);
  if (input.action === "verify") return verify(input);
  return { ok: false, code: "UNKNOWN_ACTION" };
}

module.exports = { handler, normalizeE164, generateOtp, hashOtp, identify, start, verify };
