# ADR 0151: Payables, Credits, Reimbursements and Act Costs

- Status: Accepted, pending the owner's confirmation of the steps below
- Date: 2026-10-31
- Decider: B12 (RRR-236), from the competitor parity audit the owner approved on 2026-10-28
- Gaps: G-184, G-186, G-195, G-223, G-224, G-228
- Migrations: 3010 to 3018

## Context

The parity audit found six finance gaps that the deferred theme "payables, credits, reimbursements and act cost
roll-ups" groups together:

- An expense amount must be positive (`expenses_amount_positive`, 0321) and there is no Credited state, so a refund or
  vendor credit against an approved expense had no place (G-223).
- A field crew member who paid out of pocket (decision 76) had no way to say so, and nobody could see who is owed what
  (G-228).
- A purchase order carried only payment terms, with no deposit and balance schedule (G-195).
- Nothing listed what the org owes and when: bills, deposits, balances, settlements, per diems (G-184).
- Nothing warned on a second expense or order for the same thing (G-224).
- The cost of an act is spread over settlements, bills, travel, rooms, catering, per diems, expenses and orders, with no
  roll-up (G-186).

Decision 20 and ADR 0029 item 3 hold throughout: XOS records money and never moves it. Every "paid" fact below is a
manual record, with the date and the remittance reference, by a person holding `finance.payment.write`.

## Decisions

### 1. A credit is an expense row naming its original

A credit is an `app.expenses` row with `credit_of_expense_id` set. Its amount stays positive and there is no new
state: the sign comes from being a credit. It sits on its original's budget line, in its currency and with its
counterparty, against a live Approved or Paid charge, and the live credits of a charge that are not Rejected or
Canceled never exceed it. Inserting one needs `finance.expense.write` (the 0321 policy) and the guard adds
`finance.expense.approve` on the project or `finance.payment.write` in the org. The system roles hold them, and Field holds
write only and is refused, so a field crew member cannot use up a charge's creditable amount. The recorder cannot approve it
(`sod_expense_submitter`).

Approval keeps the charge's eligibility and spend authority, then posts the reversal of what the original actually
posted: Accounts Payable debited, and the account and every dimension of the original's posted debit line credited,
dated the credit's own `incurred_on`. An Approved or Paid credit stays out of Trash, because its reversal stays Posted and
Actual would spring back (`expense_credit_posted`), and a credit keeps its original's vendor. Actual (`app.budget_line_amounts.actual_minor`) is approved and paid charges less
approved and paid credits, so every budget read, budget versus actual, the final cost report and B13's EFC and actual
drill-down read Actual net of credits.

A credit's insert emits `expense.submitted` and its approval `expense.approved`, each with the positive amount, as any
expense does; see API v1 below.

A refund after a production closes goes through a journal entry: invariant 10 holds for credits too. A credit against
a reimbursable expense that was already reimbursed is refused, because the refund is the payer's.

### 2. Reimbursements are their own records

A reimbursable expense (`is_reimbursable`) is Recorded while Proposed, Owed once approved and Paid once a reimbursement
is recorded. `app.expense_reimbursements` holds the payment: payee, currency, the net amount at recording (each
amount less its approved credits), the date and the reference. It is not `app.payments`: payments to people need an
individual engagement (1120, `derive_payment_org_id`), and `app.form_1099_nec_rows` (1306) counts payments to people for
work, which a reimbursement is not. A reimbursable charge reaches Paid only through a reimbursement, and a void returns
its expenses to Approved, the only use of the new Paid to Approved rule.

Recording is one step. An invoice payment is recorded and then approved by someone else (1123, `sod_vendor_payment`).
A reimbursement and a per diem payment are recorded by one `finance.payment.write` holder, with only the payee
excluded (`sod_reimbursement_payee`). This is a deliberate choice under decision 20: XOS moves no money, and the payer's
own bank holds the second control. The owner is asked to confirm it (step f).

R3's Reimbursed offering mode (2620) for an engaged party settles through `app.submit_engagement_invoice`, not through
reimbursable expenses. B12 reimbursements are for the person who filed the expense.

### 3. A per diem payment is recorded on the per diem

`app.per_diems` gains `paid_on` and `paid_reference`, written only by `app.record_per_diem_payments` and
`app.clear_per_diem_payment`. Once paid, a per diem keeps its amount, day, worker and allocation and stays out of Trash
until its payment is cleared.

### 4. Read models are definer functions that name every capability they read

`app.payments_due`, `app.reimbursement_balances`, `app.owed_reimbursable_expenses`, `app.po_instalment_schedule`,
`app.engagement_cost_items` and `app.engagement_costs` are security definer functions with an explicit gate, so a reader
sees the complete figure or none, never a partial sum under row level security. PostgREST also caps every answer at `max_rows`
without an error (ADR 0044), so the repositories read these functions page by page (`packages/data/src/all-rows.ts`), and
a page that fails fails the whole read. A definer function is not a way around a
role check, so each gate names every capability whose rows the function reads:

- `app.payments_due` needs `finance.payment.read`, `finance.invoice.read`, `finance.expense.read`, `procurement.po.read`
  and `crew.time_entry.read` at organization reach (`private.can_read_payments_due`).
- `app.reimbursement_balances` and `app.owed_reimbursable_expenses` need `finance.payment.read` and `finance.expense.read`
  at organization reach (`private.can_read_reimbursements`).
- `app.engagement_cost_items` and `app.engagement_costs` need `finance.invoice.read`, `finance.expense.read`,
  `procurement.po.read`, `crew.time_entry.read`, `hospitality.fulfillment.read` and `opportunities.engagement.read` on the
  project (`app.can_read_engagement_costs`).

Owner, Admin, Manager and Member hold all of these at organization reach (0203). Each has an `app.can_*` function, and
Atlas decides its tabs by those, never by holding one capability at any reach. They return person ids, never names:
names come through `app.person_names`, and a person it hides keeps the id and reads as Individual.

Where one reader may see some columns and not others, those columns are NULL with an `is_*_withheld` flag beside them
(the 2810 silence rule). The payment schedule withholds the bill from a reader without `finance.invoice.read` and the
payments from one without `finance.payment.read`, and without the latter its status stops at Invoiced, since Part paid and
Paid would read out the payments. `app.expense_balances` withholds the credit figures from a reader without
`finance.expense.read`.

Purchase order instalments never exceed the order's known total: lines, approved PO change orders, tax and shipping, since
a deposit and a balance are paid on the gross. Unbilled means `invoice_id` is NULL or its bill is Canceled or soft-deleted,
everywhere. A Closed order allows exactly two changes, so a bill arriving after close can be linked and an unbilled
instalment does not stay overdue forever: moving `invoice_id` from an unbilled state to a valid bill, and soft-deleting an
unbilled instalment. A Canceled order changes nothing.

The payments-due ledger is complete. Approval credits Accounts Payable (1611), so an Approved, non-reimbursable charge
that is not a credit is owed at its net of approved credits (kind `expense`), and an Approved reimbursable charge with net
above zero is owed to its submitter. Both are due from the local date of their approval in the project's time zone, and
a voided reimbursement keeps its original due date. A reimbursable charge credited to net zero reads Not owed, and
cannot be paid (`expense_reimbursement_expense`). A crew member cannot read finance's credits, and Compass derives status
from state alone, so Compass can still read Owed to you on one; its help article says so.

A bill linked to an instalment of an Approved, Sent or Closed order appears once, as the instalment. A bill matched to
an order (`app.invoice_matches`) and linked to no instalment would otherwise sit beside the order's unbilled instalment for
the same money, so the order's unbilled instalments, in number order, consume those bills' totals, with
`billed_offset_minor` saying what was taken off.

`paid_minor` on a reimbursement is a recorded money fact, not a derived one: credits are refused once a charge is
reimbursed, so it cannot drift from its expenses. Its name sits outside lint 1282 by design.

### 5. Cost attribution order

An act's cost item belongs to exactly one engagement, found in this order: its allocation (the allocation's engagement,
or its roster entry's), then an explicit `engagement_id` or `roster_entry_id` column, then the person it names (their
accepted roster entry's engagement, else their own engagement on the project, Active first). Internal crew are not
acts. Settlement withholding counts as cost: the org still pays it, to the tax authority.

Overlaps that remain, by design:

- A cost recorded both as a travel segment price and as an expense or purchase order line attributed to the engagement
  counts twice. Attribute an expense or a line only to costs no other record holds.
- Lodging is nights times the block's nightly rate per assignment, so a shared room counts once per person.
- Hospitality counts only Catering and Amenity fulfillment lines; Travel and Lodging fulfillments are costed through
  their segments and rooms.

### 6. Duplicate warnings warn and never block

Look-alike expenses (an alike vendor at 0.85 name similarity, or the same submitter with no vendor; within 1% and 7
days) and purchase orders (an alike vendor; totals within 1%; created within 30 days) are shown before approval and
payment. They never refuse anything, and they return only rows the caller can read.

### 7. Bills offset settlements by amount

`app.submit_engagement_invoice` (0765, 1122) lets an engaged party bill its engagement, with no link between a bill and a
settlement, so an agency that invoices its settled fee would otherwise be owed and costed twice. An earlier version hid
the whole settlement when any bill existed, so a 50.00 bill hid a 50,000.00 settlement. Bills now offset by amount, per
engagement and currency:

- In the payments-due ledger, Accepted and Paid settlements consume what the engagement's live, non-Canceled payable bills
  total, in order of `settled_on` (nulls last), then id, each at its net (`private.settlement_total`). An Accepted
  settlement lists the part above that, with `billed_offset_minor` beside it, and is left out at zero. Unknown billed, an
  unpriced settlement or an unpriced earlier settlement gives NULL (Section 3.7).
- In an act's cost, a settlement counts in full, withholding not subtracted, and its Approved and Disputed bills, in order
  of `coalesce(issued_on, due_on)` (nulls last), then id, count only the part above what its Accepted and Paid settlements
  count in that currency (`counted_minor`). So Guarantee 1000 and Withholding 300 with a bill of 1000 or of 700 costs 1000,
  and with a bill of 1200 costs 1200. An unpriced bill, an earlier unpriced bill or an unpriced settlement gives NULL, and
  a window sum that skipped NULL would hide it.

The roll-up never reads `engagements.agreed_rate_minor` (Restricted, 0700), so an act with no bill and no settlement shows a
total without its fee, and says so. `po_lines.engagement_id` attributes a whole line, so G-186's "backline share" is a line
of its own, or the whole of a shared line: a share of one line is not expressible, a known limitation.

An item with no price has no currency either, so it could be in any of the act's currencies. Its component reads NULL on
every row of the engagement rather than 0, and Atlas lists the item on every row's drill-down, since it is what makes the
total Unpriced. An act with nothing priced has one row with no currency, and its figures are not amounts.

## API v1

API v1 is frozen, so the Expense component gains no field and no operation is added. `budget_lines.actual_minor` and the
budget summary net credits, with the same shape. `GET /expenses` lists a credit as a positive expense,
`POST /expenses/{id}/approve` approves it, and `expense.submitted` and `expense.approved` keep their payloads, so neither
the API nor a webhook subscriber can tell a credit from a charge. A void emits `expense.state_changed` from Paid to Approved
and no `expense.approved`. New refusals reach the API as 422 through the existing rule mapping. This is a known v1
limitation: an additive read naming the original is the follow-up, not part of B12. The warehouse delivery (1401) carries
the new columns through the column registry.

## Owner steps

When the PR is reviewed, confirm or amend:

- (a) A credit is an expense row naming its original, with no Credited state; a refund on a closed production goes
  through a journal entry.
- (b) Reimbursements are their own records rather than `app.payments`, so `app.form_1099_nec_rows` never counts them and
  they post no journal entry.
- (c) Settlement withholding counts in an act's all-in cost.
- (d) Approved non-reimbursable expenses and reimbursements are due from the day of first approval in the project's time
  zone.
- (e) The amended overlap rule of item 7: bills offset settlements by amount per engagement and currency, in the ledger
  and in act cost, replacing the rule where any bill hid the whole settlement.
- (f) One-step recording of reimbursements and per diem payments (item 2), unlike invoice payments, which need a second
  approver (`sod_vendor_payment`).
- (g) The known API v1 limitation above.
- (h) Deposit and balance scope: supplier deposits and balances are PO instalments, while an act's deposit and balance stay
  engagement bills with due dates or a settlement, with no new engagement schedule table.

Nothing else is needed from the owner to build or test B12: no secrets, keys, accounts, settings or provider set-up.

## Consequences

- Finance > Payments gains Due, Reimbursements and Act costs tabs; the settlement and engagement peeks gain an all-in
  cost; the purchase order record gains a payment schedule and line attribution; expenses gain credits, the reimbursable
  flag, an act and look-alike warnings; Crew > Per Diems shows paid dates; Compass gains the "I paid this myself" switch.
- API v1, its OpenAPI document and frozen digest are unchanged. No settings, notification kinds, event types or Edge
  Functions are added.
- `app.submit_expense_receipt` keeps one signature with a trailing `p_is_reimbursable`. The migration ships before any
  Compass build that sends it: an older server refuses an unknown argument (`sync_argument_unknown`).
