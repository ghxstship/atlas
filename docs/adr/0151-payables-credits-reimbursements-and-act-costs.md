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
Canceled never exceed it. Only a person with `finance.expense.approve` on the project or `finance.payment.write` in the
org records one, so a field crew member cannot use up a charge's creditable amount. The recorder cannot approve it
(`sod_expense_submitter`).

Approval keeps the charge's eligibility and spend authority, then posts the reversal of what the original actually
posted: Accounts Payable debited, and the account and every dimension of the original's posted debit line credited,
dated the credit's own `incurred_on`. Actual (`app.budget_line_amounts.actual_minor`) is approved and paid charges less
approved and paid credits, so every budget read, budget versus actual, the final cost report and B13's EFC and actual
drill-down read Actual net of credits.

A credit's insert emits `expense.submitted` and its approval `expense.approved`, each with the positive amount, as any
expense does. B12 changes no event payload, so a webhook subscriber cannot yet tell a credit from a charge; an
additive field naming the original is the follow-up. API v1 is frozen: `GET /expenses` lists credits as ordinary
positive expenses. That is a known v1 limitation, and the additive read-only field on the expense resource is the
follow-up for the next API version.

A refund after a production closes goes through a journal entry: invariant 10 holds for credits too. A credit against
a reimbursable expense that was already reimbursed is refused, because the refund is the payer's.

### 2. Reimbursements are their own records

A reimbursable expense (`is_reimbursable`) is Recorded while Proposed, Owed once approved and Paid once a reimbursement
is recorded. `app.expense_reimbursements` holds the payment: payee, currency, the net amount at recording (each
amount less its approved credits), the date and the reference. It is not `app.payments`: payments to people need an
individual engagement (1120, `derive_payment_org_id`), and `app.form_1099_nec_rows` (1124) counts payments to people for
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

### 4. Read models are definer functions behind finance capabilities

`app.payments_due`, `app.reimbursement_balances`, `app.owed_reimbursable_expenses`, `app.po_instalment_schedule`,
`app.engagement_cost_items` and `app.engagement_costs` are security definer functions with an explicit capability gate,
so a reader sees the complete figure or none, never a partial sum under row level security. Where one reader may see
some columns and not others, those columns are NULL with an `is_*_withheld` flag beside them (the 2810 silence rule):
the payment schedule withholds the bill from a reader without `finance.invoice.read` and the payments from one without
`finance.payment.read`, and `app.expense_balances` withholds the credit figures from a reader without
`finance.expense.read`.

Purchase order instalments never exceed the order's known total: lines, approved PO change orders, tax and shipping,
since a deposit and a balance are paid on the gross. A bill linked to an instalment of an Approved, Sent or Closed order
appears in the payments-due ledger once, as the instalment.

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

### 7. A billed settlement is owed and costed once

`app.submit_engagement_invoice` (0765, 1122) lets an engaged party bill its engagement, so an agency that invoices its
settled fee would otherwise be owed and costed twice. The default rule:

- In the payments-due ledger, an Accepted settlement is left out when its engagement has a live, non-Canceled payable
  bill in the settlement's currency: the bill is what is owed.
- In the act's cost, an engagement bill in a currency where the engagement has an Accepted or Paid settlement is listed
  with `counts_in_total` false and left out of the sums.

## Owner steps

When the PR is reviewed, confirm or amend:

- (a) A credit is an expense row naming its original, with no Credited state; a refund on a closed production goes
  through a journal entry.
- (b) Reimbursements are their own records rather than `app.payments`, so `app.form_1099_nec_rows` never counts them.
- (c) Settlement withholding counts in an act's all-in cost.
- (d) A reimbursement is due from the day the expense was approved, on the org's calendar.
- (e) The settlement and engagement-bill rule of item 7.
- (f) One-step recording of reimbursements and per diem payments (item 2).

Nothing else is needed from the owner to build or test B12: no secrets, keys, accounts, settings or provider set-up.

## Consequences

- Finance > Payments gains Due and Reimbursements tabs; the settlement and engagement peeks gain an all-in cost; the
  purchase order record gains a payment schedule; expenses gain credits, the reimbursable flag and look-alike warnings;
  Compass gains the "I paid this myself" switch.
- API v1, its OpenAPI document and frozen digest are unchanged. No settings, notification kinds, event types or Edge
  Functions are added.
- `app.submit_expense_receipt` keeps one signature with a trailing `p_is_reimbursable`. The migration ships before any
  Compass build that sends it: an older server refuses an unknown argument (`sync_argument_unknown`).
