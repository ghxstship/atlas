# Hosted security settings

Some Section 9 controls are settings in the hosted Supabase project, not in the repository, or need a
decision only the owner can make. `supabase/config.toml` holds the local values, and
`infra/security/test/auth-config.test.ts` fails CI if they regress. Apply each item below to staging
and then to production, and record the date and who applied it in the release notes.

## Supabase Auth (A22-010)

| Setting                    | Where in the dashboard                                 | Value                                                                      |
| -------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| Leaked password protection | Authentication > Providers > Email (Password security) | On. Checks new passwords against the HaveIBeenPwned breach list (V6.2.12). |
| Minimum password length    | Authentication > Providers > Email                     | 12                                                                         |
| Password requirements      | Authentication > Providers > Email                     | Letters and digits                                                         |
| Secure password change     | Authentication > Providers > Email                     | On: a password change needs a recent sign-in (V6.2.3)                      |
| TOTP MFA                   | Authentication > Multi-Factor                          | Enroll and verify on. Optional per person; orgs enforce it per role        |
| WebAuthn MFA and passkeys  | Authentication > Multi-Factor, and Passkeys            | Enroll and verify on                                                       |
| WebAuthn relying party id  | Authentication > Passkeys (WebAuthn)                   | `ghxstship.tech`, the registrable domain (ADR 0033, decision 5)            |
| WebAuthn origins           | Authentication > Passkeys (WebAuthn)                   | `https://atlas.ghxstship.tech` and `https://gateway.ghxstship.tech`        |
| WebAuthn display name      | Authentication > Passkeys (WebAuthn)                   | `XOS`, as `rp_display_name` in `config.toml`                               |
| Google provider            | Authentication > Sign In / Providers > Google          | On, with the clients from `production.md`, "Sign in with Google (OWNER)"   |
| Google skip nonce checks   | Authentication > Sign In / Providers > Google          | On: native iOS sign-in cannot send the nonce (ADR 0036, decision 9)        |
| Manual identity linking    | Authentication > Sign In / Providers (User Signups)    | Off: Google links only to an account with the same verified email          |

Notes:

- Leaked password protection is available only on the hosted project. With it on, Supabase refuses a
  breached password with `weak_password`, and Atlas and Gateway show their weak password message,
  which names breach lists.
- Do not run `supabase config push` with the repository's values. They are local (`site_url` is
  127.0.0.1, and the WebAuthn `rp_id` is `localhost`). Set the hosted values in the dashboard.
- Atlas and Gateway also refuse passwords that contain a product name, the email's local part or a
  part of the person's name. That check runs in the sign-up server actions and needs no setting.
- Skipping the nonce check affects only ID token sign-in (Compass). It still checks Google's signature,
  the issuer, the expiry and that the audience is one of the configured client IDs; a captured ID
  token could be replayed within its hour. The web flow exchanges the code with Google itself.

### Passkeys across Atlas and Gateway (RRR-119)

- The relying party id is the registrable domain `ghxstship.tech`, not a subdomain. A passkey made on
  `atlas.ghxstship.tech` then also works on `gateway.ghxstship.tech`, because a browser accepts a passkey on
  any origin whose host is the relying party id or a subdomain of it.
- Custom Gateway domains, an org's own domain, are not subdomains of `ghxstship.tech`, so these passkeys do
  not work there, and listing such a domain under origins does not change that. People sign in on a custom domain with
  a password, a magic link or OAuth.
- No code names a passkey host. Supabase Auth issues and verifies every WebAuthn ceremony with the settings
  above; Atlas and Gateway only relay the browser's `navigator.credentials` calls to it (A77), and read
  `WEBAUTHN_RP_ID` and `WEBAUTHN_RP_ORIGINS` for security keys as a second factor. Locally, `config.toml` uses
  `rp_id = "localhost"`.
- Compass does not offer passkeys. Native passkeys would need the associated domain
  `webcredentials:ghxstship.tech` and an apple-app-site-association file served by `https://ghxstship.tech`
  itself, which nothing serves today.

## Supabase Data API (RRR-119)

| Setting         | Where in the dashboard | Value                                                                                          |
| --------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| Exposed schemas | Data API settings      | Exactly `[api] schemas` in `supabase/config.toml`: `app`, `xpms`, `api_public`, `api_external` |

Check it after every release whose migrations change `[api] schemas`, and in the post-promotion checks
(`promote-to-production.md`, step 15). A schema missing from the hosted list fails every read of it with
`PGRST106`. Until 2026-10-20 the hosted project exposed only `public`, and Gateway's brand lookup failed that
way.

## Second factors, passkeys, SSO and SCIM (A77)

Atlas, Gateway, Compass and the API enforce second factors, the org MFA policy, session length and idle
timeout themselves (migration 1330). These steps make the hosted project and the deployments match.

1. **Supabase Auth.** Apply the TOTP, WebAuthn and passkey rows of the table above. Without TOTP
   verify on, nobody can reach aal2, and Restricted exports, the 1099-NEC file, SCIM tokens and
   break-glass stay refused.
2. **Vercel, Atlas and Gateway projects.** Set `WEBAUTHN_RP_ID=ghxstship.tech` and
   `WEBAUTHN_RP_ORIGINS=https://atlas.ghxstship.tech,https://gateway.ghxstship.tech` in both
   projects, the same values as step 1. Unset, people still add authenticator apps and passkeys, but
   the "Add security key" option stays hidden. A custom Gateway domain is not a subdomain of
   `ghxstship.tech`, so passkeys and security keys do not work there (see "Passkeys across Atlas and
   Gateway"); people sign in there with a password, a magic link or OAuth, and use an authenticator app.
3. **SAML single sign-on (Enterprise orgs).** Supabase Auth SSO is a hosted add-on: enable it under
   Authentication > Providers > SAML 2.0. For each Enterprise customer, register their identity
   provider with the CLI, linked to the project:
   `supabase sso add --type saml --metadata-url '<IdP metadata URL>' --domains '<their email domain>'`.
   Give the printed provider ID to the customer's Admin, who adds it on Settings, Security with the
   role new people receive. People then use "Sign in with single sign-on" with their work email; when
   the provider adds people just in time, they join at sign-in (migration 1332). The SAML ACS URL to
   give the customer is `<project URL>/auth/v1/sso/saml/acs`, and the entity ID
   `<project URL>/auth/v1/sso/saml/metadata`. The local stack cannot enable SAML, so this path is
   tested only against a hosted project.
4. **SCIM.** Deploy the `scim` Edge Function (`supabase functions deploy scim --no-verify-jwt`). The
   SCIM base URL customers enter in their identity provider is
   `<project URL>/functions/v1/scim/v2`; the token is issued by an Admin on Settings, Security
   (it needs step-up and is shown once). Atlas shows both.
5. **Recovery codes.** XOS issues them itself since A99 (migration 1560, ADR 0055): ten single-use
   codes per person from Personal settings, Security, usable at the sign-in challenge and in step-up.
   Leave Supabase Auth's own MFA recovery codes off: XOS's codes and Supabase Auth's would be two
   sets. A person who loses every second factor and every code still asks an Owner or Admin to
   contact XOS support, who confirm the person's identity and remove the factor from the dashboard
   (Authentication > Users > the user > MFA).
6. **Known limit.** Like the IP allow-list, the org MFA policy, session length and idle timeout are
   enforced where Atlas, the API and Compass check a session, not on direct calls to the Supabase
   endpoint with a session token. The planned fix is the same: route all data access through the API.

## Recovery codes, sessions and OAuth (A99)

Migrations 1560 to 1563 (ADR 0055). Apply to staging, then production:

1. **OAuth 2.1 server.** Authentication > OAuth Server: enable it, set the authorization path to
   `/oauth/consent`, and leave dynamic client registration off. The local value is
   `[auth.oauth_server]` in `config.toml`. Apps are registered only in Atlas (Settings,
   Integrations) or through the `/oauth-apps` API resource; the database creates each app's public
   client. Without the server, `/oauth/authorize` answers that the app is not registered.
2. **Site URL.** Authentication > URL Configuration: the Site URL must be the Atlas origin
   (`https://atlas.ghxstship.tech`), because Supabase Auth sends people to the Site URL plus
   `/oauth/consent`.
3. **Refresh-token rotation.** Authentication > Sessions: keep "Detect and revoke compromised
   refresh tokens" on with the reuse interval at 10 seconds, as `config.toml` sets it. Supabase Auth
   refuses a refresh token two rotations old; on v2.197.0 it did not revoke the newer ones.
4. **Endpoints to give app developers.** Authorization `https://atlas.ghxstship.tech/oauth/authorize`
   (the API host redirects `https://api.ghxstship.tech/oauth/authorize` there) and token
   `https://atlas.ghxstship.tech/oauth/token`. Apps are public clients: PKCE with S256, no client
   secret, capability groups in `scope`. Atlas shows both on Settings, Integrations.
5. **Approximate place on Settings, Security.** Comes from Vercel's `x-vercel-ip-*` headers, read only
   on Vercel (`VERCEL=1`) and only while `XOS_TRUSTED_PROXY_HOPS` is unset. Behind a CDN or your own
   proxy the list shows the client address instead.
6. **Known limits.** A signed-out session's access token still works directly against the Supabase
   endpoint until it expires (`jwt_expiry`, one hour); Atlas, Gateway and the API refuse it at once.
   Rows an app reads by the person alone (their own notifications and preferences) are not limited
   to the app's org. Both close with routing all data access through the API (owner decision 33).

## Upload virus scanning (A22-011): self-hosted ClamAV

The owner chose self-hosted ClamAV, `clamav/clamav` 1.5.4 (decision 10, ADR 0034). Files never leave XOS
infrastructure, so there is no new subprocessor.

1. Run clamd as described in `production.md`, "Upload scanning (ClamAV)".
2. Set the function secrets `XOS_CLAMAV_HOST` and `XOS_CLAMAV_PORT`.
3. Schedule `upload-scan` every minute with the service key, as for `webhook-dispatch`.

Without `XOS_CLAMAV_HOST`, `upload-scan` answers 503 and claims nothing. Every upload stays quarantined,
and nothing is passed through unscanned outside a local stack.

## Org IP allow-list (A52, migration 1201): known limit

An org's IP allow-list is enforced only where Atlas and the XOS API check credentials:

- the API runtime, before any handler runs, for sessions and API keys;
- Atlas, before it resolves a member's context in the org (pages, server actions and the route guard).

It is **not** enforced on direct calls to the Supabase endpoint (REST, Storage and Realtime) made with a
valid session token. Only Atlas and the API see the caller's own address; row level security does not.
A signed-in member outside the allowed networks can still read and write what their role allows by
calling that endpoint directly with their session token. No setting closes this.

The planned fix is routing all data access through the API, so that the Supabase endpoint no longer
accepts end-user tokens directly (owner decision 33, ADR 0034). Until then, say so to any customer who
relies on the allow-list. `legal/security-overview.md` states it publicly.

## The client address behind proxies (A69-002, A69-003)

Every proxy appends the address it saw to `X-Forwarded-For`, so the first entry is whatever the client
sent. XOS reads the entry the trusted proxy appended, counted from the right:

- **Atlas and the API** (IP allow-list, legal acceptances): `XOS_TRUSTED_PROXY_HOPS`, the number of
  trusted proxies in front of the one that appends the client address. Leave it unset on Vercel, which
  replaces the header with the one address it saw. Set `1` when a CDN sits in front of your own proxy.
- **The database** (per-address failure limits, the audit ledger, consent records): the setting
  `xos.trusted_proxy_hops`, 0 by default, which is right for the Supabase Kong gateway of the local
  and self-hosted stacks.

Check the hosted project once, on staging, before relying on per-address limits there:

1. Create a throwaway function that returns `current_setting('request.headers', true)`, call it once
   through the project URL with `X-Forwarded-For: 203.0.113.77`, and drop it.
2. The chain looks like `203.0.113.77, <your address>, ...`. Count the entries after your own address.
3. If there are any, set that count: `alter database postgres set xos.trusted_proxy_hops = '1';` (then
   reconnect). With 0 the database would count a proxy's address and share one limit among callers.

## Report runs (A35)

Schedule the `report-run` Edge Function every minute with the service key, as for
`webhook-dispatch`. It processes `report.run` jobs (migration 1050): until it is scheduled, report runs
stay Queued. Result files go to the private `report-results` bucket, readable only by the person each
run is for.
