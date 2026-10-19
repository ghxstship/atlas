# infra: the XOS reliability stack (A26)

Section 5.1 (global performance and reliability), Section 9 (operations) and Section 14 (backup, retention, incident response), as code, scripts and runbooks. Nothing here changes a live Vercel or Supabase setting. Each directory lists the settings the orchestrator applies.

| Directory        | What it holds                                                                                             | Entry point                                |
| ---------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `observability/` | Structured logs, OpenTelemetry tracing and Sentry error reporting, all through one personal data redactor | `observability/README.md` (wiring per app) |
| `synthetics/`    | Read-only checks for sign-in, Gateway, the API, Realtime, Compass sync and notifications                  | `pnpm --filter @xos/infra synthetics`      |
| `status/`        | The public status page (static HTML, en-US and es-US) and the incident list                               | `pnpm --filter @xos/infra status:build`    |
| `delivery/`      | Progressive delivery: feature rollouts on A18's flags and the deployment release gate                     | `runbooks/progressive-delivery.md`         |
| `drills/`        | Backup and restore drills against a local Docker stack only                                               | `runbooks/backup-and-restore.md`           |
| `db/`            | Partition proposals for `time_entries` and `access_scans`, and their verification                         | `db/README.md`                             |
| `powersync/`     | PowerSync service configuration, local stack and readiness check for Compass sync                         | `powersync/README.md`                      |
| `ci/`            | Reusable CI scripts and the exact workflow snippets for the orchestrator                                  | `ci/README.md`                             |
| `runbooks/`      | Production deploys and rollback, incident response, backup and restore, progressive delivery              | `runbooks/production.md`                   |

## Cost rules

Everything runs on free tiers or on plans already paid for:

- **GitHub Actions and Pages.** Free for a public repository: synthetics every 5 minutes, the status page and the weekly backup.
- **Sentry Developer plan.** Free: errors and a 5 percent trace sample.
- **Vercel and Supabase logs.** Included in the current plans.
- **PowerSync Cloud Free plan for staging.** The owner confirms the plan's limits before creating the instance.

Four Section 5.1 and Section 9 targets need paid services, so they are blocked items, not assumptions:

1. point-in-time recovery (the 1 hour RPO);
2. log drains;
3. 1-minute synthetic checks from five regions;
4. production PowerSync hosting.

Rolling Releases on Vercel apply only if the current plan includes them.
