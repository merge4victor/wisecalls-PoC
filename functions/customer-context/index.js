"use strict";

const MASK = "••••";

function parametersFromEvent(event = {}) {
  return {
    ...event,
    ...(event.Details?.Parameters || {}),
    ...(event.arguments || {})
  };
}

function maskTail(value, visible = 4) {
  if (!value) return undefined;
  const text = String(value).replace(/\s+/g, "");
  return text.length <= visible ? MASK : `${MASK} ${text.slice(-visible)}`;
}

function safeContext(items = []) {
  const profile = items.find((item) => item.SK === "PROFILE") || {};
  const vehicles = items
    .filter((item) => String(item.SK || "").startsWith("VEHICLE#"))
    .map((item) => ({
      vehicleId: item.vehicleId,
      registrationMasked: maskTail(item.registration, 3),
      make: item.make,
      model: item.model,
      year: item.year,
      colour: item.colour
    }));
  const policies = items
    .filter((item) => String(item.SK || "").startsWith("POLICY#"))
    .map((item) => ({
      policyIdMasked: maskTail(item.policyId),
      product: item.product,
      status: item.status,
      renewalDate: item.renewalDate
    }));

  return {
    customerId: profile.customerId,
    displayName: profile.preferredName || profile.firstName,
    preferredLanguage: profile.preferredLanguage,
    vehicles,
    policies
  };
}

async function handler(event) {
  const input = parametersFromEvent(event);
  if (input.customerVerified !== true && input.customerVerified !== "true") {
    return { ok: false, code: "AUTHENTICATION_REQUIRED" };
  }
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(input.customerId || "")) {
    return { ok: false, code: "INVALID_CUSTOMER_ID" };
  }

  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, QueryCommand, PutCommand } =
    await import("@aws-sdk/lib-dynamodb");
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const result = await db.send(new QueryCommand({
    TableName: process.env.CORE_DATA_TABLE,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": `CUSTOMER#${input.customerId}` },
    ConsistentRead: false
  }));
  const output = { ok: true, ...safeContext(result.Items) };

  await db.send(new PutCommand({
    TableName: process.env.AUDIT_TABLE,
    Item: {
      auditId: crypto.randomUUID(),
      eventTime: new Date().toISOString(),
      action: "GET_CUSTOMER_CONTEXT",
      customerId: input.customerId,
      contactId: input.contactId || event.Details?.ContactData?.ContactId || "unknown",
      outcome: "SUCCESS",
      expiresAt: Math.floor(Date.now() / 1000) + 31536000
    }
  }));
  return output;
}

module.exports = { handler, maskTail, parametersFromEvent, safeContext };
