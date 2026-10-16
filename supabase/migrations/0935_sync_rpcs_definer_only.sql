-- Security finding A22-002: offline replay bypassed RLS for four logistics RPCs.
--
-- app.apply_sync_mutation runs the allowlisted RPC through private.sync_call, which is SECURITY
-- DEFINER, so a SECURITY INVOKER RPC ran as the function owner and RLS never applied. Four
-- logistics RPCs (0442) relied on RLS alone. A person could then write into another tenant's
-- marshalling log and gate queue by naming that tenant's project.
--
-- Fix: the four RPCs become SECURITY DEFINER and check the same capability their tables' write
-- policies check. sync_call now refuses any RPC that is not SECURITY DEFINER, because only such
-- RPCs carry their own authorization. pgTAP 0935 asserts every allowlisted RPC is SECURITY DEFINER.

create or replace function app.check_in_dock_slot(p_dock_slot_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  update app.dock_slots s set checked_in_at = now()
  where s.id = p_dock_slot_id and s.checked_in_at is null and s.deleted_at is null
    and s.project_id in (select private.project_ids_with('logistics.dock_slot.write'))
  returning s.checked_in_at into v_at;
  if v_at is null then
    raise exception using errcode = 'XR001', hint = 'dock_slot_not_open',
      message = 'dock_slot_not_open: This dock slot is already checked in, canceled or not yours to change.';
  end if;
  return v_at;
end;
$$;

create or replace function app.record_gate_arrival(p_project_id uuid, p_vehicle_identifier text, p_shipment_id uuid default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_project_id is null or p_project_id not in (select private.project_ids_with('logistics.yard.write')) then
    raise exception using errcode = '42501', message = 'logistics.yard.write is required on this project';
  end if;
  insert into app.gate_queue (project_id, vehicle_identifier, shipment_id)
  values (p_project_id, btrim(p_vehicle_identifier), p_shipment_id)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function app.release_vehicle(p_gate_queue_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  update app.gate_queue q set released_at = now()
  where q.id = p_gate_queue_id and q.released_at is null and q.deleted_at is null
    and q.project_id in (select private.project_ids_with('logistics.yard.write'))
  returning q.released_at into v_at;
  if v_at is null then
    raise exception using errcode = 'XR001', hint = 'vehicle_not_waiting',
      message = 'vehicle_not_waiting: This vehicle is already released or not yours to release.';
  end if;
  return v_at;
end;
$$;

create or replace function app.add_marshalling_entry(p_project_id uuid, p_entry text, p_shipment_id uuid default null, p_zone_id uuid default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_project_id is null or p_project_id not in (select private.project_ids_with('logistics.yard.write')) then
    raise exception using errcode = '42501', message = 'logistics.yard.write is required on this project';
  end if;
  insert into app.marshalling_log (project_id, entry, shipment_id, zone_id)
  values (p_project_id, btrim(p_entry), p_shipment_id, p_zone_id)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function private.sync_call(p_rpc text, p_args jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_proc oid;
  v_call text;
  v_result jsonb;
  v_retset boolean;
  v_definer boolean;
begin
  select p.oid, p.proretset, p.prosecdef into v_proc, v_retset, v_definer
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = split_part(p_rpc, '.', 1) and p.proname = split_part(p_rpc, '.', 2);
  if v_proc is null or (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
                        where n.nspname = split_part(p_rpc, '.', 1) and p.proname = split_part(p_rpc, '.', 2)) <> 1 then
    perform private.refuse('sync_rpc_unknown', format('%s is not a single-signature RPC.', p_rpc));
  end if;
  -- This function runs as its owner, so RLS would not apply to an invoker RPC. Only RPCs that
  -- authorize the caller themselves may be replayed.
  if not v_definer then
    raise exception using errcode = '42501', message = format('%s must be SECURITY DEFINER to be replayed from a device', p_rpc);
  end if;
  if exists (select 1 from jsonb_object_keys(coalesce(p_args, '{}'::jsonb)) k
             where k not in (select a.name from unnest((select p.proargnames from pg_catalog.pg_proc p where p.oid = v_proc)) a(name))) then
    perform private.refuse('sync_argument_unknown', format('The arguments name a parameter %s does not take.', p_rpc));
  end if;
  select string_agg(format('%I => ($1 ->> %L)::%s', a.name, a.name, pg_catalog.format_type(a.type, null)), ', ' order by a.ord)
  into v_call
  from unnest((select p.proargnames from pg_catalog.pg_proc p where p.oid = v_proc),
              (select p.proargtypes::oid[] from pg_catalog.pg_proc p where p.oid = v_proc)) with ordinality a(name, type, ord)
  where coalesce(p_args, '{}'::jsonb) ? a.name;
  if v_retset then
    execute format('select coalesce(jsonb_agg(to_jsonb(r)), ''[]''::jsonb) from %s(%s) r', p_rpc, coalesce(v_call, '')) into v_result using p_args;
  else
    execute format('select to_jsonb(%s(%s))', p_rpc, coalesce(v_call, '')) into v_result using p_args;
  end if;
  return v_result;
end;
$$;

comment on function private.sync_call(text, jsonb) is 'Calls an allowlisted SECURITY DEFINER app RPC with named arguments taken from a JSON object (text values cast to each parameter type; omitted parameters take their defaults) and returns its result as JSON. The RPC authorizes the session itself; invoker RPCs are refused because RLS would not apply here (A22-002).';
revoke all on function private.sync_call(text, jsonb) from public, anon, authenticated;
