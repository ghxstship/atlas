-- pgTAP: migration 2230, the shared trigger functions resolve a partition to its parent (A130, RRR-175, trace row
-- S5.1-07, Section 5.1). A probe table runs one round of audited changes and refusals as a plain table, is converted by
-- private.partition_existing_table, and runs the same round on its partitions: the audit actions, subjects, diff
-- columns and refusals come out identical. Then app.time_entries itself: its audit action names, its excluded
-- Restricted columns and its refusal codes and messages are the ones the plain table gave. Those assertions hold
-- whether or not the table is partitioned, so infra/db/verify-proposals.sh runs this suite before and after 2231 on a
-- drill copy, and here they hold after it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(27);

-- The resolver ------------------------------------------------------------------------------------------------------
select is(private.trigger_table('app.projects'::regclass), 'app.projects'::regclass, 'a plain table is itself');
select is(private.trigger_table(to_regclass(private.partition_name('app.audit_events',
  date_trunc('month', now() at time zone 'UTC')::date))), 'app.audit_events'::regclass, 'a month partition is its parent');
select is(private.trigger_table_name(to_regclass(private.partition_name('app.audit_events',
  date_trunc('month', now() at time zone 'UTC')::date))), 'audit_events', 'and is named by its parent');
select ok(not has_function_privilege('authenticated', 'private.trigger_table(oid)', 'execute')
          and not has_function_privilege('anon', 'private.trigger_table_name(oid)', 'execute'),
  'the resolver is not callable from the API');
select is((select count(*)::integer from pg_proc
           where oid in ('private.audit_row_change()'::regprocedure, 'private.guard_engaged_worker()'::regprocedure,
                         'private.refuse_ledger_change()'::regprocedure, 'private.refuse_org_change()'::regprocedure,
                         'private.refuse_cross_org_reference()'::regprocedure, 'private.derive_org_id()'::regprocedure,
                         'private.assert_same_project()'::regprocedure)
             and prosrc ~ 'private\.trigger_table'
             and prosecdef and proconfig = array['search_path=""']), 7,
  'the seven shared trigger functions name tables through the resolver, as security definers with an empty search path');

-- A probe, before and after conversion ------------------------------------------------------------------------------
select pg_temp.as_platform();
create table app.a130_probe (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  project_id uuid,
  engagement_id uuid,
  code text,
  note text,
  secret bytea,
  created_at timestamptz not null default now()
);
create trigger t20_refuse_org_change before update on app.a130_probe
  for each row execute function private.refuse_org_change();
create trigger t38_guard_engaged_worker before insert or update of engagement_id on app.a130_probe
  for each row execute function private.guard_engaged_worker();
create trigger t85_audit_trail after insert or update or delete on app.a130_probe
  for each row execute function private.audit_row_change();
create trigger t95_append_only before delete on app.a130_probe
  for each row execute function private.refuse_ledger_change();
insert into private.column_classifications (table_name, column_name, classification, read_capability)
values ('app.a130_probe', 'note', 'Restricted', 'crew.time_entry.read');

-- One round: an insert and an update audited, then three refusals. Returns what an observer sees, without ids.
create function pg_temp.probe_round() returns jsonb
language plpgsql as $$
declare
  v_id uuid;
  v_out jsonb;
begin
  insert into app.a130_probe (org_id, code, note, secret) values (pg_temp.id('org_a'), 'A', 'restricted', '\x01')
  returning id into v_id;
  update app.a130_probe set code = 'B', note = 'still restricted', secret = '\x02' where id = v_id;
  select jsonb_build_object('audit', jsonb_agg(jsonb_build_object('action', a.action, 'subject', a.subject_table,
           'columns', (select jsonb_agg(k order by k) from jsonb_object_keys(coalesce(a.diff -> 'new', a.diff -> 'old')) k))
           order by a.action))
    into v_out
  from app.audit_events a where a.subject_id = v_id;
  begin
    update app.a130_probe set org_id = pg_temp.id('org_b') where id = v_id;
  exception when others then
    v_out := v_out || jsonb_build_object('org_change', sqlstate || ' ' || sqlerrm);
  end;
  begin
    update app.a130_probe set engagement_id = gen_random_uuid() where id = v_id;
  exception when others then
    v_out := v_out || jsonb_build_object('worker_change', sqlstate || ' ' || sqlerrm);
  end;
  begin
    delete from app.a130_probe where id = v_id;
  exception when others then
    v_out := v_out || jsonb_build_object('delete', sqlstate || ' ' || sqlerrm);
  end;
  return v_out;
end $$;

create temporary table a130_before as select pg_temp.probe_round() as round;
select is((select round from a130_before), jsonb_build_object(
  'audit', jsonb_build_array(
    jsonb_build_object('action', 'a130_probe.insert', 'subject', 'app.a130_probe',
      'columns', jsonb_build_array('code', 'engagement_id', 'id', 'org_id', 'project_id')),
    jsonb_build_object('action', 'a130_probe.update', 'subject', 'app.a130_probe', 'columns', jsonb_build_array('code'))),
  'org_change', 'XR001 tenant_move: a130_probe rows cannot move to another org.',
  'worker_change', 'XR001 a130_probe_worker_immutable: The worker of time never changes.',
  'delete', 'XR001 append_only: a130_probe is an append-only ledger.'),
  'as a plain table: the audit names the table, leaves out audit, binary and Restricted columns, and refusals name it');

select lives_ok($$call private.partition_existing_table('app.a130_probe', 'created_at', 1::smallint, 99)$$,
  'the probe converts');
select is(pg_temp.probe_round(), (select round from a130_before),
  'partitioned: the same audit actions, subjects and columns, and the same refusals');
select is((select count(*)::integer from app.a130_probe where tableoid = 'app.a130_probe'::regclass), 0,
  'and its rows really sit in partitions, where TG_TABLE_NAME names the month');

-- app.time_entries ----------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_user('carol');
with x as (insert into app.time_entries (project_id, engagement_id, clock_in, clock_out)
           values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '2027-06-03 08:00+00', '2027-06-03 12:00+00') returning id)
  insert into world select 'te_ivy', id from x;

select pg_temp.as_platform();
select is((select array_agg(action || ' ' || subject_table) from app.audit_events where subject_id = pg_temp.id('te_ivy')),
  array['time_entries.insert app.time_entries'], 'a new entry is audited as time_entries.insert on app.time_entries');
select is(private.audit_excluded_columns(private.trigger_table((select tableoid from app.time_entries where id = pg_temp.id('te_ivy')))),
  private.audit_excluded_columns('app.time_entries'), 'the row''s table leaves out the columns app.time_entries leaves out');

-- A Restricted column on time_entries leaves the diff, as it did on the plain table.
insert into private.column_classifications (table_name, column_name, classification, read_capability)
values ('app.time_entries', 'break_minutes', 'Restricted', 'crew.time_entry.read');
select ok(private.audit_excluded_columns(private.trigger_table((select tableoid from app.time_entries where id = pg_temp.id('te_ivy'))))
          @> array['created_at', 'created_by', 'updated_at', 'updated_by', 'break_minutes'],
  'audit columns and the Restricted column are excluded for the row''s table');
select pg_temp.as_user('carol');
update app.time_entries set clock_out = '2027-06-03 12:30+00', break_minutes = 30 where id = pg_temp.id('te_ivy');
select pg_temp.as_platform();
select is((select array_agg(action || ' ' || subject_table order by action) from app.audit_events where subject_id = pg_temp.id('te_ivy')),
  array['time_entries.insert app.time_entries', 'time_entries.update app.time_entries'],
  'a change is audited as time_entries.update on app.time_entries');
select is((select diff from app.audit_events where subject_id = pg_temp.id('te_ivy') and action = 'time_entries.update'),
  jsonb_build_object('old', jsonb_build_object('clock_out', '2027-06-03T12:00:00+00:00'),
                     'new', jsonb_build_object('clock_out', '2027-06-03T12:30:00+00:00')),
  'the diff carries the clock-out and leaves out the Restricted break and the audit columns');
select is((select count(*)::integer from app.audit_events where subject_table like '%time_entries_p%' or action like 'time_entries_p%'),
  0, 'no audit row names a partition');

-- Refusal codes and messages, as on the plain table.
select pg_temp.as_user('carol');
select throws_ok($$update app.time_entries set engagement_id = (select id from world where key = 'eng_art_a') where id = (select id from world where key = 'te_ivy')$$,
  'XR001', 'time_entries_worker_immutable: The worker of time never changes.', 'the worker guard refuses with time_entries_worker_immutable');
select throws_ok($$insert into app.time_entries (project_id, engagement_id, clock_in, clock_out) values ((select id from world where key = 'prj_a2'), (select id from world where key = 'eng_ivy_a'), '2027-06-05 08:00+00', '2027-06-05 12:00+00')$$,
  'XR001', 'same_project: time_entries.engagement_id points to a row of another project.', 'an engagement of another project is refused by name');
select throws_ok($$insert into app.time_entries (project_id, engagement_id, clock_in, clock_out) values ((select id from world where key = 'prj_a'), (select id from world where key = 'eng_ivy_a'), '2027-06-03 11:00+00', '2027-06-03 13:00+00')$$,
  'XR001', 'time_entry_overlap: Time entries of one person cannot overlap.', 'overlapping entries are still refused (invariant 20)');
select pg_temp.as_platform();
select throws_ok($$delete from app.time_entries where id = (select id from world where key = 'te_ivy')$$,
  'XR001', 'append_only: time_entries is an append-only ledger.', 'a delete is refused as time_entries, an append-only ledger');
select throws_ok($$update app.time_entries set org_id = (select id from world where key = 'org_b') where id = (select id from world where key = 'te_ivy')$$,
  'XR001', 'tenant_move: time_entries rows cannot move to another org.', 'an entry cannot move to another org, by name');
select throws_ok($$insert into app.time_entries (project_id, engagement_id, clock_in) values ('00000000-0000-7000-8000-00000000a130', (select id from world where key = 'eng_ivy_a'), '2027-06-08 08:00+00')$$,
  '23503', 'time_entries.project_id references a missing app.projects row', 'a missing project is refused by name');
select throws_ok($$insert into app.time_entries (project_id, membership_id, clock_in) values ((select id from world where key = 'prj_a'), (select m.id from app.memberships m where m.org_id = (select id from world where key = 'org_b') limit 1), '2027-06-08 08:00+00')$$,
  'XR001', 'cross_org_reference: time_entries.membership_id points to a row of another org.', 'a membership of another org is refused by name');

-- The unchanged neighbours: shifts keep their own worker rule, and timesheets their own code.
select is((select count(*)::integer from pg_trigger where tgname = 't38_guard_engaged_worker' and tgparentid = 0
           and tgrelid in ('app.shifts'::regclass, 'app.time_entries'::regclass, 'app.timesheets'::regclass, 'app.clock_punches'::regclass)),
  4, 'the worker guard still runs on shifts, time entries, timesheets and punches');
select is((select count(*)::integer from app.audit_events where action like 'time_entries.%'
           and subject_table = 'app.time_entries' and subject_id = pg_temp.id('te_ivy')), 2,
  'refused changes write no audit rows');
select is((select count(*)::integer from app.time_entries where id = pg_temp.id('te_ivy')), 1, 'the entry is still there');
select is((select clock_out from app.time_entries where id = pg_temp.id('te_ivy')), '2027-06-03 12:30+00'::timestamptz,
  'with the accepted change');
select is((select break_minutes from app.time_entries where id = pg_temp.id('te_ivy')), 30,
  'Restricted columns are left out of the audit, not out of the row');

select * from finish();
rollback;
