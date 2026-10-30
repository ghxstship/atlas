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
Google account that connected Drive. The import worker still reads the stored access token without renewing it, so
a Sheets import after the token expired fails with "reconnect Google Drive"; the storage connectors renew it (below).

**Google Drive and OneDrive sign-in (B16, ADR 0155 D5).** Connect with Google and Connect with Microsoft run the
authorization code flow with PKCE S256 on the platform's own OAuth apps, and keep a refresh token in Vault; the
integration worker and the `storage-browse` Edge Function renew the access token 5 minutes before it expires and
store the rotated tokens. A refresh the provider answers `invalid_grant` moves the connection to Error with
`credential_revoked` and "Reconnect Google Drive" (or OneDrive).

- Google Cloud (the platform project): create an OAuth web client. Redirect URI
  `<ATLAS_SITE_URL>/oauth/integrations/callback`. Enable the Google Drive API and the Google Sheets API, and add
  `https://www.googleapis.com/auth/drive.readonly` to the consent screen. That scope is restricted: start Google's
  verification, including the security assessment. Until it passes the app runs in Testing mode, with at most 100
  listed test users and refresh tokens that expire after 7 days.
- Microsoft Entra: register a multi-tenant app (accounts in any directory and personal accounts), web redirect URI
  `<ATLAS_SITE_URL>/oauth/integrations/callback`, delegated permissions `offline_access`, `Files.Read.All` and
  `User.Read`, and complete publisher verification. Some tenants need an admin to consent to `Files.Read.All`.
- Put each pair only into `XOS_GOOGLE_STORAGE_CLIENT_ID` and `XOS_GOOGLE_STORAGE_CLIENT_SECRET`, and
  `XOS_MICROSOFT_STORAGE_CLIENT_ID` and `XOS_MICROSOFT_STORAGE_CLIENT_SECRET`: in Vercel (Atlas) and in the Edge
  Function secrets (`integration-worker`, `storage-browse`). Without a pair, its button is disabled with "not set up
  on this XOS yet". Then deploy: `supabase functions deploy storage-browse integration-worker stripe-webhook
--project-ref <ref>`.
- After connecting, an Admin chooses the connection's linking folder in Settings, Integrations. Document writers
  browse and link only inside it, so nobody browses the Admin's own files. Dropbox stays on pasted tokens.

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

**Zapier.** The app pins `zapier-platform-core` 19.1.0 (released 2026-07-30) and needs Node 22 or later, the
runtime Zapier has used since platform 18. Install the CLI at the same version so `validate` checks the same
schema. Since 19.0.0 the CLI command is `zapier-platform`; the old `zapier` command is gone.

```bash
npm install -g zapier-platform-cli@19.1.0
zapier-platform login           # as the GHXSTSHIP account
cd packages/integrations/automation/zapier
npm install                     # installs zapier-platform-core 19.1.0 from package.json
zapier-platform register "XOS"  # once; writes .zapierapprc (do not commit it)
zapier-platform validate
zapier-platform push
```

Then invite testers. The apps open as an invite-only beta and go to public listing after it (ADR 0033, decision 70):
submit the app for public listing in the Zapier developer platform once the beta is done (Zapier reviews it).

What changed between platform 17 and 19, and where the app stands (checked against the 19.1.0 schema offline,
with no errors):

- Node and module format. Platform 18 runs on Node 22. CommonJS apps are still supported (ESM is opt-in through
  `"type": "module"` and `exports`), so `index.js` stays CommonJS.
- Authentication. Platform 17 removed the `code`, `file`, `integer` and `text` auth field types and the
  `altersDynamicFields`, `dynamic`, `meta`, `primary`, `search` and `steadyState` auth field properties. The app's
  custom auth uses a `password` field (`api_key`) and a plain field (`base_url`), so nothing changed.
- Requests. Platform 17 refuses `{{bundle.*}}` and `{{process.env.*}}` inside `z.request`; the app builds every URL
  with template literals. Platform 18 throws `ThrottledError` on 429 before `afterResponse` runs, so the app's
  problem handler sees every other error status and Zapier retries throttled calls.
- Schema. Platform 17 removed `primary` and `steadyState` from input fields and dropped `shouldLock`; platform 18
  replaced the `skipCleanArrayInputData` flag with `cleanInputData`. The app uses none of these. 19.0.0 and 19.1.0
  have no schema changes.

`packages/integrations/test/automation.test.ts` checks the pinned version, the Node engine and these rules. Before
moving to a newer platform, read its release notes at `https://docs.zapier.com/platform/news` and run
`zapier-platform validate`.

**Make.** In Make, Custom Apps, create the app "XOS", then copy each section of
`packages/integrations/automation/make/xos.make.json` into the matching tab: Base, the `xos-api-key` connection,
the `xos-event` webhook (attach and detach) and each module (communication, mappable parameters, interface). Test
with a scenario against staging, then share the app with the invited beta testers, and request publication (Make
reviews it) once the beta is done (ADR 0033, decision 70).

## 6. After setup

- Inbound events that fail for good wait as Dead Letter in Atlas, Settings, Integrations, where an Admin sends them
  back with a reason. `select provider_code, inbound_state, count(*) from app.integration_inbound_events group by 1, 2;`
- Warehouse deliveries and their files are audited (`app.warehouse_deliveries`, `app.warehouse_delivery_files`).
- The demo removal script (`infra/production/remove-demo-data.sql`) deletes the Vault secrets of a removed org:
  connector credentials (`xos_integration_<id>`), inbound secrets (`xos_integration_inbound_<id>`) and warehouse
  credentials (`xos_warehouse_<id>`).
