# Integration connectors

The integration connectors of XOS and the status of each at this release. The marketing site (`ghxstship/atlas-marketing`), its integrations page and its directory listings cite this file; `design/MARKETING_LOCKSTEP.md` names it as a product fact, so a change here is a lockstep change.

The table restates the connector catalog (`packages/integrations/src/framework/catalog.ts`, which mirrors `private.integration_providers`). `packages/integrations/test/connector-status.test.ts` holds every row to the catalog, the plan registry and the en-US names, so a connector cannot be added, removed or moved to another plan without this file changing with it.

## What each status means

- **Shipped.** The connector is in this release. An Admin of an organization on the stated plan connects it in Atlas under Settings, Integrations, and the integration worker runs its sync.
- **Not offered.** The connector's code is in this release, and GHXSTSHIP does not offer it on the hosted service. No page names it as available.

A status says what the release contains. It is not a statement that the provider has reviewed, certified or listed XOS, and no connector here is a partnership with its provider.

## Connectors

| Connector               | Code                  | Category      | What it does                             | Plan           | Credential                  | Status      |
| ----------------------- | --------------------- | ------------- | ---------------------------------------- | -------------- | --------------------------- | ----------- |
| Xero                    | `xero`                | Accounting    | Export posted journals and sync payments | Core and above | Token or key                | Shipped     |
| QuickBooks Online       | `quickbooks_online`   | Accounting    | Export posted journals and sync payments | Core and above | Token or key                | Shipped     |
| NetSuite                | `netsuite`            | Accounting    | Export posted journals and sync payments | Core and above | Token or key                | Shipped     |
| Ramp                    | `ramp`                | Accounting    | Export posted journals and sync payments | Core and above | Token or key                | Shipped     |
| Google Calendar         | `google_calendar`     | Calendar      | Sync calendars                           | Every plan     | Token or key                | Shipped     |
| Microsoft 365           | `microsoft_365`       | Calendar      | Sync calendars                           | Every plan     | Token or key                | Shipped     |
| Google Drive            | `google_drive`        | Storage       | Refresh linked files                     | Every plan     | Sign-in                     | Shipped     |
| OneDrive and SharePoint | `onedrive_sharepoint` | Storage       | Refresh linked files                     | Every plan     | Sign-in                     | Not offered |
| Dropbox                 | `dropbox`             | Storage       | Refresh linked files                     | Every plan     | Token or key                | Shipped     |
| Slack                   | `slack`               | Communication | Post notifications                       | Every plan     | Token or key                | Shipped     |
| Microsoft Teams         | `microsoft_teams`     | Communication | Post notifications                       | Every plan     | Token or key                | Shipped     |
| Gusto                   | `gusto`               | Payroll       | Hand off payroll                         | Team and above | Token or key                | Shipped     |
| ADP                     | `adp`                 | Payroll       | Hand off payroll                         | Team and above | Token or key                | Shipped     |
| Rippling                | `rippling`            | Payroll       | Hand off payroll                         | Team and above | Token or key                | Shipped     |
| UPS                     | `ups`                 | Shipping      | Refresh tracking                         | Every plan     | Client ID and client secret | Shipped     |
| FedEx                   | `fedex`               | Shipping      | Refresh tracking                         | Every plan     | Client ID and client secret | Shipped     |
| DHL                     | `dhl`                 | Shipping      | Refresh tracking                         | Every plan     | Token or key                | Shipped     |
| Ticketing CSV import    | `ticketing_csv`       | Ticketing     | Import attendance                        | Every plan     | None                        | Shipped     |
| Ticketing API           | `ticketing_api`       | Ticketing     | Import attendance                        | Every plan     | Token or key                | Shipped     |

The columns:

- **Plan** is the lowest plan whose features in `packages/schemas/plans.yaml` include the feature the catalog requires: `upl_export` for Accounting and `payroll_export` for Payroll. A connector that requires no feature is on every plan.
- **Credential** is what the Admin stores for the connection: a token or key pasted from the provider, the client ID and client secret of the customer's own carrier developer app, a sign-in with the provider, or nothing.
- **What it does** is the connector's sync, in the words Atlas uses.

OneDrive and SharePoint is not offered because its sign-in is not offered: `docs/release-checklist.md` records that "Microsoft is not offered, by the owner's decision of 2026-11-06, and its button stays disabled". The same row records that Google Drive sign-in is set up.

## Other integration surfaces

| Surface                         | Plan                                           | Status              |
| ------------------------------- | ---------------------------------------------- | ------------------- |
| Zapier app                      | Pro and above, through an organization API key | Not publicly listed |
| Make app                        | Pro and above, through an organization API key | Not publicly listed |
| Warehouse delivery to Amazon S3 | Enterprise                                     | Shipped             |

The Zapier and Make app definitions are in this release (`packages/integrations/automation/`). Neither app is in its provider's public directory: each opens as an invite-only beta and goes to public listing after the provider reviews it (ADR 0033, decision 70). No page says XOS is listed on Zapier or Make.

## What the repository does not record

These are the owner's facts. This file leaves them out instead of guessing them.

- Whether the invite-only beta of the Zapier app or the Make app has opened.
- Whether Google has verified the Drive sign-in. Until it has, the sign-in runs in Google's Testing mode, which limits who can use it (`infra/runbooks/integrations.md`, section 3).
- Whether the Slack, Xero and Intuit provider apps and their inbound secrets are set in production. Until they are, Slack link previews, the Slack command and change notices from Xero and QuickBooks Online do not arrive; the connectors' own syncs do not depend on them (`infra/runbooks/integrations.md`, sections 2 and 3).

## Sources

Each sentence below is quoted exactly from the file named beside it.

| File                                              | Sentence                                                                                                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/release-checklist.md`                       | Google Drive connect is set up on the platform OAuth app. Microsoft is not offered, by the owner's decision of 2026-11-06, and its button stays disabled |
| `docs/adr/0033-owner-decisions-2026-10-19.md`     | open as an invite-only beta, then go to public listing, which each provider reviews.                                                                     |
| `infra/runbooks/integrations.md`                  | Until it passes the app runs in Testing mode, with at most 100                                                                                           |
| `infra/runbooks/integrations.md`                  | Both authenticate with an org API key                                                                                                                    |
| `infra/runbooks/integrations.md`                  | An endpoint whose secret is unset answers 503 and records nothing, so a provider keeps retrying until it is set.                                         |
| `supabase/migrations/1401_warehouse_delivery.sql` | Warehouse delivery is part of the Enterprise plan.                                                                                                       |
| `packages/integrations/src/worker.ts`             | Every Section 17 connector over the Supabase sources, one per provider of the catalog.                                                                   |
