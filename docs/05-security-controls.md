# 5. Security controls

## Prohibited information

The system must never ask a customer to place the following in normal voice transcription or chat:

- password;
- PIN;
- CVV/CVC;
- MFA or OTP code;
- recovery code;
- private authentication secret;
- full magnetic-stripe or card data.

Authentication challenges belong in the Cognito/bank IdP interface or an approved secure voice process.

## Authorization

- Public agents can access only public knowledge, published rates and location directories.
- Authenticated tools require `customerVerified=true`.
- Customer/profile identifiers are taken from trusted Connect/Cognito session state.
- The model cannot choose another customer's identifier.
- Human agents receive least-privilege Connect security profiles.
- Unredacted transcripts are restricted to a named compliance role.

## Data minimisation

- Tool responses contain only fields needed to answer the request.
- Account, policy, registration and card identifiers are masked.
- Full records remain in the authoritative system.
- GPS sessions expire and can be submitted once.
- Current GPS never overwrites a customer home address.
- No raw customer record is inserted into a knowledge base.
- Sensitive temporary values use flow attributes instead of persistent contact attributes.

## Encryption

- CloudFormation creates a rotating KMS key.
- DynamoDB uses that KMS key and PITR.
- Knowledge source S3 uses the KMS key, versioning and public-access blocking.
- Configure the existing Connect transcript bucket with the organisation-approved KMS key and bucket policy.
- All client and AWS API traffic uses TLS.
- The browser page is in private S3 and is served through CloudFront HTTPS with Origin Access Control.
- Browser authentication uses Cognito authorization code with PKCE and no client secret.
- CloudFront applies CSP, HSTS, clickjacking, referrer and geolocation permission headers.

## Detection and audit

- Enable CloudTrail data/control events appropriate to the services.
- Enable Connect flow logs for development and controlled production diagnostics.
- Enable Lambda structured logging without customer payloads.
- Send tool invocations to the audit table or the organisation SIEM.
- Alarm on Lambda errors, throttling, message-processor failure and authentication anomalies.
- Review AI-agent traces, tool parameter accuracy, citations and faithfulness.

## Redaction limitations

Machine-learning redaction can miss values. Prevent collection first, block known credential patterns second, redact third, restrict access fourth, and apply retention controls fifth.

## Threats to test

- caller-ID spoofing;
- stolen authenticated browser session;
- IDOR/customer ID substitution;
- prompt injection in customer messages and knowledge documents;
- malicious HTML/JavaScript in chat;
- transcript and log leakage;
- duplicate Customer Profile matches;
- stale or conflicting rates;
- unapproved knowledge article;
- replayed GPS link;
- tool timeout and fail-open routing;
- agent privilege escalation.

## Production changes required

The sample IAM uses `Resource: "*"` for read-only Connect Cases actions because case resource-level patterns vary with the selected domain. After the account and domain are known, restrict it to the precise supported domain/case ARN patterns and validate with IAM Access Analyzer.
