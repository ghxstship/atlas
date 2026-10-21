# ADR 0055: Recovery Codes, Signed-In Sessions, More Step-Up and OAuth 2.1

- Status: Proposed
- Date: 2026-10-21
- Decider: A99 (RRR-144) took the decisions below as the follow-up to A77 (RRR-122); the owner applies the hosted settings listed under "Owner steps"

## Context

A77 gave Atlas, Gateway and Compass second factors, passkeys, org session rules and one step-up check (`private.require_second_factor`, migration 1333). Four pieces were left:

- **Recovery codes** (finding A54-001; Section 7.5 invariant 8: "recovery codes … are stored hashed and shown once"). Supabase Auth v2.197.0 has recovery codes of its own (`auth.mfa_recovery_code_sets`, the `mfa/recovery_code` method), but behind `GOTRUE_MFA_RECOVERY_CODES_*_ENABLED`, which Supabase CLI 2.120.0 cannot set. A person who lost every factor had to go through XOS support.
- **Sessions and devices** (Section 4.5.6 personal setting 4).
- **Step-up for billing, role changes and API key creation** (Section 9, trace row S9-08).
- **OAuth 2.1 for the public API** (Section 10.1, trace rows S8.5-02 and S10.1-02). The frozen OpenAPI document (ADR 0023) already names `/oauth/authorize`, `/oauth/token` and one scope per capability group.

What the local stack does was checked on Supabase Auth v2.197.0 before deciding (scripts kept out of the repository; every credential generated at run time):

- A row in `auth.mfa_amr_claims` with `mfa/recovery_code` plus `aal = 'aal2'` on `auth.sessions` gives the session an aal2 token with that method at the next refresh; Supabase Auth counts the method as a second factor.
- Deleting an `auth.sessions` row makes `getUser()` with its access token fail at once and its refresh token fail; the access token itself stays valid until it expires (`jwt_expiry`, an hour).
- The OAuth server works with `[auth.oauth_server] enabled = true`. It requires a PKCE challenge but also accepts `plain`; it accepts only its own scopes (`openid`, `email`, `profile`, `phone`) and answers anything else with "unsupported scope"; authorization codes are single use; the token endpoint and `/oauth/authorize` need no `apikey`. Access tokens carry `client_id`, `scope` and `session_id`, with the method `oauth_provider/authorization_code` at aal1.
- Refresh tokens rotate. Presenting the previous token again returns the current one (a retry window); a token two generations old is refused with `refresh_token_already_used`, but the newest token keeps working: the family is not revoked.
- A client inserted with a null `client_secret_hash` breaks the authorize endpoint; the admin API writes an empty string for a public client.

## Decision

### Recovery codes (migration 1560)

1. **XOS issues them, on top of Supabase Auth's factors.** Ten codes per person, ten characters each from a 32-symbol alphabet without `i`, `l`, `o` and `u` (50 bits, shown as `xxxxx-xxxxx`; typing ignores case, spaces and the hyphen, and reads `i`, `l` as 1 and `o` as 0). They are made in the database from pgcrypto's strong random bytes and stored only as bcrypt hashes (cost 8) in `private.recovery_codes`, which no signed-in role can select. `app.generate_recovery_codes()` returns them once; a new set deletes the old one.
2. **Making codes is a change to how a person signs in**, so it asks for a verified second factor and step-up within 15 minutes (`private.require_second_factor`); API keys and apps are refused. Removing the last factor deletes the codes (`app.prune_recovery_codes`, called by the remove action), and a code is refused while no factor is held.
3. **Spending a code is one server-side transaction that cannot be replayed.** `app.redeem_recovery_code(code)`:
   - refuses a read-only (GET) transaction, anon, an API key or an app;
   - takes the session from the `session_id` claim of the JWT PostgREST verified, and refuses unless that session exists, belongs to the caller and has not expired, so a code raises only the caller's own session;
   - refuses once the person has five wrong codes in 15 minutes (`private.rate_limit_events`, counted per person; wrong codes return an outcome instead of raising, so the count survives the transaction);
   - locks the person's unspent codes (`for update`) and compares with bcrypt; a parallel attempt with the same code waits and then finds it spent;
   - on a match, marks the code used with the session, inserts the `mfa/recovery_code` amr claim (or moves its time) and sets `aal2` on the session row: exactly the rows Supabase Auth writes when a factor verifies. The client then refreshes its session (`redeemRecoveryCode` in `@xos/data/account-security`) to receive the aal2 token. A replayed request finds the code spent and is counted as a wrong code.
4. `private.second_factor_at()` counts `mfa/recovery_code`, so a code passes the step-up check like any second factor, and the sign-in challenge and the step-up dialog offer "Use a recovery code instead".
5. **Audit and notice.** `private.account_security_events` (append-only, the person's own trail, read by `app.my_security_events`) records each set made, each code used and refused, and each set cleared. Using a code sends `account.recovery_code_used` (category account: urgent, never held for a digest) with the codes left, through the org the person chose last, else their newest membership, else an org they work with externally.
6. When the hosted project can turn on Supabase Auth's own recovery codes, XOS can move to them: the method name is already the same. Until then the support route in `hosted-security-settings.md` stays only for people with neither a factor nor a code.

### Sessions and devices (migration 1561)

7. Sessions are Supabase Auth's. `app.my_sessions()` returns only the caller's, this one first; sessions of OAuth apps are left out and managed under Connected apps.
8. **The device and place are XOS's own record, never Supabase Auth's.** `auth.sessions.ip` is the first `X-Forwarded-For` entry, which the client writes, and its user agent is the Atlas server's when Atlas signed the person in. The Atlas and Gateway proxies record the session's device once a minute with `app.touch_my_session`: the client address as `clientAddress()` reads it past `XOS_TRUSTED_PROXY_HOPS` (A69-003), the user agent, and an approximate place only where the host derived it from that same address: Vercel's `x-vercel-ip-*` headers, read only when `VERCEL=1` and no trusted proxy sits in front. Elsewhere the list shows the address. The record lives in `private.session_devices`, deleted with the session.
9. **Signing out** one other session, or every other one, deletes the `auth.sessions` rows as Supabase Auth's own sign-out does (refresh tokens and amr claims cascade). Atlas and Gateway stop at once (the proxy's `getUser()` fails); `app.my_org_auth_status` gains `session_ended`, so the API runtime (within its 30-second cache) and any guard that reads it refuse the access token too. Each sign-out is on the trail and sends `account.session_signed_out`.
10. **Admins see no one else's sessions.** Section 4.5.6 lists "sessions and devices" under the person's own settings; org settings 10 lists the org's session rules (session lifetime, idle timeout), which 1330 enforces. Nothing in the spec gives an admin another person's devices, so nothing does.

### More step-up (migration 1562)

11. **Role changes**: the role guard (`private.guard_membership_role`, latest 0204, every rule kept) asks for step-up when a person assigns someone else a role or removes someone else's role. Joins the platform makes (accepted invitations, single sign-on, SCIM, org creation, service accounts) run as the platform or in a trusted operation and are not asked. Atlas's member role select answers the refusal with the step-up dialog and resubmits.
12. **API key creation**: `app.create_api_key` asks for step-up; the service-account overload delegates to it. Atlas now has an API keys panel on Settings, API Keys and Service Accounts (secret shown once). A86's personal access tokens call the same check when they land.
13. **Billing**: Atlas has no billing change yet (Billing and Plan stays disabled until Stripe is connected, and the billing service writes with the service role); signed-in callers hold no write privilege on the subscription tables. Restrictive policies on `app.subscriptions` and `app.subscription_state_transitions` keep step-up in force should a grant ever open them. A79's plan and lifecycle actions and the future checkout and portal server actions call `requireSecondFactor` (the seam A77 built) before they act. Partner wholesale statements and client prices are not stepped up: they record what XOS bills a partner and charge nothing (listed as a follow-up for the owner).
14. Every step-up is recent (15 minutes): each of these changes who holds the org or what a credential may do.

### OAuth 2.1 (migration 1563)

15. **Supabase Auth's OAuth server issues and rotates the tokens.** `supabase/config.toml` turns it on with `authorization_url_path = "/oauth/consent"` and no dynamic registration.
16. **Registered apps are mirrored as public clients.** A trigger on `app.oauth_apps` creates the Supabase Auth client (empty secret hash, `token_endpoint_auth_method none`, the app's redirect URI and name), keeps it in step, and on removal ends every grant, consent and session of it; `private.oauth_app_clients` maps the two. Apps are registered in Atlas (Settings, Integrations) or through the existing `/oauth-apps` resource; the client id an app sends is the Supabase Auth client's.
17. **Capability groups travel beside Supabase Auth's scopes.** `/oauth/authorize` (Atlas; the API host redirects there) checks the request (PKCE S256 only; capability groups in `scope`), signs the person in, starts Supabase Auth's authorization with its own `email` scope and records the groups for that authorization and person (`app.record_oauth_request`). Asking for more than the live grant makes Supabase Auth ask again. Malformed requests are answered on the page, never redirected.
18. **Consent** (`/oauth/consent`): the app, the org that registered it, the groups (Restricted ones marked), the redirect URI and the signed-in person. `app.consent_oauth_request` refuses an authorization without S256, records the grant (`app.grant_oauth_consent`, which now refuses API keys and apps and asks for step-up when any group is Restricted) and only then does Supabase Auth issue the code. Restricted groups are `data` (payroll, banking, tax, government and medical reads; Restricted exports), `org` (members, roles, keys, security, billing) and `audit`.
19. **An app's token is a scoped credential.** For a JWT with `client_id`, `private.api_key_scopes()` returns the person's live grant (empty once revoked), so every capability check, the step-up check (apps never step up) and the org session rules (apps are exempt) treat it like an API key. `private.my_org_ids()` and `private.person_capability_reach()` (latest 1298, unchanged otherwise) limit it to the org that registered the app, and the custom access token hook names that org in its `org_id` claim. The API runtime reads `app.my_oauth_access` (cached 30 seconds per token), binds that org, and checks each operation's group (credential `oauth`).
20. **Revocation**: revoking a grant (Connected apps, or the `/oauth-grants` resource) revokes Supabase Auth's consent and deletes the app's sessions for that person, so the refresh token stops at once and the access token reaches nothing.
21. `/oauth/token` forwards form-encoded code and refresh grants to Supabase Auth unchanged, outside the proxy (no CSRF check, no cookie), with the app's address as the one `X-Forwarded-For` entry so Supabase Auth's per-address limits count apps, not Atlas.

## Consequences

- Invariant 8's recovery-code clause is implemented and tested (`supabase/tests/1560_recovery_codes.test.sql` names `inv_08_token_rpcs_hashed_secrets`).
- XOS writes four Supabase Auth tables directly (`auth.mfa_amr_claims`, `auth.sessions`, `auth.oauth_clients`, `auth.oauth_consents`), only from security definer functions, with the rows Supabase Auth itself writes. A Supabase Auth upgrade can change them; the pgTAP suites and the Playwright journeys fail first. Move to Supabase Auth's recovery codes and admin API when the hosted project allows.
- Rows an app reads by the person alone (their own notifications and preferences, keyed to the person rather than an org) are not limited by the app's org; capability- and membership-based access is. The planned move of all data access behind the API (owner decision 33) closes this with the IP allow-list's known limit.
- Supabase Auth does not revoke a refresh token family when an old token is reused (observed on v2.197.0); rotation and the retry window are its own.
- The existing pgTAP suites that assign roles or create API keys act with a recent second factor (`pg_temp.as_user_stepped_up` in the identity world).
- A signed-out session's access token still reaches the Supabase endpoint directly until it expires (an hour), the same known limit as the org rules (`hosted-security-settings.md`).

## Owner steps

Names only; values in `infra/runbooks/hosted-security-settings.md`, "Recovery codes, sessions and OAuth (A99)":

- Supabase Auth, OAuth Server: enable, authorization path `/oauth/consent`, dynamic registration off.
- Supabase Auth, Site URL: the Atlas origin (the consent page is relative to it).
- Supabase Auth, Sessions: keep refresh-token rotation on.
- Vercel, Atlas and Gateway: nothing new (`VERCEL` is set by the platform; `XOS_TRUSTED_PROXY_HOPS` as today).
