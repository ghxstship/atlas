-- pgTAP: 1452, field history (A88, RRR-133, Section 4.10). Who changed which field and when, read from the audit
-- ledger for one row, only by someone who can read that row (its own read policies decide), never exposing the
-- actor's IP address or user agent, and masking a Restricted field without its read capability.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(13);

select pg_temp.as_user('dave');
with x as (
  insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Task', 'Hang the banner', 'Y', 'Declared') returning id
) insert into world select 't1', id from x;
update app.records set owner_party_id = pg_temp.id('erin') where id = pg_temp.id('t1');
update app.records set title = 'Hang both banners' where id = pg_temp.id('t1');

create temporary table history as select * from app.field_history('app.records', pg_temp.id('t1'));
grant select on history to public;

select is((select count(*)::int from history where operation = 'insert'), 1, 'the history starts with the creation');
select is((select count(*)::int from history where field = 'owner_party_id'), 1, 'an owner change is one field row');
select is((select new_value #>> '{}' from history where field = 'owner_party_id'), pg_temp.id('erin')::text, 'with the new value');
select is((select old_value from history where field = 'owner_party_id'), 'null'::jsonb, 'and the old one');
select is((select actor_name from history where field = 'title'), 'Dave Lindqvist', 'the person who changed it is named');
select ok((select bool_and(field not in ('updated_at', 'updated_by', 'created_at', 'created_by', 'org_id', 'id')) from history where field is not null),
  'audit columns and keys are left out');
select is((select count(*)::int from app.audit_events where subject_id = pg_temp.id('t1')), 0,
  'the ledger itself stays closed to a Member without audit.log.read');

-- Only someone who can read the row ---------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok($$select * from app.field_history('app.records', (select id from world where key = 't1'))$$, '42501', null,
  'a Viewer outside the project reads no history of its records (invariant 2)');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.field_history('app.records', (select id from world where key = 't1'))$$, '42501', null,
  'another org reads none');
select pg_temp.as_user('dave');
select throws_ok($$select * from app.field_history('app.medical_encounters', gen_random_uuid())$$, 'XR001', null,
  'a table outside the registry has no field history');
select ok(pg_get_function_result('app.field_history(text,uuid,integer)'::regprocedure) !~ 'actor_ip|user_agent',
  'IP addresses and user agents never leave the ledger');

-- Restricted fields stay masked --------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into private.column_classifications (table_name, column_name, classification, read_capability)
values ('app.records', 'title', 'Restricted', 'data.restricted.read.payroll');
select pg_temp.as_user('dave');
select is((select masked from app.field_history('app.records', pg_temp.id('t1')) where field = 'title'), true,
  'a field classified Restricted after the change is masked without its read capability');
select is((select new_value from app.field_history('app.records', pg_temp.id('t1')) where field = 'title'), null,
  'and shows neither value');
select pg_temp.as_platform();

select * from finish();
rollback;
