# Integration runtime: owner setup

A83 (RRR-128) made the Section 17 integrations run: the `integration-worker`, `integration-inbound` and `import-run`
Edge Functions, inbound webhooks with retries and a dead letter list, Google Sheets imports, warehouse delivery,
and the Zapier and Make apps. This runbook lists what only the owner can do: accounts, app registrations,
secrets and publishing. Nothing here is needed for local development or CI, which use fake transports.

Never paste a real secret into the repository, an issue or a chat. Values below are formats only.

## 1. Deploy and schedule the workers

```bash
supabase functions deploy integration-worker integration-inbound import-run --project-ref <production-ref>
```

`integration-inbound` runs with `verify_jwt = false` (`supabase/config.toml`): providers authenticate by signature.

Schedule the two workers every minute from the database, as the other workers (`webhook-dispatch`,
`notification-dispatch`, `upload-scan`, `report-run`) are scheduled, reading the service key from Vault
(`xos_worker_key`):

```sql
select cron.schedule('xos_worker_integration', '* * * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/integration-worker',
    headers := jsonb_build_object('Authorization', 'Bearer ' ||
      (select decrypted_secret from vault.decrypted_secrets where name = 'xos_worker_key')));
$$);
select cron.schedule('xos_worker_import_run', '* * * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/import-run',
    headers := jsonb_build_object('Authorization', 'Bearer ' ||
      (select decrypted_secret from vault.decrypted_secrets where name = 'xos_worker_key')));
$$);
```

Until `import-run` runs, imports stay at "Reading your spreadsheet". Until `integration-worker` runs, sync runs,
change notices, Slack unfurls and warehouse deliveries stay queued. The nightly warehouse scheduler itself is a
migration-created pg_cron job (`xos_queue_due_warehouse_deliveries`, hourly at minute 7).

Verify: `select jobname, schedule from cron.job order by 1;` lists both; calling either function with the
service key answers 200 with a JSON summary; `select job_kind, job_status, count(*) from app.job_queue where
job_kind in ('integration.sync', 'integration.inbound', 'warehouse.deliver', 'import.fetch', 'import.detect')
group by 1, 2;` shows no growing Queued count.

## 2. Edge Function secrets

| Secret                          | Format                                       | Used by                                                                 |
| ------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| `XOS_API_JWT_SIGNING_KEY`       | The project's JWT secret (already set)       | One-minute chat sessions for slash commands, Teams messages and unfurls |
| `XOS_APP_URL`                   | `https://atlas.ghxstship.tech` (already set) | Which record links Slack unfurls                                        |
| `XOS_SLACK_SIGNING_SECRET`      | `<32 hex characters>` from the Slack app     | `/integration-inbound/slack/*`                                          |
| `XOS_XERO_WEBHOOK_KEY`          | `<webhook key>` from the Xero app            | `/integration-inbound/xero`                                             |
| `XOS_QUICKBOOKS_VERIFIER_TOKEN` | `<verifier token>` from the Intuit app       | `/integration-inbound/quickbooks_online`                                |

An endpoint whose secret is unset answers 503 and records nothing, so a provider keeps retrying until it is set.

## 3. Provider apps

Each provider app belongs to the platform owner, not to a customer. Customers connect their accounts in Atlas,
Settings, Integrations; the connection stores their token in Vault.

**Slack.** Create a Slack app (api.slack.com/apps). Event Subscriptions: request URL
`https://<project-ref>.supabase.co/functions/v1/integration-inbound/slack/events`, bot event `link_shared`, and the
Atlas domain under App unfurl domains. Slash Commands: `/xos` with request URL `.../integration-inbound/slack/commands`.
Bot scopes: `chat:write`, `links:read`, `links:write`, `commands`. Copy the Signing Secret into
`XOS_SLACK_SIGNING_SECRET`. The workspace's team id is the connection's external account id.

**Microsoft Teams.** A team owner adds an outgoing webhook (Apps, Manage apps, Create an outgoing webhook) with
callback URL `.../integration-inbound/microsoft_teams/<connection id>`. Teams shows a security token once; an Admin
pastes it in Atlas as the connection's webhook secret (stored in Vault, `app.store_integration_inbound_secret`).

**Xero.** In the Xero developer portal, the XOS app's Webhooks: delivery URL `.../integration-inbound/xero`, events
Invoices and Contacts. Xero sends an intent-to-receive check first; the endpoint answers it. Copy the webhook key
into `XOS_XERO_WEBHOOK_KEY`. A notice for a tenant queues a Payment Sync run of the connection whose external
account id is that tenant id.

**QuickBooks Online.** In the Intuit developer portal, the XOS app's Webhooks: endpoint
`.../integration-inbound/quickbooks_online`, entities Invoice, Payment and Customer. Copy the verifier token into
`XOS_QUICKBOOKS_VERIFIER_TOKEN`. The realm id routes the notice.

**Google Calendar and Microsoft 365.** Push notifications go to `.../integration-inbound/google_calendar/<connection id>`
and `.../integration-inbound/microsoft_365/<connection id>`. The channel token (Google) or subscription client state
(Microsoft Graph) is the connection's webhook secret, at least 16 characters. Opening channels and subscriptions
from the calendar connector is a follow-up; until then, calendars sync on the schedule.

**Google Drive and Sheets (imports).** The Google Cloud project behind the Drive connection needs the Google
Sheets API and the Google Drive API enabled, and the OAuth consent screen must list
`https://www.googleapis.com/auth/spreadsheets.readonly` (or `drive.readonly`). A customer connects Drive in Atlas;
the import worker reads a pasted Sheets link with that connection's token, so the sheet must be shared with the
Google account that connected Drive. Connections store an access token without a refresh flow today, so a token
that expired fails the import with "reconnect Google Drive" until the OAuth refresh flow lands.

## 4. Warehouse delivery (Enterprise)

Nothing to set up on the platform side. A customer's Admin adds the destination and its credential in Atlas. For
Amazon S3, the customer creates an IAM user or role whose policy allows only `s3:PutObject` on
`arn:aws:s3:::<bucket>/<folder>/*`, and stores
`{"access_key_id": "AKIA<16 characters>", "secret_access_key": "<40 characters>"}`. The schema customers rely on is
published at `/guides/warehouse-delivery` on the docs site and in every delivery's `_schema.json`.

## 5. Zapier and Make apps

The app definitions live in `packages/integrations/automation/` and are tested against the OpenAPI document
(`packages/integrations/test/automation.test.ts`). Both authenticate with an org API key (`xos_live_` plus 48 hex
characters) that a customer creates in Atlas, Settings, API keys and service accounts. OAuth replaces the key once
the authorization server described by the OpenAPI document ships.

**Zapier.** With the Zapier CLI (`npm install -g zapier-platform-cli`, then `zapier login` as the GHXSTSHIP
account):

```bash
cd packages/integrations/automation/zapier
npm install            # set zapier-platform-core in package.json to the current release first
zapier register "XOS"  # once; writes .zapierapprc (do not commit it)
zapier validate
zapier push
```

Then invite testers, and submit the app for public listing in the Zapier developer platform when the owner
decides to publish (Zapier reviews it).

**Make.** In Make, Custom Apps, create the app "XOS", then copy each section of
`packages/integrations/automation/make/xos.make.json` into the matching tab: Base, the `xos-api-key` connection,
the `xos-event` webhook (attach and detach) and each module (communication, mappable parameters, interface). Test
with a scenario against staging, then request publication (Make reviews it) when the owner decides to publish.

## 6. After setup

- Inbound events that fail for good wait as Dead Letter in Atlas, Settings, Integrations, where an Admin sends them
  back with a reason. `select provider_code, inbound_state, count(*) from app.integration_inbound_events group by 1, 2;`
- Warehouse deliveries and their files are audited (`app.warehouse_deliveries`, `app.warehouse_delivery_files`).
- The demo removal script (`infra/production/remove-demo-data.sql`) deletes `xos_integration_<id>` Vault secrets;
  inbound secrets (`xos_integration_inbound_<id>`) and warehouse credentials (`xos_warehouse_<id>`) of a removed
  org must be deleted the same way if any exist.
