# Claude Code deployment brief

Deploy this folder as an isolated add-on to an existing Amazon Connect instance. Do not change or delete unrelated WiseCalls stacks, flows, tables, functions, frontends, phone numbers, or customer-location resources.

Required rules:

1. Start with read-only AWS discovery and `scripts/preflight.ps1`.
2. Use `AWS Managed Microsoft AD Standard` unless the operator explicitly sets `DirectoryType=SimpleAD` after confirming Simple AD availability in that AWS account.
3. Never use caller ID as authentication. DynamoDB must contain the normalized registered mobile and the exact directory username.
4. Never print HMAC keys, OTP values, directory passwords, or full phone numbers in command output or logs.
5. Do not seed or deploy until the operator reviews the account ID, region, Connect instance ARN, VPC, subnets, cost, and parameters.
6. Keep `AllowTemporaryPasswordSms=false` in production. The template enforces this; a production implementation needs a short-lived authenticated password-choice portal.
7. Preserve Directory Service and customer table retention policies. Do not delete the directory during rollback without explicit approval.
8. Publish a new contact-flow version; do not overwrite the only known-good version.

Follow `docs/deployment.md` in order and record stack outputs without secret values.
