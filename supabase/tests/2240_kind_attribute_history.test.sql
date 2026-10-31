-- pgTAP: 2240, kind attribute history (A131, RRR-177, S4.10-04). Every kind extension table (app.record_<kind>) has an
-- audit trail keyed by the record, and a record's field history merges its extension row's changes as attributes.<column>
-- with their before and after values, under the record's own read check and Restricted masking; the per-event history
-- (2061) carries them too.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(17);

-- Every kind table is audited and registered ---------------------------------------------------------------------------
create temporary table kind_tables as
  select c.conrelid::regclass::text as table_name
  from pg_catalog.pg_constraint c
  join pg_catalog.pg_class r on r.oid = c.conrelid
  where c.contype = 'f' and c.confrelid = 'app.records'::regclass and c.conname = r.relname || '_record_kind_fkey';

select ok((select count(*) from kind_tables) >= 26, 'the record spine has its kind extension tables');
select is(
  (select count(*)::int from kind_tables k
   where exists (select 1 from pg_catalog.pg_trigger g join pg_catalog.pg_proc f on f.oid = g.tgfoid
                 where g.tgrelid = k.table_name::regclass and g.tgname = 't85_audit_trail'
                   and f.oid = 'private.audit_keyed_row_change()'::regprocedure)),
  (select count(*)::int from kind_tables),
  'every kind extension table has a keyed audit trail');
select is(
  (select count(*)::int from kind_tables k join private.field_history_extensions x on x.table_name = k.table_name
   where x.subject_table = 'app.records' and x.key_column = 'record_id' and x.field_prefix = 'attributes'),
  (select count(*)::int from kind_tables),
  'and merges into the record''s history');
select ok(not has_function_privilege('authenticated', 'private.audit_keyed_row_change()', 'execute')
          and not has_table_privilege('authenticated', 'private.field_history_extensions', 'select'),
  'the trigger and the registry stay private');

-- Editing a Task's attributes ------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (
  insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Task', 'Rig the truss', 'Y', 'Declared') returning id
) insert into world select 'task', id from x;
insert into app.record_task (record_id, progress_pct) values (pg_temp.id('task'), 40);
update app.record_task set progress_pct = 75, effort_hours = 6 where record_id = pg_temp.id('task');
update app.records set title = 'Rig both trusses' where id = pg_temp.id('task');

create temporary table history as select * from app.field_history('app.records', pg_temp.id('task'));
grant select on history to public;

select is((select count(*)::int from history where field = 'attributes.progress_pct'), 2,
  'the first save and the edit of an attribute are each a change of the record');
select is((select new_value from history where field = 'attributes.progress_pct' and old_value = 'null'::jsonb), '40'::jsonb,
  'the first save reads as the attribute going from nothing to its value');
select is((select old_value from history where field = 'attributes.progress_pct' and new_value = '75'::jsonb), '40'::jsonb,
  'an edit shows the attribute before');
select is((select new_value from history where field = 'attributes.effort_hours'), '6'::jsonb, 'and after');
select is((select operation from history where field = 'attributes.effort_hours'), 'update', 'as an update of the record');
select is((select actor_name from history where field = 'attributes.effort_hours'), 'Dave Lindqvist', 'by the person who saved it');
select is((select count(*)::int from history where field = 'title'), 1, 'the record''s own fields stay in the same history');
select ok((select bool_and(field not in ('attributes.record_id', 'attributes.record_kind', 'attributes.org_id', 'attributes.deleted_at',
                                          'attributes.updated_at', 'attributes.updated_by'))
           from history where field is not null),
  'the extension''s key, kind and bookkeeping columns are left out');

-- The page reads app.field_history_events (2061), one row per event: the attribute edit is one event with both fields.
select is(
  (select array_agg(c ->> 'field' order by c ->> 'field')
   from app.field_history_events('app.records', pg_temp.id('task')) e, jsonb_array_elements(e.changes) c
   where e.changes @> '[{"field": "attributes.effort_hours"}]'),
  array['attributes.effort_hours', 'attributes.progress_pct'],
  'the per-event history carries an attribute edit as one event of the record');

select pg_temp.as_platform();
select is((select subject_id from app.audit_events where subject_table = 'app.record_task' and action = 'record_task.update'
           and subject_id = pg_temp.id('task')), pg_temp.id('task'), 'the ledger keys an extension change by its record');

-- Only someone who can read the record, Restricted attributes masked -----------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok($$select * from app.field_history('app.records', (select id from world where key = 'task'))$$, '42501', null,
  'a Viewer outside the project reads none of its attribute history');

select pg_temp.as_platform();
insert into private.column_classifications (table_name, column_name, classification, read_capability)
values ('app.record_task', 'effort_hours', 'Restricted', 'data.restricted.read.payroll');
select pg_temp.as_user('dave');
select is((select masked from app.field_history('app.records', pg_temp.id('task')) where field = 'attributes.effort_hours'), true,
  'an attribute classified Restricted is masked without its read capability');
select is((select new_value from app.field_history('app.records', pg_temp.id('task')) where field = 'attributes.effort_hours'), null,
  'and shows neither value');
select pg_temp.as_platform();

select * from finish();
rollback;
