"use strict";

function parametersFromEvent(event = {}) {
  return { ...event, ...(event.Details?.Parameters || {}), ...(event.arguments || {}) };
}

function selectEffectiveRate(items, asOf) {
  const target = new Date(asOf || Date.now()).getTime();
  return items
    .filter((item) => item.status === "APPROVED")
    .filter((item) => new Date(item.effectiveFrom).getTime() <= target)
    .filter((item) => !item.effectiveTo || new Date(item.effectiveTo).getTime() >= target)
    .sort((a, b) => String(b.effectiveFrom).localeCompare(String(a.effectiveFrom)))[0];
}

async function handler(event) {
  const input = parametersFromEvent(event);
  const productCode = String(input.productCode || "").toUpperCase();
  if (!/^[A-Z0-9_-]{2,40}$/.test(productCode)) {
    return { ok: false, code: "INVALID_PRODUCT_CODE" };
  }

  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, QueryCommand } = await import("@aws-sdk/lib-dynamodb");
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const result = await db.send(new QueryCommand({
    TableName: process.env.CORE_DATA_TABLE,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: {
      ":pk": `PRODUCT#${productCode}`,
      ":prefix": "RATE#"
    }
  }));
  const rate = selectEffectiveRate(result.Items || [], input.asOf);
  if (!rate) return { ok: false, code: "RATE_NOT_FOUND" };

  return {
    ok: true,
    productCode,
    productName: rate.productName,
    interestRatePa: rate.interestRatePa,
    comparisonRatePa: rate.comparisonRatePa,
    rateType: rate.rateType,
    effectiveFrom: rate.effectiveFrom,
    effectiveTo: rate.effectiveTo,
    sourceId: rate.sourceId,
    disclaimer: rate.disclaimer,
    instruction: "Reproduce numeric values exactly. Do not infer eligibility or approval."
  };
}

module.exports = { handler, parametersFromEvent, selectEffectiveRate };
