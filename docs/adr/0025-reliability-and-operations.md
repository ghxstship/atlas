# ADR 0025: Reliability and Operations

- Status: Accepted
- Date: 2026-10-16
- Decider: Orchestrator

## Context

A26 built the reliability stack under `infra/`: observability, synthetic checks, the status page, progressive delivery, backup and restore drills, partition proposals and the PowerSync service setup. This ADR records the choices that later work depends on.

## Decision

1. **One redactor for all telemetry.** Every log, trace and error goes through one dependency-free redactor that runs on Node, Edge and Deno (`infra/observability`). UUIDs are kept because they are pseudonymous and needed for incident response. Sentry keeps only the user id, and Session Replay stays off.
2. **Sentry is both error sink and tracer.** Sentry 11.5.0 reports errors and also provides traces, through the pinned `@opentelemetry/api` 1.9.1. This adds no further dependencies, and it fits Sentry's free Developer plan.
3. **Feature rollouts use A18's flags.** There is no second flag system.
   - A rollout stage is a cohort of per-org overrides whose reason starts with `rollout:<flag>:`.
   - An org's cohort comes from a SHA-256 of the flag and org id. TypeScript and SQL compute it identically, and shared test vectors check that they match.
4. **Deployments roll out in stages.** A pure release gate runs stages at 5, 25 and 100 percent.
   - A stage holds until it has served 200 requests and passed its bake time.
   - It rolls back on an error rate above 2 percent, on an error regression, or on a p95 regression above 800 ms.
5. **Partitioning by `created_at`.** `time_entries` and `access_scans` are proposed for partitioning on `created_at`, which never changes.
   - The tables that reference `time_entries` get a trigger-filled `time_entry_created_at` column and a composite foreign key.
   - The SQL is in `infra/db/proposals`. It goes into a post-late migration range after Wave 6, because late slots (0940 and up) still alter `time_entries`.
6. **PowerSync publication.**
   - It publishes through the partition root.
   - It uses a replication role with no password.
   - The published table list is generated from `packages/sync/sync-rules.yaml`.
   - The readiness check runs in CI with `continue-on-error` until the sync rules are fixed (RRR-76).
7. **Status page on GitHub Pages.** Static pages are served from GitHub Pages, and their history lives on a `status-data` branch. The page uses no JavaScript and does not auto-refresh.
8. **Recovery targets.**
   - The RPO is 1 hour, which depends on point-in-time recovery.
   - The RTO is 4 hours. The first drill restored and verified in 31 seconds.

## Consequences

- **Owner approvals:** point-in-time recovery, log drains, synthetic checks every minute from five regions, production PowerSync hosting, and Vercel Rolling Releases unless the current plan includes them.
- **Owner inputs:** the public backup key, the `STAGING_DB_URL`, synthetic-user and alert-webhook secrets, the PowerSync image pin in ADR 0001, and EU-region backup storage.
- **Wiring still to do:** Atlas and Gateway still need `@sentry/nextjs` and `@opentelemetry/api` wired in as described in `infra/observability/README.md`.
- **CI snippets:** the snippets in `infra/ci/README.md` are applied once their secrets exist.
