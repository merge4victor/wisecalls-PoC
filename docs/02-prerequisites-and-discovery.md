# 2. Prerequisites and discovery

Do not deploy until every item in this document has an owner and recorded value.

## Required decisions

- AWS account ID and deployment role
- AWS Region used by the existing Connect instance
- Connect instance ARN and instance ID
- environment name: `dev`, `test`, or `prod`
- exact HTTPS chat-widget origin
- Cognito callback and logout URLs
- whether the bank has an existing OIDC/SAML identity provider
- Customer Profiles domain name
- Cases domain ID
- existing queues and routing profiles
- voice number and chat widget used for testing
- transcript retention period
- KMS administrators and data users
- approved PII redaction categories
- approved and prohibited agent actions
- business owners for rates, ATM directory and knowledge articles

## Required software

- AWS CLI v2
- PowerShell 7+
- Node.js 22+ for local validation
- credentials for a deployment role
- permissions to create CloudFormation, IAM, KMS, Lambda, DynamoDB, S3, Cognito, API Gateway, Q Connect/Wisdom and Connect integration resources

AWS SAM CLI is not required. The deployment script uses `aws cloudformation package`.

## Read-only discovery

Run:

```powershell
.\scripts\preflight.ps1 `
  -Region ap-southeast-2 `
  -ConnectInstanceArn arn:aws:connect:ap-southeast-2:111122223333:instance/INSTANCE_ID `
  -Profile YOUR_PROFILE
```

Record:

```text
AWS account:
Region:
Connect instance ARN:
Connect instance alias:
Customer Profiles domain:
Cases domain ID:
Existing AI assistant IDs:
Existing Lambda integrations:
Existing message processor:
Test queue:
Test routing profile:
Test phone number:
Chat widget origin:
```

## Existing-instance backup

Export all flow definitions and integrations before adding anything:

```powershell
.\scripts\export-connect-config.ps1 `
  -Region ap-southeast-2 `
  -ConnectInstanceArn arn:aws:connect:ap-southeast-2:111122223333:instance/INSTANCE_ID `
  -Profile YOUR_PROFILE
```

This operation is read-only. Store the generated `connect-backup` directory in the controlled deployment evidence location.

## Feature availability gate

Before setting `EnableKnowledgeResources=true`, confirm that the target Region supports the selected Connect AI-agent, customer-authentication and in-flight-redaction features. If CloudFormation support is not available in that Region, deploy with knowledge resources disabled and create/associate the assistant through the supported Connect admin workflow.

## Existing Profiles and Cases

Prefer the domains already associated with the instance. A Connect instance can have one associated Cases domain, and Cases requires Customer Profiles. Do not create a second production domain without a migration plan.

## Production approval gates

- security architecture review
- privacy review
- banking/insurance compliance review
- data retention approval
- threat model
- content-owner approval
- penetration test of the chat and location pages
- operational readiness and incident-response review
