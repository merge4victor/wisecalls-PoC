# Amazon Connect secure service solution

Deployable AWS-native foundation for:

- personalized Amazon Connect voice service;
- authenticated and redacted banking chat;
- insurance/customer data lookups;
- recent Amazon Connect Cases and comment retrieval;
- agent knowledge search with approved sources;
- authoritative product-rate and ATM lookup tools;
- consented customer GPS capture;
- HTTPS location-sharing website stored in private S3 and served by CloudFront;
- mobile call action that submits consented coordinates before opening the phone dialler;
- human handoff with structured context.

The solution attaches new resources to an **existing** Amazon Connect instance. It does not replace, edit, publish, or archive existing contact flows automatically.

If another coding agent will deploy this package, give it [CLAUDE.md](CLAUDE.md)
as the execution brief. The brief identifies required operator inputs, approval
boundaries, validation order and required completion evidence.

## Start here

1. Read [Architecture](docs/01-architecture.md).
2. Complete [Prerequisites and discovery](docs/02-prerequisites-and-discovery.md).
3. Copy `infrastructure/parameters.example.json` to `deployment-parameters.local.json` and replace every placeholder.
   Set your own contact details as environment variables rather than committing them:

   ```powershell
   $env:WISECALLS_OPERATOR_PHONE = "+614XXXXXXXX"   # callback allowlist and seeded password-reset customer
   $env:WISECALLS_OPERATOR_EMAIL = "you@example.com" # default agent login for scripts/provision-agent.ps1
   $env:WISECALLS_ORG_NAME = "Wise Calls Org"        # organisation name spoken in contact-flow prompts
   ```

   `scripts/deploy.ps1` uses `WISECALLS_OPERATOR_PHONE` when `CallbackAllowedPhonePrefixes` is empty, and `ad-password-reset/scripts/seed_customer.py` uses it as the registered mobile. `scripts/deploy-connect-flow.ps1` substitutes `WISECALLS_ORG_NAME` (or `-OrgName`, default `Wise Calls Org`) for the `__ORG_NAME__` token in `connect-flows/*.json`.
4. Run the local validator:

   ```powershell
   node scripts/validate.mjs
   ```

5. Run the read-only AWS preflight:

   ```powershell
   .\scripts\preflight.ps1 `
     -Region ap-southeast-2 `
     -ConnectInstanceArn arn:aws:connect:ap-southeast-2:111122223333:instance/INSTANCE_ID `
     -Profile YOUR_PROFILE
   ```

6. Follow the [deployment runbook](docs/03-deployment-runbook.md).
7. Configure and test Connect using [Connect configuration](docs/04-connect-configuration.md).
8. Integrate Android location sharing using [Mobile location](docs/09-mobile-location.md).
9. Deploy and test the browser experience using [Location frontend](docs/10-location-frontend.md).

## Deployment boundary

CloudFormation provisions:

- KMS key;
- encrypted DynamoDB customer data, GPS-session, current-location and audit tables;
- encrypted/versioned knowledge source bucket;
- Cognito user pool, application client and managed-login domain;
- JWT-protected location submission API;
- six Lambda functions with scoped IAM roles;
- Connect Lambda and message-processor associations;
- optional Connect AI knowledge assistant and custom knowledge base;
- optional approved web origin.
- private S3/CloudFront location frontend with security headers and Cognito PKCE sign-in.

Account-specific configuration remains staged:

- enabling or selecting Customer Profiles and Cases domains;
- creating the Cognito-to-Customer-Profiles authentication mapping;
- configuring conversational bots and AI-agent prompts;
- setting chat in-flight redaction categories;
- building new versioned voice/chat contact flows from the supplied block sequence;
- routing profiles, queues, phone numbers and chat widget selection;
- publishing knowledge content after business approval;
- production data loading.

This separation protects the running instance from accidental flow replacement.

## Important

Sample rates, ATM locations and knowledge articles are marked **DRAFT** or **DEMO**. They must never be used for customer responses until replaced and approved.
