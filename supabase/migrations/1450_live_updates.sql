-- 1450_live_updates.sql
-- A88 (RRR-133, A65-006, ADR 0044). Live lists and records (Section 11.7): the tables behind the pages that now
-- update live join the supabase_realtime publication. Realtime checks every change against the subscriber's own
-- row level security, with the subscriber's JWT, so a change reaches only people who could read the row. Pages
-- subscribe narrowed to their org, project or record (`org_id=eq.<id>`), never to a whole table.
--
--   * app.records: Work collections, project Work and Schedule tabs, and the record page
--   * app.shifts: Crew > Shifts
--   * app.invoices: Finance > Invoices
--   * app.asset_units: Assets > Units
--   * app.sops: Knowledge > SOPs and the SOP page
--
-- Show mode already follows app.cues (0412). Only these tables are added; every other page keeps reading on
-- navigation, as before.

do $$
declare
  v_table record;
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  for v_table in
    select t.table_name from (values ('records'), ('shifts'), ('invoices'), ('asset_units'), ('sops')) as t (table_name)
  loop
    if not exists (
      select 1 from pg_catalog.pg_publication_tables p
      where p.pubname = 'supabase_realtime' and p.schemaname = 'app' and p.tablename = v_table.table_name
    ) then
      execute format('alter publication supabase_realtime add table app.%I', v_table.table_name);
    end if;
  end loop;
end;
$$;
