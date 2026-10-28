-- 2681_supply_bridge.sql
-- R7a Supply bridge (RRR-183, ADR 0104 sections 3 and 4). Procurement already owns Ordered (po_state Approved or Sent),
-- Confirmed (app.po_acknowledgments) and Received (app.goods_receipts, app.receipt_lines); this file adds only the
-- links that were missing, and stores no copy of those facts:
--
--   1. Rentals on order lines: app.po_lines.acquisition_kind (Purchase or Rental) and hire_period, set together.
--      Lines still change only while the order is Proposed (private.guard_po_line, 0331, unchanged).
--   2. app.goods_returns and app.return_lines: goods sent back to the vendor against the receipt lines that brought
--      them in, written only by app.return_goods. They take no Trash: neither has a title, and a return is undone by
--      receiving again, never by restoring a row.
--   3. app.asset_units.receipt_line_id: the receipt line a unit arrived on, fixed once set. A unit's owner, cost and
--      vendor are read through it (unit, receipt line, order line, order), never stored on the unit.
--   4. app.asset_lot_movements.receipt_line_id and return_line_id, with the Receipt and Vendor Return kinds.
--      asset_lot_movements_direction starts from R1's 2602 definition (a Check Out names exactly one custodian, a
--      member or an engagement; asset_lot_movements_one_custodian stays) and adds the two kinds. R7 replaces the
--      constraint once more.
--   5. The tenth asset state, Returned: reached from Available, Damaged or In Maintenance, and only through a goods
--      return. app.transition_asset (from 0352) refuses it otherwise.
--   6. app.receive_goods: one receipt event in one transaction, keyed by the event id so a replay records nothing
--      twice. Lines may bring serialized units in by asset tag or a quantity into a lot at a venue. It replaces the
--      client-side receipt writes and is replayable from Compass (private.sync_rpcs).
--   7. app.return_goods: one return event, by units or out of a lot, with the same idempotency.

-- 1. Rentals on order lines --------------------------------------------------------------------------------------------

alter table app.po_lines add column acquisition_kind app.acquisition_kind not null default 'Purchase';
alter table app.po_lines add column hire_period tstzrange;
alter table app.po_lines add constraint po_lines_hire_period_kind
  check ((acquisition_kind = 'Rental') = (hire_period is not null));
alter table app.po_lines add constraint po_lines_hire_period_bounded
  check (hire_period is null or (not isempty(hire_period) and not lower_inf(hire_period) and not upper_inf(hire_period)));
comment on column app.po_lines.acquisition_kind is 'Purchase buys the item outright; Rental hires it for hire_period and returns it to the vendor at off-hire (ADR 0104).';
comment on column app.po_lines.hire_period is 'Rental lines only: when the hire starts and ends (both bounds set). Off-hire is due at its upper bound; NULL on a Purchase line.';

-- 2. Goods returns ---------------------------------------------------------------------------------------------------------

insert into private.domain_event_types (code, subject, description) values
  ('goods.returned', 'goods_returns', 'Goods were returned to the vendor against a purchase order (off-hire or a purchase return).')
on conflict (code) do nothing;

create table app.goods_returns (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  purchase_order_id uuid not null references app.purchase_orders (id),
  returned_at timestamptz not null default now(),
  returned_by uuid references app.people (id),
  return_reason app.goods_return_reason not null,
  note text,
  deleted_at timestamptz,
  constraint goods_returns_note_length check (note is null or char_length(btrim(note)) between 1 and 1000)
);
create index goods_returns_purchase_order_id_idx on app.goods_returns (purchase_order_id);
create index goods_returns_returned_by_idx on app.goods_returns (returned_by);

call private.install_domain_table('app.goods_returns', 'app.purchase_orders', 'purchase_order_id');
call private.install_policies('app.goods_returns',
  $$purchase_order_id in (select po.id from app.purchase_orders po where po.project_id in (select private.project_ids_with('procurement.po.read')))$$);
call private.describe('app.goods_returns', 'Goods sent back to the vendor against a purchase order: a rental at off-hire, or bought goods that were defective, the wrong item or more than ordered. Read like goods receipts; written only by app.return_goods, whose event id is the row id.', array[
  'purchase_order_id', 'Purchase order the goods were received on.',
  'returned_at', 'When the goods went back.',
  'returned_by', 'Person who returned the goods, from the session.',
  'return_reason', 'Why the goods went back. Off Hire only for rental lines.',
  'note', 'Condition or carrier noted at the return.'
]);
call private.install_default_retention('app.goods_returns');
call private.install_audit_trail('app.goods_returns');

create table app.return_lines (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  goods_return_id uuid not null references app.goods_returns (id),
  receipt_line_id uuid not null references app.receipt_lines (id),
  asset_unit_id uuid references app.asset_units (id),
  quantity_returned numeric not null,
  deleted_at timestamptz,
  constraint return_lines_quantity_positive check (quantity_returned > 0),
  constraint return_lines_unit_is_one check (asset_unit_id is null or quantity_returned = 1)
);
create index return_lines_goods_return_id_idx on app.return_lines (goods_return_id);
create index return_lines_receipt_line_id_idx on app.return_lines (receipt_line_id);
create unique index return_lines_unit_once on app.return_lines (asset_unit_id) where asset_unit_id is not null and deleted_at is null;

call private.install_domain_table('app.return_lines', 'app.goods_returns', 'goods_return_id',
  array['app.receipt_lines', 'receipt_line_id', 'app.asset_units', 'asset_unit_id']);
call private.install_policies('app.return_lines',
  $$goods_return_id in (select r.id from app.goods_returns r join app.purchase_orders po on po.id = r.purchase_order_id
     where po.project_id in (select private.project_ids_with('procurement.po.read')))$$);
call private.describe('app.return_lines', 'What went back in a goods return, per receipt line: one row per serialized unit (quantity 1), or a quantity. Returns never exceed what the receipt line brought in. Written only by app.return_goods.', array[
  'goods_return_id', 'Return the line belongs to.',
  'receipt_line_id', 'Receipt line of the same order that brought the goods in.',
  'asset_unit_id', 'Serialized unit returned, received on that receipt line; it becomes Returned. NULL for a quantity.',
  'quantity_returned', 'Quantity returned; 1 for a unit.'
]);
call private.install_default_retention('app.return_lines');
call private.install_audit_trail('app.return_lines');

create or replace function private.guard_goods_return()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.returned_by := coalesce(private.current_person_id(), new.returned_by);
  elsif new.purchase_order_id <> old.purchase_order_id or new.returned_by is distinct from old.returned_by
     or new.return_reason <> old.return_reason then
    perform private.refuse('goods_return_immutable', 'A goods return keeps its purchase order, returner and reason.');
  end if;
  return new;
end;
$$;
comment on function private.guard_goods_return() is 'Goods returns: the returner comes from the session; order, returner and reason never change.';
revoke all on function private.guard_goods_return() from public, anon, authenticated;
create trigger t40_guard_goods_return before insert or update on app.goods_returns
  for each row execute function private.guard_goods_return();
create trigger t90_emit_goods_returned after insert on app.goods_returns
  for each row execute function private.emit_subject_event('goods.returned', 'goods_returns', 'id', 'purchase_order_id', 'return_reason', 'returned_at');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('goods_returns', 'Written only by app.return_goods with its lines, units and lot movements; a return is undone by receiving the goods again, never restored from Trash.'),
  ('return_lines', 'Written only by app.return_goods; a returned unit stays Returned, so restoring a line could never undo the return.')
on conflict (table_name) do nothing;

-- 3. Units arrive on a receipt line ----------------------------------------------------------------------------------------

alter table app.asset_units add column receipt_line_id uuid references app.receipt_lines (id);
create index asset_units_receipt_line_idx on app.asset_units (receipt_line_id);
comment on column app.asset_units.receipt_line_id is 'Receipt line the unit arrived on; fixed once set. Its order line names the element, acquisition kind, hire period and price, and its order the vendor (app.asset_unit_provenance), so none of them is stored on the unit.';
call private.install_tenant_guards('app.asset_units', 'app.asset_classes', 'asset_class_id',
  array['app.venues', 'home_venue_id', 'app.receipt_lines', 'receipt_line_id']);

create or replace function private.guard_asset_unit_receipt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_received numeric;
  v_element text;
  v_units integer;
begin
  if tg_op = 'UPDATE' and old.receipt_line_id is not null and new.receipt_line_id is distinct from old.receipt_line_id then
    perform private.refuse('unit_receipt_immutable', 'A unit keeps the receipt line it arrived on.');
  end if;
  if new.receipt_line_id is null then
    return new;
  end if;
  -- Serialize units of one receipt line on its row so two inserts cannot both pass the count.
  select rl.quantity_received, pl.element_id into v_received, v_element
  from app.receipt_lines rl join app.po_lines pl on pl.id = rl.po_line_id
  where rl.id = new.receipt_line_id
  for update of rl;
  if v_element is distinct from (select c.element_id from app.asset_classes c where c.id = new.asset_class_id) then
    perform private.refuse('unit_receipt_element', 'A unit arrives on a receipt line that ordered its class''s element.');
  end if;
  select count(*) into v_units from app.asset_units u
  where u.receipt_line_id = new.receipt_line_id and u.deleted_at is null and u.id <> new.id;
  if new.deleted_at is null and v_units + 1 > v_received then
    perform private.refuse('unit_receipt_exceeds', 'A receipt line brings in no more units than the quantity it received.');
  end if;
  return new;
end;
$$;
comment on function private.guard_asset_unit_receipt() is 'Asset units on a receipt line (R7a): the line ordered the unit''s class element, the line''s live units never exceed its quantity received, and the link never changes once set.';
revoke all on function private.guard_asset_unit_receipt() from public, anon, authenticated;
create trigger t42_guard_asset_unit_receipt before insert or update of receipt_line_id on app.asset_units
  for each row execute function private.guard_asset_unit_receipt();

-- 4. Lot movements from receipts and to the vendor ------------------------------------------------------------------------

alter table app.asset_lot_movements add column receipt_line_id uuid references app.receipt_lines (id);
alter table app.asset_lot_movements add column return_line_id uuid references app.return_lines (id);
create index asset_lot_movements_receipt_line_idx on app.asset_lot_movements (receipt_line_id);
create index asset_lot_movements_return_line_idx on app.asset_lot_movements (return_line_id);
comment on column app.asset_lot_movements.receipt_line_id is 'Receipt movements only: the receipt line whose quantity came into the lot.';
comment on column app.asset_lot_movements.return_line_id is 'Vendor Return movements only: the return line whose quantity left the lot for the vendor.';

-- From R1's 2602 definition: a Check Out names exactly one custodian, a member or an engagement.
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
  and (return_line_id is null or movement_kind = 'Vendor Return'));

call private.install_tenant_guards('app.asset_lot_movements', 'app.asset_lots', 'asset_lot_id',
  array['app.memberships', 'custodian_membership_id', 'app.projects', 'project_id', 'app.engagements', 'custodian_engagement_id',
        'app.receipt_lines', 'receipt_line_id', 'app.return_lines', 'return_line_id']);

comment on table app.asset_lot_movements is 'Append-only lot ledger: each row moves a lot quantity by a delta, for a recount, a check-out to a member or engagement, a check-in, a receipt against a purchase order line, or a return to the vendor. On hand is the opening count plus the deltas (app.asset_lot_balances).';

-- 5. Returned --------------------------------------------------------------------------------------------------------------

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('asset', 'Available', 'Returned'),
  ('asset', 'Damaged', 'Returned'),
  ('asset', 'In Maintenance', 'Returned');

-- From 0352: Returned is reached only inside app.return_goods.
create or replace function app.transition_asset(p_asset_unit_id uuid, p_expected app.asset_state, p_next app.asset_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select a.org_id from app.asset_units a where a.id = p_asset_unit_id);
  v_capability text := case when p_next = 'Retired' then 'assets.write_off.approve' else 'assets.asset.write' end;
begin
  perform private.require_person();
  if p_next = 'Returned' and not private.in_trusted_operation('goods_return') then
    perform private.refuse('asset_returned_through_goods_return', 'A unit goes back to its vendor through a goods return on its purchase order.');
  end if;
  if v_org is null or not private.has_capability(v_org, v_capability) then
    raise exception using errcode = '42501', message = format('%s is required', v_capability);
  end if;
  return private.transition_lifecycle('asset', 'app.asset_units', 'asset_state', 'app.asset_state_transitions',
    'asset_unit_id', p_asset_unit_id, p_expected::text, p_next::text, p_reason);
end;
$$;
comment on function app.transition_asset(uuid, app.asset_state, app.asset_state, text) is 'Moves an asset along its ten-value lifecycle with compare-and-set; retiring needs assets.write_off.approve, the rest assets.asset.write. Returned is reached only through a goods return (app.return_goods, R7a).';
revoke all on function app.transition_asset(uuid, app.asset_state, app.asset_state, text) from public, anon;
grant execute on function app.transition_asset(uuid, app.asset_state, app.asset_state, text) to authenticated, service_role;

-- 6. Receiving against an order -----------------------------------------------------------------------------------------------

create or replace function private.receipt_event_result(p_outcome text, p_goods_receipt_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'outcome', p_outcome,
    'goods_receipt_id', p_goods_receipt_id,
    'receipt_line_ids', coalesce((select jsonb_agg(rl.id order by rl.created_at, rl.id) from app.receipt_lines rl
                                  where rl.goods_receipt_id = p_goods_receipt_id), '[]'::jsonb),
    'asset_unit_ids', coalesce((select jsonb_agg(u.id order by u.created_at, u.id) from app.asset_units u
                                join app.receipt_lines rl on rl.id = u.receipt_line_id
                                where rl.goods_receipt_id = p_goods_receipt_id), '[]'::jsonb),
    'lot_movement_ids', coalesce((select jsonb_agg(m.id order by m.created_at, m.id) from app.asset_lot_movements m
                                  join app.receipt_lines rl on rl.id = m.receipt_line_id
                                  where rl.goods_receipt_id = p_goods_receipt_id), '[]'::jsonb));
$$;
comment on function private.receipt_event_result(text, uuid) is 'The result of a receipt event read back from its stored rows: the receipt, its lines, the units they brought in and their lot movements.';
revoke all on function private.receipt_event_result(text, uuid) from public, anon, authenticated;

create or replace function app.receive_goods(p_event_id uuid, p_purchase_order_id uuid, p_lines jsonb, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order app.purchase_orders;
  v_existing app.goods_receipts;
  v_line jsonb;
  v_po_line app.po_lines;
  v_receipt_line uuid;
  v_class uuid;
  v_quantity numeric;
  v_venue uuid;
  v_tag text;
  v_unit uuid;
  v_lot uuid;
begin
  perform private.require_person();
  if p_event_id is null then
    perform private.refuse('receipt_event_required', 'Every receipt carries the event id it was recorded under.');
  end if;
  -- Receipts of one order serialize on the order row, so a replay racing its first attempt sees the first attempt.
  select * into v_order from app.purchase_orders po where po.id = p_purchase_order_id and po.deleted_at is null for update;
  select * into v_existing from app.goods_receipts g where g.id = p_event_id;
  if v_existing.id is not null then
    if v_existing.purchase_order_id is distinct from v_order.id then
      perform private.refuse('receipt_event_reused', 'This receipt event already recorded a receipt on another purchase order.');
    end if;
    return private.receipt_event_result('duplicate', p_event_id);
  end if;
  if v_order.id is null or not private.can_on_project(v_order.project_id, 'procurement.receipt.write') then
    raise exception using errcode = '42501', message = 'procurement.receipt.write is required';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    perform private.refuse('receipt_lines_required', 'A receipt receives at least one line.');
  end if;

  -- The receipt guard refuses an order that is not Approved or Sent (receipt_order_state).
  insert into app.goods_receipts (id, purchase_order_id, note)
  values (p_event_id, v_order.id, nullif(btrim(coalesce(p_note, '')), ''));

  for v_line in select l from jsonb_array_elements(p_lines) l loop
    v_quantity := (v_line ->> 'quantity')::numeric;
    v_class := null;
    -- The receipt line guard refuses a line of another order (receipt_line_order) and more than ordered
    -- (receipt_exceeds_order).
    insert into app.receipt_lines (goods_receipt_id, po_line_id, quantity_received)
    values (p_event_id, (v_line ->> 'po_line_id')::uuid, v_quantity)
    returning id into v_receipt_line;
    select * into v_po_line from app.po_lines l where l.id = (v_line ->> 'po_line_id')::uuid;
    v_venue := (v_line ->> 'venue_id')::uuid;

    if jsonb_typeof(v_line -> 'asset_tags') = 'array' or v_venue is not null then
      if jsonb_typeof(v_line -> 'asset_tags') = 'array' and v_venue is not null then
        perform private.refuse('receipt_line_target_ambiguous', 'A receipt line brings units in by tag or a quantity into a lot, not both.');
      end if;
      select c.id into v_class from app.asset_classes c
      where c.org_id = v_order.org_id and c.element_id = v_po_line.element_id and c.deleted_at is null;
      if v_class is null then
        perform private.refuse('receipt_no_asset_class', 'The ordered item has no asset class, so it cannot come into stock.');
      end if;
    end if;

    if jsonb_typeof(v_line -> 'asset_tags') = 'array' then
      if v_quantity <> trunc(v_quantity) or v_quantity <> jsonb_array_length(v_line -> 'asset_tags') then
        perform private.refuse('receipt_tags_count', 'Give one asset tag for each unit received.');
      end if;
      if not private.has_capability(v_order.org_id, 'assets.asset.write') then
        raise exception using errcode = '42501', message = 'assets.asset.write is required';
      end if;
      for v_tag in select upper(btrim(t)) from jsonb_array_elements_text(v_line -> 'asset_tags') t loop
        begin
          insert into app.asset_units (asset_class_id, asset_tag, condition_enum_id, receipt_line_id)
          values (v_class, v_tag, nullif(v_line ->> 'condition_enum_id', ''), v_receipt_line)
          returning id into v_unit;
        exception when unique_violation then
          perform private.refuse('receipt_tag_taken', format('Asset tag %s is already in use.', v_tag));
        end;
        perform private.transition_lifecycle('asset', 'app.asset_units', 'asset_state', 'app.asset_state_transitions',
          'asset_unit_id', v_unit, 'Proposed', 'Received', format('Received on PO %s.', v_order.po_number));
      end loop;
    elsif v_venue is not null then
      if not private.has_capability(v_order.org_id, 'assets.asset.write') then
        raise exception using errcode = '42501', message = 'assets.asset.write is required';
      end if;
      insert into app.asset_lots (asset_class_id, venue_id, quantity)
      values (v_class, v_venue, 0)
      on conflict (asset_class_id, venue_id) where deleted_at is null do nothing;
      select l.id into v_lot from app.asset_lots l
      where l.asset_class_id = v_class and l.venue_id = v_venue and l.deleted_at is null;
      insert into app.asset_lot_movements (asset_lot_id, movement_kind, delta, receipt_line_id, project_id)
      values (v_lot, 'Receipt', v_quantity, v_receipt_line, v_order.project_id);
    end if;
  end loop;

  return private.receipt_event_result('applied', p_event_id);
end;
$$;
comment on function app.receive_goods(uuid, uuid, jsonb, text) is 'Records one receipt event against an approved or sent purchase order in one transaction (R7a): the goods receipt (its id is the event id), one receipt line per entry of p_lines [{po_line_id, quantity, asset_tags?, venue_id?, condition_enum_id?}], and, for an element with an asset class, Received units by asset tag or a Receipt movement into the lot at the venue (assets.asset.write). Needs procurement.receipt.write on the project. Replaying the event id returns outcome duplicate with the stored ids and changes nothing.';
revoke all on function app.receive_goods(uuid, uuid, jsonb, text) from public, anon;
grant execute on function app.receive_goods(uuid, uuid, jsonb, text) to authenticated, service_role;

insert into private.sync_rpcs (rpc, description) values
  ('app.receive_goods', 'Field receiving against a purchase order; replays are idempotent on the receipt event id.');

-- 7. Returning to the vendor ------------------------------------------------------------------------------------------------

create or replace function private.return_event_result(p_outcome text, p_goods_return_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'outcome', p_outcome,
    'goods_return_id', p_goods_return_id,
    'return_line_ids', coalesce((select jsonb_agg(l.id order by l.created_at, l.id) from app.return_lines l
                                 where l.goods_return_id = p_goods_return_id), '[]'::jsonb));
$$;
comment on function private.return_event_result(text, uuid) is 'The result of a return event read back from its stored rows: the return and its lines.';
revoke all on function private.return_event_result(text, uuid) from public, anon, authenticated;

create or replace function app.return_goods(p_event_id uuid, p_purchase_order_id uuid, p_reason app.goods_return_reason,
  p_lines jsonb, p_note text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order app.purchase_orders;
  v_existing app.goods_returns;
  v_line jsonb;
  v_receipt app.receipt_lines;
  v_kind app.acquisition_kind;
  v_element text;
  v_quantity numeric;
  v_returned numeric;
  v_venue uuid;
  v_units uuid[];
  v_unit app.asset_units;
  v_unit_id uuid;
  v_custodian_member uuid;
  v_custodian_engagement uuid;
  v_return_line uuid;
  v_lot uuid;
begin
  perform private.require_person();
  if p_event_id is null then
    perform private.refuse('return_event_required', 'Every return carries the event id it was recorded under.');
  end if;
  select * into v_order from app.purchase_orders po where po.id = p_purchase_order_id and po.deleted_at is null for update;
  select * into v_existing from app.goods_returns g where g.id = p_event_id;
  if v_existing.id is not null then
    if v_existing.purchase_order_id is distinct from v_order.id then
      perform private.refuse('return_event_reused', 'This return event already recorded a return on another purchase order.');
    end if;
    return private.return_event_result('duplicate', p_event_id);
  end if;
  if v_order.id is null or not private.can_on_project(v_order.project_id, 'procurement.receipt.write') then
    raise exception using errcode = '42501', message = 'procurement.receipt.write is required';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    perform private.refuse('return_lines_required', 'A return sends back at least one line.');
  end if;

  insert into app.goods_returns (id, purchase_order_id, return_reason, note)
  values (p_event_id, v_order.id, p_reason, nullif(btrim(coalesce(p_note, '')), ''));

  for v_line in select l from jsonb_array_elements(p_lines) l loop
    v_quantity := (v_line ->> 'quantity')::numeric;
    v_venue := (v_line ->> 'venue_id')::uuid;
    v_lot := null;
    -- Returns of one receipt line serialize on its row.
    select rl.* into v_receipt from app.receipt_lines rl
    join app.goods_receipts g on g.id = rl.goods_receipt_id
    where rl.id = (v_line ->> 'receipt_line_id')::uuid and rl.deleted_at is null and g.deleted_at is null
      and g.purchase_order_id = v_order.id
    for update of rl;
    if v_receipt.id is null then
      perform private.refuse('return_line_order', 'A return line sends back goods received on this purchase order.');
    end if;
    select l.acquisition_kind, l.element_id into v_kind, v_element from app.po_lines l where l.id = v_receipt.po_line_id;
    if p_reason = 'Off Hire' and v_kind <> 'Rental' then
      perform private.refuse('return_off_hire_not_rental', 'Off Hire returns only goods hired on a rental line.');
    end if;
    select coalesce(sum(r.quantity_returned), 0) into v_returned from app.return_lines r
    join app.goods_returns g on g.id = r.goods_return_id
    where r.receipt_line_id = v_receipt.id and r.deleted_at is null and g.deleted_at is null;
    if v_returned + v_quantity > v_receipt.quantity_received then
      perform private.refuse('return_exceeds_receipt', 'Returns never exceed what the receipt line brought in.');
    end if;

    if jsonb_typeof(v_line -> 'asset_unit_ids') = 'array' then
      if v_venue is not null then
        perform private.refuse('return_line_target_ambiguous', 'A return line sends back units or a quantity out of a lot, not both.');
      end if;
      select array_agg(x::uuid) into v_units from jsonb_array_elements_text(v_line -> 'asset_unit_ids') x;
      if coalesce(cardinality(v_units), 0) <> v_quantity then
        perform private.refuse('return_units_count', 'Name one unit for each unit returned.');
      end if;
      if not private.has_capability(v_order.org_id, 'assets.asset.write') then
        raise exception using errcode = '42501', message = 'assets.asset.write is required';
      end if;
      foreach v_unit_id in array v_units loop
        select * into v_unit from app.asset_units u where u.id = v_unit_id for update;
        if v_unit.id is null or v_unit.deleted_at is not null or v_unit.receipt_line_id is distinct from v_receipt.id then
          perform private.refuse('return_unit_not_from_receipt', 'A returned unit arrived on the receipt line it goes back against.');
        end if;
        if v_unit.asset_state not in ('Available', 'Damaged', 'In Maintenance') then
          perform private.refuse('return_unit_state', format('The unit is %s; only an Available, Damaged or In Maintenance unit goes back.', v_unit.asset_state));
        end if;
        v_custodian_member := null;
        v_custodian_engagement := null;
        select c.custodian_membership_id, c.custodian_engagement_id into v_custodian_member, v_custodian_engagement
        from app.asset_custody c where c.asset_unit_id = v_unit.id order by c.created_at desc, c.id desc limit 1;
        if v_custodian_member is not null or v_custodian_engagement is not null then
          perform private.refuse('return_unit_in_custody', 'Check the unit in before it goes back to the vendor.');
        end if;
        insert into app.return_lines (goods_return_id, receipt_line_id, asset_unit_id, quantity_returned)
        values (p_event_id, v_receipt.id, v_unit.id, 1);
        perform private.begin_trusted_operation('goods_return');
        perform private.transition_lifecycle('asset', 'app.asset_units', 'asset_state', 'app.asset_state_transitions',
          'asset_unit_id', v_unit.id, v_unit.asset_state::text, 'Returned',
          format('%s on PO %s.', case p_reason when 'Off Hire' then 'Off hire' else 'Returned to vendor' end, v_order.po_number));
        perform private.end_trusted_operation('goods_return');
      end loop;
    elsif v_venue is not null then
      if not private.has_capability(v_order.org_id, 'assets.asset.write') then
        raise exception using errcode = '42501', message = 'assets.asset.write is required';
      end if;
      select l.id into v_lot from app.asset_lots l
      join app.asset_classes c on c.id = l.asset_class_id
      where c.org_id = v_order.org_id and c.element_id = v_element and c.deleted_at is null
        and l.venue_id = v_venue and l.deleted_at is null;
      if v_lot is null then
        perform private.refuse('asset_lot_insufficient', 'Nothing of this item is on hand at that venue.');
      end if;
      insert into app.return_lines (goods_return_id, receipt_line_id, quantity_returned)
      values (p_event_id, v_receipt.id, v_quantity)
      returning id into v_return_line;
      -- The lot guard refuses taking the lot below zero (asset_lot_insufficient).
      insert into app.asset_lot_movements (asset_lot_id, movement_kind, delta, return_line_id, project_id)
      values (v_lot, 'Vendor Return', -v_quantity, v_return_line, v_order.project_id);
    else
      if exists (select 1 from app.asset_units u where u.receipt_line_id = v_receipt.id and u.deleted_at is null) then
        perform private.refuse('return_units_count', 'Name one unit for each unit returned.');
      end if;
      insert into app.return_lines (goods_return_id, receipt_line_id, quantity_returned)
      values (p_event_id, v_receipt.id, v_quantity);
    end if;
  end loop;

  return private.return_event_result('applied', p_event_id);
end;
$$;
comment on function app.return_goods(uuid, uuid, app.goods_return_reason, jsonb, text) is 'Records one return event against a purchase order in one transaction (R7a): the goods return (its id is the event id) and, per entry of p_lines [{receipt_line_id, quantity, asset_unit_ids?, venue_id?}], return lines that never exceed the receipt line. Serialized units must have arrived on that line, be Available, Damaged or In Maintenance and in no one''s custody, and become Returned; a quantity out of a lot writes a Vendor Return movement (both need assets.asset.write). Off Hire applies only to rental lines. Needs procurement.receipt.write on the project. Replaying the event id returns outcome duplicate with the stored ids.';
revoke all on function app.return_goods(uuid, uuid, app.goods_return_reason, jsonb, text) from public, anon;
grant execute on function app.return_goods(uuid, uuid, app.goods_return_reason, jsonb, text) to authenticated, service_role;

select private.sync_trash_tables();
