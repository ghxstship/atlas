-- pgTAP: migration 1021, the carrier connections a shipment writer chooses from when tracking a shipment.
-- Same-tenant allow for integration managers and shipment writers, deny for a viewer without the capability,
-- cross-tenant deny, anon deny; only Connected Shipping connections, never credentials.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

select pg_temp.as_user('bob');
with c as (insert into app.integration_connections (org_id, provider_code, display_name) values (pg_temp.id('org_a'), 'ups', 'Northwind UPS') returning id) insert into world select 'ups', id from c;
with c as (insert into app.integration_connections (org_id, provider_code, display_name) values (pg_temp.id('org_a'), 'fedex', 'Northwind FedEx') returning id) insert into world select 'fedex', id from c;
with c as (insert into app.integration_connections (org_id, provider_code, display_name) values (pg_temp.id('org_a'), 'slack', 'Slack') returning id) insert into world select 'slack', id from c;
select app.store_integration_credential(pg_temp.id('ups'), 'fixture-key', 'API Key');
select app.transition_integration_connection(pg_temp.id('ups'), 'Pending', 'Connected', 'Authorized.');
select app.store_integration_credential(pg_temp.id('slack'), 'fixture-key', 'OAuth Token');
select app.transition_integration_connection(pg_temp.id('slack'), 'Pending', 'Connected', 'Authorized.');
select pg_temp.as_platform();

create function pg_temp.carriers(p_who text) returns text[]
language plpgsql as $$
declare v text[];
begin
  perform pg_temp.as_user(p_who);
  select coalesce(array_agg(display_name order by display_name), '{}') into v from app.carrier_connections(pg_temp.id('org_a'));
  perform pg_temp.as_platform();
  return v;
end $$;

select is(pg_temp.carriers('bob'), array['Northwind UPS'], 'an integration manager sees only the Connected carrier');
select is(pg_temp.carriers('alice'), array['Northwind UPS'], 'a shipment writer sees it too');
select is(pg_temp.carriers('gina'), '{}'::text[], 'a viewer who writes no shipments sees none');
select is(pg_temp.carriers('xavier'), '{}'::text[], 'another tenant sees none');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.integration_connections), 0, 'the connections table itself stays closed to the viewer');
select pg_temp.as_platform();
select is((select pg_get_function_result('app.carrier_connections(uuid)'::regprocedure)),
  'TABLE(id uuid, provider_code text, display_name text)', 'only id, provider and display name; never credentials or settings');
select pg_temp.as_anon();
select throws_ok(format($$select * from app.carrier_connections('%s')$$, pg_temp.id('org_a')), '42501', null, 'anon deny');
select pg_temp.as_platform();

select * from finish();
rollback;
