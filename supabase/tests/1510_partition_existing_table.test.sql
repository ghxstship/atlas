-- pgTAP: migration 1510, private.partition_existing_table and the id guard (A94, RRR-139, finding A65-032, Section 5.1).
-- A probe table with rows in two months, a comment, a policy, a grant, a view and a referencing table is converted:
-- everything it had comes back on the partitioned table, the referencing key becomes composite, and the converted
-- table still refuses a reused id (23505) and a reference to no row (23503) as the plain table did. Tables the
-- procedure cannot convert faithfully are refused.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(30);

-- Who may call it -------------------------------------------------------------------------------------------------
select is((select prokind::text from pg_proc
           where oid = 'private.partition_existing_table(regclass,text,smallint,integer)'::regprocedure), 'p',
  'the conversion is a procedure');
select ok(not has_function_privilege('authenticated', 'private.partition_existing_table(regclass,text,smallint,integer)', 'execute'),
  'signed-in people cannot convert a table');
select ok(not has_function_privilege('anon', 'private.partition_existing_table(regclass,text,smallint,integer)', 'execute'),
  'anon cannot convert a table');
select ok(not has_function_privilege('authenticated', 'private.guard_partitioned_id()', 'execute'),
  'the id guard runs only as a trigger');
select isnt(obj_description('private.guard_partitioned_id()'::regprocedure, 'pg_proc'), null, 'the id guard is described');

-- What it refuses -------------------------------------------------------------------------------------------------
create table app.a94_probe (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  maybe_at timestamptz,
  code text,
  note text
);
create table app.a94_child (
  id uuid primary key default gen_random_uuid(),
  probe_id uuid references app.a94_probe (id) on delete cascade
);
select throws_ok($$call private.partition_existing_table('private.partitioned_tables', 'created_at', 3::smallint, 99)$$,
  'XR001', null, 'only app tables are converted');
select throws_ok($$call private.partition_existing_table('app.audit_events', 'created_at', 3::smallint, 99)$$,
  'XR001', null, 'a table that is already partitioned is refused');
select throws_ok($$call private.partition_existing_table('app.a94_probe', 'maybe_at', 3::smallint, 99)$$,
  'XR001', null, 'the partition column must be a not null timestamptz');
create unique index a94_probe_code_key on app.a94_probe (code);
select throws_ok($$call private.partition_existing_table('app.a94_probe', 'created_at', 3::smallint, 99)$$,
  'XR001', null, 'a unique index without the partition column is refused, since it could not hold');
drop index app.a94_probe_code_key;
select throws_ok($$call private.partition_existing_table('app.a94_probe', 'created_at', 3::smallint, 99)$$,
  'XR001', 'partition_existing_table: app.a94_probe has an incoming foreign key with an action or deferral',
  'an incoming foreign key with an action is refused rather than recreated without it');
alter table app.a94_child drop constraint a94_child_probe_id_fkey;
alter table app.a94_child add constraint a94_child_probe_id_fkey foreign key (probe_id) references app.a94_probe (id);

-- The conversion ---------------------------------------------------------------------------------------------------
comment on table app.a94_probe is 'Probe table for pgTAP 1510.';
comment on column app.a94_probe.note is 'A note.';
alter table app.a94_probe enable row level security;
create policy a94_probe_read on app.a94_probe for select to authenticated using (note is not null);
grant select on app.a94_probe to authenticated;
create view app.a94_probe_notes with (security_invoker = true) as select id, note from app.a94_probe;
comment on view app.a94_probe_notes is 'Probe view for pgTAP 1510.';
grant select on app.a94_probe_notes to authenticated;
insert into app.a94_probe (id, created_at, note) values
  ('00000000-0000-7000-8000-000000000001', now() - interval '40 days', 'older month'),
  ('00000000-0000-7000-8000-000000000002', now(), 'this month');
insert into app.a94_child (probe_id) values ('00000000-0000-7000-8000-000000000001');

select lives_ok($$call private.partition_existing_table('app.a94_probe', 'created_at', 2::smallint, 99)$$,
  'a plain table converts in one call');
select is((select relkind::text from pg_class where oid = 'app.a94_probe'::regclass), 'p', 'the table is partitioned');
select is(pg_get_partkeydef('app.a94_probe'::regclass), 'RANGE (created_at)', 'by range on the partition column');
select is((select count(*)::integer from app.a94_probe), 2, 'every row is copied');
select is((select count(distinct tableoid)::integer from app.a94_probe), 2, 'rows of two months sit in two partitions');
select col_is_pk('app', 'a94_probe', array['id', 'created_at'], 'the primary key is widened to the partition key');
select is(obj_description('app.a94_probe'::regclass, 'pg_class'), 'Probe table for pgTAP 1510.', 'the table comment is kept');
select is(col_description('app.a94_probe'::regclass,
  (select attnum from pg_attribute where attrelid = 'app.a94_probe'::regclass and attname = 'note')), 'A note.',
  'column comments are kept');
select policies_are('app', 'a94_probe', array['a94_probe_read'], 'policies are kept');
select table_privs_are('app', 'a94_probe', 'authenticated', array['SELECT'], 'grants are kept');
select ok(has_table_privilege('authenticated', 'app.a94_probe_notes', 'select')
          and obj_description('app.a94_probe_notes'::regclass, 'pg_class') = 'Probe view for pgTAP 1510.',
  'a view over the table is recreated with its comment and grants');
select is((select maintenance_order from private.partitioned_tables where table_name = 'app.a94_probe'), 99::smallint,
  'the table is registered with the nightly partition maintenance');
select hasnt_table('app', 'a94_probe_unpartitioned', 'the old table is gone');

-- Referencing tables ------------------------------------------------------------------------------------------------
select is((select pg_get_constraintdef(c.oid) from pg_constraint c
           where c.conrelid = 'app.a94_child'::regclass and c.conname = 'a94_child_probe_id_fkey' and c.conparentid = 0),
  'FOREIGN KEY (probe_id, probe_created_at) REFERENCES app.a94_probe(id, created_at)',
  'an incoming foreign key becomes composite, under its old name');
select is((select probe_created_at from app.a94_child),
  (select created_at from app.a94_probe where id = '00000000-0000-7000-8000-000000000001'),
  'existing references are backfilled');
insert into app.a94_child (probe_id) values ('00000000-0000-7000-8000-000000000002');
select is((select count(*)::integer from app.a94_child where probe_created_at is not null), 2,
  'a new reference fills the partition key itself');
select throws_ok($$insert into app.a94_child (probe_id) values ('00000000-0000-7000-8000-0000000000ff')$$,
  '23503', 'insert or update on table "a94_child" violates foreign key constraint "a94_child_probe_id_fkey"',
  'a reference to no row is refused, as by the old foreign key');

-- One row per id -----------------------------------------------------------------------------------------------------
select throws_ok($$insert into app.a94_probe (id, note) values ('00000000-0000-7000-8000-000000000001', 'again')$$,
  '23505', 'duplicate key value violates unique constraint "a94_probe_pkey"',
  'an id stays unique across partitions, as under the old key');
select lives_ok($$update app.a94_probe set note = 'edited' where id = '00000000-0000-7000-8000-000000000001'$$,
  'an update that keeps the id passes the guard');
select throws_ok($$update app.a94_probe set id = '00000000-0000-7000-8000-000000000002' where id = '00000000-0000-7000-8000-000000000001'$$,
  '23505', null, 'an update to a taken id is refused');

select * from finish();
rollback;
