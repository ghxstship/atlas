# PowerSync service for Compass sync

Compass launches on REST sync, and PowerSync is deferred until the readiness check below passes (ADR 0033, decision 51). Until then Compass's REST downloader (`apps/compass/src/data/downloader.ts`) reads through row-level security and the `api_external` views, and nothing in production runs this service. When it is turned on, Compass syncs through PowerSync (Section 5: open edition, self-hostable; Section 13). The service streams changes from Postgres by logical replication and serves each device the buckets that A17's sync rules (`packages/sync/sync-rules.yaml`) grant from `private.sync_scope_grants`. Writes never go through PowerSync: Compass sends them to `app.apply_sync_mutation` with an idempotency key (0364).

| File                         | Purpose                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `powersync.yaml`             | Service configuration for every environment; every secret comes from the environment (`!env`) |
| `docker-compose.yaml`        | Local service plus its own bucket-storage Postgres, against the `xos4-shared` stack           |
| `src/rules.ts`, `src/cli.ts` | Readiness check: rules against the live catalog, and the replication role and publication SQL |

## Readiness check

```sh
node --experimental-strip-types infra/powersync/src/cli.ts --container supabase_db_xos4-shared --out /tmp/powersync.sql
```

The check reads the catalog read-only and writes the role and publication SQL. It exits 1 while any problem remains. On 2026-10-16, against the shared stack at migration 1001, it found:

| Problem                                                                                 | Tables                                                                                     | Owner                                                        |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Unqualified names: PowerSync reads them from `public`, where none of these tables are   | All 26 replicable tables, including `private.sync_scope_grants`                            | A17 follow-up: qualify every name                            |
| `SELECT *` in external buckets sends internal columns to external devices (Section 8.7) | `time_entries`, `shifts`, `credentials`, `dock_slots`, `cues`, `day_sheets`, `run_of_show` | A17 follow-up: select the `api_external` view's columns      |
| External buckets read tables that have no `api_external` view at all                    | `asset_custody`, `clock_punches`, `projects`, `radio_channels`                             | A28's range (Gateway and Compass follow-up), then A17        |
| A view in the rules (logical replication publishes tables only)                         | `app.geofence_shapes`                                                                      | A17 with A03: sync the base table or a maintained table      |
| Not a table in the database                                                             | `kiosk_roster`, `emergency_codes`, `incident_severities`, `inspection_result_values`       | A17: kiosk roster view and canon lists (see the relay notes) |

Until these are fixed, the service would replicate nothing for the unqualified names and would leak internal columns to external devices. Do not point Compass builds at a PowerSync instance before the check passes. Meanwhile Compass's REST downloader (`apps/compass/src/data/downloader.ts`) keeps working, because it reads through RLS and the `api_external` views.

## Database setup (per environment, after the check passes)

1. Generate the SQL with the check above. It creates `powersync_role` (login, replication, bypass RLS, **no password**), grants it read access to exactly the published tables, and creates or alters the `powersync` publication with `publish_via_partition_root = true`.
   - The role bypasses RLS because replication reads every row. The sync rules and `private.sync_scope_grants` decide what each device receives.
   - Publishing through the root is required for the partitioned tables (and for `time_entries` and `access_scans` once the partition proposals land). Without it, changes arrive under partition names and match no rule.
2. The owner runs it in the Supabase SQL editor, then sets the password there with `alter role powersync_role with password '<generated>'`. The owner stores the password only in the PowerSync service's secret configuration. No agent and no file in this repository ever holds it.
3. Logical replication must be on. It is on in every Supabase project, since Realtime uses it.

## Hosting

| Option                               | Cost                                                                                              | Notes                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| PowerSync Cloud, Free plan (staging) | No charge within the Free plan's limits; the owner confirms the current limits before creating it | Same service; paste `powersync.yaml`'s values and the sync rules into the instance, or deploy the rules with the PowerSync CLI |
| Self-hosted open edition             | Needs always-on compute and a storage database; no free tier on the current hosts                 | Run the image from `docker-compose.yaml` on the owner's chosen host, with `PS_*` variables as secrets                          |

The recommendation for staging is PowerSync Cloud's Free plan, because it adds no spend and no servers to run. Section 5 only requires that the service be self-hostable, and `powersync.yaml` keeps that path open. Production hosting is an owner decision (blocked item: it may cost money).

### Service image

ADR 0001 does not pin the PowerSync service image yet. Before first use the orchestrator records the image `journeyapps/powersync-service` at the latest stable tag in ADR 0001, as a "Wave 5 additions" row. Then set `POWERSYNC_SERVICE_IMAGE` to that exact tag (never `latest`). Pulling the image is a download, so it needs approval on hosts that run agents.

### Environment variables

| Variable                 | Local                                                                           | Hosted                                                              |
| ------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `PS_DATA_SOURCE_URI`     | `postgresql://powersync_role:<local value>@host.docker.internal:56022/postgres` | The project's direct connection string as `powersync_role` (secret) |
| `PS_DATA_SOURCE_SSLMODE` | `disable`                                                                       | `verify-full`                                                       |
| `PS_STORAGE_URI`         | Set by compose                                                                  | The storage database (secret)                                       |
| `PS_STORAGE_SSLMODE`     | `disable`                                                                       | `verify-full`                                                       |
| `PS_JWKS_URI`            | `http://host.docker.internal:56021/auth/v1/.well-known/jwks.json`               | `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`   |

### Local run

```sh
export POWERSYNC_SERVICE_IMAGE=<tag from ADR 0001> PS_STORAGE_PASSWORD=<any local value>
export PS_DATA_SOURCE_URI=postgresql://powersync_role:<local value>@host.docker.internal:56022/postgres
docker compose -f infra/powersync/docker-compose.yaml up -d
curl -fsS http://127.0.0.1:56080/probes/liveness && curl -fsS http://127.0.0.1:56080/probes/readiness
docker compose -f infra/powersync/docker-compose.yaml down -v   # removes only this project's containers and volume
```

## Compass and monitoring

- **Compass.** Compass connects with `EXPO_PUBLIC_POWERSYNC_URL` (the instance URL) and the person's Supabase session token through a PowerSync backend connector. Its `uploadData` drains the outbox through `app.apply_sync_mutation`. That wiring is a Compass follow-up (A17); today Compass uses the REST downloader.
- **Monitoring.** The synthetic check `sync.liveness` calls `/probes/liveness` and `/probes/readiness` when `XOS_POWERSYNC_URL` is set, and the status page shows it as Compass sync. Section 5.1's target is a queued write synced within 5 s at p95 after reconnect; A24's Maestro offline runs measure it.
- **Incidents.** See "Realtime or sync degraded" in `infra/runbooks/incident-response.md`. A lost replication slot shows as readiness failing. Restart the service; it resumes from the slot, or re-snapshots if the slot is gone.
- **Replication slots** hold WAL while the service is down. If the service will be off for more than a day, drop its slot (`select pg_drop_replication_slot(...)`) so WAL does not fill the disk. The service re-snapshots when it returns.
