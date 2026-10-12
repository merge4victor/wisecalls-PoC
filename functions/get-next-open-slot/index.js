"use strict";

const START_MINUTES = 14 * 60; // 14:00
const END_MINUTES = 16 * 60; // 16:00, exclusive upper bound for slot starts
const SLOT_MINUTES = 15;
const SYDNEY_OFFSET_MINUTES = 10 * 60; // ap-southeast-2 AEST, no DST handling needed for this PoC

function parametersFromEvent(event = {}) {
  return { ...event, ...(event.Details?.Parameters || {}) };
}

function toSydneyParts(utcDate) {
  const local = new Date(utcDate.getTime() + SYDNEY_OFFSET_MINUTES * 60000);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    minutesSinceMidnight: local.getUTCHours() * 60 + local.getUTCMinutes()
  };
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function computeCandidateSlots(now) {
  const parts = toSydneyParts(now);
  const dateStr = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  const nextBoundary = Math.ceil(parts.minutesSinceMidnight / SLOT_MINUTES) * SLOT_MINUTES;
  const firstSlotMinutes = Math.max(START_MINUTES, nextBoundary);
  const slots = [];
  for (let minutes = firstSlotMinutes; minutes < END_MINUTES; minutes += SLOT_MINUTES) {
    const hh = Math.floor(minutes / 60);
    const mm = minutes % 60;
    slots.push(`${dateStr}#${pad2(hh)}:${pad2(mm)}`);
  }
  return slots;
}

function nextOpenSlot(candidates, excluded, taken) {
  const excludedSet = new Set(excluded);
  return candidates.find((slot) => !excludedSet.has(slot) && !taken.has(slot));
}

function formatSlotLabel(slotKey) {
  const [, time] = slotKey.split("#");
  const [hourStr, minuteStr] = time.split(":");
  const hour24 = Number(hourStr);
  const suffix = hour24 >= 12 ? "pm" : "am";
  const hour12 = ((hour24 + 11) % 12) + 1;
  return `${hour12}:${minuteStr}${suffix}`;
}

async function handler(event) {
  const input = parametersFromEvent(event);
  const excluded = String(input.excludedSlots || "").split(",").map((s) => s.trim()).filter(Boolean);
  const candidates = computeCandidateSlots(new Date());
  if (candidates.length === 0) return { ok: true, available: false };

  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, BatchGetCommand } = await import("@aws-sdk/lib-dynamodb");
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const result = await db.send(new BatchGetCommand({
    RequestItems: {
      [process.env.CALLBACK_BOOKING_TABLE]: {
        Keys: candidates.map((slotKey) => ({ slotKey }))
      }
    }
  }));
  const taken = new Set((result.Responses?.[process.env.CALLBACK_BOOKING_TABLE] || []).map((item) => item.slotKey));

  const slotKey = nextOpenSlot(candidates, excluded, taken);
  if (!slotKey) return { ok: true, available: false };
  return { ok: true, available: true, slotKey, slotLabel: formatSlotLabel(slotKey) };
}

module.exports = { handler, computeCandidateSlots, nextOpenSlot, formatSlotLabel, parametersFromEvent };
