# WiseCalls Amazon Connect AD password reset

Deployable proof of concept for caller-initiated password reset using Amazon Connect, Amazon Lex V2, Python Lambda, DynamoDB, Amazon SNS, and AWS Directory Service.

The default directory is **AWS Managed Microsoft AD Standard Edition**. `DirectoryType=SimpleAD` is included only for customer accounts where AWS confirms Simple AD remains available.

## Identity rule

The incoming Connect number is never trusted by itself. `IdentifyCallerFunction` normalizes it to E.164, HMAC-hashes it, and performs an exact lookup in `CustomerDirectoryTable`. The OTP is sent only to the `phoneE164` stored in that DynamoDB record. A successful OTP proves possession of the registered mobile before the directory reset API is called.

The supplied sample maps the mobile in `WISECALLS_OPERATOR_PHONE` (or `seed_customer.py --phone`) to customer `123456` and directory user `alex.sample`. Customer and directory data are synthetic PoC values.

## Contents

- `infrastructure/template.yaml` — SAM/CloudFormation infrastructure, Lex V2 bot and Connect associations.
- `functions/` — Python 3.13 Lambda handlers.
- `config/seed-customer.example.json` — sample registered customer, including home address.
- `scripts/` — dry-run-first preflight, deployment, validation and seed utilities.
- `docs/deployment.md` — complete hand-off procedure for Claude Code.
- `docs/connect-flow.md` — blocks and attributes to add to the existing contact flow.
- `docs/security.md` — banking/finance controls and production gaps.

## Quick sequence

1. Read `docs/security.md`; this is a PoC, not a production credential-delivery design.
2. Copy `infrastructure/parameters.example.json`, replace every `REPLACE` value, and keep the two directory subnets in different Availability Zones.
3. Run `scripts/preflight.ps1` and `scripts/validate.ps1`.
4. Run `scripts/deploy.ps1` without `-Execute`, review, then run it with `-Execute`.
5. Create `alex.sample` in the directory and set a test password.
6. Run `python scripts/seed_customer.py ... --apply`.
7. Add the blocks in `docs/connect-flow.md`, publish a new contact-flow version, and test with the registered mobile.

Nothing in this package deploys automatically.
