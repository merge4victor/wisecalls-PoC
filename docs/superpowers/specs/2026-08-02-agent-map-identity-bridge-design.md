# agent-map identity bridge: dedicated Cognito agent pool

Status: approved by operator (Ben Mergen), 2026-08-02. Ready for implementation planning.

## Problem

`agent-map` (an existing, undeployed WiseCalls add-on — see `agent-map/README.md` and
`agent-map/CLAUDE.md`) shows a customer's consented GPS location inside the Amazon
Connect Agent Workspace. Its own deployment docs (`agent-map/docs/deployment.md`)
require an **agent OIDC public client with authorization-code + PKCE**: an
`AgentOidcIssuer`, `AgentOidcAudience`, `AgentAuthorizationEndpoint`,
`AgentTokenEndpoint`, and a stable `AgentIdClaim` equal to the agent's Connect user ID.

No such identity provider exists in this account. The Connect instance
(`wise-calls-org`, `arn:aws:connect:ap-southeast-2:111122223333:instance/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`)
uses `CONNECT_MANAGED` identity — agents sign into Connect itself with built-in
Connect accounts, not SSO/federation. Confirmed via `aws connect describe-instance`
during brainstorming; this identity-bridge work does not touch or need to change how
agents sign into Connect. It only needs to produce a working OIDC issuer that
agent-map's separately-hosted frontend can authenticate against, with a claim
mappable to each agent's existing Connect user ID.

## Decisions made during brainstorming (in order, including two reversed paths — kept for context)

1. **Managed AD as the identity source, bridged via IAM Identity Center** — the
   operator's first proposal, reusing the AWS Managed Microsoft AD directory already
   deployed for the `ad-password-reset` feature (`corp.wisecalls.internal`, directory
   ID `d-97679cf5a1`). **Rejected after verification**: AWS's own documentation
   (`docs.aws.amazon.com/singlesignon/.../customermanagedapps-saml2-oauth2.html`)
   states IAM Identity Center's OAuth 2.0/PKCE flow is "only available through AWS
   managed applications" (CLI, CodeWhisperer, Redshift, DataZone, etc.) — its access
   scopes are a fixed list of AWS-service scopes, nothing generic for a third-party
   app. For custom apps like agent-map, IAM Identity Center offers only SAML 2.0, not
   OIDC. Using it would require rewriting agent-map's own authentication code (API
   Gateway JWT authorizer, frontend PKCE flow) to speak SAML instead — real
   development work on agent-map itself, out of scope for an identity-bridge task.
2. **Cognito federated to the same Managed AD via ADFS** — technically correct
   (Cognito's Hosted UI genuinely speaks OIDC+PKCE for custom apps, matching
   agent-map's expectations with zero code changes to agent-map), but **rejected on
   cost grounds**: ADFS requires a permanently-running Windows Server EC2 instance,
   the first non-serverless/non-request-billed resource this session would have
   introduced. Every other PoC resource built this session is either serverless or
   request-billed (an idle Kinesis stream was removed earlier this session for
   exactly this class of cost reason).
3. **Cognito with native users, no AD link (final decision)** — a new, dedicated
   Cognito User Pool where agent accounts are created directly (not backed by the AD).
   No EC2, no ADFS, no ongoing always-on cost beyond the pool itself (Cognito user
   pools are not billed per-hour). Agents get a separate credential just for
   agent-map, not synced with AD or with their Connect login — an accepted tradeoff
   for PoC scope.
4. **Provisioning**: manual and documented, not automated. A short runbook step per
   test agent (`admin-create-user` + set a custom attribute to their real Connect
   user ID). No sync/import process — matches the scope of everything else built as a
   PoC this session.

## Design

### Cognito User Pool

A new pool, e.g. `wisecalls-dev-agents` — **deliberately separate** from the existing
customer-facing pool `wisecalls-dev-customers`, per `agent-map/CLAUDE.md`'s explicit
rule: "Do not reuse the customer Cognito user pool for agents." Hosted UI (Managed
Login) enabled, which is Cognito's standards-compliant OIDC provider supporting
Authorization Code + PKCE for a public app client — this is the same flow agent-map's
frontend already expects, so this design changes no agent-map code, only its
configuration parameters.

### Claim mapping

A custom Cognito user attribute, `custom:connect_user_id`, set per-agent at
account-creation time and configured to appear in the ID token. This mirrors a
pattern already proven elsewhere in this same codebase: the Android GPS API already
derives customer identity from a Cognito JWT's `custom:customer_id` claim (per the
root `CLAUDE.md`: "The authenticated Android API derives customer ID from the Cognito
JWT `custom:customer_id` claim"). `AgentIdClaim` becomes the literal string
`custom:connect_user_id`, satisfying agent-map's requirement that the claim equal
"the assigned Connect user ID."

### Resulting agent-map parameters (the actual deliverable of this identity-bridge work)

| agent-map parameter | Value source |
|---|---|
| `AgentOidcIssuer` | Cognito pool's issuer URL (`https://cognito-idp.<region>.amazonaws.com/<pool-id>`) |
| `AgentOidcAudience` | the new public app client's ID |
| `AgentAuthorizationEndpoint` | Cognito Hosted UI's `/oauth2/authorize` |
| `AgentTokenEndpoint` | Cognito Hosted UI's `/oauth2/token` |
| `AgentIdClaim` | `custom:connect_user_id` |

Everything else in `agent-map/infrastructure/parameters.example.json`
(`ConnectInstanceArn`, `CurrentLocationTableName`, `ToolAuditTableName`,
`CustomerIdContactAttribute`, `ApplicationNamespace`) is already answerable from the
existing account/stack — this spec covers only the four identity-provider values above.

### Security

TOTP-based MFA (authenticator app) required on this pool. No per-message SMS cost
(unlike the SNS-based OTP flows elsewhere in this project, which are already
spend-capped), and this pool grants access to a real customer GPS-location viewer —
agent-map's own docs already call for MFA even without an enterprise IdP ("Require
MFA through the enterprise IdP").

### Provisioning runbook (manual, PoC-scoped)

For each test agent: create a Cognito user (`aws cognito-idp admin-create-user`),
set `custom:connect_user_id` to that agent's real Connect user ID (the value
agent-map's backend will compare against `Contact.AgentInfo.Id` per its own security
model in `agent-map/docs/deployment.md` §1), and set a temporary password requiring
first-login change plus MFA enrollment.

### Out of scope

- No link to the AWS Managed Microsoft AD (dropped after the cost discussion in
  decision 2/3 above) — a future project could revisit this if agent headcount or
  turnover makes manual provisioning impractical.
- No automated agent sync between Connect and this pool.
- No change to Connect's own `CONNECT_MANAGED` sign-in model — agents still log into
  Connect itself exactly as they do today; this pool is purely so agent-map has an
  OIDC provider to authenticate its own frontend against.
- agent-map's own deployment (`agent-map/scripts/deploy-stack.ps1`,
  `deploy-frontend.ps1`, and the rest of `agent-map/docs/deployment.md`) is a
  separate follow-on step once this identity bridge's four parameter values exist —
  not part of this spec.

## Test plan

1. Create one test Cognito user with `custom:connect_user_id` set to a real Connect
   agent's user ID; confirm the ID token issued after Hosted UI login contains that
   claim with the correct value.
2. Confirm the Hosted UI flow is genuinely Authorization Code + PKCE (no client
   secret required/used) from a public client, matching what agent-map's frontend
   (a static SPA with no secure secret storage) needs.
3. Confirm MFA (TOTP) is enforced — a login attempt without a valid TOTP code is
   rejected.
4. Confirm the customer-facing pool (`wisecalls-dev-customers`) is untouched by this
   work.
