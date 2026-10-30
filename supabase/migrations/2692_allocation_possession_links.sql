-- 2692_allocation_possession_links.sql
-- R7 Allocations, Atlas side (RRR-187, ADR 0103 and 0104). Possession of an allocation is the row that hands it over,
-- never a state: a credential, a custody check-out, a lot check-out, a catering line, a room, a trip or a per diem
-- day, each carrying the allocation (or the hold) and, for people on a roster, the roster entry.
--
--   1. allocation_id on app.credentials, app.fulfillment_lines, app.accommodation_assignments, app.travel_segments
--      and app.per_diems, in place of app.advance_promotions for advancing items. Only app.issue_allocation writes a
--      linked row (allocation_issue_only); the link is fixed and always agrees with the allocation's target and
--      person (<table>_allocation_mismatch).
--   2. app.per_diems.roster_entry_id, a third worker column: a roster per diem names the entry alone, with
--      engagement_id NULL, so private.guard_engaged_worker (A130) is untouched. One per diem per entry and day.
--   3. app.asset_custody.roster_entry_id and reservation_id, with t44_guard_custody_holder: a reserved unit goes only
--      to its holder, within the hold's window and quantity, and an unreserved check-out never takes a unit someone
--      holds now or leaves too few for the holds that start now. Signed-in users no longer insert custody directly;
--      app.record_asset_custody keeps the old capability rule and writes through app.apply_asset_scan.
--   4. app.asset_lot_movements.roster_entry_id and reservation_id. A lot quantity is issued by a Check Out to the
--      engagement and returned by a Check In, either naming the entry and the hold (ADR 0104 section 2: no Issue or
--      Return kinds). The direction constraint is replaced from R7a's 2681 definition; a guard mirrors the custody
--      holder rules.
--   5. app.apply_asset_scan, from R1's 2602 definition, takes the roster entry and the hold, and stays the only writer
--      of custody and lot movement rows. One signature, still a sync RPC.
-- Units are no longer moved to Reserved by Atlas (R7): a hold is a row in app.asset_reservations. Units already
-- Reserved keep working; a later contract package retires the value.

-- 1. Possession rows name their allocation -------------------------------------------------------------------------------

alter table app.credentials add column allocation_id uuid references app.advance_allocations (id);
alter table app.fulfillment_lines add column allocation_id uuid references app.advance_allocations (id);
alter table app.accommodation_assignments add column allocation_id uuid references app.advance_allocations (id);
alter table app.travel_segments add column allocation_id uuid references app.advance_allocations (id);
alter table app.per_diems add column allocation_id uuid references app.advance_allocations (id);
create index credentials_allocation_id_idx on app.credentials (allocation_id);
create index fulfillment_lines_allocation_id_idx on app.fulfillment_lines (allocation_id);
create index accommodation_assignments_allocation_id_idx on app.accommodation_assignments (allocation_id);
create index travel_segments_allocation_id_idx on app.travel_segments (allocation_id);
create index per_diems_allocation_id_idx on app.per_diems (allocation_id);
comment on column app.credentials.allocation_id is 'Allocation the badge or parking pass was issued under (R7); written only by app.issue_allocation and fixed.';
comment on column app.fulfillment_lines.allocation_id is 'Catering allocation the line was issued under (R7); written only by app.issue_allocation and fixed.';
comment on column app.accommodation_assignments.allocation_id is 'Lodging allocation the room was issued under (R7); written only by app.issue_allocation and fixed.';
comment on column app.travel_segments.allocation_id is 'Travel allocation the trip was issued under (R7); written only by app.issue_allocation and fixed.';
comment on column app.per_diems.allocation_id is 'Per diem allocation the day was issued under (R7); written only by app.issue_allocation and fixed.';

-- 2. Roster per diems ------------------------------------------------------------------------------------------------------

alter table app.per_diems add column roster_entry_id uuid references app.engagement_roster_entries (id);
create index per_diems_roster_entry_id_idx on app.per_diems (roster_entry_id, day);
alter table app.per_diems drop constraint per_diems_one_worker;
alter table app.per_diems add constraint per_diems_one_worker check (num_nonnulls(membership_id, engagement_id, roster_entry_id) = 1);
create unique index per_diems_one_per_roster_entry_day on app.per_diems (roster_entry_id, day)
  where roster_entry_id is not null and deleted_at is null;
comment on column app.per_diems.roster_entry_id is 'Roster entry of the person paid, for a person on a party''s roster (R7). Exactly one of membership_id, engagement_id and roster_entry_id; engagement_id stays NULL for a roster per diem.';

create or replace function private.guard_roster_worker()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.roster_entry_id is distinct from old.roster_entry_id then
    perform private.refuse('per_diems_worker_immutable', 'The worker of time never changes.');
  end if;
  if tg_op = 'UPDATE' or new.roster_entry_id is null then
    return new;
  end if;
  if not exists (
      select 1 from app.engagement_roster_entries r
      join app.engagements e on e.id = r.engagement_id
      where r.id = new.roster_entry_id and r.deleted_at is null and e.deleted_at is null and e.project_id = new.project_id) then
    perform private.refuse('roster_worker_project', 'A roster per diem is for an entry on the per diem''s project.');
  end if;
  if not exists (
      select 1 from app.engagement_roster_entries r
      join app.engagements e on e.id = r.engagement_id
      where r.id = new.roster_entry_id and r.entry_state = 'Accepted' and r.person_response = 'Accepted'
        and e.engagement_state in ('Active', 'Closing')) then
    perform private.refuse('roster_worker_not_working', 'A roster per diem goes to an entry accepted by both sides while its engagement is Active or Closing.');
  end if;
  return new;
end;
$$;
comment on function private.guard_roster_worker() is 'Per diems paid through a roster entry (R7): the entry is live on the per diem''s project, accepted by the reviewer and the person, and its engagement Active or Closing; the worker never changes.';
revoke all on function private.guard_roster_worker() from public, anon, authenticated;
create trigger t38b_guard_roster_worker before insert or update of roster_entry_id on app.per_diems
  for each row execute function private.guard_roster_worker();

call private.install_tenant_guards('app.per_diems', 'app.projects', 'project_id',
  array['app.memberships', 'membership_id', 'app.engagements', 'engagement_id',
        'app.engagement_roster_entries', 'roster_entry_id', 'app.advance_allocations', 'allocation_id']);
call private.install_policies('app.per_diems',
  $$project_id in (select private.project_ids_with('crew.time_entry.read'))
    or membership_id in (select private.my_membership_ids())
    or engagement_id in (select private.my_engagement_ids('operational'))
    or roster_entry_id in (select private.my_roster_entry_ids('operational'))$$,
  $$project_id in (select private.project_ids_with('crew.time_entry.write'))$$);

call private.install_tenant_guards('app.credentials', 'app.credential_categories', 'credential_category_id',
  array['app.advance_allocations', 'allocation_id']);
call private.install_tenant_guards('app.fulfillment_lines', 'app.fulfillments', 'fulfillment_id',
  array['app.advance_allocations', 'allocation_id']);
call private.install_tenant_guards('app.accommodation_assignments', 'app.accommodation_blocks', 'accommodation_block_id',
  array['app.advance_allocations', 'allocation_id']);
call private.install_tenant_guards('app.travel_segments', 'app.projects', 'project_id',
  array['app.fulfillments', 'fulfillment_id', 'app.advance_allocations', 'allocation_id']);

-- The link agrees with the allocation --------------------------------------------------------------------------------------

create or replace function private.guard_allocation_possession()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text := tg_table_name;
  v_row jsonb := to_jsonb(new);
  v_allocation app.advance_allocations;
  v_entry_engagement uuid;
  v_ok boolean;
begin
  if tg_op = 'UPDATE' and new.allocation_id is distinct from old.allocation_id then
    perform private.refuse(v_table || '_allocation_mismatch', 'An issued row keeps the allocation it was issued under.');
  end if;
  if new.allocation_id is null then
    return new;
  end if;
  if tg_op = 'INSERT' and not private.in_trusted_operation('allocation_issue') then
    perform private.refuse('allocation_issue_only', 'Items of an allocation are handed over by issuing the allocation.');
  end if;
  select a.* into v_allocation from app.advance_allocations a where a.id = new.allocation_id;
  select r.engagement_id into v_entry_engagement from app.engagement_roster_entries r where r.id = v_allocation.roster_entry_id;
  v_ok := v_allocation.id is not null and v_allocation.roster_entry_id is not null
    and (tg_op = 'UPDATE' or (v_allocation.allocation_state = 'Approved' and v_allocation.deleted_at is null));
  if v_ok then
    v_ok := case v_table
      when 'credentials' then
        (v_row ->> 'credential_category_id')::uuid = v_allocation.credential_category_id
        and (v_row ->> 'holder_person_id')::uuid = private.allocation_person(v_allocation)
        and (v_row ->> 'engagement_id')::uuid is not distinct from v_entry_engagement
      when 'fulfillment_lines' then
        (v_row ->> 'fulfillment_id')::uuid = v_allocation.fulfillment_id
        and (v_row ->> 'person_id')::uuid is not distinct from private.allocation_person(v_allocation)
      when 'accommodation_assignments' then
        (v_row ->> 'accommodation_block_id')::uuid = v_allocation.accommodation_block_id
        and (v_row ->> 'person_id')::uuid = private.allocation_person(v_allocation)
      when 'travel_segments' then
        v_allocation.service_kind = 'Travel' and (v_row ->> 'project_id')::uuid = v_allocation.project_id
        and (v_row ->> 'person_id')::uuid = private.allocation_person(v_allocation)
        and (v_row ->> 'engagement_id')::uuid is not distinct from v_entry_engagement
      when 'per_diems' then
        v_allocation.service_kind = 'Per Diem' and (v_row ->> 'project_id')::uuid = v_allocation.project_id
        and (v_row ->> 'roster_entry_id')::uuid is not distinct from v_allocation.roster_entry_id
      else false
    end;
  end if;
  if not coalesce(v_ok, false) then
    perform private.refuse(v_table || '_allocation_mismatch',
      'An issued row matches its Approved allocation: the same target and the allocation''s person on its engagement.');
  end if;
  return new;
end;
$$;
comment on function private.guard_allocation_possession() is 'Credentials, fulfillment lines, room assignments, travel segments and per diems issued under an allocation (R7): only app.issue_allocation writes a linked row (allocation_issue_only); the allocation is Approved and held by a roster entry, the row has its target (category, fulfillment, block, or Travel or Per Diem on its project) and its person (the holder, guest, traveller, or the roster entry for a per diem), and a credential or trip carries the entry''s engagement; the link never changes and keeps agreeing on later updates (<table>_allocation_mismatch).';
revoke all on function private.guard_allocation_possession() from public, anon, authenticated;

create trigger t43_guard_allocation_possession before insert or update on app.credentials
  for each row when (new.allocation_id is not null) execute function private.guard_allocation_possession();
create trigger t43_guard_allocation_possession_change before update of allocation_id on app.credentials
  for each row when (old.allocation_id is not null) execute function private.guard_allocation_possession();
create trigger t43_guard_allocation_possession before insert or update on app.fulfillment_lines
  for each row when (new.allocation_id is not null) execute function private.guard_allocation_possession();
create trigger t43_guard_allocation_possession_change before update of allocation_id on app.fulfillment_lines
  for each row when (old.allocation_id is not null) execute function private.guard_allocation_possession();
create trigger t43_guard_allocation_possession before insert or update on app.accommodation_assignments
  for each row when (new.allocation_id is not null) execute function private.guard_allocation_possession();
create trigger t43_guard_allocation_possession_change before update of allocation_id on app.accommodation_assignments
  for each row when (old.allocation_id is not null) execute function private.guard_allocation_possession();
create trigger t43_guard_allocation_possession before insert or update on app.travel_segments
  for each row when (new.allocation_id is not null) execute function private.guard_allocation_possession();
create trigger t43_guard_allocation_possession_change before update of allocation_id on app.travel_segments
  for each row when (old.allocation_id is not null) execute function private.guard_allocation_possession();
create trigger t43_guard_allocation_possession before insert or update on app.per_diems
  for each row when (new.allocation_id is not null) execute function private.guard_allocation_possession();
create trigger t43_guard_allocation_possession_change before update of allocation_id on app.per_diems
  for each row when (old.allocation_id is not null) execute function private.guard_allocation_possession();

-- Badges go to the people on a company engagement's roster (from R1's 2601) ----------------------------------------------------

create or replace function private.guard_credential_engagement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
begin
  if new.engagement_id is null then
    return new;
  end if;
  select e.* into v_engagement from app.engagements e
  where e.id = new.engagement_id and e.project_id = new.project_id and e.deleted_at is null;
  if v_engagement.id is null then
    perform private.refuse('credential_engagement_project', 'A credential''s engagement belongs to the same project as its category.');
  end if;
  if v_engagement.engagement_state in ('Complete', 'Canceled') then
    perform private.refuse('credential_engagement_closed', 'A badge is issued under an engagement that is still open.');
  end if;
  if v_engagement.person_id is distinct from new.holder_person_id and v_engagement.role_type <> 'Artist'
     and not exists (
       select 1 from private.roster_people p
       join app.engagement_roster_entries r on r.id = p.roster_entry_id
       where p.engagement_id = v_engagement.id and p.person_id = new.holder_person_id
         and r.deleted_at is null and r.entry_state = 'Accepted') then
    perform private.refuse('credential_engagement_holder', 'A badge issued under an engagement is held by the person it names; only an artist''s engagement carries party badges.');
  end if;
  return new;
end;
$$;
comment on function private.guard_credential_engagement() is 'Credentials: an engagement, when given, is a live engagement on the credential''s project that is not Complete or Canceled, and names the holder, or has the holder as the resolved person of a live Accepted roster entry (R7), unless it is an Artist engagement carrying party badges (R1).';
revoke all on function private.guard_credential_engagement() from public, anon, authenticated;

-- 3. Custody goes to the holder ------------------------------------------------------------------------------------------------

alter table app.asset_custody add column roster_entry_id uuid references app.engagement_roster_entries (id);
alter table app.asset_custody add column reservation_id uuid references app.asset_reservations (id);
create index asset_custody_roster_entry_id_idx on app.asset_custody (roster_entry_id);
create index asset_custody_reservation_id_idx on app.asset_custody (reservation_id);
alter table app.asset_custody add constraint asset_custody_roster_engagement check (roster_entry_id is null or custodian_engagement_id is not null);
comment on column app.asset_custody.roster_entry_id is 'The person on the custodian engagement''s roster who holds the asset (R7). Requires custodian_engagement_id; when a hold is named it is the hold''s allocation entry (a guarded copy, registered).';
comment on column app.asset_custody.reservation_id is 'Hold the asset was issued against (R7); the issue counts toward that allocation.';
call private.install_tenant_guards('app.asset_custody', 'app.asset_units', 'asset_unit_id',
  array['app.memberships', 'custodian_membership_id', 'app.projects', 'project_id', 'app.venues', 'venue_id',
        'app.engagements', 'custodian_engagement_id', 'app.engagement_roster_entries', 'roster_entry_id',
        'app.asset_reservations', 'reservation_id']);

-- Custody is written only by definer RPCs from now on (ADR 0103 section 4).
drop policy if exists asset_custody_insert on app.asset_custody;
revoke insert on app.asset_custody from authenticated;

create or replace function private.roster_entry_working(p_roster_entry_id uuid, p_engagement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.engagement_roster_entries r
    where r.id = p_roster_entry_id and r.engagement_id = p_engagement_id and r.deleted_at is null
      and r.entry_state = 'Accepted' and r.person_response = 'Accepted');
$$;
comment on function private.roster_entry_working(uuid, uuid) is 'True when a roster entry of the engagement is live and accepted by the reviewer and by the person (R7).';
revoke all on function private.roster_entry_working(uuid, uuid) from public, anon, authenticated;

create or replace function private.reservation_holder_matches(p_reservation_id uuid, p_engagement_id uuid, p_roster_entry_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.asset_reservations r
    join app.advance_allocations a on a.id = r.advance_allocation_id
    where r.id = p_reservation_id
      and ((a.roster_entry_id is not null and a.roster_entry_id = p_roster_entry_id)
        or (a.roster_entry_id is null and p_roster_entry_id is null and a.engagement_id = p_engagement_id)));
$$;
comment on function private.reservation_holder_matches(uuid, uuid, uuid) is 'True when a custodian is the holder of a hold''s allocation: its roster entry, or, for a party pool, the pool''s engagement with no entry named.';
revoke all on function private.reservation_holder_matches(uuid, uuid, uuid) from public, anon, authenticated;

create or replace function private.unit_reservation_issued(p_reservation_id uuid, p_except_unit uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(distinct c.asset_unit_id)::integer from app.asset_custody c
  where c.reservation_id = p_reservation_id and c.asset_unit_id is distinct from p_except_unit;
$$;
comment on function private.unit_reservation_issued(uuid, uuid) is 'How many distinct units custody rows have issued against a hold, leaving one unit out (the one being issued now).';
revoke all on function private.unit_reservation_issued(uuid, uuid) from public, anon, authenticated;

create or replace function private.guard_custody_holder()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_unit app.asset_units;
  v_hold app.asset_reservations;
  v_allocation app.advance_allocations;
  v_free integer;
  v_owed numeric;
begin
  if new.roster_entry_id is not null and not exists (
      select 1 from app.engagement_roster_entries r where r.id = new.roster_entry_id and r.engagement_id = new.custodian_engagement_id) then
    perform private.refuse('custody_roster_engagement', 'The person holding the asset is on the custodian engagement''s roster.');
  end if;
  if new.roster_entry_id is not null and not private.roster_entry_working(new.roster_entry_id, new.custodian_engagement_id) then
    perform private.refuse('custody_roster_entry_not_live', 'Gear goes to a roster entry accepted by the reviewer and by the person.');
  end if;
  if num_nonnulls(new.custodian_membership_id, new.custodian_engagement_id) = 0 then
    if new.reservation_id is not null then
      perform private.refuse('custody_not_reserved_holder', 'A held asset goes only to the holder of its hold.');
    end if;
    return new;
  end if;
  select u.* into v_unit from app.asset_units u where u.id = new.asset_unit_id;

  if new.reservation_id is not null then
    select r.* into v_hold from app.asset_reservations r where r.id = new.reservation_id;
    select a.* into v_allocation from app.advance_allocations a where a.id = v_hold.advance_allocation_id;
    if v_hold.id is null or v_hold.released_at is not null or v_hold.deleted_at is not null or v_hold.asset_lot_id is not null
       or v_allocation.allocation_state <> 'Approved' or v_allocation.deleted_at is not null
       or v_allocation.asset_class_id <> v_unit.asset_class_id
       or (v_hold.asset_unit_id is not null and v_hold.asset_unit_id <> v_unit.id)
       or new.custodian_membership_id is not null
       or not private.reservation_holder_matches(v_hold.id, new.custodian_engagement_id, new.roster_entry_id) then
      perform private.refuse('custody_not_reserved_holder', 'A held asset goes only to the holder of its hold.');
    end if;
    if now() >= upper(v_allocation.needed_during) then
      perform private.refuse('custody_reservation_window', 'The hold''s window has ended.');
    end if;
    if private.unit_reservation_issued(v_hold.id, v_unit.id) >= v_hold.quantity then
      perform private.refuse('custody_reservation_exhausted', 'Everything this hold covers is already issued.');
    end if;
    return new;
  end if;

  -- An unreserved hand-over: never a unit someone else holds now.
  if exists (
      select 1 from app.asset_reservations r
      join app.advance_allocations a on a.id = r.advance_allocation_id
      where r.asset_unit_id = v_unit.id and r.released_at is null and r.deleted_at is null
        and a.allocation_state = 'Approved' and a.deleted_at is null and a.needed_during @> now()
        and (new.custodian_membership_id is not null
          or not private.reservation_holder_matches(r.id, new.custodian_engagement_id, new.roster_entry_id))) then
    perform private.refuse('asset_reserved_for_other', 'This asset is held for someone else now.');
  end if;
  -- A check-out from stock leaves enough free units for the class-stock holds that hold now.
  if v_unit.asset_state in ('Available', 'Reserved') then
    select count(*)::integer into v_free from app.asset_units u
    where u.asset_class_id = v_unit.asset_class_id and u.deleted_at is null and u.id <> v_unit.id
      and u.asset_state in ('Available', 'Reserved')
      and not exists (select 1 from app.asset_reservations r join app.advance_allocations a on a.id = r.advance_allocation_id
                      where r.asset_unit_id = u.id and r.released_at is null and r.deleted_at is null
                        and a.allocation_state = 'Approved' and a.needed_during @> now());
    select coalesce(sum(greatest(r.quantity - private.unit_reservation_issued(r.id, null), 0)), 0) into v_owed
    from app.asset_reservations r
    join app.advance_allocations a on a.id = r.advance_allocation_id
    where a.asset_class_id = v_unit.asset_class_id and r.asset_unit_id is null and r.asset_lot_id is null and r.po_line_id is null
      and r.released_at is null and r.deleted_at is null and a.allocation_state = 'Approved' and a.deleted_at is null
      and a.needed_during @> now();
    if v_free < v_owed then
      perform private.refuse('asset_class_held_for_reservations', 'The units left of this class are held for others now; issue it against a hold.');
    end if;
  end if;
  return new;
end;
$$;
comment on function private.guard_custody_holder() is 'Custody holders (R7, decision 8): a roster entry named is on the custodian engagement (custody_roster_engagement) and accepted by both sides (custody_roster_entry_not_live). Against a hold: the hold is live, of a unit of the allocation''s class (the pinned unit, when pinned), the allocation Approved, and the custodian its holder, the entry or the pool engagement with no entry (custody_not_reserved_holder); the window has not ended (custody_reservation_window); and it has units left (custody_reservation_exhausted). Without a hold: never a unit held by someone else now (asset_reserved_for_other), and a check-out from stock never leaves fewer free units than the class-stock holds that hold now still owe (asset_class_held_for_reservations). Check-ins pass.';
revoke all on function private.guard_custody_holder() from public, anon, authenticated;
create trigger t44_guard_custody_holder before insert on app.asset_custody
  for each row execute function private.guard_custody_holder();

-- 4. Lot movements carry the holder --------------------------------------------------------------------------------------------------

alter table app.asset_lot_movements add column roster_entry_id uuid references app.engagement_roster_entries (id);
alter table app.asset_lot_movements add column reservation_id uuid references app.asset_reservations (id);
create index asset_lot_movements_roster_entry_id_idx on app.asset_lot_movements (roster_entry_id);
create index asset_lot_movements_reservation_id_idx on app.asset_lot_movements (reservation_id);
comment on column app.asset_lot_movements.roster_entry_id is 'The person on the custodian engagement''s roster who took or returned the quantity (R7). Requires custodian_engagement_id; when a hold is named it is the hold''s allocation entry (a guarded copy, registered).';
comment on column app.asset_lot_movements.reservation_id is 'Hold of this lot a Check Out issues against, or a Check In returns to (R7).';

-- From R7a's 2681 definition: a Check Out or Check In may carry the roster entry and the hold.
alter table app.asset_lot_movements drop constraint asset_lot_movements_direction;
alter table app.asset_lot_movements add constraint asset_lot_movements_direction check (
  ((movement_kind = 'Check Out' and delta < 0 and num_nonnulls(custodian_membership_id, custodian_engagement_id) = 1)
   or (movement_kind = 'Check In' and delta > 0)
   or movement_kind = 'Count'
   or (movement_kind = 'Receipt' and delta > 0 and receipt_line_id is not null
       and custodian_membership_id is null and custodian_engagement_id is null)
   or (movement_kind = 'Vendor Return' and delta < 0 and return_line_id is not null
       and custodian_membership_id is null and custodian_engagement_id is null))
  and (receipt_line_id is null or movement_kind = 'Receipt')
  and (return_line_id is null or movement_kind = 'Vendor Return')
  and (roster_entry_id is null or custodian_engagement_id is not null)
  and (reservation_id is null or movement_kind in ('Check Out', 'Check In')));

call private.install_tenant_guards('app.asset_lot_movements', 'app.asset_lots', 'asset_lot_id',
  array['app.memberships', 'custodian_membership_id', 'app.projects', 'project_id', 'app.engagements', 'custodian_engagement_id',
        'app.receipt_lines', 'receipt_line_id', 'app.return_lines', 'return_line_id',
        'app.engagement_roster_entries', 'roster_entry_id', 'app.asset_reservations', 'reservation_id']);

create or replace function private.lot_reservation_issued(p_reservation_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(-m.delta) filter (where m.movement_kind = 'Check Out'), 0)
  from app.asset_lot_movements m where m.reservation_id = p_reservation_id;
$$;
comment on function private.lot_reservation_issued(uuid) is 'The quantity Check Out movements have issued against a lot hold.';
revoke all on function private.lot_reservation_issued(uuid) from public, anon, authenticated;

create or replace function private.guard_lot_movement_holder()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hold app.asset_reservations;
  v_allocation app.advance_allocations;
  v_on_hand numeric;
  v_owed numeric;
begin
  if new.roster_entry_id is not null and not exists (
      select 1 from app.engagement_roster_entries r where r.id = new.roster_entry_id and r.engagement_id = new.custodian_engagement_id) then
    perform private.refuse('custody_roster_engagement', 'The person holding the asset is on the custodian engagement''s roster.');
  end if;
  if new.movement_kind = 'Check Out' and new.roster_entry_id is not null
     and not private.roster_entry_working(new.roster_entry_id, new.custodian_engagement_id) then
    perform private.refuse('custody_roster_entry_not_live', 'Gear goes to a roster entry accepted by the reviewer and by the person.');
  end if;

  if new.reservation_id is not null then
    select r.* into v_hold from app.asset_reservations r where r.id = new.reservation_id;
    if v_hold.asset_lot_id is distinct from new.asset_lot_id then
      perform private.refuse('lot_reservation_mismatch', 'A lot movement names a hold of that lot.');
    end if;
    if new.movement_kind = 'Check Out' then
      select a.* into v_allocation from app.advance_allocations a where a.id = v_hold.advance_allocation_id;
      if v_hold.released_at is not null or v_hold.deleted_at is not null or v_allocation.allocation_state <> 'Approved'
         or v_allocation.deleted_at is not null or new.custodian_membership_id is not null
         or not private.reservation_holder_matches(v_hold.id, new.custodian_engagement_id, new.roster_entry_id) then
        perform private.refuse('custody_not_reserved_holder', 'A held asset goes only to the holder of its hold.');
      end if;
      if now() >= upper(v_allocation.needed_during) then
        perform private.refuse('custody_reservation_window', 'The hold''s window has ended.');
      end if;
      if private.lot_reservation_issued(v_hold.id) - new.delta > v_hold.quantity then
        perform private.refuse('custody_reservation_exhausted', 'Everything this hold covers is already issued.');
      end if;
    end if;
    return new;
  end if;

  -- An unreserved check-out leaves what the lot's holds that hold now still owe.
  if new.movement_kind = 'Check Out' then
    select b.on_hand into v_on_hand from app.asset_lot_balances b where b.asset_lot_id = new.asset_lot_id;
    select coalesce(sum(greatest(r.quantity - private.lot_reservation_issued(r.id), 0)), 0) into v_owed
    from app.asset_reservations r
    join app.advance_allocations a on a.id = r.advance_allocation_id
    where r.asset_lot_id = new.asset_lot_id and r.released_at is null and r.deleted_at is null
      and a.allocation_state = 'Approved' and a.deleted_at is null and a.needed_during @> now();
    -- Taking the lot below zero is t45's refusal (asset_lot_insufficient); this one is about what holds still owe.
    if v_owed > 0 and coalesce(v_on_hand, 0) + new.delta >= 0 and coalesce(v_on_hand, 0) + new.delta < v_owed then
      perform private.refuse('lot_held_for_reservations', 'What is left of this lot is held for others now; issue it against a hold.');
    end if;
  end if;
  return new;
end;
$$;
comment on function private.guard_lot_movement_holder() is 'Lot movements, mirroring the custody holder rules (R7): a roster entry named is on the custodian engagement and, on a Check Out, accepted by both sides; a hold named is of the movement''s lot (lot_reservation_mismatch); a Check Out against it goes to its holder while the hold is live and its allocation Approved (custody_not_reserved_holder), before its window ends (custody_reservation_window) and within its quantity (custody_reservation_exhausted); an unreserved Check Out never leaves less on hand than the lot''s holds that hold now still owe (lot_held_for_reservations).';
revoke all on function private.guard_lot_movement_holder() from public, anon, authenticated;
create trigger t44_guard_lot_movement_holder before insert on app.asset_lot_movements
  for each row execute function private.guard_lot_movement_holder();

-- 5. Applying a scan event (from 2602) ----------------------------------------------------------------------------------------------

drop function app.apply_asset_scan(uuid, uuid, text, app.asset_scan_action, uuid, uuid, uuid, uuid, text, numeric);

create or replace function app.apply_asset_scan(
  p_event_id uuid,
  p_org_id uuid,
  p_code text,
  p_action app.asset_scan_action,
  p_custodian_membership_id uuid default null,
  p_custodian_engagement_id uuid default null,
  p_venue_id uuid default null,
  p_project_id uuid default null,
  p_note text default null,
  p_quantity numeric default null,
  p_roster_entry_id uuid default null,
  p_reservation_id uuid default null
)
returns table (outcome text, subject_kind text, subject_id uuid, ledger_id uuid, asset_state app.asset_state, on_hand numeric)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_found record;
  v_unit app.asset_units%rowtype;
  v_lot app.asset_lots%rowtype;
  v_current record;
  v_existing record;
  v_project uuid;
  v_venue uuid;
  v_target app.asset_state;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_engagement uuid := p_custodian_engagement_id;
begin
  perform private.require_scan_access(p_org_id);
  if not private.reads_all_assets(p_org_id) then
    raise exception using errcode = '42501', message = 'assets.custody.write is required';
  end if;
  if p_event_id is null then
    perform private.refuse('asset_scan_event_required', 'Every scan carries the event id the device minted.');
  end if;
  select * into v_found from private.find_asset_code(p_org_id, p_code);
  if v_found.o_rule is not null then
    perform private.refuse(v_found.o_rule, 'NO_ANSWER: no single asset or lot carries this code.');
  end if;
  -- A roster entry is held under its own engagement (R7).
  if p_roster_entry_id is not null and v_engagement is null and p_custodian_membership_id is null then
    select r.engagement_id into v_engagement from app.engagement_roster_entries r where r.id = p_roster_entry_id;
  end if;

  -- Lots ------------------------------------------------------------------------------------------------
  if v_found.o_lot_id is not null then
    select * into v_lot from app.asset_lots l where l.id = v_found.o_lot_id for update;
    select m.id, m.asset_lot_id into v_existing from app.asset_lot_movements m where m.id = p_event_id;
    if v_existing.id is not null then
      if v_existing.asset_lot_id <> v_lot.id then
        perform private.refuse('asset_scan_event_reused', 'This scan event already moved another lot.');
      end if;
      return query select 'duplicate'::text, 'lot'::text, v_lot.id, p_event_id, null::app.asset_state,
        (select b.on_hand from app.asset_lot_balances b where b.asset_lot_id = v_lot.id);
      return;
    end if;
    if p_action = 'transfer' then
      perform private.refuse('asset_scan_lot_transfer', 'Check a lot quantity in, then out again, to pass it on.');
    end if;
    if p_quantity is null or p_quantity <= 0 then
      perform private.refuse('asset_scan_quantity_required', 'Say how many of the lot move.');
    end if;
    -- A quantity checked out to an engagement is out for the engagement's project.
    v_project := p_project_id;
    if p_action = 'check-out' and v_engagement is not null then
      v_project := coalesce(p_project_id, (select e.project_id from app.engagements e where e.id = v_engagement));
    end if;
    if not (private.has_capability(p_org_id, 'assets.custody.write')
            or (v_project is not null and private.can_on_project(v_project, 'assets.custody.write'))) then
      raise exception using errcode = '42501', message = 'assets.custody.write is required';
    end if;
    if p_action = 'check-out' and num_nonnulls(p_custodian_membership_id, v_engagement) <> 1 then
      perform private.refuse('asset_scan_custodian_required', 'Name the one member or engagement that takes the quantity.');
    end if;
    if p_action = 'check-out' and v_engagement is not null then
      v_project := private.scan_engagement_project(v_engagement, p_project_id);
    end if;
    insert into app.asset_lot_movements (id, org_id, asset_lot_id, movement_kind, delta, custodian_membership_id, custodian_engagement_id,
      project_id, note, roster_entry_id, reservation_id)
    values (p_event_id, v_lot.org_id, v_lot.id,
            case when p_action = 'check-out' then 'Check Out' else 'Check In' end::app.asset_lot_movement_kind,
            case when p_action = 'check-out' then -p_quantity else p_quantity end,
            p_custodian_membership_id, v_engagement, v_project, v_note, p_roster_entry_id, p_reservation_id);
    return query select 'applied'::text, 'lot'::text, v_lot.id, p_event_id, null::app.asset_state,
      (select b.on_hand from app.asset_lot_balances b where b.asset_lot_id = v_lot.id);
    return;
  end if;

  -- Units -----------------------------------------------------------------------------------------------
  -- Lock the unit so a replay racing its first attempt sees the first attempt's custody row.
  select * into v_unit from app.asset_units u where u.id = v_found.o_unit_id for update;
  select c.id, c.asset_unit_id into v_existing from app.asset_custody c where c.id = p_event_id;
  if v_existing.id is not null then
    if v_existing.asset_unit_id <> v_unit.id then
      perform private.refuse('asset_scan_event_reused', 'This scan event already moved another asset.');
    end if;
    return query select 'duplicate'::text, 'unit'::text, v_unit.id, p_event_id, v_unit.asset_state, null::numeric;
    return;
  end if;

  if v_unit.asset_state in ('Proposed', 'Received', 'In Maintenance', 'Damaged', 'Lost', 'Retired', 'Returned') then
    perform private.refuse('asset_scan_unavailable', format('The asset is %s and cannot move by scan.', v_unit.asset_state));
  end if;
  if (p_action = 'check-out' and v_unit.asset_state not in ('Available', 'Reserved'))
     or (p_action in ('check-in', 'transfer') and v_unit.asset_state <> 'Deployed') then
    perform private.refuse('asset_scan_state_conflict', format('The asset is %s now; refresh before you scan again.', v_unit.asset_state));
  end if;

  select c.custodian_membership_id, c.project_id into v_current
  from app.asset_custody c where c.asset_unit_id = v_unit.id order by c.created_at desc, c.id desc limit 1;
  v_project := case when p_action = 'check-in' then null else coalesce(p_project_id, v_current.project_id) end;
  -- An asset handed to an engagement is out for the engagement's project.
  if p_action <> 'check-in' and v_engagement is not null then
    v_project := coalesce(p_project_id, (select e.project_id from app.engagements e where e.id = v_engagement), v_project);
  end if;
  if not (private.has_capability(p_org_id, 'assets.custody.write')
          or (coalesce(v_project, v_current.project_id) is not null
              and private.can_on_project(coalesce(v_project, v_current.project_id), 'assets.custody.write'))) then
    raise exception using errcode = '42501', message = 'assets.custody.write is required';
  end if;

  if p_action = 'check-in' then
    v_venue := coalesce(p_venue_id, v_unit.home_venue_id);
    if v_venue is null then
      perform private.refuse('asset_scan_place_required', 'Name the place the asset comes back to.');
    end if;
    insert into app.asset_custody (id, org_id, asset_unit_id, custodian_membership_id, venue_id, project_id, note)
    values (p_event_id, v_unit.org_id, v_unit.id, null, v_venue, null, v_note);
    v_target := 'Available';
  else
    if num_nonnulls(p_custodian_membership_id, v_engagement) <> 1 then
      perform private.refuse('asset_scan_custodian_required', 'Name the one member or engagement that takes the asset.');
    end if;
    if v_engagement is not null then
      v_project := private.scan_engagement_project(v_engagement, p_project_id);
    end if;
    -- The custody holder guard (t44) checks the roster entry and the hold, and that no one else holds the unit.
    insert into app.asset_custody (id, org_id, asset_unit_id, custodian_membership_id, custodian_engagement_id, venue_id, project_id, note,
      roster_entry_id, reservation_id)
    values (p_event_id, v_unit.org_id, v_unit.id, p_custodian_membership_id, v_engagement, p_venue_id, v_project, v_note,
      p_roster_entry_id, p_reservation_id);
    v_target := case when p_action = 'check-out' then 'Deployed' end;
  end if;

  if v_target is not null and v_target <> v_unit.asset_state then
    perform private.transition_lifecycle('asset', 'app.asset_units', 'asset_state', 'app.asset_state_transitions',
      'asset_unit_id', v_unit.id, v_unit.asset_state::text, v_target::text,
      case when p_action = 'check-out' then 'Checked out by scan.' else 'Checked in by scan.' end);
  end if;
  return query select 'applied'::text, 'unit'::text, v_unit.id, p_event_id, coalesce(v_target, v_unit.asset_state), null::numeric;
end;
$$;
comment on function app.apply_asset_scan(uuid, uuid, text, app.asset_scan_action, uuid, uuid, uuid, uuid, text, numeric, uuid, uuid) is 'Applies one scan event in one transaction, the only writer of custody and lot movement rows: resolves the code, writes the custody row or lot movement under the device''s event id, and moves the unit state (check-out to Deployed, check-in to Available). A unit or a lot quantity goes to exactly one member or engagement; an engagement must be open (not Complete or Canceled) and the asset is out for its project, so a different given project is refused (R1). R7: the hand-over may name the roster entry (its engagement is the custodian when none is given) and the hold it is issued against, and the holder guards refuse a unit or quantity held for someone else; a lot quantity is issued by a Check Out and returned by a Check In naming them. A replayed event id returns duplicate and changes nothing. Units that are not in a state the action starts from are refused with their current state. Needs assets.custody.write org-wide or on the project.';
revoke all on function app.apply_asset_scan(uuid, uuid, text, app.asset_scan_action, uuid, uuid, uuid, uuid, text, numeric, uuid, uuid) from public, anon;
grant execute on function app.apply_asset_scan(uuid, uuid, text, app.asset_scan_action, uuid, uuid, uuid, uuid, text, numeric, uuid, uuid) to authenticated, service_role;

-- The custody create of API v1, kept through the scan --------------------------------------------------------------------------------

create or replace function app.record_asset_custody(
  p_asset_unit_id uuid,
  p_custodian_membership_id uuid default null,
  p_custodian_engagement_id uuid default null,
  p_venue_id uuid default null,
  p_project_id uuid default null,
  p_note text default null,
  p_roster_entry_id uuid default null,
  p_reservation_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_unit app.asset_units;
  v_action app.asset_scan_action;
  v_result record;
begin
  perform private.require_person();
  select u.* into v_unit from app.asset_units u where u.id = p_asset_unit_id and u.deleted_at is null;
  if v_unit.id is null
     or not (private.has_capability(v_unit.org_id, 'assets.custody.write')
       or (p_project_id is not null and private.can_on_project(p_project_id, 'assets.custody.write'))) then
    raise exception using errcode = '42501', message = 'assets.custody.write is required';
  end if;
  v_action := case
    when num_nonnulls(p_custodian_membership_id, p_custodian_engagement_id, p_roster_entry_id) = 0 then 'check-in'
    when v_unit.asset_state = 'Deployed' then 'transfer'
    else 'check-out'
  end;
  select * into v_result from app.apply_asset_scan(private.uuid_v7(), v_unit.org_id, v_unit.asset_tag, v_action,
    p_custodian_membership_id, p_custodian_engagement_id, p_venue_id, p_project_id, p_note, null, p_roster_entry_id, p_reservation_id);
  return v_result.ledger_id;
end;
$$;
comment on function app.record_asset_custody(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid) is 'Records a custody hand-over of a unit with the rule of the old insert policy (assets.custody.write org-wide or on the given project, R7): with no custodian a check-in to the venue, to a Deployed unit a transfer, otherwise a check-out. It writes through app.apply_asset_scan, so the unit moves to Deployed or Available in the same transaction and every holder guard applies. Returns the custody row id. The API''s assetCustodyEntries create calls it.';
revoke all on function app.record_asset_custody(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid) from public, anon;
grant execute on function app.record_asset_custody(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid) to authenticated, service_role;
