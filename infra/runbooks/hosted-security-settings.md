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
| WebAuthn relying party id  | Authentication > Passkeys (WebAuthn)                   | The production registrable domain, for example the Atlas apex domain       |
| WebAuthn origins           | Authentication > Passkeys (WebAuthn)                   | The https origins of Atlas and Gateway, including custom Gateway domains   |

Notes:

- Leaked password protection is available only on the hosted project. With it on, Supabase refuses a
  breached password with `weak_password`, and Atlas and Gateway show their weak password message,
  which names breach lists.
- Do not run `supabase config push` with the repository's values. They are local (`site_url` is
  127.0.0.1, and the WebAuthn `rp_id` is `localhost`). Set the hosted values in the dashboard.
- Atlas and Gateway also refuse passwords that contain a product name, the email's local part or a
  part of the person's name. That check runs in the sign-up server actions and needs no setting.

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
