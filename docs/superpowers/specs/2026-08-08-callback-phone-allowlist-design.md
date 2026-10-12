# Scheduled callback — phone allowlist

Status: approved by operator (Ben Mergen), 2026-08-08. Ready for implementation
planning.

## Problem

The scheduled-callback feature (see
`docs/superpowers/specs/2026-08-02-scheduled-callback-design.md`) lets any
caller who reaches option 7 on `wisecalls-voice-v1-dev` book a slot, and the
poller then places a real outbound call to that caller's number. Booking
requires no verification by design — the original spec put callback requests at
the same public trust tier as the rates and ATM options, since requesting a
call back at your own number discloses nothing sensitive.

The gap that reasoning leaves open is cost, not disclosure. Every booking
becomes a billed `StartOutboundVoiceContact` leg, and in a PoC that is exposed
on a real phone number, nuisance or automated callers can convert free inbound
calls into paid outbound ones.

Until the demo presentation, callbacks must be restricted to the operator's own
number. Afterwards the restriction must be able to widen to Australian mobiles
generally without a code change.

## Decisions made during brainstorming

- **Allowlist by E.164 prefix, not by exact number.** A prefix list covers both
  required states with one mechanism: `+61491570156` is a full-length prefix and
  therefore an exact match today, and `+614` is the post-demo "any Australian
  mobile" state. Widening is a parameter change, not a code change.
- **Configured as a CloudFormation parameter surfaced as a Lambda environment
  variable**, matching how `BasicQueueArn` and `CallbackOutboundFlowId` are
  already handled in `infrastructure/template.yaml`.
- **Fail closed.** An unset or empty allowlist denies every number. A botched
  deploy must not silently open the gate.
- **Enforced at the booking layer only** — in `book-callback-slot`. The
  operator explicitly chose this over also checking `get-next-open-slot` and
  `callback-poller`. See "Accepted limitations" below.
- **No new caller-facing prompt.** A blocked caller hears the existing
  `callback-unavailable-message` and is routed to the agent queue. This
  discloses nothing about the existence of an allowlist and avoids a dead-end
  disconnect.

## Design

### Allowlist matching

New environment variable `CALLBACK_ALLOWED_PHONE_PREFIXES`: a comma-separated
list of E.164 prefixes. A phone number is allowed when it starts with at least
one non-empty prefix in the list, after both sides are trimmed.

| State | Value | Effect |
|---|---|---|
| Now (through the demo) | `+61491570156` | Only the operator's number |
| After the demo | `+614` | Any Australian mobile |
| Unset, empty, or only whitespace/commas | — | Denies every number |

Matching is a plain `String.prototype.startsWith` against each configured
prefix. Deliberately not a regex: a regex in an environment variable can be
malformed (throwing at request time) or pathological, and prefix semantics are
all the two required states need.

### Where the check runs

Inside `buildBookingItem` in `functions/book-callback-slot/index.js`,
immediately after the existing `PHONE_PATTERN` validation, throwing
`PHONE_NOT_ALLOWED` on failure. Placing it there keeps it inside the pure,
already-unit-tested function and before any DynamoDB call.

The number tested is the one `trustedPhoneFromEvent` reads from
`Details.ContactData.CustomerEndpoint.Address` — the carrier-provided ANI. The
handler already overwrites `input.phoneE164` with this value on every
invocation, so a caller cannot bypass the allowlist by supplying a phone number
through the flow's `LambdaInvocationAttributes`.

### Return shape and the flow branch it requires

`book-callback-slot` currently returns `{ ok: false, code }` for every
validation failure. `$.External.booked` is then absent, and `check-book-result`
(`connect-flows/wisecalls-voice-v1-dev.json:543`) treats a non-`true` value as
"slot taken" and routes to `track-declined-slot`, which loops back to
`get-next-open-slot` with that slot excluded.

For a blocked caller that loop is wrong: they would be offered every remaining
slot of the day in turn, each one refused. The same latent defect already
affects `INVALID_SLOT_KEY` and `INVALID_PHONE` today; fixing it is in scope
because the new failure mode runs straight through it.

Failures are therefore split into retryable and non-retryable:

| Code | `retryable` | Flow destination |
|---|---|---|
| `SLOT_TAKEN` | `true` | `track-declined-slot` — offer the next slot (unchanged) |
| `PHONE_NOT_ALLOWED` | `false` | `callback-unavailable-message` |
| `INVALID_SLOT_KEY` | `false` | `callback-unavailable-message` |
| `INVALID_PHONE` | `false` | `callback-unavailable-message` |

One new `Compare` block, `check-book-blocked`, is inserted between
`call-book-slot` and `check-book-result`:

- `call-book-slot`'s `NextAction` changes from `check-book-result` to
  `check-book-blocked`. Its `Errors` transition is unchanged.
- `check-book-blocked` compares `$.External.retryable`; `Equals "false"` routes
  to `callback-unavailable-message`, and both the default `NextAction` and the
  `NoMatchingCondition` error route to `check-book-result`.
- `check-book-result` and `booking-confirmed-message` are untouched.

Defaulting to `check-book-result` rather than to the blocked path means an
unexpected or missing `retryable` value degrades to today's behaviour rather
than to a hard refusal.

### Caller experience

A blocked caller hears the existing message — "Scheduled callbacks aren't
available for the rest of today. I'll transfer you to an agent." — and is
routed into the agent queue exactly as a genuinely-full day already is. No new
prompt is added, and the caller is not told that an allowlist exists.

### Infrastructure

- New CloudFormation parameter `CallbackAllowedPhonePrefixes`, `Type: String`,
  `Default: "+61491570156"`, with a description covering the post-demo `+614`
  value.
- `BookCallbackSlotFunction` gains its own `Environment.Variables` block setting
  `CALLBACK_ALLOWED_PHONE_PREFIXES: !Ref CallbackAllowedPhonePrefixes`. SAM
  merges function-level environment variables with the `Globals` block rather
  than replacing it, so `CALLBACK_BOOKING_TABLE` and the other shared variables
  are retained. `CallbackPollerFunction` already relies on this same merge.
- The parameter is added to `infrastructure/parameters.example.json` for
  discoverability. Because the template supplies a default, an existing
  `deployment-parameters.local.json` without the key still deploys correctly.

### Deployment

Two steps, both required:

1. Stack update through `scripts/deploy.ps1` (new parameter and Lambda
   environment variable).
2. Republish `wisecalls-voice-v1-dev` through `scripts/deploy-connect-flow.ps1`,
   because the flow JSON gained the `check-book-blocked` block.

Applying only the stack update leaves a blocked caller in the slot-offer loop
described above; applying only the flow update leaves the allowlist unenforced.

### Widening after the demo

Change `CallbackAllowedPhonePrefixes` to `+614` and rerun `scripts/deploy.ps1`.
No code change, no flow change, no republish.

## Testing

Unit tests extend the existing `buildBookingItem` cases in
`tests/functions.test.js`, setting `CALLBACK_ALLOWED_PHONE_PREFIXES` per case
and restoring it afterwards:

1. Exact-match config (`+61491570156`) allows that number and produces the same
   `PENDING` item the current tests assert.
2. Exact-match config rejects a different Australian mobile with
   `PHONE_NOT_ALLOWED`.
3. Prefix config (`+614`) allows that same different Australian mobile.
4. Prefix config (`+614`) still rejects a non-Australian number such as
   `+6421234567`.
5. Unset, empty, and whitespace-only config each reject `+61491570156`,
   confirming the fail-closed behaviour.
6. Multi-prefix config (`+61491570156,+614`) allows a number matching either
   entry.
7. Non-retryable failures return `retryable: false`; the `SLOT_TAKEN` path
   returns `retryable: true` and is otherwise unchanged.

Manual acceptance, after both deployment steps:

8. Call from `+61491570156`, press 7, book a slot — confirmation plays and the
   outbound call fires as before.
9. Call from any other number, press 7, accept a slot — the caller hears the
   "not available for the rest of today" message and lands in the agent queue,
   and no row appears in `CallbackBookingTable`.
10. Regression: options 1-6 and 8 on `wisecalls-voice-v1-dev` behave
    identically, checked the same way prior changes to this flow were.

## Accepted limitations

Consequences of enforcing at the booking layer only, accepted by the operator:

- A blocked caller still walks the entire DTMF path — hears a slot offered,
  presses 1, selects a reason — and is refused only at the final step. No row
  is written and no outbound call is placed, so there is no telephony cost.
  The caller does land in the agent queue afterwards (see "Caller
  experience"), so the residual cost is agent handling time, not a billed
  call.
- `callback-poller` is unguarded, so any row already present in
  `CallbackBookingTable` will still be dialled regardless of its `phoneE164`.
  No such rows exist for non-allowlisted numbers today.
- `get-next-open-slot` is unguarded, so a blocked caller's declined slots are
  still tracked in the session's `excludedSlots` attribute. That attribute is
  per-contact and never persisted, so it cannot deny slots to other callers.

## Out of scope

- Rate limiting or per-number booking caps.
- Any allowlist on the chat channel or the other voice menu options.
- Storing the allowlist in DynamoDB or another runtime-editable store.
- Alerting or metrics on blocked booking attempts.
