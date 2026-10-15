-- pgTAP: every app ledger and soft-deletable table has a retention policy (0930).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(4);

select is(
  (select count(*)::integer
   from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'app' and c.relkind in ('r', 'p') and not c.relispartition
     and format('app.%s', c.relname) not in (select table_name from private.retention_policies)
     and (exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = c.oid and t.tgname = 't95_append_only')
       or exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attname = 'deleted_at' and not a.attisdropped))),
  0,
  'every app ledger and soft-deletable table has a retention policy'
);

create table app.retention_sweep_probe (id uuid primary key, deleted_at timestamptz);
select is(private.sweep_default_retention(), 1, 'the sweep adds a policy for a new soft-deletable table');
select is(
  (select basis::text from private.retention_policies where table_name = 'app.retention_sweep_probe'),
  'Soft Deleted',
  'a soft-deletable table is kept by soft delete'
);
select ok(
  exists (select 1 from cron.job where jobname = 'xos_nightly_retention_sweep'),
  'the sweep is scheduled nightly'
);

select * from finish();
rollback;
