// scripts/deploy-frontend.ps1 creates config.js from CloudFormation outputs.
// Do not put client secrets or credentials in this public file.
window.WISECALLS_CONFIG = Object.freeze({
  cognitoDomain: "https://REPLACE.auth.ap-southeast-2.amazoncognito.com",
  clientId: "REPLACE",
  locationApiUrl: "https://REPLACE.execute-api.ap-southeast-2.amazonaws.com/dev/location",
  currentLocationApiUrl: "https://REPLACE.execute-api.ap-southeast-2.amazonaws.com/dev/location/current",
  servicePhoneNumbers: [
    { id: "line-03", label: "03 service line", e164: "+61370100002", display: "03 7010 0002" },
    { id: "line-02", label: "02 service line", e164: "+61255500001", display: "02 5550 0001" }
  ]
});
