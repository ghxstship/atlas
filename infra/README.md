# infra: the XOS reliability stack (A26)

Section 5.1 (global performance and reliability), Section 9 (operations) and Section 14 (backup, retention, incident response), as code, scripts and runbooks. Nothing here changes a live Vercel or Supabase setting. Each directory lists the settings the orchestrator applies.

| Directory        | What it holds                                                                                             | Entry point                                |
| ---------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `observability/` | Structured logs, OpenTelemetry tracing and Sentry error reporting, all through one personal data redactor | `observability/README.md` (wiring per app) |
| `synthetics/`    | Read-only checks for sign-in, Gateway, the API, Realtime, Compass sync and notifications                  | `pnpm --filter @xos/infra synthetics`      |
| `status/`        | The public status page (static HTML, en-US and es-US) and the incident list                               | `pnpm --filter @xos/infra status:build`    |
| `delivery/`      | Progressive delivery: feature rollouts on A18's flags and the deployment release gate                     | `runbooks/progressive-delivery.md`         |
| `drills/`        | Backup and restore drills against a local Docker stack only                                               | `runbooks/backup-and-restore.md`           |
| `db/`            | Partitions: what is converted (1510, 1511) and the `time_entries` proposal with its precondition          | `db/README.md`                             |
| `security/`      | Supply chain and security checks: Semgrep, audit, licenses, SBOM, action pins, advisors, ZAP baseline     | `security/README.md`                       |
| `powersync/`     | PowerSync service configuration, local stack and readiness check for Compass sync                         | `powersync/README.md`                      |
| `ci/`            | Reusable CI scripts and the exact workflow snippets for the orchestrator                                  | `ci/README.md`                             |
| `production/`    | Demo-data removal before promoting staging to production, its row-count comparison and storage step       | `runbooks/promote-to-production.md`        |
| `runbooks/`      | Production deploys and rollback, incident response, backup and restore, progressive delivery              | `runbooks/production.md`                   |

## Cost rules

Everything runs on free tiers or on plans already paid for:

- **GitHub Actions and Pages.** Free for a public repository: synthetics every 5 minutes, the status page and the weekly backup.
- **Sentry Developer plan.** Free: errors and a 5 percent trace sample.
- **Vercel and Supabase logs.** Included in the current plans.

Three Section 5.1 and Section 9 targets need paid services, so they are blocked items, not assumptions:

1. point-in-time recovery (the 1 hour RPO);
2. log drains, on Better Stack (ADR 0033, decision 45);
3. 1-minute synthetic checks from five regions, on Better Stack (the same decision).

PowerSync hosting is not needed for launch: Compass launches on REST sync and PowerSync is deferred (ADR 0033, decision 51).

The Vercel plan includes Rolling Releases for one project, which `atlas` uses; `gateway` relies on Instant Rollback (ADR 0033, decision 50).
