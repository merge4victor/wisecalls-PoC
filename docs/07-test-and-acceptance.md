# 7. Test and acceptance plan

## Local tests

```powershell
node .\scripts\validate.mjs
```

The contact-flow structural validator is not run by `validate.mjs` and must be
run separately whenever a flow JSON file changes:

```powershell
cd .\connect-flows\tests
python .\test_validate_flow.py
```

## Infrastructure acceptance

- stack deployed without drift;
- KMS rotation enabled;
- S3 public access blocked and versioning enabled;
- DynamoDB encryption and PITR enabled;
- Cognito deletion protection enabled;
- JWT required by location API;
- Lambda roles match the documented access;
- invocation policies are scoped to the intended Connect instance.

## Voice tests

- single profile match;
- no match;
- multiple matches;
- withheld/spoofed caller number;
- verification success, timeout and failure;
- no private disclosure before verification;
- recent case with comments;
- no cases;
- Cases timeout/error;
- customer requests a human;
- AI tool failure returns to safe queue;
- GPS consent accepted and declined.

## Scheduled callback tests

Booking is restricted to the E.164 prefixes in `CallbackAllowedPhonePrefixes`.
Run the first two groups after every change to the callback flow or Lambdas,
and the operational checks before any demo.

Allowlist:

- an allowlisted caller books a slot and hears the confirmation;
- a non-allowlisted caller is refused at booking, hears the "not available for
  the rest of today" message, and is routed to the agent queue rather than
  disconnected;
- a refused caller is not told that an allowlist exists;
- no row is written to `CallbackBookingTable` for a refused caller;
- an empty `CallbackAllowedPhonePrefixes` denies every caller;
- widening the value to `+614` admits a second Australian mobile after a stack
  update alone, with no flow republish.

Booking and callback behaviour:

- the outbound call fires within five minutes of the slot start time;
- an already-taken slot is rejected and the next open slot is offered instead;
- slots declined earlier in the same call are not re-offered;
- a caller after 16:00 is told callbacks are unavailable today and is routed to
  an agent, not disconnected;
- an outbound no-answer produces exactly one retry, then `MISSED`, with no
  voicemail;
- regression: main-menu options 1-6 and 8 behave as before.

Operational checks before a demo:

- `CallbackBookingTable` holds no `PENDING` rows for numbers outside the
  allowlist — query `StatusIndex` and clear any that remain, because
  `callback-poller` does not re-check the allowlist and will still dial them;
- narrowing the allowlist is confirmed not to retract bookings already
  `PENDING`, so the manual clear above is the only way to stop them.

## Chat tests

- public FAQ without authentication;
- account-specific question triggers authentication;
- Cognito MFA success;
- MFA failure/timeout/opt-out;
- authenticated profile association;
- transfer preserves authentication state;
- customer enters card number;
- customer enters PIN/password/CVV/OTP;
- redaction and custom processor failure;
- malicious HTML/script content;
- agent without unredacted permission;
- session expiry and logout.

## Knowledge tests

- exact approved answer with citation;
- paraphrased question;
- ambiguous product;
- wrong jurisdiction;
- expired article;
- conflicting articles;
- unpublished/draft article;
- prompt injection embedded in a document;
- request requiring a live rate tool rather than retrieval;
- no supporting source;
- agent overrides a suggestion.

## Tool tests

- correct rate on effective-date boundary;
- no approved rate;
- stale ATM record;
- ATM capability filters;
- invalid coordinates;
- customer ID substitution attempt;
- unverified customer invokes customer context;
- case comments ordered newest first;
- long comment truncation;
- all identifiers masked.

## Location tests

- Android JWT contains the immutable `custom:customer_id` claim;
- direct S3 access is denied and CloudFront serves the page over HTTPS;
- Cognito PKCE login, MFA, callback and logout work on the CloudFront URL;
- browser tokens are cleared from session storage at sign-out;
- the page sends latitude, longitude, accuracy, timestamp and optional altitude only after consent;
- denied browser geolocation permission sends no API request;
- customer ID supplied in the request body is ignored;
- home address remains unchanged after a location update;
- current location expires after the configured TTL;
- landmark wording is used only when GPS accuracy and landmark distance pass thresholds;
- valid Cognito JWT;
- no JWT;
- wrong audience/issuer;
- valid coordinates;
- invalid latitude/longitude;
- poor accuracy;
- expired session;
- replayed single-use session;
- consent not selected;
- TTL deletion.

## Acceptance evidence

For each test capture:

- test ID;
- environment;
- flow and Lambda version;
- input classification, not raw sensitive input;
- expected result;
- actual result;
- CloudWatch/contact ID;
- tester;
- date;
- defect/reference;
- approval.

## Go-live thresholds

Define and approve thresholds for:

- authentication success rate;
- transfer rate;
- Lambda/tool error rate;
- P95 tool latency;
- redaction test pass rate;
- knowledge citation rate;
- answer faithfulness;
- customer abandonment;
- false block rate for message processing.
