-- pgTAP: monthly partitions, retention policies, legal holds, the purge job and personal data
-- redaction (Section 5.1, Section 7.1, Section 14.3, Section 7.5 invariant 23).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

-- Catalog-wide checks grow with later tables, so the count is not fixed.
select * from no_plan();

-- Every table states its retention (ADR 0002) -------------------------------------------------------
select is(
  (select coalesce(string_agg(c.relname, ', '), '') from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'app' and c.relkind in ('r', 'p') and not c.relispartition
     and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'deleted_at' and not a.attisdropped)
     and format('app.%s', c.relname) not in (select table_name from private.retention_policies)
     -- Later ranges (0600 and up) add their own rows with private.install_default_retention.
     and c.oid <= (select max(to_regclass(table_name)::oid) from private.retention_policies)),
  '', 'every app table with soft delete up to this range has a retention policy');
select is(
  (select coalesce(string_agg(table_name, ', '), '') from private.retention_policies where to_regclass(table_name) is null),
  '', 'every retention policy names an existing table');
select is(
  (select retention from private.retention_policies where table_name = 'app.audit_events'), interval '7 years',
  'inv_23_audit_retention: the audit ledger is kept 7 years');
select is(
  (select redact_personal_data_after from private.retention_policies where table_name = 'app.audit_events'), interval '90 days',
  'audit personal data is redacted at 90 days');
select is(
  (select retention from private.retention_policies where table_name = 'app.activity_events'), interval '18 months',
  'the activity feed is kept 18 months');
select throws_ok($$insert into private.retention_policies values ('app.no_such_table', 'Age', 'created_at', '1 year', 'Delete', null, 'Test.')$$,
  'XR001', null, 'a retention policy must name a real table');
select throws_ok($$insert into private.retention_policies values ('app.teams', 'Soft Deleted', 'created_at', '1 year', 'Delete', null, 'Test.')$$,
  '23514', null, 'a soft delete policy counts from deleted_at');
select throws_ok($$update private.retention_policies set purge_method = 'Drop Partition' where table_name = 'app.teams'$$,
  'XR001', null, 'only registered partitioned tables drop partitions');
select pg_temp.as_user('gina');
select ok((select count(*) from app.retention_policies) > 100, 'members read the retention schedule');
select pg_temp.as_platform();

-- Partitions (Section 5.1) -------------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(p.table_name || ':' || to_char(m, 'YYYYMM'), ', '), '')
   from private.partitioned_tables p
   cross join generate_series(date_trunc('month', now() at time zone 'UTC'), date_trunc('month', now() at time zone 'UTC') + make_interval(months => p.premake_months), interval '1 month') m
   where to_regclass(private.partition_name(p.table_name, m::date)) is null),
  '', 'every partitioned table has partitions from this month through its premake horizon');
select is(
  (select coalesce(string_agg(c.oid::regclass::text, ', '), '') from pg_inherits i join pg_class c on c.oid = i.inhrelid
   join pg_namespace n on n.oid = c.relnamespace
   where i.inhparent in (select to_regclass(table_name) from private.partitioned_tables) and n.nspname <> 'private'),
  '', 'partitions live in the private schema');
select is(
  (select coalesce(string_agg(c.oid::regclass::text, ', '), '') from pg_inherits i join pg_class c on c.oid = i.inhrelid
   where i.inhparent in (select to_regclass(table_name) from private.partitioned_tables)
     and (not c.relrowsecurity or has_table_privilege('authenticated', c.oid, 'select') or has_table_privilege('anon', c.oid, 'select'))),
  '', 'partitions have row level security on and grant nothing to signed-in or anonymous callers');
select is(
  (select count(*)::integer from private.partitioned_tables where table_name = 'app.audit_events' and partition_column = 'created_at'),
  1, 'audit_events is partitioned by month');
select is(private.ensure_partitions('app.audit_events'), 0, 'partition maintenance is idempotent');
select throws_ok($$select private.ensure_partitions('app.teams')$$, 'XR001', null, 'only registered tables get partitions');
select is(
  (select count(*)::integer from cron.job where jobname = 'xos_nightly_retention'), 1,
  'the nightly retention job is scheduled with pg_cron');

-- Row purge and legal hold ----------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into app.teams (org_id, name) values (pg_temp.id('org_a'), 'Retired Riggers');
select pg_temp.as_user('xavier');
insert into app.teams (org_id, name) values (pg_temp.id('org_b'), 'Retired Painters');
select pg_temp.as_platform();
update app.teams set deleted_at = now() - interval '8 years' where name in ('Retired Riggers', 'Retired Painters', 'Load-In Crew');
update app.teams set deleted_at = now() - interval '6 years' where name = 'Riggers';

select pg_temp.as_user('carol');
select throws_ok($$insert into app.legal_holds (org_id, table_name, matter) values (pg_temp.id('org_a'), 'app.teams', 'Crew dispute 2026-14.')$$,
  '42501', null, 'a manager cannot place a legal hold');
select pg_temp.as_user('bob');
select lives_ok($$insert into app.legal_holds (org_id, table_name, matter) values (pg_temp.id('org_a'), 'app.teams', 'Crew dispute 2026-14.')$$,
  'an admin places a legal hold on a table');
select throws_ok($$insert into app.legal_holds (org_id, table_name, matter) values (pg_temp.id('org_a'), 'app.not_a_table', 'Typo.')$$,
  'XR001', null, 'a hold names a table with a retention policy');
select throws_ok($$insert into app.legal_holds (org_id, matter) values (pg_temp.id('org_b'), 'Raid.')$$,
  '42501', null, 'an admin cannot place a hold on another org');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.legal_holds), 0, 'another org cannot see the hold');
select pg_temp.as_platform();

select ok(private.purge_table('app.teams') >= 1, 'the purge job deletes rows past retention');
select is((select count(*)::integer from app.teams where name = 'Retired Painters'), 0, 'an expired soft-deleted row is purged');
select is((select count(*)::integer from app.teams where name = 'Riggers'), 1, 'a soft-deleted row inside retention is kept');
select is((select count(*)::integer from app.teams where name = 'Retired Riggers'), 1, 'a legal hold suspends purge for the org');
select is((select count(*)::integer from app.teams where name in ('Load-In Crew')), 1, 'held org rows stay too');
select pg_temp.as_user('bob');
update app.legal_holds set released_at = now() where org_id = pg_temp.id('org_a');
select throws_ok($$update app.legal_holds set released_at = now() where org_id = pg_temp.id('org_a')$$, 'XR001', null,
  'a released hold stays released');
select throws_ok($$update app.legal_holds set matter = 'Edited.' where org_id = pg_temp.id('org_a')$$, 'XR001', null,
  'a hold is never edited');
select pg_temp.as_platform();
select ok(private.purge_table('app.teams') >= 1, 'after release the purge resumes');
select is((select count(*)::integer from app.teams where name = 'Retired Riggers'), 0, 'the released org''s expired row is purged');
select is((select count(*)::integer from app.teams where name = 'Load-In Crew'), 1, 'a row still referenced is kept');
select ok(
  (select error_message from private.retention_runs where table_name = 'app.teams' order by ran_at desc, id desc limit 1) like '1 expired rows kept:%',
  'a row that cannot be purged yet is counted and recorded, never silent');

-- Ledgers end at their retention ------------------------------------------------------------------------------
select throws_ok($$delete from app.subscription_state_transitions where org_id = pg_temp.id('org_b')$$, 'XR001', null,
  'an append-only ledger refuses deletes');
alter table app.subscription_state_transitions disable trigger t95_append_only;
alter table app.subscription_state_transitions disable trigger t90_stamp_audit_columns;
update app.subscription_state_transitions set created_at = now() - interval '8 years' where org_id = pg_temp.id('org_b');
alter table app.subscription_state_transitions enable trigger t95_append_only;
alter table app.subscription_state_transitions enable trigger t90_stamp_audit_columns;
select ok(private.purge_table('app.subscription_state_transitions') >= 1, 'the purge job removes ledger rows past retention');
select is((select count(*)::integer from app.subscription_state_transitions where org_id = pg_temp.id('org_b')), 0,
  'expired ledger rows are gone');
select ok((select count(*) from app.subscription_state_transitions where org_id = pg_temp.id('org_a')) > 0,
  'ledger rows inside retention remain');

-- Partition expiry with legal holds --------------------------------------------------------------------------------
select private.create_month_partition('app.audit_events', (now() - interval '8 years')::date);
alter table app.audit_events disable trigger t90_stamp_audit_columns;
insert into app.audit_events (org_id, actor_kind, action, subject_table, created_at) values
  (pg_temp.id('org_a'), 'System', 'test.old', 'app.teams', now() - interval '8 years'),
  (pg_temp.id('org_b'), 'System', 'test.old', 'app.teams', now() - interval '8 years');
alter table app.audit_events enable trigger t90_stamp_audit_columns;
select pg_temp.as_user('alice');
insert into app.legal_holds (org_id, table_name, matter) values (pg_temp.id('org_a'), 'app.audit_events', 'Regulator inquiry 7.');
select pg_temp.as_platform();
select is(private.expire_partitions('app.audit_events'), 1, 'an expired audit partition is detached');
select is((select count(*)::integer from app.audit_events where action = 'test.old'), 0, 'detached months leave the ledger');
select is((select count(*)::integer from private.held_partitions where parent_table = 'app.audit_events'), 1,
  'a partition with held rows is kept as a held partition');
select is(
  (select count(*)::integer from private.retention_runs where action = 'hold' and rows_affected = 1
     and table_name = private.partition_name('app.audit_events', date_trunc('month', now() - interval '8 years')::date)),
  1, 'only the held org''s rows are kept');
select pg_temp.as_user('alice');
update app.legal_holds set released_at = now() where table_name = 'app.audit_events';
select pg_temp.as_platform();
select private.run_partition_maintenance();
select is((select count(*)::integer from private.held_partitions), 0, 'after release the held partition is dropped');
select ok(to_regclass(private.partition_name('app.audit_events', date_trunc('month', now() - interval '8 years')::date)) is null,
  'the dropped partition no longer exists');

-- Redaction at every depth (invariant 23) ------------------------------------------------------------------------------
select is(
  private.redact_personal_data('{"email": "a@b.test", "count": 3, "nested": {"list": [{"full_name": "Ana Ruiz"}, "call +1 305 555 0100"]}, "note_ok": "Load-in at 08:00"}'::jsonb),
  '{"email": "[redacted]", "count": 3, "nested": {"list": [{"full_name": "[redacted]"}, "call [redacted]"]}, "note_ok": "Load-in at 08:00"}'::jsonb,
  'inv_23_audit_retention: personal data is redacted at every depth and other values are kept');
select is(
  private.redact_personal_data('{"a": {"b": {"c": {"d": "write to ana@harbor.test today"}}}, "when": "2026-10-14"}'::jsonb),
  '{"a": {"b": {"c": {"d": "write to [redacted] today"}}}, "when": "2026-10-14"}'::jsonb,
  'emails inside deep strings are redacted; dates are not phone numbers');
select is(private.redact_personal_data('{"phone": null}'::jsonb), '{"phone": null}'::jsonb, 'null stays null');

select private.create_month_partition('app.audit_events', (now() - interval '100 days')::date);
alter table app.audit_events disable trigger t90_stamp_audit_columns;
insert into app.audit_events (org_id, actor_kind, action, subject_table, diff, actor_ip, user_agent, created_at) values
  (pg_temp.id('org_a'), 'System', 'test.aged', 'app.teams',
   '{"new": {"name": "Riggers", "lead": {"email": "lead@northwind.test", "phones": ["(305) 555-0199"]}}}', '203.0.113.9', 'Test Agent', now() - interval '100 days'),
  (pg_temp.id('org_a'), 'System', 'test.fresh', 'app.teams', '{"new": {"email": "fresh@northwind.test"}}', '203.0.113.9', 'Test Agent', now());
alter table app.audit_events enable trigger t90_stamp_audit_columns;
select ok(private.redact_audit_events() >= 1, 'the redaction job redacts aged audit events');
select is((select diff from app.audit_events where action = 'test.aged'),
  '{"new": {"name": "Riggers", "lead": {"email": "[redacted]", "phones": ["[redacted]"]}}}'::jsonb,
  'inv_23_audit_retention: aged audit diffs lose personal data at every depth');
select ok((select actor_ip is null and user_agent is null and redacted_at is not null from app.audit_events where action = 'test.aged'),
  'aged audit events lose IP and user agent and record the redaction');
select is((select diff ->> 'new' from app.audit_events where action = 'test.fresh'), '{"email": "fresh@northwind.test"}',
  'inv_23_audit_retention: audit events younger than 90 days keep their diff');
select throws_ok($$update app.audit_events set diff = '{}' where action = 'test.fresh'$$, 'XR001', null,
  'inv_23_audit_retention: the audit ledger refuses updates outside redaction');
select throws_ok($$delete from app.audit_events where action = 'test.fresh'$$, 'XR001', null,
  'inv_23_audit_retention: the audit ledger refuses deletes');

select * from finish();
rollback;
