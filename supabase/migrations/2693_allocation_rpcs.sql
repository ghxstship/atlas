-- 2693_allocation_rpcs.sql
-- R7 Allocations, Atlas side (RRR-187, ADR 0103 and 0104, owner decision 8). Every write to an allocation, its holds
-- and its possession goes through these functions; each is security definer with search_path '', revoked from
-- public and anon, granted to authenticated and service_role, and commented.
--
--   * Offerings and caps: private.allocation_offering is the one reader of R3's resolver. An allocation needs its
--     offering Provided (offering_not_offered, offering_not_provided). private.check_allocation_caps counts live
--     Requested and Approved quantities of the offering under the engagement and its entries (cap_per_engagement)
--     or under the entry (cap_per_person). With advancing.allowance_overflow at refuse (the default) a request over
--     the remaining cap is refused; at review (G-174) a request is inserted Requested, approving it or assigning
--     above the cap needs a reason (allocation_over_allowance_reason) that goes in the ledger, and a split above
--     cap_per_person is still refused. The quantity beyond is computed when deciding and never stored.
--   * app.request_allocation (production for a party, advancing.packet.write), app.assign_allocation (a reviewer,
--     advancing.submission.review, Approved at once), app.decide_allocation (compare-and-set on Requested, never by
--     the requester), private.insert_allocation (shared with R8's external request).
--   * Holds: approval reserves asset allocations (private.reserve_allocation); app.reserve_allocation replaces them,
--     app.release_reservation releases one.
--   * Splits: a party pool's approved quantity and holds move to people (app.split_allocation) and back
--     (app.unsplit_allocation).
--   * app.withdraw_allocation and app.issue_allocation, the one writer of possession for allocations. Issue is
--     idempotent on the caller's event id.
--   * Notifications allocation.decided, allocation.assigned, allocation.issued and allocation.withdrawn (seeded by
--     2698).

-- Offerings and caps ---------------------------------------------------------------------------------------------------------

create or replace function private.allocation_offering(p_engagement_id uuid, p_offering app.offering_kind)
returns table (offering_mode app.offering_mode, cap_per_engagement numeric, cap_per_person numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select o.offering_mode, o.cap_per_engagement::numeric, o.cap_per_person::numeric
  from private.effective_offerings(p_engagement_id) o where o.offering = p_offering;
$$;
comment on function private.allocation_offering(uuid, app.offering_kind) is 'How an offering reaches an engagement for allocations, with its caps: the one reader of R3''s private.effective_offerings in R7. No row for a missing engagement.';

create or replace function private.allocation_overflow(p_project_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.project_setting_text(p_project_id, 'advancing.allowance_overflow'), 'refuse');
$$;
comment on function private.allocation_overflow(uuid) is 'What happens to a request above the remaining allowance on a project (G-174, advancing.allowance_overflow): refuse (the default) or review. A locked org value wins over the project.';

create or replace function private.allocation_live_quantity(p_engagement_id uuid, p_roster_entry_id uuid, p_offering app.offering_kind, p_except uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(a.quantity), 0)
  from app.advance_allocations a
  where a.deleted_at is null and a.allocation_state in ('Requested', 'Approved') and a.id is distinct from p_except
    and private.allocation_offering_kind(a) = p_offering
    and case when p_roster_entry_id is not null then a.roster_entry_id = p_roster_entry_id
             else a.engagement_id = p_engagement_id
               or a.roster_entry_id in (select r.id from app.engagement_roster_entries r where r.engagement_id = p_engagement_id) end;
$$;
comment on function private.allocation_live_quantity(uuid, uuid, app.offering_kind, uuid) is 'Live Requested and Approved quantity of one offering under an entry (when given) or under an engagement and every entry of it, leaving one allocation out.';

create or replace function private.check_allocation_caps(p_allocation app.advance_allocations, p_step text, p_reason text)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_offering app.offering_kind := private.allocation_offering_kind(p_allocation);
  v_engagement uuid := private.allocation_engagement(p_allocation);
  v_offer record;
  v_review boolean;
  v_over numeric;
  v_beyond numeric := 0;
begin
  if p_step is null or p_step not in ('request', 'approve', 'assign', 'split') then
    perform private.refuse('allocation_cap_step', 'Caps are checked to request, approve, assign or split.');
  end if;
  if v_offering is null then
    return 0;
  end if;
  select * into v_offer from private.allocation_offering(v_engagement, v_offering);
  if coalesce(v_offer.offering_mode, 'Not Offered') = 'Not Offered' then
    perform private.refuse('offering_not_offered', format('%s is not offered on this engagement''s project.', v_offering));
  end if;
  if v_offer.offering_mode <> 'Provided' then
    perform private.refuse('offering_not_provided', format('%s is %s here, so it is not allocated.', v_offering, lower(v_offer.offering_mode::text)));
  end if;
  v_review := private.allocation_overflow(p_allocation.project_id) = 'review';

  if v_offer.cap_per_person is not null and p_allocation.roster_entry_id is not null then
    v_over := private.allocation_live_quantity(v_engagement, p_allocation.roster_entry_id, v_offering, p_allocation.id)
      + p_allocation.quantity - v_offer.cap_per_person;
    if v_over > 0 then
      if p_step = 'split' or not v_review then
        perform private.refuse('allocation_cap_person', format('This person may have %s of this; the request goes beyond it.', v_offer.cap_per_person));
      end if;
      v_beyond := greatest(v_beyond, v_over);
    end if;
  end if;
  -- A split moves quantity inside the pool, so the engagement's total does not change.
  if v_offer.cap_per_engagement is not null and p_step <> 'split' then
    v_over := private.allocation_live_quantity(v_engagement, null, v_offering, p_allocation.id)
      + p_allocation.quantity - v_offer.cap_per_engagement;
    if v_over > 0 then
      if not v_review then
        perform private.refuse('allocation_cap_engagement', format('This engagement may have %s of this; the request goes beyond it.', v_offer.cap_per_engagement));
      end if;
      v_beyond := greatest(v_beyond, v_over);
    end if;
  end if;
  if v_beyond > 0 and p_step in ('approve', 'assign')
     and (p_reason is null or char_length(btrim(p_reason)) not between 1 and 1000) then
    perform private.refuse('allocation_over_allowance_reason', format('This goes beyond the allowance by %s; give a reason of 1 to 1000 characters.', v_beyond));
  end if;
  return v_beyond;
end;
$$;
comment on function private.check_allocation_caps(app.advance_allocations, text, text) is 'The offering and cap rules of an allocation at one step (request, approve, assign or split; R7, G-174): its offering must be Provided on the engagement (offering_not_offered, offering_not_provided; a badge is no offering). Live Requested and Approved quantity of the offering under the entry plus this one is held to cap_per_person, and under the engagement and its entries to cap_per_engagement (a split leaves the engagement total alone). With advancing.allowance_overflow at refuse every step refuses allocation_cap_person or allocation_cap_engagement; at review a request goes through, approving or assigning needs p_reason of 1 to 1000 characters (allocation_over_allowance_reason), and a split above cap_per_person is still refused. Returns the quantity beyond the allowance, computed now and never stored. R8 (2700) and R9 (2711) call this signature.';

-- Holders ----------------------------------------------------------------------------------------------------------------------

create or replace function private.assert_allocation_holder(p_project_id uuid, p_engagement_id uuid, p_roster_entry_id uuid, p_step text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_entry app.engagement_roster_entries;
begin
  if num_nonnulls(p_engagement_id, p_roster_entry_id) <> 1 then
    perform private.refuse('allocation_holder_required', 'An allocation is held by one party engagement or one person on a roster.');
  end if;
  if p_roster_entry_id is not null then
    select r.* into v_entry from app.engagement_roster_entries r where r.id = p_roster_entry_id and r.deleted_at is null;
  end if;
  select e.* into v_engagement from app.engagements e
  where e.id = coalesce(p_engagement_id, v_entry.engagement_id) and e.deleted_at is null;
  if v_engagement.id is null or v_engagement.project_id is distinct from p_project_id then
    perform private.refuse('allocation_holder_project', 'An allocation''s holder is an engagement of the project.');
  end if;
  if v_engagement.engagement_state not in ('Onboarding', 'Blocked', 'Active', 'Closing') then
    perform private.refuse('allocation_engagement_closed', 'The engagement is complete or canceled.');
  end if;
  if p_roster_entry_id is null then
    return;
  end if;
  if p_step = 'request' then
    if v_entry.entry_state not in ('Draft', 'Submitted', 'Accepted') or v_entry.person_response = 'Declined' then
      perform private.refuse('allocation_entry_not_live', 'The roster entry was withdrawn or declined.');
    end if;
  elsif not private.roster_entry_working(v_entry.id, v_engagement.id) then
    perform private.refuse('allocation_entry_not_accepted', 'The roster entry is accepted by the reviewer and the person first.');
  end if;
end;
$$;
comment on function private.assert_allocation_holder(uuid, uuid, uuid, text) is 'An allocation''s holder at one step: one engagement or one roster entry (allocation_holder_required) of the project (allocation_holder_project), the engagement Onboarding, Blocked, Active or Closing (allocation_engagement_closed); for a request the entry is Draft, Submitted or Accepted and not declined (allocation_entry_not_live), otherwise accepted by both sides (allocation_entry_not_accepted).';

create or replace function private.insert_allocation(
  p_project_id uuid,
  p_engagement_id uuid,
  p_roster_entry_id uuid,
  p_credential_category_id uuid,
  p_asset_class_id uuid,
  p_fulfillment_id uuid,
  p_accommodation_block_id uuid,
  p_service_kind app.allocation_service_kind,
  p_quantity numeric,
  p_needed_from timestamptz,
  p_needed_to timestamptz,
  p_time_zone text,
  p_note text,
  p_origin app.allocation_origin,
  p_step text
)
returns app.advance_allocations
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row app.advance_allocations;
begin
  if p_needed_from is null or p_needed_to is null or p_needed_to <= p_needed_from then
    perform private.refuse('allocation_window', 'An allocation is needed from a start to a later end.');
  end if;
  if p_quantity is null or p_quantity <= 0 then
    perform private.refuse('allocation_quantity_positive', 'An allocation is for a quantity above zero.');
  end if;
  v_row.project_id := p_project_id;
  v_row.engagement_id := p_engagement_id;
  v_row.roster_entry_id := p_roster_entry_id;
  v_row.credential_category_id := p_credential_category_id;
  v_row.asset_class_id := p_asset_class_id;
  v_row.fulfillment_id := p_fulfillment_id;
  v_row.accommodation_block_id := p_accommodation_block_id;
  v_row.service_kind := p_service_kind;
  v_row.quantity := p_quantity;
  v_row.needed_during := tstzrange(p_needed_from, p_needed_to, '[)');
  v_row.needed_time_zone := p_time_zone;
  v_row.origin := p_origin;
  v_row.note := nullif(btrim(coalesce(p_note, '')), '');
  if num_nonnulls(p_credential_category_id, p_asset_class_id, p_fulfillment_id, p_accommodation_block_id, p_service_kind) <> 1 then
    perform private.refuse('allocation_target_required', 'An allocation is for one item: a category, an asset class, a catering, a block, travel or per diem.');
  end if;
  -- The guard checks the target belongs to the project before the caps read its offering.
  perform private.check_allocation_caps(v_row, p_step, p_note);
  insert into app.advance_allocations (project_id, engagement_id, roster_entry_id, credential_category_id, asset_class_id,
    fulfillment_id, accommodation_block_id, service_kind, quantity, needed_during, needed_time_zone, origin, note)
  values (p_project_id, p_engagement_id, p_roster_entry_id, p_credential_category_id, p_asset_class_id, p_fulfillment_id,
    p_accommodation_block_id, p_service_kind, p_quantity, v_row.needed_during, p_time_zone, p_origin, v_row.note)
  returning * into v_row;
  return v_row;
end;
$$;
comment on function private.insert_allocation(uuid, uuid, uuid, uuid, uuid, uuid, uuid, app.allocation_service_kind, numeric, timestamptz, timestamptz, text, text, app.allocation_origin, text) is 'The one creator of a Requested allocation, after the caller authorized and checked the holder: a window from a start to a later end (allocation_window), one target (allocation_target_required), a quantity above zero, the offering and caps of the step (private.check_allocation_caps, the note standing as the over-allowance reason), then the row; the guard checks the target''s project and whole numbers. app.request_allocation, app.assign_allocation and R8''s external request use it.';

-- Notifications ----------------------------------------------------------------------------------------------------------------

create or replace function private.allocation_notification_args(p_allocation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'personName', coalesce(pp.full_name, ''),
    'partyName', coalesce(ao.name, ep.full_name, ''),
    'projectName', p.name,
    'orgName', o.name,
    'kind', lower(replace(private.allocation_kind(a), ' ', '_')),
    'itemName', coalesce(k.name, c.name, f.title, b.title, ''),
    'quantity', a.quantity::text)
  from app.advance_allocations a
  join app.projects p on p.id = a.project_id
  join app.organizations o on o.id = a.org_id
  join app.engagements e on e.id = private.allocation_engagement(a)
  left join app.counterparties cp on cp.id = e.counterparty_id
  left join app.organizations ao on ao.id = cp.organization_id
  left join app.people ep on ep.id = e.person_id
  left join app.people pp on pp.id = private.allocation_person(a)
  left join app.credential_categories k on k.id = a.credential_category_id
  left join app.asset_classes c on c.id = a.asset_class_id
  left join app.fulfillments f on f.id = a.fulfillment_id
  left join app.accommodation_blocks b on b.id = a.accommodation_block_id
  where a.id = p_allocation_id;
$$;
comment on function private.allocation_notification_args(uuid) is 'The names an allocation notification shows: the person, the party, the project, the producing org, the kind (credential, parking_pass, asset, catering, lodging, travel, per_diem), the item name and the quantity.';

create or replace function private.notify_allocation(p_allocation_id uuid, p_kind text, p_people uuid[], p_extra jsonb default '{}')
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_allocation app.advance_allocations;
  v_person uuid;
  v_me uuid := private.current_person_id();
begin
  select a.* into v_allocation from app.advance_allocations a where a.id = p_allocation_id;
  for v_person in select distinct x from unnest(p_people) x where x is not null and x is distinct from v_me loop
    perform private.notify(v_allocation.org_id, v_person, p_kind, 'advance_allocations', v_allocation.id, v_allocation.project_id,
      private.allocation_notification_args(v_allocation.id) || coalesce(p_extra, '{}'));
  end loop;
end;
$$;
comment on function private.notify_allocation(uuid, text, uuid[], jsonb) is 'Sends an allocation notification (allocation.decided, assigned, issued or withdrawn) in the producing org to each distinct person named, except the person acting, with the allocation as its subject.';

-- Possession counted ----------------------------------------------------------------------------------------------------------

create or replace function private.allocation_issued_quantity(p_allocation app.advance_allocations)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case private.allocation_kind(p_allocation)
    when 'Credential' then (select count(*) from app.credentials c where c.allocation_id = p_allocation.id and c.deleted_at is null)
    when 'Parking Pass' then (select count(*) from app.credentials c where c.allocation_id = p_allocation.id and c.deleted_at is null)
    when 'Asset' then
      (select count(distinct c.asset_unit_id) from app.asset_custody c
       join app.asset_reservations r on r.id = c.reservation_id where r.advance_allocation_id = p_allocation.id)
      + (select coalesce(sum(-m.delta), 0) from app.asset_lot_movements m
         join app.asset_reservations r on r.id = m.reservation_id
         where r.advance_allocation_id = p_allocation.id and m.movement_kind = 'Check Out')
    when 'Catering' then (select coalesce(sum(l.quantity), 0) from app.fulfillment_lines l where l.allocation_id = p_allocation.id and l.deleted_at is null)
    when 'Lodging' then (select count(*) from app.accommodation_assignments x where x.allocation_id = p_allocation.id and x.deleted_at is null)
    when 'Travel' then (select count(*) from app.travel_segments t where t.allocation_id = p_allocation.id and t.deleted_at is null)
    when 'Per Diem' then (select count(*) from app.per_diems d where d.allocation_id = p_allocation.id and d.deleted_at is null)
  end::numeric;
$$;
comment on function private.allocation_issued_quantity(app.advance_allocations) is 'How much of an allocation has been issued, counted from the possession rows: credentials, distinct units checked out against its holds plus lot quantities checked out against them, catering line quantities, rooms, trips and per diem days. Returns are not taken off.';

create or replace function private.allocation_out(p_allocation app.advance_allocations)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case private.allocation_kind(p_allocation)
    when 'Asset' then
      exists (
        select 1 from app.asset_reservations r
        join app.asset_custody c on c.reservation_id = r.id
        where r.advance_allocation_id = p_allocation.id
          and not exists (select 1 from app.asset_custody l where l.asset_unit_id = c.asset_unit_id
                          and (l.created_at, l.id) > (c.created_at, c.id)
                          and l.custodian_membership_id is null and l.custodian_engagement_id is null))
      or exists (
        select 1 from app.asset_reservations r
        where r.advance_allocation_id = p_allocation.id
          and (select coalesce(sum(-m.delta), 0) from app.asset_lot_movements m where m.reservation_id = r.id) > 0)
    when 'Credential' then exists (select 1 from app.credentials c where c.allocation_id = p_allocation.id and c.deleted_at is null and c.revoked_at is null)
    when 'Parking Pass' then exists (select 1 from app.credentials c where c.allocation_id = p_allocation.id and c.deleted_at is null and c.revoked_at is null)
    else private.allocation_issued_quantity(p_allocation) > 0
  end;
$$;
comment on function private.allocation_out(app.advance_allocations) is 'True while something of an allocation is in its holder''s hands: a unit checked out against a hold and not checked in since, a lot quantity checked out and not checked in, a credential not revoked, or any live catering line, room, trip or per diem day.';

-- Holds ------------------------------------------------------------------------------------------------------------------------

create or replace function private.release_allocation_holds(p_allocation_id uuid, p_reason app.reservation_release_reason)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform private.begin_trusted_operation('reservation_release');
  update app.asset_reservations set released_at = now(), release_reason = p_reason
  where advance_allocation_id = p_allocation_id and released_at is null and deleted_at is null;
  get diagnostics v_count = row_count;
  perform private.end_trusted_operation('reservation_release');
  return v_count;
end;
$$;
comment on function private.release_allocation_holds(uuid, app.reservation_release_reason) is 'Releases every live hold of an allocation with the reason; returns how many.';

create or replace function private.reserve_allocation(p_allocation app.advance_allocations, p_sources jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sources jsonb := p_sources;
  v_source jsonb;
  v_lot uuid;
  v_total numeric := 0;
  v_count integer := 0;
  v_quantity numeric;
begin
  if p_allocation.asset_class_id is null then
    return 0;
  end if;
  if v_sources is null then
    if exists (select 1 from app.asset_units u where u.asset_class_id = p_allocation.asset_class_id and u.deleted_at is null) then
      v_sources := jsonb_build_array(jsonb_build_object('source', 'Class Stock', 'quantity', p_allocation.quantity));
    elsif (select count(*) from app.asset_lots l where l.asset_class_id = p_allocation.asset_class_id and l.deleted_at is null) = 1 then
      select l.id into v_lot from app.asset_lots l where l.asset_class_id = p_allocation.asset_class_id and l.deleted_at is null;
      v_sources := jsonb_build_array(jsonb_build_object('source', 'Lot', 'asset_lot_id', v_lot, 'quantity', p_allocation.quantity));
    else
      perform private.refuse('allocation_sources_required', 'Say where the stock comes from: class stock, a lot or an order line.');
    end if;
  end if;
  if jsonb_typeof(v_sources) <> 'array' or jsonb_array_length(v_sources) = 0 then
    perform private.refuse('allocation_sources_required', 'Say where the stock comes from: class stock, a lot or an order line.');
  end if;
  for v_source in select s from jsonb_array_elements(v_sources) s loop
    v_quantity := (v_source ->> 'quantity')::numeric;
    if v_quantity is null or v_quantity <= 0
       or (v_source ->> 'source') not in ('Class Stock', 'Unit', 'Lot', 'Order Line')
       or ((v_source ->> 'source') = 'Unit') <> (v_source ? 'asset_unit_id')
       or ((v_source ->> 'source') = 'Lot') <> (v_source ? 'asset_lot_id')
       or ((v_source ->> 'source') = 'Order Line') <> (v_source ? 'po_line_id') then
      perform private.refuse('allocation_sources_invalid', 'Each source is Class Stock, a Unit, a Lot or an Order Line with its id and a quantity above zero.');
    end if;
    v_total := v_total + v_quantity;
  end loop;
  if v_total <> p_allocation.quantity then
    perform private.refuse('allocation_sources_sum', format('The sources hold %s; the allocation is for %s.', v_total, p_allocation.quantity));
  end if;
  for v_source in select s from jsonb_array_elements(v_sources) s loop
    insert into app.asset_reservations (advance_allocation_id, asset_unit_id, asset_lot_id, po_line_id, quantity)
    values (p_allocation.id, (v_source ->> 'asset_unit_id')::uuid, (v_source ->> 'asset_lot_id')::uuid,
      (v_source ->> 'po_line_id')::uuid, (v_source ->> 'quantity')::numeric);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
comment on function private.reserve_allocation(app.advance_allocations, jsonb) is 'Holds the stock of an Approved asset allocation: p_sources [{source: Class Stock | Unit | Lot | Order Line, quantity, asset_unit_id, asset_lot_id, po_line_id}] (allocation_sources_invalid), one hold per source, summing to the allocation quantity (allocation_sources_sum). NULL holds class stock for the whole quantity when the class has serialized units, else the class''s only live lot, else refuses allocation_sources_required. The hold guards check the source, the hire period and capacity (reservation_over_capacity).';

create or replace function app.reserve_allocation(p_allocation_id uuid, p_sources jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_allocation app.advance_allocations;
begin
  perform private.require_person();
  select a.* into v_allocation from app.advance_allocations a where a.id = p_allocation_id and a.deleted_at is null for update;
  if v_allocation.id is null or not private.can_on_project(v_allocation.project_id, 'advancing.submission.review') then
    raise exception using errcode = '42501', message = 'advancing.submission.review is required';
  end if;
  if v_allocation.allocation_state <> 'Approved' or v_allocation.asset_class_id is null then
    perform private.refuse('allocation_state_conflict', 'Only an approved asset allocation holds stock.');
  end if;
  if private.allocation_issued_quantity(v_allocation) > 0 then
    perform private.refuse('allocation_issued', 'Something of this allocation is already issued; release single holds instead.');
  end if;
  perform private.release_allocation_holds(v_allocation.id, 'Released By Reviewer');
  return private.reserve_allocation(v_allocation, p_sources);
end;
$$;
comment on function app.reserve_allocation(uuid, jsonb) is 'A reviewer (advancing.submission.review) replaces the holds of an Approved asset allocation before anything of it is issued (allocation_issued): the live holds are released Released By Reviewer and new ones written from p_sources as on approval. Returns the number of holds.';

create or replace function app.release_reservation(p_reservation_id uuid, p_reason text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_hold app.asset_reservations;
begin
  perform private.require_person();
  select r.* into v_hold from app.asset_reservations r where r.id = p_reservation_id and r.deleted_at is null for update;
  if v_hold.id is null or not private.can_on_project(v_hold.project_id, 'advancing.submission.review') then
    raise exception using errcode = '42501', message = 'advancing.submission.review is required';
  end if;
  if v_hold.released_at is not null then
    perform private.refuse('reservation_released', 'This hold was already released.');
  end if;
  if exists (
      select 1 from app.asset_custody c
      where c.reservation_id = v_hold.id
        and not exists (select 1 from app.asset_custody l where l.asset_unit_id = c.asset_unit_id
                        and (l.created_at, l.id) > (c.created_at, c.id)
                        and l.custodian_membership_id is null and l.custodian_engagement_id is null))
     or (select coalesce(sum(-m.delta), 0) from app.asset_lot_movements m where m.reservation_id = v_hold.id) > 0 then
    perform private.refuse('reservation_in_use', 'Something issued against this hold is still out; check it in first.');
  end if;
  perform private.begin_trusted_operation('reservation_release');
  update app.asset_reservations set released_at = now(), release_reason = 'Released By Reviewer' where id = v_hold.id;
  perform private.end_trusted_operation('reservation_release');
  perform private.write_audit_event(v_hold.org_id, 'reservation.released', 'app.asset_reservations', v_hold.id,
    jsonb_build_object('reason', nullif(btrim(coalesce(p_reason, '')), '')));
end;
$$;
comment on function app.release_reservation(uuid, text) is 'A reviewer (advancing.submission.review) releases one hold, Released By Reviewer, with the reason in the audit ledger. Refuses a hold already released (reservation_released) and one with a unit or lot quantity issued against it still out (reservation_in_use).';

-- Withdrawing a row ------------------------------------------------------------------------------------------------------------

-- The state and its cause change in one update, so the cause pair check holds; the ledger entry follows.
create or replace function private.withdraw_allocation_row(p_allocation_id uuid, p_expected app.allocation_state,
  p_cause app.allocation_withdraw_cause, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_ledger uuid;
begin
  if not exists (select 1 from private.lifecycle_transition_rules r
                 where r.lifecycle = 'advance_allocation' and r.from_state = p_expected::text and r.to_state = 'Withdrawn') then
    perform private.refuse('advance_allocation_transition_not_allowed', format('An advance allocation cannot move from %s to Withdrawn.', p_expected));
  end if;
  perform private.begin_trusted_operation('advance_allocation_transition');
  update app.advance_allocations set allocation_state = 'Withdrawn', withdraw_cause = p_cause
  where id = p_allocation_id and allocation_state = p_expected and deleted_at is null
  returning org_id into v_org;
  perform private.end_trusted_operation('advance_allocation_transition');
  if v_org is null then
    perform private.refuse('allocation_state_conflict', format('The allocation is not %s any more.', p_expected));
  end if;
  insert into app.advance_allocation_state_transitions (advance_allocation_id, from_state, to_state, reason)
  values (p_allocation_id, p_expected, 'Withdrawn', left(btrim(p_reason), 1000))
  returning id into v_ledger;
  return v_ledger;
end;
$$;
comment on function private.withdraw_allocation_row(uuid, app.allocation_state, app.allocation_withdraw_cause, text) is 'Moves an allocation to Withdrawn with its cause in one compare-and-set update (allocation_state_conflict when it moved), under the lifecycle rules, and writes the ledger entry with the reason. Callers authorize and release holds.';

create or replace function app.withdraw_allocation(p_allocation_id uuid, p_reason text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_allocation app.advance_allocations;
  v_cause app.allocation_withdraw_cause;
begin
  select a.* into v_allocation from app.advance_allocations a where a.id = p_allocation_id and a.deleted_at is null for update;
  if v_allocation.id is null then
    raise exception using errcode = '42501', message = 'advancing.packet.write is required';
  end if;
  if private.can_on_project(v_allocation.project_id, 'advancing.packet.write') then
    v_cause := case when private.allocation_requester(v_allocation.id) = v_me then 'Requester' else 'Reviewer' end;
  elsif private.allocation_requester(v_allocation.id) = v_me then
    v_cause := 'Requester';
  else
    raise exception using errcode = '42501', message = 'advancing.packet.write is required';
  end if;
  if v_allocation.allocation_state not in ('Requested', 'Approved') then
    perform private.refuse('allocation_state_conflict', format('The allocation is %s.', v_allocation.allocation_state));
  end if;
  if v_allocation.allocation_state = 'Approved' and private.allocation_out(v_allocation) then
    perform private.refuse('allocation_issued', 'Something of this allocation is out; check it in or revoke it first.');
  end if;
  perform private.release_allocation_holds(v_allocation.id, 'Withdrawn');
  perform private.withdraw_allocation_row(v_allocation.id, v_allocation.allocation_state, v_cause,
    coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Withdrawn.'));
  perform private.notify_allocation(v_allocation.id, 'allocation.withdrawn',
    array[private.allocation_person(v_allocation), private.allocation_requester(v_allocation.id)],
    jsonb_build_object('reason', nullif(btrim(coalesce(p_reason, '')), '')));
end;
$$;
comment on function app.withdraw_allocation(uuid, text) is 'Withdraws a Requested allocation, or an Approved one with nothing of it out (allocation_issued): by its requester (cause Requester) or a holder of advancing.packet.write on the project (cause Reviewer). Releases its holds (Withdrawn) and sends allocation.withdrawn to the person and the requester.';

-- Request, assign, decide ------------------------------------------------------------------------------------------------------

create or replace function app.request_allocation(
  p_project_id uuid,
  p_engagement_id uuid,
  p_roster_entry_id uuid,
  p_credential_category_id uuid,
  p_asset_class_id uuid,
  p_fulfillment_id uuid,
  p_accommodation_block_id uuid,
  p_service_kind app.allocation_service_kind,
  p_quantity numeric,
  p_needed_from timestamptz,
  p_needed_to timestamptz,
  p_time_zone text,
  p_note text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row app.advance_allocations;
begin
  perform private.require_person();
  if not private.can_on_project(p_project_id, 'advancing.packet.write') then
    raise exception using errcode = '42501', message = 'advancing.packet.write is required';
  end if;
  perform private.assert_allocation_holder(p_project_id, p_engagement_id, p_roster_entry_id, 'request');
  v_row := private.insert_allocation(p_project_id, p_engagement_id, p_roster_entry_id, p_credential_category_id, p_asset_class_id,
    p_fulfillment_id, p_accommodation_block_id, p_service_kind, p_quantity, p_needed_from, p_needed_to, p_time_zone, p_note,
    'Requested', 'request');
  return v_row.id;
end;
$$;
comment on function app.request_allocation(uuid, uuid, uuid, uuid, uuid, uuid, uuid, app.allocation_service_kind, numeric, timestamptz, timestamptz, text, text) is 'Production requests an allocation for a party''s pool (p_engagement_id) or one person on a roster (p_roster_entry_id): advancing.packet.write on the project; the engagement Onboarding, Blocked, Active or Closing (allocation_engagement_closed); the entry Draft, Submitted or Accepted (allocation_entry_not_live); the offering Provided and the caps (private.check_allocation_caps; with allowance overflow at review, a request above the cap goes in for review). Inserted Requested with origin Requested. Returns the allocation id.';

create or replace function app.assign_allocation(
  p_project_id uuid,
  p_engagement_id uuid,
  p_roster_entry_id uuid,
  p_credential_category_id uuid,
  p_asset_class_id uuid,
  p_fulfillment_id uuid,
  p_accommodation_block_id uuid,
  p_service_kind app.allocation_service_kind,
  p_quantity numeric,
  p_needed_from timestamptz,
  p_needed_to timestamptz,
  p_time_zone text,
  p_note text default null,
  p_sources jsonb default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row app.advance_allocations;
  v_beyond numeric;
begin
  perform private.require_person();
  if not private.can_on_project(p_project_id, 'advancing.submission.review') then
    raise exception using errcode = '42501', message = 'advancing.submission.review is required';
  end if;
  perform private.assert_allocation_holder(p_project_id, p_engagement_id, p_roster_entry_id, 'assign');
  v_row := private.insert_allocation(p_project_id, p_engagement_id, p_roster_entry_id, p_credential_category_id, p_asset_class_id,
    p_fulfillment_id, p_accommodation_block_id, p_service_kind, p_quantity, p_needed_from, p_needed_to, p_time_zone, p_note,
    'Assigned', 'assign');
  v_beyond := private.check_allocation_caps(v_row, 'assign', p_note);
  perform private.begin_trusted_operation('allocation_assign');
  perform private.transition_lifecycle('advance_allocation', 'app.advance_allocations', 'allocation_state',
    'app.advance_allocation_state_transitions', 'advance_allocation_id', v_row.id, 'Requested', 'Approved',
    case when v_beyond > 0 then left(btrim(p_note), 1000) else 'Assigned.' end);
  select a.* into v_row from app.advance_allocations a where a.id = v_row.id;
  perform private.reserve_allocation(v_row, p_sources);
  perform private.end_trusted_operation('allocation_assign');
  perform private.notify_allocation(v_row.id, 'allocation.decided', array[private.allocation_person(v_row)],
    jsonb_build_object('decision', 'approved'));
  return v_row.id;
end;
$$;
comment on function app.assign_allocation(uuid, uuid, uuid, uuid, uuid, uuid, uuid, app.allocation_service_kind, numeric, timestamptz, timestamptz, text, text, jsonb) is 'A reviewer (advancing.submission.review) assigns an allocation directly, as the guest list lets a reviewer add an approved guest (0431): the entry accepted by both sides (allocation_entry_not_accepted), the offering and caps (above the cap with allowance overflow at review, p_note is the reason, 1 to 1000 characters, and goes in the ledger). Inserted Requested and moved to Approved in the same call inside the trusted operation allocation_assign (origin Assigned), then an asset allocation is reserved from p_sources as on approval. Sends allocation.decided to the person. Returns the allocation id.';

create or replace function app.decide_allocation(p_allocation_id uuid, p_decision app.approval_decision, p_reason text default null,
  p_sources jsonb default null)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_allocation app.advance_allocations;
  v_beyond numeric;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select a.* into v_allocation from app.advance_allocations a where a.id = p_allocation_id and a.deleted_at is null for update;
  if v_allocation.id is null or not private.can_on_project(v_allocation.project_id, 'advancing.submission.review') then
    raise exception using errcode = '42501', message = 'advancing.submission.review is required';
  end if;
  if v_allocation.allocation_state <> 'Requested' then
    perform private.refuse('allocation_state_conflict', format('The allocation is %s already.', v_allocation.allocation_state));
  end if;
  perform private.assert_separation('sod_allocation_requester', v_me, private.allocation_requester(v_allocation.id));

  if p_decision = 'Rejected' then
    if v_reason is null or char_length(v_reason) > 1000 then
      perform private.refuse('allocation_reason_required', 'Say why the allocation is declined, in 1 to 1000 characters.');
    end if;
    perform private.transition_lifecycle('advance_allocation', 'app.advance_allocations', 'allocation_state',
      'app.advance_allocation_state_transitions', 'advance_allocation_id', v_allocation.id, 'Requested', 'Declined', v_reason);
    perform private.notify_allocation(v_allocation.id, 'allocation.decided',
      array[private.allocation_requester(v_allocation.id), private.allocation_person(v_allocation)],
      jsonb_build_object('decision', 'declined', 'reason', v_reason));
    return true;
  end if;

  perform private.assert_allocation_holder(v_allocation.project_id, v_allocation.engagement_id, v_allocation.roster_entry_id, 'approve');
  v_beyond := private.check_allocation_caps(v_allocation, 'approve', v_reason);
  perform private.transition_lifecycle('advance_allocation', 'app.advance_allocations', 'allocation_state',
    'app.advance_allocation_state_transitions', 'advance_allocation_id', v_allocation.id, 'Requested', 'Approved',
    coalesce(v_reason, 'Approved.'));
  select a.* into v_allocation from app.advance_allocations a where a.id = v_allocation.id;
  perform private.reserve_allocation(v_allocation, p_sources);
  perform private.notify_allocation(v_allocation.id, 'allocation.decided',
    array[private.allocation_requester(v_allocation.id), private.allocation_person(v_allocation)],
    jsonb_build_object('decision', 'approved'));
  return true;
end;
$$;
comment on function app.decide_allocation(uuid, app.approval_decision, text, jsonb) is 'A reviewer (advancing.submission.review) decides a Requested allocation with compare-and-set (allocation_state_conflict), never its requester (sod_allocation_requester, private.allocation_requester). Rejected needs a reason of 1 to 1000 characters (allocation_reason_required) and moves to Declined with it in the ledger. Approved checks the holder again (an entry accepted by both sides), the offering and caps (above the cap with allowance overflow at review it needs a reason, allocation_over_allowance_reason, that goes in the ledger), moves to Approved and reserves an asset allocation from p_sources (allocation_sources_required, reservation_over_capacity, raised for R9 to catch per allocation). Sends allocation.decided to the requester and the person. Returns true.';

-- Splitting a pool -----------------------------------------------------------------------------------------------------------------

create or replace function private.move_hold(p_hold app.asset_reservations, p_quantity numeric, p_to_allocation uuid, p_unit uuid default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_target uuid;
begin
  -- Lower the source first, so the capacity check of the new hold sees the quantity free.
  if p_quantity >= p_hold.quantity then
    update app.asset_reservations set released_at = now(), release_reason = 'Split' where id = p_hold.id;
  else
    update app.asset_reservations set quantity = quantity - p_quantity where id = p_hold.id;
  end if;
  if p_unit is not null then
    insert into app.asset_reservations (advance_allocation_id, asset_unit_id, quantity) values (p_to_allocation, p_unit, 1);
    return;
  end if;
  select r.id into v_target from app.asset_reservations r
  where r.advance_allocation_id = p_to_allocation and r.released_at is null and r.deleted_at is null
    and r.asset_unit_id is not distinct from p_hold.asset_unit_id and r.asset_lot_id is not distinct from p_hold.asset_lot_id
    and r.po_line_id is not distinct from p_hold.po_line_id and p_hold.asset_unit_id is null
  for update;
  if v_target is not null then
    update app.asset_reservations set quantity = quantity + p_quantity where id = v_target;
  else
    insert into app.asset_reservations (advance_allocation_id, asset_unit_id, asset_lot_id, po_line_id, quantity)
    values (p_to_allocation, p_hold.asset_unit_id, p_hold.asset_lot_id, p_hold.po_line_id, p_quantity);
  end if;
end;
$$;
comment on function private.move_hold(app.asset_reservations, numeric, uuid, uuid) is 'Inside allocation_split: moves part of a hold to another allocation of the same class, lowering or releasing (Split) the source hold first and then adding to the target''s hold on the same source or writing one; with p_unit, a class-stock unit becomes a pinned hold of the target.';

create or replace function private.split_allocation_parts(p_allocation_id uuid, p_parts jsonb)
returns uuid[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pool app.advance_allocations;
  v_part jsonb;
  v_total numeric := 0;
  v_quantity numeric;
  v_child app.advance_allocations;
  v_ids uuid[] := '{}';
  v_unit uuid;
  v_hold app.asset_reservations;
  v_left numeric;
  v_take numeric;
begin
  select a.* into v_pool from app.advance_allocations a where a.id = p_allocation_id and a.deleted_at is null for update;
  if v_pool.id is null or v_pool.allocation_state <> 'Approved' or v_pool.engagement_id is null then
    perform private.refuse('allocation_not_pool', 'Only an approved allocation held by a party is split to its people.');
  end if;
  if p_parts is null or jsonb_typeof(p_parts) <> 'array' or jsonb_array_length(p_parts) = 0 then
    perform private.refuse('allocation_split_parts', 'A split gives a quantity to at least one person.');
  end if;
  for v_part in select p from jsonb_array_elements(p_parts) p loop
    v_quantity := (v_part ->> 'quantity')::numeric;
    if v_quantity is null or v_quantity <= 0 or (v_part ->> 'roster_entry_id') is null then
      perform private.refuse('allocation_split_parts', 'A split gives a quantity to at least one person.');
    end if;
    if not private.roster_entry_working((v_part ->> 'roster_entry_id')::uuid, v_pool.engagement_id) then
      perform private.refuse('allocation_entry_not_accepted', 'The roster entry is accepted by the reviewer and the person first.');
    end if;
    v_total := v_total + v_quantity;
  end loop;
  if v_total > v_pool.quantity - private.allocation_issued_quantity(v_pool) then
    perform private.refuse('allocation_split_exceeds', 'A split gives no more than the pool has left.');
  end if;

  perform private.begin_trusted_operation('allocation_split');
  update app.advance_allocations set quantity = quantity - v_total where id = v_pool.id;
  for v_part in select p from jsonb_array_elements(p_parts) p loop
    v_quantity := (v_part ->> 'quantity')::numeric;
    v_child.id := null;
    v_child.project_id := v_pool.project_id;
    v_child.org_id := v_pool.org_id;
    v_child.engagement_id := null;
    v_child.roster_entry_id := (v_part ->> 'roster_entry_id')::uuid;
    v_child.credential_category_id := v_pool.credential_category_id;
    v_child.asset_class_id := v_pool.asset_class_id;
    v_child.fulfillment_id := v_pool.fulfillment_id;
    v_child.accommodation_block_id := v_pool.accommodation_block_id;
    v_child.service_kind := v_pool.service_kind;
    v_child.quantity := v_quantity;
    perform private.check_allocation_caps(v_child, 'split', null);
    insert into app.advance_allocations (project_id, roster_entry_id, parent_allocation_id, credential_category_id, asset_class_id,
      fulfillment_id, accommodation_block_id, service_kind, quantity, needed_during, needed_time_zone, origin)
    values (v_pool.project_id, v_child.roster_entry_id, v_pool.id, v_pool.credential_category_id, v_pool.asset_class_id,
      v_pool.fulfillment_id, v_pool.accommodation_block_id, v_pool.service_kind, v_quantity, v_pool.needed_during,
      v_pool.needed_time_zone, 'Split')
    returning * into v_child;
    perform private.transition_lifecycle('advance_allocation', 'app.advance_allocations', 'allocation_state',
      'app.advance_allocation_state_transitions', 'advance_allocation_id', v_child.id, 'Requested', 'Approved',
      'Split from the party''s allocation.');
    v_ids := v_ids || v_child.id;

    if v_pool.asset_class_id is not null then
      v_left := v_quantity;
      -- Units named first: the pool's pin on the unit, else one unit taken from class stock.
      for v_unit in select x::uuid from jsonb_array_elements_text(coalesce(v_part -> 'asset_unit_ids', '[]'::jsonb)) x loop
        exit when v_left <= 0;
        select r.* into v_hold from app.asset_reservations r
        where r.advance_allocation_id = v_pool.id and r.asset_unit_id = v_unit and r.released_at is null and r.deleted_at is null;
        if v_hold.id is not null then
          perform private.move_hold(v_hold, 1, v_child.id);
        else
          select r.* into v_hold from app.asset_reservations r
          where r.advance_allocation_id = v_pool.id and r.released_at is null and r.deleted_at is null
            and r.asset_unit_id is null and r.asset_lot_id is null and r.po_line_id is null
          order by r.created_at, r.id limit 1;
          if v_hold.id is null then
            perform private.refuse('allocation_split_unit', 'A unit named in a split is held by the pool or comes from its class stock.');
          end if;
          perform private.move_hold(v_hold, 1, v_child.id, v_unit);
        end if;
        v_left := v_left - 1;
      end loop;
      -- Then lots, class stock and order lines, in that order.
      for v_hold in
        select r.* from app.asset_reservations r
        where r.advance_allocation_id = v_pool.id and r.released_at is null and r.deleted_at is null and r.asset_unit_id is null
        order by case when r.asset_lot_id is not null then 1 when r.po_line_id is null then 2 else 3 end, r.created_at, r.id
      loop
        exit when v_left <= 0;
        v_take := least(v_left, v_hold.quantity);
        perform private.move_hold(v_hold, v_take, v_child.id);
        v_left := v_left - v_take;
      end loop;
      -- Pinned units not named move last.
      for v_hold in
        select r.* from app.asset_reservations r
        where r.advance_allocation_id = v_pool.id and r.released_at is null and r.deleted_at is null and r.asset_unit_id is not null
        order by r.created_at, r.id
      loop
        exit when v_left <= 0;
        perform private.move_hold(v_hold, 1, v_child.id);
        v_left := v_left - 1;
      end loop;
    end if;
    perform private.notify_allocation(v_child.id, 'allocation.assigned', array[private.allocation_person(v_child)]);
  end loop;
  perform private.end_trusted_operation('allocation_split');
  return v_ids;
end;
$$;
comment on function private.split_allocation_parts(uuid, jsonb) is 'Splits an Approved party pool (allocation_not_pool) to people: p_parts [{roster_entry_id, quantity, asset_unit_ids?}], each entry on the pool''s engagement and accepted by both sides, together no more than the pool has left unissued (allocation_split_exceeds), each within cap_per_person (allocation_cap_person). Inside the trusted operation allocation_split it lowers the pool, writes each share (origin Split, the pool as parent, the same target and window) Approved, and moves hold quantity from the pool''s live holds: units named (their pins, or a pin taken from class stock), then lots, class stock and order lines, then other pins, releasing a pool hold that reaches 0 with reason Split. Sends allocation.assigned to each person. Returns the shares'' ids. R8''s party split shares it.';

create or replace function app.split_allocation(p_allocation_id uuid, p_parts jsonb)
returns uuid[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid := (select a.project_id from app.advance_allocations a where a.id = p_allocation_id and a.deleted_at is null);
begin
  perform private.require_person();
  if v_project is null or not private.can_on_project(v_project, 'advancing.packet.write') then
    raise exception using errcode = '42501', message = 'advancing.packet.write is required';
  end if;
  return private.split_allocation_parts(p_allocation_id, p_parts);
end;
$$;
comment on function app.split_allocation(uuid, jsonb) is 'Production splits a party''s approved pool to people on its roster (advancing.packet.write on the project) through private.split_allocation_parts. Returns the shares'' ids.';

create or replace function app.unsplit_allocation(p_child_id uuid, p_quantity numeric default null)
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
  perform private.require_person();
  select a.* into v_child from app.advance_allocations a where a.id = p_child_id and a.deleted_at is null for update;
  if v_child.id is null or not private.can_on_project(v_child.project_id, 'advancing.packet.write') then
    raise exception using errcode = '42501', message = 'advancing.packet.write is required';
  end if;
  if v_child.origin <> 'Split' or v_child.allocation_state <> 'Approved' then
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
    perform private.withdraw_allocation_row(v_child.id, 'Approved', 'Reviewer', 'Returned to the party''s allocation.');
  end if;
  return v_quantity;
end;
$$;
comment on function app.unsplit_allocation(uuid, numeric) is 'Production (advancing.packet.write) returns part or all of a share to its pool (allocation_not_split, allocation_not_pool), never more than was not issued (allocation_issued): the quantity and the holds that cover it move back inside allocation_split, and a share returned whole becomes Withdrawn with cause Reviewer. Returns the quantity returned.';

-- Issue -----------------------------------------------------------------------------------------------------------------------------

create or replace function private.allocation_issue_capability(p_kind text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_kind
    when 'Credential' then 'credentials.credential.issue'
    when 'Parking Pass' then 'credentials.credential.issue'
    when 'Asset' then 'assets.custody.write'
    when 'Catering' then 'hospitality.fulfillment.write'
    when 'Travel' then 'hospitality.fulfillment.write'
    when 'Lodging' then 'hospitality.accommodation.write'
    when 'Per Diem' then 'crew.time_entry.write'
  end;
$$;
comment on function private.allocation_issue_capability(text) is 'The capability that issues each kind of allocation on its project: credentials.credential.issue for badges and parking passes, assets.custody.write for assets, hospitality.fulfillment.write for catering and travel, hospitality.accommodation.write for lodging, crew.time_entry.write for per diems.';

create or replace function private.local_day(p_at timestamptz, p_time_zone text)
returns date
language sql
stable
set search_path = ''
as $$
  select (p_at at time zone p_time_zone)::date;
$$;
comment on function private.local_day(timestamptz, text) is 'The calendar day of an instant in an IANA time zone.';

create or replace function private.pick_allocation_hold(p_allocation app.advance_allocations, p_unit uuid, p_lot uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.id from app.asset_reservations r
  where r.advance_allocation_id = p_allocation.id and r.released_at is null and r.deleted_at is null
    and case
      when p_lot is not null then r.asset_lot_id = p_lot
        and private.lot_reservation_issued(r.id) < r.quantity
      else r.asset_lot_id is null and (r.asset_unit_id = p_unit or r.asset_unit_id is null)
        and private.unit_reservation_issued(r.id, p_unit) < r.quantity
    end
  order by (r.asset_unit_id is not distinct from p_unit) desc, (r.po_line_id is null) desc, r.created_at, r.id
  limit 1;
$$;
comment on function private.pick_allocation_hold(app.advance_allocations, uuid, uuid) is 'The hold an issued unit or lot quantity counts against when the caller names none: the unit''s own pin, else class stock, else an order line, with room left; for a lot, a hold of that lot with room left.';

create or replace function app.issue_allocation(p_event_id uuid, p_allocation_id uuid, p_items jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_allocation app.advance_allocations;
  v_existing app.advance_issue_events;
  v_kind text;
  v_capability text;
  v_engagement app.engagements;
  v_person uuid;
  v_item jsonb;
  v_issued numeric;
  v_possession jsonb := '{}'::jsonb;
  v_id uuid;
  v_unit app.asset_units;
  v_hold uuid;
  v_quantity numeric;
  v_result record;
  v_from date;
  v_to date;
  v_day date;
begin
  if p_event_id is null then
    perform private.refuse('issue_event_required', 'Every issue carries the event id it was recorded under.');
  end if;
  -- The capability holds before the allocation is locked or a replay answered.
  select a.* into v_allocation from app.advance_allocations a where a.id = p_allocation_id and a.deleted_at is null;
  v_kind := private.allocation_kind(v_allocation);
  v_capability := coalesce(private.allocation_issue_capability(v_kind), 'advancing.packet.read');
  if v_allocation.id is null or not private.can_on_project(v_allocation.project_id, v_capability) then
    raise exception using errcode = '42501', message = format('%s is required', v_capability);
  end if;
  select a.* into v_allocation from app.advance_allocations a where a.id = v_allocation.id for update;
  select e.* into v_existing from app.advance_issue_events e where e.id = p_event_id;
  if v_existing.id is not null then
    if v_existing.advance_allocation_id <> v_allocation.id then
      perform private.refuse('issue_event_reused', 'This issue event already issued another allocation.');
    end if;
    return jsonb_build_object('outcome', 'duplicate', 'possession', v_existing.possession);
  end if;

  if v_allocation.allocation_state <> 'Approved' then
    perform private.refuse('allocation_state_conflict', format('The allocation is %s, so nothing of it is issued.', v_allocation.allocation_state));
  end if;
  select e.* into v_engagement from app.engagements e where e.id = private.allocation_engagement(v_allocation);
  if v_engagement.engagement_state not in ('Active', 'Closing') then
    perform private.refuse('allocation_engagement_not_active', 'Items are issued while the engagement is Active or Closing.');
  end if;
  if v_kind <> 'Asset' and v_allocation.roster_entry_id is null then
    perform private.refuse('allocation_needs_person', 'This item goes to one person; split the allocation to the people first.');
  end if;
  if v_allocation.roster_entry_id is not null and not private.roster_entry_working(v_allocation.roster_entry_id, v_engagement.id) then
    perform private.refuse('allocation_entry_not_accepted', 'The roster entry is accepted by the reviewer and the person first.');
  end if;
  v_person := private.allocation_person(v_allocation);
  if v_person is not null and v_person = v_me then
    perform private.refuse('allocation_self_issue', 'A person never issues an allocation to themselves.');
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    perform private.refuse('issue_items_required', 'An issue hands over at least one item.');
  end if;
  v_issued := private.allocation_issued_quantity(v_allocation);

  perform private.begin_trusted_operation('allocation_issue');
  for v_item in select i from jsonb_array_elements(p_items) i loop
    if v_kind in ('Credential', 'Parking Pass') then
      if jsonb_array_length(p_items) <> 1 or (v_item ? 'roster_vehicle_id' and v_kind <> 'Parking Pass') then
        perform private.refuse('issue_items_invalid', 'A badge or pass is issued one at a time; only a pass names a vehicle.');
      end if;
      insert into app.credentials (credential_category_id, holder_person_id, valid_from, valid_to, engagement_id, allocation_id)
      values (v_allocation.credential_category_id, v_person,
        coalesce((v_item ->> 'valid_from')::timestamptz, lower(v_allocation.needed_during)),
        coalesce((v_item ->> 'valid_to')::timestamptz, upper(v_allocation.needed_during)),
        v_engagement.id, v_allocation.id)
      returning id into v_id;
      v_possession := jsonb_set(v_possession, '{credentials}', coalesce(v_possession -> 'credentials', '[]') || to_jsonb(v_id));
      if v_item ->> 'roster_vehicle_id' is not null then
        insert into app.credential_vehicles (credential_id, roster_vehicle_id) values (v_id, (v_item ->> 'roster_vehicle_id')::uuid)
        returning id into v_id;
        v_possession := jsonb_set(v_possession, '{credential_vehicles}', coalesce(v_possession -> 'credential_vehicles', '[]') || to_jsonb(v_id));
      end if;
      v_issued := v_issued + 1;

    elsif v_kind = 'Asset' and v_item ? 'asset_lot_id' then
      v_quantity := (v_item ->> 'quantity')::numeric;
      if v_quantity is null or v_quantity <= 0 then
        perform private.refuse('issue_items_invalid', 'A lot quantity is issued above zero.');
      end if;
      v_hold := coalesce((v_item ->> 'reservation_id')::uuid, private.pick_allocation_hold(v_allocation, null, (v_item ->> 'asset_lot_id')::uuid));
      if v_hold is null or not exists (select 1 from app.asset_reservations r where r.id = v_hold and r.advance_allocation_id = v_allocation.id) then
        perform private.refuse('issue_hold_required', 'Issue against a hold of this allocation.');
      end if;
      v_id := private.uuid_v7();
      select * into v_result from app.apply_asset_scan(v_id, v_allocation.org_id, 'LOT:' || (v_item ->> 'asset_lot_id'), 'check-out', null,
        v_engagement.id, null, v_allocation.project_id, null, v_quantity, v_allocation.roster_entry_id, v_hold);
      v_possession := jsonb_set(v_possession, '{asset_lot_movements}', coalesce(v_possession -> 'asset_lot_movements', '[]') || to_jsonb(v_id));
      v_issued := v_issued + v_quantity;

    elsif v_kind = 'Asset' then
      select u.* into v_unit from app.asset_units u
      where u.org_id = v_allocation.org_id and u.deleted_at is null
        and (u.id = (v_item ->> 'asset_unit_id')::uuid or u.asset_tag = upper(btrim(v_item ->> 'asset_tag')));
      if v_unit.id is null then
        perform private.refuse('issue_unit_unknown', 'No unit of the org carries this tag.');
      end if;
      v_hold := coalesce((v_item ->> 'reservation_id')::uuid, private.pick_allocation_hold(v_allocation, v_unit.id, null));
      if v_hold is null or not exists (select 1 from app.asset_reservations r where r.id = v_hold and r.advance_allocation_id = v_allocation.id) then
        perform private.refuse('issue_hold_required', 'Issue against a hold of this allocation.');
      end if;
      v_id := private.uuid_v7();
      select * into v_result from app.apply_asset_scan(v_id, v_allocation.org_id, v_unit.asset_tag, 'check-out', null,
        v_engagement.id, null, v_allocation.project_id, null, null, v_allocation.roster_entry_id, v_hold);
      v_possession := jsonb_set(v_possession, '{asset_custody}', coalesce(v_possession -> 'asset_custody', '[]') || to_jsonb(v_id));
      v_issued := v_issued + 1;

    elsif v_kind = 'Catering' then
      v_quantity := coalesce((v_item ->> 'quantity')::numeric, 1);
      insert into app.fulfillment_lines (fulfillment_id, description, person_id, quantity, unit_price_minor, currency_code, allocation_id)
      values (v_allocation.fulfillment_id,
        coalesce(nullif(btrim(v_item ->> 'description'), ''), (select f.title from app.fulfillments f where f.id = v_allocation.fulfillment_id)),
        v_person, v_quantity,
        (v_item ->> 'unit_price_minor')::bigint, (v_item ->> 'currency_code')::char(3), v_allocation.id)
      returning id into v_id;
      v_possession := jsonb_set(v_possession, '{fulfillment_lines}', coalesce(v_possession -> 'fulfillment_lines', '[]') || to_jsonb(v_id));
      v_issued := v_issued + v_quantity;

    elsif v_kind = 'Lodging' then
      v_from := coalesce((v_item ->> 'check_in_on')::date, private.local_day(lower(v_allocation.needed_during), v_allocation.needed_time_zone));
      v_to := coalesce((v_item ->> 'check_out_on')::date,
        greatest(private.local_day(upper(v_allocation.needed_during), v_allocation.needed_time_zone), v_from + 1));
      insert into app.accommodation_assignments (accommodation_block_id, person_id, check_in_on, check_out_on, allocation_id)
      values (v_allocation.accommodation_block_id, v_person, v_from, v_to, v_allocation.id)
      returning id into v_id;
      v_possession := jsonb_set(v_possession, '{accommodation_assignments}', coalesce(v_possession -> 'accommodation_assignments', '[]') || to_jsonb(v_id));
      v_issued := v_issued + 1;

    elsif v_kind = 'Travel' then
      insert into app.travel_segments (project_id, person_id, engagement_id, travel_mode, operator_name, service_identifier,
        confirmation_identifier, departs_from, departs_at, departs_time_zone, arrives_at_place, arrives_at, arrives_time_zone,
        price_minor, currency_code, allocation_id)
      values (v_allocation.project_id, v_person, v_engagement.id, (v_item ->> 'travel_mode')::app.travel_mode, v_item ->> 'operator_name',
        v_item ->> 'service_identifier', v_item ->> 'confirmation_identifier', v_item ->> 'departs_from',
        (v_item ->> 'departs_at')::timestamptz, v_item ->> 'departs_time_zone', v_item ->> 'arrives_at_place',
        (v_item ->> 'arrives_at')::timestamptz, v_item ->> 'arrives_time_zone', (v_item ->> 'price_minor')::bigint,
        (v_item ->> 'currency_code')::char(3), v_allocation.id)
      returning id into v_id;
      v_possession := jsonb_set(v_possession, '{travel_segments}', coalesce(v_possession -> 'travel_segments', '[]') || to_jsonb(v_id));
      v_issued := v_issued + 1;

    elsif v_kind = 'Per Diem' then
      v_day := (v_item ->> 'day')::date;
      if v_day is null
         or v_day < private.local_day(lower(v_allocation.needed_during), v_allocation.needed_time_zone)
         or v_day > private.local_day(upper(v_allocation.needed_during) - interval '1 microsecond', v_allocation.needed_time_zone) then
        perform private.refuse('issue_day_outside_window', 'A per diem day falls inside the allocation''s window.');
      end if;
      insert into app.per_diems (project_id, roster_entry_id, day, amount_minor, currency_code, allocation_id)
      values (v_allocation.project_id, v_allocation.roster_entry_id, v_day, (v_item ->> 'amount_minor')::bigint,
        (v_item ->> 'currency_code')::char(3), v_allocation.id)
      returning id into v_id;
      v_possession := jsonb_set(v_possession, '{per_diems}', coalesce(v_possession -> 'per_diems', '[]') || to_jsonb(v_id));
      v_issued := v_issued + 1;
    end if;
  end loop;
  perform private.end_trusted_operation('allocation_issue');

  if v_issued > v_allocation.quantity then
    perform private.refuse('allocation_issue_exceeds', format('This allocation is for %s; the issue goes beyond it.', v_allocation.quantity));
  end if;
  insert into app.advance_issue_events (id, advance_allocation_id, possession) values (p_event_id, v_allocation.id, v_possession);
  perform private.notify_allocation(v_allocation.id, 'allocation.issued', array[v_person]);
  return jsonb_build_object('outcome', 'applied', 'possession', v_possession);
end;
$$;
comment on function app.issue_allocation(uuid, uuid, jsonb) is 'Hands over part or all of an Approved allocation in one transaction (R7, decision 8): Issue confirms possession by the intended person. Needs the kind''s capability on the project (private.allocation_issue_capability; 42501 names it), checked before the allocation is locked or a replay answered. p_event_id is required (issue_event_required); a stored event for the same allocation returns {outcome: duplicate, possession}, for another refuses issue_event_reused. The engagement is Active or Closing (allocation_engagement_not_active), kinds other than Asset go to a person (allocation_needs_person: split first), the entry is accepted by both sides, the issuer is not the person (allocation_self_issue; credentials also refuse credential_self_issue), and issued plus new stays within the quantity (allocation_issue_exceeds). Items by kind: Credential or Parking Pass [{valid_from?, valid_to?, roster_vehicle_id? (passes only)}], one item, defaults from the window; Asset units [{asset_unit_id | asset_tag, reservation_id?}] and lots [{asset_lot_id, quantity, reservation_id?}], written by app.apply_asset_scan as a check-out to the engagement with the roster entry and the hold; Catering [{description?, quantity?, unit_price_minor?, currency_code?}] (the description defaults to the fulfillment title); Lodging [{check_in_on?, check_out_on?}] defaulting to the window''s days in its time zone; Travel [{travel_mode, operator_name?, service_identifier?, confirmation_identifier?, departs_from, departs_at, departs_time_zone, arrives_at_place, arrives_at?, arrives_time_zone, price_minor?, currency_code?}]; Per Diem [{day, amount_minor, currency_code}] each day inside the window (issue_day_outside_window). Stores the event with the ids written by table and sends allocation.issued to the person.';

-- Privileges --------------------------------------------------------------------------------------------------------------------

revoke all on function private.allocation_offering(uuid, app.offering_kind) from public, anon, authenticated;
revoke all on function private.allocation_overflow(uuid) from public, anon, authenticated;
revoke all on function private.allocation_live_quantity(uuid, uuid, app.offering_kind, uuid) from public, anon, authenticated;
revoke all on function private.check_allocation_caps(app.advance_allocations, text, text) from public, anon, authenticated;
revoke all on function private.assert_allocation_holder(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function private.insert_allocation(uuid, uuid, uuid, uuid, uuid, uuid, uuid, app.allocation_service_kind, numeric, timestamptz, timestamptz, text, text, app.allocation_origin, text) from public, anon, authenticated;
revoke all on function private.allocation_notification_args(uuid) from public, anon, authenticated;
revoke all on function private.notify_allocation(uuid, text, uuid[], jsonb) from public, anon, authenticated;
revoke all on function private.allocation_issued_quantity(app.advance_allocations) from public, anon, authenticated;
revoke all on function private.allocation_out(app.advance_allocations) from public, anon, authenticated;
revoke all on function private.release_allocation_holds(uuid, app.reservation_release_reason) from public, anon, authenticated;
revoke all on function private.reserve_allocation(app.advance_allocations, jsonb) from public, anon, authenticated;
revoke all on function private.withdraw_allocation_row(uuid, app.allocation_state, app.allocation_withdraw_cause, text) from public, anon, authenticated;
revoke all on function private.move_hold(app.asset_reservations, numeric, uuid, uuid) from public, anon, authenticated;
revoke all on function private.split_allocation_parts(uuid, jsonb) from public, anon, authenticated;
revoke all on function private.allocation_issue_capability(text) from public, anon, authenticated;
revoke all on function private.local_day(timestamptz, text) from public, anon, authenticated;
revoke all on function private.pick_allocation_hold(app.advance_allocations, uuid, uuid) from public, anon, authenticated;
grant execute on function private.check_allocation_caps(app.advance_allocations, text, text) to service_role;
grant execute on function private.insert_allocation(uuid, uuid, uuid, uuid, uuid, uuid, uuid, app.allocation_service_kind, numeric, timestamptz, timestamptz, text, text, app.allocation_origin, text) to service_role;
grant execute on function private.split_allocation_parts(uuid, jsonb) to service_role;

revoke all on function app.reserve_allocation(uuid, jsonb) from public, anon;
revoke all on function app.release_reservation(uuid, text) from public, anon;
revoke all on function app.withdraw_allocation(uuid, text) from public, anon;
revoke all on function app.request_allocation(uuid, uuid, uuid, uuid, uuid, uuid, uuid, app.allocation_service_kind, numeric, timestamptz, timestamptz, text, text) from public, anon;
revoke all on function app.assign_allocation(uuid, uuid, uuid, uuid, uuid, uuid, uuid, app.allocation_service_kind, numeric, timestamptz, timestamptz, text, text, jsonb) from public, anon;
revoke all on function app.decide_allocation(uuid, app.approval_decision, text, jsonb) from public, anon;
revoke all on function app.split_allocation(uuid, jsonb) from public, anon;
revoke all on function app.unsplit_allocation(uuid, numeric) from public, anon;
revoke all on function app.issue_allocation(uuid, uuid, jsonb) from public, anon;
grant execute on function app.reserve_allocation(uuid, jsonb) to authenticated, service_role;
grant execute on function app.release_reservation(uuid, text) to authenticated, service_role;
grant execute on function app.withdraw_allocation(uuid, text) to authenticated, service_role;
grant execute on function app.request_allocation(uuid, uuid, uuid, uuid, uuid, uuid, uuid, app.allocation_service_kind, numeric, timestamptz, timestamptz, text, text) to authenticated, service_role;
grant execute on function app.assign_allocation(uuid, uuid, uuid, uuid, uuid, uuid, uuid, app.allocation_service_kind, numeric, timestamptz, timestamptz, text, text, jsonb) to authenticated, service_role;
grant execute on function app.decide_allocation(uuid, app.approval_decision, text, jsonb) to authenticated, service_role;
grant execute on function app.split_allocation(uuid, jsonb) to authenticated, service_role;
grant execute on function app.unsplit_allocation(uuid, numeric) to authenticated, service_role;
grant execute on function app.issue_allocation(uuid, uuid, jsonb) to authenticated, service_role;

insert into private.sync_rpcs (rpc, description) values
  ('app.issue_allocation', 'Field issue of an allocation (badges, radios, rooms); replays are idempotent on the issue event id.');
