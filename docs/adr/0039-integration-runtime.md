# ADR 0039: Integration Runtime, Import Sheets and Warehouse Delivery

- Status: Accepted
- Date: 2026-10-20
- Decider: Orchestrator; built and recorded by A83 (RRR-128)
- Resolves: findings A65-013, A65-025 and A65-029 (work package WP13); the worker schedule, inbound endpoints and
  chat token minter ADR 0024 left without an owner

## Context

Section 17's connectors existed as libraries and tables (0600 to 0639) that nothing ran: no Edge Function claimed
`integration.sync`, providers had no endpoint to post to, and the import worker had no deployed entry point either.
The import wizard read one sheet and ignored the Playbook column map and the assistant (Section 4.6.2). Warehouse
delivery (Section 4.6.4, Enterprise) was a feature flag with nothing behind it. Zapier and Make apps did not exist.

## Decision

1. **Three Edge Functions.** `integration-worker` runs one pass of the runtime every minute: connector sync runs,
   inbound webhook processing and warehouse deliveries, each part on its own so one failure never stops the others
   (`packages/integrations/src/runtime.ts`). `integration-inbound` receives provider webhooks (`verify_jwt = false`;
   providers sign). `import-run` runs the import worker. All logic lives in packages and reaches the functions through
   the generated Edge bundle (`packages/platform/edge/integrations.ts`); the function files only read the environment.
2. **Inbound webhooks are verified, then recorded once, then processed.** Every route checks the provider's
   signature on the raw body before reading it: Slack v0 signatures, Teams HMAC, Xero and QuickBooks HMAC with the
   app's key, and a per-connection shared token for Google Calendar channels and Microsoft Graph subscriptions.
   Work that can wait is recorded in `app.integration_inbound_events` once per connection and provider event
   (idempotency), answered at once, and processed by the worker with attempts, `private.integration_backoff` and a
   Dead Letter state an admin sends back with a reason (migration 1400). A change notice only queues a sync run of
   the scope it names, with an idempotency key per event; the sync run itself reads the provider. Slash commands
   and Teams messages are answered in the request.
3. **Chat reads as the linked person.** Slash commands, Teams messages and Slack unfurls read records with a
   one-minute HS256 session for the auth user behind the chat user (`mintChatSession`, signed with the project's JWT
   secret), never with the service role, so row level security decides what a reply shows.
4. **App-wide secrets in the function environment, per-connection secrets in Vault.** Slack's signing secret and
   the Xero and QuickBooks webhook keys belong to the platform's provider apps (`XOS_SLACK_SIGNING_SECRET`,
   `XOS_XERO_WEBHOOK_KEY`, `XOS_QUICKBOOKS_VERIFIER_TOKEN`). A Teams outgoing webhook token, a Google channel token
   or a Graph client state belongs to one connection and is stored in Vault (`app.store_integration_inbound_secret`),
   destroyed when the connection is disconnected. An endpoint without its secret answers 503.
5. **Every sheet, imported as its own import.** Detection records every sheet with its header row, data range and a
   proposed target (`app.import_job_sheets`): the target of the Playbook sheet of the same name, else the target the
   headers match best. The import reads one sheet; another sheet is imported through `app.import_detected_sheet`,
   which creates a new import as the person, so their capability for the target and the rule that an import reads
   only their own upload decide. One job per sheet keeps one target, one mapping and one batch per import.
6. **Suggestions name their source.** Saved profile first, then the Playbook column map (`xpms.playbook_column`,
   with an alias for a counterparty's organization name, and headers the map sends two ways left out), then header
   similarity. The assistant's suggestions are offered in the wizard through `aurora.mapColumns`, behind the AI seam
   (the org's AI switch, plan and allowance) and the `imports.ai_mapping` flag, now on by default. Headers only are
   sent, never cell values. The person confirms every mapping.
7. **Google Sheets links are fetched, saved and scanned.** A link import (`source_url`, behind the
   `imports.google_sheets` flag and a Connected Google Drive connection) is fetched by `import.fetch` with the Drive
   connection's token through the Sheets API v4 and saved as .xlsx into the person's own imports folder. The upload
   scanner then treats it like any upload, and its Clean verdict queues detection, so every import is read from one
   stored, scanned file. A sheet that is not shared, missing or too large fails the import with a reason.
8. **Warehouse delivery: Enterprise, S3 first, never Restricted.** A destination needs the Enterprise plan and the
   `reports.warehouse_delivery` flag (now on by default; the plan check keeps it to Enterprise) and is managed with
   `reports.schedule.write`. Its bucket credential lives in Vault. The nightly delivery writes one Parquet (or CSV)
   file per table in `private.warehouse_tables`, then `_schema.json` and, last, `_manifest.json`. Columns come from
   the catalog through the column registry: Restricted columns are never delivered, because Section 8.6 lets
   Restricted data leave only with step-up authentication, which an unattended job cannot give; Confidential columns
   only when a holder of `data.export.confidential` turns them on; encrypted values never. Every delivery and file is
   audited. S3 and S3-compatible services are built (SigV4 by hand, behind the webhook SSRF guard repeated after DNS
   resolution); Google Cloud Storage, Azure Blob, BigQuery and Snowflake are named, refused by
   `private.warehouse_providers` and by the provider seam until they are built.
9. **A small Parquet writer, no dependency.** One row group, PLAIN values, RLE definition levels, uncompressed,
   Thrift compact footer, with STRING, DATE and TIMESTAMP(UTC, micros) logical types. The tests read files back with
   an independent decoder. Compression and statistics can come later without changing the published schema.
10. **Zapier and Make apps are files tested against the contract.** Both use an org API key (the OAuth server the
    OpenAPI document describes is not built), REST hooks over `webhookEndpoints`, and only v1 operations; the tests
    run every request against `packages/api/openapi/v1.json` and every event against the registered domain events.
    Publishing is the owner's (`infra/runbooks/integrations.md`).

## Consequences

- The API v1 contract is unchanged; nothing here adds an operation.
- Large warehouse deliveries are bounded by the Edge Function's time and memory; a resumable delivery (a cursor per
  table) is the follow-up for orgs that outgrow one pass.
- Opening Google Calendar channels and Graph subscriptions from the calendar connector, a Zoom or Meet link
  connector, the SCIM endpoint (A65-002) and the scheduled domain verifier remain open.
- OAuth connections store an access token without a refresh flow, so long-lived Drive imports need the refresh
  flow to stay connected.
