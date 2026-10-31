# ADR 0103: Combined Statuses Are Computed

- Status: Accepted
- Date: 2026-10-28
- Decider: Owner decisions on advancing, 2026-10-28 (decision 8); R0 (RRR-176)
- Migrations: none

## Context

Section 3.15 keeps the schema in third normal form: a derived value is a view, a generated column or a registered
materialized view (ADR 0002). Advancing adds several statuses that combine facts owned by different tables:

- an allocation's progress, which depends on purchase orders, receipts, reservations and possession rows,
- a roster entry's readiness, which depends on the entry, the share, the project facts and the offerings,
- the heatmap cells, effective offerings, project people and Up Next details.

Storing any of these would copy facts another table owns, and the copy would drift whenever the owning table changes
without the copy's writer. ADR 0104 records which table owns each step of an item's lifecycle; this ADR records how
the combined answer is read.

## Decisions

### 1. Computed at read time, never copied

Every combined or cross-table status is computed when it is read, by a view or a function, and never copied onto a
row. This covers allocation status, roster readiness, heatmap cells, effective offerings
(`private.effective_offerings`, ADR 0100), project people (`app.project_people`, R1) and Up Next details.

### 2. Exceptions are measured, registered and written once

- An exception needs a measured reason and a row in the [denormalization register](denormalization-register.md).
- When a status value is stored, exactly one definer function writes it, in the same transaction as the fact it
  summarizes.
- Register rows are added by the package that builds each stored fact, not by this ADR:
  - R4 registers `app.work_detail_shares.person_id` and `engagement_id` (A108 lists the first as finding A108-003).
  - R7 registers the `app.asset_units.asset_state` value Deployed and the stamped `project_id` columns it adds.
  - From A108's merge, the register's source is `docs/adr/denormalization-register.yaml` and the Markdown table is
    generated from it (ADR 0022, amendment of 2026-10-28).

### 3. The allocation status (decision 8)

- `app.advance_allocation_status` (R7) shows, per allocation, the quantities on order, confirmed, received, reserved,
  issued, returned and lost.
- An allocation stores only Requested, Approved, Declined and Withdrawn. Issued is computed from the possession rows.
- R8 reads the status in Gateway through an external view with no order prices, and R11's heatmap reads the same view.

### 4. One writer for each possession fact

- `app.apply_asset_scan` is the only writer of custody rows (`app.asset_custody`) and of the Check Out and Check In
  rows of `app.asset_lot_movements`. Counts keep their own writer (`0450_assets_scans_lots.sql:213`), and R7a's
  `app.receive_goods` and its vendor return function write the Receipt and Vendor Return rows (ADR 0104). R7 replaces the direct custody insert (`packages/data/src/assets.ts:859`, allowed by
  the policy at `0352_assets_credentials.sql:229-231`) with a definer `app.record_asset_custody` that calls it, and
  `app.issue_allocation` calls it as well.
- `app.issue_allocation` is the only writer of allocation-linked credentials and service rows.
- New code stops writing `asset_units.asset_state` Reserved (R7); a reservation is a row in `app.asset_reservations`
  (ADR 0104). Deployed stays, written only by `app.apply_asset_scan` in the same transaction as the custody row
  (`0975_assets_engagement_custody_scans.sql:250-260`), and R7 registers it.

### 5. Requesters are computed

An allocation's requester is computed by `private.allocation_requester`: `created_by`, plus the person who claimed a
token link once R10 lands. It is never stamped later, so the rule that the requester cannot approve reads the same
answer everywhere.

## Alternatives

- **A stored status column with triggers on every source table.** Every source table gains a trigger that must know
  about allocations, and a missed path (a direct receipt, a scan replay) leaves the column wrong.
- **A materialized view refreshed on a schedule.** Status changes on a scan; a refresh interval would show an issued
  radio as reserved until the next run.
- **Stamping the requester when a token link is claimed.** A second writer of the same fact; the claim row already
  records who claimed.

## Consequences

- Reads of combined statuses join several tables. Packages index the join keys they add and measure the status view
  before it ships; a measured miss is the only path to a stored value.
- Deployed is the one stored asset state advancing keeps, because Compass checks scan state offline without the
  custody ledger.
- Packages that add a foreign key, an array column or a counted column run A108's lints and register each hit (ADR
  0022).

## Amendment: R7 as built (RRR-187, 2026-10-30)

Migrations 2690 to 2698 build sections 3 and 4. Where the build differs from the text above or adds to it:

- **Display status.** `app.advance_allocation_status.display_status` is computed in this order: Declined,
  Withdrawn and Requested come from the stored state. Then Returned (everything issued came back or was lost; not
  for credentials or parking passes), Revoked (every issued credential or pass was revoked), Issued, Partly Issued,
  Awaiting Order, On Order, Confirmed, Received, Reserved, and finally Approved. Atlas only reads it and maps it to a
  chip.
- **Definer views.** The status view, `app.allocation_holders`, `app.asset_reservation_conflicts` and the R7 owner
  reads filter rows themselves. Each one revokes select from `xos_backup`. The private helpers they call are granted
  execute to authenticated.
- **Possession writers.**
  - The custody insert policy is dropped, and insert on `app.asset_custody` is revoked from authenticated.
  - `app.record_asset_custody` writes through `app.apply_asset_scan`, which gains `p_roster_entry_id` and
    `p_reservation_id`.
  - `private.guard_custody_holder` and `private.guard_lot_movement_holder` check that the holder is the
    reservation's holder and that the roster entry is working. A lot check-out is refused
    (`lot_held_for_reservations`) only when reservations are still owed and the movement would not leave the lot
    negative, so the existing `asset_lot_insufficient` refusal still answers first.
  - The API custody create keeps its v1 request shape and now calls the RPC.
- **Allocation-linked rows.** `allocation_id` on credentials, fulfillment lines, accommodation assignments, travel
  segments and per diems may be set only inside the trusted operation `allocation_issue` (`allocation_issue_only`).
  Per diems gain `roster_entry_id`, so a roster worker can hold one without a membership.
- **Catering counts.** `app.catering_counts` logs `dietary_needs.counted`, and `allergies.counted` when allergies
  are shown, once per person counted. Below five people the counts are suppressed.
