# ADR 0051: AI Entry Points in Atlas

- Status: Proposed (amends ADR 0020)
- Date: 2026-10-21
- Decider: Orchestrator, on A95's proposal (RRR-140, finding A65-020, work package WP19)

## Context

Section 4.7 lists six Aurora features, and the API serves all of them (`aurora.ask`, `.filter`,
`.extract`, `.draft`, `.summarize`, `.mapColumns`, `.bindCode`). Finding A65-020 found that Atlas called
only `ask` (the assistant panel) and `extract` for riders and insurance certificates. Customers pay for an
Aurora allowance on every paid plan (ADR 0020), and most of it had no button.

Every entry point has to keep the Section 4.7 guardrails: it is gated by the org's AI Features switches
and the plan, it shows what will be sent, it confirms before writing, it shows the result as an editable
proposal, it explains a refusal, a timeout or a used-up allowance in plain words, it is metered, and it
never sends what `app.ai_never_send` excludes. Atlas Projects and project Overview sit close to the 200 KB
route budget (ADR 0027), so nothing heavy may load with a page.

Writing the entry points showed four mismatches between the features and the API:

- The proposals of invoice, receipt and quote extraction and of code bindings named fields the write
  operations do not take (`currency` for `currency_code`, a bid's `notes`, a binding's `tenant_item_code`).
- The handler resolved relative dates on the UTC date, a day ahead every evening in the Americas (A71).
- A filter could only use a collection's API fields, while each Atlas page filters by its own query
  parameters (`state`, `q`, and so on), so a filter the person applied could not be the page's filter.
- Nothing showed what a draft or summary would send: the handler reads the named records itself.

## Decision

1. **Gating.** The Atlas shell reads `app.ai_enabled_features` (switch on and plan includes Aurora) once
   per request (`lib/aurora/features.ts`) and hands it to every client entry point (`useAiFeature`). An entry
   point whose feature is off renders nothing, also in the first paint. Each panel checks `aurora.status`
   again when it opens and says why it cannot run (not in plan, turned off, allowance used up). The API stays
   the authority: `app.ai_begin_request` still checks membership, plan, switch and allowance and meters every
   request (ADR 0020 item 3).
2. **What will be sent.** Every panel lists what Aurora receives before the person presses "Send to Aurora".
   A new additive operation, `POST /aurora/preview`, reads the records a draft or summary names exactly as
   the request would (the caller's permissions, Restricted columns, masked values and excluded tables
   removed) and returns per record the fields sent, the fields withheld and the values. It calls no model
   and meters nothing.
3. **Confirmation and writes.**
   - Drafts fill the editor's own fields ("Use this draft"); the editor's Save is the write.
   - Extractions fill the invoice, expense or RFQ response form ("Fill the form") and add each suggestion's
     id as a hidden field. The form's save is the confirmation: after it succeeds, the server action moves
     each suggestion Proposed, Confirmed, Applied with the record written (`lib/aurora/suggestions.ts`).
     Lines left out and readings discarded are Rejected.
   - A plain-language filter is applied to the page's query string; nothing is saved, so Aurora's proposal
     to save a view is Rejected with that reason. The person may save the filtered page as a view.
   - Suggest binding writes the catalog binding and resolves the scan intake row (Created) only after the
     person confirms the element and name, then applies the suggestion with the binding.
   - A summary writes nothing; its text can be edited and copied.
4. **A page's own filters.** `aurora.filter` takes an optional `fields` list: the page's query parameters
   with a type, values, one operator each and a sentence for the model. Aurora's conditions are checked
   against it, and a field that names a Restricted column of the collection's table is dropped. Applying
   them rewrites only those parameters, so the filtered page is an ordinary link.
5. **The org's calendar.** The Aurora handler resolves "today" on the org's `locale.time_zone`
   (`readOrgTimeZone`), which A71 already made the rule for org-wide dates. A project's week is read on the
   project's calendar.
6. **Proposals match their write paths.** Extraction fields are the create bodies' names
   (`currency_code`); a quote becomes an RFQ response (`rfqResponses.create`, `rfqResponseLines.create`); a
   code binding proposes `element_id` and `name`. Drafts follow the org's verbiage library terms and their
   casing rules. A gate readiness summary reads the project's next-gate criteria.
7. **Loading on demand.** A page ships only an entry point's button (or the filter field); the panel, the
   AI client and its messages load the first time the person points at or opens it (`components/aurora/entry`).
8. **Plain failures.** The browser client gives up after a per-feature wait (`ENTRY_TIMEOUT_MS`, rule
   `timeout`), and `problemKind` names timeout, quota, not in plan, off, not configured, offline, forbidden
   and refused, each with its own sentence in `aurora.entry.problems`. Results and errors are announced in a
   polite live region.
9. **Where each switch takes effect.** The AI switches are not registry settings, so A76's `enforced_by`
   guard cannot see them. `apps/atlas/lib/aurora/entry-points.ts` lists each switch's consumers and tests,
   and `test/aurora-entry-points.test.ts` fails when one stops naming its feature.
10. **The scan intake queue.** Unknown scanned codes (migration 0367) had no screen. The scan log now lists
    the open ones with Suggest binding and Dismiss.

## Consequences

- The entry points are: a "Filter in plain language" field on Finance Invoices, Expenses and Change
  orders; "Draft with Aurora" in the SOP editor (new and edit), the advance packet's Add section form and
  the change order form; "Summarize" on every work record and on project Overview (this week, gate
  readiness); "Suggest binding" in the scan intake queue; and "Fill from a document" on the invoice, expense
  and RFQ response forms. The import wizard's "Suggest mappings" is A83's.
- `ask-filter` joins the shortcut registry with no default keys; a person may bind it.
- Summaries are on in the demo seed, so the project Overview and record core screens gain a Summarize button.
- Follow-ups: plain-language filters on more collections (each page declares its filters), binding a code by
  hand without Aurora, and Compass entry points.
- Day sheets gained "Draft with Aurora" in their editor (A121, ADR 0080). Atlas 4.0 has no free-text email
  composer: notification, invitation and reminder emails are system templates, advance packet links are shared
  by the coordinator, and the project inbox files or discards inbound mail without replying. Drafting an email
  stays an API feature (`aurora.draft` kind `email`) with no entry point in any shell.
- An empty running order and a project Work tab filtered to Risk gained "Draft run of show with Aurora" and
  "Draft risk assessment with Aurora" (P6, gap G-83). Aurora drafts only into an empty list: a cue with
  deleted_at null fills a running order, and any Risk record with deleted_at null fills a risk list, in every
  record state (Canceled included, since Canceled records are retained and never trashed) and archived or not.
  Each line is a suggestion (`cues.create` or `records.create`) on a drafting request about the list, and
  `aurora.applyDraft` (app.apply_drafted_list) adds the kept lines in one transaction while the list is still
  empty. Those suggestions are applied only by app.apply_drafted_list, never by the operation they name, and
  app.transition_ai_suggestion refuses confirming them one at a time (ai_suggestion_drafted_list).
