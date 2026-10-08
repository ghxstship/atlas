-- 0199_xpms_privileges.sql
-- A01 Canon. Last migration of the 0100 range: canon is read-only to tenants
-- (Section 7.2). Authenticated users may select; nobody but the importer (the
-- migration owner) and service_role writes. anon has no usage on xpms (0001).
-- Row level security is enabled on every xpms table as defense in depth, with a
-- read policy for authenticated users. The Production Template tables are the
-- exception: they hold real-world rows and stay private (no tenant read) until
-- the owner approves publishing them (Section 2.1, a Section 19.8 stop condition).

do $$
declare
  t record;
  private_tables constant text[] := array[
    'production_template', 'production_template_rows', 'production_template_values', 'production_template_metadata'
  ];
begin
  for t in
    select c.relname
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'xpms' and c.relkind = 'r'
  loop
    execute format('revoke all on table xpms.%I from public, anon, authenticated', t.relname);
    execute format('grant all on table xpms.%I to service_role', t.relname);
    execute format('alter table xpms.%I enable row level security', t.relname);
    if not (t.relname = any (private_tables)) then
      execute format('grant select on table xpms.%I to authenticated', t.relname);
      execute format(
        'create policy %I on xpms.%I for select to authenticated using (true)',
        t.relname || '_canon_read', t.relname
      );
    end if;
  end loop;

  for t in
    select c.relname
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'xpms' and c.relkind = 'v'
  loop
    execute format('revoke all on table xpms.%I from public, anon, authenticated', t.relname);
    execute format('grant select on table xpms.%I to authenticated, service_role', t.relname);
  end loop;
end;
$$;

-- Functions: callable by authenticated users and service_role, never by anon.
revoke all on all functions in schema xpms from public, anon;
grant execute on all functions in schema xpms to authenticated, service_role;
