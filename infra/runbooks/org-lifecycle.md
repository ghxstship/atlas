# Org lifecycle: trials, deletion, ownership, dunning, partners and white label

Agent A79 (RRR-124), findings A65-015, A65-026 and A65-033. Migrations 1350 to 1355, the `org-lifecycle` Edge
Function, `@xos/data` `org-purge.ts` and `@xos/integrations` `domains/`.

Values are never pasted into tickets, logs or this file. A step that needs a secret names the secret only; the
owner sets it from the owner's secret store.

## What runs where

| Piece                          | Runs                                          | Does                                                                                                                                                                       |
| ------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `private.run_org_lifecycle()`  | pg_cron `xos_hourly_org_lifecycle`, minute 23 | Ends trials (Access plan), lapses ownership offers, ends white label kept after a downgrade, writes deletion certificates for orgs due, purges orgs whose storage is clear |
| `private.run_dunning()` (0560) | pg_cron `xos_daily_dunning`                   | Dunning notices; read-only on day 21, which 1353 now enforces                                                                                                              |
| `org-lifecycle` Edge Function  | the owner's scheduler, every 5 minutes        | Deletes due orgs' storage objects through the Storage API; renders, stores and emails deletion certificates; provisions custom domains at Vercel and Resend                |

The purge itself runs in the database (`private.purge_organization`, called by the hourly job) so it has no
statement timeout and runs in one transaction through the tenant purge of migration 1270. The Edge Function only
does what SQL cannot: Storage API deletes, the PDF, email and the provider APIs.

## Owner secrets

Set on the hosted project as Edge Function secrets (`supabase secrets set --project-ref <ref> NAME=...`). Each is
optional: without it, that part waits and says why.

| Secret                      | Used for                                                     | Format (example shape only)                  |
| --------------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| `VERCEL_API_TOKEN`          | Adding, checking and removing custom Atlas and Gateway hosts | `<24-character Vercel access token>`         |
| `VERCEL_TEAM_ID`            | The team that owns the Atlas and Gateway projects            | `team_<24 characters>`                       |
| `VERCEL_PROJECT_ID_ATLAS`   | The Atlas Vercel project                                     | `prj_<28 characters>`                        |
| `VERCEL_PROJECT_ID_GATEWAY` | The Gateway Vercel project                                   | `prj_<28 characters>`                        |
| `RESEND_DOMAINS_API_KEY`    | Creating, verifying and removing sending domains             | `re_<32 characters>`, a key with full access |
| `ATLAS_SITE_URL`            | The link printed on deletion certificates                    | `https://<the production Atlas host>`        |

The certificate email reuses the email secrets of `production.md` (`XOS_EMAIL_TRANSPORT`, `XOS_EMAIL_FROM`,
`RESEND_API_KEY`, `XOS_EMAIL_ALLOWLIST`, `XOS_EMAIL_DELIVER_TO_ANY`). `RESEND_API_KEY` may stay a sending-only
key; `RESEND_DOMAINS_API_KEY` is the separate full-access key the domains API needs.

Create the Vercel token under the team's account settings with access to the two projects only, and the Resend key
in the Resend dashboard with full access. Rotate both by setting the new value and deleting the old one at the
provider.

## Schedule the worker (OWNER CONFIRMS)

1. Deploy the function: `supabase functions deploy org-lifecycle --project-ref <ref>`.
2. Schedule it every 5 minutes with the service key, as for `report-run` and `upload-scan`
   (`hosted-security-settings.md`).
3. Check: call it once with the service key. A 200 with `{"certificates": [], "domains": []}` means it is
   connected; `select jobname, schedule from cron.job where jobname = 'xos_hourly_org_lifecycle';` shows the
   hourly job.

## Trials

- A new org, and an external account that starts using Atlas, start a 14-day Pro trial with no card
  (`app.subscriptions.trial_ends_at`). Billing owners hear on days 3 and 1; at the end the subscription moves to
  the Access plan in place and nothing is deleted.
- Adding a card runs through Stripe Checkout with `trialEnd` (`@xos/platform` `createCheckoutSession`): Stripe
  holds the charge to the trial end, and the webhook moves the subscription to active, which converts the trial.
  Nothing charges a card before then, and the expiry job never calls Stripe.
- Atlas does not reach Checkout yet (ADR 0035, gaps), so "Add a card" stays disabled in Billing and Plan.

## Deletion and certificates

- Due: day 90 of a cancellation, or the end of a deletion request's 7-day recovery window. The hourly job writes a
  row in `app.deletion_certificates` (kept after the org is gone, read only by the former Owner).
- Legal hold: a held org is marked `held_at` and waits; the purge refuses it too. Releasing the hold lets it go on.
- Storage: the worker lists the org's objects (`app.deletion_storage_objects`) and deletes them through the
  Storage API in batches of 100 per bucket, then records the storage as clear.
- Purge: the next hourly run deletes every row of the org and its Vault credentials, and records the counts.
- Certificate: the worker renders the PDF (tagged PDF/UA, checked by `documents:verapdf`), stores it in the
  private `deletion-certificates` bucket and emails it to the former Owner, who can also download it from Atlas
  (Personal settings, Account) while they belong to any org.

### When a purge is blocked

`blocked_reason` is set and nothing is deleted when the purge would reach rows of another org or rows outside any
org beyond the reviewed few (`app.blocks`, `private.integration_credentials`, `private.rating_releases`). Typical
causes: another org's counterparty, engagement or record grant that names the deleted org, or a partner whose
former clients still hold its support sessions.

```sql
select id, org_slug, due_at, blocked_reason, last_error from app.deletion_certificates
where purged_at is null and (blocked_reason is not null or last_error is not null);
```

Resolve with the owner case by case (the other org keeps its history; the reference usually has to stay), then
clear `blocked_reason` so the next run tries again:

```sql
update app.deletion_certificates set blocked_reason = null where id = '<certificate id>';
```

## Ownership transfer

An Owner offers the org with step-up; the member accepts with step-up (a second factor) within 7 days. Step-up is
`private.require_step_up` in the database and `requireStepUp` in Atlas (`apps/atlas/lib/auth/step-up.ts`), the
seam A77's step-up check plugs into.

## Dunning

From day 21 of dunning the org is read-only for people (billing still writes), and every page shows why. Owners
and Admins see the failed payment from day 0. "Update the payment method" links to Billing and Plan, where the
customer portal will open once Atlas reaches Stripe (ADR 0035, gaps).

## Partners

- A client Owner records standing grants (one read scope, an expiry within a year, the agreement clause) in
  Settings, Security; each is a `record_grants` row, audited in the client's ledger.
- A client org leaves its partner in Settings, Danger zone: brand kept as its own, the partner's access ended,
  billing moved to the org as a 14-day trial of its plan.
- Partner-to-client billing through Stripe Connect is not built: `docs/design/partner-connect-billing.md`.

## White label

- Adding an Atlas, Gateway or sending domain in Settings, White label queues provisioning. The panel "Domain
  setup" lists the DNS records to publish and the state; "Check again" queues another check. Pending DNS is checked
  every 15 minutes for 7 days.
- A downgrade keeps white label and custom domains to the end of the paid period (`app.white_label_grace`), with
  notice to every Owner, then reverts; a trial's white label reverts when it ends, with notice.
- Without `VERCEL_*` or `RESEND_DOMAINS_API_KEY`, domains are recorded as "Not set up" with the reason, and an
  Owner presses "Check again" once the secrets are set.
