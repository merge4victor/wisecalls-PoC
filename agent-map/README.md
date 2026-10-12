# WiseCalls Agent Workspace customer map

This add-on shows a customer’s consented, short-lived mobile GPS location inside the **default Amazon Connect Agent Workspace**. It uses Amazon Location map tiles with MapLibre GL JS and never changes the customer’s DynamoDB home address.

It is intentionally a separate stack from the customer-facing location page. Deploy the core WiseCalls stack first, then follow [the deployment runbook](docs/deployment.md).

Included components:

- contact-scoped Amazon Connect third-party application and instance association;
- private S3 origin and CloudFront distribution;
- MapLibre frontend integrated with the Amazon Connect App SDK;
- OAuth 2.0 authorization-code with PKCE for agent sign-in;
- API Gateway JWT authorizer;
- Python Lambda that verifies the JWT agent is assigned to the active contact;
- lookup of the trusted `customerId` contact attribute;
- read-only access to the existing short-lived current-location table;
- Amazon Location reverse geocoding and nearby-place description;
- referrer-restricted, maps-only Amazon Location API key;
- location-access audit records without raw coordinates.

The stack associates the application with the instance but does **not** grant it to existing security profiles. That authorization is a deliberate manual step after testing.
