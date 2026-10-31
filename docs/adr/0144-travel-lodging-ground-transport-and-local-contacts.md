# ADR 0144: Travel, Lodging, Ground Transport and Local Contacts

- Status: Accepted
- Date: 2026-10-31
- Decider: Owner (parity audit triage of 2026-10-28, fast-forward of 2026-10-30), package B5 (RRR-229)
- Gaps: G-32, G-33, G-56, G-58, G-66, G-67
- Migrations: `2940_travel_grid.sql` to `2947_hospitality_notices.sql`, and the notification seed `2949`

## Context

The competitor parity audit found the travel desk's daily work spread over records that could not show it. Flights
lived inside each Travel fulfillment's peek (`app.travel_segments`, 0442) with no project-wide grid. A segment holds
one traveller and no vehicle, so a van run from the airport could not be planned. Green rooms and dressing rooms had
no booking at all. Hotel blocks (0440) showed their own nights but no project-wide fill, no list of acts still without
rooms and no reminder before release. R5's travel requests asked who needs a room, but nothing turned that into a
rooming list. Local contacts had no home beyond the counterparty's organization and the member directory.

## Decisions

1. **Transfers are their own entity.** `app.transfers` is one vehicle run (pickup, drop-off, vehicle, driver) with
   `app.transfer_passengers` and `app.transfer_vehicles`. Travel segments keep one traveller per row. A pickup counts
   as booked from either a Ground segment or a transfer that picks the person up on their inbound date
   (`app.roster_travel_party`, recreated in 2942). A canceled transfer is restored in place through `@xos/data`: it
   has no title column, so Trash never registers it (`private.trash_title_column`, 2390). Vehicles register by
   label, and passengers are excluded and go with their transfer. Space bookings and local contacts have no title
   column either, so they are not Trash candidates.
2. **Everything the desk reads about state is computed, never stored.** This covers the night-by-night fill
   (`app.accommodation_block_nights`), the acts without rooms, the rooming status, the transfer status (Unassigned,
   Assigned, Underway, Done), the flight phase (Upcoming, In Flight, Departed, Landed), journeys (legs within 24 hours
   of the previous landing), booking conflict groups, the peak party against capacity and Set moved. The one stored
   derived value is a space booking's `engagement_id` copied from its set time, which the guard keeps equal
   (denormalization register).
3. **Overlap guards take advisory locks, without btree_gist** (ADR 0104 section 6), with `hashtextextended(key, 0)`
   and one fixed order to avoid deadlocks. A transfer locks itself, then the driver, the vehicle and the passengers by
   ascending person id. A person has one key whether they drive or ride, so a driver riding elsewhere at the same time
   is refused. A window move, a vehicle or driver change and a restore check every passenger again. An Exclusive
   space booking overlaps nothing, and a Shared one overlaps no Exclusive booking. Shared bookings may overlap: their
   clusters, peak party and capacity are reported on the board, never refused.
4. **Local contacts have one home** (`app.local_contacts`): a project row for every day or one day, or a venue row for
   every project there. A Member row names a membership and copies nothing: Atlas and internal Compass read the
   member's current name and directory work phone (`workforce.work_phone`, read as 1632 reads it) live. The phone
   is NULL once the membership ends. Outside the org, only Shared rows reach `api_external.local_contacts`. A
   member's row reaches it with display name and title only, and phone and email NULL. Outside parties see a phone
   only for a Shared contact whose number was typed on the row. The member's work phone never leaves the org.
5. **The rooming list is derived and logged.** It lists the entries of `private.travel_party_entries` (Travel
   offered) whose travel request needs lodging and whose engagement offers Lodging. People whose engagement offers
   Lodging but not Travel cannot appear, because R5 asks needs_lodging only on the travel request. Stays come from
   runs of consecutive access days of the person's live, unrevoked credentials of the engagement. Days are clamped to
   the project's dates, and to the category's live access grid windows when it has any. The list holds at most 120
   days and never stores a suggestion. Access days reveal pass validity, which R5 shows only to holders of
   credentials.credential.read, so other readers get the travel-date fallback. Every read is logged per person, as
   R5's travel party is, so Atlas reads it on request and never exports it. Assign room opens R7's Issue dialog for
   an Approved block allocation not yet issued. Otherwise it opens the room form prefilled, and nothing is saved
   until confirmed. B8 may later reshape access windows; the derivation reads them only through
   `private.person_access_days`.
6. **A block links to a budget line; lodging amounts are derived.** Linking needs finance.budget.read. The line
   belongs to a live budget of the block's project, and a priced block keeps the budget's currency, including on a
   later change of currency or rate. `app.budget_line_lodging` follows P4's silence rule: a reader without
   hospitality.fulfillment.read sees every figure withheld, never a partial sum. Blocks in another currency are
   counted and never summed. Nothing is written to a budget line, an expense or the ledger, and lodging is not folded
   into committed (XOS never holds funds).
7. **Computed arrivals and maps stay deferred** (G-34, S5-29). The planner types the drop-off estimate and places stay
   text. The no-account driver view belongs to B10; drivers sign in.
8. **Release reminders.** `accommodation_block.release_due` goes at 14, 7 and 1 days before the release date, on the
   project's calendar, once per threshold and release date (a ledger claimed before the notification is queued). It
   goes only while the block has a free room-night. Recipients are the block's creator and last editor, each only
   while they hold hospitality.accommodation.write on the project (`private.project_member_people_with`). An
   org-level reach check would also admit an assigned-reach holder off the project. The job runs hourly at minute 53. `transfer.assigned` tells a new driver once, with a Gateway link to their engagement when they are not a
   member. A failure to queue never blocks the write.

## Names under row level security

`app.people` is readable only for the reader and their orgs' members. The invoker views of B5 (the travel grid, the
transfer board, the space booking board) therefore read names through `private.known_person_name`. It returns a
name exactly when `app.person_names` would, and B5 widens that rule to the person of a live roster entry (not
Withdrawn, not Declined) on a live engagement of one of the reader's orgs. The `api_external` views run as their owner
and join `app.people` directly, as 2701 does. A desk that holds hospitality.fulfillment.read without
projects.project.read reads project keys and booked spaces through definer helpers that check that capability.

## Open item

`api_external.my_transfers` lets a principal (an account Owner or Admin, an artist's Advance representative) see the
transfers of the people named on an engagement they answer for (`private.party_person_visible`), the rule
`api_external.lodging` and `api_external.travel` use (2701). It does not reach the persons of an account's roster
entries. Widening the rule to roster persons would depart from R8's precedent, so it is left for a later decision.

## Consequences

- The API adds read-only `/flights` (Flight rows only), `/transfers`, `/transfer-vehicles`, `/space-bookings`,
  `/local-contacts` and `/accommodation-nights`, the latter with the acts-without-rooms and rooming-list queries.
  Each is additive under oasdiff and declares the capability its view or RPC requires. Writes are made in Atlas.
- Compass reads transfers and local contacts through REST-only scope rules (decision 51); PowerSync is unchanged.
- The day sheet document gains a Local contacts table in template version 2, for sheets issued from 2026-11-01.
