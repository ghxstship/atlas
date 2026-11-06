# ADR 0150: Delivery Windows as Dock Slots, Sealed Quote Chasing, and Requested Allocations on Needs

- Status: Proposed
- Date: 2026-11-06
- Decider: B11 (RRR-235) took the decisions below for the owner-approved parity gaps G-115, G-196 and G-180 (competitor
  parity audit, 2026-10-28). The owner confirms this record; until then it stays Proposed, following ADR 0138's
  practice.

## Context

A loading dock took one slot at a time (0351: "Slots at one dock never overlap"), booked by a coordinator. Productions
want a gate open for a time with room for several vehicles, and vendors who book their own place. RFQs had no way to
reach a vendor: `rfq.issued` notifies nobody, and Gateway had no RFQ code. Quotes that never came were chased by hand.

## Decision

1. **A delivery booking is a dock slot.** Check-in, P9 approvals, the Gateway tab, Up Next, exports and sync keep one
   source. The vehicle limit lives on a new parent, `app.delivery_windows`, one per gate and time. This narrows 0351's
   rule: bookings of one window share its time, while nothing else at that gate may touch the window or its bookings.
   Windows and direct slots share 0351's advisory lock `dock_slots:<zone>`.
2. **The limit cannot be dodged.** `app.dock_slots.delivery_window_id` is written only inside `app.book_delivery_window`
   and never changes (`delivery_booking_direct`), and a restored booking is counted against the limit. Lock order: the
   window row, then the advisory lock, the order a window update already holds, so the two cannot deadlock.
3. **A reference code is a lookup label, not a credential.** Six characters from an alphabet without look-alikes,
   issued only for a booking, built from `pg_catalog.gen_random_uuid()` bytes so ADR 0001's extension list stays.
4. **What P9 does with bookings stays P9's.** A matching Delivery rule opens one approval per booking, with the vendor
   as requester. A Rejected approval frees no place, because ADR 0138 does not gate deliveries: the coordinator cancels.
   `t91_open_delivery_approval` fires on insert only, so a booking restored from Trash opens no approval. This record
   leaves that as it is rather than change P9.
5. **Per-vendor chase history stays sealed until an RFQ closes.** The ledger `app.rfq_supplier_notices` reads like a
   sealed response (0331). While an RFQ is Issued, `app.rfq_chase_status` holds only the settings and the due date. With
   one invited vendor, a total that stops rising, or a next reminder that vanishes, would tell a reader of RFQs that the
   vendor answered. Whether a vendor can be reached at all is static, and readable.
6. **The first reminder is the vendor's first contact, so its copy stands alone.** RFQs issued or awarded before the
   release get no notice (`private.rfq_chase_started`), so the first sweep does not email every open RFQ's vendors.
7. **A chase has a destination.** `/work/quote-requests` in Gateway reads the Issued RFQs that invite the caller's
   account, for its Owner and Admin, with no prices, needs or other vendors. Vendors still send the quote to the named
   contact and the buyer records it. Vendor quote submission stays out of scope.
8. **Requested allocations may be linked to needs.** See the amendment to ADR 0104.

## Alternatives rejected

- **A separate bookings table.** It would fork check-in, approvals, the Gateway tab and sync, or need a sync between
  them.
- **Per-slot vehicle capacity on `app.dock_slots`.** A slot is one booking. Capacity on it would leave nothing to name a
  vendor's place, plate or code.
- **A per-vendor reply view for buyers while Issued.** It breaks the seal in the first row anyone reads.
- **Reachable from `counterparties.organization_id`.** The column is NOT NULL, so every vendor would read as reachable.

## Consequences

- `private.project_docks_full_at` now reads windows: one with places left is free, and one full or closed is taken.
- `private.guard_dock_slot` takes a window row lock on every write to a booking.
- pgTAP runs on one connection, so the limit is asserted sequentially and the lock order from the function definition.
  Real concurrency is not exercised by the suite.
