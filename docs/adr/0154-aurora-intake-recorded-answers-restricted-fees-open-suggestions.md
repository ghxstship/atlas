# ADR 0154: Aurora Intake: Answers Recorded for a Recipient, Restricted Fees and Open Suggestions

- Status: Proposed
- Date: 2026-11-06
- Package: B15, RRR-239; parity gaps G-59, G-173, G-177, G-225, G-240. Extends ADR 0051.
- Migrations: 6270 to 6275, and the notification seed 3049.

## Context

Aurora read one document at a time into one form. The owner approved closing five gaps: itineraries into travel segments,
contracts and riders into bookings, invoice lines with a tie-out and vendor history, advance answers drafted from a reply, and
event plans, briefs, approval packs and waste plans. Each write stays a person pressing a button. Six decisions shape it.

## Decisions

### D1. Who holds the pen on an AI-drafted advance answer

`app.submit_advance_answer` allows only the recipient side, and `private.record_advance_answer` is its one writer. The org side can
already create Text answers: `advanceSubmissions.create` needs `advancing.submission.review`. B15 extends that same capability to
Text, Schedule Window, and non-per-person Item Request and Credential Request answers, recorded by the person who accepts the
draft through `app.record_drafted_advance_answer`.

These hold without new rules: `created_by` is the accepter, so `sod_advance_submitter` stops them reviewing it and a second person
must. Item and credential lines become Requested allocations through `private.insert_allocation` with the accepter as requester.
Offerings, caps and `advance_answer_pending` hold because the writer is the same one.

Producing a request for a party is `advancing.packet.write` in R7's `app.request_allocation`, so Item Request and Credential Request
sections are offered and accepted only with both `advancing.submission.review` and `advancing.packet.write`. A holder of review
alone sees Text and Schedule Window. Those two sections are left out for a recipient with no engagement.

B15 adds what makes this safe to approve: the source and its excerpt on `app.advance_answer_sources`, which any packet reader
sees; `recorded_by_producer` on `api_external.advance_submissions`, with a plain sentence in Gateway; and a notice to the
recipient side, `advance_answer.recorded`.

Never drafted: Guest List (the recipient's own confirmation), File (the prefix check in `record_advance_answer` requires a
party-uploads path), Crew Roster (`advance_section_derived`), any per-person section and any project fact. Advancing decision 0/1 and
ADR 0100 decision 1 stand: the person enters their own sizes, airports, travel preferences and vehicle, and Aurora neither reads
nor writes `app.roster_travel_requests` or another project fact. The model never receives the roster.

Suggestion fields are not proof, because any asker can propose any fields on their own request. The RPC requires the request to
have feature drafting and subject `app.advance_recipients`, and the suggestion's target to be the section. For mail it reads the
message again: purpose Project Inbox, the packet's project's inbox, Verified or Filed, not discarded, and
`knowledge.document.write` on the project, with the excerpt found in `private.ai_redact(body_text)` after whitespace
normalization. Verified only means the sender's DKIM passed for any domain, so every source list and card shows `from_address`. A
PDF or image cannot be held to an excerpt, so its card says to check it against the file.

If the owner prefers recipient confirmation, this is the one decision to change.

### D2. A fee read from a contract is Restricted

`app.engagements.agreed_rate_minor` is Restricted with `data.restricted.read.payroll`, but suggestion rows are readable by
`audit.log.read` holders and `ai_requests.output_redacted` keeps a model's output. So:

- A fee and its currency (`agreed_rate_minor`, `agreed_rate_currency_code`) are asked of the model only for a holder of that
  capability; for anyone else they are absent from the tool schema and the prompt.
- `t40_guard_ai_suggestion_field_restricted` refuses those paths (`ai_field_restricted`) without the capability, and the read
  policy of `app.ai_suggestion_fields` hides them from every other reader.
- The contract kind logs output as a fixed sentence with counts and no model text, and its `missing` values are fixed sentences.
- Any other contract field whose value or excerpt holds a money amount becomes NO_ANSWER and stores no excerpt.
- A contract's file is raised to Restricted right after upload, because `app.attachments.classification` defaults to Internal. If
  the raise fails the attachment is removed and the row says so. A rider's file keeps the default.

Canon has no Flat Fee rate card row and no artist role, and `agreed_rate_minor` is per pay basis unit. So the printed total is shown
read-only to a payroll reader and prefills the input only on a Flat Fee row. With today's canon a booking from a contract stores no
flat fee, and the person types a day rate or leaves it empty. Adding those rows is a canon decision for the owner, as in 1230.

### D3. No batch table

Requests already carry a subject, and suggestions already last 7 days and belong to the asker. An intake is its open suggestions:
requests with feature extraction and subject `app.projects/<project>`. Reloading resumes the review through `aurora.openProposals`
without a model call. P6's transition guard keys on feature drafting, so these requests are not reserved. Nothing new is retained
or purged.

### D4. Files are not stored until confirmation

Contract files stay in the browser until they are added, then attach to the `app.engagement_documents` row each document became
(`app.apply_contract_intake` returns its id per suggestion), so the row and its file stay together. A resumed review has lost the
bytes, so it offers Attach File on that row. A failed upload is reported on its row, and the booking stays.

### D5. Proposal operations that name no handler

`travelSegments.create`, `engagements.createFromContract` and `advanceAnswers.record` name no API handler. The generic
`aiSuggestions.confirm` calls `performSuggestion`, which returns `ai_suggestion_operation_unavailable` and moves the suggestion back
to Proposed, so they can be applied only by their RPCs and `app.transition_ai_suggestion` needs no redefinition. `invoiceLines.create`
is a real operation and stays; its panel applies it through `app.apply_invoice_line_suggestions`, because a line suggestion belongs to
an invoice only when the `invoices.create` suggestion of its request was saved as that invoice.

### D6. Inbound mail is not live

`infra/runbooks/production.md` records that Resend refused `inbound.ghxstship.tech` at the plan's domain limit. B15 builds and tests
against `app.inbound_messages` rows with fakes, the mail source shows its empty sentence until the owner step is done, and the file
source works from day one. S4.6.5-03 stays Partial. A forward used to reach nobody, because `stripQuotedText` stops at the first
"From:" line, so `receiveInbound` now strips only reply addresses and project inbox mail keeps its full text. `inbound-email` is
rebundled for this one change, within its ceiling. Attachments on inbound mail stay out (ADR 0040 follow-up).

## Other changes

- A tool call stopped at `max_tokens` now fails with `model_output_invalid` and stores nothing for every extraction kind, including
  rider, quote and insurance certificate, because a cut-off list would give a false residual. So a long rider now fails instead of
  proposing part of it, with a plain "too many lines" message in the rider panel and the extract panel.
- Itinerary and invoice or receipt lines use a compact schema, one excerpt and confidence per line, because the extraction token limit
  fits only about 7 lines in the per-field shape. A document proposes at most 40 lines after passengers are expanded.
- A zone is inferred from a place, so its confidence is clamped to 0.5 in code, and only Area/Location names and UTC are accepted:
  `Intl` takes "+05:00" and "EST", which `private.assert_time_zone` may refuse, and one refusal rolls back a whole batch.
- Printed tax becomes one more line, because `app.invoice_totals.tax_minor` comes only from a tax rate no Atlas screen sets, and a
  rate would not round alike. The person may uncheck it. The residual is computed in `app.invoice_tie_out`, never stored, and never
  blocks approval or posting.
- A year a date does not print is the first such date on or after today in the project's own zone (`inferYear`), and an arrival's is
  the first on or after its departure, so a Dec 31 to Jan 1 flight is one night.
- A party or traveler is preselected only on one exact match after normalizing (`matchExact`). There is no fuzzy preselection.

## Consequences

An accepter can fill a section a recipient has not answered, and `advance_answer_pending` then holds the recipient back until the
answer is returned. The notice and the Gateway sentence say so. Governance drafts need `app.record_document.body`, because a Document
record held only a storage URI and a version label.

## Merge notes for the train

- R10 replaces `api_public.preview_advance` at 4730 on origin/batch-c. Append `recorded_by_producer` to R10's latest answer and show the
  Gateway label on the token page too; otherwise a token recipient sees an answer they did not write with no explanation.
- B5's `/hospitality/travel` page is not on this stack. Also mount `ItineraryEntry` there; it takes only `projectId` and `fulfillmentId`.
