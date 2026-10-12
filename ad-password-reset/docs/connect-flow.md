# Amazon Connect contact-flow changes

Clone the existing inbound voicemail flow and add a password-reset branch. Use the exact Lambda/Lex resources output by this stack.

## Block sequence

1. **Set logging behavior** — enable flow logs but do not log sensitive attributes.
2. **Get customer input** — ask whether the caller wants directory password help; use DTMF or a simple non-sensitive Lex intent.
3. **Invoke AWS Lambda function** — call `IdentifyCallerFunction` with no manually supplied phone. Amazon Connect puts the real inbound endpoint at `Details.ContactData.CustomerEndpoint.Address`.
4. **Check contact attributes** — inspect `$.External.candidateFound`:
   - `true`: continue.
   - `false`, invocation error, or timeout: say that automated verification is unavailable and route to the service desk. Do not reveal whether a customer or AD account exists.
5. **Set contact attributes** in a dedicated namespace:
   - `resetSessionId = $.External.resetSessionId`
   - `maskedPhone = $.External.maskedPhone`
6. **Play prompt** — "For your security, enter the code sent to the mobile ending [maskedPhone]." Do not read the OTP back and do not personalize before MFA.
7. **Get customer input (Amazon Lex V2)** — select the deployed bot alias and locale `en_AU`. Set Lex session attribute `resetSessionId` from the user-defined Connect attribute. Start the `ResetPassword` intent.
8. **Check contact attributes / Lex result**:
   - fulfilled and `resetOutcome=SUCCESS`: play the success prompt and end.
   - all other outcomes: transfer to a staffed service-desk queue or create a callback.
9. **Disconnect** only after the prompt completes.

## Connect attributes

| Purpose | Connect path | Exposure |
|---|---|---|
| Inbound caller | `$.CustomerEndpoint.Address` | Used by Lambda, never announced |
| Candidate result | `$.External.candidateFound` | Boolean only |
| Transaction | `$.External.resetSessionId` | Opaque UUID, pass to Lex |
| Registered phone | `$.External.maskedPhone` | Last four digits only |
| Greeting | Lex success response | First name only after OTP verification |

Do not put the full phone, directory username, OTP, password, home address, or customer ID into contact attributes, Lex slots, transcripts, CTRs, agent notes, prompts, or logs.

## Failure behavior

Use the same spoken response for missing and ineligible records. Cap retries in both Lex and DynamoDB. A Lambda or SNS failure must fail closed and transfer the call; it must never bypass verification.
