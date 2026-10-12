# Anonymous SMS-link location sharing

Status: approved by operator (Ben Mergen), 2026-08-03. Ready for implementation planning.

## Problem

The IVR's "share your location securely" option (option 4 in
`connect-flows/wisecalls-voice-v1-dev.json`) sends the caller an SMS link to a
CloudFront-hosted page. Today that page requires the customer to sign in through
Cognito Hosted UI — including TOTP MFA — before it will accept a GPS position
(`infrastructure/template.yaml`'s `LocationApi` sets `DefaultAuthorizer: CognitoJwt`
for the whole API, per `docs/10-location-frontend.md`'s documented customer flow).
For a single, spontaneous, one-time location share triggered mid-call, that is a
lot of friction: the customer needs an existing password and an authenticator app
just to send back a GPS pin.

## Decisions made during brainstorming

1. **Scope: only the one-time, SMS-link share loses Cognito.** The separate
   `/location/current` route — used by an authenticated Android app for ongoing
   location updates tied to a persistent customer session — keeps its Cognito
   requirement untouched. That is a different use case (a persistent account
   relationship) with a different, real security need: without a JWT there, the
   Lambda would have no way to know which customer's record a request updates
   except by trusting a client-supplied ID, which the root `CLAUDE.md` explicitly
   forbids ("ignore any customer ID supplied in the request body") precisely
   because customer IDs are simple, guessable values (the PoC test customer is
   `123456`) — accepting one from an unauthenticated request would let any caller
   overwrite any other customer's current-location record.
2. **What replaces Cognito for the one-time share: the phone call itself, plus a
   registered-customer check, plus the existing single-use session token.**
   Cognito was never actually adding a security property this specific flow
   needs: the caller has already proven control of their phone number by being
   on a call from it, the SMS is only ever sent to that same number, and the
   session token embedded in the link (two concatenated UUIDs, effectively
   unguessable, single-use via a `attribute_not_exists(submittedAt)` DynamoDB
   condition, short-TTL) is already a strong bearer-token-style boundary —
   comparable in practice to an industry-standard "magic link" (password reset,
   calendar RSVP), not "no security."
3. **New gate: only registered customers trigger the SMS.** Today, option 4 will
   text a location-request link to *any* caller, known customer or not, trusting
   only the ANI. This adds a check that the caller's phone number already
   matches a customer record in DynamoDB before sending anything.
4. **How the registered-customer gate is implemented: reuse the flow's existing
   identify step, don't add a new lookup.** Every caller already gets an ANI
   lookup against `CoreDataTable` (GSI1 `PHONE#<e164>`) at the very start of the
   call, via `call-identify-module`, which sets `$.Attributes.identify_found`
   and `$.Attributes.identify_customerId` before the main menu is even reached.
   The chosen approach (over an alternative that would re-query DynamoDB inside
   the Lambda) is to gate option 4 in the contact flow itself with a `Compare` on
   `$.Attributes.identify_found`, matching the trust pattern this same repo
   already uses elsewhere (e.g. `book-callback-slot` trusting flow-sourced
   contact attributes rather than re-deriving them). This is simpler, avoids a
   redundant DynamoDB query, and `identify_found` is recomputed fresh every call
   so there is no staleness risk.

## Design

### Contact flow change

In `connect-flows/wisecalls-voice-v1-dev.json`, insert a `Compare` action on
`$.Attributes.identify_found` between the existing option-4 selection and the
existing `call-create-location-module` `InvokeFlowModule` action. If
`identify_found` is not `"true"`, play a decline message and route to the agent
queue (`set-target-queue` → `escalate-to-queue`), matching the existing
`reset-unavailable-message`/`callback-unavailable-message` pattern used for
other opt-out branches in this same flow. If `identify_found` is `"true"`,
proceed to `call-create-location-module` exactly as today.

**Known limitation, stated plainly:** `call-create-location-module` is an
external Amazon Connect flow module (`1f300764-1c7f-4f41-9a4c-221f3f49c3c0`),
not version-controlled in this repository, so this plan cannot see or change
how it internally invokes the `location-session` Lambda's `create` action. The
flow-level gate added here — only ever reaching the module at all when
`identify_found` is true — is what actually enforces "registered customers
only," independent of the module's internals, and is sufficient on its own.

### Lambda change (`functions/location-session/index.js`)

No change to the session-submission branch's validation logic: it already
checks only the session token (`attribute_exists(sessionId) AND expiresAt > now
AND attribute_not_exists(submittedAt)`), never a Cognito claim — API Gateway was
the only thing enforcing authentication on this path, not the Lambda. The one
change here is to the outbound SMS text in the `create` action, which currently
reads "share your current location securely here (sign-in required, link
expires soon)" — the "sign-in required" phrase is removed since it will no
longer be true.

### API Gateway change (`infrastructure/template.yaml`)

`LocationApi`'s `POST /location` route (the `SubmitLocation` event on
`LocationSessionFunction`) gets a per-route `Auth: Authorizer: NONE` override,
a standard SAM `AWS::Serverless::HttpApi` capability that overrides the API's
`DefaultAuthorizer: CognitoJwt` for just that one route. `POST /location/current`
(the `SubmitCurrentMobileLocation` event) is untouched and keeps requiring the
Cognito JWT via the existing default.

### Frontend change

`docs/10-location-frontend.md`'s documented customer flow currently redirects
to Cognito Hosted UI unconditionally (steps 2–4, 9) before doing anything else.
For the session-based path (URL contains `?session=...`), that redirect step is
removed entirely — the page goes directly from "open link → read consent notice
→ request browser geolocation permission → submit coordinates" with no login
screen. The "otherwise, update the authenticated customer's current-location
record" branch is untouched, since that still serves `/location/current` and
still requires Cognito.

### Out of scope

- Any change to `/location/current`, its Lambda-side JWT-derived customer-ID
  logic, or the Android app that calls it.
- Any change to `call-create-location-module`'s own internal implementation
  (out of this repository's visibility, per the known limitation above).
- Rate-limiting or additional anti-abuse controls on the now-unauthenticated
  `/location` route beyond the registered-customer gate and the existing
  single-use/short-TTL session token — the existing controls are judged
  sufficient for this PoC's scope; a future project could revisit this if usage
  patterns suggest otherwise.

## Test plan

Full verification requires a real phone call and cannot be scripted, matching
every other IVR-facing feature built this session.

1. Call in as a registered customer (ANI matches an existing `CoreDataTable`
   record), select option 4, confirm the SMS arrives and the link works with no
   sign-in prompt of any kind.
2. Call in from a number that does not match any registered customer, select
   option 4, confirm a decline message plays, the call routes to an agent, and
   no SMS is sent.
3. Confirm `POST /location/current` still rejects a request with no Cognito JWT
   (or an invalid one) exactly as it does today — this is a regression check
   that the per-route auth override did not accidentally loosen the wrong route.
4. Confirm an expired or already-used session link is still rejected by the
   existing `EXPIRED_OR_USED` response — this behavior is unchanged by this
   work and must not regress.
