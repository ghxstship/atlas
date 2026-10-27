# ADR 0060: Exports of Every Collection and the Export Worker

- Status: Proposed
- Date: 2026-10-23
- Decider: A102 (RRR-146) took the decisions below; the owner deploys the worker as listed under "Owner steps"

## Context

Section 4.6.4 says every list and report exports to CSV, .xlsx and PDF, subject to Section 8.6, and Section 8.6 puts the viewer's email and the time on Confidential and Restricted PDFs. Before A102 (trace rows S4.6.4-04 and S8.6-03, findings A65-006 and A65-016):

- `app.request_export` (0530, fixed in 1380) classified an export's columns, set `export_jobs.watermark` and queued an `export.render` job, but no worker claimed one, so every export stayed Queued. The API's `exportJobs.create` called it; no Atlas page did.
- Report runs wrote PDFs (1126) without any watermark, whatever their columns.
- An export named only columns, with no filters and no source, and the column registry (`private.column_classifications`) lists table columns only. A Restricted column reaches people through masked views (`app.rate_card_lines_masked.rate_minor` and the like), which the registry does not name, so an export of the view would have been classified Internal.

## Decision

### What a collection exports (Atlas, `lib/views/export-sources.ts`)

1. **One registry maps each collection key to one table or view.** The key is the one saved views use (`collectionKeyFor`). Each source names a relation in `app` or, for canon pages, `xpms`, the columns of the page's table view, the URL filters it honors (`?state=Open,Done`, a project key resolved to its id), the filters the page applies itself (Milestones shows Milestone records), the filters on whether a column is set that the page applies by default and a query key changes (Projects hides archived projects unless `?archived=1`; 2381) and, for project tabs and custom object pages, the project or object in the path. A page that switches collections in place (`?section=rfqs` on a project's Procurement tab) maps each section. Relations and columns are typed against the generated database types, so a renamed column fails the typecheck; a unit test walks the import graph of every page and fails when a page renders the view switcher without a source.
2. **An export reads one relation.** The worker reads it as the requester, so the export never shows more than the page could. A page that assembles rows from several tables exports its base relation: identifiers stay identifiers (a vendor's counterparty, a shift's membership) rather than the names the page joins in. Three collections export less precisely than they show: the project Activity and Overview tabs export the org feed the viewer can read (`app.activity_events` has no project), a project's Receipts section exports the org's receipts (`app.goods_receipts` has no project), and My Work exports the viewer's assignment rows.
3. **Headers are written in the requester's language when they ask** (`views.export.columns.<column>`, en-US and es-US) and stored with the export (`export_job_columns.header_label`), so the worker needs no catalog of its own. Values leave as stored: codes as codes, money in minor units beside its currency, NULL as an empty cell, never zero (Section 3.11).

### Classification (migration 2030)

4. **A view column is classified as the column it shows.** `private.export_column_classification` follows a view's rewrite dependencies to the same-named column of each relation it reads, through other views, and to the source a row of `private.view_column_sources` names for a column shown under another name or computed from it (`payroll_line_amounts.amount_minor`, `engagement_resolved.rate_minor`). The registry itself stays a list of table columns: pgTAP 9900 holds that no Restricted column in it is selectable by `authenticated`, which a masked view column is by design. pgTAP 2030 fails when a new view reads a classified column without a same-named column or a `view_column_sources` row.
5. **A filtered column counts toward the classification**, since filtering on a Restricted rate discloses it as surely as exporting it.
6. **Medical encounter data is refused through any relation that reads `app.medical_encounters`**, directly or through views (Section 14.3), not only its treatment notes column.
7. **An export names existing columns of one relation.** The four-argument `request_export` the API calls keeps its body and rules and now refuses unknown or mixed columns at once, rather than queuing a job no worker could render; it accepts `xpms` columns, which the frozen `ExportJobCreate` description (`app.table.column`) does not exclude.

### Recording filters (ADR 0002)

8. **Filters are rows of `app.export_job_filters`, not a JSON column.** ADR 0002 keeps JSON for rich text, audit diffs and provider payloads; a filter is a column, an operator (`eq`, `in` or `search`, and since 2381 `is_null` or `not_null`, which compare no value) and a value, like `app.report_filters`. The overload `request_export(org, format, label, columns, headers, filters)` takes the filters as a JSON argument and writes the rows in the same transaction that queues the job, so the worker never sees a job without its filters. A person reads their export's filters and columns and writes neither.

### The worker (`supabase/functions/export-render`, `@xos/data/export-renders`)

9. **The report worker's loop.** `app.claim_export_renders` claims jobs with `app.claim_jobs` and moves each export to Rendering in the same transaction (a job whose export is gone or finished is finished at once); `app.export_job_rows` reads the recorded columns, scope, filters and search as the requester (security invoker, switched to their identity for the one query, as 1050's `report_run_rows`) and is stable, so a read replica serves it with GET (1512) and the primary answers when the replica lags. It answers the rows as one jsonb array, not a set (2360): PostgREST caps a set-returning function at `max_rows` (1,000), which would cut every larger export to 1,000 rows without its note; `app.finish_export_render` records Ready with the export's own file, its row count and a 7-day expiry, or Queued again while the job has attempts left and then Failed, with the reason the requester sees.
10. **Files.** CSV fields are neutralized against formulas (A69-005). The .xlsx is one sheet, header frozen, numbers as numbers. The PDF is the report table renderer (`renderTablePdf`, shared with report runs). A file stops at 50,000 rows (2,000 for a PDF, meant for reading) and says so.
11. **The watermark** of a Confidential or Restricted PDF, in the requester's language and time zone, is stamped on every page twice, light and diagonal across the page and legible in the bottom margin, and written into the document's Keywords. CSV and .xlsx carry none (Section 8.6 names PDFs and images).
12. **Report PDFs** are watermarked when the columns a run reads classify above Internal, by the same rule as exports (`app.report_run_classification`), with the email of the person the run is for and the time in UTC.

### Downloads and expiry

13. **Only the requester downloads the file, and only while its classification allows it now**: the `export-files` storage policy and `app.record_export_download` both ask for `data.export.confidential` for a Confidential export, and `data.export.restricted` with an aal2 session for a Restricted one, as 1380 asks of classified attachments. Each download is logged in `app.file_access_log`. The link is a signed URL that lives 60 seconds.
14. **Expired files are removed by the worker before their exports are marked Expired** (`app.expired_export_files`, `app.mark_export_expired`), so a failed removal is retried and no file outlives its export's record.

### Scheduling

15. **pg_cron calls the worker every minute, only when there is work** (a ready `export.render` job or an expired file), through the functions URL and worker key in Vault (`private.request_export_render`), as 1542 calls fx-rates-ecb. Without the secrets it does nothing and exports wait.

### The Atlas control

16. **The Export menu sits in the one view switcher** (`components/views/collection-export.tsx`, one line in `collection-views.tsx`), so every collection that renders it exports its current view. A `step_up_required` refusal opens the A77 step-up dialog and verifying asks again. The menu follows the export in a toast (fixed, so nothing moves on the page) and downloads the file when it is ready. Its wrapper carries `data-shortcut="view.export"` for the keyboard shortcut.

## Alternatives considered

- **An export view per collection**, joining the names each page shows: about 140 views to keep in step with the pages, each needing its own classification and grants. Rejected for this release; a source can move to such a view later without changing the worker.
- **Listing masked view columns in `private.column_classifications`**: breaks the registry's meaning (columns no signed-in role can select) and pgTAP 9900.
- **Rendering in Atlas** on request: a large export would hold a request open past the platform's limits and skip the read replica.

## Owner steps

- Deploy `export-render` with the other functions. The Vault secrets `xos_functions_url` and `xos_worker_key` that `xos_fx_rates_ecb` uses are the ones the export schedule reads (`infra/runbooks/production.md`, Exports).

## Consequences

Every collection that renders the view switcher exports its view, queued exports complete, and Confidential and Restricted PDFs, exported or reported, name their viewer. Uploaded PDFs (the rest of S8.6-03) are A103's.
