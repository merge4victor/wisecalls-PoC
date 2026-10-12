# 4. Amazon Connect configuration

These steps intentionally occur after infrastructure deployment because they depend on account-specific queues, phone numbers, Profiles, Cases, bots and business approval.

## 4.1 Customer Profiles

1. Open the existing Connect instance.
2. Confirm Customer Profiles is enabled and associated with the intended domain.
3. Confirm KMS administrators and Profile API roles.
4. Define the immutable external `customerId`.
5. Configure search keys for phone, account and profile ID.
6. Configure profile matching and review multiple-match handling.
7. Do not automatically disclose information merely because a phone number matches.
8. Test `Success`, `None Found`, `Multiple Found` and `Error` branches.

## 4.2 Cases

1. Enable Cases only if no domain is already associated.
2. Record the Cases domain ID in the stack parameters and update the stack.
3. Confirm standard field IDs in the target domain:
   - `customer_id`
   - `title`
   - `status`
   - `last_updated_datetime`
4. If the target domain uses different IDs, update `functions/cases-context/index.js`.
5. Grant the Lambda role only `SearchCases`, `SearchRelatedItems` and `GetCase`.
6. Test with a non-production profile and case comments.

## 4.3 Customer chat authentication

1. In the Connect instance, enable customer authentication.
2. Associate the provisioned Cognito user pool and app client.
3. If using an existing bank IdP:
   - configure it in Cognito;
   - map only required claims;
   - require MFA at the IdP;
   - add it to the app client;
   - remove the local Cognito provider if policy requires federation only.
4. Configure a Customer Profiles object mapping using the immutable customer subject, not only email or phone.
5. Add `Authenticate Customer` to the chat flow.
6. Route `Success`, `Timeout`, `Opted out` and `Error` separately.
7. On success, set a flow-local `customerVerified=true`.
8. Never accept an MFA code as a normal chat message.

## 4.4 Sensitive chat processing

At the very beginning of the chat flow add `Set recording, analytics and processing behavior`:

1. channel: Chat;
2. enable conversational analytics;
3. enable in-flight sensitive-data redaction;
4. select all approved entities, including card and bank-account identifiers;
5. use entity-type placeholders;
6. store redacted-only output where policy permits;
7. choose suppression/fail-closed behaviour for processor failure;
8. select the deployed message-processor integration.

The custom processor blocks explicit PIN, password, CVV and OTP disclosures. Built-in redaction remains enabled because the custom processor is not a complete PII detector.

Restrict these security-profile permissions:

- unredacted transcripts;
- redacted transcripts;
- contact search;
- Cases audit history;
- Customer Profiles access;
- AI-agent tools.

## 4.5 Public chat flow

Create a new inbound flow using this order:

1. Set logging behaviour.
2. Enable chat analytics and in-flight redaction.
3. Set public trust state.
4. Invoke the public conversational AI bot.
5. Permit only:
   - approved general knowledge retrieval;
   - published product-rate tool;
   - ATM/branch locator;
   - human escalation.
6. If the request is customer-specific, return control.
7. Run `Authenticate Customer`.
8. On authentication success, route to the authenticated bot or agent queue.
9. On timeout/opt-out/failure, retain public-only permissions.
10. Add queue and error handling.

## 4.6 Authenticated chat flow

After authentication:

1. retrieve Customer Profile by immutable profile/customer ID;
2. set `customerVerified=true` as flow-local data;
3. allow customer-context and Cases tools;
4. mask all identifiers returned to the customer;
5. permit only approved read-only requests;
6. use step-up authentication for any approved higher-risk action;
7. return control and transfer when:
   - the customer requests an agent;
   - a tool fails repeatedly;
   - identity cannot be established;
   - vulnerability, hardship, fraud, complaint or distress is detected;
   - the request involves a prohibited action.

## 4.7 Voice flow extension

Clone the existing voicemail/basic inbound flow. Do not edit it in place.

Add:

1. Customer Profiles lookup using the incoming number.
2. Privacy-safe greeting such as “May I speak with Alex?”
3. Voice verification journey:
   - account/policy identifier;
   - secure SMS or OTP;
   - Lambda verification;
   - flow-local verified flag.
4. Cases lookup only after verification.
5. Voice conversational AI agent for intent and clarification.
6. Customer, rate, ATM and case tools as permitted.
7. Secure GPS link only after explicit consent.
8. human handoff with structured summary.
9. fallback to the original queue/voicemail behaviour on error.

Amazon Connect Voice ID must not be introduced; AWS ended support on 20 May 2026.

## 4.8 AI agent

Create separate configurations:

- Public Self Service
- Authenticated Self Service
- Agent Assistance
- Case Summarization

Use the prompt controls in `config/ai-agent-instructions.md`.

For every tool:

- use the input schema in `config/tool-schemas.json`;
- give a narrow description and examples;
- require authentication in tool instructions where applicable;
- override customer/profile identifiers from trusted session data;
- do not let the model supply trusted identity parameters;
- filter output fields;
- make error behaviour explicit;
- configure Complete and Escalate return-to-control tools.

## 4.9 Knowledge

1. Associate the deployed assistant with the Connect instance.
2. Upload only approved articles.
3. Configure Retrieve tools by content domain.
4. Require citations.
5. Tag/filter content by product, jurisdiction, audience and status.
6. Keep rates and ATM facts in structured tools, not prose.
7. Test ambiguous and conflicting queries.

## 4.10 Publish sequence

1. Save all new flows as inactive drafts.
2. Export them for peer review.
3. Test with a dedicated number and widget.
4. Publish a version.
5. Assign only the test number/widget.
6. Observe metrics and logs.
7. Obtain change approval.
8. Cut over using the Connect number/widget association.
