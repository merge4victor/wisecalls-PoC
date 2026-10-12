"use strict";

const RETRY_DELAY_SECONDS = 7 * 60;

function wasAnswered(detail) {
  return Boolean(detail.connectedToSystemTimestamp);
}

function nextRetryState(retryCount, nowSeconds) {
  if (retryCount >= 1) return { status: "MISSED", retryCount };
  return { status: "PENDING", retryCount: retryCount + 1, dueAt: nowSeconds + RETRY_DELAY_SECONDS };
}

function buildUpdateExpression(update) {
  const names = { "#s": "status" };
  const values = { ":calledStatus": "CALLED", ":newStatus": update.status };
  let expression = "SET #s = :newStatus";
  if (update.retryCount !== undefined) {
    expression += ", retryCount = :retryCount";
    values[":retryCount"] = update.retryCount;
  }
  if (update.dueAt !== undefined) {
    expression += ", dueAt = :dueAt";
    values[":dueAt"] = update.dueAt;
  }
  return { names, expression, values };
}

async function handler(event) {
  const detail = event.detail || {};
  if (detail.initiationMethod !== "API" || detail.channel?.toUpperCase() !== "VOICE") {
    return { ok: true, skipped: true };
  }

  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, QueryCommand, UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const match = await db.send(new QueryCommand({
    TableName: process.env.CALLBACK_BOOKING_TABLE,
    IndexName: "ContactIdIndex",
    KeyConditionExpression: "contactId = :cid",
    ExpressionAttributeValues: { ":cid": detail.contactId }
  }));
  const booking = match.Items?.[0];
  if (!booking) return { ok: true, matched: false };

  const nowSeconds = Math.floor(Date.now() / 1000);
  const update = wasAnswered(detail)
    ? { status: "COMPLETED" }
    : nextRetryState(Number(booking.retryCount || 0), nowSeconds);

  const { names, expression, values } = buildUpdateExpression(update);

  await db.send(new UpdateCommand({
    TableName: process.env.CALLBACK_BOOKING_TABLE,
    Key: { slotKey: booking.slotKey },
    UpdateExpression: expression,
    ConditionExpression: "#s = :calledStatus",
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values
  })).catch((error) => {
    if (error?.name !== "ConditionalCheckFailedException") throw error;
  });

  return { ok: true, matched: true, newStatus: update.status };
}

module.exports = { handler, wasAnswered, nextRetryState, buildUpdateExpression };
