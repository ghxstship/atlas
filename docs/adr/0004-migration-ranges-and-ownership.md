# ADR 0004: Migration Ranges and Path Ownership

- Status: Accepted
- Date: 2026-10-08
- Decider: Orchestrator (Wave 0)

## Context

Section 19 runs up to 31 agents in parallel worktrees. Collisions are prevented by giving each agent a path set and a migration number range (Section 19.4).

## Decision

### Migration files

- Files are named `NNNN_snake_case_description.sql` in `supabase/migrations`. The four-digit prefix is the Supabase migration version, so lexical and numeric order agree.
- A migration may depend only on objects created by lower-numbered migrations. When an agent needs an object from a higher range, it requests the change from that range's owner through the orchestrator.
- Migrations are forward-only, commented and idempotent where feasible. Applied migrations are never edited; fixes ship as new migrations in the same range.

### Ranges

| Range        | Owner                               | Contents                                                                    |
| ------------ | ----------------------------------- | --------------------------------------------------------------------------- |
| 0001 to 0099 | Orchestrator                        | Foundation: schemas, extensions, `private.uuid_v7()`                        |
| 0100 to 0199 | A01 Canon                           | `xpms` schema, canon seed, Standard Library, Production Template            |
| 0200 to 0299 | A02 Platform Data                   | Tenancy, identity, access, `private` helpers, platform RLS                  |
| 0300 to 0499 | A03 Domain Data                     | Record spine and domain tables, invariants                                  |
| 0500 to 0599 | A18 Platform Services               | Billing, notifications, jobs, imports, reports, search                      |
| 0600 to 0649 | A19 Integrations                    | Integration framework and connectors                                        |
| 0650 to 0699 | A25 AI Features                     | AI settings, requests, suggestions, usage                                   |
| 0700 to 0799 | A28 Engagements and Marketplace     | External identity, opportunities, applications, engagements, `api_external` |
| 0800 to 0849 | A29 Workforce Suite                 | Feed, groups, chat, training, forms, polls, help desk, on-site operations   |
| 0850 to 0899 | A30 Identity, Profiles and Settings | Identity model, profiles, settings registry                                 |
| 0900 to 0999 | Orchestrator                        | Reserved for contract corrections after the freeze                          |

pgTAP suites in `supabase/tests` use the same four-digit prefix as the migration they cover.

### Path ownership

| Paths                                                                                               | Owner                                                                          |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Root configuration, `.github/`, `turbo.json`, `pnpm-workspace.yaml`, `packages/config`, `docs/adr/` | Orchestrator                                                                   |
| `canon/`                                                                                            | A01                                                                            |
| `packages/schemas`, `packages/api`                                                                  | A04                                                                            |
| `design/`, `packages/tokens`, `packages/ui`, `packages/ui-native`, `packages/icons`                 | A05                                                                            |
| `apps/atlas` shell, `apps/atlas/ia/sitemap.yaml`                                                    | A06                                                                            |
| `apps/atlas/app/(modules)/*`                                                                        | A07 to A16 per Section 19.3                                                    |
| `apps/compass`, `packages/sync`                                                                     | A17                                                                            |
| `packages/email`, Edge Functions                                                                    | A18                                                                            |
| `packages/sdk-ts`, `apps/docs`                                                                      | A20                                                                            |
| `legal/`                                                                                            | A21                                                                            |
| `packages/ai`                                                                                       | A25                                                                            |
| `infra/`                                                                                            | A26                                                                            |
| `apps/gateway`, `apps/gateway/ia/sitemap.yaml`                                                      | A27                                                                            |
| `packages/i18n`                                                                                     | Orchestrator holds the structure; each agent adds keys under its own namespace |
| `packages/testing`                                                                                  | A24                                                                            |

Generated files (database types, OpenAPI document, SDKs, navigation output) belong to no agent. CI regenerates them.

## Alternatives considered

- Timestamp-prefixed migrations: rejected, because parallel worktrees would interleave unrelated agents' migrations and hide range ownership.

## Consequences

The orchestrator checks every pull request's migration numbers against this table before merge.
