# 9. Android mobile location integration

## Data separation

The customer’s home address is durable profile data in the core DynamoDB
table and Customer Profiles. The customer’s current GPS position is dynamic
data in `CurrentLocationTable`.

The mobile update never modifies:

- home address;
- mailing address;
- Customer Profile address;
- policy risk address.

## Authentication

The Android app signs in through Cognito or the bank identity provider. Its
JWT must contain the immutable business claim:

```text
custom:customer_id = 123456
```

The API ignores any `customerId` supplied in the request body. The Lambda
derives the customer ID from the validated JWT.

## Mobile API request

Use the CloudFormation output `CurrentMobileLocationApiUrl`:

```http
POST /dev/location/current
Authorization: Bearer <Cognito access token>
Content-Type: application/json

{
  "latitude": -37.8123,
  "longitude": 144.9631,
  "accuracyMeters": 28,
  "altitudeMeters": 31.4,
  "verticalAccuracyMeters": 12,
  "observedAt": "2026-07-31T08:30:00Z"
}
```

Android should send a location only after the user has granted runtime
location permission and the application has displayed the approved purpose
and consent notice.

Send:

- WGS84 latitude and longitude;
- Android-reported horizontal accuracy;
- altitude and vertical accuracy when the device provides reliable values;
- observation time;
- no customer ID;
- no client-supplied landmark or human-readable address.

Landmark and address descriptions are backend-derived so a modified client
cannot claim that the customer is somewhere else.

## Current-location lifecycle

The table stores one latest location per customer:

```json
{
  "customerId": "123456",
  "latitude": -37.8123,
  "longitude": 144.9631,
  "accuracyMeters": 28,
  "altitudeMeters": 31.4,
  "verticalAccuracyMeters": 12,
  "observedAt": "2026-07-31T08:30:00Z",
  "receivedAt": "2026-07-31T08:30:02Z",
  "source": "AUTHENTICATED_WEB_OR_MOBILE_CLIENT",
  "expiresAt": 1785487502
}
```

The default lifetime is 15 minutes. After expiry, Connect reports that a
current location is unavailable and asks the customer to refresh it.

## Connect retrieval

The `get_current_location` tool invokes the location Lambda with trusted
overrides:

```json
{
  "action": "getCurrent",
  "customerId": "123456",
  "customerVerified": true,
  "contactId": "<trusted Connect contact ID>"
}
```

The tool:

1. verifies the authenticated state;
2. retrieves a non-expired GPS position;
3. reverse-geocodes it with Amazon Location Service;
4. searches nearby points of interest;
5. applies the device accuracy and landmark distance thresholds;
6. returns map coordinates, an accuracy radius and safe spoken wording.

Amazon Location expects coordinates in `[longitude, latitude]` order for
reverse geocoding and nearby search. Responses are used as `SingleUse`; the
human-readable place result is not persisted.

## Spoken-location rules

The backend, not the language model, chooses the confidence label:

| Condition | Example |
|---|---|
| Good accuracy and close landmark | “Near Richmond train station, around Richmond” |
| Usable locality only | “Approximately around Box Hill” |
| Low GPS accuracy | “Approximately around Melbourne; the GPS accuracy is limited” |
| No place result | “A current GPS position was received with approximately 80 metres accuracy” |

The AI agent must:

- say that the position is approximate;
- never say “at” a landmark;
- use “near” only when `nearbyLandmark` is returned;
- not select another nearby search result itself;
- disclose that location may be stale or inaccurate when appropriate.

## Map presentation

The tool returns:

```json
{
  "map": {
    "latitude": -37.8123,
    "longitude": 144.9631,
    "accuracyRadiusMeters": 28
  }
}
```

The agent workspace or approved internal map component plots:

- a point at latitude/longitude;
- a translucent accuracy-radius circle;
- observation time;
- “approximate location” label;
- refresh/stale status.

Do not expose precise coordinates in an ordinary spoken response unless an
approved use case requires them.

## Android requirements

- request foreground location permission at time of use;
- do not request background location for this feature;
- show consent and purpose text;
- use TLS and the Cognito token;
- reject rooted/debug interception according to mobile security policy;
- send only when the customer actively requests help or location sharing;
- allow the customer to stop sharing;
- display the last submission time and expiry;
- handle permission denial without blocking general service.

## AWS references

- [Reverse Geocode API](https://docs.aws.amazon.com/location/latest/APIReference/API_geoplaces_ReverseGeocode.html)
- [Search Nearby API](https://docs.aws.amazon.com/location/latest/APIReference/API_geoplaces_SearchNearby.html)
- [Amazon Cognito authentication](https://docs.aws.amazon.com/cognito/latest/developerguide/authentication.html)
