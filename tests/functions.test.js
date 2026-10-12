"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const customer = require("../functions/customer-context/index.js");
const rates = require("../functions/product-rates/index.js");
const atms = require("../functions/atm-locator/index.js");
const cases = require("../functions/cases-context/index.js");
const messages = require("../functions/message-processor/index.js");
const location = require("../functions/location-session/index.js");
const verification = require("../functions/customer-verification/index.js");
const redactionTeardown = require("../functions/redaction-demo-teardown/index.js");

test("maskTail exposes only final characters", () => {
  assert.equal(customer.maskTail("1234 5678 9012 3456"), "•••• 3456");
});

test("safeContext excludes full registration and policy identifiers", () => {
  const output = customer.safeContext([
    { SK: "PROFILE", customerId: "cust1", firstName: "Alex" },
    { SK: "VEHICLE#1", vehicleId: "v1", registration: "ABC123", make: "Toyota" },
    { SK: "POLICY#1", policyId: "POLICY0001", product: "Motor" }
  ]);
  assert.equal(output.vehicles[0].registrationMasked, "•••• 123");
  assert.equal(output.policies[0].policyIdMasked, "•••• 0001");
  assert.equal(JSON.stringify(output).includes("ABC123"), false);
});

test("selectEffectiveRate selects latest valid rate", () => {
  const selected = rates.selectEffectiveRate([
    { status: "APPROVED", effectiveFrom: "2026-01-01", interestRatePa: "7.00%" },
    { status: "APPROVED", effectiveFrom: "2026-07-01", interestRatePa: "6.50%" },
    { status: "DRAFT", effectiveFrom: "2026-07-20", interestRatePa: "1.00%" }
  ], "2026-07-31");
  assert.equal(selected.interestRatePa, "6.50%");
});

test("ATM ranking applies distance and capability filters", () => {
  const ranked = atms.rankAtms([
    { status: "ACTIVE", atmId: "1", latitude: -33.8688, longitude: 151.2093, depositCapable: true, accessible: true },
    { status: "ACTIVE", atmId: "2", latitude: -34.0, longitude: 151.0, depositCapable: false, accessible: true },
    { status: "DRAFT", atmId: "3", latitude: -33.8688, longitude: 151.2093, depositCapable: true, accessible: true }
  ], {
    latitude: -33.87,
    longitude: 151.21,
    radiusKm: 10,
    depositRequired: true,
    accessibilityRequired: false
  });
  assert.deepEqual(ranked.map((item) => item.atmId), ["1"]);
});

test("case comments are sorted newest first and bounded", () => {
  const result = cases.commentsFromRelatedItems([
    { type: "Comment", associationTime: "2026-01-01", content: { comment: { body: "Old" } } },
    { type: "Comment", associationTime: "2026-02-01", content: { comment: { body: "New" } } }
  ], 1);
  assert.equal(result[0].body, "New");
  assert.equal(result.length, 1);
});

test("message processor blocks credential disclosures", () => {
  const result = messages.sanitizeMessage("my PIN is 1234");
  assert.equal(result.blocked, true);
  assert.equal(result.text.includes("1234"), false);
});

test("message processor emits the Connect custom processor contract", async () => {
  const result = await messages.handler({
    chatContent: { content: "my OTP is 123456", contentType: "text/plain" }
  });
  assert.equal(result.status, "PROCESSED");
  assert.equal(result.result.processedChatContent.contentType, "text/plain");
  assert.equal(result.result.processedChatContent.content.includes("123456"), false);
});

test("location validation rejects invalid coordinates", () => {
  assert.equal(location.validateCoordinates({ latitude: 91, longitude: 151, accuracyMeters: 10 }), undefined);
  assert.deepEqual(
    location.validateCoordinates({
      latitude: -33.86,
      longitude: 151.2,
      altitudeMeters: 42.5,
      accuracyMeters: 25,
      verticalAccuracyMeters: 18
    }),
    {
      latitude: -33.86,
      longitude: 151.2,
      altitudeMeters: 42.5,
      accuracyMeters: 25,
      verticalAccuracyMeters: 18
    }
  );
  assert.equal(location.validateCoordinates({
    latitude: -33.86,
    longitude: 151.2,
    altitudeMeters: 99999,
    accuracyMeters: 25
  }), undefined);
});

test("mobile identity comes from the JWT customer claim", () => {
  assert.equal(location.authenticatedCustomerId({
    requestContext: {
      authorizer: {
        jwt: {
          claims: {
            sub: "cognito-sub-not-used-as-business-id",
            "custom:customer_id": "123456"
          }
        }
      }
    }
  }), "123456");
});

test("spoken location uses a nearby landmark only with sufficient accuracy", () => {
  const description = location.describeLocation(
    { latitude: -37.81, longitude: 144.96, accuracyMeters: 25 },
    { Title: "Melbourne", Address: { Locality: "Melbourne", Label: "Melbourne VIC, Australia" } },
    [{ Title: "Richmond train station", Distance: 80 }]
  );
  assert.equal(description.spokenLocation, "Near Richmond train station, around Melbourne");
  assert.equal(description.confidence, "LANDMARK_APPROXIMATE");

  const lowAccuracy = location.describeLocation(
    { latitude: -37.81, longitude: 144.96, accuracyMeters: 1500 },
    { Title: "Melbourne", Address: { Locality: "Melbourne" } },
    [{ Title: "Richmond train station", Distance: 80 }]
  );
  assert.equal(lowAccuracy.nearbyLandmark, undefined);
  assert.equal(lowAccuracy.confidence, "LOW_ACCURACY");
});

test("normalizeE164 accepts only plausible E.164 numbers", () => {
  assert.equal(verification.normalizeE164("+61491570156"), "+61491570156");
  assert.equal(verification.normalizeE164("0491 570 156"), undefined);
  assert.equal(verification.normalizeE164("not-a-phone"), undefined);
});

test("generateOtp produces a zero-padded 6 digit code", () => {
  const otp = verification.generateOtp();
  assert.match(otp, /^\d{6}$/);
});

test("hashOtp is deterministic per salt and differs across salts", () => {
  const hash1 = verification.hashOtp("123456", "contact-a");
  const hash2 = verification.hashOtp("123456", "contact-a");
  const hash3 = verification.hashOtp("123456", "contact-b");
  assert.equal(hash1, hash2);
  assert.notEqual(hash1, hash3);
});

test("verify rejects malformed OTP input before touching storage", async () => {
  const result = await verification.verify({ contactId: "11111111-1111-1111-1111-111111111111", otp: "abc" });
  assert.equal(result.verified, false);
  assert.equal(result.code, "INVALID_FORMAT");
});

test("location-session normalizeE164 accepts only plausible E.164 numbers", () => {
  assert.equal(location.normalizeE164("+61491570156"), "+61491570156");
  assert.equal(location.normalizeE164("0491 570 156"), undefined);
  assert.equal(location.normalizeE164(""), undefined);
});

const nextSlot = require("../functions/get-next-open-slot/index.js");

test("computeCandidateSlots returns only today's 14:00-15:45 slots at or after now, rounded up", () => {
  const now = new Date("2026-08-03T03:22:00.000Z"); // 13:22 AEST (UTC+10, no DST)
  const slots = nextSlot.computeCandidateSlots(now);
  assert.deepEqual(slots, [
    "2026-08-03#14:00", "2026-08-03#14:15", "2026-08-03#14:30", "2026-08-03#14:45",
    "2026-08-03#15:00", "2026-08-03#15:15", "2026-08-03#15:30", "2026-08-03#15:45"
  ]);
});

test("computeCandidateSlots skips slots already in the past today", () => {
  const now = new Date("2026-08-03T04:18:00.000Z"); // 14:18 AEST
  const slots = nextSlot.computeCandidateSlots(now);
  assert.deepEqual(slots, [
    "2026-08-03#14:30", "2026-08-03#14:45", "2026-08-03#15:00",
    "2026-08-03#15:15", "2026-08-03#15:30", "2026-08-03#15:45"
  ]);
});

test("computeCandidateSlots returns no slots after 16:00", () => {
  const now = new Date("2026-08-03T06:05:00.000Z"); // 16:05 AEST
  assert.deepEqual(nextSlot.computeCandidateSlots(now), []);
});

test("nextOpenSlot skips excluded and already-taken slots", () => {
  const candidates = ["2026-08-03#14:00", "2026-08-03#14:15", "2026-08-03#14:30"];
  const result = nextSlot.nextOpenSlot(candidates, ["2026-08-03#14:00"], new Set(["2026-08-03#14:15"]));
  assert.equal(result, "2026-08-03#14:30");
});

test("nextOpenSlot returns undefined when every candidate is excluded or taken", () => {
  const candidates = ["2026-08-03#14:00", "2026-08-03#14:15"];
  const result = nextSlot.nextOpenSlot(candidates, ["2026-08-03#14:00"], new Set(["2026-08-03#14:15"]));
  assert.equal(result, undefined);
});

test("formatSlotLabel renders a 12-hour time", () => {
  assert.equal(nextSlot.formatSlotLabel("2026-08-03#14:15"), "2:15pm");
  assert.equal(nextSlot.formatSlotLabel("2026-08-03#09:00"), "9:00am");
});

const bookSlot = require("../functions/book-callback-slot/index.js");

function withAllowlist(value, fn) {
  const previous = process.env.CALLBACK_ALLOWED_PHONE_PREFIXES;
  if (value === undefined) delete process.env.CALLBACK_ALLOWED_PHONE_PREFIXES;
  else process.env.CALLBACK_ALLOWED_PHONE_PREFIXES = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.CALLBACK_ALLOWED_PHONE_PREFIXES;
    else process.env.CALLBACK_ALLOWED_PHONE_PREFIXES = previous;
  }
}

test("buildBookingItem produces a PENDING item due at the slot's own start time", () => {
  const item = withAllowlist("+61491570156", () => bookSlot.buildBookingItem(
    { slotKey: "2026-08-03#14:15", phoneE164: "+61491570156", reasonCategory: "GENERAL_ENQUIRY" },
    1754190000
  ));
  assert.equal(item.slotKey, "2026-08-03#14:15");
  assert.equal(item.phoneE164, "+61491570156");
  assert.equal(item.reasonCategory, "GENERAL_ENQUIRY");
  assert.equal(item.status, "PENDING");
  assert.equal(item.retryCount, 0);
  assert.equal(item.createdAt, 1754190000);
  assert.equal(typeof item.dueAt, "number");
});

test("buildBookingItem rejects a malformed slotKey", () => {
  assert.throws(() => bookSlot.buildBookingItem(
    { slotKey: "not-a-slot", phoneE164: "+61491570156", reasonCategory: "OTHER" }, 1754190000
  ), { message: "INVALID_SLOT_KEY" });
});

test("buildBookingItem rejects an invalid phone number", () => {
  assert.throws(() => bookSlot.buildBookingItem(
    { slotKey: "2026-08-03#14:15", phoneE164: "not-a-phone", reasonCategory: "OTHER" }, 1754190000
  ), { message: "INVALID_PHONE" });
});

test("buildBookingItem defaults an unrecognized reason category to OTHER", () => {
  const item = withAllowlist("+61491570156", () => bookSlot.buildBookingItem(
    { slotKey: "2026-08-03#14:15", phoneE164: "+61491570156", reasonCategory: "nonsense" }, 1754190000
  ));
  assert.equal(item.reasonCategory, "OTHER");
});

test("trustedPhoneFromEvent returns the ANI and ignores any Parameters-supplied phone", () => {
  const phone = bookSlot.trustedPhoneFromEvent({
    Details: {
      ContactData: { CustomerEndpoint: { Address: "+61491570156" } },
      Parameters: { callerPhone: "+15551234567", phoneE164: "+15559999999" }
    }
  });
  assert.equal(phone, "+61491570156");
});

test("trustedPhoneFromEvent returns undefined when ANI is absent, even with a phone-shaped Parameters value", () => {
  const phone = bookSlot.trustedPhoneFromEvent({
    Details: {
      Parameters: { callerPhone: "+15551234567", phoneE164: "+15559999999" }
    }
  });
  assert.equal(phone, undefined);
});

test("buildBookingItem rejects a number outside an exact-match allowlist", () => {
  assert.throws(
    () => withAllowlist("+61491570156", () => bookSlot.buildBookingItem(
      { slotKey: "2026-08-03#14:15", phoneE164: "+61400111222", reasonCategory: "OTHER" }, 1754190000
    )),
    { message: "PHONE_NOT_ALLOWED" }
  );
});

test("buildBookingItem accepts any Australian mobile once the allowlist is widened to a prefix", () => {
  const item = withAllowlist("+614", () => bookSlot.buildBookingItem(
    { slotKey: "2026-08-03#14:15", phoneE164: "+61400111222", reasonCategory: "OTHER" }, 1754190000
  ));
  assert.equal(item.phoneE164, "+61400111222");
});

test("buildBookingItem still rejects a non-Australian number under the +614 prefix", () => {
  assert.throws(
    () => withAllowlist("+614", () => bookSlot.buildBookingItem(
      { slotKey: "2026-08-03#14:15", phoneE164: "+6421234567", reasonCategory: "OTHER" }, 1754190000
    )),
    { message: "PHONE_NOT_ALLOWED" }
  );
});

test("buildBookingItem accepts a number matching any entry in a multi-prefix allowlist", () => {
  const item = withAllowlist("+61491570156,+614", () => bookSlot.buildBookingItem(
    { slotKey: "2026-08-03#14:15", phoneE164: "+61400111222", reasonCategory: "OTHER" }, 1754190000
  ));
  assert.equal(item.phoneE164, "+61400111222");
});

test("an unset, empty, or whitespace-only allowlist denies every number", () => {
  for (const value of [undefined, "", "   ", " , , "]) {
    assert.throws(
      () => withAllowlist(value, () => bookSlot.buildBookingItem(
        { slotKey: "2026-08-03#14:15", phoneE164: "+61491570156", reasonCategory: "OTHER" }, 1754190000
      )),
      { message: "PHONE_NOT_ALLOWED" },
      `expected denial for allowlist value ${JSON.stringify(value)}`
    );
  }
});

test("allowedPrefixes trims entries and drops empty ones", () => {
  withAllowlist(" +61491570156 , , +614 ", () => {
    assert.deepEqual(bookSlot.allowedPrefixes(), ["+61491570156", "+614"]);
  });
});

test("isPhoneAllowed reads the environment when no prefix list is passed", () => {
  withAllowlist("+614", () => {
    assert.equal(bookSlot.isPhoneAllowed("+61400111222"), true);
    assert.equal(bookSlot.isPhoneAllowed("+6421234567"), false);
  });
});

test("handler returns a terminal PHONE_NOT_ALLOWED response for a non-allowlisted caller", async () => {
  const response = await withAllowlist("+61491570156", () => bookSlot.handler({
    Details: {
      ContactData: { CustomerEndpoint: { Address: "+61400111222" } },
      Parameters: { slotKey: "2026-08-03#14:15", reasonCategory: "OTHER" }
    }
  }));
  assert.deepEqual(response, { ok: false, code: "PHONE_NOT_ALLOWED", retryable: false });
});

test("only SLOT_TAKEN is retryable; allowlist and validation failures are terminal", () => {
  assert.equal(bookSlot.isRetryable("SLOT_TAKEN"), true);
  assert.equal(bookSlot.isRetryable("PHONE_NOT_ALLOWED"), false);
  assert.equal(bookSlot.isRetryable("INVALID_PHONE"), false);
  assert.equal(bookSlot.isRetryable("INVALID_SLOT_KEY"), false);
});

const poller = require("../functions/callback-poller/index.js");

test("isDue is true only for PENDING items whose dueAt has arrived", () => {
  assert.equal(poller.isDue({ status: "PENDING", dueAt: 100 }, 150), true);
  assert.equal(poller.isDue({ status: "PENDING", dueAt: 200 }, 150), false);
  assert.equal(poller.isDue({ status: "CALLED", dueAt: 100 }, 150), false);
  assert.equal(poller.isDue({ status: "COMPLETED", dueAt: 100 }, 150), false);
});

const outcome = require("../functions/record-callback-outcome/index.js");

test("wasAnswered is true only when connectedToSystemTimestamp is present", () => {
  assert.equal(outcome.wasAnswered({ connectedToSystemTimestamp: "2026-08-03T04:15:03.000Z" }), true);
  assert.equal(outcome.wasAnswered({}), false);
});

test("nextRetryState reschedules once, then gives up", () => {
  const firstMiss = outcome.nextRetryState(0, 1000);
  assert.equal(firstMiss.status, "PENDING");
  assert.equal(firstMiss.retryCount, 1);
  assert.equal(firstMiss.dueAt > 1000, true);

  const secondMiss = outcome.nextRetryState(1, 1000);
  assert.equal(secondMiss.status, "MISSED");
  assert.equal(secondMiss.retryCount, 1);
  assert.equal(secondMiss.dueAt, undefined);
});

test("buildUpdateExpression for COMPLETED omits retryCount and dueAt entirely", () => {
  const result = outcome.buildUpdateExpression({ status: "COMPLETED" });
  assert.equal(result.expression, "SET #s = :newStatus");
  assert.equal(result.values[":retryCount"], undefined);
  assert.equal(result.values[":dueAt"], undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(result.values, ":retryCount"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.values, ":dueAt"), false);
});

test("buildUpdateExpression for first-retry PENDING includes both retryCount and dueAt", () => {
  const result = outcome.buildUpdateExpression({ status: "PENDING", retryCount: 1, dueAt: 2000 });
  assert.equal(result.expression, "SET #s = :newStatus, retryCount = :retryCount, dueAt = :dueAt");
  assert.equal(result.values[":retryCount"], 1);
  assert.equal(result.values[":dueAt"], 2000);
});

test("buildUpdateExpression for second-miss MISSED includes retryCount but not dueAt", () => {
  const result = outcome.buildUpdateExpression({ status: "MISSED", retryCount: 1 });
  assert.equal(result.expression, "SET #s = :newStatus, retryCount = :retryCount");
  assert.equal(result.values[":retryCount"], 1);
  assert.equal(Object.prototype.hasOwnProperty.call(result.values, ":dueAt"), false);
});

test("findStorageConfigAssociationId matches by stream ARN", () => {
  const configs = [
    { AssociationId: "assoc-1", KinesisStreamConfig: { StreamArn: "arn:aws:kinesis:ap-southeast-2:111122223333:stream/other" } },
    { AssociationId: "assoc-2", KinesisStreamConfig: { StreamArn: "arn:aws:kinesis:ap-southeast-2:111122223333:stream/wisecalls-dev-contact-lens-demo" } }
  ];
  assert.equal(
    redactionTeardown.findStorageConfigAssociationId(configs, "arn:aws:kinesis:ap-southeast-2:111122223333:stream/wisecalls-dev-contact-lens-demo"),
    "assoc-2"
  );
});

test("findStorageConfigAssociationId returns undefined when no config matches the stream ARN", () => {
  const configs = [
    { AssociationId: "assoc-1", KinesisStreamConfig: { StreamArn: "arn:aws:kinesis:ap-southeast-2:111122223333:stream/other" } }
  ];
  assert.equal(
    redactionTeardown.findStorageConfigAssociationId(configs, "arn:aws:kinesis:ap-southeast-2:111122223333:stream/wisecalls-dev-contact-lens-demo"),
    undefined
  );
});

test("findStorageConfigAssociationId returns undefined when storageConfigs is undefined", () => {
  assert.equal(
    redactionTeardown.findStorageConfigAssociationId(undefined, "arn:aws:kinesis:ap-southeast-2:111122223333:stream/x"),
    undefined
  );
});
