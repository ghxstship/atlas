---
title: XOS 4.0 Platform Threat Model
version: 1.0.0-draft
effective_date: The date this version is approved by the Owner
status: Draft for review before launch
audience: Internal; shared with customers and auditors under confidentiality
owner: A22 Security Review (RRR-41)
---

# XOS 4.0 Platform Threat Model

This model covers Atlas, Gateway, Compass, the public API and the Supabase back end as built on
main at the Wave 6 review (d36918a, with the fixes merged at 1a63487). It uses STRIDE per trust
boundary: Spoofing, Tampering, Repudiation, Information disclosure, Denial of service and Elevation
of privilege. Each boundary lists the threats that apply, the controls that answer them, the
evidence (a test or document), and the residual risk.

The design principle is that the database is the boundary (Section 3.15, ADR 0002). Every tenant
row is protected by row level security that calls helpers in `private`, every write path that
skips RLS is a SECURITY DEFINER function with its own checks and an empty search path, and every
other layer (Hono API, Next.js, Compass, MCP, Aurora) acts as the caller, so it can never grant more
than the database allows.

## Findings referenced

| Id      | Severity | Boundary                        | State    |
| ------- | -------- | ------------------------------- | -------- |
| A22-001 | High     | API key to api-token JWT        | Fixed    |
| A22-002 | High     | Compass offline sync            | Fixed    |
| A22-003 | Medium   | Tenant member to app            | Fixed    |
| A22-004 | Medium   | Storage buckets                 | Fixed    |
| A22-005 | Low      | Subprocessors (legal)           | Fixed    |
| A22-006 | Low      | Subprocessors (legal)           | Fixed    |
| A22-007 | Low      | Normalization (gate 29)         | Fixed    |
| A22-008 | Low      | Normalization (gate 29)         | Fixed    |
| A22-009 | Low      | Normalization (gate 29)         | Fixed    |
| A22-010 | Medium   | Tenant member to app            | Fixed    |
| A22-011 | Medium   | Storage buckets                 | Fixed    |
| A22-012 | Low      | API key to api-token JWT        | Fixed    |
| A22-013 | Low      | Service role and Edge Functions | Fixed    |
| A22-014 | Low      | Tenant member to app            | Fixed    |
| A22-015 | Low      | Integrations (OAuth)            | Accepted |

## Trust boundaries

1. Anonymous visitor to `api_public`
2. External party to `api_external`
3. Tenant member to `app`
4. API key to the api-token JWT
5. Service role and Edge Functions
6. Webhooks: Stripe, inbound email and kiosk punch
7. Compass offline sync: `apply_sync_mutation` and PowerSync
8. Integrations: Vault credentials, SCIM, SSO just-in-time joins and OAuth grants
9. Aurora AI: prompt injection, tool scopes and data exfiltration
10. Storage buckets

## 1. Anonymous visitor to api_public

Anon has USAGE only on `api_public`, `public`, `extensions` and `storage`. It reaches 21 reviewed
SECURITY DEFINER RPCs: token documents and agreements, advance packets, public profiles, brand
lookup, cookie consent, calendar feeds and certification verification.

| STRIDE | Threat                                                  | Control                                                                                                 | Evidence                                              |
| ------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| S      | Guessing a document, advance or agreement token         | Random tokens stored only as hashes; a separate access code; lockout after 5 failed codes               | 0769, 0430 and 0361 suites; `private.resolve_*_token` |
| T      | Writing tenant rows without a sign-in                   | No anon policies anywhere; anon has no USAGE on `app`; every anon RPC is SECURITY DEFINER with checks   | `9900_security_catalog.test.sql`                      |
| R      | Denying a signature                                     | Signer name, signed body SHA-256 and time are stored; no IP or user agent is captured (residual risk)   | 0361 and 0769 suites                                  |
| I      | Enumerating people or certifications                    | Profiles honor Public, Network and Private visibility; verification needs the holder's consent and code | 0860, 0352 and 0510 suites                            |
| D      | Flooding consent or verification RPCs                   | Per-IP failure limits on verification and kiosk PINs; platform rate limits at the edge                  | `private.rate_limit_exceeded`                         |
| E      | Reaching a privileged function through a new anon grant | The catalog test fixes the exact set of anon-callable functions                                         | `9900_security_catalog.test.sql`                      |

Residual risk: a GET through PostgREST runs read-only, so failed-attempt counters only advance on
POST. Lockout still holds for POST, which is the only path that can return data, so the risk is low.

## 2. External party to api_external

External users (Client, Vendor, Contractor, Crew, Staff, Artist, Artist Representative, Sponsor)
read through 69 owner-run, column-allowlisted views (ADR 0019). App-table read policies stay
internal-only except for tables with no internal columns.

| STRIDE | Threat                                                   | Control                                                                                                  | Evidence                                       |
| ------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| S      | Acting as another party                                  | Views filter by `auth.uid()` through `private.my_engagement_ids` and the Section 8.7 helpers             | 0750 and 0760 suites                           |
| T      | Writing through a projection                             | `api_external` views carry no INSERT, UPDATE or DELETE grant; writes go through checked RPCs             | `9900_security_catalog.test.sql`               |
| R      | Disputing a submitted document or rating                 | Engagement documents and ratings keep state transition ledgers and audit events                          | 0700 and 0740 suites                           |
| I      | Reading internal columns (margins, notes, Do Not Engage) | Column allowlists; internal-only columns never appear in a view                                          | 0750 suite; gate 24 crawl (A24)                |
| I      | Reading after the engagement closes                      | Time box by state: areas narrow at Complete and close 18 months later, except own tax forms and payments | 0761 suite                                     |
| E      | An external user reaching Atlas data                     | External role types are not org roles; anon and unrelated users read no view rows                        | 0750 suite; `9901_security_cross_tenant_reads` |

## 3. Tenant member to app

Signed-in members reach `app` under RLS: 481 tables, all with RLS on, and 1,135 policies built on
`private.has_capability`, `private.project_ids_with`, `private.orgs_with_capability` and the scope
helpers (ADR 0008, ADR 0016).

| STRIDE | Threat                                               | Control                                                                                                     | Evidence                                                              |
| ------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| S      | Using another member's session                       | Supabase Auth JWTs; same-origin check on cookie writes; MFA and step-up for billing, export, roles and keys | `packages/api/test/security/auth-attacks.test.ts`; A02 and A30 suites |
| T      | Writing into another tenant                          | RLS on every table; `org_id` derived by trigger; cross-org references refused                               | `9902` and `9903` security suites                                     |
| T      | A lower band writing (Viewer, Collaborator, Field)   | Capability reach (own, assigned, organization) checked in every write policy and RPC                        | `9904_security_viewer_band`; `9907` (A22-003); 0205 and 0400 suites   |
| R      | Denying an action                                    | Append-only audit ledger with 7-year retention; domain events written only by triggers                      | 0501 suite                                                            |
| I      | Reading another tenant's rows                        | RLS read policies; owner-rights views limited to reference, masking and self-filtering views                | `9901` security suite; `9900` view allowlist                          |
| I      | Reading Restricted columns (pay, bank, tax, medical) | Column SELECT revoked; reads through `*_masked` views that check the restricted-read capability             | `9900` masking assertion; 0363 suite                                  |
| D      | Expensive list queries starving the database         | Indexed policy columns; gate 17 benchmark under 50 ms at p95 on 1,000,000 rows                              | `0399_rls_benchmark.psql`; 0943 suite                                 |
| E      | Granting oneself a role or capability                | Granting limits (own band and below, capabilities held); separation of duties; at least one Owner kept      | 0206 suite                                                            |
| E      | A SECURITY DEFINER function without its own check    | Empty search path on every function; reviewed list of anon RPCs; static triage of every org-scoped RPC      | `9900`; review notes below                                            |

Review notes: every one of the 268 SECURITY DEFINER functions in `app` that authenticated may
execute was triaged for an explicit person, membership or capability check. Six had no such check in
their own body; each was read and found to delegate to a checked function or to read only rows the
caller already holds (`preview_invite`, `poll_results`, `organization_verified`,
`request_engaged_guest`, `engaged_guest_list` and the five-argument `create_api_key`, which a
trigger guards).

## 4. API key to the api-token JWT

Servers call `/api/v1` with `Authorization: Bearer xos_live_...`. The runtime exchanges the key at the
`api-token` Edge Function for a five-minute JWT whose subject is the key's service account.

| STRIDE | Threat                                         | Control                                                                                                           | Evidence                                     |
| ------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| S      | Guessing a key                                 | 192-bit random secret; only the SHA-256 hash and a 17-character prefix are stored                                 | 0921 suite                                   |
| T      | Binding a key to another org's service account | `t21_guard_api_key_service_account` refuses it                                                                    | 0922 suite                                   |
| R      | Untraceable key use                            | `last_used_at`, the key id and service account id in every minted token, and the service account's audit identity | 0922 suite                                   |
| I      | A scoped key reading outside its scopes        | The database applies the token's scopes (A22-001, fixed in 0936); the runtime `assertScope` is a second layer     | `9905` (A22-001); `contract-attacks.test.ts` |
| D      | Replaying exchanges                            | Exchanged tokens are cached per key for their lifetime; rate limits per key                                       | `auth-attacks.test.ts`                       |
| E      | A key exceeding its service account's role     | The account's membership and role bound every token; Owner is refused for service accounts                        | 0922 suite                                   |

The default rate limiter counts in Postgres (`app.take_api_rate_limit`, migration 1040), shared by
every instance, with the in-process limiter as the fallback (A22-012, fixed).

## 5. Service role and Edge Functions

The service role bypasses RLS. It is held only by Edge Functions and pg_cron workers, never by the
API runtime or a browser (`packages/api/src/runtime/auth.ts` builds every client with the caller's
token).

| STRIDE | Threat                                       | Control                                                                                                        | Evidence                                   |
| ------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| S      | Calling a worker function without the secret | Worker functions require a bearer secret compared in constant time (`_shared/runtime.ts` `hasBearer`)          | Function source review                     |
| T      | Service-role writes skipping tenant rules    | Functions call checked RPCs (`kiosk_punch`, `exchange_api_key`, `unsubscribe_by_token`) rather than raw tables | 0592, 0922 and 0520 suites                 |
| I      | Error detail leaking internals               | Unhandled errors return a 500 problem with only a request id; the error is logged through the redactor         | `packages/platform/test/failure.test.ts`   |
| E      | Service role key exposure                    | Keys only in Supabase and Vercel encrypted environment variables; gitleaks in CI; no key in the repository     | gitleaks scan of the tree (no leaks found) |

`_shared/runtime.ts` `serve` returns a request id and logs the error server side (A22-013, fixed).

## 6. Webhooks: Stripe, inbound email and kiosk punch

These Edge Functions run with `verify_jwt = false` and authenticate another way.

| Function            | Authentication                                                                                   | Replay and abuse control                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `stripe-webhook`    | Stripe signature over the raw body with `STRIPE_WEBHOOK_SECRET`; invalid signatures answer 400   | Each event id is stored once in `app.stripe_events`; livemode is checked against the key |
| `inbound-email`     | Bearer `XOS_INBOUND_SECRET`, constant-time compare; replies only from signed addresses with DKIM | Message id deduplication; quoted text stripped                                           |
| `email-unsubscribe` | HMAC signature per org, person and category, checked in `app.unsubscribe_by_token`               | Idempotent suppression insert                                                            |
| `kiosk-punch`       | Device key (hashed) plus member PIN, checked in `app.kiosk_punch`                                | 20 PIN failures per device key per 15 minutes; punch id idempotency                      |
| `api-token`         | The API key itself                                                                               | See boundary 4                                                                           |

STRIDE notes: spoofing is answered by the signatures and secrets above. Tampering and replay are
answered by event and punch id deduplication. Repudiation is answered by stored Stripe events and
punch ledgers. Residual risk: a stolen kiosk device key allows a slow PIN search across every member
of the device's org. Per-member lockout is recommended in addition to the per-device limit.
Unsubscribe by GET is honored for one-click links; mail scanners that prefetch links can trigger it.

## 7. Compass offline sync

Devices queue mutations offline and replay them through `app.apply_sync_mutation`, which calls only
RPCs listed in `private.sync_rpcs`. PowerSync streams rows filtered by `private.sync_scope_grants`.

| STRIDE | Threat                                         | Control                                                                                                  | Evidence                                      |
| ------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| S      | Replaying another person's mutation id         | A stored mutation id is bound to its person and RPC; a mismatch is refused                               | 0364 suite                                    |
| T      | Replay running with the owner's rights         | Every replayable RPC is SECURITY DEFINER with its own checks; `sync_call` refuses invoker RPCs (A22-002) | `9906` (A22-002); 0935 suite                  |
| R      | Losing the record of what a device did         | `app.sync_mutations` keeps each result with device id and person                                         | 0364 suite                                    |
| I      | A device storing another party's rows          | Sync scope grants mirror the RLS helpers, refreshed by triggers and nightly                              | 0942 and 0944 suites; `infra/powersync` tests |
| D      | A device flooding replays                      | Advisory lock per mutation id; idempotent results                                                        | 0364 suite                                    |
| E      | Replaying an RPC that is not meant for devices | Allowlist in `private.sync_rpcs`; unknown arguments refused                                              | 0364 and 0935 suites                          |

## 8. Integrations: Vault, SCIM, SSO and OAuth

| STRIDE | Threat                             | Control                                                                                                    | Evidence                      |
| ------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------- |
| S      | A forged SCIM or SSO identity      | Just-in-time joins need an SSO session; SCIM tokens are stored as prefixes and hashes                      | 0638 suite                    |
| T      | Provider data overwriting XOS work | Inbound changes never delete XOS work; deletions re-place or report (ADR 0024)                             | 0600 to 0636 suites           |
| I      | Reading integration credentials    | Secrets only in Supabase Vault; only the service role reads them through `app.read_integration_credential` | `9900` service-role assertion |
| I      | Secrets in connector settings      | `provider_settings` is documented as never holding secrets, and connectors validate it                     | 0600 suite                    |
| E      | SSO or SCIM granting Owner         | SSO and SCIM never grant Owner; SCIM deprovisioning ends the membership and opens offboarding              | 0638 suite                    |
| E      | An OAuth app exceeding its consent | OAuth scopes map to capability groups; grants are recorded per app and person                              | 0638 suite                    |

Residual risk: the OAuth 2.1 authorization and token endpoints are not built yet (ADR 0024). Until
they are, OAuth grants cannot be exercised end to end, and ASVS V10 requirements are marked as gaps.
The docs no longer advertise the endpoints; the frozen OpenAPI `oauth2` scheme stays until the server
exists (A22-015, accepted). Scopes and SCIM groups are stored as arrays, registered in the
denormalization register (A22-009, fixed).

## 9. Aurora AI

Aurora answers questions by calling `list_records` and `get_record` through the public API as the
person asking, and proposes changes that the person confirms (`packages/ai/src/features/assistant.ts`).

| STRIDE | Threat                                       | Control                                                                                       | Evidence                     |
| ------ | -------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------- |
| S      | A prompt in record data posing as the person | Record data is wrapped as data blocks; the model can only propose changes, never apply them   | A25 evals; `assistant.ts`    |
| T      | Injected instructions causing writes         | `propose_change` returns a proposal the person reviews; no write tool exists                  | `assistant.ts` tool list     |
| I      | Reading beyond the caller's rights           | Every read goes through `/api/v1` with the caller's credential, so RLS and scopes apply       | `assistant.ts` `runRead`     |
| I      | Reaching collections outside the allowlist   | Paths must match the configured collections; ids must be UUIDs; never-send tables are refused | `assistant.ts` input schemas |
| I      | Restricted or medical data sent to the model | Never-send list (`app.ai_never_send`) and record scrubbing before any model call              | A25 redaction evals          |
| D      | Exhausting the plan allowance                | Per-org advisory lock and monthly request limit in `app.ai_begin_request`                     | 0650 suite                   |
| E      | The model widening its own tools             | Fixed tool set; at most 8 turns; writable operations listed by the caller                     | `assistant.ts`               |

The MCP server follows the same rule: every call goes through `/api/v1` with the operator's key, write
tools appear only for resources or modules named with `--write`, and delete also needs
`--allow-delete` (ADR 0024, `packages/mcp/src/tools.ts`).

## 10. Storage buckets

| Bucket               | Public | Write rule                                                                                                                                                                              |
| -------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attachments`        | No     | `private.attachment_upload_allowed`; reads follow the subject's RLS                                                                                                                     |
| `field-media`        | No     | `private.field_media_allowed`                                                                                                                                                           |
| `onboarding-uploads` | No     | `private.onboarding_upload_writable`; reads by the party and the org                                                                                                                    |
| `org-brand`          | Yes    | Service role only: the scan worker publishes Clean staged files                                                                                                                         |
| `profile-media`      | Yes    | Service role only: the scan worker publishes Clean staged files                                                                                                                         |
| `upload-staging`     | No     | The target bucket's rule: `org.white_label.write` on the org in the path for `org-brand`, the person's own folder or an org profile editor for `profile-media`; only the uploader reads |

| STRIDE | Threat                                            | Control                                                                  | Evidence                     |
| ------ | ------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------- |
| T      | Writing into another tenant's folder              | Policies resolve the org or person from the first path segment           | 0590 and 0860 suites         |
| I      | Active content served inline from a public bucket | Public buckets refuse SVG, HTML, XML and script (A22-004, fixed in 0938) | `9908` (A22-004); 0938 suite |
| D      | Oversized uploads                                 | Per-bucket size caps (2 MB to 50 MB) and type allowlists                 | `9908` control assertion     |

Uploads are sniffed and scanned by the `upload-scan` worker; private buckets serve only Clean files to
anyone but the uploader (A22-011, fixed in 1041). The imports and support-screenshots buckets are
scanned too, and an import is parsed only once its file is Clean (1240). The scanner is self-hosted
ClamAV (ADR 0034). Residual risk: without a reachable clamd, `upload-scan` claims nothing and files stay
quarantined. Public buckets cannot gate reads, so since migration 1265 nobody signed in writes them: a
file for `org-brand` or `profile-media` is uploaded to the private `upload-staging` bucket under the
target bucket's rules, and the worker publishes it only once it scans Clean. An infected file is never
public (ADR 0034 amendment, `1265_public_upload_staging` suite).

## Review method

- Catalog-generated pgTAP: `supabase/tests/9900` to `9908`.
- API attack tests: `packages/api/test/security`.
- Manual review of every SECURITY DEFINER function, Edge Function, the API runtime, Aurora and MCP.
- Secrets: gitleaks over the tree found no leaks. Supply chain: every dependency in every
  `package.json` and `supabase/functions/deno.json` is pinned exactly, and every GitHub Action is
  pinned to a commit SHA.
- New attack reproductions go in `supabase/tests/security/*.attack.psql` and run with
  `supabase/tests/security/run-attacks.sh`.
