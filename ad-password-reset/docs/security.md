# Security and banking guardrails

This package demonstrates identity recovery. It is not approval for use as a production bank credential-reset system.

## Enforced in the code/template

- Caller ID only selects a candidate DynamoDB record; it is not authentication.
- Registered mobile numbers are looked up using a keyed HMAC and are encrypted at rest with a customer-managed KMS key.
- OTPs are random, stored only as a keyed hash, expire after five minutes, have capped attempts, are rate-limited, and are single-use.
- The destination number always comes from DynamoDB, never from speech, DTMF or caller-supplied Lambda parameters.
- Inactive, privileged and reset-disallowed records are denied before and after OTP verification.
- Connect/Lex receive only an opaque transaction ID and masked phone.
- CloudFormation forbids temporary-password SMS in `prod`.
- Directory and customer data use retention/PITR controls.

## Required before production

- Replace SMS password delivery with an authenticated password-choice portal. SMS OTP alone is vulnerable to SIM swap, number recycling and interception.
- Require phishing-resistant MFA where practical; step up to a human verification process for recovery-risk signals.
- Integrate authoritative HR/identity lifecycle data. DynamoDB must not keep a departed or disabled employee eligible.
- Add WAF/rate controls to every public API, fraud velocity rules across phone/customer/IP/device, anomaly detection, alarms and security operations response.
- Store immutable audit facts only: customer surrogate, transaction, timestamps, result and reason category. Never log credentials, OTPs, full phone numbers, home addresses or authentication answers.
- Apply least privilege, permission boundaries, separate deployment/operator roles, MFA, CloudTrail, Config, GuardDuty/Security Hub, KMS rotation and secret rotation.
- Define retention and redaction for Connect recordings, transcripts, Contact Lens output and chat. Pause/redact capture for sensitive entry and prohibit PAN, CVV, PIN and passwords in chat.
- Perform threat modelling, privacy impact assessment, Australian regulatory/legal review, penetration testing, disaster recovery testing and change approval.
- Use generic prompts to prevent account enumeration. Human agents must never ask a caller to read out an OTP intended for automated verification.

## Production flow policy

Allowed automation: account-status guidance, locked-account recovery initiation, branch/ATM information and authenticated low-risk service requests. Require step-up verification and/or an agent for profile changes, payee changes, card controls and disclosure of sensitive account information. Do not approve loans, transfer funds, disclose secrets, or alter high-risk identity attributes through this flow.
