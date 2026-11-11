-- 2150_bulk_edit_logistics_hospitality.sql
-- A121 (RRR-167, A65-006, ADR 0080). Bulk edit (Section 11.7) reaches the Logistics and Hospitality tables: five more
-- resources on the driver of 1451, private.run_bulk, so each call keeps its rules. All or nothing, a preview that
-- always undoes, the capability checked on every row, refusals naming the row, the inverse rows that undo a call,
-- and one <resource>.bulk_update audit event per org.
--
--   * Shipments: direction, carrier and freight type. Every row needs logistics.shipment.write on its project, as the
--     update policy does; the freight type still comes from the canon Freight Type enumeration (guard_shipment) and
--     the carrier from the same org.
--   * Dock slots (the dock and yard bookings): the dock zone. Needs logistics.dock_slot.write; the overlap rule and
--     the freeze of a checked-in slot still refuse a move (guard_dock_slot, guard_dock_check_in).
--   * Fulfillments: state through app.transition_fulfillment (a reason, the lifecycle rules) and the supplier.
--   * BEOs: approval, the "approve 20 in 60 s" path of Section 11.11. approved_at takes true to approve now; each
--     row needs hospitality.beo.write as the update policy does, and guard_beo still asks for hospitality.beo.approve
--     and refuses the BEO's author (sod_approval_requester). An approval is stamped once, so undoing one is refused.
--   * Room blocks (app.accommodation_blocks): the hotel. Needs hospitality.accommodation.write.
--   * Row functions run with owner rights, so each checks the caller's capability on the row the way the table's
--     policies do, and every guard trigger still applies. The driver, its helpers and the earlier row functions are
--     not redefined here.
--   * The five tables gain the audit trail app.records has (1451), so each row change and its undo reaches the ledger
--     field by field; until now only their creation and a few stamps emitted domain events.

-- Shipments ----------------------------------------------------------------------------------------------------------

create or replace function private.bulk_shipments_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.shipments;
  v_new app.shipments;
  v_direction app.shipment_direction;
  v_carrier uuid;
  v_freight text;
  v_keys jsonb := p_set;
begin
  perform private.bulk_check_fields(p_set, p_expect, 'direction,carrier_counterparty_id,freight_type_enum_id');
  select * into v_old from app.shipments s where s.id = p_id and s.deleted_at is null for update;
  if v_old.id is null or v_old.project_id not in (select private.project_ids_with('logistics.shipment.read')) then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  if v_old.project_id not in (select private.project_ids_with('logistics.shipment.write')) then
    raise exception using errcode = '42501', message = 'logistics.shipment.write is required on this shipment''s project.';
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);

  v_direction := case when p_set ? 'direction' then (p_set ->> 'direction')::app.shipment_direction else v_old.direction end;
  v_carrier := case when p_set ? 'carrier_counterparty_id' then (p_set ->> 'carrier_counterparty_id')::uuid else v_old.carrier_counterparty_id end;
  v_freight := case when p_set ? 'freight_type_enum_id' then p_set ->> 'freight_type_enum_id' else v_old.freight_type_enum_id end;
  if v_direction = v_old.direction and v_carrier is not distinct from v_old.carrier_counterparty_id
     and v_freight is not distinct from v_old.freight_type_enum_id then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;

  update app.shipments
  set direction = v_direction, carrier_counterparty_id = v_carrier, freight_type_enum_id = v_freight
  where id = p_id;

  select * into v_new from app.shipments s where s.id = p_id;
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true,
    'before', private.bulk_pick(to_jsonb(v_old), v_keys), 'after', private.bulk_pick(to_jsonb(v_new), v_keys));
end;
$$;

comment on function private.bulk_shipments_row(uuid, jsonb, jsonb, text) is 'One shipment of a bulk change: direction, carrier and freight type. Needs logistics.shipment.write on the project as its update policy does; the freight type comes from the canon Freight Type enumeration and the carrier from the same org.';
revoke all on function private.bulk_shipments_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

-- Dock slots ---------------------------------------------------------------------------------------------------------

create or replace function private.bulk_dock_slots_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.dock_slots;
  v_new app.dock_slots;
  v_zone uuid;
begin
  perform private.bulk_check_fields(p_set, p_expect, 'zone_id');
  select * into v_old from app.dock_slots d where d.id = p_id and d.deleted_at is null for update;
  if v_old.id is null or v_old.project_id not in (select private.project_ids_with('logistics.shipment.read')) then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  if v_old.project_id not in (select private.project_ids_with('logistics.dock_slot.write')) then
    raise exception using errcode = '42501', message = 'logistics.dock_slot.write is required on this dock slot''s project.';
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);
  v_zone := case when p_set ? 'zone_id' then (p_set ->> 'zone_id')::uuid else v_old.zone_id end;
  if v_zone is not distinct from v_old.zone_id then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;
  update app.dock_slots set zone_id = v_zone where id = p_id;
  select * into v_new from app.dock_slots d where d.id = p_id;
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true,
    'before', jsonb_build_object('zone_id', v_old.zone_id),
    'after', jsonb_build_object('zone_id', v_new.zone_id));
end;
$$;

comment on function private.bulk_dock_slots_row(uuid, jsonb, jsonb, text) is 'One dock slot of a bulk change: the dock zone it books. Needs logistics.dock_slot.write on the project as its update policy does; slots at one dock still never overlap and a checked-in slot keeps its dock.';
revoke all on function private.bulk_dock_slots_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

-- Fulfillments -------------------------------------------------------------------------------------------------------

create or replace function private.bulk_fulfillments_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.fulfillments;
  v_new app.fulfillments;
  v_state app.fulfillment_state;
  v_supplier uuid;
  v_keys jsonb := p_set;
begin
  perform private.bulk_check_fields(p_set, p_expect, 'fulfillment_state,counterparty_id');
  select * into v_old from app.fulfillments f where f.id = p_id and f.deleted_at is null for update;
  if v_old.id is null or v_old.project_id not in (select private.project_ids_with('hospitality.fulfillment.read')) then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  if v_old.project_id not in (select private.project_ids_with('hospitality.fulfillment.write')) then
    raise exception using errcode = '42501', message = 'hospitality.fulfillment.write is required on this fulfillment''s project.';
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);

  v_state := case when p_set ? 'fulfillment_state' then (p_set ->> 'fulfillment_state')::app.fulfillment_state else v_old.fulfillment_state end;
  v_supplier := case when p_set ? 'counterparty_id' then (p_set ->> 'counterparty_id')::uuid else v_old.counterparty_id end;
  if v_state = v_old.fulfillment_state and v_supplier is not distinct from v_old.counterparty_id then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;

  if v_supplier is distinct from v_old.counterparty_id then
    update app.fulfillments set counterparty_id = v_supplier where id = p_id;
  end if;
  if v_state <> v_old.fulfillment_state then
    perform app.transition_fulfillment(p_id, v_old.fulfillment_state, v_state, coalesce(nullif(btrim(p_reason), ''), 'Changed in bulk.'));
  end if;

  select * into v_new from app.fulfillments f where f.id = p_id;
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true,
    'before', private.bulk_pick(to_jsonb(v_old), v_keys), 'after', private.bulk_pick(to_jsonb(v_new), v_keys));
end;
$$;

comment on function private.bulk_fulfillments_row(uuid, jsonb, jsonb, text) is 'One fulfillment of a bulk change: its state through app.transition_fulfillment, with the reason and the lifecycle rules, and its supplier. Needs hospitality.fulfillment.write on the project.';
revoke all on function private.bulk_fulfillments_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

-- BEOs -----------------------------------------------------------------------------------------------------------------

create or replace function private.bulk_beos_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.beos;
  v_new app.beos;
  v_approve boolean;
begin
  perform private.bulk_check_fields(p_set, p_expect, 'approved_at');
  select * into v_old from app.beos b where b.id = p_id and b.deleted_at is null for update;
  if v_old.id is null or v_old.project_id not in (select private.project_ids_with('hospitality.fulfillment.read')) then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  if v_old.project_id not in (select private.project_ids_with('hospitality.beo.write')) then
    raise exception using errcode = '42501', message = 'hospitality.beo.write is required on this BEO''s project.';
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);

  -- true or a time approves, null asks for no approval: an approval is stamped once and never withdrawn (guard_beo).
  v_approve := case
    when not p_set ? 'approved_at' then v_old.approved_at is not null
    when jsonb_typeof(p_set -> 'approved_at') = 'boolean' then (p_set ->> 'approved_at')::boolean
    when jsonb_typeof(p_set -> 'approved_at') = 'null' then false
    else (p_set ->> 'approved_at')::timestamptz is not null
  end;
  if v_approve = (v_old.approved_at is not null) then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;
  if not v_approve then
    perform private.refuse('beo_approved', 'An approved BEO stays approved.');
  end if;

  -- guard_beo checks hospitality.beo.approve and separation from the author, and stamps the time and approver.
  update app.beos set approved_at = now() where id = p_id;
  select * into v_new from app.beos b where b.id = p_id;
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true,
    'before', jsonb_build_object('approved_at', v_old.approved_at),
    'after', jsonb_build_object('approved_at', v_new.approved_at));
end;
$$;

comment on function private.bulk_beos_row(uuid, jsonb, jsonb, text) is 'One BEO of a bulk change: approval. Needs hospitality.beo.write on the project as its update policy does; the BEO guard still asks for hospitality.beo.approve, refuses the author and stamps the approval once, so undoing one is refused (beo_approved).';
revoke all on function private.bulk_beos_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

-- Room blocks ----------------------------------------------------------------------------------------------------------

create or replace function private.bulk_accommodation_blocks_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.accommodation_blocks;
  v_new app.accommodation_blocks;
  v_hotel uuid;
begin
  perform private.bulk_check_fields(p_set, p_expect, 'counterparty_id');
  select * into v_old from app.accommodation_blocks b where b.id = p_id and b.deleted_at is null for update;
  if v_old.id is null or v_old.project_id not in (select private.project_ids_with('hospitality.fulfillment.read')) then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  if v_old.project_id not in (select private.project_ids_with('hospitality.accommodation.write')) then
    raise exception using errcode = '42501', message = 'hospitality.accommodation.write is required on this block''s project.';
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);
  v_hotel := case when p_set ? 'counterparty_id' then (p_set ->> 'counterparty_id')::uuid else v_old.counterparty_id end;
  if v_hotel is not distinct from v_old.counterparty_id then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;
  update app.accommodation_blocks set counterparty_id = v_hotel where id = p_id;
  select * into v_new from app.accommodation_blocks b where b.id = p_id;
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true,
    'before', jsonb_build_object('counterparty_id', v_old.counterparty_id),
    'after', jsonb_build_object('counterparty_id', v_new.counterparty_id));
end;
$$;

comment on function private.bulk_accommodation_blocks_row(uuid, jsonb, jsonb, text) is 'One room block of a bulk change: the hotel or lodging supplier holding it, of the same org. Needs hospitality.accommodation.write on the project as its update policy does.';
revoke all on function private.bulk_accommodation_blocks_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

insert into private.bulk_resources (resource, table_name, row_function) values
  ('shipments', 'app.shipments', 'private.bulk_shipments_row'),
  ('dock_slots', 'app.dock_slots', 'private.bulk_dock_slots_row'),
  ('fulfillments', 'app.fulfillments', 'private.bulk_fulfillments_row'),
  ('beos', 'app.beos', 'private.bulk_beos_row'),
  ('accommodation_blocks', 'app.accommodation_blocks', 'private.bulk_accommodation_blocks_row');

-- App RPCs -------------------------------------------------------------------------------------------------------------

create or replace function app.bulk_update_shipments(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('shipments', p_rows, coalesce(p_preview, false), p_reason);
$$;

comment on function app.bulk_update_shipments(jsonb, boolean, text) is 'Changes the direction, carrier or freight type of shipments in bulk in one transaction (Section 11.7), with the answer of app.bulk_update_records.';

create or replace function app.bulk_update_dock_slots(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('dock_slots', p_rows, coalesce(p_preview, false), p_reason);
$$;

comment on function app.bulk_update_dock_slots(jsonb, boolean, text) is 'Moves dock slots to another dock in bulk in one transaction (Section 11.7), every overlap and check-in rule applying to each row, with the answer of app.bulk_update_records.';

create or replace function app.bulk_update_fulfillments(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('fulfillments', p_rows, coalesce(p_preview, false), p_reason);
$$;

comment on function app.bulk_update_fulfillments(jsonb, boolean, text) is 'Moves fulfillments along their lifecycle or changes their supplier in bulk in one transaction (Section 11.7), with the answer of app.bulk_update_records.';

create or replace function app.bulk_update_beos(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('beos', p_rows, coalesce(p_preview, false), p_reason);
$$;

comment on function app.bulk_update_beos(jsonb, boolean, text) is 'Approves BEOs in bulk in one transaction (Section 11.7, approve 20 in 60 s), every rule of a single approval applying to each row, with the answer of app.bulk_update_records.';

create or replace function app.bulk_update_accommodation_blocks(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('accommodation_blocks', p_rows, coalesce(p_preview, false), p_reason);
$$;

comment on function app.bulk_update_accommodation_blocks(jsonb, boolean, text) is 'Changes the hotel of room blocks in bulk in one transaction (Section 11.7), with the answer of app.bulk_update_records.';

revoke all on function app.bulk_update_shipments(jsonb, boolean, text) from public, anon;
revoke all on function app.bulk_update_dock_slots(jsonb, boolean, text) from public, anon;
revoke all on function app.bulk_update_fulfillments(jsonb, boolean, text) from public, anon;
revoke all on function app.bulk_update_beos(jsonb, boolean, text) from public, anon;
revoke all on function app.bulk_update_accommodation_blocks(jsonb, boolean, text) from public, anon;
grant execute on function app.bulk_update_shipments(jsonb, boolean, text) to authenticated, service_role;
grant execute on function app.bulk_update_dock_slots(jsonb, boolean, text) to authenticated, service_role;
grant execute on function app.bulk_update_fulfillments(jsonb, boolean, text) to authenticated, service_role;
grant execute on function app.bulk_update_beos(jsonb, boolean, text) to authenticated, service_role;
grant execute on function app.bulk_update_accommodation_blocks(jsonb, boolean, text) to authenticated, service_role;

-- Row changes reach the audit ledger, so bulk edits, their undo and every single edit leave a field-level trail.
call private.install_audit_trail('app.shipments');
call private.install_audit_trail('app.dock_slots');
call private.install_audit_trail('app.fulfillments');
call private.install_audit_trail('app.beos');
call private.install_audit_trail('app.accommodation_blocks');
