-- Security finding A22-002: offline replay must not bypass RLS. Every allowlisted sync RPC is
-- SECURITY DEFINER and authorizes the caller itself; the four logistics RPCs refuse another
-- tenant's project through apply_sync_mutation and still work for a coordinator.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(9);

select is(
  (select coalesce(string_agg(r.rpc, ', ' order by r.rpc), '')
   from private.sync_rpcs r
   join pg_catalog.pg_namespace n on n.nspname = split_part(r.rpc, '.', 1)
   join pg_catalog.pg_proc p on p.pronamespace = n.oid and p.proname = split_part(r.rpc, '.', 2)
   where not p.prosecdef),
  '',
  'every allowlisted sync RPC is SECURITY DEFINER');

create function pg_temp.replay(p_org text, p_rpc text, p_args jsonb) returns text
language plpgsql as $$
begin
  return app.apply_sync_mutation(gen_random_uuid(), pg_temp.id(p_org), 'test-device', p_rpc, p_args)::text;
exception when others then
  return sqlstate;
end $$;

select pg_temp.as_user('xavier');
select is(pg_temp.replay('org_b', 'app.add_marshalling_entry',
    jsonb_build_object('p_project_id', pg_temp.id('prj_a'), 'p_entry', 'Written by another tenant')), '42501',
  'another tenant cannot append to the yard log through the sync path');
select is(pg_temp.replay('org_b', 'app.record_gate_arrival',
    jsonb_build_object('p_project_id', pg_temp.id('prj_a'), 'p_vehicle_identifier', 'XTENANT-1')), '42501',
  'another tenant cannot record a gate arrival through the sync path');

select pg_temp.as_user('dave');
select ok(left(pg_temp.replay('org_a', 'app.add_marshalling_entry',
    jsonb_build_object('p_project_id', pg_temp.id('prj_a'), 'p_entry', 'Lane 3 staged.')), 8) = '{"data":',
  'a coordinator appends to the yard log through the sync path');
select ok(left(pg_temp.replay('org_a', 'app.record_gate_arrival',
    jsonb_build_object('p_project_id', pg_temp.id('prj_a'), 'p_vehicle_identifier', 'SYNC-TRK-1')), 8) = '{"data":',
  'a coordinator records a gate arrival through the sync path');

select pg_temp.as_platform();
insert into world select 'sync_gq', id from app.gate_queue where project_id = pg_temp.id('prj_a') and vehicle_identifier = 'SYNC-TRK-1';

select pg_temp.as_user('xavier');
select is(pg_temp.replay('org_b', 'app.release_vehicle', jsonb_build_object('p_gate_queue_id', pg_temp.id('sync_gq'))),
  '{"refusal": {"rule": "vehicle_not_waiting", "message": "vehicle_not_waiting: This vehicle is already released or not yours to release."}}',
  'another tenant cannot release a vehicle through the sync path');

select pg_temp.as_user('dave');
select ok(left(pg_temp.replay('org_a', 'app.release_vehicle', jsonb_build_object('p_gate_queue_id', pg_temp.id('sync_gq'))), 8) = '{"data":',
  'a coordinator releases the vehicle through the sync path');

select pg_temp.as_platform();
select is((select count(*)::integer from app.marshalling_log where project_id = pg_temp.id('prj_a') and entry = 'Written by another tenant'), 0,
  'no marshalling entry from another tenant lands in the project');
select is((select count(*)::integer from app.gate_queue where project_id = pg_temp.id('prj_a') and vehicle_identifier = 'XTENANT-1'), 0,
  'no gate arrival from another tenant lands in the project');

select * from finish();
rollback;
