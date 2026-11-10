# ADR 0168: Supabase's Publishable and Secret Keys, and No Legacy Key

- Status: Accepted
- Date: 2026-11-09
- Decider: the owner ("make sure we are not using any legacy key types for supabase", 2026-11-09)
- Addresses: the production worker schedules answering 401 since 4.8; RRR-243
- Migrations: 904090001 (release 4.9, block 00: a fix made ahead of the train; ADR 0022)
- Amends: ADR 0033, decision 44 (the key rotation at cutover)

## Context

Supabase replaced the JWT-based `anon` and `service_role` API keys with publishable (`sb_publishable_...`) and secret (`sb_secret_...`) keys. The new keys can be created, named and revoked one at a time. The legacy keys are all signed by the project's shared JWT secret. Supabase stops the legacy keys at the end of 2026.

Production already ran on the new keys almost everywhere. Atlas, Gateway and the console hold the publishable key in `SUPABASE_ANON_KEY`, on production and on the staging branch. No Vercel project holds a secret key. Of the platform's function secrets, `SUPABASE_ANON_KEY` holds the publishable key, and `SUPABASE_SERVICE_ROLE_KEY` is not the legacy JWT (the workers' 401s below prove it). Two places still depended on a legacy key:

- **The worker schedules.** pg_cron sends the key in Vault (`xos_worker_key`) to the workers. That key was the legacy `service_role` JWT, sent as `Authorization: Bearer`, because a function with `verify_jwt` on admits only a JWT. The workers compared it with `SUPABASE_SERVICE_ROLE_KEY`, which on production is a secret key, so every scheduled worker answered 401. That covers webhooks, notifications, upload scans, reports, imports, integrations, sub-processor notices, automations, search embeddings, exports, guest email, exchange rates and weather.
- **Function code** read the legacy-named variables, which work only while the platform keeps filling them.

Supabase's guidance is to send a secret key on the `apikey` header, never as a bearer. Platform `verify_jwt` cannot check the new keys, so such a function turns it off and authorizes the request in its own code.

## Decisions

### D1. The functions read only the new keys

`supabase/functions/_shared/api-keys.ts` reads `SUPABASE_SECRET_KEYS` and `SUPABASE_PUBLISHABLE_KEYS`, JSON objects of key name to key. A function calls Supabase with the `default` key of each. `serviceDb()`, `secretKey()` and `publishableKey()` in `_shared/runtime.ts` go through it. No function reads `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_ANON_KEY`, and a test fails if one does (`packages/platform/test/api-keys.test.ts`).

The local CLI stack (CLI 2.x) gives its functions only the legacy-named variables, holding its well-known development keys. Outside production a function falls back to those. `XOS_ENVIRONMENT=production` turns the fallback off, so production cannot quietly run on a legacy key.

### D2. The workers take a secret key on the apikey header

Every worker runs with `verify_jwt = false` (`supabase/config.toml`). Each one answers 401 before doing any work unless the request carries one of the project's secret keys, compared exactly and in constant time. The key normally comes on the `apikey` header; the same key as a bearer is also accepted. Every secret key the project has is accepted, so a key made only for the workers can be revoked on its own. No claim in a token is trusted.

Two shortcuts were rejected. Keeping `verify_jwt` on and trusting the role claim of the legacy JWT depends on the legacy key. Comparing against the legacy key keeps it alive.

`search-embed` also serves a person's search. That path passes the person's session to PostgREST, which verifies it, so turning `verify_jwt` off adds no access.

### D3. One request builder in the database

`private.worker_request(function, timeout)` posts `{}` to a worker at the functions URL in Vault (`xos_functions_url`). It sends the Vault key (`xos_worker_key`, now a secret key) on the `apikey` header and never sends an `Authorization` header. Without either Vault secret it sends nothing. The four schedules that migrations make (exchange rates, exports, guest email, weather) and the workers an operator schedules by hand all call it. The pgTAP suite `904090001_workers_use_secret_keys` holds this.

### D4. The legacy keys are deactivated, not rotated

Once `xos_worker_key` holds a secret key, nothing reads the legacy keys. The owner deactivates them under Settings, API Keys. That can be undone and signs no one out. From then on, rotating an API key means making a new one, putting it where the old one was, and deleting the old one.

### D5. What still rests on the JWT secret

Sessions are still signed with the project's shared JWT secret. So are the short-lived tokens that `api-token`, `integration-worker` and `automation-run` mint (`XOS_API_JWT_SIGNING_KEY`). Moving those to Supabase's JWT signing keys is a separate migration and a rotation, which the owner holds until 5.0. Until then, `XOS_API_JWT_SIGNING_KEY` stays unset in production, so the public API's token exchange is not live. Setting it to the shared secret would add a new dependency on the legacy secret.

## Consequences

- Production needs one owner step: a secret key in Vault (`xos_worker_key`), made under Settings, API Keys, ideally named `workers`. The hand-made schedules then call `private.worker_request`.
- `report-run` also stops failing at load. It imported two names its bundle does not export, so it never booted. `packages/platform/test/edge-imports.test.ts` now checks every function's imports against its bundle, because CI has no Deno step.
- CI and local scripts still read the local stack's legacy development keys from `supabase status`. They move to its publishable and secret keys with the Supabase CLI 3 migration.
