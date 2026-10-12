# Deployment runbook

## 1. Decisions and prerequisites

- Choose the same AWS Region as the existing Amazon Connect instance (expected `ap-southeast-2`).
- Confirm AWS Managed Microsoft AD Standard pricing and two private subnets in different Availability Zones. Provide DNS/network access for the clients that will use the directory.
- Confirm the Connect service-linked role exists and the deployer can create IAM, KMS, Secrets Manager, DynamoDB, Lambda, Lex V2, Directory Service and Connect integration resources.
- Move the AWS account out of the SNS SMS sandbox, register any required Australian origination identity, and set spend controls. Sender IDs are not supported identically in every destination.
- Decide how users sign in to the directory. Creating AD alone does not provide a user-facing Windows sign-in environment.

Run the read-only check:

```powershell
.\scripts\preflight.ps1 -Region ap-southeast-2 -ConnectInstanceArn 'arn:aws:connect:ap-southeast-2:ACCOUNT:instance/INSTANCE_ID' -Profile PROFILE
```

## 2. Configure

Copy `infrastructure/parameters.example.json` to a local, uncommitted file. Replace account, instance, VPC and subnet placeholders. Use:

- `DirectoryType=MicrosoftAD` for this environment.
- `Environment=dev` for the PoC.
- `AllowTemporaryPasswordSms=true` only for the PoC. CloudFormation rejects that combination for `prod`.

Do not reuse a public DNS domain as `DirectoryName`. Ensure the chosen directory DNS name does not conflict with existing DNS namespaces.

## 3. Validate and review the change set

```powershell
.\scripts\validate.ps1
.\scripts\deploy.ps1 -StackName wisecalls-dev-ad-reset -Region ap-southeast-2 -S3Bucket YOUR-SAM-BUCKET -ParameterFile .\infrastructure\parameters.dev.json -Profile PROFILE
```

The first deploy command is a dry run. After review:

```powershell
.\scripts\deploy.ps1 -StackName wisecalls-dev-ad-reset -Region ap-southeast-2 -S3Bucket YOUR-SAM-BUCKET -ParameterFile .\infrastructure\parameters.dev.json -Profile PROFILE -Execute
```

Directory creation commonly takes much longer than Lambda/table creation. Wait for `CREATE_COMPLETE`; do not interrupt or delete the stack merely because it remains in progress.

## 4. Create the test directory user

For Managed Microsoft AD, enable Directory Service Data access, then create the non-privileged `alex.sample` test user through the AWS Directory Service console/API or from a domain-joined administration host. Set a temporary initial password and complete any required first-login change. Do not use the directory `Admin` account for the demo.

For Simple AD, user administration normally requires domain-joined Windows administration tools. The reset Lambda still uses `ResetUserPassword`, but the customer account must already be eligible for Simple AD.

Verify the username is exactly `alex.sample` before seeding DynamoDB. The reset API can enable a disabled user, so the DynamoDB `status`, `passwordResetAllowed`, and `privilegedAccount` checks are deliberate safety controls.

## 5. Seed the registered mobile mapping

Install `boto3` in the operator environment if needed. First run without `--apply`:

```powershell
py -3.13 .\scripts\seed_customer.py --stack-name wisecalls-dev-ad-reset --region ap-southeast-2 --profile PROFILE
```

Review the masked output, then write it:

```powershell
py -3.13 .\scripts\seed_customer.py --stack-name wisecalls-dev-ad-reset --region ap-southeast-2 --profile PROFILE --apply
```

The item includes customer ID `123456`, the registered mobile from `WISECALLS_OPERATOR_PHONE` (or `--phone`), the home address, and `directoryUserName=alex.sample`. The partition key is a keyed HMAC, not a reversible phone number. Do not manually invent `phoneHash`; the Lambda and seed tool must use the same Secrets Manager key.

## 6. Configure the Connect flow

Follow `connect-flow.md`. Clone the existing flow, add the password-reset branch, save, test, and publish a new version. Roll back by repointing the phone number to the previous published flow/version; do not delete the stack during an incident.

## 7. Test cases

Use a dedicated non-production directory user and test phone:

1. Registered mobile and correct OTP — reset succeeds once.
2. Registered mobile and wrong OTP — generic failure; no reset.
3. Unregistered/anonymous number — no customer details disclosed; route to service desk.
4. Replay of an accepted session — rejected.
5. Expired OTP — rejected.
6. Inactive, privileged or `passwordResetAllowed=false` record — rejected.
7. Calls repeated inside 60 seconds — rate-limited.
8. Ensure CloudWatch contains no OTP, full mobile, HMAC key or password.
9. Verify alarms, SNS spend limit, DynamoDB TTL/PITR and KMS encryption.

## 8. Production replacement

Set `AllowTemporaryPasswordSms=false`. Replace password delivery with a short-lived, one-time HTTPS password-choice portal protected by strong MFA. The portal should accept the verified opaque transaction, enforce the directory password policy, call the reset API server-side, expire immediately, and record an immutable audit event without credential material.
