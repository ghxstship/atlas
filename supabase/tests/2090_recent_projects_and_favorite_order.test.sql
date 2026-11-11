-- pgTAP: recent projects and the order of favorites (A113, RRR-158, finding A65-024, Section 4.5.2, Section 11.7).
-- Opening a project is recorded only when the person can read it; app.recent_projects lists the person's own, newest
-- first; projects never push records out of the command menu's last 50; app.reorder_favorites changes only the
-- caller's own favorites, in the order given.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(27);

create temporary table s (key text primary key, id uuid);
grant select, insert, update on s to public;

select is((select prosecdef from pg_proc where oid = 'app.recent_projects(uuid, integer)'::regprocedure), false,
  'app.recent_projects is SECURITY INVOKER: it reads with the caller''s own row level security');
select is((select prosecdef from pg_proc where oid = 'app.reorder_favorites(uuid, uuid[])'::regprocedure), false,
  'app.reorder_favorites is SECURITY INVOKER: the owner policies of app.favorites decide every row');
select is(has_function_privilege('anon', 'app.recent_projects(uuid, integer)', 'execute'), false,
  'signed-out visitors cannot list recent projects');
select is(has_function_privilege('anon', 'app.reorder_favorites(uuid, uuid[])', 'execute'), false,
  'signed-out visitors cannot reorder favorites');

-- Recent projects -----------------------------------------------------------------------------------------------------
-- dave is a member of NWL only; NWX has no members, and HLP belongs to Harbor Lights.
select pg_temp.as_user('dave');
select is((select count(*)::integer from app.projects where id = pg_temp.id('prj_a2')), 0,
  'dave cannot read Northwind Winter Gala');
select is(app.record_recent_view(pg_temp.id('org_a'), 'projects', pg_temp.id('prj_a')), true,
  'opening a project the person can read is recorded');
select is(app.record_recent_view(pg_temp.id('org_a'), 'projects', pg_temp.id('prj_a2')), false,
  'a project the person cannot read is not recorded');
select is(app.record_recent_view(pg_temp.id('org_a'), 'projects', pg_temp.id('prj_b')), false,
  'a project of another org is not recorded');
select is((select string_agg(r.project_key || ' ' || r.name, ', ') from app.recent_projects(pg_temp.id('org_a')) r),
  'NWL Northwind Summer Series', 'recent projects list what the person opened, with key and name');
select is((select count(*)::integer from app.recent_items(pg_temp.id('org_a'))), 0,
  'a project is not one of the command menu''s recent items');
select pg_temp.as_user('erin');
select is((select count(*)::integer from app.recent_projects(pg_temp.id('org_a'))), 0,
  'nobody lists another person''s recent projects');

-- alice, the owner, reads every project of Northwind Live.
select pg_temp.as_user('alice');
select app.record_recent_view(pg_temp.id('org_a'), 'projects', pg_temp.id('prj_a'));
select app.record_recent_view(pg_temp.id('org_a'), 'projects', pg_temp.id('prj_a2'));
select is((select string_agg(r.project_key, ',' order by r.viewed_at desc) from app.recent_projects(pg_temp.id('org_a')) r),
  'NWX,NWL', 'newest first');
select app.record_recent_view(pg_temp.id('org_a'), 'projects', pg_temp.id('prj_a'));
select is((select string_agg(r.project_key, ',' order by r.viewed_at desc) from app.recent_projects(pg_temp.id('org_a')) r),
  'NWL,NWX', 'opening a project again moves it to the top');
select is((select count(*)::integer from app.recent_views where subject_table = 'projects'), 2,
  'one row per project opened');
select is((select string_agg(r.project_key, ',') from app.recent_projects(pg_temp.id('org_a'), 1) r), 'NWL',
  'the list stops at the limit asked for');

-- Opening 52 records keeps the last 50 of them and every project.
insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  select pg_temp.id('prj_a'), 'Task', 'Walk the load-in route ' || n, 'Y', 'Declared' from generate_series(1, 52) n;
select count(app.record_recent_view(pg_temp.id('org_a'), 'records', r.id)) from app.records r where r.title like 'Walk the load-in route %';
select is((select count(*)::integer from app.recent_views where subject_table = 'records'), 50,
  'the command menu still keeps the last 50 records');
select is((select count(*)::integer from app.recent_projects(pg_temp.id('org_a'))), 2,
  'opening records never pushes a project out');

select pg_temp.as_platform();
update app.projects set deleted_at = now() where id = pg_temp.id('prj_a2');
select pg_temp.as_user('alice');
select is((select string_agg(r.project_key, ',') from app.recent_projects(pg_temp.id('org_a')) r), 'NWL',
  'a deleted project drops out');
select throws_ok($$insert into app.recent_views (org_id, person_id, subject_table, subject_id)
  values (pg_temp.id('org_a'), pg_temp.id('alice'), 'people', pg_temp.id('dave'))$$,
  '23514', null, 'only the listed tables can be recent views');

-- Favorite order --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.favorites (org_id, person_id, node_id, sort_order)
  values (pg_temp.id('org_a'), pg_temp.id('carol'), 'schedule', 0) returning id)
  insert into s select 'carol_schedule', id from x;
select pg_temp.as_user('dave');
with x as (insert into app.favorites (org_id, person_id, node_id, sort_order)
  values (pg_temp.id('org_a'), pg_temp.id('dave'), 'finance.budgets', 0) returning id)
  insert into s select 'budgets', id from x;
with x as (insert into app.favorites (org_id, person_id, node_id, sort_order)
  values (pg_temp.id('org_a'), pg_temp.id('dave'), 'schedule', 1) returning id)
  insert into s select 'schedule', id from x;
with x as (insert into app.favorites (org_id, person_id, node_id, sort_order)
  values (pg_temp.id('org_a'), pg_temp.id('dave'), 'work', 2) returning id)
  insert into s select 'work', id from x;

create function pg_temp.order_of_daves() returns text
language sql as $$
  select string_agg(f.node_id || ':' || f.sort_order, ', ' order by f.sort_order)
  from app.favorites f where f.person_id = pg_temp.id('dave') and f.deleted_at is null
$$;

select is(app.reorder_favorites(pg_temp.id('org_a'), array[(select id from s where key = 'work'),
  (select id from s where key = 'budgets'), (select id from s where key = 'schedule')]), 3,
  'a person reorders their three favorites');
select is(pg_temp.order_of_daves(), 'work:0, finance.budgets:1, schedule:2', 'each takes its place from the list');

select is(app.reorder_favorites(pg_temp.id('org_a'), array[(select id from s where key = 'carol_schedule'),
  (select id from s where key = 'schedule'), (select id from s where key = 'work'), (select id from s where key = 'budgets')]), 3,
  'naming someone else''s favorite changes only the caller''s own');
select is(pg_temp.order_of_daves(), 'schedule:0, work:1, finance.budgets:2', 'and the caller''s own still follow the list');
select pg_temp.as_platform();
select is((select sort_order from app.favorites where id = (select id from s where key = 'carol_schedule')), 0,
  'carol''s favorite keeps its place');

select pg_temp.as_user('dave');
select app.reorder_favorites(pg_temp.id('org_a'), array[(select id from s where key = 'budgets')]);
select is(pg_temp.order_of_daves(), 'finance.budgets:0, schedule:1, work:2',
  'favorites left out of the list follow in their current order');

select throws_ok($$select app.reorder_favorites(pg_temp.id('org_a'), array[(select id from s where key = 'work'), (select id from s where key = 'work')])$$,
  'XR001', 'favorites_order: Send the favorites as a list of at most 50 ids, each once.', 'an id appears once');
select throws_ok($$select app.reorder_favorites(pg_temp.id('org_a'), array(select gen_random_uuid() from generate_series(1, 51)))$$,
  'XR001', null, 'a list holds at most 50 ids');

select * from finish();
rollback;
