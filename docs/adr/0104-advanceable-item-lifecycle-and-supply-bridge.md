# ADR 0104: Advanceable Item Lifecycle and the Supply Bridge

- Status: Accepted (the owner confirmed this answer to decision 8 as recommended on 2026-10-27)
- Date: 2026-10-28
- Decider: Owner decisions on advancing, 2026-10-28 (decision 8, answered here and confirmed by the owner on 2026-10-27); R0 (RRR-176)
- Migrations: none (R0); 2680 to 2683 (R7a, see the amendment below)

## Context

Decision 8: approval reserves and assigns the asset to the person, and Issue activates it and confirms possession by
the intended person. The owner asked whether a Confirmed, Ordered and Received sequence is needed to complete the
asset lifecycle, whether it is covered elsewhere (procurement, receiving), and what implementation keeps third normal
form and a single source of truth and scales. This ADR is that answer.

Each step already has an owner today:

| Step      | Where it lives                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| Ordered   | `app.purchase_orders.po_state` at Approved or Sent (`0331_procurement.sql:14`, `0331:27-32`)                              |
| Confirmed | `app.po_acknowledgments` (`0766_external_vendor.sql:35-44`)                                                               |
| Received  | `app.goods_receipts` and `app.receipt_lines`, with the order line locked while a receipt line is written (`0331:600-612`) |
| Matched   | `app.invoice_matches` (`0331:624`)                                                                                        |

Three links are missing: from a receipt into stock, from a reservation to the person it is for, and rentals.

## Decisions

### 1. No Confirmed, Ordered or Received states are added

Procurement owns those steps, and the allocation status (ADR 0103) reads them through the order line. Adding them to
an allocation or a unit would copy facts that procurement already holds.

### 2. One owner per state

| Owner                                                           | States                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `app.advance_allocations` (R7)                                  | Requested, Approved, Declined, Withdrawn. The requester cannot approve. |
| `app.asset_reservations` (R7)                                   | Held or Released, written at approval                                   |
| procurement tables                                              | Ordered, Confirmed, Received                                            |
| `app.asset_units.asset_state`                                   | the unit's condition and place, plus a new Returned (section 4 below)   |
| possession rows: custody, lot movement, credential, service row | Issued                                                                  |
| return rows: Check In custody and lot movements, `return_lines` | Returned                                                                |

- **Reservations.** An `app.asset_reservations` row holds a quantity, its release, and at most one source key (a
  pinned unit, a lot, or the order line the item arrives on). No source key means class stock. It reads the class, the
  window and the holder from its allocation and stores none of them.
- **Issue** is a Check Out to a membership or an engagement (R1's `custodian_engagement_id`), carrying
  `roster_entry_id` and `reservation_id` (R7). **Return** is a Check In naming the same custodian and reservation.
  There are no Issue or Return movement kinds: two kinds for one fact would split the ledger.

### 3. Per item kind

- **Serialized**: a unit, reserved by pin or from class stock, issued by a custody Check Out.
- **Bulk and consumable**: a lot, reserved by quantity, issued by a lot movement Check Out.
- **Rental**: `po_lines.acquisition_kind` 'Purchase' or 'Rental' and `po_lines.hire_period` (tstzrange). Off-hire is
  a goods return.
- **Mixed supply**: an allocation filled partly from owned stock and partly from an order holds one reservation per
  source.

Owner, cost and vendor are derived through unit, receipt line, order line and purchase order, and never stored on the
unit.

### 4. R7a, the supply bridge (RRR-183)

- `app.asset_units.receipt_line_id` and `app.asset_lot_movements.receipt_line_id`, so a received item enters stock
  with its order line.
- Lot movement kinds gain Receipt and Vendor Return only.
- `app.receive_goods(event_id, ...)` replaces the client-side receipt writes in `packages/data/src/procurement.ts:808-843`
  and the receiving scan mode in `apps/compass/src/domain/scan.ts:358-362`, keyed by its event id so a
  replay records nothing twice.
- The rental columns above, `app.goods_returns` and `app.return_lines`.
- A tenth asset state, Returned, for a unit sent back to its vendor (off-hire or vendor return). It amends the
  nine-value asset lifecycle (Sections 3.12 and 7.4, `0352_assets_credentials.sql:11-14`).

### 5. R7, allocations

- `app.advance_allocations` and `app.asset_reservations`.
- `roster_entry_id` and `reservation_id` on `app.asset_custody` and `app.asset_lot_movements`.
- `allocation_id` on credentials and service rows, replacing `app.advance_promotions`
  (`0351_requirements_advancing_logistics_hospitality.sql:221-226`) for issued items.
- `app.issue_allocation`, which checks that the custodian is the reservation's holder before the scan writes
  possession, as `app.apply_asset_scan` checks state at `0975_assets_engagement_custody_scans.sql:222-224`.
- Direct custody inserts are removed (`0352_assets_credentials.sql:229-231`, ADR 0103).
- The status view `app.advance_allocation_status` (ADR 0103).

R8 reads the status in Gateway through an external view with no order prices. R11's heatmap reads the same view.

### 6. Overlap is guarded by row locks, not btree_gist

The extension list at `0001_foundation.sql:26-33` and ADR 0001 stay unchanged. A trigger,
`private.guard_asset_reservation`, guards overlap:

- For a pinned unit it locks the `app.asset_units` row FOR UPDATE, the same lock `app.apply_asset_scan` takes
  (`0975:209`).
- For a class-quantity hold it locks the `app.asset_classes` row FOR UPDATE.
- It then checks live windows that overlap (`tstzrange &&`) against the unit, or against the class's available unit
  count.

Precedent: `private.guard_dock_slot` (`0351:349-366`) and `private.guard_accommodation_assignment` (`0440_logistics_hospitality.sql:309-343`)
check overlapping ranges in a trigger the same way.

### 7. Follow-ups outside advancing

Shipment lines linked to order lines, quantity change orders (`0331:434-443` carries an amount only), auto-close of a
fully received order, and finance committed and accrued views. None blocks advancing.

## Alternatives

- **Design B: a stored Confirmed, Ordered, Received, Issued sequence on the allocation.** Rejected: it copies facts
  that procurement, receiving and the possession rows already own, and each copy needs a writer on every source path.
- **Issue and Return movement kinds.** Two kinds for the fact a Check Out or Check In already records.
- **An exclusion constraint with btree_gist.** It adds an extension for one table, and it cannot express a
  class-quantity hold, which compares a sum against a count.
- **Keep writing asset_state Reserved.** A unit can hold several future reservations in different windows; one state
  value cannot say which.

## Consequences

- Procurement stays the one place an order's progress is recorded; advancing reads it.
- The asset lifecycle gains Returned, so Section 3.12 lifecycle 3 and Section 7.4 list ten values once R7a merges.
- Reservations and scans take the same row lock, so a scan never checks out a unit a concurrent reservation is
  claiming without seeing it.
- With the owner's confirmation, R7a and R7 may start once their dependencies merge.

## Amendment: R7a as built (RRR-183, 2026-10-28)

Migrations 2680 to 2683 build section 4. Where the build differs from the text above or adds to it:

- **Idempotency.** The event id is the row id: `app.receive_goods` inserts the goods receipt with id = the event id,
  and `app.return_goods` the goods return. A replay on the same order returns outcome duplicate with the stored ids;
  the same id on another order is refused (receipt_event_reused, return_event_reused). The API mints a fresh event id
  on the first request and its Idempotency-Key ledger replays the stored response.
- **Compass.** The receiving scan mode is not replaced. Receiving gains a Receive against an order sheet for internal
  receivers (feature `scan.receiving.order`, procurement.receipt.write) that queues one `app.receive_goods`
  mutation; scans outside the sheet keep queuing unknown codes to scan intake, and a vendor still only acknowledges.
- **Returned.** Reached from Available, Damaged or In Maintenance, only inside `app.return_goods`
  (`app.transition_asset` refuses it otherwise, asset_returned_through_goods_return). A unit in someone's custody is
  checked in first (return_unit_in_custody). A quantity out of a lot is a Vendor Return movement; the direction
  constraint keeps R1's engagement custodian on Check Out.
- **Units on a receipt line.** `app.asset_units.receipt_line_id` is fixed once set, and a receipt line never brings
  in more live units than it received or a unit of another element (t42_guard_asset_unit_receipt).
- **Trash.** `app.goods_returns` and `app.return_lines` are excluded from Trash (ADR 0110): a return is undone by
  receiving again, never by restoring a row.
- **Reader views.** `app.po_line_supply` (ordered, acknowledged, received, returned, off-hire due; no prices) and
  `app.asset_unit_provenance` (receipt, order, vendor and unit price) run as the reader, so cost never reaches a
  reader without procurement.po.read.
- **Parity additions (gaps G-96 and G-99).** `app.asset_unit_hire`, an owner-rights view filtered to
  assets.asset.read with no vendor, cost or order, feeds the units list's built-in Damaged, Hired in and Unavailable
  views. `app.po_line_hire_warnings` and `app.hire_window_warnings` warn, never refuse, when a hire starts after the
  site opens, ends before it closes, runs more than a day beyond it, or starts or ends when every dock the project
  books is taken. The site window is the project's live Build and Strike records, else its dates; a missing bound
  gives no warning for the rules that use it.
- **API.** `poLines` and `assetUnits` take the new fields through correction entries (`po-line-rental`,
  `asset-unit-receipt-line`); `purchaseOrders.receive`, `purchaseOrders.returnGoods`, `poLines.hireWindowWarnings`,
  `goodsReturns`, `returnLines`, `poLineHireWarnings` and `assetUnitHire` are additions.
