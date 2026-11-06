# ADR 0152: Quotes, Budget Versions, Forecasts and Labor Actuals

- Status: Accepted
- Date: 2026-11-06
- Decider: B13 (RRR-237)
- Migrations: 3020 to 3029

## Context

Gaps G-188 (phase 1), G-210, G-205, G-214 and G-133 ask the budget to do four more things: price itself for a client
and send a quote, freeze itself to compare later, forecast its final cost, and take approved crew hours into Actual.
The owner's standing decisions bound the work: XOS never holds funds, budgets never reach clients (S4.4-12), and a
price is NULL until someone sets one (S3.7-02).

## Decisions

### 1. Client prices are derived, and NULL stays NULL

A line's client unit price is its override (`client_unit_price_minor`), else its cost unit price marked up by its own
`markup_bp`, else by the budget's `default_markup_bp`. Markups are basis points: 2500 is 25 percent, 0 to 100000.
Rounding is half away from zero, as `private.extended_minor` rounds (numeric `round`). A line with no cost price and no
override, or with no markup at either level, has no client price, and its client amount and margin are NULL, never
zero. `excluded_from_quote` keeps a line off every client total, quote, external view, token read and PDF. Prices are
derived in `app.budget_line_prices` and `app.budget_price_totals`; only the override and the markups are stored.

### 2. A quote is a separate client document over a frozen capture

A quote prices from one budget for one Client engagement of its project. Budgets never reach the client: a Draft reads
live prices for the org only, and sending captures a Quote budget version (3021). Acceptance is the client's signature
on a Quote engagement document, through a signing link (0769) or signed in to Gateway (0710), reusing S14.5-01. There
is no Paid state, deposit or payment collection, and receivable invoices from a quote are G-190, post-launch.

The canonical content a quote freezes is the jsonb text of:

```
{quote key, version_number, title, client, currency, valid_until, terms,
 lines ordered by line_number (line_number, description, quantity, unit_basis,
   client_unit_price_minor, client_extended_minor),
 total_minor}
```

Its SHA-256, `content_sha256`, is printed on the PDF with the Signature block as tamper evidence. The title and the
client's name are copied to `sent_title` and `sent_client_name` at send, because the fingerprint must keep describing
what was signed after a retitle or a rename. Later client-visible changes go through change orders and client
approvals (0770); acceptance locks the quote.

A signing link's signer is whoever typed the name, even when the browser holds a session, so `accepted_name` is always
the typed name there and `accepted_by` is cleared. How a quote was signed is decided by a used token existing, never by
`accepted_by`. The sender is told once: a link's notification waits for the typed name, and the acceptance trigger knows a
link by 0769's fixed reason wording and an open link together, because a signed-in caller chooses their own reason. A
signed-in signer who words the reason like a link while a link is also open still leaves the sender untold; the quote
shows Accepted live all the same.

A Quote document is not an agreement, and the features meant for agreements leave it out: it carries no `expires_on`
(1463 would remind the client about `valid_until`, the only expiry); it moves Signed to Executed inside acceptance,
because nobody countersigns it (0775 and 1624 would count it in flight forever); it stays off the Compass Profile (2080);
and it is never signed in one click or in bulk, on any Gateway surface (Home, Documents, the engagement's Overview).

A signing link's PDF prints and encodes Gateway's Documents page, never the link: the token is one of the link's two secrets
and the PDF is meant to be forwarded.

### 3. The template's issue time is sent_at

The quote template (ADR 0031 amendment) renders with the version in force at `sent_at`. A Draft preview uses its
`created_at` and says "Draft: not sent" in its facts, with no fingerprint.

### 4. Budget versions freeze plan fields only

`app.budget_version_lines` copies plan fields with the effective markup and client price. Actual and committed are never
frozen: a definer-written copy of committed would leak past P4's `procurement.po.read` withholding (2810). A snapshot
does not replace the gate 3 `is_baseline` budget the final cost report compares against.

### 5. Actual is expenses plus approved labor

`actual_minor` is approved and paid expenses plus approved crew time. Payroll runs post to the journal (0362). Vendor
invoices are in the Transactions drill-down, not in Actual; they post to the ledger and the final cost report reads
them there, so nothing counts twice. An org that also records an agency's invoice as an expense would count that labor
twice; no rule stops it.

Actual follows the live shift's `budget_line_id`. A person with `finance.budget.write` who relinks a shift moves its past
Actual on purpose, and a crew planner without it is refused (`shift_budget_line_posted`). Deleting a shift moves its
posted time to Hours not on a budget line.

### 6. Forecasts are derived, and an approximation is named

- current budget = extended + drawn in - drawn out + approved change order lines on the line
- remaining commitment = greatest(committed - actual, 0)
- ETC = entered `etc_minor`, else greatest(current budget - actual - remaining commitment, 0)
- EFC = actual + remaining commitment + ETC; forward exposure = remaining commitment + ETC

Expenses carry no purchase order link, so spend on a line is taken to consume its commitments first. With no entered
ETC, EFC = max(current budget, committed, actual), which agrees with the canon Playbook FORECAST rule max(budget,
committed) (0150). `greatest` ignores NULL in Postgres, so the derivations test for NULL first: an unpriced line without
an entered ETC, and an unknown commitment even with one, have a NULL EFC. A reader without `procurement.po.read`,
`finance.expense.read` or `finance.change_order.read` would get a partial sum from these invoker views, so every figure
is withheld instead (P4's silence rule). Approved change order lines with no budget line count as both current budget
and ETC in the totals, so total EFC reconciles with `app.budget_revised_totals`.

### 7. Labor postings

Approving a timesheet posts its time to an append-only ledger. It stores what the approval fixed; the worker, team and
project are read through the approval, and a void or a deleted timesheet drops out of every view at once.

- **Rates** apply on the work date. Payroll uses the period end and stays authoritative for pay. A member's rate is the
  latest pay rate for the role. An engaged individual or an agency on an Hourly engagement takes `app.engagement_resolved`'s
  precedence on that date, matching rate cards on the engagement's role, else the posted role (the role may be NULL
  since 1624).
- **Overtime** is split within the timesheet. External and agency overtime is not computed: they bill their own.
- **Unpriced** is never zero. Day Rate, Flat Fee and Salary post minutes with no rate, though 1305's self-billing bills
  Day Rate days. A missing rate never refuses an approval.
- **Not posted:** holiday pay (2270, 2271) and fringes (G-207). Currencies are never converted: a rate in another
  currency is counted, not summed.
- **Team kind** is Agency only when the roster entry's engagement has a counterparty. Roster entries also exist on
  Artist, Vendor, Contractor and Sponsor engagements, with self entries (2633), and those are Engaged.
- **Visibility.** `rate_minor` is Restricted. The per-line aggregate in Actual shows to `finance.budget.read` readers as an
  Internal aggregate, as the journal's payroll aggregates do (0362), so it is deliberately not registered as sourced from
  `rate_minor`. The ledger's rows and the team totals need `crew.timesheet.read`, because hours beside a line's Actual
  would give a rate to a reader who holds only `finance.budget.read`.
- **Remaining risk.** A reader who holds both `finance.budget.read` and `crew.timesheet.read` can still work out a rate on
  a line only one person works. The owner confirms this at release review.
- **Period edges.** Posting reads the project's calendar. The void trigger (2751) and `private.worker_minutes` still read
  UTC days, so editing an entry late on a period's last local evening can leave its posting standing with old minutes and
  no void, and an early-local entry in a UTC window no earlier approved timesheet covers is never posted. Both are to be
  re-checked when the project-day fix lands.

### 8. The frozen API omits Quote

`engagementDocuments` in v1 keeps its `document_kind` enum: its list omits Quote, and get and transition answer 404. A
quote is read through the additive `GET /quotes` and `GET /quotes/{id}`. The catalog is unchanged, because a correction
that changes nothing fails `corrections.test.ts`.

### 9. Phase boundary

Phase 1 of G-188 leaves for later phases, each needing a new package: quote templates with merge tags, sub-quotes,
target-margin pricing, rolled-up hidden lines, adjustment columns (tax, service, discount, freight), VAT and
reverse-charge wording, one link across versions, recorded or offline acceptance, notes per line, margin by client and
producer, and Paid. Film budget formats and hot costs are out. Out, post-launch: G-190, G-194, G-203, G-206, G-207, G-116,
G-218, G-291. Out, skip: G-193, G-209, G-213, G-215. `app.client_approval_requests` (0770) is not extended.

## Consequences

- Every read of a budget computes labor totals, so `app.budget_line_amounts` joins them laterally: the line filter reaches
  the grouped view rather than aggregating every line the reader can see.
- A Sent quote has one link at a time; **Signing link** reissues and revokes earlier ones. A lost link never costs a new
  version.
- A person's email is not readable by the org in general (0860), so the Send form's Recipient email starts blank.
