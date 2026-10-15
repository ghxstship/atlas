-- 0930_retention_sweep.sql
-- Orchestrator. Every app table must have a retention policy (ADR 0002, Section 14.3). Migration 0501
-- swept the tables that existed then. Module ranges (04xx) run before 0501 on a fresh reset, but
-- after it on databases that were already migrated. This sweep runs here, after every main range, and
-- nightly, so no table is ever missed whatever order its migration was applied in. A table whose
-- range already inserted its own row keeps it.

create or replace function private.sweep_default_retention()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table regclass;
  v_count integer := 0;
begin
  for v_table in
    select c.oid::regclass
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relkind in ('r', 'p') and not c.relispartition
      and format('app.%s', c.relname) not in (select r.table_name from private.retention_policies r)
      and (
        exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = c.oid and t.tgname = 't95_append_only')
        or exists (select 1 from pg_catalog.pg_attribute a
                   where a.attrelid = c.oid and a.attname = 'deleted_at' and not a.attisdropped)
      )
  loop
    call private.install_default_retention(v_table);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function private.sweep_default_retention() is 'Gives every app ledger and soft-deletable table without a retention policy the default policy (ADR 0002). Runs once here and nightly before the retention job, and returns how many policies it added.';

revoke all on function private.sweep_default_retention() from public, anon, authenticated;

select private.sweep_default_retention();

select cron.schedule('xos_nightly_retention_sweep', '7 3 * * *', 'select private.sweep_default_retention()');
