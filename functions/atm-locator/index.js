"use strict";

function parametersFromEvent(event = {}) {
  return { ...event, ...(event.Details?.Parameters || {}), ...(event.arguments || {}) };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function rankAtms(items, input) {
  return items
    .filter((item) => item.status === "ACTIVE")
    .filter((item) => !input.depositRequired || item.depositCapable === true)
    .filter((item) => !input.accessibilityRequired || item.accessible === true)
    .map((item) => ({
      atmId: item.atmId,
      name: item.name,
      address: item.address,
      distanceKm: Number(haversineKm(
        Number(input.latitude),
        Number(input.longitude),
        Number(item.latitude),
        Number(item.longitude)
      ).toFixed(2)),
      openingHours: item.openingHours,
      depositCapable: item.depositCapable,
      accessible: item.accessible,
      lastVerifiedAt: item.lastVerifiedAt
    }))
    .filter((item) => item.distanceKm <= Number(input.radiusKm || 25))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, Math.min(Number(input.limit || 3), 5));
}

async function handler(event) {
  const input = parametersFromEvent(event);
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return { ok: false, code: "INVALID_COORDINATES" };
  }

  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, QueryCommand } = await import("@aws-sdk/lib-dynamodb");
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const result = await db.send(new QueryCommand({
    TableName: process.env.CORE_DATA_TABLE,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: { ":pk": "DIRECTORY#ATM", ":prefix": "ATM#" }
  }));
  const atms = rankAtms(result.Items || [], { ...input, latitude, longitude });
  return {
    ok: true,
    atms,
    distanceType: "straight_line",
    instruction: "Locations come from the bank-maintained directory. Confirm hours if lastVerifiedAt is stale."
  };
}

module.exports = { handler, haversineKm, parametersFromEvent, rankAtms };
