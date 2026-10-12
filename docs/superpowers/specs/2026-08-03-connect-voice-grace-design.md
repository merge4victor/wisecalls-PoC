# Connect voice: Olivia (Neural) across WiseCalls-owned flows

Status: approved by operator (Ben Mergen), 2026-08-03. Ready for implementation planning.

## Problem

The operator asked for the IVR's spoken voice to be set to "Grace" across every
contact flow. No Amazon Polly voice named "Grace" exists in any language
(verified against the full official Amazon Polly voice list) — Amazon Connect's
text-to-speech prompts are Polly voices under the hood, so this request cannot
be implemented literally. This spec replaces "Grace" with a real voice choice
and scopes "everywhere" to what this project actually owns and can affect.

## Decisions made during brainstorming

1. **Voice: Olivia.** Amazon Polly's Australian English options are Nicole
   (standard), Russell (standard), and Olivia (neural + generative, AWS's
   newest and most natural-sounding Australian English voice). Olivia was
   chosen over the older standard voices.
2. **Engine: Neural, not Generative.** Olivia supports Neural and Generative
   engines but not Standard (an unspecified engine defaults to Standard, which
   Olivia doesn't support, and the flow's Set Voice block would take its Error
   branch). Generative voices carry real, ongoing per-character billing —
   AWS's own documentation states this explicitly ("You will be charged for
   using the Generative voices"). Neural was chosen to keep the same
   cost-conscious posture already applied elsewhere in this PoC this session
   (removing an idle Kinesis stream, self-expiring the redaction-demo's
   Kinesis stream, choosing Cognito over an ADFS EC2 instance for the
   agent-map identity bridge) while still being a substantial quality
   upgrade over the old standard voices.
3. **Scope: only the WiseCalls-owned flows actually tracked in this repo.**
   This account also contains AWS sample flows, `VMX3_*`-prefixed flows, and
   `Default *` agent/customer hold/whisper/queue-transfer flows that are not
   part of this project and must not be touched, matching this session's
   consistent rule throughout every other feature. `wise-calls-org-voicemail-ivr`
   is technically WiseCalls' own, but this session has treated it as
   untouchable (referenced only via `TransferToFlow`, never edited) and that
   remains unchanged here.
4. **`wisecalls-public-chat-v1-dev` needs no change, and isn't touched.**
   Amazon Connect's own documentation for the "Set voice" block states it has
   no effect on chat channels — the block simply takes its Success branch and
   changes nothing about the chat experience. This isn't a scope exclusion so
   much as a fact: the requested change doesn't apply to chat at all. (This
   flow also isn't currently version-controlled in this repository — only
   `wisecalls-voice-v1-dev.json` and `wisecalls-callback-outbound-v1-dev.json`
   are tracked here, which is the second, independent reason it's excluded.)

## Design

### Mechanism

Amazon Connect's contact-flow-language action for this is
`UpdateContactTextToSpeechVoice` — the "Set voice" block in the flow designer.
It is set once per flow and applies to every text-to-speech prompt from that
point forward in the same flow; it is not a per-prompt setting. The action has
`Success` and `Error` branches. Its documented failure modes: an unspecified
engine defaults to `standard`, and Olivia doesn't support `standard`, so the
engine must be explicitly set to `neural`.

### Flow changes

- **`connect-flows/wisecalls-voice-v1-dev.json`**: a new Set Voice action
  inserted between the existing `start-logging` and `set-public-state`
  actions — the very first two actions in the flow — so it runs before the
  first prompt (`greeting-known`/`greeting-unknown`) ever plays.
- **`connect-flows/wisecalls-callback-outbound-v1-dev.json`**: a new Set Voice
  action inserted between the existing `start-logging` and `greeting`
  actions — again, before the only prompt in that flow.

### Verification approach

The exact JSON parameter names for `UpdateContactTextToSpeechVoice` (the voice
field name, the engine field name, the exact `ErrorType` its error branch
uses) are a best-effort reconstruction from AWS's admin-guide documentation,
not yet confirmed against this account's real behavior. This matches exactly
how the voice-redaction-demo feature's `UpdateContactRecordingBehavior` action
was handled earlier this session: the implementation task pushes the change to
the real, live flows and treats any `InvalidContactFlowException` as
authoritative, fixing the JSON based on the exact error message (and, if
needed, cross-referencing this account's own existing sample flows), the same
verification loop that already worked once this session.

### Out of scope

- `wisecalls-public-chat-v1-dev` (chat — the block has no effect there, and
  the file isn't tracked in this repo).
- `wise-calls-org-voicemail-ivr`, any AWS sample flow, any `VMX3_*`/`Default *`
  flow.
- Per-prompt voice overrides, Newscaster/Conversational speaking styles, or
  any language change — this is a single flow-level voice/engine change only.

## Test plan

Full verification requires real phone calls and cannot be scripted, matching
every other voice-facing feature built this session.

1. Call the main WiseCalls number, listen through several prompts (the
   greeting and the main menu) — confirm they sound like Olivia (natural,
   Australian-accented), not the prior default voice.
2. Trigger a scheduled callback and answer it — confirm the outbound
   greeting also uses Olivia.
3. Confirm chat still works normally — the voice change has no visible
   effect there, as expected, and this is a regression check that nothing
   else in the chat flow was disturbed.
