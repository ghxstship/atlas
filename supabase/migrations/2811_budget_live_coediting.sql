-- 2811_budget_live_coediting.sql
-- P4 (RRR-218, gap G-216; Section 11.7). Live co-editing of a budget: a description, quantity or price saved by one
-- person appears in the grid of everyone else on the budget without a reload, and the grid shows who else is there and
-- which line they are editing.
--
--   * app.budgets and app.budget_lines join the supabase_realtime publication with 2170's guarded loop. Deletes are
--     soft (updates), and Realtime checks every change against the subscriber's own read policy, so a change reaches
--     only people who can read the budget. The budget page narrows its subscription to the budget it shows.
--   * app.budgets joins private.presence_subjects, so a budget's grid joins the private channel presence:budgets:<id>.
--     2170's join rule (private.presence_can_join) and its two realtime.messages policies are reused unchanged: only
--     readers of the budget may join, and broadcasts stay refused. Presence is ephemeral and never stored.
--   * Saves stay compare-and-set on updated_at (Section 11.7): a live grid takes others' values for lines nobody has
--     open, and a save against an older version still opens the conflict dialog.

do $$
declare
  v_table record;
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  for v_table in
    select t.table_name from (values ('budgets'), ('budget_lines')) as t (table_name)
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

insert into private.presence_subjects (table_name) values ('app.budgets') on conflict do nothing;
