-- 2690_allocation_enums.sql
-- R7 Allocations, Atlas side (RRR-187, ADR 0103 and 0104). The vocabularies of advance allocations; 2691 to 2697 use
-- them. Lots gain no movement kinds: issuing a lot quantity is a Check Out to the engagement and returning it a Check
-- In, both naming the roster entry and the reservation (ADR 0104 section 2), so the ledger keeps one kind per fact.
--
--   * app.allocation_state: Requested, Approved, Declined, Withdrawn, stored on app.advance_allocations, the one owner
--     of these four states (ADR 0104 section 2). Reserved, ordered, issued and returned are read from the rows that
--     own them (app.advance_allocation_status, 2695).
--   * app.allocation_origin: how the allocation came to be: requested by production or a party, assigned directly by
--     a reviewer, or split from a party's pool.
--   * app.allocation_service_kind: the targets that are neither a credential category, an asset class, a catering
--     fulfillment nor an accommodation block.
--   * app.allocation_withdraw_cause and app.reservation_release_reason: why an allocation or a hold ended.
--   * app.credential_category_kind: a credential category is an access badge or a parking pass.

create type app.allocation_state as enum ('Requested', 'Approved', 'Declined', 'Withdrawn');
comment on type app.allocation_state is 'Where an advance allocation stands (R7, ADR 0104): Requested, then Approved or Declined by a reviewer who did not request it, or Withdrawn. An Approved allocation can still be Withdrawn while nothing of it is out. Possession is never a state: app.advance_allocation_status computes it.';

create type app.allocation_origin as enum ('Requested', 'Assigned', 'Split');
comment on type app.allocation_origin is 'How an allocation came to be: Requested (production or the party asked and a reviewer decides), Assigned (a reviewer allocated it directly) or Split (a share of a party''s approved pool given to one person).';

create type app.allocation_service_kind as enum ('Travel', 'Per Diem');
comment on type app.allocation_service_kind is 'Allocation targets that need no catalog row: a trip (issued as travel segments) or a per diem (issued as per diem days).';

create type app.allocation_withdraw_cause as enum ('Requester', 'Reviewer', 'Entry Removed', 'Engagement Ended');
comment on type app.allocation_withdraw_cause is 'Why an allocation was withdrawn: by its requester, by a reviewer, because the person''s roster entry was withdrawn or declined, or because the engagement ended (Complete or Canceled).';

create type app.reservation_release_reason as enum ('Withdrawn', 'Entry Removed', 'Engagement Ended', 'Split', 'Released By Reviewer');
comment on type app.reservation_release_reason is 'Why an asset hold was released: its allocation was withdrawn, the roster entry or engagement ended, the hold moved to a person in a split, or a reviewer released or replaced it.';

create type app.credential_category_kind as enum ('Access', 'Parking');
comment on type app.credential_category_kind is 'What a credential category issues: an access badge, or a parking pass tied to parking zones through app.access_grid (R7).';
