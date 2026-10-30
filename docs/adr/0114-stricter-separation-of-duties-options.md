# ADR 0114: Stricter Separation of Duties Options

- Status: Proposed
- Date: 2026-10-28
- Decider: A135 (RRR-197), trace row S4.5.6-23; the package plan named this record ADR 0064, a number A104 had
  since taken, so it is the next free one
- Migrations: 2280, 2281

## Context

Section 8.2 says an organization may tighten separation of duties but never remove it. The rules every org keeps
are database checks that refuse with their rule code (0320, 1150; registry `private.separation_of_duties_rules`,
read through `app.separation_of_duties_rules`). Settings, Separation of Duties listed them read-only, and nothing
let an org tighten them (finding A65-004 resolved the empty page, not the tightening).

Before choosing options we checked what the built-in rules already refuse:

- Every direct approval RPC refuses the person who started the document: the creator of a purchase order or PO
  change order (`sod_po_creator`), the requester of a change order (`sod_change_order_requester`, set from the
  session on insert), the creator of an invoice, payroll run or settlement and the requester of a requisition
  (`sod_approval_requester`), and the submitter of an expense (`sod_expense_submitter`, set from the session).
- Approval policies (1030) refuse only the person who requested the approval (`sod_approval_requester` on the
  instance's `requested_by`). The document's creator, or a change order's requester, may decide a step when
  someone else put the document through the policy.
- Goods receipts take their receiver from the session and check nothing about who approved the order.

## Decisions

1. **Options sit in the rule registry, marked by what they tighten.** `private.separation_of_duties_rules` gains
   `tightens`: NULL for a built-in rule, and for an option the built-in rule it tightens. One registry keeps one
   way of refusing (XR001, message `<code>: <sentence>`, hint the code), and the 1150 catalog check (every `sod_`
   code a function refuses with is registered) and the gate 18 coverage audit (every code is named by a pgTAP
   suite) cover options without change. `app.separation_of_duties_rules` still lists only the built-in rules, so the
   v1 `separationOfDutiesRules` list is unchanged; `app.separation_of_duties_options` lists the options. Like the rules view, it is an owner-rights reference view of the platform's registry, holding no tenant data, and
   joins the reviewed list of `supabase/tests/9900_security_catalog.test.sql`.

2. **Three options are offered**, each closing a gap the built-in rules leave, over facts the database already
   records:

   | Code                               | Tightens                     | Refuses                                                                                                                                                                                                         |
   | ---------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `sod_document_creator`             | `sod_approval_requester`     | The creator of any approvable document (purchase order, PO change order, change order, invoice, requisition, expense, payroll run, settlement round) approving it directly or deciding any step of its approval |
   | `sod_receiver_po_approver`         | `sod_po_creator`             | A goods receipt, or a line on one, by a person who approved the purchase order or a change order to it (a spend approval or an approving step)                                                                  |
   | `sod_change_order_requester_steps` | `sod_change_order_requester` | A change order's requester deciding any step of its approval, also when someone else requested the approval                                                                                                     |

   On a direct approval `sod_document_creator` restates what the built-in rules already refuse, and the built-in
   rule answers first; it bites on approval steps, and it keeps holding if a document type gains a creator distinct
   from its requester. A rejected step counts as deciding, as it does for `sod_approval_requester`.

3. **Considered and not offered.** An invoice approver who may not be the purchase order's approver, and a payment
   approver who may not be the invoice's: payments have no approval RPC yet (`finance.payment.approve` is unused),
   and invoice approval already runs the three-way match. Options over people's relationships (a manager may not
   approve a report's timesheet) need an org chart the database does not hold. Each can be added later as one
   registry row and one check.

4. **Only options switch; the built-in rules have nothing to switch.** `app.org_separation_of_duties_options` holds
   one row per option an org turned on (unique per org and code while not deleted). A trigger refuses a row for a
   built-in or unknown code (`separation_option_unknown`), and `app.set_separation_of_duties_option` refuses the same
   way, so no write path can name a built-in rule. Turning an option off soft-deletes its row and returns the org to
   the built-in floor, which Section 8.2 allows: it removes the org's own addition, never a platform rule.

5. **The governing capability decides, and every change is audited.** Writes need
   `org.separation_of_duties.write` (Owner and Admin, 0203), through the RPC or row level security; every member
   reads which options are on. The table carries the audit trail (`app.audit_events`) and 90 days of retention after
   a soft delete. No v1 operation writes options; Atlas uses the RPC through `@xos/data/governance`.

6. **Checks live where the built-in rules are checked, from their latest definitions.** 2281 redefines
   `private.approve_under_spend_authority` (from 1030), which every spend approval RPC runs, `app.decide_approval`
   (from 1395), and `private.guard_goods_receipt` and `private.guard_receipt_line` (from 0331). Each reads
   `private.separation_option_on` for the document's org and refuses through `private.assert_separation` or
   `private.refuse` with the option's code and registry sentence.

7. **Settings, Separation of Duties.** The panel lists the built-in rules marked Always on, with no control, and the
   options with On or Off. A holder of the capability turns an option on in one click and off after a
   confirmation that the built-in rules stay on; others read the state. Option sentences and refusals read in
   en-US and es-US (`settingsSurfaces.sod.options`, and `refusals.*` in finance, procurement and workflow).

## Alternatives

- **A per-org copy of every rule with an enabled flag.** It would let a write path switch a built-in rule off, the
  one thing Section 8.2 forbids, and every org would carry rows for rules it cannot change.
- **A separate registry table for options.** It would need its own catalog and coverage checks, and a second
  sentence lookup for refusals, for no gain over one column.
- **Options as settings in the settings registry.** Settings are typed values read by the app; these are database
  checks that must hold for every client, so they belong beside the rules they tighten.

## Consequences

- An org can turn on each option in Settings, and the matching refusal names it: pgTAP 2280 (each option enforced
  with its code and sentence, the built-in rules cannot be switched, the capability is required) and the journey
  `apps/atlas/e2e/a135-separation-of-duties.spec.ts`.
- A new option is one registry row, one check in the function that enforces its built-in rule, a pgTAP assertion of
  its code, and its sentence in `NAMED_SOD_OPTIONS` and the catalogs.
- The trace row S4.5.6-23 moves from Partial to Done.
