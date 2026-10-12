# WiseCalls PoC deployment handoff

This repository is a deployment-ready, AWS-native extension for an **existing**
Amazon Connect instance. Do not recreate the solution or modify an existing
production contact flow in place.

## Objective

Deploy the infrastructure and code, then configure new versioned Amazon Connect
voice and chat flows for:

- verified customer lookup and personalized greetings;
- insurance enquiry capture and safe agent handoff;
- recent Amazon Connect Cases and comment summaries;
- banking chat with sensitive-data redaction and Cognito MFA;
- approved knowledge search, live product-rate lookup and ATM lookup;
- consented Android GPS updates, map coordinates and approximate landmark wording.

No function may approve a loan, transfer money, decide insurance coverage or
liability, or expose full sensitive identifiers.

## Required operator inputs

Do not deploy until the operator supplies:

- AWS CLI profile or deployment role;
- AWS account ID and Region;
- existing Amazon Connect instance ARN and instance ID;
- encrypted CloudFormation artifact bucket;
- unique Cognito domain prefix;
- approved application origin, callback URL and logout URL;
- location web page base URL;
- Amazon Connect Cases domain ID, if Cases is already enabled;
- Customer Profiles domain name, if Profiles is already enabled;
- confirmation whether optional Connect knowledge resources should be created.

Copy `infrastructure/parameters.example.json` to
`deployment-parameters.local.json` and replace every placeholder. Never commit
that local file, AWS credentials, tokens, production customer data, or stack
outputs.

## Mandatory execution order

1. Read `README.md` and every file in `docs/` in numeric order.
2. Run `node scripts/validate.mjs`; stop if any test fails.
3. Run `scripts/preflight.ps1` against the supplied account. It is read-only.
4. Export the current Connect configuration with
   `scripts/export-connect-config.ps1` and retain it for rollback.
5. Run `scripts/deploy.ps1` without `-Execute` and review the printed commands.
6. Run it with `-Execute -WhatIf`; review the CloudFormation change set.
7. Only after explicit operator approval, rerun with `-Execute` and without
   `-WhatIf`.
8. Validate the stack outputs and security controls using
   `docs/03-deployment-runbook.md`.
9. Deploy the static location page with `scripts/deploy-frontend.ps1` and test
   it using `docs/10-location-frontend.md`.
10. Replace all `DRAFT`, `DEMO`, and `REPLACE_BEFORE_USE` content with
   business-approved values before seeding or uploading knowledge.
11. Build **new** versioned Connect flows following
    `docs/04-connect-configuration.md`; do not overwrite the live flows.
12. Execute all tests in `docs/07-test-and-acceptance.md` before any cutover.

## Important data rules

- Customer home address belongs in the encrypted core DynamoDB profile record.
- Current GPS is a separate short-lived record and must never replace the home
  address.
- The authenticated Android API derives customer ID from the Cognito JWT
  `custom:customer_id` claim; ignore any customer ID supplied in the request
  body.
- Treat GPS as approximate. Include accuracy/confidence wording and do not
  persist reverse-geocoded landmark text.
- The included Customer 1 record is local PoC data for a synthetic customer (Alex Sample), customer ID
  `123456`; its phone comes from `WISECALLS_OPERATOR_PHONE` at seed time and
  must never be committed.
- The custom chat message processor complements, but does not replace, Amazon
  Connect in-flight sensitive-data redaction.

## Prompts and tools

- Agent safety and response instructions: `config/ai-agent-instructions.md`
- Tool input schemas and trust requirements: `config/tool-schemas.json`
- Contact-flow block sequence and attribute names:
  `docs/04-connect-configuration.md`

Keep tool responses factual and deterministic. Knowledge content may answer
policy questions, but customer-specific rates, cases, identity, and location
must come from the corresponding tool rather than generated text.

## Completion evidence

Return:

- validation and test results;
- the reviewed CloudFormation change set;
- final stack status and outputs with secrets removed;
- resource inventory and Connect associations created;
- names/IDs of new unpublished and published flows;
- acceptance-test evidence;
- rollback location and the previous production flow ID;
- any manual actions still required.

Do not claim deployment completion if only local validation succeeded.
