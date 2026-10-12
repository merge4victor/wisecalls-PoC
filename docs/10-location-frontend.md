# 10. Location-sharing frontend

## Architecture

The page files are stored in a private, versioned S3 bucket. CloudFront reads
them through Origin Access Control and provides the public HTTPS endpoint.
The bucket is not configured for anonymous S3 website access.

HTTPS is mandatory because browsers expose geolocation only in a secure
context. The CloudFront response policy also supplies HSTS, a restrictive
Content Security Policy, clickjacking protection, `no-referrer`, content-type
protection and a Permissions Policy limited to same-origin geolocation.

## Customer flow

### Session-based share (from the IVR's "share your location" option)

1. The customer opens the CloudFront HTTPS URL with a `?session=...` value
   created by the contact flow.
2. The page reads the purpose notice and the customer selects explicit
   consent. No sign-in step: the single-use, short-lived session token in the
   URL is the only credential this path uses.
3. The browser requests foreground geolocation permission.
4. The page sends latitude, longitude, horizontal accuracy, observation time,
   and optional altitude/vertical accuracy to API Gateway over HTTPS, along
   with the session token.
5. After the API accepts the position, the page opens the device phone app
   with the configured WiseCalls number. The customer still confirms the
   call.
6. The session token can only be used once — a repeat submission with the
   same token is rejected.

### Authenticated current-location update (separate feature, e.g. the Android app)

1. The customer opens the CloudFront HTTPS URL with no `?session=...` value.
2. The page redirects to Cognito managed login using authorization code with
   PKCE. The supplied user pool requires TOTP MFA.
3. Cognito returns to the exact CloudFront root URL.
4. The page stores the short-lived ID token in browser session storage only.
5. The customer reads the purpose notice and selects explicit consent.
6. The browser requests foreground geolocation permission.
7. The page sends latitude, longitude, horizontal accuracy, observation time,
   and optional altitude/vertical accuracy to API Gateway over HTTPS.
8. API Gateway validates the JWT. Lambda derives the immutable customer ID
   from `custom:customer_id`; no customer ID is accepted from page input.
9. DynamoDB retains the latest authenticated current location until TTL
   expiry.

## Deploy

Deploy the main stack first with:

```json
{ "ParameterKey": "EnableLocationFrontend", "ParameterValue": "true" }
```

The stack automatically configures the generated CloudFront origin as:

- an API Gateway CORS origin;
- a Cognito callback and logout URL;
- the location URL returned to Amazon Connect.

Configure both pairs of phone-number parameters. E.164 values are used by the
mobile `tel:` links and display values are shown to the customer:

```json
{ "ParameterKey": "ServicePhoneNumberE164", "ParameterValue": "+61370100002" },
{ "ParameterKey": "ServicePhoneNumberDisplay", "ParameterValue": "03 7010 0002" },
{ "ParameterKey": "SecondaryServicePhoneNumberE164", "ParameterValue": "+61255500001" },
{ "ParameterKey": "SecondaryServicePhoneNumberDisplay", "ParameterValue": "02 5550 0001" }
```

The values above are PoC defaults. Replace them with the claimed Amazon Connect
number before production deployment.

Preview the upload:

```powershell
.\scripts\deploy-frontend.ps1 `
  -Region ap-southeast-2 `
  -StackName connect-secure-service-dev `
  -Profile YOUR_PROFILE
```

Upload and invalidate CloudFront:

```powershell
.\scripts\deploy-frontend.ps1 `
  -Region ap-southeast-2 `
  -StackName connect-secure-service-dev `
  -Profile YOUR_PROFILE `
  -Execute
```

The script reads stack outputs, generates `config.js`, synchronises the static
assets to the dedicated frontend bucket and creates a CloudFront invalidation.
`config.js` contains public identifiers and endpoints only; it never contains
an application-client secret or AWS credential.

## Cognito test customer

Before testing, create the PoC customer in the user pool and set the immutable
custom attribute:

```text
custom:customer_id = 123456
```

Use an administrator-approved process to set the initial password and enrol
TOTP MFA. Do not put a password, MFA seed or temporary token in this repository.

## Acceptance checks

- CloudFront redirects HTTP to HTTPS and direct S3 object access is denied.
- The page cannot share until the consent checkbox is selected.
- the customer can choose either the `03` or `02` service line;
- “Share location and call” submits the accepted coordinates before opening the selected line in the dialler;
- each “Call without location” link opens its corresponding line without making an API request.
- Denying browser permission shows a safe message and sends no API request.
- Successful sign-in (authenticated current-location path only) shows only a masked customer ID.
- The session-based share path never shows a sign-in screen.
- The request body contains no customer ID, token, address or landmark.
- API Gateway rejects missing, expired, wrong-audience and modified JWTs.
- DynamoDB keeps home address and current location in separate records/tables.
- Altitude is omitted cleanly when the browser/device does not provide it.
- A successful submission shows coordinates, device accuracy and timestamp.
- Sign-out clears the browser session and invokes Cognito logout.

## AWS and browser references

- [AWS secure static website with S3 and CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/getting-started-secure-static-website-cloudformation-template.html)
- [S3 website endpoints do not support HTTPS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/HostingWebsiteOnS3Setup.html)
- [MDN Geolocation secure-context requirement](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation_API)
