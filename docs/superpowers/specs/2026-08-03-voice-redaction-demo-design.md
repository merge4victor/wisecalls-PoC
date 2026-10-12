# Voice-to-voice PII redaction demo

Status: approved by operator (Ben Mergen), 2026-08-03. Ready for implementation planning.

## Problem

WiseCalls needs a live demo for banking-customer stakeholders that shows a voice call
being transcribed and having sensitive data (credit card numbers, bank account/routing
numbers, and similar PCI/PII) redacted from both the transcript and the saved call
recording. This instance (`wise-calls-org`,
`arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`)
already has call recording configured (`CALL_RECORDINGS` → S3 bucket
`wise-calls-org-voicemails/recordings`) but has no Contact Lens conversational analytics
enabled at all — `REAL_TIME_CONTACT_ANALYSIS_SEGMENTS` instance storage is not
configured. Real-time Contact Lens requires an always-on Kinesis Data Stream, the same
class of ongoing cost this project has already removed once this session (an idle
Kinesis stream was deleted earlier for exactly this reason) and stayed deliberately
cost-conscious about elsewhere (SNS spend capped at $5/month, Cognito native users
chosen over an ADFS EC2 instance for the agent-map identity bridge).

## Decisions made during brainstorming

1. **Real-time analytics, but only for a demo window, not always-on.** Post-call/batch
   Contact Lens (S3-delivered redacted transcript after the call ends) would avoid the
   Kinesis cost entirely, but loses the "watch it redact live" demo moment that matters
   for this audience. A dedicated demo-window Kinesis stream — created right before a
   demo, deleted right after — gets the real-time spectacle without an ongoing cost.
2. **Teardown is self-expiring, not manual-only.** A one-time EventBridge Scheduler
   entry created at spin-up time, targeting a small teardown Lambda, guarantees the
   stream is deleted after an operator-chosen duration even if the operator forgets to
   tear it down manually. The EventBridge Scheduler entry and the Lambda invocation are
   both effectively free (one-shot, sub-second); the only real cost during a demo
   window is the Kinesis stream itself, for exactly as long as the operator chose.
3. **Built-in Contact Lens PCI/PII categories only, no custom second pass.** Contact
   Lens's default redaction categories (credit card numbers, bank account/routing
   numbers, SSN-style numbers, expiry dates, etc.) cover what a banking audience will
   recognize immediately, with zero additional Lambda code. This project does have a
   precedent for a custom second redaction pass (the chat message-processor Lambda,
   which "complements, but does not replace, Amazon Connect in-flight sensitive-data
   redaction" per the root `CLAUDE.md`) — that pattern is available to extend to later
   if WiseCalls-specific identifier formats need covering, but is explicitly out of
   scope for this demo.
4. **Both transcript and audio are redacted.** Contact Lens's "redact and delete
   original audio" option is used, not transcript-only redaction — the saved recording
   has the unredacted original deleted outright, not just access-restricted. This is a
   stronger position than this project's existing documented policy in
   `docs/05-security-controls.md` ("unredacted transcripts are restricted to a named
   compliance role") — for audio, there is no unredacted artifact left to restrict
   access to at all.
5. **Viewing surface is Connect's own Agent Workspace, not a custom UI.** Amazon
   Connect's built-in Agent Workspace already shows a real-time transcript panel once
   Contact Lens real-time analytics is enabled on a call. No new frontend is built for
   this demo.
6. **Scoped to one new IVR branch, not the whole flow.** Real-time Contact Lens is
   billed per minute of call analyzed. Enabling it instance-wide or flow-wide during a
   demo window would mean any real customer call that happened to come in during that
   window is also analyzed and billed. Instead, a new DTMF option — "press N for credit
   card related issues" — is added to `connect-flows/wisecalls-voice-v1-dev.json`
   (the same flow file every other feature this session has extended: password reset,
   voicemail, scheduled callback). Only that branch passes through the
   contact-analytics-enablement step before routing into the existing basic agent
   queue; every other menu option is untouched. This also gives the demo a natural
   narrative: a customer calls, chooses "credit card issues," and reads out a card
   number — precisely the input Contact Lens's default PCI redaction targets.
7. **Demo duration is operator-specified per run, not fixed.** The enable script takes
   a `-DurationHours` parameter rather than a hardcoded window, so a quick test and an
   all-day event can both be supported without changing the script.

## Design

### Contact flow change (one-time, permanent)

A new DTMF option added to `connect-flows/wisecalls-voice-v1-dev.json`, following the
existing menu pattern in this file. The new branch passes through a contact-analytics
enablement step (Amazon Connect's real-time-analytics flow capability — the exact
block name and required parameters are confirmed against a real AWS deploy during
implementation, the same way this project has already found and fixed several other
flow-schema surprises this session by cross-referencing real `InvalidContactFlowException`
rejections against this account's own existing sample flows) before continuing into the
existing basic agent queue transfer, unchanged from how other options already reach an
agent. This flow change is deployed once and is permanent; it has no effect unless the
demo-window Kinesis stream and instance storage association described below also exist
at the time a call reaches that branch — outside a demo window, calls through this
option are expected to route normally, just without analytics. (This
no-storage-config-means-no-analytics-but-otherwise-normal-routing behavior is
Contact Lens's documented default; it is included in this plan's acceptance checklist
to confirm directly against this account rather than assumed.)

### Demo-window automation

Two new PowerShell scripts, matching this repo's existing `deploy.ps1` /
`provision-agent.ps1` conventions (dry-run by default where they mutate AWS state,
`-Execute` to actually run):

**`scripts/enable-redaction-demo.ps1 -DurationHours <N> -Execute`**
1. Creates an on-demand-capacity Kinesis Data Stream, e.g.
   `wisecalls-dev-contact-lens-demo` — on-demand mode avoids manual shard sizing.
2. Associates that stream as this instance's `REAL_TIME_CONTACT_ANALYSIS_SEGMENTS`
   storage config via `associate-instance-storage-config` — this association is the
   real on/off switch for whether the flow's analytics branch does anything.
3. Creates a one-time EventBridge Scheduler entry for `now + DurationHours`, targeting
   a small teardown Lambda, using EventBridge Scheduler's built-in delete-after-completion
   so the schedule itself doesn't linger after firing.
4. Prints the created stream name and the computed expiry timestamp.

**`scripts/disable-redaction-demo.ps1 -Execute`**
Performs the same teardown as the scheduled path — disassociates the instance storage
config, deletes the Kinesis stream, and cancels the pending EventBridge schedule if run
before it fires — so a demo can be ended early without waiting for expiry.

**`functions/redaction-demo-teardown/index.js`**
A small Lambda invoked once by the EventBridge Scheduler entry at expiry. Performs the
same disassociate-and-delete steps as the manual disable script. No state of its own;
idempotent-safe to invoke even if a manual teardown already ran first (disassociating
an already-disassociated config or deleting an already-deleted stream should no-op or
fail harmlessly, not throw an unhandled error — confirmed during implementation).

### Redaction & storage behavior

- Contact Lens's default PCI/PII redaction categories, applied to both the live
  transcript and the saved call recording audio (the "redact and delete original
  audio" option, not transcript-only redaction).
- The redacted recording is written to the same existing S3 location already
  configured for call recording (`wise-calls-org-voicemails/recordings`) — no new bucket
  is introduced by this feature.
- No custom Comprehend-based or Lambda-based second redaction pass is built for this
  demo (see brainstorming decision 3) — this remains available as a documented future
  extension, mirroring the existing chat message-processor precedent, but is explicit
  out-of-scope work.

### Out of scope

- A custom second-pass redaction Lambda for WiseCalls-specific identifier formats not
  covered by Contact Lens's default categories.
- A new phone number or DID — the demo uses a new option on the existing
  `wisecalls-voice-v1-dev` development flow's phone number.
- Any change to the live production contact flow — this feature only touches the
  `-v1-dev` flow this session has already been iterating on for every other feature.
- A custom demo-viewer web page — the existing Amazon Connect Agent Workspace's
  built-in real-time transcript panel is the viewing surface.

## Test plan

Full verification requires a real phone call and cannot be scripted, matching every
other voice-facing feature built this session (scheduled-callback's acceptance test,
agent-map's OIDC login flow). Acceptance checklist:

1. Call in, choose the new "credit card related issues" option, speak a test card
   number during a live demo window — confirm the Agent Workspace's real-time
   transcript panel shows that value redacted as the call happens.
2. After the call, confirm the saved recording in
   `wise-calls-org-voicemails/recordings` has that moment of audio redacted/silenced,
   not the original unredacted speech.
3. Call in through any other existing menu option during the same demo window —
   confirm it is not analyzed by Contact Lens (no transcript panel activity, no
   incremental Kinesis/Contact-Lens cost attributable to that call).
4. Let the demo window expire naturally (or run `disable-redaction-demo.ps1` early) —
   confirm the Kinesis stream, the instance storage association, and the EventBridge
   schedule are all gone afterward.
5. Call in through the "credit card related issues" option again after expiry —
   confirm the call still routes normally to an agent, without analytics.
