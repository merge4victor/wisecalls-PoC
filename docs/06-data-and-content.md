# 6. Data and content preparation

## Core table key patterns

| PK | SK | Purpose |
|---|---|---|
| `CUSTOMER#<id>` | `PROFILE` | Minimal application profile |
| `CUSTOMER#<id>` | `VEHICLE#<id>` | Vehicle |
| `CUSTOMER#<id>` | `POLICY#<id>` | Policy |
| `PRODUCT#<code>` | `RATE#<date>` | Effective product rate |
| `DIRECTORY#ATM` | `ATM#<id>` | ATM directory |
| `DIRECTORY#BRANCH` | `BRANCH#<id>` | Branch directory |

Do not use phone, email or account number as the primary customer key.

The customer profile item stores the durable home address. A mobile GPS
position is never written over the home address; it is stored separately
with observation time, accuracy, consent/source and automatic expiry.

Customer 1 local seed data is in `config/customer-data.local.json`. The file
is ignored by source control because it contains personal information. Load
it explicitly:

```powershell
.\scripts\seed-data.ps1 `
  -Region ap-southeast-2 `
  -StackName connect-secure-service-dev `
  -DataPath .\config\customer-data.local.json `
  -Profile YOUR_PROFILE `
  -Execute
```

## Rate requirements

Every production rate must include:

- product code and approved display name;
- interest rate;
- comparison rate where applicable;
- rate type;
- effective-from and optional effective-to date;
- source record ID;
- approved disclaimer;
- approval state;
- content owner and approval evidence.

Only `APPROVED` records should be exposed in production. Add a status condition to the Lambda or use a separate approved table/view before go-live.

## ATM requirements

Every ATM record should contain:

- stable ATM ID;
- approved name and address;
- latitude/longitude;
- opening hours;
- deposit capability;
- accessibility information;
- last verified timestamp;
- active/out-of-service state.

The supplied locator calculates straight-line distance. Add Amazon Location Routes in a later adapter when road distance and duration are required; keep the bank directory authoritative.

## Customer context

Do not copy full core-banking/insurance records into DynamoDB merely for Connect. Store references or a customer-service read model. Where a core API exists, replace the DynamoDB query inside the Lambda with the approved private API integration.

## Knowledge metadata

Each article requires:

```json
{
  "product": "car-loan",
  "jurisdiction": "AU",
  "audience": "agent",
  "status": "approved",
  "effectiveFrom": "2026-07-01",
  "reviewBy": "2026-10-01",
  "owner": "Consumer Lending",
  "version": "4.2"
}
```

Content lifecycle:

1. author;
2. subject-matter review;
3. compliance approval;
4. publish;
5. retrieval test;
6. scheduled review;
7. revoke/replace;
8. retain evidence.

Rapidly changing numeric values must be retrieved from a tool, even when an explanatory knowledge article also exists.
