"use strict";

function parametersFromEvent(event = {}) {
  let body = event.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  return { ...event, ...(body || {}), ...(event.Details?.Parameters || {}) };
}

function validateCoordinates(input) {
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  const accuracyMeters = Number(input.accuracyMeters);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return undefined;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return undefined;
  if (!Number.isFinite(accuracyMeters) || accuracyMeters <= 0 || accuracyMeters > 50000) return undefined;
  const coordinates = { latitude, longitude, accuracyMeters };
  if (input.altitudeMeters !== undefined && input.altitudeMeters !== null && input.altitudeMeters !== "") {
    const altitudeMeters = Number(input.altitudeMeters);
    if (!Number.isFinite(altitudeMeters) || altitudeMeters < -500 || altitudeMeters > 20000) return undefined;
    coordinates.altitudeMeters = altitudeMeters;
  }
  if (input.verticalAccuracyMeters !== undefined && input.verticalAccuracyMeters !== null && input.verticalAccuracyMeters !== "") {
    const verticalAccuracyMeters = Number(input.verticalAccuracyMeters);
    if (!Number.isFinite(verticalAccuracyMeters) || verticalAccuracyMeters <= 0 || verticalAccuracyMeters > 50000) return undefined;
    coordinates.verticalAccuracyMeters = verticalAccuracyMeters;
  }
  return coordinates;
}

function normalizeE164(phone) {
  const digits = String(phone || "").replace(/[^\d+]/g, "");
  return /^\+\d{6,15}$/.test(digits) ? digits : undefined;
}

function authenticatedCustomerId(event = {}) {
  const claims = event.requestContext?.authorizer?.jwt?.claims || {};
  return claims["custom:customer_id"] || claims.customer_id;
}

function describeLocation(location, reverseItem, nearbyItems = []) {
  const address = reverseItem?.Address || {};
  const locality = address.Locality || address.District || reverseItem?.Title;
  const landmark = nearbyItems
    .filter((item) => item.Title && Number.isFinite(Number(item.Distance)))
    .sort((a, b) => Number(a.Distance) - Number(b.Distance))[0];
  const accuracy = Number(location.accuracyMeters);
  const landmarkDistance = Number(landmark?.Distance);
  const reliableLandmark = accuracy <= 150
    && Number.isFinite(landmarkDistance)
    && landmarkDistance <= Math.max(250, accuracy * 2);

  let spokenLocation;
  let confidence;
  if (reliableLandmark) {
    spokenLocation = locality
      ? `Near ${landmark.Title}, around ${locality}`
      : `Near ${landmark.Title}`;
    confidence = "LANDMARK_APPROXIMATE";
  } else if (locality) {
    spokenLocation = `Approximately around ${locality}`;
    confidence = accuracy <= 500 ? "LOCALITY_APPROXIMATE" : "LOW_ACCURACY";
  } else {
    spokenLocation = `A current GPS position was received with approximately ${Math.round(accuracy)} metres accuracy`;
    confidence = "COORDINATES_ONLY";
  }

  return {
    spokenLocation,
    confidence,
    locality,
    nearbyLandmark: reliableLandmark ? landmark.Title : undefined,
    landmarkDistanceMeters: reliableLandmark ? landmarkDistance : undefined,
    reverseGeocodedAddress: address.Label,
    map: {
      latitude: location.latitude,
      longitude: location.longitude,
      accuracyRadiusMeters: accuracy
    }
  };
}

async function handler(event) {
  const input = parametersFromEvent(event);
  if (input.action === "create") {
    const contactId = input.contactId || event.Details?.ContactData?.ContactId;
    if (!/^[A-Za-z0-9-]{8,256}$/.test(contactId || "")) {
      return { ok: false, code: "INVALID_CONTACT_ID" };
    }
    const sessionId = `${crypto.randomUUID()}${crypto.randomUUID().replaceAll("-", "")}`;
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + Number(process.env.LOCATION_TTL_HOURS || 1) * 3600;
    const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
    const { DynamoDBDocumentClient, PutCommand } = await import("@aws-sdk/lib-dynamodb");
    const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    await db.send(new PutCommand({
      TableName: process.env.LOCATION_SESSION_TABLE,
      Item: {
        sessionId,
        contactId,
        customerId: input.customerId,
        createdAt: new Date().toISOString(),
        expiresAt
      },
      ConditionExpression: "attribute_not_exists(sessionId)"
    }));
    const locationUrl = `${process.env.LOCATION_WEB_BASE_URL || ""}?session=${encodeURIComponent(sessionId)}`;

    const phone = normalizeE164(input.phone);
    let smsSent = false;
    if (phone) {
      const { SNSClient, PublishCommand } = await import("@aws-sdk/client-sns");
      const sns = new SNSClient({});
      await sns.send(new PublishCommand({
        PhoneNumber: phone,
        Message: `WiseCalls: share your current location securely here (link expires soon): ${locationUrl}`
      }));
      smsSent = true;
    }

    return {
      ok: true,
      sessionId,
      expiresAt,
      locationUrl,
      smsSent
    };
  }

  if (input.action === "getCurrent") {
    if (input.customerVerified !== true && input.customerVerified !== "true") {
      return { ok: false, code: "AUTHENTICATION_REQUIRED" };
    }
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(input.customerId || "")) {
      return { ok: false, code: "INVALID_CUSTOMER_ID" };
    }
    const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
    const { DynamoDBDocumentClient, GetCommand } = await import("@aws-sdk/lib-dynamodb");
    const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const result = await db.send(new GetCommand({
      TableName: process.env.CURRENT_LOCATION_TABLE,
      Key: { customerId: input.customerId },
      ConsistentRead: true
    }));
    const current = result.Item;
    if (!current || Number(current.expiresAt) <= Math.floor(Date.now() / 1000)) {
      return { ok: false, code: "CURRENT_LOCATION_NOT_AVAILABLE" };
    }

    let reverseItem;
    let nearbyItems = [];
    try {
      const {
        GeoPlacesClient,
        ReverseGeocodeCommand,
        SearchNearbyCommand
      } = await import("@aws-sdk/client-geo-places");
      const places = new GeoPlacesClient({});
      const position = [Number(current.longitude), Number(current.latitude)];
      const [reverse, nearby] = await Promise.all([
        places.send(new ReverseGeocodeCommand({
          QueryPosition: position,
          MaxResults: 1,
          Language: "en-AU",
          IntendedUse: "SingleUse"
        })),
        places.send(new SearchNearbyCommand({
          QueryPosition: position,
          QueryRadius: Math.min(Math.max(Number(current.accuracyMeters) * 3, 250), 2000),
          MaxResults: 5,
          Language: "en-AU",
          IntendedUse: "SingleUse"
        }))
      ]);
      reverseItem = reverse.ResultItems?.[0];
      nearbyItems = nearby.ResultItems || [];
    } catch (error) {
      console.warn(JSON.stringify({ event: "LOCATION_ENRICHMENT_FAILED", name: error.name }));
    }

    return {
      ok: true,
      customerId: current.customerId,
      observedAt: current.observedAt,
      receivedAt: current.receivedAt,
      ...describeLocation(current, reverseItem, nearbyItems),
      instruction: "State that the location is approximate. Never claim a landmark unless nearbyLandmark is present."
    };
  }

  const coordinates = validateCoordinates(input);
  const isCurrentLocationUpdate = event.routeKey === "POST /location/current";
  if (isCurrentLocationUpdate) {
    const customerId = authenticatedCustomerId(event);
    if (!coordinates || !/^[A-Za-z0-9_-]{6,128}$/.test(customerId || "")) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, code: "INVALID_REQUEST" }) };
    }
    const now = Math.floor(Date.now() / 1000);
    const observedAt = input.observedAt || new Date().toISOString();
    const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
    const { DynamoDBDocumentClient, PutCommand } = await import("@aws-sdk/lib-dynamodb");
    const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    await db.send(new PutCommand({
      TableName: process.env.CURRENT_LOCATION_TABLE,
      Item: {
        customerId,
        ...coordinates,
        observedAt,
        receivedAt: new Date().toISOString(),
        source: "AUTHENTICATED_WEB_OR_MOBILE_CLIENT",
        expiresAt: now + Number(process.env.CURRENT_LOCATION_TTL_MINUTES || 15) * 60
      }
    }));
    return { statusCode: 200, body: JSON.stringify({ ok: true, observedAt }) };
  }

  if (!coordinates || !/^[A-Za-z0-9_-]{16,128}$/.test(input.sessionId || "")) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, code: "INVALID_REQUEST" }) };
  }

  const now = Math.floor(Date.now() / 1000);
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  try {
    const updateParts = [
      "latitude=:lat",
      "longitude=:lon",
      "accuracyMeters=:acc",
      "consentAt=:consent",
      "submittedAt=:now"
    ];
    const expressionValues = {
      ":lat": coordinates.latitude,
      ":lon": coordinates.longitude,
      ":acc": coordinates.accuracyMeters,
      ":consent": input.consentAt || new Date().toISOString(),
      ":now": new Date().toISOString(),
      ":epoch": now
    };
    if (coordinates.altitudeMeters !== undefined) {
      updateParts.push("altitudeMeters=:alt");
      expressionValues[":alt"] = coordinates.altitudeMeters;
    }
    if (coordinates.verticalAccuracyMeters !== undefined) {
      updateParts.push("verticalAccuracyMeters=:vacc");
      expressionValues[":vacc"] = coordinates.verticalAccuracyMeters;
    }
    await db.send(new UpdateCommand({
      TableName: process.env.LOCATION_SESSION_TABLE,
      Key: { sessionId: input.sessionId },
      UpdateExpression: `SET ${updateParts.join(", ")}`,
      ConditionExpression: "attribute_exists(sessionId) AND expiresAt > :epoch AND attribute_not_exists(submittedAt)",
      ExpressionAttributeValues: expressionValues
    }));
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") {
      return { statusCode: 409, body: JSON.stringify({ ok: false, code: "EXPIRED_OR_USED" }) };
    }
    throw error;
  }
}

module.exports = {
  handler,
  authenticatedCustomerId,
  describeLocation,
  normalizeE164,
  parametersFromEvent,
  validateCoordinates
};
