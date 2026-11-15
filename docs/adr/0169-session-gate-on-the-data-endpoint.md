# ADR 0169: A Session Gate in the Database for Direct Calls to the Data Endpoint

- Status: Proposed
- Date: 2026-11-15
- Decider: the owner's goal of 2026-11-15 (close the enforcement gaps the Security Overview states, so the public /security page can stop stating them); the open decisions in the last section are the owner's
- Addresses: `legal/security-overview.md` lines 37, 39 and 40; finding A69-010's residual; RRR-243
- Migrations: 904180101 to 904180502 (release 4.18, blocks 01 to 05; ADR 0022). None is written yet.
- Supersedes when accepted: ADR 0033 decisions 33 and 55 (the gap accepted for launch, and the plan to route all data access through the API), ADR 0034 item 5, and the last consequence of ADR 0055 (a signed-out token stays valid on the data endpoint for up to an hour)

Nothing in this record was run. It rests on a read of the repository and of Supabase's documentation. Every fact that was not observed on the hosted project is named as such, and work package 0 exists to observe it.

## Context

An organization can set three access controls: a second-factor requirement (`security.mfa_policy`), a session lifetime and idle timeout (`security.session_hours`, `security.idle_timeout_minutes`), and an IP allow-list (`app.org_ip_allowlist` with the switch `security.ip_allowlist`). Today the database only reports what an organization asks of a session (`app.my_org_auth_status`, `app.network_access`). The refusal happens in application code: Atlas on every page and server action, the XOS API before every handler, and Compass when a session starts or changes organization. The idle timeout exists only in Atlas, from a browser cookie. Gateway and Console check none of them.

Row-level security reads none of this. The policies on about a thousand tables rest on membership and capability helpers rooted in `auth.uid()`. So a call made straight to the Supabase data endpoint (PostgREST, Storage, Realtime) with a valid session token does everything the person's role allows in four cases where the apps would refuse:

1. a session without a second factor, of a member whose organization requires one (including a person who never enrolled one);
2. a session older than the organization's lifetime, for as long as its refresh token renews it;
3. a session idle longer than the organization allows;
4. a session signed out from another device, until its access token expires (up to 3,600 seconds);

and in a fifth: a caller outside the organization's allowed networks.

Five facts shape any fix.

- **First-party clients are direct callers.** Compass reads and writes through PostgREST, Storage and one Realtime channel (PowerSync is deferred and not in production). Atlas and Gateway hand the browser the access token for a Realtime socket (`GET /auth/realtime`). Routing everything through the API is not possible on Vercel functions for websockets and 6 MB upload chunks.
- **The database cannot tell our servers from anyone else.** Atlas, Gateway, Console and the XOS API call PostgREST from Vercel as the `authenticated` role with the person's own token and no caller address. The database sees Vercel's address for all of them.
- **A pre-request check exists for PostgREST only.** Supabase documents that `pgrst.db_pre_request` does not run for Storage or Realtime; there the check has to sit in row-level security. Realtime caches broadcast and presence authorization for the life of a connection and refreshes it only on join or a new token.
- **The caller's address is not established on hosted Supabase.** `private.request_ip()` reads the forwarded chain by a hop count that was only ever observed on the local stack (finding A69-002). Storage and Realtime are not documented to give the database any request header.
- **Compass treats refusals differently by shape.** Only HTTP 401, `PGRST301` and `PGRST303` make the sync engine halt and wait for sign-in. `XR001` and `42501` turn a queued offline write into a permanent conflict, and an error-free full pull that returns nothing makes the device delete its local rows (`packages/sync/src/conflict.ts`, `apps/compass/src/data/downloader.ts`).

Three designs were drawn and two adversarial reviews judged them. Both reviews chose the same base: a gate in the database that refuses a failing direct call as a whole, before any statement runs. This record takes that base and grafts the parts of the other two that the reviews found stronger.

## Decisions

### D1. One verdict, computed in the database, from the token and the session row

`private.session_verdict()` answers two things for the current token: whether the session itself is refused, and which organizations refuse it and why. Its inputs are the standard claims `aal`, `amr` and `session_id`, the `auth.sessions` row, one row of activity per session (`private.session_state`) and one row of rules per organization (`private.org_session_rules`, kept current by triggers on `app.setting_values`, plan features and `app.org_ip_allowlist`). The custom access token hook does not change. A claim stamped at issue was rejected because it is stale for a token lifetime and makes the hook a write path on every sign-in.

The session is refused as a whole (reason `session_ended`) when a person's token has no `session_id`, no `amr` timestamp or no live `auth.sessions` row. Missing claims fail closed. This also ends the hour in which a signed-out token still works.

For each organization where the caller is an active member, the session is refused when:

- `session_mfa_required`: `private.mfa_required(person, org)` and `aal` is not `aal2`;
- `session_expired`: the earliest `amr` timestamp plus the organization's `session_hours` has passed;
- `session_idle`: the longest gap between two activities of the session, or the time since the last one, exceeds the organization's `idle_timeout_minutes`. An activity is a recorded call (D5), `app.touch_my_session`, or a token refresh (`auth.sessions.refreshed_at`). The longest gap is kept, so activity after the timeout does not revive a session; only a new sign-in does;
- `network_restricted`: the organization enforces its allow-list, the caller's address (D4) is outside it, and the caller holds no open break-glass session at `aal2` (migration 1298).

An organization that set nothing gets the registry defaults, as Atlas applies them today: second factor optional, 336 hours, 60 minutes idle, allow-list off.

Who the verdict skips: `service_role` and requests with no token (Edge Function workers and pg_cron); `anon`; people who are not members of the organization (external collaborators reach rows through engagements, accounts, grants and shares). API keys, personal API tokens and OAuth app tokens are not sessions and stay exempt from the second-factor, lifetime and idle rules, as migrations 1330 and 1563 decided; the allow-list binds them (D4), and an OAuth app token also needs a live session row. Tokens minted by `integration-worker`, `integration-inbound` and `automation-run` carry a signed claim `xos_origin: worker` and skip the allow-list, because they act from Supabase's own network. `api-token` is public and never sets that claim.

The verdict is computed once per request. On PostgREST the pre-request function (D2) stores it in a transaction-local setting and every helper and policy reads that. On Storage and Realtime, which run no pre-request, the helpers compute it when the setting is absent, and policies read the refused set as `= any (array(select ...))`, the form `supabase/tests/0943_rls_benchmark_fixes.test.sql` already pins as one evaluation per statement. This matters because `private.person_capability_reach` runs per row through `has_capability`.

`app.my_org_auth_status` and `app.network_access` answer from the same verdict and gain `idle`, `network_allowed` and `blocked_reason`, so Atlas, the XOS API and Compass read one answer. Atlas's `xos-last-seen` cookie stops being the idle source. `private.require_second_factor` additionally requires a live session row.

### D2. PostgREST: a failing direct call is refused whole, with HTTP 401

`gate.pre_request()` is registered as `pgrst.db_pre_request` on the `authenticator` role. It lives in a new schema `gate` that is not exposed through the API and on which `anon`, `authenticated` and `service_role` hold usage. It cannot live in `private`: `0001_foundation.sql` line 37 revokes that schema from `anon` and `authenticated`, PostgREST calls the pre-request as the request role, and the lookup would fail for every request. pgTAP does not go through PostgREST and cannot catch that, so the registration is proven by a test over real HTTP (D8).

For `anon`, `service_role` and a request without a token the function returns before touching any table. For `authenticated` it distinguishes two kinds of call:

- **A direct call** carries no attestation (D3): Compass, a browser, a hand-made request, an API-key or OAuth token used directly. If the session is refused, or any organization the caller belongs to refuses it, the function raises SQLSTATE `PGRST` with HTTP status 401, code `XS401` and the reason as the hint. Nothing runs. The strictest organization governs the whole call on purpose: the pre-request runs before the target organization is known, about 100 security definer functions identify the caller without the shared helpers (a text match, not a proof), and refusing whole is the only form that leaves none of the roughly 1,065 `app` functions open. It matches the XOS API's rule for a request bound to no organization (A69-010). HTTP 401 is the one shape that released Compass builds treat as "halt and wait for sign-in": queued writes are held, and a refused pull is an error, never an empty snapshot.
- **A server-mediated call** carries a valid attestation. It is not refused whole. The helpers (D6) drop the refusing organizations, so a person in two organizations keeps the one whose rules the session meets, and Atlas, Gateway and the API refuse before the handler from the same verdict.

A refused session can still reach what it needs to recover: `app.my_session_gate()` (new: each of the caller's organizations by name, and the reason it is closed), `app.my_org_auth_status`, `app.network_access`, `app.redeem_recovery_code`, `app.touch_my_session`, `app.my_sessions`, `app.sign_out_my_session`, `app.sign_out_my_other_sessions`, the break-glass start function of migration 1298, `app.ensure_my_profile`, and the `api_public` schema. The function reads the schema from the profile header PostgREST itself uses for the request method (`Accept-Profile` for GET and HEAD, `Content-Profile` otherwise); a test holds that a mismatched pair does not pass. A session refused as a whole reaches `api_public` only.

### D3. Our servers prove themselves with a signed attestation

Atlas, Gateway, Console, the XOS API and the Edge Functions that act for a signed-in person send one header on every PostgREST call: the person's address as Vercel reported it (`clientAddress`, the reader trusted today), a timestamp, the session id, and an HMAC over them with a server-only key. The database verifies it (five-minute window, bound to the token's `sub` and `session_id`; two keys accepted during a rotation). `createCallerClient` in `packages/data/src/client.ts` is the one place that adds it. The key is `XOS_DATA_ATTEST_KEY` in the three Vercel projects and as a function secret, and in Vault for the database. If the build measures the Vault read above the budget in D9, the key moves to a table in `private` that only the verifier reads.

Whoever holds the key can make a direct call look server-mediated and attest any address for a session token they already hold. Row-level security and the per-organization filtering still apply to such a call. The attestation never grants an identity.

### D4. The caller's address: attested, or a network pass, or the edge once it is observed

The allow-list needs an address the caller cannot write. There are three sources, in this order.

1. **Attested address**: on server-mediated PostgREST calls, checked on every request. Exact.
2. **Network pass**: `private.session_state` holds the last address at which the session was seen by one of our servers, and when. It is written only from an attestation, passed either as the header or as a signed argument to `app.touch_my_session`, never from a value the client supplies. A session passes the allow-list when its pass is inside the list and no older than five minutes. Compass obtains its pass by calling the XOS API (`POST /api/v1/session/network-pass`), which sees the device's address through Vercel. Live pages and long uploads send a heartbeat so a passive screen does not lose its pass.
3. **Edge address**: `private.request_ip()` on a direct PostgREST request. It is used only after work package 0 has observed the hosted forwarded chain and set `xos.trusted_proxy_hops`. Until then `private.session_gate_config` keeps the address source at `pass`.

Storage and Realtime always use the pass, because Supabase documents no request header reaching the database there. If work package 0 finds a trustworthy header on Storage requests or on Realtime channel joins, that path moves to exact enforcement.

API-key and OAuth app tokens have no session to hold a pass. Used directly against the data endpoint for an organization that enforces an allow-list, they are refused while the address source is `pass`, and checked per request once it is `edge`. Through the XOS API they are checked on the attested address, as today.

### D5. Activity is recorded by the server, never claimed by the client

`private.session_state` (one row per session, removed with it) replaces the activity role of `private.session_devices`. The pre-request stamps it at most once a minute on read-write transactions; GET, HEAD and stable functions run read-only and cannot write, so a caller that only reads stays active through `app.touch_my_session` or through its token refresh. Released Compass builds never call touch; the Compass package adds it on foreground and on each sync cycle, and the minimum-version gate moves people to that build before the idle control is enforced (D7).

### D6. Helpers, Storage and Realtime

- **Helpers.** `private.my_org_ids()`, `private.my_membership_ids()` and `private.person_capability_reach()` exclude the refusing organizations; `has_capability`, `capability_reach`, `orgs_with_capability` and `project_ids_with` inherit that. Their current bodies stay as `*_base` twins, used only by the recovery functions of D2 and by the read policies on `app.organizations` and on the caller's own `app.memberships`, so `/auth/mfa`, `/auth/session-ended`, `/auth/network-restricted` and the Compass gate can still name the organization. A catalog test holds that nothing else references a twin.
- **Storage.** One restrictive policy on `storage.objects`, all commands, to `authenticated`: the object's organization (`private.storage_object_org(bucket_id, name)` over the 13 buckets) must not refuse the session, and for a bucket whose path carries no organization the session must be refused by none. This closes the person-keyed buckets that hold organization files (imports, upload staging, support screenshots, deletion certificates).
- **Realtime, Postgres Changes.** A restrictive select policy on every table in the `supabase_realtime` publication, null-safe on `org_id`. Realtime evaluates table policies for each change with the subscriber's claims, so the verdict applies per delivered change. The policy filters and never raises, because the effect of an exception on Realtime's change worker is not established.
- **Realtime, broadcast and presence.** The same test is added to the `realtime.messages` policies through `private.ensure_realtime_channel_policies`. Realtime evaluates it at join and on each new token only. The anonymous live-link and showcaller rules are untouched.
- **Gateway and Console.** Gateway refuses a member before the handler when the member's organization refuses the session, as Atlas does. Without that, the attested path would reach definer functions that check membership inline.
- **Signed links.** Onboarding-upload links drop from 3,600 to 300 seconds (`packages/data/src/vendors.ts`).

### D7. Rollout: off, then shadow, then on, per control and per organization

`private.session_gate_config` holds a mode for each of five controls (`ended`, `mfa`, `lifetime`, `idle`, `network`): `off`, `observe` or `enforce`. `private.session_gate_orgs` sets a mode for one organization and one control, which overrides the global one, so enforcement starts with named organizations (the owner's own first). Both are read on every evaluation; a change takes effect on the next request with no deploy.

- **Off** (how every migration ships): the verdict is empty, the helpers and policies behave as today, and the pre-request returns after one single-row read. The pre-request registration is its own migration, applied last, because it runs on every request from the moment it lands.
- **Observe**: nothing is refused. Each call that enforce would refuse writes one Postgres log line (`xos_session_gate`, with control, surface, organization and token type, and no personal data) and, on read-write transactions, a count in `private.session_gate_observations`.
- **Enforce**: per control, in this order: `ended`, `mfa`, `lifetime`, `idle`, `network`. Each needs at least seven days of observe on production showing no first-party path refused and no sign-in method issuing tokens without `session_id` or `amr` timestamps, then enforce on the canary organization, then everywhere. `lifetime` is announced first, because Compass sessions that have renewed past an organization's lifetime are refused the moment it turns on. `idle` and `network` wait for the Compass build and the raised minimum version.

The apps are compatible with mode off (the attestation is ignored, the new status columns read as passing), so the database and the apps release and roll back independently.

Switching off has three levels, none of which needs a deploy: one control (`update private.session_gate_config`); the PostgREST layer (`alter role authenticator reset pgrst.db_pre_request` and `notify pgrst, 'reload config'`); and full removal (a down migration drops the restrictive policies and restores the helper bodies from the twins). The second level is rehearsed on staging before the registration migration reaches production.

### D8. Lockout protection and recovery

- **Second factor.** Setting `security.mfa_policy` to `admins` or `everyone` requires the setter's own session at `aal2`, so at least one Owner holds a working factor. Enrollment and verification run on Supabase Auth, which the gate does not touch, and the recovery functions and organization-name reads use the ungated twins, so a member who never enrolled can still enroll and a member can still redeem a recovery code.
- **Lifetime and idle.** Signing in again always restores access. The floors stay at 1 hour and 5 minutes.
- **Allow-list.** The existing guards stay (no empty list, plan feature, no enabling from an uncovered address, no removing the last entry while enforced). Break-glass at `aal2` from outside the list is honored inside the verdict and its start function is reachable by a refused session.
- **Compass in the field.** Released builds receive HTTP 401, which they already hold on. The new build shows which organization refuses and why, checks the gate before uploading media, and treats a Storage 403 under a refused session as "halt", not as a conflict.
- **Support.** `private.session_gate_overrides` suspends one control for one organization for at most 24 hours. It takes a secret key, an actor and a reason, is written to the audit ledger, and notifies the organization's Owners.
- **The pre-request itself.** A defect in it is an outage of the whole data endpoint. It returns before any table access for `anon` and `service_role`, and level two of the switch-off removes it alone.

### D9. Performance budget

- Gate 17 stands: policy-filtered list queries under 50 ms at p95 on 1,000,000 rows, measured by `supabase/tests/0399_rls_benchmark.psql` with every control in enforce and a passing session. A plan-shape assertion in the style of 0943 holds that the refused set appears only as an InitPlan and that `person_capability_reach` reads the transaction-local verdict.
- The pre-request adds at most 3 ms at p95 to a PostgREST request in enforce (one session-state read, one `auth.sessions` read, the caller's memberships, one rules row per organization, one HMAC when attested, at most one single-row update a minute per session), and at most 0.5 ms in off. A new HTTP benchmark against a Postgres and PostgREST local stack measures both over 1,000 requests.
- Realtime evaluates the verdict per subscriber per change. The show-cue path is measured with 50 subscribers on one table before the Realtime package is enforced; the gate may add at most 5 ms at p95 to the policy check of one change for one subscriber.
- Creating a restrictive policy takes a brief exclusive lock. The Realtime installer applies one table at a time with `lock_timeout` and retries, outside show hours.

None of these was measured.

## What is closed, and where

"Closed" means enforced in the database on that path once the control is in enforce.

| Control                          | PostgREST, direct call                                                                      | PostgREST, through our servers  | Storage API                           | Realtime Postgres Changes             | Realtime broadcast and presence                   |
| -------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------- | ------------------------------------- | ------------------------------------------------- |
| Second-factor requirement        | Closed, every request                                                                       | Closed, per organization        | Closed, every call                    | Closed, every delivered change        | Checked at join and on each new token only        |
| Session lifetime                 | Closed, every request                                                                       | Closed, per organization        | Closed, every call                    | Closed, every delivered change        | Checked at join and on each new token only        |
| Idle timeout                     | Closed, every request, as time since the session's last recorded activity                   | Closed, per organization        | Closed, every call                    | Closed, every delivered change        | Checked at join and on each new token only        |
| Signed-out session               | Closed, next request                                                                        | Closed, next request            | Closed, next call                     | Closed, next delivered change         | Checked at join and on each new token only        |
| IP allow-list                    | Five-minute network pass; exact per request only after the hosted address chain is observed | Closed, exact, attested address | Five-minute network pass, never exact | Five-minute network pass, never exact | Five-minute network pass, at join and token renew |
| Allow-list for API keys and apps | Refused outright under `pass`; exact under `edge`                                           | Closed, exact                   | Refused for an enforcing organization | Refused for an enforcing organization | Refused for an enforcing organization             |

The idle timeout also becomes enforced in the XOS API and Compass for the first time, and the allow-list binds Compass for the first time.

## What stays open, and what the page must keep stating

1. **The allow-list is not exact on Storage and Realtime, and cannot be made exact on hosted Supabase as documented.** Those two services do not give the database the address of a request. There the rule is: the same session was seen inside an allowed network by Atlas or the XOS API within the last five minutes. A token in use inside the network can therefore also be used from outside it on Storage and Realtime, and on direct REST calls until the edge address is observed. A member with any device inside the network can keep the pass alive. The page must say so.
2. **Broadcast and presence rooms** (co-editing, presence, budget, show cues) re-check a session only when it joins and when its token renews. A session that stops meeting a rule keeps receiving on rooms it already joined for up to one token lifetime: 60 minutes today.
3. **Delete events.** Realtime does not apply row-level security to delete events; a connected session that is now refused can still receive the key of a deleted row.
4. **Bearer links.** Signed file links (at most 300 seconds after D6, and export links with their own lifetime) and single-use file-download tickets (2 minutes) work from any network and any session state until they expire. Profile media and organization brand assets are public.
5. **Idle means no recorded activity, not no human.** A client that keeps calling or refreshing stays active until the session lifetime ends. Only Atlas also measures human inactivity. The clock is one minute coarse.
6. **Apps and keys act without a second factor.** API keys, personal API tokens and OAuth apps have no second-factor, lifetime or idle rule. An OAuth app is a public PKCE client: a person whose own session an organization refuses for lack of a second factor can still obtain an app token where a consent already exists, limited to that one organization and the capability groups granted, never Restricted data. Whether this can be closed depends on a fact work package 0 reads (whether an app token's `session_id` names the authorizing session). Until it is closed the page must say that apps and keys act without a second factor.
7. **People who are not members** (external collaborators in Gateway and Compass, recipients of a grant or a share) follow no organization's second-factor, session or network rule. Only the signed-out check applies to them.
8. **A person's own rows with no organization** (profile, preferences, own notifications) follow the signed-out check on server-mediated calls. On direct calls the strictest organization still governs.
9. **Support access through Console** follows Console's own rules and access transparency, not the organization's allow-list or second-factor policy. How support sessions reach rows was not read for this record and is confirmed in work package 7.
10. **Server-mediated calls rest on a server-held key** (D3).
11. **Workers, pg_cron and worker-minted tokens** act for an organization from Supabase's network and are outside all the rules by design.
12. **Supabase Auth's own endpoints** (sign-in, refresh, factor enrollment and verification) are not the data endpoint. A refresh still succeeds for a session an organization refuses; the refusal happens at the data call.
13. **Anonymous links and screens** (live links, showcaller screens, `api_public` token functions, kiosk device keys) carry no session.
14. **PowerSync** is not in production. Its replication role bypasses row-level security and it accepts a token by signature alone. Turning it on is blocked until its authentication calls the verdict.
15. **One customer's rule can stop another customer's crew in Compass.** On direct calls the strictest organization governs, so a member of organizations A and B who is outside A's allowed networks, or cannot complete A's second factor in Compass (Compass verifies TOTP and recovery codes only), loses Compass for B too until that is resolved. External crew who are not members are unaffected. The alternative is in the owner decisions.

Not established, and each blocks the part named: the hosted forwarded chain and hop count (exact allow-list on direct REST); whether a custom header reaches `request.headers` through the hosted gateway (per-request attestation; the signed touch argument does not depend on it); whether SQLSTATE `PGRST` yields exactly HTTP 401 through the hosted gateway and supabase-js (Compass's safe behavior); whether every sign-in method issues `session_id` and `amr` timestamps (observe measures it); the claims of the three worker-minted tokens; the hosted Auth session settings.

## Build plan

Each package is built on its own branch, tested with pgTAP where it has a migration, and ships with every control off. A package owns the functions listed and no other package redefines them.

| #   | Package                         | Migrations (4.18)      | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                         | Depends on |
| --- | ------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 0   | Staging probe                   | none                   | A record in `infra/runbooks/hosted-security-settings.md`: the forwarded chain and `xos.trusted_proxy_hops`; custom header pass-through; request headers inside a `storage.objects` policy, a `realtime.messages` policy and a Postgres Changes evaluation; the 401 shape of SQLSTATE `PGRST`; the claims of an OAuth app token. Needs the owner's approval.                                                                                  | none       |
| 1   | Test identities                 | none                   | `supabase/tests/0200_identity_world.psql`: `pg_temp.as_user` and `as_user_stepped_up` create an `auth.sessions` row and set `aal`, `amr` and `session_id`; new `pg_temp.as_session`; the 75 suites that set claims themselves are reviewed. Lands alone, with the whole suite green, before any gate logic.                                                                                                                                  | none       |
| 2   | Gate core                       | 904180101 to 904180104 | Tables `private.session_gate_config`, `session_gate_orgs`, `session_gate_overrides`, `session_gate_observations`, `session_state`, `org_session_rules`; `private.session_verdict` and its readers; the attestation verifier; the `*_base` twins as new functions; `app.my_session_gate`, `app.my_org_auth_status`, `app.network_access`, `app.touch_my_session`, `private.require_second_factor`; the `aal2` guard on `security.mfa_policy`. | 1          |
| 3   | Gated helpers                   | 904180201              | `private.my_org_ids`, `private.my_membership_ids`, `private.person_capability_reach`; the read policies on `app.organizations` and own `app.memberships`.                                                                                                                                                                                                                                                                                    | 2          |
| 4   | PostgREST pre-request           | 904180301, 904180302   | Schema `gate`, `gate.pre_request()` (904180301); its registration on `authenticator`, alone (904180302); the HTTP test harness `infra/db/test/direct-endpoint.http.test.ts`.                                                                                                                                                                                                                                                                 | 2          |
| 5   | Storage                         | 904180401              | `private.storage_object_org`, policy `storage_objects_session_gate`; the 300-second cap in `packages/data/src/vendors.ts`.                                                                                                                                                                                                                                                                                                                   | 2          |
| 6   | Realtime                        | 904180501, 904180502   | The catalog-driven installer and the restrictive select policy on each published table (904180501); `private.ensure_realtime_channel_policies` (904180502).                                                                                                                                                                                                                                                                                  | 2          |
| 7   | Servers                         | none                   | `packages/data/src/client.ts` (attestation), `packages/data/src/auth-assurance.ts`, `apps/atlas/lib/auth/assurance.ts` and proxy (idle and network from the database, heartbeat, `/auth/realtime` refuses a refused session), Gateway's pre-handler refusal, Console's caller client; `XOS_DATA_ATTEST_KEY` in env files.                                                                                                                    | 2          |
| 8   | API and functions               | none                   | `packages/api/src/runtime/auth.ts` (idle and network reasons, touch as surface API, `POST /api/v1/session/network-pass`); `supabase/functions/_shared/sessions.ts` (gate check before the secret key in `storage-browse`, `search-embed`, `apple-revoke`, `wallet-pass`); the `xos_origin` claim in the three minting functions.                                                                                                             | 2          |
| 9   | Compass                         | none                   | `packages/sync/src/conflict.ts` (`XS401`), `apps/compass/src/runtime/assurance.ts` and provider (bootstrap from `app.my_session_gate`, touch on foreground and each sync cycle, network pass through the API), `apps/compass/src/data/uploader.ts` (gate before media, Storage 403 as halt), refusal screens, `private.client_minimum_versions` at rollout.                                                                                  | 2          |
| 10  | Benchmarks and the attack suite | none                   | `supabase/tests/904189901_direct_endpoint_attack.test.sql`, the 0399 run in enforce, plan-shape assertions, the pre-request HTTP benchmark, the Realtime fan-out measurement.                                                                                                                                                                                                                                                                | 3 to 6     |
| 11  | Documents                       | none                   | `legal/security-overview.md`, `infra/runbooks/hosted-security-settings.md`, this record's status, notes on ADR 0033, 0034 and 0055, the /security subject in `design/MARKETING_LOCKSTEP.md`, every generated file with a `check:` twin.                                                                                                                                                                                                      | rollout    |

Packages 3, 4, 5, 6, 7, 8 and 9 build in parallel once package 2's contract is merged: no two of them redefine the same function, policy or file. Package 2 is the only one that touches `app.my_org_auth_status`, `app.network_access`, `app.touch_my_session` and `private.require_second_factor`. Package 10 integrates. Estimated build: three to four weeks for the 4.18 train, then calendar time for observe, the Compass store release and enforcement control by control.

## Test plan

**The attacker's test.** `supabase/tests/904189901_direct_endpoint_attack.test.sql` and `infra/db/test/direct-endpoint.http.test.ts` are written in package 2, before the gate, and fail today. Each case signs in as a member of an organization that sets the rule and calls the data endpoint directly:

- an `aal1` session under `mfa_policy = everyone` reads a project list, inserts a record, calls a definer function that reads `app.memberships` inline (`app.workforce_directory`), reads and writes an object in the imports bucket, and joins a private channel;
- the same five actions with a session older than `session_hours`; with a session whose last activity is older than `idle_timeout_minutes`, including a touch sent after the timeout; with a session whose `auth.sessions` row was deleted, including a step-up function at `aal2`; and from an address outside the allow-list, with a session token and with an API-key token;
- a token with no `session_id` claim.

Today every case succeeds, so every assertion that it is refused fails. The cases land marked as expected failures (pgTAP `todo`), and each package removes the marks for what it closes: package 4 the PostgREST cases (HTTP 401, code `XS401`, the right hint), package 5 Storage, package 6 Realtime. Package 10 holds that no mark is left. The HTTP file repeats the PostgREST cases over a real PostgREST, because pgTAP cannot see the pre-request registration.

**pgTAP, per package.** The passes: an organization on defaults; `aal2`; break-glass at `aal2` from outside the list; a non-member; `service_role`; no token; an API key (exempt from three rules, bound by the allow-list); a worker claim; an attestation that is valid, expired, for another session, or signed with another key. Two organizations in one session: a direct call is refused when one refuses; an attested call returns only the admitting organization's rows. Recovery: a refused session reads its organization's name, `app.my_session_gate`, redeems a recovery code, starts break-glass, lists and signs out sessions. Modes: off changes nothing (the existing suites stay green), observe records and refuses nothing, an organization row overrides the global mode, an override suspends one control and expires. Catalog: every published table has the restrictive policy; `storage.objects` has it; only the listed functions and policies reference a twin; `private.request_ip` and the attestation verifier are the only readers of forwarding headers; `gate.pre_request` is executable by `anon` and `authenticated`; a profile-header mismatch does not reach the allow-list.

**Unit and end to end.** `packages/data` (attestation, `orgAuthDecision` with idle and network from the database); `packages/api` (idle and network refusals, the network-pass route); `packages/sync` (`XS401` with status 401 is `unauthorized`); Compass (a refused organization never reaches `session.replace`; queued writes with media halt); Playwright a77 and a99 (the redirect pages with a refused session, and a direct REST call from the page context for each rule).

**Staging, with approval.** The probe; then real tokens against REST, Storage (a TUS upload and a signed link) and Realtime (Postgres Changes and a private channel) for each control, inside and outside a listed network; a released Compass build and the new build against enforce; the level-two switch-off.

## What the Security Overview can say

The page changes only after the named control is in enforce on production and the staging checks passed, never at merge. Lines 39 and 40 keep their current text until then.

**After `ended` is enforced (packages 2 to 6):** "Each person sees where they are signed in and can sign out any other session or all of them at once. Atlas, Gateway, the XOS API and the underlying data endpoint stop accepting a signed-out session on its next request."

**After `mfa` and `lifetime` are enforced:** "Per-organization session lifetime and second-factor requirement: these are enforced in the database on every call to the underlying data endpoint (REST and Storage) and on every live update delivered, as well as in Atlas, the XOS API and Compass. A session older than the organization allows, or without the second factor it requires, reads and writes nothing in that organization until the person signs in again or verifies. Live presence and co-editing rooms check a session when it joins and when its token renews, so a change reaches them within 60 minutes. Apps and API keys an organization registers are not sessions and act without a second factor."

**After `idle` is enforced (needs packages 8 and 9 and the Compass minimum version):** add "The idle timeout is enforced the same way, in Atlas, the XOS API, Compass and on direct calls. Outside Atlas, idle means the session made no call for the time the organization allows; Atlas also measures inactivity in the browser."

**After `network` is enforced with the address source at `pass`:** "IP allow-lists. An organization's allow-list is enforced on every request through Atlas and the XOS API, for sessions, API keys and apps. Compass and direct calls to the underlying data endpoint (REST, Storage and Realtime) are accepted only for a session that Atlas or the XOS API saw inside the allowed networks within the last five minutes; API keys and apps cannot call that endpoint directly for an organization with an allow-list. Supabase does not give the database the address of each direct request, so a session in use inside the allowed networks can also be used from outside them on that endpoint. Signed file links work from any network until they expire, at most five minutes. People who are not members of the organization, and support access, are outside the allow-list."

**After the address source is `edge` (needs the probe to prove the chain):** replace the fourth sentence with "On the REST endpoint every direct request is checked against the list. On Storage and Realtime, Supabase does not give the database the address of each request, so a session in use inside the allowed networks can also be used from outside them there for up to five minutes."

The sentence "We plan to close this gap by routing all data access through the API" is removed at the first of these changes; this record replaces that plan. The page never says the allow-list is enforced on every direct request to Storage or Realtime.

## Alternatives rejected

- **Gate tokens** (the data endpoint accepts only 120-second tokens that Atlas or the API minted). Rejected: a token is issued even when every organization refuses the session, which leaves every definer function with an inline membership check and the person-keyed buckets open; it makes one Edge Function and one key a single point of failure for all data access; it has no per-organization rollout; and Realtime clients that miss a two-minute renewal are disconnected. Its two strongest ideas are kept: the address is attested by a server that sees it (D3, D4), and a refused session can ask which organization refuses it (D2).
- **Verdicts stamped in the token at issue.** Rejected: a refused organization's rows go missing without an error, which makes released Compass builds delete local data and turn queued writes into conflicts; a token without `session_id` is exempt, which fails open; the hook becomes a write path on every sign-in; and a 300-second token lifetime collides with Supabase Auth's per-address refresh limit. Kept from it: the verdict computed once per request into a transaction-local setting, and a token refresh counted as activity.
- **Routing all data access through the API** (the plan in ADR 0033). Rejected as the way to close the gap: Vercel functions cannot carry Realtime websockets or the upload chunks, and Compass would lose offline-first sync.
- **Supabase's own session time-box and inactivity timeout.** They are project-wide, not per organization, and are enforced only at the next refresh.
- **A restrictive policy on every table with `org_id`.** Rejected for this release: an exclusive lock on about 800 live tables for a path the pre-request already refuses whole. It is limited to the published tables, where Realtime needs it.

## Consequences

- Row-level security reads session state for the first time. The header of migration 1330 ("Row level security does not read these settings") stops being true when package 3 lands.
- The three helpers at the root of about a thousand policies are redefined. A defect there is a production-wide outage or leak; mode off, the benchmark and the full pgTAP run before each step are the guard.
- A new server secret exists and has to be created, stored in three Vercel projects, a function secret and Vault, and rotated.
- Compass needs a store release and a raised minimum version before `idle` and `network` are enforced.
- Customers who call PostgREST directly with an API-key token from outside their listed networks are refused once `network` is enforced.
- Hosted changes the owner makes, none of which this record makes: the staging probe, the Vault secret and Vercel variables, `xos.trusted_proxy_hops`, and any change to the token lifetime.

## Owner decisions needed

1. **Staging probe.** Approve creating and dropping one throwaway function on the staging project and sending a handful of requests (work package 0). Recommended: approve. Without it the allow-list on direct REST calls stays a five-minute pass and the Compass 401 behavior rests on documentation.
2. **Allow-list fallback.** If the probe does not prove the hosted address chain, accept the five-minute network pass as the allow-list on direct REST calls with the wording above (recommended), or refuse every direct REST call for an organization with an allow-list, which stops Compass for those organizations.
3. **Compass and the allow-list.** Strict: Compass is refused outside an organization's listed networks, cellular and venue Wi-Fi included, and the Security settings panel says so before the switch is turned on (recommended; an exemption cannot be enforced, because a caller declares its own surface). Or keep stating that Compass is outside the allow-list.
4. **Compass and the idle timeout.** The default is 60 minutes and Compass is offline-first. Enforce one value everywhere, so a device offline or unused for the organization's idle time signs in again (recommended), and decide separately whether to raise the default; or keep stating that the idle timeout applies to Atlas only.
5. **Several organizations on direct calls.** The strictest organization governs all of Compass for a person who is a member of more than one (recommended: complete, no function left open); or per-organization judgment, which needs an audit of about 1,065 functions and two to three more weeks.
6. **The attestation key.** Approve a new server-only key in the Atlas, Gateway and Console Vercel projects, as a function secret and in Vault (recommended), and say whether its rotation waits for 5.0 under the standing no-rotation decision.
7. **Token lifetime.** Keep 3,600 seconds and state 60 minutes for broadcast and presence rooms, or lower it to 900 seconds and raise the Auth token-refresh rate limit in the same change (recommended), which makes the page say 15 minutes.
8. **API keys and apps on direct calls.** Confirm that they become bound by the allow-list on the data endpoint, and are refused there outright for an organization with an allow-list while the address source is `pass`.
9. **Apps and the second factor.** If the probe shows an app token names its authorizing session, refuse an app token for an organization that requires a second factor the authorizing session did not meet (recommended); otherwise keep the sentence that apps and keys act without a second factor.
10. **Gateway, Console and external people.** Gateway refuses members whose organization refuses the session (in this plan). Confirm that external collaborators and Console support access stay outside organization rules and are named so on /security, or ask for a later package.
11. **Compass minimum version.** Raise it to the build with the refusal screens and the activity touch before `idle` and `network` are enforced.
12. **Wording.** Confirm that /security changes control by control, only after each is enforced and verified on production, with the residual sentences above.
