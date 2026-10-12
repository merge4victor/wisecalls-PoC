# Scheduled callback (human agent, fixed 15-minute slots)

Status: approved by operator (Ben Mergen), 2026-08-02. Ready for implementation planning.

## Problem

Today, "press 3 for agent" on `wisecalls-voice-v1-dev` puts the caller straight
into `BasicQueue` and they wait live until an agent is free. The operator
wants an alternative: let the caller pick a specific future 15-minute slot
and have a human agent call them back at that time, instead of waiting on
hold or relying on Connect's native "callback when next agent is free"
pattern.

## Decisions made during brainstorming

- **Conductor**: a human agent, not an AI-only call. The system just moves
  *when* the agent-customer conversation happens, not *who* has it.
- **Hours**: slots are only offered between **14:00 and 16:00** (last
  bookable start time is 15:45), same day only. Past 16:00, callers are told
  scheduled callbacks aren't available today — no next-day offering in v1.
- **Capacity**: **one booking per 15-minute slot**, enforced by using the
  slot itself as the DynamoDB partition key plus a conditional write. Sized
  for this PoC's 1-2 test agents, not a real contact-center roster.
- **Slot selection UX**: DTMF only. The system offers the next open slot by
  voice ("the next available time is 2:15pm, press 1 to book, press 2 for
  another time"); no free-form spoken time parsing — avoids NLU ambiguity
  entirely.
- **Trigger mechanism**: Option B from the three discussed (per-booking
  EventBridge Scheduler, polling Lambda, native Connect Tasks) — a single
  Lambda on a **5-minute** polling interval. Precision within 5 minutes is a
  non-issue at 15-minute slot granularity, and it avoids managing a
  scheduler-resource lifecycle per booking.
- **Identity**: **no OTP/verification required to book.** Requesting a
  callback at a phone number discloses nothing sensitive, so it sits at the
  same public trust tier as options 1/2 (rates, ATM), not gated like
  password reset (option 5).
- **Context for the agent**: caller records a short spoken reason, passed to
  the outbound flow as a contact attribute so the agent isn't cold-calling
  blind. Not wired into Connect Cases in v1 (`WiseCalls_Cases` domain
  exists and this could be added later, but a full `cases:CreateCase` call
  is unnecessary surface area for what a contact attribute already solves).
- **No-answer handling**: one retry roughly 5-10 minutes later; if still
  unanswered, mark the booking `MISSED` and stop. No voicemail fallback.

## No-answer detection (resolved)

Amazon Connect outbound contact flows only begin executing once the
destination number answers, so the flow itself cannot branch on "did they
pick up" — if they don't, the flow never runs at all. Detection instead
uses **Amazon Connect Contact Events**, which every Connect instance
publishes automatically to the account's default EventBridge bus (no
storage config association needed, and no flat per-hour cost — unlike the
Kinesis stream removed earlier this session, EventBridge rules here only
cost per matched event, negligible at this volume).

A new EventBridge rule matches:

```json
{
  "source": ["aws.connect"],
  "detail-type": ["Amazon Connect Contact Event"],
  "detail": {
    "eventType": ["DISCONNECTED"],
    "channel": ["VOICE"],
    "initiationMethod": ["API"]
  }
}
```

targeting a new Lambda (`RecordCallbackOutcomeFunction`). The `DISCONNECTED`
event's `detail.connectedToSystemTimestamp` field is the signal: **absent**
means the destination phone never answered — customer no-answer, eligible
for the one retry. **Present** means the customer's phone was picked up;
this is treated as `COMPLETED` regardless of whether an agent ultimately
joined the queue afterward — distinguishing "customer answered but no agent
was free" from "customer answered" is a real operational scenario but is
explicitly out of scope for v1 (see below).

This requires `CallbackBookingTable` to also store the `contactId` returned
by `StartOutboundVoiceContact` (written by the poller at trigger time), so
`RecordCallbackOutcomeFunction` can match an incoming `DISCONNECTED` event's
`contactId` back to its booking record.

## Design

### Data model

New DynamoDB table `CallbackBookingTable`:

| Attribute | Purpose |
|---|---|
| `slotKey` (partition key) | e.g. `2026-08-03#14:15`. Booking uniqueness *is* capacity enforcement — `PutItem` with `ConditionExpression="attribute_not_exists(slotKey)"`. |
| `phoneE164` | number to call back (caller's ANI, not user-supplied free text) |
| `reason` | short spoken reason, passed to the agent at connect time |
| `status` | `PENDING` \| `CALLED` \| `COMPLETED` \| `MISSED` |
| `retryCount` | 0 or 1 |
| `contactId` | the Connect contact ID returned by `StartOutboundVoiceContact`, used to match incoming `DISCONNECTED` events back to this booking |
| `createdAt` / `lastAttemptAt` | epoch seconds |

A GSI on `status` (same pattern as `CoreDataTable`'s existing `GSI1`) lets
the poller query due `PENDING` bookings without a full table scan.

### Booking during the call

Two new flow modules, matching this repo's one-Lambda-per-module
convention (`wisecalls-<verb>-v1-dev`):

- `get-next-open-slot` — given a comma-separated list of slots already
  declined this session (passed via a contact attribute, since the Lambda
  itself is stateless across GetParticipantInput loop iterations), returns
  the next open 15-minute slot between 14:00-15:45 today, or an
  "unavailable" result if none remain or it's already past 16:00.
- `book-callback-slot` — conditional `PutItem` on `slotKey`. On a race-
  condition collision (another caller grabbed it first), the flow loops
  back to `get-next-open-slot` excluding that slot rather than failing the
  call.

New DTMF option **7** on `wisecalls-voice-v1-dev`'s existing `main-menu`:
*"To schedule a callback between 2 and 4pm today, press 7."* Reachable from
the same menu as options 1-6 (rates, ATM, agent, location, password reset,
voicemail) added in the two prior changes to this flow.

### Trigger and outbound call

- `wisecalls-dev-callback-poller`: EventBridge rule, `rate(5 minutes)`,
  invokes a Lambda that queries `CallbackBookingTable` via the `status`
  GSI for `PENDING` bookings whose `slotKey` time has arrived.
- For each due booking, the Lambda calls Connect's
  `StartOutboundVoiceContact`, targeting a new minimal outbound flow
  (`wisecalls-callback-outbound-v1-dev`) that sets the `reason` contact
  attribute and transfers into the **existing** `BasicQueue` — the same
  queue option 3 already uses. No new queue.
- Retry: `RecordCallbackOutcomeFunction` (triggered by the `DISCONNECTED`
  contact event, see "No-answer detection" above) makes the retry decision
  from the prior attempt's disposition, not from logic inside the outbound
  flow itself. First no-answer sets `status=PENDING` with a new near-term
  due time (~5-10 minutes later) for the poller to pick up again; second
  no-answer sets `status=MISSED`.

### Error handling

- Past-16:00 callers: generic "not available today" message, routed the
  same way `reset-unavailable-message` routes today — to the existing
  agent queue, not silently disconnected.
- Slot race condition at booking time: transparent retry against
  `get-next-open-slot`, invisible to the caller beyond hearing the next
  offered time.
- Two failed contact attempts (no-answer both times): `MISSED`, no further
  action, no voicemail.

### Out of scope for v1

- AI-agent-conducted callbacks (explicitly decided against — human agent
  only).
- Next-day slot offering.
- Connect Cases integration (reason is a contact attribute, not a Case).
- Capacity greater than 1 per slot (would need a different DynamoDB key
  shape — a counter or composite key — if ever needed).
- Distinguishing "customer answered but no agent was available" from a true
  no-answer. Both currently end the retry logic (the first as `COMPLETED`
  once `connectedToSystemTimestamp` is set, since that's a real operational
  gap rather than a scheduling problem this feature is meant to solve).

## Test plan

1. Book a slot, confirm the outbound call fires within 5 minutes of the
   slot start time.
2. Attempt to book an already-taken slot — rejected, next slot offered
   instead.
3. Call after 16:00 — told callbacks aren't available today, routed to the
   agent queue (not disconnected).
4. Decline several offered slots in one call — none of the declined slots
   are re-offered in the same session.
5. Simulate no-answer on the outbound leg — confirm exactly one retry, then
   `MISSED`, no voicemail.
6. Regression: options 1-6 on `wisecalls-voice-v1-dev` behave identically
   to their state after the password-reset/voicemail change (same
   regression-check approach as that change's `unchanged_actions` check).
