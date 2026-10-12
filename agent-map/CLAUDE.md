# Claude deployment brief: WiseCalls Agent Map

Deploy this add-on only after reading `README.md` and `docs/deployment.md`. Do not modify or publish existing contact flows in place and do not deploy until the operator supplies all `REPLACE_*` values.

## Required order

1. Confirm the core WiseCalls stack is healthy and obtain `CurrentLocationTableName` and `ToolAuditTableName`.
2. Confirm the existing Connect instance ARN and ID.
3. Confirm the agent OIDC issuer, public PKCE client, authorization endpoint, token endpoint and the JWT claim mapped to each Connect user ID.
4. Copy `infrastructure/parameters.example.json` to `deployment-parameters.local.json`; never commit the local file.
5. Run `scripts/validate.ps1`.
6. Run `scripts/deploy-stack.ps1` without `-Execute`.
7. Run it with `-Execute -WhatIf`, inspect the change set, and obtain operator approval.
8. Execute the approved change set or rerun without `-WhatIf` only when directed.
9. Add the `AgentMapUrl` as an exact allowed OIDC callback/logout URL and confirm the token endpoint supports the browser PKCE flow/CORS.
10. Run `scripts/deploy-frontend.ps1` without `-Execute`, then with `-Execute` after review.
11. Add the `customerId` contact attribute only after customer verification in a **new version** of the voice/chat flow.
12. Grant the `wisecalls.agent-map` application `ACCESS` only to a test security profile.
13. Complete every acceptance test in `docs/deployment.md` before broader access.

## Do not weaken

- Do not accept `customerId`, coordinates or agent identity from query parameters or application state.
- Do not remove the backend check that `Contact.AgentInfo.Id` equals the authenticated agent’s mapped Connect user ID.
- Do not place raw coordinates in logs, contact attributes, analytics or audit records.
- Do not grant the application to every security profile by default.
- Do not broaden the Amazon Location API key beyond `geo-maps:Get*` or remove its CloudFront referrer restriction.
- Do not treat GPS as identity proof or emergency-service-grade position.
- Do not reuse the customer Cognito user pool for agents.

Return the reviewed change set, stack outputs with secrets removed, application association ARN, exact security profile changed, frontend test evidence, API authorization test evidence and rollback actions.
