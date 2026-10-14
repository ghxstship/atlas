# ADR 0021: Conventions for Running Agents in Parallel

- Status: Accepted
- Date: 2026-10-14
- Decider: Orchestrator

## Context

Waves 3 to 5 run more than twenty agents at once. They share four files that every module touches: the message catalog, the list of hand-written Atlas pages, the demo seed and the API handler mount. Shared lists would cause a merge conflict on every branch. The local Docker VM also limits how many full Supabase stacks can run at the same time.

## Decision

1. **Message catalogs.** There is one file per namespace in `packages/i18n/messages/<locale>/<namespace>.json`. Running `pnpm --filter @xos/i18n generate:catalogs` writes `src/catalogs.generated.ts`. An agent adds its own namespace files, in en-US and es-US, and runs the generator. On a merge conflict in the generated file, rerun the generator.
2. **Hand-written Atlas pages.** These are listed in `apps/atlas/ia/implemented/<owner>.txt`, one node id per line, and read only at build time by `ia/implemented.ts`. Each module agent owns one file named after its module group, for example `projects.txt`.
3. **Demo seed.** Seed files live in `supabase/seeds/NNNN_<owner>.sql` and load in file name order. Numbers and fixed demo ids are listed in `0000_demo_tenant_conventions.sql`.
4. **API handlers.** A04 defines the handler seam: per-module handler files under `packages/api/src/handlers/`, collected into a generated index. Module agents write their handlers there once the seam has merged. Until then they build repository functions in `packages/data/src/<module>.ts`, the UI and the tests.
5. **Local databases.**
   - An agent with its own migration range runs its own Postgres-only stack, started with `supabase start -x gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor`. Each stack gets its own `project_id` and port block, set in the agent's uncommitted `supabase/config.toml`.
   - Agents without migrations share the orchestrator's stack `xos4-shared` on ports 560xx. They never reset it. The orchestrator resets it after merging migrations and tells the agents.
6. **Generated files.** `database.types.ts`, `openapi/v1.json`, `plans.generated.ts`, `catalogs.generated.ts` and the generated route pages are never resolved by hand. On a conflict, take either side and rerun the generator.
7. **The finish guard** skips files that are deleted on disk but whose deletion is not yet staged.

## Consequences

- Module branches merge without conflicts in shared lists. The orchestrator regenerates derived files after each merge.
- Schema changes a module needs outside its owner's range go through the orchestrator to the range owner (Section 19.4).
