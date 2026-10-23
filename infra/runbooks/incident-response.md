# Incident response runbook

This is the operational runbook for the Incident Response Policy (`legal/policies/incident-response.md`, owner A21). The policy defines severities, roles and notification duties. This runbook says what to do, minute by minute. Every synthetic check alert links to a section below.

## First 15 minutes

1. **Acknowledge** the alert in the on-call channel: "I have it." You are the Incident Commander (IC) until you hand over.
2. **Confirm impact.** Open the status page (`https://status.ghxstship.tech`) and the failing check's latest run (GitHub Actions, workflow `synthetics`), then try the journey yourself in a private window.
3. **Assign a severity** with the policy's table:

   | Severity | Examples                                                                                                    | Response start      |
   | -------- | ----------------------------------------------------------------------------------------------------------- | ------------------- |
   | SEV1     | Atlas, Gateway or the API down in a region; confirmed cross-tenant exposure; Restricted data breached       | Immediately, 24x7   |
   | SEV2     | Sign-in failing for some users; Realtime or Compass sync down; suspected breach; a security control failing | Within 1 hour, 24x7 |
   | SEV3     | A slow component (degraded checks); a non-critical feature down                                             | Next business day   |
   | SEV4     | No customer impact                                                                                          | Scheduled           |

4. **Open the incident record:** an issue labeled `incident` and `sev<n>`, titled "<component>: <symptom>". Keep the timeline in it in UTC, one line per fact or decision.
5. **For SEV1 or SEV2:**
   - name a Communications Lead;
   - tell the Owner;
   - freeze deploys (no merges to main until the IC lifts it);
   - post on the status page within 30 minutes (see Communication).
6. **If personal data may be involved, page the Privacy Officer now.** Customer breach notice is due within 48 hours of awareness (DPA Section 9). Regulators are due within 72 hours where XOS is controller. Awareness starts the clock, so write the time in the timeline.

## Contain first

Pick the smallest action that stops the harm, and preserve evidence before changing anything you can:

| Lever                                 | How                                                                                                | Undo                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Roll back a deployment                | Vercel, project `atlas` or `gateway`, Deployments, the last good deployment, Instant Rollback      | Promote the newer deployment again    |
| Abort a rolling release               | Vercel, Rolling Releases, Abort                                                                    | Start the release again after the fix |
| Kill a feature                        | `pnpm --filter @xos/infra rollout:gate flag-kill <flag> on`, run with the service role             | `flag-kill <flag> off`                |
| Stop a rollout cohort                 | `flag-rollback <flag>`                                                                             | Stage again                           |
| Revoke a leaked key                   | Supabase, Settings, API, roll the key; Vercel env var update and redeploy; revoke `xos_live_` keys | Not reversible; issue new keys        |
| Disable an integration for one tenant | Set the integration inactive for the org (A19's integration settings)                              | Re-enable                             |
| Pause outbound webhooks               | Kill switch on `webhooks.delivery`                                                                 | Release the kill switch               |
| Block abusive traffic                 | Vercel Firewall, a custom rule for the source (included features only)                             | Remove the rule                       |

Never delete data, accounts or cloud resources during an incident. Pause or isolate them instead, and ask the Owner (Section 19.8).

## Diagnose by symptom

### Atlas or Gateway unavailable

Checks: `atlas.sign_in_page`, `gateway.home`.

1. Vercel, the project, Deployments: did a deploy land in the last hour? If yes, roll back first and investigate after.
2. Vercel, Observability or Logs, filtered on `level:error`. Each log line is JSON with `service`, `request_id`, `trace_id` and `http_route`.
3. Sentry, project `atlas` or `gateway`: the newest issue, its first-seen release and its trace.
4. Check `https://www.vercel-status.com` and `https://status.supabase.com` for a provider incident. If one is open, link it on the status page and track it.
5. If the pages fail but `api.openapi` passes, suspect the proxy (`apps/atlas/proxy.ts`) or the Supabase session refresh. Sign-in errors show up as `auth` errors in the logs.

### Sign-in failing

Check: `atlas.sign_in`.

1. Supabase, the project, Auth logs: rate limits, `invalid_grant` for every user, or provider outages.
2. Check the synthetic user still exists and is not locked. A locked synthetic user is SEV4: fix the account and close.
3. Check the custom access token hook (`0920_active_org_token_hook.sql`). A failing hook blocks every sign-in. The Auth logs show `hook` errors.
4. Recent changes to Auth settings (Supabase, Auth, Settings) are a common cause. Revert them through the dashboard and record the change in the timeline.

### API errors or latency

Checks: `api.openapi`, `api.read`.

1. Errors: Vercel logs for `/api/v1`, grouped by `http_route` and status. A wave of 5xx after a deploy means roll back.
2. Latency: Supabase, Reports, Database. Look for CPU, connections and slow queries (`pg_stat_statements`). Connections near the limit point at pooling: the API must use Supavisor in transaction mode (Section 5.1).
3. The RLS benchmark (gate 17) catches policy regressions. A slow list query usually means a policy without an index; `explain analyze` it as the affected role.
4. If the API is slow only for one tenant, check that tenant's import or export jobs (`app.import_jobs`, `app.export_jobs`) and pause the job.

### Realtime or sync degraded

Checks: `realtime.join`, `sync.liveness`.

1. Realtime: Supabase, Realtime inspector; check concurrent connection and message quotas on the plan page.
2. Compass sync: check the PowerSync service health (`/probes/liveness`, `/probes/readiness`) and its logs (`infra/powersync/README.md`). A replication slot error means the service lost its Postgres connection.
3. Compass keeps working offline, so sync outages are SEV2: queued writes drain on reconnect and the server deduplicates by idempotency key. Watch the queue drain after recovery.

### Notifications delayed

Check: `notifications.function`.

1. Supabase, Edge Functions, `notification-dispatch`: invocations and errors. The function answers 401 without the service key, which is what the check expects.
2. Check the scheduled job that calls it (`cron.job_run_details` for the dispatch job) and the provider status (Resend).
3. Deliveries are rows in `app.notification_deliveries`. Undelivered rows are retried, so nothing is lost while the function is down.

### Security incident or suspected breach

1. Preserve evidence:
   - export the relevant `app.audit_events`, `app.file_access_log` and provider logs to a restricted location;
   - record who collected them and when (policy Section 7).
2. Contain: revoke credentials, kill the feature, block the source.
3. Scope it from the audit ledger: which orgs, records and people.
4. The Privacy Officer decides on notification. The Communications Lead drafts the customer notice with the DPA Section 9 contents, and the Owner approves it.
5. Never post breach details on the public status page. Post an availability-only note if service is affected.

## Communication

- **Status page.** Add an entry to `infra/status/incidents.json` (title and update in en-US and es-US, affected components and regions, `startedAt`, `resolvedAt` set to null) and merge it. The next synthetics run republishes the page. Update at least every 60 minutes until resolved (SLA Section 5).

  ```json
  {
    "id": "2026-10-16-api-errors",
    "components": ["api"],
    "regions": ["us-east"],
    "startedAt": "2026-10-16T14:05:00Z",
    "resolvedAt": null,
    "text": {
      "en-US": {
        "title": "API errors",
        "update": "Some API requests fail. We rolled back the latest release and are watching recovery."
      },
      "es-US": {
        "title": "Errores de la API",
        "update": "Algunas solicitudes a la API fallan. Revertimos la última versión y estamos vigilando la recuperación."
      }
    }
  }
  ```

- **In-app banner.** The Communications Lead posts the same text in the Atlas and Gateway banner.
- **Resolution.** Set `resolvedAt`, write the final update and lift the deploy freeze.

## After the incident

1. **Postmortem.** For SEV1 and SEV2, hold a blameless review within 5 business days. Cover the timeline, root cause, what worked and what did not, and actions with owners and dates, each filed as an issue.
2. **Post-incident report.** Publish it within 5 business days for any downtime under the SLA.
3. **Error budget.** At 99.9 percent, the monthly budget is 43 minutes. When a month's budget is spent, feature releases pause until reliability work restores it (Section 5.1). The release owner checks the status page's 30-day uptime before each release.
4. **Update this runbook** with anything the next on-call would have needed.

## On-call setup (orchestrator)

| Item                 | Setting                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Alert channel        | A Slack incoming webhook for the on-call channel, saved as the `XOS_ALERT_WEBHOOK_URL` repository secret                 |
| GitHub notifications | Watch the repository for failed `synthetics` runs (Actions notifications for the on-call engineers)                      |
| Synthetic user       | One staging user with no org data of value, `XOS_SYNTHETIC_EMAIL` and `XOS_SYNTHETIC_PASSWORD` secrets                   |
| Sentry alerts        | Projects `atlas` and `gateway`: alert on a new issue and on more than 10 events in 5 minutes, routed to the same channel |
| Rotation             | Weekly primary and secondary; the handover note lists open incidents and frozen deploys                                  |
