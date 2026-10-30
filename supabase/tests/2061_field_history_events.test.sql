-- pgTAP: 2061, field history one row per event (A106, RRR-151, ADR 0044). app.field_history_events groups
-- app.field_history's rows into events, so its limit counts the same thing as the API's row cap and an event never
-- arrives with only some of its changes; the access rules and masking are app.field_history's own.
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
update app.records set title = 'Hang both banners', due_at = now() + interval '1 day' where id = pg_temp.id('t1');
update app.records set title = 'Hang three banners', due_at = now() + interval '2 days' where id = pg_temp.id('t1');
update app.records set title = 'Hang four banners', due_at = now() + interval '3 days' where id = pg_temp.id('t1');

create temporary table fields as select * from app.field_history('app.records', pg_temp.id('t1'));
create temporary table events as select * from app.field_history_events('app.records', pg_temp.id('t1'));
grant select on fields, events to public;

-- One row per event, every change kept -----------------------------------------------------------------------------
select is((select count(*)::int from events), 4, 'the creation and three updates are four rows');
select is((select count(*)::int from events), (select count(distinct event_id)::int from fields),
  'one row for each event app.field_history names');
select is((select sum(jsonb_array_length(changes))::int from events),
  (select count(*)::int from fields where field is not null), 'and every changed field is in one of them');
select ok((select bool_and(changes @> '[{"field": "title"}]' and changes @> '[{"field": "due_at"}]')
           from events where operation = 'update'), 'an update carries each field it changed');
select is((select changes from events where operation = 'insert'), '[]'::jsonb, 'a creation carries no changes');
select ok((select bool_and(
             (select array_agg(c ->> 'field' order by o) from jsonb_array_elements(e.changes) with ordinality x (c, o))
             = (select array_agg(c ->> 'field' order by c ->> 'field') from jsonb_array_elements(e.changes) c))
           from events e where operation = 'update'), 'changes are ordered by field');

-- The limit counts events ----------------------------------------------------------------------------------------------
select ok((select count(*) from app.field_history('app.records', pg_temp.id('t1'), 2)) > 2,
  'app.field_history answers more rows than events for multi-field updates');
select is((select count(*)::int from app.field_history_events('app.records', pg_temp.id('t1'), 2)), 2,
  'app.field_history_events answers exactly the events asked for');
select ok((select bool_and(changes @> '[{"field": "title"}]' and changes @> '[{"field": "due_at"}]')
           from app.field_history_events('app.records', pg_temp.id('t1'), 2) where operation = 'update'),
  'and each update in a short page is whole');

-- The same rules as app.field_history --------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok($$select * from app.field_history_events('app.records', (select id from world where key = 't1'))$$,
  '42501', null, 'a Viewer outside the project reads no history of its records (invariant 2)');
select pg_temp.as_user('dave');
select throws_ok($$select * from app.field_history_events('app.medical_encounters', gen_random_uuid())$$, 'XR001', null,
  'a table outside the registry has no field history');
select ok(not has_function_privilege('anon', 'app.field_history_events(text,uuid,integer)', 'execute'),
  'an anonymous caller may not run it');

select pg_temp.as_platform();
insert into private.column_classifications (table_name, column_name, classification, read_capability)
values ('app.records', 'title', 'Restricted', 'data.restricted.read.payroll');
select pg_temp.as_user('dave');
select ok((select bool_and(c -> 'masked' = 'true'::jsonb and c -> 'old_value' = 'null'::jsonb and c -> 'new_value' = 'null'::jsonb)
           from app.field_history_events('app.records', pg_temp.id('t1')) e
           cross join lateral jsonb_array_elements(e.changes) c
           where c ->> 'field' = 'title'),
  'a Restricted field is masked without its read capability and shows neither value');
select pg_temp.as_platform();

select * from finish();
rollback;
