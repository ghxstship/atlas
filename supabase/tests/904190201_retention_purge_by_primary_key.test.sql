-- pgTAP: the nightly retention job completes (904190201; Section 7.1, Section 14.3). The row purge reads and
-- deletes by each table's primary key, so the record tables keyed by record_id and the partitioned
-- app.time_entries keyed by (id, created_at) purge like every table keyed by id; and a table the purge cannot
-- read is recorded and skipped, so it never ends the night for the other tables.
-- Before 904190201 the first assertion on app.record_task failed with "column t.id does not exist", the error
-- xos_nightly_retention raised in production on every night from 2026-10-17.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(22);

-- Every row-purged table can be purged ---------------------------------------------------------------------
select is(
  (select coalesce(string_agg(r.table_name, ', ' order by r.table_name), '') from private.retention_policies r
   where r.purge_method = 'Delete'
     and not exists (select 1 from pg_index i where i.indrelid = r.table_name::regclass and i.indisprimary)),
  '', 'every table with a Delete retention policy has a primary key to purge by');
select ok(
  (select count(*) from private.retention_policies r
   where r.purge_method = 'Delete'
     and not exists (select 1 from pg_attribute a where a.attrelid = r.table_name::regclass and a.attname = 'id' and not a.attisdropped)) >= 26,
  'the record tables have Delete policies and no id column: the case that stopped the job');

-- A table keyed by record_id ---------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Task', 'Execute', 'Strike the old truss', 'Y', 'Declared') returning id)
  insert into world select 'ret_old', id from x;
with x as (insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Task', 'Execute', 'Coil the feeder cable', 'Y', 'Declared') returning id)
  insert into world select 'ret_recent', id from x;
with x as (insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Task', 'Execute', 'Label the road cases', 'Y', 'Declared') returning id)
  insert into world select 'ret_live', id from x;
insert into app.record_task (record_id, progress_pct) values
  (pg_temp.id('ret_old'), 10), (pg_temp.id('ret_recent'), 20), (pg_temp.id('ret_live'), 30);
select pg_temp.as_platform();
update app.record_task set deleted_at = now() - interval '8 years' where record_id = pg_temp.id('ret_old');
update app.record_task set deleted_at = now() - interval '6 years' where record_id = pg_temp.id('ret_recent');

-- A legal hold still suspends the purge for the org.
select pg_temp.as_user('bob');
insert into app.legal_holds (org_id, table_name, matter) values (pg_temp.id('org_a'), 'app.record_task', 'Rigging claim 2026-31.');
select pg_temp.as_platform();
select lives_ok($$select private.purge_table('app.record_task')$$, 'the purge reads a table that has no id column');
select is((select count(*)::integer from app.record_task where record_id = pg_temp.id('ret_old')), 1,
  'a legal hold keeps the org''s expired row in a table keyed by record_id');
select pg_temp.as_user('bob');
update app.legal_holds set released_at = now() where org_id = pg_temp.id('org_a') and table_name = 'app.record_task';
select pg_temp.as_platform();

select is(private.purge_table('app.record_task'), 1::bigint, 'the purge deletes the one expired row of a table keyed by record_id');
select is((select count(*)::integer from app.record_task where record_id = pg_temp.id('ret_old')), 0, 'the expired row is gone');
select is((select count(*)::integer from app.record_task where record_id = pg_temp.id('ret_recent')), 1,
  'a soft-deleted row inside retention is kept');
select is((select count(*)::integer from app.record_task where record_id = pg_temp.id('ret_live')), 1, 'a live row is kept');
select is(
  (select row(rows_affected, error_message)::text from private.retention_runs where table_name = 'app.record_task'
   order by ran_at desc, id desc limit 1),
  '(1,)', 'the step is recorded with its count and no error');

-- A partitioned table keyed by (id, created_at) --------------------------------------------------------------
select pg_temp.as_user('frank');
with x as (insert into app.time_entries (project_id, membership_id, clock_in, clock_out)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-06-01 08:00+00', '2027-06-01 12:00+00') returning id)
  insert into world select 'ret_te_old', id from x;
with x as (insert into app.time_entries (project_id, membership_id, clock_in, clock_out)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-06-02 08:00+00', '2027-06-02 12:00+00') returning id)
  insert into world select 'ret_te_live', id from x;
select pg_temp.as_platform();
update app.time_entries set deleted_at = now() - interval '8 years' where id = pg_temp.id('ret_te_old');
-- The entry's audit rows are a ledger kept as long as the entry; they reach their own retention with it.
alter table app.time_entry_audit disable trigger user;
update app.time_entry_audit set created_at = now() - interval '8 years' where time_entry_id = pg_temp.id('ret_te_old');
alter table app.time_entry_audit enable trigger user;
select lives_ok($$select private.purge_table('app.time_entry_audit')$$, 'the entry''s expired audit rows are purged first');
select is(private.purge_table('app.time_entries'), 1::bigint, 'the purge deletes by a two-column primary key');
select is((select count(*)::integer from app.time_entries where id = pg_temp.id('ret_te_old')), 0, 'the expired time entry is gone');
select is((select count(*)::integer from app.time_entries where id = pg_temp.id('ret_te_live')), 1, 'the live time entry is kept');

-- A table keyed by id, as before ---------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into app.teams (org_id, name) values (pg_temp.id('org_a'), 'Retired Carpenters');
select pg_temp.as_platform();
update app.teams set deleted_at = now() - interval '8 years' where name = 'Retired Carpenters';
select ok(private.purge_table('app.teams') >= 1, 'a table keyed by id is purged as before');
select is((select count(*)::integer from app.teams where name = 'Retired Carpenters'), 0, 'its expired row is gone');

-- The whole job, to the end --------------------------------------------------------------------------------
insert into private.rate_limit_events (bucket, subject_hash, occurred_at)
values ('test.retention', decode('00ff', 'hex'), now() - interval '2 days');
select lives_ok($$select private.run_nightly_retention()$$, 'the nightly retention job runs to the end');
select is(
  (select count(*)::integer from private.rate_limit_events where bucket = 'test.retention'), 0,
  'the last step, rate limit pruning, ran');
select is(
  (select coalesce(string_agg(distinct format('%s: %s', table_name, error_message), '; '), '') from private.retention_runs
   where error_message is not null and error_message not like '% expired rows kept: %'),
  '', 'no step of the job failed');
select is(
  (select coalesce(string_agg(r.table_name, ', ' order by r.table_name), '') from private.retention_policies r
   where r.purge_method = 'Delete'
     and not exists (select 1 from private.retention_runs u where u.table_name = r.table_name and u.action = 'purge' and u.ran_at = now())),
  '', 'every Delete policy got its purge step in this run');

-- A table the purge cannot read does not end the night -------------------------------------------------------
create table app.retention_probe_unkeyed (label text not null, deleted_at timestamptz);
insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale)
values ('app.retention_probe_unkeyed', 'Soft Deleted', 'deleted_at', '1 year', 'Delete', 'Test table without a primary key.');
insert into app.retention_probe_unkeyed (label, deleted_at) values ('Aged', now() - interval '2 years');
update app.record_task set deleted_at = now() - interval '8 years' where record_id = pg_temp.id('ret_recent');
select lives_ok($$select private.purge_expired_rows()$$, 'a table that cannot be purged does not stop the row purge');
select ok(
  (select error_message from private.retention_runs where table_name = 'app.retention_probe_unkeyed'
   order by id desc limit 1) like '%has no primary key to purge by.',
  'its failure is recorded in the retention runs');
select is((select count(*)::integer from app.record_task where record_id = pg_temp.id('ret_recent')), 0,
  'the tables after it were still purged');

select * from finish();
rollback;
