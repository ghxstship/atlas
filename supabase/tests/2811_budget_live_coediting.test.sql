-- pgTAP: 2811, live co-editing of a budget (P4, RRR-218, gap G-216). app.budgets and app.budget_lines stream their
-- changes through the Realtime publication, and a budget's presence channel presence:budgets:<id> admits only people
-- who can read the budget (2170's join rule, unchanged).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(9);

select pg_temp.as_user('carol');
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Summer Series Budget', 'USD') returning id)
  insert into world select 'bud', id from x;
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a2'), 'Winter Gala Budget', 'USD') returning id)
  insert into world select 'bud_gala', id from x;
select pg_temp.as_platform();

-- Live updates -----------------------------------------------------------------------------------------------------------
create function pg_temp.published() returns setof text
language plpgsql as $$
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    return next skip('This database has no supabase_realtime publication', 1);
    return;
  end if;
  return next is(
    (select count(*)::int from pg_catalog.pg_publication_tables p
     where p.pubname = 'supabase_realtime' and p.schemaname = 'app' and p.tablename in ('budgets', 'budget_lines')),
    2, 'budgets and their lines stream their changes');
end $$;
select * from pg_temp.published();

select ok((select relrowsecurity from pg_class where oid = 'app.budget_lines'::regclass)
  and exists (select 1 from pg_policy where polrelid = 'app.budget_lines'::regclass and polcmd in ('r', '*')),
  'budget lines keep row level security and a read policy, so a change reaches only readers of the budget');

-- Presence ---------------------------------------------------------------------------------------------------------------
select ok(exists (select 1 from private.presence_subjects where table_name = 'app.budgets'),
  'private.presence_subjects lists app.budgets');

create temporary table topic (key text, value text);
grant all on topic to public;
insert into topic values
  ('bud', 'presence:budgets:' || pg_temp.id('bud')),
  ('gala', 'presence:budgets:' || pg_temp.id('bud_gala')),
  ('lines', 'presence:budget_lines:' || pg_temp.id('bud'));
create function pg_temp.topic(p_key text) returns text language sql as $$ select value from topic where key = p_key $$;

select pg_temp.claims('dave');
select ok(private.presence_can_join(pg_temp.topic('bud')), 'a Member of the project, who reads its budget, joins the budget''s channel');
select ok(not private.presence_can_join(pg_temp.topic('gala')), 'but not the channel of a budget in a project they are not in');
select ok(not private.presence_can_join(pg_temp.topic('lines')), 'nor a channel of budget lines, which show no presence of their own');
select ok(not private.presence_can_join('presence:budgets:not-a-uuid'), 'and a malformed topic answers false');
select pg_temp.claims('gina');
select ok(not private.presence_can_join(pg_temp.topic('bud')), 'a Viewer in no project may not join');
select pg_temp.claims('xavier');
select ok(not private.presence_can_join(pg_temp.topic('bud')), 'nor may another org''s owner');
select pg_temp.as_platform();

select * from finish();
rollback;
