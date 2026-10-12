window.WISECALLS_AGENT_MAP_CONFIG = Object.freeze({
  apiBaseUrl: "https://REPLACE.execute-api.ap-southeast-2.amazonaws.com/dev",
  awsRegion: "ap-southeast-2",
  mapApiKey: "REPLACE_FROM_CLOUDFORMATION_OUTPUT",
  mapStyle: "Standard",
  oidc: {
    authorizationEndpoint: "https://identity.example.com/oauth2/authorize",
    tokenEndpoint: "https://identity.example.com/oauth2/token",
    clientId: "REPLACE_AGENT_APP_CLIENT_ID",
    redirectUri: "https://REPLACE.cloudfront.net/",
    scopes: ["openid", "profile"]
  }
});
