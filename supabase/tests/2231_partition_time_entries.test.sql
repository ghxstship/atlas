-- pgTAP: migration 2231, app.time_entries partitioned by month (A130, RRR-175, trace row S5.1-07, Section 5.1). The
-- table keeps its policies, triggers, grants, indexes and API view; its three referencing tables carry the partition
-- key in composite foreign keys the database fills; an id is never reused; retention is unchanged, and the nightly
-- maintenance makes its months ahead. Audit names and refusal codes are pgTAP 2230; the crew, punch and payroll suites
-- (0340, 0365, 0940, 0941, 1321, 1328, 1398, 1399 and others) run unchanged against the partitioned table.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(29);

-- Structure ---------------------------------------------------------------------------------------------------------
select is((select relkind::text from pg_class where oid = 'app.time_entries'::regclass), 'p', 'time_entries is partitioned');
select is(pg_get_partkeydef('app.time_entries'::regclass), 'RANGE (created_at)', 'by month ranges of created_at');
select is((select row(partition_column, premake_months, maintenance_order)::text from private.partitioned_tables
           where table_name = 'app.time_entries'), '(created_at,3,20)', 'registered: 3 months ahead, maintenance order 20');
select is((select i.inhparent::regclass::text from pg_inherits i
           where i.inhrelid = to_regclass(private.partition_name('app.time_entries',
             (date_trunc('month', now() at time zone 'UTC') + interval '3 months')::date))),
  'app.time_entries', 'the partition three months ahead exists');
select col_is_pk('app', 'time_entries', array['id', 'created_at'], 'the primary key carries the partition key');
select policies_are('app', 'time_entries', array['time_entries_insert', 'time_entries_read', 'time_entries_update'],
  'the same three policies');
select triggers_are('app', 'time_entries', array[
  't00_unique_id', 't10_derive_org_id', 't15_refuse_read_only_org', 't20_refuse_org_change', 't30_refuse_cross_org_reference',
  't36_apply_web_clock_rules', 't38_guard_engaged_worker', 't39_time_entry_engagement_project', 't40_guard_time_entry',
  't42_refuse_time_entry_delete', 't85_audit_time_entry', 't85_audit_trail', 't86_void_timesheet_approvals',
  't90_emit_clocked_in', 't90_emit_clocked_out', 't90_stamp_audit_columns'],
  'every trigger, the web clock rules of 1321 included, and the id guard');
select indexes_are('app', 'time_entries', array[
  'time_entries_pkey', 'time_entries_clock_in_idx', 'time_entries_created_by_idx', 'time_entries_engagement_id_idx',
  'time_entries_kiosk_device_id_idx', 'time_entries_membership_id_idx', 'time_entries_needs_review_idx', 'time_entries_open_idx',
  'time_entries_org_id_idx', 'time_entries_project_clock_in_idx', 'time_entries_shift_id_idx', 'time_entries_updated_by_idx'],
  'every index');
select table_privs_are('app', 'time_entries', 'authenticated', array['SELECT', 'INSERT', 'UPDATE'],
  'signed-in people read, insert and update, as before');
select table_privs_are('app', 'time_entries', 'anon', array[]::text[], 'anon has no grant');
select is((select relrowsecurity from pg_class where oid = 'app.time_entries'::regclass), true, 'row level security is on');
select is((select count(*)::integer from pg_inherits i where i.inhparent = 'app.time_entries'::regclass
           and (has_table_privilege('authenticated', i.inhrelid, 'select') or has_table_privilege('anon', i.inhrelid, 'select'))),
  0, 'no partition can be read directly, around the policies');
select ok(has_table_privilege('authenticated', 'api_external.time_entries', 'select')
          and not has_table_privilege('anon', 'api_external.time_entries', 'select'),
  'the API view is recreated with its grants');
select is((select array_agg(a.attname || ': ' || col_description(a.attrelid, a.attnum) order by a.attnum) from pg_attribute a
           where a.attrelid = 'api_external.time_entries'::regclass and a.attnum > 0),
  array['id: Time entry.', 'engagement_id: Engagement.', 'project_id: Project.', 'shift_id: Shift worked.', 'clock_in: Clock in.',
        'clock_out: Clock out; NULL while open.', 'break_minutes: Break minutes.', 'source: Where the time was captured.'],
  'and its column descriptions');
select is((select array_agg(c.conrelid::regclass::text || ' ' || pg_get_constraintdef(c.oid) order by c.conrelid::regclass::text)
           from pg_constraint c where c.confrelid = 'app.time_entries'::regclass and c.conparentid = 0),
  array['app.clock_punches FOREIGN KEY (time_entry_id, time_entry_created_at) REFERENCES app.time_entries(id, created_at)',
        'app.time_entry_audit FOREIGN KEY (time_entry_id, time_entry_created_at) REFERENCES app.time_entries(id, created_at)',
        'app.time_entry_corrections FOREIGN KEY (time_entry_id, time_entry_created_at) REFERENCES app.time_entries(id, created_at)'],
  'the three referencing tables hold composite foreign keys');
select is((select array_agg(c.table_name || ' ' || coalesce(c.column_default, 'none') || ' ' || c.is_nullable order by c.table_name)
           from information_schema.columns c where c.table_schema = 'app' and c.column_name = 'time_entry_created_at'),
  array['clock_punches none YES', 'time_entry_audit ''-infinity''::timestamp with time zone NO',
        'time_entry_corrections ''-infinity''::timestamp with time zone NO'],
  'callers may leave the partition key out: it is nullable with the reference, or defaults to a value the key refuses');
select is((select purge_method::text || ' ' || retention::text from private.retention_policies where table_name = 'app.time_entries'),
  'Delete 7 years', 'retention is unchanged: soft-deleted entries are deleted row by row after 7 years');

-- Behavior ----------------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_user('carol');
with x as (insert into app.time_entries (project_id, engagement_id, clock_in, clock_out)
           values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '2027-06-03 08:00+00', '2027-06-03 12:00+00') returning id)
  insert into world select 'te_ivy', id from x;
select is((select tableoid::regclass::text from app.time_entries where id = pg_temp.id('te_ivy')),
  'private.time_entries_p' || to_char(now() at time zone 'UTC', 'YYYYMM'),
  'an entry lands in this month''s partition, by when it was recorded, not when work started');
select is((select time_entry_created_at from app.time_entry_audit where time_entry_id = pg_temp.id('te_ivy')),
  (select created_at from app.time_entries where id = pg_temp.id('te_ivy')),
  'the entry''s own audit row is filled with its partition key');
select lives_ok($$update app.time_entries set clock_out = '2027-06-03 12:30+00' where id = (select id from world where key = 'te_ivy')$$,
  'a correction of the times stays in its partition');
select is((select count(*)::integer from app.time_entry_audit where time_entry_id = pg_temp.id('te_ivy')
           and time_entry_created_at = (select created_at from app.time_entries where id = pg_temp.id('te_ivy'))), 2,
  'and its audit row is filled too, never left at the default');
select pg_temp.as_user('carol');
with x as (insert into app.time_entry_corrections (time_entry_id, proposed_clock_in, proposed_clock_out, reason)
           values (pg_temp.id('te_ivy'), '2027-06-03 08:05+00', '2027-06-03 12:30+00', 'Clocked in at the gate.') returning id)
  insert into world select 'corr_ivy', id from x;
select is((select time_entry_created_at from app.time_entry_corrections where id = pg_temp.id('corr_ivy')),
  (select created_at from app.time_entries where id = pg_temp.id('te_ivy')),
  'a correction sent with only the entry id is filled with the entry''s partition key');
select pg_temp.as_user('ivy');
select is((select count(*)::integer from app.time_entries), 1, 'the engaged person reads their own entry through the policies');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.time_entries), 0, 'another org reads none');
select pg_temp.as_anon();
select throws_ok('select 1 from app.time_entries', '42501', null, 'anon cannot read entries');

select pg_temp.as_platform();
select throws_ok($$insert into app.time_entries (id, project_id, engagement_id, clock_in, clock_out) values ((select id from world where key = 'te_ivy'), (select id from world where key = 'prj_a'), (select id from world where key = 'eng_ivy_a'), '2027-07-03 08:00+00', '2027-07-03 12:00+00')$$,
  '23505', 'duplicate key value violates unique constraint "time_entries_pkey"', 'an id is never reused');
select throws_ok($$insert into app.time_entry_audit (time_entry_id, new_values) values ('00000000-0000-7000-8000-00000000a130', '{}')$$,
  '23503', 'insert or update on table "time_entry_audit" violates foreign key constraint "time_entry_audit_time_entry_id_fkey"',
  'a reference to no entry is refused, as by the old foreign key');
select private.create_month_partition('app.time_entries', (now() - interval '8 years')::date);
select is(private.expire_partitions('app.time_entries'), 0, 'the nightly job never detaches a month of time entries');
select lives_ok('select private.run_partition_maintenance()', 'the nightly maintenance runs with the converted table');

select * from finish();
rollback;
