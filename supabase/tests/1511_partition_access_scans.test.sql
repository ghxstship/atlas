-- pgTAP: migration 1511, app.access_scans partitioned by month (A94, RRR-139, finding A65-032, Section 5.1). The table
-- keeps its policies, triggers, grants and indexes; a scan still lands with the database's decision, a replayed client
-- id still returns the first scan, an id is never reused, the ledger stays append-only, and the 7-year retention now
-- drops whole months. The access scan suites (0352, 0470 and later) run unchanged against the partitioned table.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(24);

-- Structure ---------------------------------------------------------------------------------------------------------
select is((select relkind::text from pg_class where oid = 'app.access_scans'::regclass), 'p', 'access_scans is partitioned');
select is(pg_get_partkeydef('app.access_scans'::regclass), 'RANGE (created_at)', 'by month ranges of created_at');
select is((select row(partition_column, premake_months, maintenance_order)::text from private.partitioned_tables
           where table_name = 'app.access_scans'), '(created_at,3,30)', 'registered: 3 months ahead, maintenance order 30');
select is((select i.inhparent::regclass::text from pg_inherits i
           where i.inhrelid = to_regclass(private.partition_name('app.access_scans',
             (date_trunc('month', now() at time zone 'UTC') + interval '3 months')::date))),
  'app.access_scans', 'the partition three months ahead exists');
select col_is_pk('app', 'access_scans', array['id', 'created_at'], 'the primary key carries the partition key');
select policies_are('app', 'access_scans', array['access_scans_insert', 'access_scans_read'], 'the same two policies');
select triggers_are('app', 'access_scans', array[
  't00_unique_id', 't10_derive_org_id', 't15_access_scans_project', 't15_refuse_read_only_org', 't20_refuse_org_change',
  't30_refuse_cross_org_reference', 't40_decide_access_scan', 't41_guard_access_scan_device',
  't90_emit_access_scan_denied', 't90_stamp_audit_columns', 't95_append_only'], 'every trigger, and the id guard');
select indexes_are('app', 'access_scans', array[
  'access_scans_pkey', 'access_scans_created_by_idx', 'access_scans_credential_idx', 'access_scans_org_id_idx',
  'access_scans_project_id_idx', 'access_scans_updated_by_idx', 'access_scans_zone_idx'], 'every index');
select table_privs_are('app', 'access_scans', 'authenticated', array['SELECT', 'INSERT'], 'signed-in people read and insert, as before');
select table_privs_are('app', 'access_scans', 'anon', array[]::text[], 'anon has no grant');
select is((select relrowsecurity from pg_class where oid = 'app.access_scans'::regclass), true, 'row level security is on');
select is((select count(*)::integer from pg_inherits i where i.inhparent = 'app.access_scans'::regclass
           and (has_table_privilege('authenticated', i.inhrelid, 'select') or has_table_privilege('anon', i.inhrelid, 'select'))),
  0, 'no partition can be read directly, around the policies');

-- Behavior ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'BOH', 'Back of House') returning id)
  insert into world select 'zone', id from x;
with x as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'CREW', 'Crew') returning id)
  insert into world select 'cat', id from x;
insert into app.access_grid (credential_category_id, zone_id, access_level_enum_id, window_starts_at, window_ends_at)
values (pg_temp.id('cat'), pg_temp.id('zone'), 'ENM-036', now() - interval '1 day', now() + interval '1 day');
with x as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat'), pg_temp.id('frank')) returning id)
  insert into world select 'cred', id from x;

insert into app.access_scans (credential_id, zone_id, result) values (pg_temp.id('cred'), pg_temp.id('zone'), 'Denied');
select is((select result::text from app.access_scans where credential_id = pg_temp.id('cred')), 'Granted',
  'the database still decides the result, whatever the scanner sent');
select is((select tableoid::regclass::text from app.access_scans where credential_id = pg_temp.id('cred')),
  'private.access_scans_p' || to_char(now() at time zone 'UTC', 'YYYYMM'),
  'the scan lands in this month''s partition');
select is((select replayed from app.record_scan(pg_temp.id('zone'), pg_temp.id('cred'), null, '00000000-0000-7000-8000-00000000a941')),
  false, 'a client id records a scan');
select is((select replayed from app.record_scan(pg_temp.id('zone'), pg_temp.id('cred'), null, '00000000-0000-7000-8000-00000000a941')),
  true, 'replaying the client id returns the first scan');
select is((select count(*)::integer from app.access_scans where id = '00000000-0000-7000-8000-00000000a941'), 1, 'and records nothing new');
select throws_ok($$insert into app.access_scans (id, credential_id, zone_id) values ('00000000-0000-7000-8000-00000000a941', (select id from world where key = 'cred'), (select id from world where key = 'zone'))$$,
  '23505', 'duplicate key value violates unique constraint "access_scans_pkey"', 'an id is never reused');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.access_scans), 0, 'another org reads no scans');
select pg_temp.as_anon();
select throws_ok('select 1 from app.access_scans', '42501', null, 'anon cannot read scans');

-- The ledger and its retention -----------------------------------------------------------------------------------------
select pg_temp.as_platform();
select throws_ok($$update app.access_scans set result = 'Denied' where credential_id = (select id from world where key = 'cred')$$,
  'XR001', null, 'the scan ledger stays append-only, even for the platform');
select is((select purge_method::text from private.retention_policies where table_name = 'app.access_scans'), 'Drop Partition',
  'the 7-year retention drops whole months');
select private.create_month_partition('app.access_scans', (now() - interval '8 years')::date);
select is(private.expire_partitions('app.access_scans'), 1, 'a month past retention is detached by the nightly job');
select lives_ok('select private.run_partition_maintenance()', 'the nightly maintenance runs with the converted table');

select * from finish();
rollback;
