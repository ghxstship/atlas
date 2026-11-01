-- 2691_advance_allocations.sql
-- R7 Allocations, Atlas side (RRR-187, ADR 0103 and 0104, owner decision 8). What a party or a person is given for a
-- production, and the asset holds behind it. One owner per state (ADR 0104 section 2):
--
--   1. app.credential_categories.category_kind: Access or Parking. A parking pass is a credential category of kind
--      Parking, tied to parking zones through the existing app.access_grid.
--   2. app.asset_classes.offering (app.offering_kind, Radios or Carts): the class that answers for an asset offering,
--      one per org. The live classes bound to the canon radio and the 4-seat golf cart are backfilled, and
--      app.ensure_offering_asset_class finds, marks or creates the class for an org.
--   3. app.advance_allocations: one allocation of one target (a credential category, an asset class, a catering
--      fulfillment, an accommodation block, or Travel or Per Diem) to a party's pool (engagement_id) or to one person
--      (roster_entry_id), for a window in its time zone. Requested, Approved, Declined and Withdrawn are stored here
--      and change only through the RPCs of 2693; who decided, when and why live only in the lifecycle ledger. The
--      requester is the stamped created_by (private.allocation_requester). project_id is stamped from the holder and
--      registered (ADR 0022). No direct writes for signed-in users.
--   4. app.asset_reservations: the holds an approved asset allocation keeps, one per source (class stock, a pinned
--      unit, a lot or an order line), so mixed supply is several rows. Class, window and holder are read from the
--      allocation, never copied. Overlap is checked under row locks without btree_gist (ADR 0104 section 6): the
--      class row, then the unit, lot or order line row, FOR UPDATE, then the peak concurrent hold over the window
--      (private.asset_reservation_peak, a boundary sweep) against the capacity of private.asset_class_capacity.
--   5. app.credential_vehicles: the roster vehicle a parking pass is for, written only by app.issue_allocation. The
--      plate is never copied; when R5's retention purges the vehicle the link goes NULL.
--   6. app.advance_issue_events: one row per issue event, keyed by the caller's event id, so a replay of
--      app.issue_allocation writes nothing twice.
--   7. The separation of duties rule sod_allocation_requester and the allocation domain events.

-- 1. Parking passes are credential categories ---------------------------------------------------------------------------

alter table app.credential_categories add column category_kind app.credential_category_kind not null default 'Access';
comment on column app.credential_categories.category_kind is 'Access for a badge, Parking for a parking pass tied to parking zones through app.access_grid (R7). Fixed once a live allocation names the category.';

-- 2. Asset offerings ---------------------------------------------------------------------------------------------------------

alter table app.asset_classes add column offering app.offering_kind;
alter table app.asset_classes add constraint asset_classes_offering check (offering is null or offering in ('Radios', 'Carts'));
create unique index asset_classes_org_offering_key on app.asset_classes (org_id, offering) where offering is not null and deleted_at is null;
comment on column app.asset_classes.offering is 'The offering this class answers for, Radios or Carts, at most one live class per offering in an org (R7). NULL for site assets that are not an offering.';

update app.asset_classes set offering = 'Radios' where element_id = '3000.05.01-GHXST-013' and deleted_at is null and offering is null;
update app.asset_classes set offering = 'Carts' where element_id = '6000.02.06-XPMS-002' and deleted_at is null and offering is null;

create or replace function private.offering_asset_element(p_offering app.offering_kind)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_offering
    when 'Radios' then '3000.05.01-GHXST-013'
    when 'Carts' then '6000.02.06-XPMS-002'
  end;
$$;
comment on function private.offering_asset_element(app.offering_kind) is 'The canon element an asset offering seeds its class from: the two-way radio (0150 line 1878) for Radios, the 4-seat golf cart (0150 line 2357) for Carts; NULL for an offering that is not an asset.';
revoke all on function private.offering_asset_element(app.offering_kind) from public, anon, authenticated;

create or replace function app.ensure_offering_asset_class(p_org_id uuid, p_offering app.offering_kind)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_element text := private.offering_asset_element(p_offering);
  v_id uuid;
begin
  perform private.require_person();
  if p_org_id is null or not private.has_capability(p_org_id, 'assets.asset.write') then
    raise exception using errcode = '42501', message = 'assets.asset.write is required';
  end if;
  if v_element is null then
    perform private.refuse('offering_not_asset_class', 'Only radios and carts are offered from an asset class.');
  end if;
  select c.id into v_id from app.asset_classes c
  where c.org_id = p_org_id and c.offering = p_offering and c.deleted_at is null;
  if v_id is not null then
    return v_id;
  end if;
  update app.asset_classes c set offering = p_offering
  where c.org_id = p_org_id and c.element_id = v_element and c.deleted_at is null
  returning c.id into v_id;
  if v_id is not null then
    return v_id;
  end if;
  insert into app.asset_classes (org_id, element_id, name, offering)
  select p_org_id, e.element_id, left(coalesce(e.common_name, e.item), 200), p_offering
  from xpms.elements e where e.element_id = v_element
  returning id into v_id;
  return v_id;
end;
$$;
comment on function app.ensure_offering_asset_class(uuid, app.offering_kind) is 'The org''s asset class for an asset offering (Radios or Carts, R7): the live class carrying the offering, else the live class bound to the offering''s canon element, marked with it, else a new class bound to that element and named from its common name or item. Needs assets.asset.write in the org; another offering refuses offering_not_asset_class. This is how radios and carts are seeded.';
revoke all on function app.ensure_offering_asset_class(uuid, app.offering_kind) from public, anon;
grant execute on function app.ensure_offering_asset_class(uuid, app.offering_kind) to authenticated, service_role;

-- 3. Advance allocations ---------------------------------------------------------------------------------------------------------

create table app.advance_allocations (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  engagement_id uuid references app.engagements (id),
  roster_entry_id uuid references app.engagement_roster_entries (id),
  parent_allocation_id uuid references app.advance_allocations (id),
  credential_category_id uuid references app.credential_categories (id),
  asset_class_id uuid references app.asset_classes (id),
  fulfillment_id uuid references app.fulfillments (id),
  accommodation_block_id uuid references app.accommodation_blocks (id),
  service_kind app.allocation_service_kind,
  quantity numeric not null,
  needed_during tstzrange not null,
  needed_time_zone text not null,
  allocation_state app.allocation_state not null default 'Requested',
  origin app.allocation_origin not null,
  withdraw_cause app.allocation_withdraw_cause,
  note text,
  deleted_at timestamptz,
  constraint advance_allocations_one_holder check (num_nonnulls(engagement_id, roster_entry_id) = 1),
  constraint advance_allocations_one_target check (
    num_nonnulls(credential_category_id, asset_class_id, fulfillment_id, accommodation_block_id, service_kind) = 1),
  constraint advance_allocations_quantity check (quantity >= 0),
  constraint advance_allocations_window check (
    not isempty(needed_during) and not lower_inf(needed_during) and not upper_inf(needed_during)),
  constraint advance_allocations_withdraw_cause check ((allocation_state = 'Withdrawn') = (withdraw_cause is not null)),
  constraint advance_allocations_split_parent check ((origin = 'Split') = (parent_allocation_id is not null)),
  constraint advance_allocations_note_length check (note is null or char_length(btrim(note)) between 1 and 1000)
);

create index advance_allocations_project_state_idx on app.advance_allocations (project_id, allocation_state);
create index advance_allocations_engagement_id_idx on app.advance_allocations (engagement_id);
create index advance_allocations_roster_entry_id_idx on app.advance_allocations (roster_entry_id);
create index advance_allocations_parent_allocation_id_idx on app.advance_allocations (parent_allocation_id);
create index advance_allocations_credential_category_id_idx on app.advance_allocations (credential_category_id);
create index advance_allocations_asset_class_id_idx on app.advance_allocations (asset_class_id);
create index advance_allocations_fulfillment_id_idx on app.advance_allocations (fulfillment_id);
create index advance_allocations_accommodation_block_id_idx on app.advance_allocations (accommodation_block_id);

-- project_id is stamped before t10 derives org_id from it.
create or replace function private.stamp_allocation_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
begin
  if new.engagement_id is not null then
    select e.project_id into v_project from app.engagements e where e.id = new.engagement_id;
  else
    select e.project_id into v_project from app.engagement_roster_entries r
    join app.engagements e on e.id = r.engagement_id where r.id = new.roster_entry_id;
  end if;
  if tg_op = 'UPDATE' and new.project_id is distinct from old.project_id then
    perform private.refuse('allocation_project_fixed', 'An allocation keeps the project of its holder.');
  end if;
  if v_project is null then
    perform private.refuse('allocation_holder_missing', 'An allocation is held by an engagement or a roster entry of one.');
  end if;
  new.project_id := v_project;
  return new;
end;
$$;
comment on function private.stamp_allocation_project() is 'Advance allocations: project_id is the holder''s project, the engagement''s or the roster entry''s engagement''s, stamped on every write; a change is refused (allocation_project_fixed). Registered in the denormalization register.';
revoke all on function private.stamp_allocation_project() from public, anon, authenticated;
create trigger t05_stamp_allocation_project before insert or update on app.advance_allocations
  for each row execute function private.stamp_allocation_project();

call private.install_domain_table('app.advance_allocations', 'app.projects', 'project_id',
  array['app.engagements', 'engagement_id', 'app.engagement_roster_entries', 'roster_entry_id',
        'app.advance_allocations', 'parent_allocation_id', 'app.credential_categories', 'credential_category_id',
        'app.asset_classes', 'asset_class_id', 'app.fulfillments', 'fulfillment_id',
        'app.accommodation_blocks', 'accommodation_block_id']);
call private.describe('app.advance_allocations', 'What a production allocates to the people it engages (R7, ADR 0104): one target (a credential category, an asset class, a catering fulfillment, an accommodation block, or Travel or Per Diem) for a party''s pool or one person on a roster, for a window. Requested, Approved, Declined and Withdrawn are stored here and change only through the allocation RPCs; who decided, when and why are in app.advance_allocation_state_transitions. Holds, orders, possession and returns are read from the rows that own them (app.advance_allocation_status). Written only by RPCs.', array[
  'project_id', 'Project of the holder, stamped from the engagement or the roster entry''s engagement; never changes.',
  'engagement_id', 'Party pool: the engagement that holds the allocation until it is split to people. NULL when a roster entry holds it.',
  'roster_entry_id', 'One person: the roster entry that holds it. NULL for a pool.',
  'parent_allocation_id', 'Pool this allocation was split from; set exactly when origin is Split.',
  'credential_category_id', 'Credential category allocated: a badge, or a parking pass when the category kind is Parking.',
  'asset_class_id', 'Asset class allocated, such as the org''s radios or carts.',
  'fulfillment_id', 'Catering fulfillment the person eats at.',
  'accommodation_block_id', 'Accommodation block the room comes from.',
  'service_kind', 'Travel or Per Diem, for targets with no catalog row.',
  'quantity', 'How many: units, a quantity of stock, meals, rooms, trips or days. A pool goes down as it is split and may reach 0.',
  'needed_during', 'When the allocation is needed, a bounded range.',
  'needed_time_zone', 'IANA time zone of the window, for dates such as lodging nights and per diem days.',
  'allocation_state', 'Requested, Approved, Declined or Withdrawn. Changes only through the allocation RPCs.',
  'origin', 'Requested, Assigned (directly by a reviewer) or Split (from a pool).',
  'withdraw_cause', 'Why a Withdrawn allocation was withdrawn; set exactly when the state is Withdrawn.',
  'note', 'Note from the requester or assigner, 1 to 1000 characters.'
]);

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('advance_allocation', 'Requested', 'Approved'),
  ('advance_allocation', 'Requested', 'Declined'),
  ('advance_allocation', 'Requested', 'Withdrawn'),
  ('advance_allocation', 'Approved', 'Withdrawn');

call private.install_lifecycle('app.advance_allocations', 'advance_allocation_id', 'allocation_state', 'advance_allocation', 'Requested',
  $$advance_allocation_id in (select a.id from app.advance_allocations a where a.project_id in (select private.project_ids_with('advancing.packet.read')))$$);
-- A decline reason and an over-allowance reason run to 1000 characters (R7), longer than the ledger default of 500.
alter table app.advance_allocation_state_transitions drop constraint advance_allocation_state_transitions_reason_length;
alter table app.advance_allocation_state_transitions add constraint advance_allocation_state_transitions_reason_length
  check (char_length(btrim(reason)) between 1 and 1000);
comment on column app.advance_allocation_state_transitions.reason is 'Why the state changed, 1 to 1000 characters: a decline reason, an over-allowance reason or the RPC''s own wording.';
call private.install_default_retention('app.advance_allocation_state_transitions');

call private.install_policies('app.advance_allocations',
  $$project_id in (select private.project_ids_with('advancing.packet.read'))$$);
revoke insert, update, delete on app.advance_allocations from authenticated;
call private.install_default_retention('app.advance_allocations');
call private.install_audit_trail('app.advance_allocations');

-- Kind, offering and person of an allocation -----------------------------------------------------------------------------------

create or replace function private.allocation_kind(p_allocation app.advance_allocations)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_allocation.credential_category_id is not null then
      case (select k.category_kind from app.credential_categories k where k.id = p_allocation.credential_category_id)
        when 'Parking' then 'Parking Pass' else 'Credential' end
    when p_allocation.asset_class_id is not null then 'Asset'
    when p_allocation.fulfillment_id is not null then 'Catering'
    when p_allocation.accommodation_block_id is not null then 'Lodging'
    when p_allocation.service_kind = 'Travel' then 'Travel'
    when p_allocation.service_kind = 'Per Diem' then 'Per Diem'
  end;
$$;
comment on function private.allocation_kind(app.advance_allocations) is 'What an allocation gives, from its target and the category kind: Credential, Parking Pass, Asset, Catering, Lodging, Travel or Per Diem (R7).';
revoke all on function private.allocation_kind(app.advance_allocations) from public, anon, authenticated;

create or replace function private.allocation_offering_kind(p_allocation app.advance_allocations)
returns app.offering_kind
language sql
stable
security definer
set search_path = ''
as $$
  select case private.allocation_kind(p_allocation)
    when 'Parking Pass' then 'Parking'
    when 'Asset' then (select c.offering from app.asset_classes c where c.id = p_allocation.asset_class_id)
    when 'Catering' then 'Catering'
    when 'Lodging' then 'Lodging'
    when 'Travel' then 'Travel'
    when 'Per Diem' then 'Per Diem'
  end::app.offering_kind;
$$;
comment on function private.allocation_offering_kind(app.advance_allocations) is 'The offering an allocation draws on (R3''s app.offering_kind): Parking for a parking pass, the class offering for an asset (NULL for site assets that are no offering), Catering, Lodging, Travel or Per Diem; NULL for a badge, which is no offering.';
revoke all on function private.allocation_offering_kind(app.advance_allocations) from public, anon, authenticated;

create or replace function private.allocation_person(p_allocation app.advance_allocations)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.person_id from private.roster_people p where p.roster_entry_id = p_allocation.roster_entry_id;
$$;
comment on function private.allocation_person(app.advance_allocations) is 'The person an allocation is for: the roster entry''s resolved person (private.roster_people, R4); NULL for a party pool.';
revoke all on function private.allocation_person(app.advance_allocations) from public, anon, authenticated;

create or replace function private.allocation_engagement(p_allocation app.advance_allocations)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_allocation.engagement_id,
    (select r.engagement_id from app.engagement_roster_entries r where r.id = p_allocation.roster_entry_id));
$$;
comment on function private.allocation_engagement(app.advance_allocations) is 'The engagement an allocation is held under: the pool''s own, or the roster entry''s.';
revoke all on function private.allocation_engagement(app.advance_allocations) from public, anon, authenticated;

create or replace function private.allocation_requester(p_allocation_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select a.created_by from app.advance_allocations a where a.id = p_allocation_id;
$$;
comment on function private.allocation_requester(uuid) is 'Who requested an allocation, computed (ADR 0103 section 5): its created_by. The separation rule sod_allocation_requester compares it; R10 extends it with the person who claimed a token link.';
revoke all on function private.allocation_requester(uuid) from public, anon, authenticated;

create or replace function private.asset_class_serialized(p_asset_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from app.asset_units u where u.asset_class_id = p_asset_class_id and u.deleted_at is null)
    or exists (select 1 from app.asset_classes c join xpms.elements e on e.element_id = c.element_id
               where c.id = p_asset_class_id and e.unit_basis = 'each');
$$;
comment on function private.asset_class_serialized(uuid) is 'True when an asset class is counted in whole units: it has live serialized units, or its canon element is counted each.';
revoke all on function private.asset_class_serialized(uuid) from public, anon, authenticated;

-- The guard ------------------------------------------------------------------------------------------------------------------------

create or replace function private.guard_advance_allocation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_fulfillment app.fulfillments;
begin
  if tg_op = 'UPDATE' then
    if new.engagement_id is distinct from old.engagement_id or new.roster_entry_id is distinct from old.roster_entry_id
       or new.credential_category_id is distinct from old.credential_category_id or new.asset_class_id is distinct from old.asset_class_id
       or new.fulfillment_id is distinct from old.fulfillment_id or new.accommodation_block_id is distinct from old.accommodation_block_id
       or new.service_kind is distinct from old.service_kind or new.needed_during <> old.needed_during
       or new.needed_time_zone <> old.needed_time_zone or new.origin <> old.origin
       or new.parent_allocation_id is distinct from old.parent_allocation_id
       or (new.quantity <> old.quantity and not private.in_trusted_operation('allocation_split')) then
      perform private.refuse('allocation_immutable', 'An allocation keeps its holder, target, window and origin; its quantity changes only by a split.');
    end if;
    return new;
  end if;

  if new.quantity <= 0 then
    perform private.refuse('allocation_quantity_positive', 'An allocation is for a quantity above zero.');
  end if;
  if new.origin = 'Split' and not private.in_trusted_operation('allocation_split') then
    perform private.refuse('allocation_split_internal', 'A share of a pool is made by splitting the pool.');
  end if;
  if new.credential_category_id is not null and not exists (
      select 1 from app.credential_categories k
      where k.id = new.credential_category_id and k.project_id = new.project_id and k.deleted_at is null) then
    perform private.refuse('allocation_target_project', 'An allocation''s target belongs to the holder''s project or org.');
  end if;
  if new.asset_class_id is not null and not exists (
      select 1 from app.asset_classes c where c.id = new.asset_class_id and c.org_id = new.org_id and c.deleted_at is null) then
    perform private.refuse('allocation_target_project', 'An allocation''s target belongs to the holder''s project or org.');
  end if;
  if new.accommodation_block_id is not null and not exists (
      select 1 from app.accommodation_blocks b
      where b.id = new.accommodation_block_id and b.project_id = new.project_id and b.deleted_at is null) then
    perform private.refuse('allocation_target_project', 'An allocation''s target belongs to the holder''s project or org.');
  end if;
  if new.fulfillment_id is not null then
    select f.* into v_fulfillment from app.fulfillments f where f.id = new.fulfillment_id and f.deleted_at is null;
    if v_fulfillment.id is null or v_fulfillment.project_id <> new.project_id then
      perform private.refuse('allocation_target_project', 'An allocation''s target belongs to the holder''s project or org.');
    end if;
    if v_fulfillment.fulfillment_kind <> 'Catering' then
      perform private.refuse('allocation_target_kind', 'Only a catering fulfillment is allocated; travel and lodging have their own targets.');
    end if;
  end if;
  v_kind := private.allocation_kind(new);
  if new.quantity <> trunc(new.quantity)
     and (v_kind <> 'Asset' or private.asset_class_serialized(new.asset_class_id)) then
    perform private.refuse('allocation_quantity_whole', 'This item is allocated in whole numbers.');
  end if;
  perform private.assert_time_zone(new.needed_time_zone);
  return new;
end;
$$;
comment on function private.guard_advance_allocation() is 'Advance allocations: a new one is for a quantity above zero; a split share only from the split operation; its target on the holder''s project (category, fulfillment, block) or org (class), a fulfillment only when Catering; whole numbers for every kind but stock of a class that is not serialized; a known time zone. Holder, target, window, time zone, origin and parent never change, and the quantity only inside the allocation_split operation (allocation_immutable).';
revoke all on function private.guard_advance_allocation() from public, anon, authenticated;
create trigger t40_guard_advance_allocation before insert or update on app.advance_allocations
  for each row execute function private.guard_advance_allocation();

-- A category's kind stays while allocations name it.
create or replace function private.guard_credential_category_kind()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.category_kind <> old.category_kind and exists (
      select 1 from app.advance_allocations a
      where a.credential_category_id = new.id and a.deleted_at is null and a.allocation_state in ('Requested', 'Approved')) then
    perform private.refuse('credential_category_kind_in_use', 'A category keeps its kind while open allocations name it.');
  end if;
  return new;
end;
$$;
comment on function private.guard_credential_category_kind() is 'Credential categories: the kind (Access or Parking) stays while a Requested or Approved allocation names the category, so an allocation never changes kind under its holder.';
revoke all on function private.guard_credential_category_kind() from public, anon, authenticated;
create trigger t41_guard_credential_category_kind before update of category_kind on app.credential_categories
  for each row execute function private.guard_credential_category_kind();

-- 4. Asset reservations -----------------------------------------------------------------------------------------------------------

create table app.asset_reservations (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  advance_allocation_id uuid not null references app.advance_allocations (id),
  asset_unit_id uuid references app.asset_units (id),
  asset_lot_id uuid references app.asset_lots (id),
  po_line_id uuid references app.po_lines (id),
  quantity numeric not null,
  released_at timestamptz,
  release_reason app.reservation_release_reason,
  deleted_at timestamptz,
  constraint asset_reservations_quantity_positive check (quantity > 0),
  constraint asset_reservations_one_source check (num_nonnulls(asset_unit_id, asset_lot_id, po_line_id) <= 1),
  constraint asset_reservations_unit_is_one check (asset_unit_id is null or quantity = 1),
  constraint asset_reservations_release_pair check ((released_at is null) = (release_reason is null))
);
create index asset_reservations_advance_allocation_id_idx on app.asset_reservations (advance_allocation_id);
create index asset_reservations_asset_unit_id_idx on app.asset_reservations (asset_unit_id);
create index asset_reservations_asset_lot_id_idx on app.asset_reservations (asset_lot_id);
create index asset_reservations_po_line_id_idx on app.asset_reservations (po_line_id);
create index asset_reservations_project_id_idx on app.asset_reservations (project_id);

call private.install_domain_table('app.asset_reservations', 'app.advance_allocations', 'advance_allocation_id',
  array['app.projects', 'project_id', 'app.asset_units', 'asset_unit_id', 'app.asset_lots', 'asset_lot_id', 'app.po_lines', 'po_line_id']);
call private.describe('app.asset_reservations', 'Holds of approved asset allocations (R7, ADR 0104): a quantity held from one source, class stock (no source key), a pinned unit, a lot or the order line the item arrives on, until it is released. Mixed supply is one row per source. The class, window and holder are read from the allocation, never copied. Written only by the allocation RPCs; overlap is checked under row locks.', array[
  'project_id', 'Project of the allocation, stamped from it; never changes.',
  'advance_allocation_id', 'Approved asset allocation the hold serves.',
  'asset_unit_id', 'Unit pinned to the allocation; the quantity is 1.',
  'asset_lot_id', 'Lot the quantity is held from.',
  'po_line_id', 'Order line the item arrives on, bought or hired.',
  'quantity', 'Quantity held. Changes only when a pool is split or a hold released.',
  'released_at', 'When the hold was released; NULL while it holds.',
  'release_reason', 'Why it was released.'
]);
call private.install_policies('app.asset_reservations',
  $$project_id in (select private.project_ids_with('advancing.packet.read')) or org_id in (select private.orgs_with_capability('assets.asset.read'))$$);
revoke insert, update, delete on app.asset_reservations from authenticated;
call private.install_default_retention('app.asset_reservations');
call private.install_audit_trail('app.asset_reservations');

-- Capacity: what the class can supply over a window --------------------------------------------------------------------------------

create or replace function private.asset_class_capacity(p_asset_class_id uuid, p_window tstzrange)
returns table (serviceable_units integer, lot_quantity numeric, on_order_quantity numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with cls as (
    select c.id, c.org_id, c.element_id from app.asset_classes c where c.id = p_asset_class_id
  ),
  purchase_receipts as (
    select rl.id from app.receipt_lines rl
    join app.po_lines pl on pl.id = rl.po_line_id
    where pl.acquisition_kind = 'Purchase'
  )
  select
    (select count(*)::integer from app.asset_units u
     left join app.receipt_lines rl on rl.id = u.receipt_line_id
     left join app.po_lines pl on pl.id = rl.po_line_id
     where u.asset_class_id = p_asset_class_id and u.deleted_at is null
       and u.asset_state not in ('Proposed', 'Lost', 'Retired', 'Returned')
       and coalesce(pl.acquisition_kind, 'Purchase') = 'Purchase'),
    (select coalesce(sum(l.quantity + coalesce((
        select sum(m.delta) from app.asset_lot_movements m
        left join app.return_lines rt on rt.id = m.return_line_id
        where m.asset_lot_id = l.id
          and (m.movement_kind = 'Count'
            or (m.movement_kind = 'Receipt' and m.receipt_line_id in (select id from purchase_receipts))
            or (m.movement_kind = 'Vendor Return' and rt.receipt_line_id in (select id from purchase_receipts)))), 0)), 0)
     from app.asset_lots l where l.asset_class_id = p_asset_class_id and l.deleted_at is null),
    (select coalesce(sum(greatest(case
        when pl.acquisition_kind = 'Rental' then pl.quantity - coalesce(s.returned, 0)
        else pl.quantity - coalesce(s.received, 0) end, 0)), 0)
     from cls
     join app.po_lines pl on pl.element_id = cls.element_id and pl.org_id = cls.org_id and pl.deleted_at is null
     join app.purchase_orders po on po.id = pl.purchase_order_id and po.deleted_at is null and po.po_state <> 'Canceled'
     left join lateral (
       select sum(rl.quantity_received) as received,
         (select sum(r.quantity_returned) from app.return_lines r
          join app.goods_returns g on g.id = r.goods_return_id and g.deleted_at is null
          join app.receipt_lines rl2 on rl2.id = r.receipt_line_id and rl2.deleted_at is null
          where rl2.po_line_id = pl.id and r.deleted_at is null) as returned
       from app.receipt_lines rl
       join app.goods_receipts g on g.id = rl.goods_receipt_id and g.deleted_at is null
       where rl.po_line_id = pl.id and rl.deleted_at is null
     ) s on true
     where pl.acquisition_kind = 'Purchase' or p_window is null or pl.hire_period @> p_window);
$$;
comment on function private.asset_class_capacity(uuid, tstzrange) is 'What an asset class can supply over a window (R7, ADR 0104): serviceable owned units (not Proposed, Lost, Retired or Returned, and not received on a rental line), the owned quantity of its lots (opening count plus recounts and purchase receipts and returns; check-outs move custody, not ownership) and the quantity still on order: purchase lines of the class element not yet received, and rental lines whose hire period contains the window (NULL counts every rental), ordered minus returned. Orders that are Canceled count nothing. The reservation guard and app.asset_class_availability both read it.';
revoke all on function private.asset_class_capacity(uuid, tstzrange) from public, anon, authenticated;

create or replace function private.live_asset_reservations(p_asset_class_id uuid)
returns table (reservation_id uuid, asset_unit_id uuid, asset_lot_id uuid, po_line_id uuid, quantity numeric, needed_during tstzrange)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.asset_unit_id, r.asset_lot_id, r.po_line_id, r.quantity, a.needed_during
  from app.asset_reservations r
  join app.advance_allocations a on a.id = r.advance_allocation_id
  where a.asset_class_id = p_asset_class_id and r.released_at is null and r.deleted_at is null and a.deleted_at is null
    and a.allocation_state = 'Approved';
$$;
comment on function private.live_asset_reservations(uuid) is 'The holds of an asset class that still hold: unreleased, of a live Approved allocation, with the allocation''s window.';
revoke all on function private.live_asset_reservations(uuid) from public, anon, authenticated;

create or replace function private.asset_reservation_peak(p_asset_class_id uuid, p_window tstzrange, p_source text, p_source_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  with holds as (
    select h.quantity, h.needed_during * p_window as overlap
    from private.live_asset_reservations(p_asset_class_id) h
    where h.needed_during && p_window
      and case p_source
        when 'all' then true
        when 'stock' then h.asset_lot_id is null and h.po_line_id is null
        when 'unit' then h.asset_unit_id = p_source_id
        when 'lot' then h.asset_lot_id = p_source_id
        when 'line' then h.po_line_id = p_source_id
        else false
      end
  ),
  points as (
    select lower(p_window) as at
    union
    select lower(overlap) from holds
  )
  select coalesce(max(t.held), 0) from (
    select (select coalesce(sum(h.quantity), 0) from holds h where h.overlap @> p.at) as held from points p
  ) t;
$$;
comment on function private.asset_reservation_peak(uuid, tstzrange, text, uuid) is 'The most an asset class has held at once over a window, by a boundary sweep (as private.block_peak_occupancy does for rooms, 0440): the concurrent total is highest at the window start or where a hold starts, so only those points are summed. p_source narrows the holds: all, stock (class stock and pinned units), unit, lot or line (with p_source_id). Without btree_gist (ADR 0104 section 6).';
revoke all on function private.asset_reservation_peak(uuid, tstzrange, text, uuid) from public, anon, authenticated;

create or replace function private.lot_owned_quantity(p_asset_lot_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select l.quantity + coalesce((
    select sum(m.delta) from app.asset_lot_movements m
    left join app.receipt_lines rl on rl.id = m.receipt_line_id
    left join app.return_lines rt on rt.id = m.return_line_id
    left join app.receipt_lines rl2 on rl2.id = rt.receipt_line_id
    left join app.po_lines pl on pl.id = coalesce(rl.po_line_id, rl2.po_line_id)
    where m.asset_lot_id = l.id
      and (m.movement_kind = 'Count'
        or (m.movement_kind in ('Receipt', 'Vendor Return') and pl.acquisition_kind = 'Purchase'))), 0)
  from app.asset_lots l where l.id = p_asset_lot_id;
$$;
comment on function private.lot_owned_quantity(uuid) is 'What a lot owns, whoever has it out: the opening count plus recounts and purchase receipts and returns. Check-outs and check-ins move custody only; a rental received into the lot counts on its order line.';
revoke all on function private.lot_owned_quantity(uuid) from public, anon, authenticated;

create or replace function private.po_line_open_quantity(p_po_line_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select l.quantity - coalesce((
    select sum(r.quantity_returned) from app.return_lines r
    join app.goods_returns g on g.id = r.goods_return_id and g.deleted_at is null
    join app.receipt_lines rl on rl.id = r.receipt_line_id and rl.deleted_at is null
    where rl.po_line_id = l.id and r.deleted_at is null), 0)
  from app.po_lines l where l.id = p_po_line_id;
$$;
comment on function private.po_line_open_quantity(uuid) is 'What an order line can still supply to holds: the quantity ordered minus what went back to the vendor.';
revoke all on function private.po_line_open_quantity(uuid) from public, anon, authenticated;

create or replace function private.guard_asset_reservation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allocation app.advance_allocations;
  v_class app.asset_classes;
  v_unit app.asset_units;
  v_lot app.asset_lots;
  v_line app.po_lines;
  v_order app.purchase_orders;
begin
  if tg_op = 'UPDATE' then
    if new.advance_allocation_id <> old.advance_allocation_id or new.asset_unit_id is distinct from old.asset_unit_id
       or new.asset_lot_id is distinct from old.asset_lot_id or new.po_line_id is distinct from old.po_line_id
       or new.project_id <> old.project_id
       or old.released_at is not null
       or ((new.quantity <> old.quantity or new.released_at is distinct from old.released_at
            or new.release_reason is distinct from old.release_reason)
           and not (private.in_trusted_operation('allocation_split') or private.in_trusted_operation('reservation_release'))) then
      perform private.refuse('reservation_immutable', 'A hold keeps its allocation and source; its quantity and release change only by a split or a release.');
    end if;
    if new.quantity > old.quantity then
      -- More held on the same source (a share returned to its pool): lock as an insert does.
      select a.* into v_allocation from app.advance_allocations a where a.id = new.advance_allocation_id;
      perform 1 from app.asset_classes c where c.id = v_allocation.asset_class_id for update;
      perform 1 from app.asset_units u where u.id = new.asset_unit_id for update;
      perform 1 from app.asset_lots l where l.id = new.asset_lot_id for update;
      perform 1 from app.po_lines l where l.id = new.po_line_id for update;
    end if;
    return new;
  end if;

  select a.* into v_allocation from app.advance_allocations a where a.id = new.advance_allocation_id and a.deleted_at is null;
  if v_allocation.asset_class_id is null then
    perform private.refuse('reservation_allocation_kind', 'Only an asset allocation holds stock.');
  end if;
  if v_allocation.allocation_state <> 'Approved' then
    perform private.refuse('reservation_allocation_state', 'Stock is held for an approved allocation.');
  end if;
  new.project_id := v_allocation.project_id;
  new.released_at := null;
  new.release_reason := null;

  -- Lock order: the class row, then the source row (ADR 0104 section 6). app.apply_asset_scan locks the unit too.
  select c.* into v_class from app.asset_classes c where c.id = v_allocation.asset_class_id for update;
  if new.asset_unit_id is not null then
    select u.* into v_unit from app.asset_units u where u.id = new.asset_unit_id for update;
    if v_unit.id is null or v_unit.deleted_at is not null or v_unit.asset_class_id <> v_class.id then
      perform private.refuse('reservation_source_class', 'A hold comes from a unit, lot or order line of the allocation''s class.');
    end if;
    if v_unit.asset_state in ('Lost', 'Retired', 'Returned') then
      perform private.refuse('reservation_unit_unavailable', format('The unit is %s and cannot be held.', v_unit.asset_state));
    end if;
  elsif new.asset_lot_id is not null then
    select l.* into v_lot from app.asset_lots l where l.id = new.asset_lot_id for update;
    if v_lot.id is null or v_lot.deleted_at is not null or v_lot.asset_class_id <> v_class.id then
      perform private.refuse('reservation_source_class', 'A hold comes from a unit, lot or order line of the allocation''s class.');
    end if;
  elsif new.po_line_id is not null then
    select l.* into v_line from app.po_lines l where l.id = new.po_line_id for update;
    select po.* into v_order from app.purchase_orders po where po.id = v_line.purchase_order_id;
    if v_line.id is null or v_line.deleted_at is not null or v_line.element_id is distinct from v_class.element_id
       or v_order.project_id <> v_allocation.project_id or v_order.deleted_at is not null or v_order.po_state = 'Canceled' then
      perform private.refuse('reservation_source_class', 'A hold comes from a unit, lot or order line of the allocation''s class.');
    end if;
    if v_line.acquisition_kind = 'Rental' and not v_line.hire_period @> v_allocation.needed_during then
      perform private.refuse('reservation_outside_hire_period', 'A hold on a rental line falls inside its hire period.');
    end if;
  end if;
  return new;
end;
$$;
comment on function private.guard_asset_reservation() is 'Asset holds, before the write (R7, ADR 0104 section 6): a new hold serves an Approved asset allocation (reservation_allocation_kind, reservation_allocation_state) and takes its project; it locks the class row and then the unit, lot or order line row FOR UPDATE, so holds of one class serialize; its source is of the allocation''s class (a unit or lot of the class, or an order line of the class element on the allocation''s project whose order is not Canceled, reservation_source_class), a pinned unit is not Lost, Retired or Returned, and a rental line''s hire period contains the window. Afterwards only a split or a release changes the quantity and release (reservation_immutable). Capacity is checked after the write by private.check_asset_reservation_capacity.';
revoke all on function private.guard_asset_reservation() from public, anon, authenticated;
create trigger t40_guard_asset_reservation before insert or update on app.asset_reservations
  for each row execute function private.guard_asset_reservation();

create or replace function private.check_asset_reservation_capacity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allocation app.advance_allocations;
  v_capacity record;
begin
  if new.released_at is not null or new.deleted_at is not null or (tg_op = 'UPDATE' and new.quantity <= old.quantity) then
    return null;
  end if;
  select a.* into v_allocation from app.advance_allocations a where a.id = new.advance_allocation_id;
  select * into v_capacity from private.asset_class_capacity(v_allocation.asset_class_id, v_allocation.needed_during);

  if new.asset_unit_id is not null and exists (
      select 1 from private.live_asset_reservations(v_allocation.asset_class_id) h
      where h.asset_unit_id = new.asset_unit_id and h.reservation_id <> new.id and h.needed_during && v_allocation.needed_during) then
    perform private.refuse('reservation_unit_overlap', 'This unit is already held for another allocation in that window.');
  end if;
  if new.asset_lot_id is null and new.po_line_id is null
     and private.asset_reservation_peak(v_allocation.asset_class_id, v_allocation.needed_during, 'stock', null) > v_capacity.serviceable_units then
    perform private.refuse('reservation_over_capacity', 'Not enough of this class is free in that window.');
  end if;
  if new.asset_lot_id is not null
     and private.asset_reservation_peak(v_allocation.asset_class_id, v_allocation.needed_during, 'lot', new.asset_lot_id)
       > private.lot_owned_quantity(new.asset_lot_id) then
    perform private.refuse('reservation_over_capacity', 'Not enough of this class is free in that window.');
  end if;
  if new.po_line_id is not null
     and private.asset_reservation_peak(v_allocation.asset_class_id, v_allocation.needed_during, 'line', new.po_line_id)
       > private.po_line_open_quantity(new.po_line_id) then
    perform private.refuse('reservation_over_capacity', 'Not enough of this class is free in that window.');
  end if;
  if private.asset_reservation_peak(v_allocation.asset_class_id, v_allocation.needed_during, 'all', null)
       > v_capacity.serviceable_units + v_capacity.lot_quantity + v_capacity.on_order_quantity then
    perform private.refuse('reservation_over_capacity', 'Not enough of this class is free in that window.');
  end if;
  return null;
end;
$$;
comment on function private.check_asset_reservation_capacity() is 'Asset holds, after a new or larger hold is written under the guard''s row locks, so the sweep sees it and every committed hold: a pinned unit is not held by another allocation over an overlapping window (reservation_unit_overlap); class stock and pinned holds never exceed the serviceable owned units, a lot''s holds its owned quantity, an order line''s holds its quantity ordered minus returned, and all holds of the class the total the class can supply over the window (reservation_over_capacity). One unit may be held for several windows that do not overlap, because the hold is the row, not the unit state.';
revoke all on function private.check_asset_reservation_capacity() from public, anon, authenticated;
create trigger t41_check_asset_reservation_capacity after insert or update on app.asset_reservations
  for each row execute function private.check_asset_reservation_capacity();

-- 5. Parking passes name the vehicle ---------------------------------------------------------------------------------------------

create table app.credential_vehicles (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  credential_id uuid not null references app.credentials (id),
  roster_vehicle_id uuid references app.roster_vehicles (id) on delete set null,
  deleted_at timestamptz,
  constraint credential_vehicles_credential_key unique (credential_id)
);
create index credential_vehicles_roster_vehicle_id_idx on app.credential_vehicles (roster_vehicle_id);

call private.install_domain_table('app.credential_vehicles', 'app.credentials', 'credential_id', array['app.roster_vehicles', 'roster_vehicle_id']);
call private.describe('app.credential_vehicles', 'The vehicle a parking pass was issued for (R7): the holder''s roster vehicle on the pass''s engagement, linked, never copied. When the vehicle is purged the link goes NULL and the pass shows Vehicle removed. Written only by app.issue_allocation.', array[
  'credential_id', 'Parking pass.',
  'roster_vehicle_id', 'Roster vehicle of the holder''s entry; NULL once the vehicle was removed.'
]);
call private.install_policies('app.credential_vehicles',
  $$credential_id in (select c.id from app.credentials c
      where c.project_id in (select private.project_ids_with('credentials.credential.read'))
        or c.holder_person_id = (select private.current_person_id()))$$);
revoke insert, update, delete on app.credential_vehicles from authenticated;
call private.install_default_retention('app.credential_vehicles');
call private.install_audit_trail('app.credential_vehicles');

create or replace function private.guard_credential_vehicle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credential app.credentials;
begin
  if tg_op = 'UPDATE' and (new.credential_id <> old.credential_id
     or (new.roster_vehicle_id is not null and new.roster_vehicle_id is distinct from old.roster_vehicle_id)) then
    perform private.refuse('credential_vehicle_immutable', 'A parking pass keeps the vehicle it was issued for.');
  end if;
  if tg_op = 'UPDATE' or new.roster_vehicle_id is null then
    return new;
  end if;
  select c.* into v_credential from app.credentials c where c.id = new.credential_id;
  if (select k.category_kind from app.credential_categories k where k.id = v_credential.credential_category_id) <> 'Parking' then
    perform private.refuse('credential_vehicle_not_parking', 'Only a parking pass names a vehicle.');
  end if;
  if not exists (
      select 1 from app.roster_vehicles v
      join private.roster_people p on p.roster_entry_id = v.roster_entry_id
      where v.id = new.roster_vehicle_id and v.deleted_at is null
        and p.person_id = v_credential.holder_person_id and p.engagement_id = v_credential.engagement_id) then
    perform private.refuse('credential_vehicle_not_holders', 'A parking pass names the holder''s own vehicle on the pass''s engagement.');
  end if;
  return new;
end;
$$;
comment on function private.guard_credential_vehicle() is 'Credential vehicles: only a pass of a Parking category names a vehicle, the holder''s own roster vehicle on the pass''s engagement; the link never moves, though it goes NULL when the vehicle is purged.';
revoke all on function private.guard_credential_vehicle() from public, anon, authenticated;
create trigger t40_guard_credential_vehicle before insert or update on app.credential_vehicles
  for each row execute function private.guard_credential_vehicle();

-- 6. Issue events -------------------------------------------------------------------------------------------------------------------

create table app.advance_issue_events (
  id uuid primary key,
  org_id uuid not null references app.organizations (id),
  advance_allocation_id uuid not null references app.advance_allocations (id),
  possession jsonb not null,
  constraint advance_issue_events_possession_object check (jsonb_typeof(possession) = 'object')
);
create index advance_issue_events_advance_allocation_id_idx on app.advance_issue_events (advance_allocation_id);

call private.install_domain_table('app.advance_issue_events', 'app.advance_allocations', 'advance_allocation_id', '{}', true);
call private.describe('app.advance_issue_events', 'One row per issue of an allocation (R7), keyed by the event id the caller minted, so a replay of app.issue_allocation returns what the first call wrote and writes nothing twice. Append-only; read as allocations are.', array[
  'id', 'The caller''s event id (an API Idempotency-Key or a device-minted id).',
  'advance_allocation_id', 'Allocation issued.',
  'possession', 'Ids of the possession rows the event wrote, by table: credentials, asset_custody, asset_lot_movements, fulfillment_lines, accommodation_assignments, travel_segments or per_diems, with credential_vehicles.'
]);
call private.install_policies('app.advance_issue_events',
  $$advance_allocation_id in (select a.id from app.advance_allocations a where a.project_id in (select private.project_ids_with('advancing.packet.read')))$$);
call private.install_default_retention('app.advance_issue_events');

-- 7. Separation of duties and events -----------------------------------------------------------------------------------------------

insert into private.separation_of_duties_rules (code, enforced_on, description) values
  ('sod_allocation_requester', 'Advancing allocations', 'The person who requested an allocation cannot approve or decline it.')
on conflict (code) do nothing;

insert into private.domain_event_types (code, subject, description) values
  ('allocation.requested', 'advance_allocations', 'An allocation was requested or assigned to a party or a person.'),
  ('allocation.decided', 'advance_allocations', 'A requested allocation was approved or declined.'),
  ('allocation.withdrawn', 'advance_allocations', 'An allocation was withdrawn by its requester, a reviewer or a cascade.'),
  ('allocation.issued', 'advance_allocations', 'Part or all of an allocation was issued to its holder.'),
  ('reservation.released', 'asset_reservations', 'An asset hold was released.')
on conflict (code) do nothing;

create trigger t90_emit_allocation_requested after insert on app.advance_allocations
  for each row execute function private.emit_row_event('allocation.requested', 'project_id', 'origin', 'quantity', 'engagement_id', 'roster_entry_id');
create trigger t90_emit_allocation_decided after update of allocation_state on app.advance_allocations
  for each row when (old.allocation_state = 'Requested' and new.allocation_state in ('Approved', 'Declined'))
  execute function private.emit_row_event('allocation.decided', 'project_id', 'allocation_state');
create trigger t90_emit_allocation_withdrawn after update of allocation_state on app.advance_allocations
  for each row when (new.allocation_state = 'Withdrawn' and old.allocation_state <> 'Withdrawn')
  execute function private.emit_row_event('allocation.withdrawn', 'project_id', 'withdraw_cause');
create trigger t90_emit_allocation_issued after insert on app.advance_issue_events
  for each row execute function private.emit_subject_event('allocation.issued', 'advance_allocations', 'advance_allocation_id', 'possession');
create trigger t90_emit_reservation_released after update of released_at on app.asset_reservations
  for each row when (old.released_at is null and new.released_at is not null)
  execute function private.emit_row_event('reservation.released', 'project_id', 'release_reason', 'quantity');

-- The allocations list follows changes live (as 1450, 2170 and 2633).
do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_catalog.pg_publication_tables p
                     where p.pubname = 'supabase_realtime' and p.schemaname = 'app' and p.tablename = 'advance_allocations') then
    alter publication supabase_realtime add table app.advance_allocations;
  end if;
end $$;

insert into private.trash_excluded_tables (table_name, rationale) values
  ('advance_allocations', 'An allocation is declined or withdrawn through its lifecycle, never deleted and restored.'),
  ('asset_reservations', 'A hold is released, never deleted; a new hold is made by approving or reserving again.'),
  ('credential_vehicles', 'Written only by app.issue_allocation with its parking pass.'),
  ('advance_issue_events', 'Append-only issue ledger, read back for idempotent replays.')
on conflict (table_name) do nothing;

select private.sync_trash_tables();
