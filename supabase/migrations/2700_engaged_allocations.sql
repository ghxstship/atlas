-- 2700_engaged_allocations.sql
-- R8 Gateway assignment (RRR-188, ADR 0100, 0101, 0103 and 0104; owner decisions 4, 6, 7 and 8). The party side of an
-- engagement asks for what it needs and shares it out to its people from Gateway, through the same internals R7's
-- Atlas RPCs use, so every rule of 2693 holds here too. Each function is security definer with search_path '',
-- starts with private.require_person(), is revoked from public and anon and granted to authenticated and
-- service_role, and is commented.
--
--   * Who: R4's private.can_advance_engagement (2635), defined there and only used here (ADR 0101 decision 4): the
--     engaged person of an Artist engagement or one no account supplies, an Account Owner or Admin of the supplying
--     account, a live Advancing Lead or the artist's Advance representative, while the roster area is open. The
--     worker a company sends, a plain Account Member, is on the roster and refused allocation_not_your_engagement.
--   * app.request_engaged_allocation: a Requested allocation for the party's pool or one person on its roster, of an
--     item the org offers (owner decision 7): a credential category of the project (an Access badge is always
--     requestable; a Parking pass needs the Parking offering), an asset class that answers for an offering, a
--     Catering fulfillment or an accommodation block of the project, or Travel or Per Diem. A credential need is a
--     Requested credential allocation (Section 4.5.8 line 1655: Gateway only requests). Then private.insert_allocation
--     with the caller as created_by, so the reviewer separation of 2693 applies.
--   * app.split_engaged_allocation and app.unsplit_engaged_allocation: the party shares an approved pool to its people
--     and takes shares back, through private.split_allocation_parts and private.unsplit_allocation_share. The share
--     logic of app.unsplit_allocation (2693) moves into private.unsplit_allocation_share so both doors run one body;
--     app.unsplit_allocation is recreated from 2693 to call it, with the same refusals.
--   * app.withdraw_engaged_allocation: a Requested allocation any time, an Approved one only while nothing of it was
--     issued (allocation_issued), by the party side, or by the person on the roster for a request they made.
--   * The bulk resource engaged_allocation_assignments (A122's pattern, 2160): one row per roster entry, set
--     {pool_allocation_id, quantity}, the person's live share of that pool. A higher quantity splits the difference
--     from the pool, a lower one returns shares newest first; expect compares the quantity (bulk_stale), so an undo
--     after someone else moved the share is refused.

-- Unsplitting, one body for both doors -----------------------------------------------------------------------------------

create or replace function private.unsplit_allocation_share(p_child_id uuid, p_quantity numeric, p_cause app.allocation_withdraw_cause)
returns numeric
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_child app.advance_allocations;
  v_pool app.advance_allocations;
  v_quantity numeric;
  v_left numeric;
  v_take numeric;
  v_hold app.asset_reservations;
begin
  select a.* into v_child from app.advance_allocations a where a.id = p_child_id and a.deleted_at is null for update;
  if v_child.id is null or v_child.origin <> 'Split' or v_child.allocation_state <> 'Approved' then
    perform private.refuse('allocation_not_split', 'Only an approved share of a pool goes back to it.');
  end if;
  select a.* into v_pool from app.advance_allocations a where a.id = v_child.parent_allocation_id for update;
  if v_pool.allocation_state <> 'Approved' or v_pool.deleted_at is not null then
    perform private.refuse('allocation_not_pool', 'Only an approved allocation held by a party is split to its people.');
  end if;
  v_quantity := coalesce(p_quantity, v_child.quantity);
  if v_quantity <= 0 or v_quantity > v_child.quantity then
    perform private.refuse('allocation_split_parts', 'A split gives a quantity to at least one person.');
  end if;
  if v_quantity > v_child.quantity - private.allocation_issued_quantity(v_child) then
    perform private.refuse('allocation_issued', 'Part of this share was issued; only what was not issued goes back.');
  end if;

  perform private.begin_trusted_operation('allocation_split');
  update app.advance_allocations set quantity = quantity - v_quantity where id = v_child.id;
  update app.advance_allocations set quantity = quantity + v_quantity where id = v_pool.id;
  if v_child.asset_class_id is not null then
    v_left := v_quantity;
    for v_hold in
      select r.* from app.asset_reservations r
      where r.advance_allocation_id = v_child.id and r.released_at is null and r.deleted_at is null
      order by case when r.asset_unit_id is not null then 4 when r.po_line_id is not null then 1 when r.asset_lot_id is null then 2 else 3 end,
        r.created_at desc, r.id desc
    loop
      exit when v_left <= 0;
      v_take := least(v_left, v_hold.quantity - case when v_hold.asset_lot_id is not null then private.lot_reservation_issued(v_hold.id)
                                                     else private.unit_reservation_issued(v_hold.id, null) end);
      continue when v_take <= 0;
      perform private.move_hold(v_hold, v_take, v_pool.id);
      v_left := v_left - v_take;
    end loop;
  end if;
  perform private.end_trusted_operation('allocation_split');
  if v_quantity = v_child.quantity then
    perform private.release_allocation_holds(v_child.id, 'Split');
    perform private.withdraw_allocation_row(v_child.id, 'Approved', p_cause, 'Returned to the party''s allocation.');
  end if;
  return v_quantity;
end;
$$;
comment on function private.unsplit_allocation_share(uuid, numeric, app.allocation_withdraw_cause) is 'Returns part or all of an approved share to its pool (allocation_not_split, allocation_not_pool), never more than was not issued (allocation_issued): inside allocation_split the quantity and the holds that cover it move back, order lines first and pins last, and a share returned whole becomes Withdrawn with the cause given. The callers authorize: app.unsplit_allocation (production, Reviewer) and R8''s app.unsplit_engaged_allocation and bulk row (the party, Requester). Returns the quantity returned.';
revoke all on function private.unsplit_allocation_share(uuid, numeric, app.allocation_withdraw_cause) from public, anon, authenticated;
grant execute on function private.unsplit_allocation_share(uuid, numeric, app.allocation_withdraw_cause) to service_role;

-- Recreated from 2693: the same capability check, then the shared body.
create or replace function app.unsplit_allocation(p_child_id uuid, p_quantity numeric default null)
returns numeric
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid;
begin
  perform private.require_person();
  select a.project_id into v_project from app.advance_allocations a where a.id = p_child_id and a.deleted_at is null;
  if v_project is null or not private.can_on_project(v_project, 'advancing.packet.write') then
    raise exception using errcode = '42501', message = 'advancing.packet.write is required';
  end if;
  return private.unsplit_allocation_share(p_child_id, p_quantity, 'Reviewer');
end;
$$;
comment on function app.unsplit_allocation(uuid, numeric) is 'Production (advancing.packet.write) returns part or all of a share to its pool (allocation_not_split, allocation_not_pool), never more than was not issued (allocation_issued): the quantity and the holds that cover it move back inside allocation_split, and a share returned whole becomes Withdrawn with cause Reviewer (private.unsplit_allocation_share, 2700). Returns the quantity returned.';
revoke all on function app.unsplit_allocation(uuid, numeric) from public, anon;
grant execute on function app.unsplit_allocation(uuid, numeric) to authenticated, service_role;

-- Who may answer for the engagement --------------------------------------------------------------------------------------

create or replace function private.assert_engaged_allocator(p_engagement_id uuid)
returns app.engagements
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
begin
  select e.* into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  -- The relationship first, so a closed engagement of the party reads as closed and anyone else's as not theirs.
  if v_engagement.id is null or not ('roster' = any (private.engagement_party_areas(v_engagement.id, v_engagement.person_id,
      v_engagement.counterparty_id, v_engagement.role_type))) then
    perform private.refuse('allocation_not_your_engagement', 'Only the people who answer for this engagement ask for and share out what it needs.');
  end if;
  if v_engagement.engagement_state not in ('Onboarding', 'Blocked', 'Active', 'Closing') then
    perform private.refuse('allocation_engagement_closed', 'The engagement is complete or canceled.');
  end if;
  if not private.can_advance_engagement(v_engagement.id) then
    perform private.refuse('allocation_not_your_engagement', 'Only the people who answer for this engagement ask for and share out what it needs.');
  end if;
  return v_engagement;
end;
$$;
comment on function private.assert_engaged_allocator(uuid) is 'R8: the engagement the signed-in person answers for (private.can_advance_engagement, R4): allocation_not_your_engagement for anyone whose relationship opens no roster area, allocation_engagement_closed once the engagement is complete or canceled. Returns the engagement.';
revoke all on function private.assert_engaged_allocator(uuid) from public, anon, authenticated;

-- Requesting ------------------------------------------------------------------------------------------------------------------

create or replace function app.request_engaged_allocation(
  p_engagement_id uuid,
  p_item_kind text,
  p_quantity numeric,
  p_needed_from timestamptz,
  p_needed_to timestamptz,
  p_time_zone text,
  p_roster_entry_id uuid default null,
  p_item_id uuid default null,
  p_service_kind app.allocation_service_kind default null,
  p_note text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_entry app.engagement_roster_entries;
  v_category uuid;
  v_class uuid;
  v_fulfillment uuid;
  v_block uuid;
  v_service app.allocation_service_kind;
  v_row app.advance_allocations;
begin
  perform private.require_person();
  v_engagement := private.assert_engaged_allocator(p_engagement_id);
  if p_roster_entry_id is not null then
    select r.* into v_entry from app.engagement_roster_entries r where r.id = p_roster_entry_id and r.deleted_at is null;
    if v_entry.id is null or v_entry.engagement_id <> v_engagement.id then
      perform private.refuse('allocation_entry_not_on_engagement', 'That person is not on this engagement''s roster.');
    end if;
  end if;

  if p_item_kind = 'credential_category' then
    select k.id into v_category from app.credential_categories k
    where k.id = p_item_id and k.project_id = v_engagement.project_id and k.deleted_at is null;
  elsif p_item_kind = 'asset_class' then
    select c.id into v_class from app.asset_classes c
    where c.id = p_item_id and c.org_id = v_engagement.org_id and c.offering is not null and c.deleted_at is null;
  elsif p_item_kind = 'fulfillment' then
    select f.id into v_fulfillment from app.fulfillments f
    where f.id = p_item_id and f.project_id = v_engagement.project_id and f.fulfillment_kind = 'Catering' and f.deleted_at is null;
  elsif p_item_kind = 'accommodation_block' then
    select b.id into v_block from app.accommodation_blocks b
    where b.id = p_item_id and b.project_id = v_engagement.project_id and b.deleted_at is null;
  elsif p_item_kind = 'service' then
    v_service := p_service_kind;
  else
    perform private.refuse('allocation_item_kind', 'Ask for a credential, an asset, a catering, a room, travel or per diem.');
  end if;
  if num_nonnulls(v_category, v_class, v_fulfillment, v_block, v_service) <> 1
     or (p_item_kind <> 'service' and p_service_kind is not null) then
    perform private.refuse('allocation_not_requestable', 'That item is not one this project lets you ask for.');
  end if;

  -- The holder (allocation_engagement_closed, allocation_entry_not_live), then the window, the offering (Parking,
  -- Radios, Carts, Catering, Lodging, Travel or Per Diem Provided, offering_not_offered) and both caps.
  perform private.assert_allocation_holder(v_engagement.project_id,
    case when p_roster_entry_id is null then v_engagement.id end, p_roster_entry_id, 'request');
  v_row := private.insert_allocation(v_engagement.project_id, case when p_roster_entry_id is null then v_engagement.id end,
    p_roster_entry_id, v_category, v_class, v_fulfillment, v_block, v_service, p_quantity, p_needed_from, p_needed_to,
    p_time_zone, p_note, 'Requested', 'request');
  return v_row.id;
end;
$$;
comment on function app.request_engaged_allocation(uuid, text, numeric, timestamptz, timestamptz, text, uuid, uuid, app.allocation_service_kind, text) is 'R8: the party side (private.can_advance_engagement, else allocation_not_your_engagement) asks for an item for its pool or one person on its roster (allocation_entry_not_on_engagement, allocation_entry_not_live). p_item_kind is credential_category, asset_class, fulfillment, accommodation_block or service (allocation_item_kind); the item is a category of the project, a class of the org that answers for an offering, a Catering fulfillment or a block of the project, or Travel or Per Diem (allocation_not_requestable); the engagement Onboarding to Closing (allocation_engagement_closed); the offering Provided (offering_not_offered, offering_not_provided; an Access badge needs none) and within cap_per_engagement and cap_per_person (allocation_cap_engagement, allocation_cap_person). Inserted Requested by private.insert_allocation with the caller as created_by, for production to decide. Returns the allocation id.';
revoke all on function app.request_engaged_allocation(uuid, text, numeric, timestamptz, timestamptz, text, uuid, uuid, app.allocation_service_kind, text) from public, anon;
grant execute on function app.request_engaged_allocation(uuid, text, numeric, timestamptz, timestamptz, text, uuid, uuid, app.allocation_service_kind, text) to authenticated, service_role;

-- Sharing out and taking back --------------------------------------------------------------------------------------------------

create or replace function app.split_engaged_allocation(p_pool_allocation_id uuid, p_parts jsonb)
returns uuid[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement uuid;
begin
  perform private.require_person();
  select a.engagement_id into v_engagement from app.advance_allocations a where a.id = p_pool_allocation_id and a.deleted_at is null;
  if v_engagement is null then
    perform private.refuse('allocation_not_pool', 'Only an approved allocation held by a party is split to its people.');
  end if;
  perform private.assert_engaged_allocator(v_engagement);
  return private.split_allocation_parts(p_pool_allocation_id, p_parts);
end;
$$;
comment on function app.split_engaged_allocation(uuid, jsonb) is 'R8: the party side (private.can_advance_engagement) shares its approved pool to people on its roster through private.split_allocation_parts (2693): p_parts [{roster_entry_id, quantity, asset_unit_ids?}], each entry accepted by both sides, together no more than the pool has left, each within cap_per_person; holds move with the shares and each person is sent allocation.assigned. Returns the shares'' ids.';
revoke all on function app.split_engaged_allocation(uuid, jsonb) from public, anon;
grant execute on function app.split_engaged_allocation(uuid, jsonb) to authenticated, service_role;

create or replace function app.unsplit_engaged_allocation(p_child_id uuid, p_quantity numeric default null)
returns numeric
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement uuid;
begin
  perform private.require_person();
  select p.engagement_id into v_engagement
  from app.advance_allocations a join app.advance_allocations p on p.id = a.parent_allocation_id
  where a.id = p_child_id and a.deleted_at is null;
  if v_engagement is null then
    perform private.refuse('allocation_not_split', 'Only an approved share of a pool goes back to it.');
  end if;
  perform private.assert_engaged_allocator(v_engagement);
  return private.unsplit_allocation_share(p_child_id, p_quantity, 'Requester');
end;
$$;
comment on function app.unsplit_engaged_allocation(uuid, numeric) is 'R8: the party side (private.can_advance_engagement on the pool''s engagement) returns part or all of a person''s share to its pool through private.unsplit_allocation_share: never more than was not issued (allocation_issued); a share returned whole becomes Withdrawn with cause Requester. Returns the quantity returned.';
revoke all on function app.unsplit_engaged_allocation(uuid, numeric) from public, anon;
grant execute on function app.unsplit_engaged_allocation(uuid, numeric) to authenticated, service_role;

create or replace function app.withdraw_engaged_allocation(p_allocation_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_allocation app.advance_allocations;
  v_engagement app.engagements;
begin
  select a.* into v_allocation from app.advance_allocations a where a.id = p_allocation_id and a.deleted_at is null for update;
  if v_allocation.id is null then
    perform private.refuse('allocation_not_your_engagement', 'Only the people who answer for this engagement ask for and share out what it needs.');
  end if;
  select e.* into v_engagement from app.engagements e where e.id = private.allocation_engagement(v_allocation);
  -- The person on the roster takes back a request they made; anything else is the party side's.
  if not (v_allocation.roster_entry_id is not null
          and v_allocation.roster_entry_id in (select private.my_roster_entry_ids('roster'))
          and private.allocation_requester(v_allocation.id) = v_me) then
    perform private.assert_engaged_allocator(v_engagement.id);
  end if;
  if v_allocation.allocation_state not in ('Requested', 'Approved') then
    perform private.refuse('allocation_state_conflict', format('The allocation is %s.', v_allocation.allocation_state));
  end if;
  if v_allocation.allocation_state = 'Approved' and private.allocation_issued_quantity(v_allocation) > 0 then
    perform private.refuse('allocation_issued', 'Something of this allocation was issued; check it in or revoke it first.');
  end if;
  perform private.release_allocation_holds(v_allocation.id, 'Withdrawn');
  perform private.withdraw_allocation_row(v_allocation.id, v_allocation.allocation_state, 'Requester',
    coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Withdrawn from Gateway.'));
  perform private.notify_allocation(v_allocation.id, 'allocation.withdrawn',
    array[private.allocation_person(v_allocation), private.allocation_requester(v_allocation.id)],
    jsonb_build_object('reason', nullif(btrim(coalesce(p_reason, '')), '')));
end;
$$;
comment on function app.withdraw_engaged_allocation(uuid, text) is 'R8: withdraws a Requested allocation, or an Approved one while nothing of it was issued (allocation_issued), by the party side of its engagement (private.can_advance_engagement, allocation_not_your_engagement) or by the person on the roster for a request they made. Releases its holds (Withdrawn), records cause Requester with the reason in the ledger, and sends allocation.withdrawn to the person and the requester.';
revoke all on function app.withdraw_engaged_allocation(uuid, text) from public, anon;
grant execute on function app.withdraw_engaged_allocation(uuid, text) to authenticated, service_role;

-- Bulk: a person's share of a pool ------------------------------------------------------------------------------------------------

create or replace function private.bulk_engaged_allocation_assignments_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_entry app.engagement_roster_entries;
  v_pool app.advance_allocations;
  v_pool_id uuid;
  v_before numeric;
  v_after numeric;
  v_left numeric;
  v_take numeric;
  v_child app.advance_allocations;
begin
  perform private.bulk_check_fields(p_set, p_expect, 'pool_allocation_id,quantity');
  select r.* into v_entry from app.engagement_roster_entries r where r.id = p_id and r.deleted_at is null;
  if v_entry.id is null or not private.can_advance_engagement(v_entry.engagement_id) then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  v_pool_id := coalesce(nullif(p_set ->> 'pool_allocation_id', ''), nullif(p_expect ->> 'pool_allocation_id', ''))::uuid;
  select a.* into v_pool from app.advance_allocations a where a.id = v_pool_id and a.deleted_at is null;
  if v_pool.id is null or v_pool.engagement_id is distinct from v_entry.engagement_id then
    perform private.refuse('allocation_not_pool', 'Only an approved allocation held by a party is split to its people.');
  end if;
  select coalesce(sum(a.quantity), 0) into v_before from app.advance_allocations a
  where a.parent_allocation_id = v_pool.id and a.roster_entry_id = v_entry.id and a.allocation_state = 'Approved' and a.deleted_at is null;
  -- Values travel as text on the wire, so the share is compared as a number.
  if p_expect ? 'quantity' and (p_expect ->> 'quantity')::numeric is distinct from v_before then
    perform private.refuse('bulk_stale', 'Someone changed this row after you loaded it; reload to see the change.');
  end if;
  v_after := coalesce(nullif(p_set ->> 'quantity', '')::numeric, v_before);
  if v_after < 0 then
    perform private.refuse('allocation_split_parts', 'A split gives a quantity to at least one person.');
  end if;
  if v_after = v_before then
    return jsonb_build_object('org_id', v_entry.org_id, 'changed', false);
  end if;
  if v_after > v_before then
    perform private.split_allocation_parts(v_pool.id,
      jsonb_build_array(jsonb_build_object('roster_entry_id', v_entry.id, 'quantity', v_after - v_before)));
  else
    v_left := v_before - v_after;
    for v_child in
      select a.* from app.advance_allocations a
      where a.parent_allocation_id = v_pool.id and a.roster_entry_id = v_entry.id and a.allocation_state = 'Approved' and a.deleted_at is null
      order by a.created_at desc, a.id desc
    loop
      exit when v_left <= 0;
      v_take := least(v_left, v_child.quantity);
      perform private.unsplit_allocation_share(v_child.id, v_take, 'Requester');
      v_left := v_left - v_take;
    end loop;
  end if;
  return jsonb_build_object('org_id', v_entry.org_id, 'changed', true,
    'before', jsonb_build_object('pool_allocation_id', v_pool.id::text, 'quantity', v_before::text),
    'after', jsonb_build_object('pool_allocation_id', v_pool.id::text, 'quantity', v_after::text));
end;
$$;
comment on function private.bulk_engaged_allocation_assignments_row(uuid, jsonb, jsonb, text) is 'One roster entry of a Gateway bulk assignment (R8): set {pool_allocation_id, quantity} is the person''s live share of a pool of their engagement (allocation_not_pool), checked for the party side (private.can_advance_engagement; anyone else reads bulk_row_not_found). Before is the quantity of the entry''s approved shares of that pool; a higher quantity splits the difference (private.split_allocation_parts, with its caps and notification), a lower one returns shares newest first (private.unsplit_allocation_share). expect.quantity compares with before (bulk_stale), so the inverse row undoes the change only while nobody moved it.';
revoke all on function private.bulk_engaged_allocation_assignments_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

insert into private.bulk_resources (resource, table_name, row_function) values
  ('engaged_allocation_assignments', 'app.advance_allocations', 'private.bulk_engaged_allocation_assignments_row');

create or replace function app.bulk_update_engaged_allocation_assignments(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('engaged_allocation_assignments', p_rows, coalesce(p_preview, false), p_reason);
$$;
comment on function app.bulk_update_engaged_allocation_assignments(jsonb, boolean, text) is 'Gateway bulk assignment from a pool (R8, Section 11.7): sets each selected roster entry''s share of a pool in one transaction, every rule of a single split or unsplit applying to each row, with the answer of app.bulk_update_records and the inverse rows for undo.';
revoke all on function app.bulk_update_engaged_allocation_assignments(jsonb, boolean, text) from public, anon;
grant execute on function app.bulk_update_engaged_allocation_assignments(jsonb, boolean, text) to authenticated, service_role;
