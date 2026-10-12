"use strict";

function isDue(item, nowSeconds) {
  return item.status === "PENDING" && Number(item.dueAt) <= nowSeconds;
}

async function handler() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, QueryCommand, UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
  const { ConnectClient, StartOutboundVoiceContactCommand } = await import("@aws-sdk/client-connect");
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const connect = new ConnectClient({});

  const dueItems = [];
  let exclusiveStartKey;
  try {
    do {
      const page = await db.send(new QueryCommand({
        TableName: process.env.CALLBACK_BOOKING_TABLE,
        IndexName: "StatusIndex",
        KeyConditionExpression: "#s = :pending AND dueAt <= :now",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":pending": "PENDING", ":now": nowSeconds },
        ExclusiveStartKey: exclusiveStartKey
      }));
      dueItems.push(...(page.Items || []));
      exclusiveStartKey = page.LastEvaluatedKey;
    } while (exclusiveStartKey);
  } catch (error) {
    // Nothing has been claimed yet, so it is always safe to give up this cycle
    // and let the next 5-minute tick retry from scratch, rather than throwing
    // and triggering Lambda's own automatic async-invoke retry.
    return { ok: false, triggered: 0, code: "QUERY_FAILED" };
  }

  let triggered = 0;
  for (const item of dueItems) {
    if (!isDue(item, nowSeconds)) continue;

    // Step 1: claim the booking. Any failure here (already claimed, or a transient
    // error) means no call has been placed yet, so it is always safe to skip this
    // item and let the next 5-minute cycle retry it.
    try {
      await db.send(new UpdateCommand({
        TableName: process.env.CALLBACK_BOOKING_TABLE,
        Key: { slotKey: item.slotKey },
        UpdateExpression: "SET #s = :called, lastAttemptAt = :now",
        ConditionExpression: "#s = :pending",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":called": "CALLED", ":pending": "PENDING", ":now": nowSeconds }
      }));
    } catch (error) {
      console.error(JSON.stringify({ event: "CLAIM_FAILED", slotKey: item.slotKey, error: String(error) }));
      continue;
    }

    // Step 2: place the real call. ClientToken is scoped to this booking's
    // current logical attempt (slotKey + retryCount), not just the slotKey.
    // record-callback-outcome increments retryCount once (0 -> 1) when it
    // schedules the deliberate no-answer retry, so that retry gets a fresh
    // token and is not deduped away by Connect. Within a single attempt,
    // retryCount is untouched by the revert-to-PENDING path below, so an
    // ambiguous-failure retry (the SDK throws, but Connect may have already
    // accepted the call server-side before the network error occurred) still
    // reuses the same token, and Connect's own idempotency handling prevents
    // a second real call even though this client-side code cannot itself
    // distinguish "never went out" from "went out, ack lost."
    let outcome;
    try {
      outcome = await connect.send(new StartOutboundVoiceContactCommand({
        ClientToken: `${item.slotKey}#${item.retryCount ?? 0}`,
        DestinationPhoneNumber: item.phoneE164,
        ContactFlowId: process.env.CALLBACK_OUTBOUND_FLOW_ID,
        InstanceId: process.env.CONNECT_INSTANCE_ARN,
        QueueId: process.env.CALLBACK_QUEUE_ARN,
        Attributes: { reasonCategory: item.reasonCategory || "OTHER", slotKey: item.slotKey }
      }));
    } catch (error) {
      try {
        await db.send(new UpdateCommand({
          TableName: process.env.CALLBACK_BOOKING_TABLE,
          Key: { slotKey: item.slotKey },
          UpdateExpression: "SET #s = :pending",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":pending": "PENDING" }
        }));
      } catch (revertError) {
        // Intentionally swallowed. The item stays CALLED with no contactId and
        // will not be retried automatically — safer than letting an uncaught
        // exception here abort the rest of this cycle's batch or trigger
        // Lambda's own async retry on top of the ClientToken retry semantics
        // above.
      }
      console.error(JSON.stringify({ event: "DIAL_FAILED_REVERTED", slotKey: item.slotKey, error: String(error) }));
      continue;
    }

    // Step 3: record the contactId for outcome-matching (Task 5). The real call has
    // already been placed by this point — a failure here must NEVER revert status
    // back to PENDING, since that would cause a duplicate real call next cycle.
    // Leave the booking CALLED even if this write fails; the contactId will simply
    // be missing for that one booking, to be reconciled out-of-band.
    try {
      await db.send(new UpdateCommand({
        TableName: process.env.CALLBACK_BOOKING_TABLE,
        Key: { slotKey: item.slotKey },
        UpdateExpression: "SET contactId = :cid",
        ExpressionAttributeValues: { ":cid": outcome.ContactId }
      }));
    } catch (error) {
      // Intentionally swallowed — see comment above. The call already happened;
      // reverting here would risk a duplicate call, which is worse than a missing contactId.
      console.error(JSON.stringify({ event: "CONTACT_ID_WRITE_FAILED", slotKey: item.slotKey, error: String(error) }));
    }
    triggered += 1;
  }
  return { ok: true, triggered };
}

module.exports = { handler, isDue };
