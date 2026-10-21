-- pgTAP: personal sidebar layout (A81, RRR-126, Section 4.5.2). A person hides and reorders the groups and items of an
-- org's sidebar; the layout is theirs alone and per org; saving replaces it; Reset to role default removes it; only
-- members of the org keep one there; malformed layouts are refused.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(19);

select has_table('app', 'sidebar_item_preferences', 'app.sidebar_item_preferences exists');
select is((select relrowsecurity from pg_class where oid = 'app.sidebar_item_preferences'::regclass), true,
  'row level security is on');
select is(
  (select count(*)::int from pg_attribute a where a.attrelid = 'app.sidebar_item_preferences'::regclass and a.attnum > 0
     and not a.attisdropped and col_description(a.attrelid, a.attnum) is null),
  0, 'every column carries a comment');
select is((select count(*)::int from private.retention_policies where table_name = 'app.sidebar_item_preferences'), 1,
  'a reset layout has a retention policy');

-- carol, a manager of Northwind Live, moves Finance above Production and hides Show.
select pg_temp.as_user('carol');
select is(app.save_sidebar_layout(pg_temp.id('org_a'),
  '[{"node": "group.commercial"}, {"node": "group.production"}, {"node": "show", "hidden": true}, {"node": "schedule"}]'::jsonb),
  4, 'a member saves a layout of four nodes');
select is((select string_agg(node_id || ':' || sort_order || ':' || hidden, ', ' order by sort_order)
  from app.sidebar_item_preferences where deleted_at is null),
  'group.commercial:0:false, group.production:1:false, show:2:true, schedule:3:false',
  'each node takes its position from the list and keeps whether it is hidden');

select is(app.save_sidebar_layout(pg_temp.id('org_a'),
  '[{"node": "group.production"}, {"node": "show", "hidden": false}]'::jsonb),
  2, 'saving again replaces the layout');
select is((select string_agg(node_id || ':' || sort_order || ':' || hidden, ', ' order by sort_order)
  from app.sidebar_item_preferences where deleted_at is null),
  'group.production:0:false, show:1:false', 'nodes left out return to the role default');
select is((select count(*)::int from app.sidebar_item_preferences where deleted_at is null), 2,
  'one live row per node');

-- Refusals.
select throws_ok($$select app.save_sidebar_layout(pg_temp.id('org_a'), '{"node": "show"}'::jsonb)$$,
  'XR001', 'sidebar_layout_items: Send the sidebar as a list of at most 200 items.', 'a layout is a list');
select throws_ok($$select app.save_sidebar_layout(pg_temp.id('org_a'), '[{"node": "show"}, {"node": "show"}]'::jsonb)$$,
  'XR001', 'sidebar_layout_items: Each sidebar item names its node once, with hidden true or false.',
  'a node appears once');
select throws_ok($$select app.save_sidebar_layout(pg_temp.id('org_a'), '[{"node": "show", "hidden": "yes"}]'::jsonb)$$,
  'XR001', null, 'hidden is true or false');
select throws_ok($$select app.save_sidebar_layout(pg_temp.id('org_a'), '[{"node": "Not A Node"}]'::jsonb)$$,
  '23514', null, 'a node outside the sitemap shape is refused');
select throws_ok($$update app.sidebar_item_preferences set node_id = 'finance' where node_id = 'show'$$,
  'XR001', null, 'a row never moves to another node');

-- Private to the person, and only in orgs they belong to.
select pg_temp.as_user('alice');
select is((select count(*)::int from app.sidebar_item_preferences), 0, 'the owner reads none of carol''s layout');
select pg_temp.as_user('carol');
select throws_ok($$select app.save_sidebar_layout(pg_temp.id('org_b'), '[{"node": "finance"}]'::jsonb)$$,
  '42501', null, 'nobody keeps a layout in an org they do not belong to');
select pg_temp.as_user('mia');
select is(app.save_sidebar_layout(pg_temp.id('org_b'), '[{"node": "finance", "hidden": true}]'::jsonb), 1,
  'a person in two orgs keeps a layout in each');

-- Reset to role default.
select pg_temp.as_user('carol');
select is(app.reset_sidebar_layout(pg_temp.id('org_a')), 2, 'Reset to role default removes every row');
select is((select count(*)::int from app.sidebar_item_preferences where deleted_at is null), 0,
  'and the role default applies again');

select * from finish();
rollback;
