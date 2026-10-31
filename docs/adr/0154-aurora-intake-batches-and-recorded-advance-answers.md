# ADR 0154: Aurora Intake Batches and Recorded Advance Answers

- Status: Proposed (amends ADR 0051's consequences and ADR 0100)
- Date: 2026-10-31
- Decider: Owner, on B15's proposal (RRR-239; parity gaps G-59, G-177, G-225, G-173, G-240; owner approval 2026-10-28, fast-forwarded 2026-10-30)

## Context

ADR 0051 put Aurora's features behind entry points that confirm before they write, one suggestion at a
time through `aiSuggestions.confirm`, and P6 added drafted lists, confirmed as a whole only while the list
is empty. The parity audit asked for five more uses: itineraries read into travel segments, booking
contracts and riders read into Artist engagements, invoice and receipt lines with a tie-out against the
printed totals, advance answers drafted from what a party sends, and event plans, briefs, approval packs
and waste plans. Four questions had no recorded answer:

- How many files one person reads at once, how each is metered, and how their rows are written: one by
  one would let a preview half-apply, and a second confirm would race the first.
- Who may record a typed advance answer. R9 (ADR 0100) made typed answers the recipient's own act; a
  coordinator could already record a Text answer through `advanceSubmissions.create`.
- How a Restricted value Aurora reads, a contract's fee, is kept from people who may not see pay rates
  when suggestions are readable by audit.log.read holders.
- What a deterministic check such as the tie-out may decide.

## Decision

1. **Intake batches.** `app.ai_intake_batches` (3040) is the subject of the extraction requests that read
   many files into one preview: up to 25 files, one metered request each, checked against this month's
   allowance before the first is read. `t41_guard_intake_request` holds a request about a batch to its
   creator, while the batch is open (`aurora_intake_closed`) and below its file count
   (`aurora_intake_full`); a Failed request does not count, so a file can be read again, metered again.
   The refusal aborts `app.ai_begin_request`, so no request or usage row is left. A batch is applied by its
   own RPC in one transaction (`app.apply_itinerary_intake`, `app.apply_contract_intake`), which rejects the
   rows left out and closes the batch.
2. **Batch-applied suggestions.** Instead of redefining `app.transition_ai_suggestion` again (2830), the
   trigger `t13_aurora_batch_apply_only` refuses confirming a suggestion of an intake batch, or of a
   drafting request about an advance recipient, outside the trusted operation `aurora_batch_apply`
   (`ai_suggestion_batch_apply`). Rejecting one stays allowed. The suggestions name real public
   operations: `aurora.applyItineraries`, `aurora.applyContracts`, `riders.create`, `riderLines.create` and
   `aurora.applyAdvanceAnswer`. Every resource names its own op, so the batch operations are
   `auroraIntakes.start`, `get`, `close`, `checkItineraries`, `applyItineraries` and `applyContracts` under
   `/aurora/intakes`. A segment the traveler already has as a live segment of the org (same service and
   departure) refuses the whole apply (`itinerary_duplicate`), so the preview asks `checkItineraries`
   whenever a row's traveler, service or departure changes and starts such rows unchecked. The check reads
   `app.travel_segments` in the caller's session: it is a hint, and the apply still decides.
3. **Direct bookings.** Contract intake books Artist engagements at Onboarding without an application or an
   offer (Section 4.4.4 stages 3 to 5): the signed contract stands for the accepted offer. The person sets
   the party (a person the org already holds, an account, or both), the role, the worker classification,
   the pay basis and the arrangement, as one canon rate card row with a non-employee classification for
   the batch; Aurora proposes none of them. `engagements.create` in API v1 is unchanged. The engagement
   guards and the `active_external_engagements_per_month` plan limit apply as for any engagement.
4. **Restricted fee proposals.** A contract's fee is asked of the model only when the database says the
   caller reads pay rates (`app.my_capabilities_on_project`), never from a client flag; otherwise it is
   NO_ANSWER. `app.ai_propose_suggestion` marks such a field with `restricted_capability` itself, from
   `private.ai_restricted_fields`, and refuses a value from a caller without the capability
   (`aurora_field_restricted`); a marked field is hidden from anyone without it, audit.log.read holders
   included. Only a field with a value or an excerpt is marked, since an excerpt can quote the fee: a
   NO_ANSWER fee with neither stays readable, so the reason it was not read ("Fees are read only by
   someone who may see pay rates.") reaches everyone who may read the suggestion. The logged output shows `[Restricted]` for the fee and its excerpt, and every money amount of
   a contract's other excerpts is withheld the same way, since a date excerpt can quote the fee. Applying
   a fee without the capability refuses `intake_fee_restricted`. A person-chosen document may contain
   values that become Restricted once written; reading the document is not reading a Restricted column
   (S4.7-10).
5. **Recorded advance answers (amends ADR 0100).** Any advancing.submission.review holder in an org with
   Aurora may record a typed answer on a recipient's behalf from a confirmed Aurora draft, including
   Requested allocations (origin `request`), through R9's single writer `private.record_advance_answer`,
   so lines, offerings, caps and the one open answer rule hold. Its provenance is
   `app.advance_answer_drafts`: the suggestion and the source, a project inbox message or a file name.
   The recorder becomes the answer's submitter, so separation of duties needs a second reviewer, and an
   org with a single reviewer cannot accept such an answer. Provenance is as trustworthy as the recorder,
   because Aurora artifacts are caller-written. Gateway labels the answer "Recorded by {org}", and "from
   an email to the project" when it was read from mail, since project inbox mail can come from anyone; an
   open answer blocks the party until the org returns it.
6. **Inbox mail as a source.** Only a DKIM-verified, live Project Inbox message the caller can read, of the
   packet's or batch's project, is a source, checked again in the caller's session before any metering
   (`aurora_draft_source_invalid`). Its body reaches the model as a text/plain document, which the request
   log records as `[document text/plain]`, never as text: the log is readable by audit.log.read holders
   across the org while the mail is readable only on the project. Excerpts still reach the suggestion
   fields, as for any document. Passport numbers and expiry, dates of birth and known traveler numbers are
   withheld from every excerpt and log (ADR 0033 item 38).
7. **The tie-out is advisory.** `@xos/ai/tieout` computes the lines against the printed totals with the
   rounding of `private.extended_minor`, on the server and on every edit in the panel. A nonzero residual
   must be acknowledged in the panel before the lines are added; the acknowledgment is not stored and the
   database never refuses a line for a residual. A currency other than the invoice's is flagged.
8. **Vendor history is a hint.** `app.vendor_line_history` (security invoker) shows the same vendor's
   earlier invoice and purchase-order lines beside each read line. It never returns or sets a budget line
   or a tax rate: the budget line always comes from the person.
9. **Governance drafts.** Event plans, briefs, approval packs and waste plans are prose drafts with subject
   null (a drafting request about `app.projects` is P6's drafted risk list), read from the project's own
   records through the caller's permissions and held to a fixed outline in the person's locale. An
   insurance certificate belongs to a vendor, not a project, so an approval pack sends only the
   certificates of the project vendors: the vendors of its purchase orders and of its live Vendor
   engagements. "Save to
   project documents" files the Markdown as a project document whose first line is the AI label; the file
   becomes the document's first version once it scans Clean.

## Consequences

- ADR 0051's confirm-one-at-a-time rule now has two exceptions besides P6's drafted lists: intake batches
  and drafted advance answers, each applied only by its RPC.
- ADR 0100's "typed answers come from the recipient side" gains the producer-recorded path above; the
  party sees it labeled and may ask for it to be returned.
- Mail as a source works in production only once the inbound domain of decision 60 is live; until then the
  mail lists are empty and file sources work.
- The handler asks the model for a fee when the caller reads pay rates on the batch's project
  (`app.my_capabilities_on_project`), while storing and reading the fee need the capability across the
  org (`private.has_capability`). Someone who reads pay rates only through a project role is asked for
  the fee, and storing it then refuses `aurora_field_restricted` after a metered request. Open: an
  org-wide check the API can call would close the gap.
