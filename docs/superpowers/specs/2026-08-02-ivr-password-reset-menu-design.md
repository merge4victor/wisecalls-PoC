# Unified IVR menu: add password reset and voicemail to `wisecalls-voice-v1-dev`

Status: approved by operator (Ben Mergen), 2026-08-02. Ready for implementation planning.

## Problem

Two independent specs each said to "clone the existing voicemail flow":
`docs/04-connect-configuration.md` §4.7 (main WiseCalls voice self-service) and
`ad-password-reset/docs/connect-flow.md` (AD password reset). Following both
literally would produce two separate cloned flows. The operator wants one
caller-facing menu that offers existing self-service options, voicemail, and
password reset together.

## Current state (discovered via read-only `describe-contact-flow` against
account `111122223333` / instance `wise-calls-org`, 2026-08-02)

- `wisecalls-voice-v1-dev` (Id `790c287e-1663-4dcf-844c-f180891bca52`) already
  exists, is published, and is **not assigned to any phone number**. It
  implements: flow logging, a generic caller-identify + OTP verification
  sequence (`CoreDataTable` via flow modules, unrelated to the password-reset
  feature's tables), then an unconditional `main-menu` `GetParticipantInput`
  with four DTMF options:
  - `1` product rates, `2` ATM locator, `3` agent (`set-target-queue` →
    `escalate-to-queue`), `4` share location.
  - Timeout / no match / any other unhandled case also falls through to
    `set-target-queue` → `escalate-to-queue`.
- `wise-calls-org-voicemail-ivr` (Id `05d92d19-1fc1-4540-a3f5-91dda3584ec5`) is
  the live, currently-assigned voicemail flow (department routing + message
  recording). It is not part of `wisecalls-voice-v1-dev`.
- Existing contact attributes set by `wisecalls-voice-v1-dev`: `customerVerified`,
  `trustState`, `phone`, `otp_entered`, `customerId`. None collide with the
  attribute names the password-reset feature uses (`resetSessionId`,
  `maskedPhone`, `candidateFound`, `resetOutcome`).
- The generic top-of-call OTP verification in `wisecalls-voice-v1-dev` is
  **not sufficient** to authorize a directory password reset: it only proves
  the caller matches a `CoreDataTable` record, not that the account is
  `ACTIVE`, `passwordResetAllowed`, non-privileged, and has a
  `directoryUserName` — those checks live only in the password-reset
  feature's own `CustomerDirectoryTable`. The password-reset branch therefore
  keeps its own independent identify + OTP step, even if the caller already
  verified earlier in the same call.

## Design

Extend `wisecalls-voice-v1-dev`'s `main-menu` action with two new DTMF
options. Do not edit `wise-calls-org-voicemail-ivr` in place — reference it via
Transfer to Flow so its live behavior is unchanged.

### Menu prompt (replaces current `main-menu` text)

> "For our current product rates, press 1. For the nearest branch or ATM,
> press 2. To speak with an agent, press 3. To share your location securely,
> press 4. To reset your directory password, press 5. To leave a voicemail
> message, press 6."

### New option 5 — password reset

1. `call-identify-caller-reset` — Invoke AWS Lambda `IdentifyCallerFunction`
   (from the `ad-password-reset` stack). No manually supplied phone; Connect
   provides `Details.ContactData.CustomerEndpoint.Address` automatically.
2. `check-reset-candidate` — Compare `$.External.candidateFound`:
   - `false`, invocation error, or timeout → `reset-unavailable-message`
     ("Automated verification isn't available for that right now.") →
     **reuse the existing `set-target-queue` → `escalate-to-queue`** path.
     Do not reveal whether a customer or AD account exists.
   - `true` → continue.
3. `set-reset-attributes` — Set contact attributes:
   `resetSessionId = $.External.resetSessionId`,
   `maskedPhone = $.External.maskedPhone`.
4. `reset-otp-prompt` — Play prompt: "For your security, enter the code sent
   to the mobile ending [maskedPhone]." Do not read back the OTP or
   personalize before verification.
5. `invoke-reset-bot` — Get customer input (Amazon Lex V2), bot alias
   `PasswordResetBot`/`{Environment}-connect`, locale `en_AU`. Set Lex
   session attribute `resetSessionId` from the Connect contact attribute.
   Start intent `ResetPassword`.
6. `check-reset-outcome` — intent state `Fulfilled` and `resetOutcome=SUCCESS`
   → success prompt → `end-call`. **Every other outcome**
   (`OTP_INVALID`, `EXPIRED_OR_USED`, `ATTEMPTS_EXCEEDED`,
   `ACCOUNT_INELIGIBLE`, `RESET_FAILED`, `REPLAY_REJECTED`,
   `INVALID_REQUEST`, or a Lex/Lambda error) → the same generic failure
   message used in step 2 → the same `set-target-queue` → `escalate-to-queue`
   agent path. One generic failure message for all non-success outcomes,
   per `ad-password-reset/docs/connect-flow.md`'s no-enumeration rule.

No new queue is created; option 5's failure paths and option 3 (agent) share
the existing queue.

### New option 6 — voicemail

`transfer-to-voicemail` — Transfer to Flow → `wise-calls-org-voicemail-ivr`
(Id `05d92d19-1fc1-4540-a3f5-91dda3584ec5`). Hard transfer; the voicemail
flow's own department routing, prompts, and error handling apply unchanged
from that point on. `wisecalls-voice-v1-dev` is not involved once transferred.

### Attributes used by the new branch (all new, no collisions)

| Attribute | Scope | Spoken to caller? |
|---|---|---|
| `candidateFound` | internal branching only | no |
| `resetSessionId` | opaque UUID, passed to Lex only | no |
| `maskedPhone` | last 4 digits | yes (once) |
| `resetOutcome` | internal branching only | no |

Never put the full phone, directory username, OTP, password, home address,
or customer ID into contact attributes, Lex slots, transcripts, CTRs, agent
notes, prompts, or logs — inherited unchanged from
`ad-password-reset/docs/security.md` and `docs/connect-flow.md`.

### Out of scope / unchanged

- Options 1–4 and the top-of-call generic verification sequence.
- `wise-calls-org-voicemail-ivr` internals (department routing, recording).
- Everything in `ad-password-reset`'s infrastructure, Lambdas, and Lex bot —
  this design only adds Connect flow wiring that calls them.
- Whether/when `wisecalls-voice-v1-dev` gets assigned to the live phone
  number — that remains a separate cutover decision gated by acceptance
  testing (see below), unaffected by this change.

## Error handling summary

Fail closed everywhere: any Lambda error, Lex error, or timeout in the new
branch routes to the same agent queue used for option 3, never to a
password-reset success state and never back into the menu silently. This
mirrors the existing flow's own timeout/no-match behavior (also
`set-target-queue`).

## Publishing / rollout

`wisecalls-voice-v1-dev` is still unassigned to any phone number, so editing
it carries no live-traffic risk today. Follow the existing publish sequence
(`docs/04-connect-configuration.md` §4.10):

1. Save as an inactive draft with the new actions.
2. Export the draft for peer review.
3. Test via a dedicated test number or widget (not the live Wise Calls Org
   number).
4. Publish a new version.
5. Assign only the test number.
6. Observe metrics/logs.
7. Obtain change approval.
8. Only then consider cutting the live number over — a separate, explicit
   decision not implied by this design.

`wise-calls-org-voicemail-ivr` is never edited, so the currently-live voicemail
behavior is unaffected regardless of when/whether `wisecalls-voice-v1-dev`
goes live.

## Test plan

Existing `ad-password-reset` matrix (`docs/deployment.md` step 7), run
through the new menu path instead of a standalone flow:

1. Registered mobile, correct OTP — reset succeeds once.
2. Registered mobile, wrong OTP — generic failure, transferred to agent.
3. Unregistered/anonymous number — no details disclosed, transferred to
   agent.
4. Replay of an accepted session — rejected.
5. Expired OTP — rejected.
6. Inactive, privileged, or `passwordResetAllowed=false` record — rejected.
7. Repeated calls inside 60 seconds — rate-limited.
8. CloudWatch contains no OTP, full mobile, HMAC key, or password.

New cases specific to this design:

9. Option 6 reaches voicemail and department routing works exactly as it
   does on the live number today (regression check on the transfer, not on
   voicemail's own logic).
10. A failed/ineligible password-reset attempt lands the caller on a live
    agent (not stranded, not silently disconnected, not returned to the
    menu to retry indefinitely).
11. Options 1–4 behave identically to their current published behavior
    (regression check that the menu edit didn't disturb existing branches).

## Prerequisites this design assumes

The `ad-password-reset` SAM stack (Lambda `IdentifyCallerFunction`,
`ResetFulfillmentFunction`, `PasswordResetBotAlias`, `CustomerDirectoryTable`,
`ResetSessionTable`) must already be deployed to this same Connect instance
before these flow edits are made, since the new actions reference its
outputs (Lambda ARNs, Lex bot alias). That deployment is tracked separately
and was paused earlier in this session pending AWS SAM CLI installation.
