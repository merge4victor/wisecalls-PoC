# 8. Operations and rollback

## Monitoring

Create alarms for:

- Lambda errors, duration and throttles;
- API Gateway 4xx/5xx;
- Cognito authentication anomalies;
- DynamoDB throttles and system errors;
- Connect contact-flow errors;
- AI tool invocation failures and latency;
- message processor failures;
- Cases API throttling;
- knowledge ingestion failures.

Send alarms to the existing incident-management destination.

## Operational checks

Daily:

- critical alarms;
- tool failure and message suppression counts;
- authentication failure anomalies.

Weekly:

- stale ATM records;
- upcoming rate expiries;
- knowledge review dates;
- AI answer/citation sample;
- duplicate Customer Profiles.

Monthly:

- IAM Access Analyzer findings;
- security-profile membership;
- unredacted transcript access;
- KMS and S3 policy review;
- disaster-recovery evidence.

## Safe rollback

Flow rollback is the primary rollback:

1. reassign the test/production number or widget to the previous published flow;
2. disable the new AI-agent configuration;
3. retain the new stack for investigation;
4. do not immediately delete DynamoDB, KMS or S3 resources;
5. preserve contact IDs and logs;
6. correct and redeploy through change control.

CloudFormation data resources have `Retain` policies. Stack deletion therefore does not delete the KMS key, DynamoDB tables or knowledge bucket. Those retained resources require a separately approved disposal procedure.

## Disable an individual tool

1. remove it from the AI-agent tool configuration or flow;
2. publish a new agent/flow version;
3. verify it cannot be selected;
4. preserve Lambda and audit logs;
5. revoke the Connect integration only after confirming no other flow uses it.

## Credential or data incident

1. stop affected chat/voice flow or tool;
2. preserve evidence;
3. revoke tokens/sessions where applicable;
4. restrict transcript access;
5. engage the organisation incident process;
6. assess notification obligations;
7. rotate affected secrets/keys only under the incident plan;
8. test before reactivation.

## Data restoration

- DynamoDB PITR restores to a new table; update Lambda configuration only after validation.
- S3 versioning recovers previous knowledge source objects.
- Customer Profiles, Cases and Connect configuration require their documented backup/export strategy.
- Keep exported flow definitions for every production release.
