-- pgTAP: migration 2900 (B1, RRR-225; ADR 0140 D1 and D2). Site plan states move only along the lifecycle graph through
-- app.transition_site_plan, with a ledger; a plan with no drawing is never Locked or Live; a project has one Live plan per
-- venue and level; a plan deleted before 2900 stays in Trash as a Draft; levels belong to one venue and reorder in one call.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 2900_places_world.psql

select * from no_plan();

-- Initial state and ledger ------------------------------------------------------------------------------------------------
select is((select plan_state::text from app.site_plans where id = pg_temp.id('plan_a')), 'Draft', 'a new plan starts as Draft');
select is((select string_agg(coalesce(from_state::text, '-') || '>' || to_state || ' ' || reason, ',') from app.site_plan_state_transitions
  where site_plan_id = pg_temp.id('plan_a')), '->Draft Created.', 'and its ledger starts with the creation entry');
select pg_temp.as_user('dave');
select throws_ok($$insert into app.site_plans (project_id, title, image_uri, plan_state) values (pg_temp.id('prj_a'), 'Sneaky', 'attachments/pending', 'Live')$$,
  'XR001', null, 'a plan cannot be created in another state');
select throws_ok($$update app.site_plans set plan_state = 'Locked' where id = pg_temp.id('plan_a')$$, 'XR001', null,
  'the state changes only through app.transition_site_plan');

-- A plan with no drawing ----------------------------------------------------------------------------------------------------
select throws_ok($$select app.transition_site_plan(pg_temp.id('plan_a'), 'Draft', 'Locked', 'Layout done.')$$, 'XR001',
  'site_plan_no_drawing: Use a drawing on the plan before you lock it or make it live.', 'a plan waiting for its drawing cannot be locked');

-- The graph (a legacy plan with a web image has a drawing to show) ------------------------------------------------------------
select pg_temp.as_platform();
update app.site_plans set image_uri = 'https://example.test/ground.png' where id = pg_temp.id('plan_a');
select pg_temp.as_user('dave');
select throws_ok($$select app.transition_site_plan(pg_temp.id('plan_a'), 'Draft', 'Live', 'Skip ahead.')$$, 'XR001', null, 'Draft cannot go straight to Live');
select throws_ok($$select app.transition_site_plan(pg_temp.id('plan_a'), 'Draft', 'Locked', '')$$, 'XR001', null, 'every move carries a reason');
select lives_ok($$select app.transition_site_plan(pg_temp.id('plan_a'), 'Draft', 'Locked', 'Layout done.')$$, 'Draft to Locked');
select throws_ok($$select app.transition_site_plan(pg_temp.id('plan_a'), 'Draft', 'Locked', 'Again.')$$, 'XR001', null, 'compare-and-set on the expected state');
select lives_ok($$select app.transition_site_plan(pg_temp.id('plan_a'), 'Locked', 'Draft', 'One more pin.')$$, 'Locked to Draft');
select lives_ok($$select app.transition_site_plan(pg_temp.id('plan_a'), 'Draft', 'Locked', 'Done now.')$$, 'Draft to Locked again');
select lives_ok($$select app.transition_site_plan(pg_temp.id('plan_a'), 'Locked', 'Live', 'Crews use this.')$$, 'Locked to Live');
select throws_ok($$select app.transition_site_plan(pg_temp.id('plan_a'), 'Live', 'Draft', 'Back.')$$, 'XR001', null, 'Live cannot go straight to Draft');
select lives_ok($$select app.transition_site_plan(pg_temp.id('plan_a'), 'Live', 'Locked', 'Fix a pin.')$$, 'Live to Locked');
select lives_ok($$select app.transition_site_plan(pg_temp.id('plan_a'), 'Locked', 'Archived', 'Retired.')$$, 'Locked to Archived');
select throws_ok($$select app.transition_site_plan(pg_temp.id('plan_a'), 'Archived', 'Locked', 'Back.')$$, 'XR001', null, 'Archived reopens only as Draft');
select lives_ok($$select app.transition_site_plan(pg_temp.id('plan_a'), 'Archived', 'Draft', 'Next season.')$$, 'Archived to Draft');
select lives_ok($$select app.transition_site_plan(pg_temp.id('plan_a'), 'Draft', 'Archived', 'Not needed.')$$, 'Draft to Archived');
select lives_ok($$select app.transition_site_plan(pg_temp.id('plan_a'), 'Archived', 'Draft', 'Needed.')$$, 'and back');
select lives_ok($$select app.transition_site_plan(pg_temp.id('plan_a'), 'Draft', 'Locked', 'Locked.')$$, 'locked');
select lives_ok($$select app.transition_site_plan(pg_temp.id('plan_a'), 'Locked', 'Live', 'Live.')$$, 'live');
select lives_ok($$select app.transition_site_plan(pg_temp.id('plan_a'), 'Live', 'Archived', 'Show over.')$$, 'Live to Archived');
select is((select count(*)::int from app.site_plan_state_transitions where site_plan_id = pg_temp.id('plan_a')), 13,
  'every move wrote one ledger row after the creation entry');
select is((select reason from app.site_plan_state_transitions where site_plan_id = pg_temp.id('plan_a') order by created_at desc, id desc limit 1),
  'Show over.', 'with its reason');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'site_plan.state_changed' and subject_id = pg_temp.id('plan_a')), 12,
  'each move emits site_plan.state_changed');
select pg_temp.as_user('dave');
select throws_ok($$update app.site_plan_state_transitions set reason = 'x' where site_plan_id = pg_temp.id('plan_a')$$, null, null,
  'the ledger is append-only');

-- Capability ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok($$select app.transition_site_plan(pg_temp.id('plan_a'), 'Archived', 'Draft', 'Viewer.')$$, '42501', null, 'a Viewer cannot change the state');
select ok((select count(*) from app.site_plan_state_transitions where site_plan_id = pg_temp.id('plan_a')) > 0, 'but reads the ledger');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.site_plan_state_transitions where site_plan_id = pg_temp.id('plan_a')), 0, 'another org reads none of it');

-- One Live plan per project, venue and level -----------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select app.transition_site_plan(pg_temp.id('plan_a'), 'Archived', 'Draft', 'Again.');
select app.transition_site_plan(pg_temp.id('plan_a'), 'Draft', 'Locked', 'Locked.');
select app.transition_site_plan(pg_temp.id('plan_a'), 'Locked', 'Live', 'Live.');
with x as (insert into app.site_plans (project_id, venue_id, title, image_uri) values (pg_temp.id('prj_a'), pg_temp.id('venue_a'), 'Ground floor v2', 'https://example.test/v2.png') returning id) insert into world select 'plan_c', id from x;
select app.transition_site_plan(pg_temp.id('plan_c'), 'Draft', 'Locked', 'Locked.');
select throws_ok($$select app.transition_site_plan(pg_temp.id('plan_c'), 'Locked', 'Live', 'Live.')$$, 'XR001',
  'site_plan_live_exists: Another plan of this project, venue and level is live. Move it back to Locked first.',
  'a second Live plan of the same project, venue and level is refused');
with x as (insert into app.site_plans (project_id, title, image_uri) values (pg_temp.id('prj_a'), 'Parking (no venue)', 'https://example.test/p.png') returning id) insert into world select 'plan_d', id from x;
select app.transition_site_plan(pg_temp.id('plan_d'), 'Draft', 'Locked', 'Locked.');
select lives_ok($$select app.transition_site_plan(pg_temp.id('plan_d'), 'Locked', 'Live', 'Live.')$$, 'a plan of another venue (none) may be live too');
-- A Live plan moved to Trash and restored while another is Live hits the index.
select app.transition_site_plan(pg_temp.id('plan_a'), 'Live', 'Locked', 'Swap.');
select app.transition_site_plan(pg_temp.id('plan_c'), 'Locked', 'Live', 'Swap.');
select app.transition_site_plan(pg_temp.id('plan_c'), 'Live', 'Locked', 'Hold.');
select app.transition_site_plan(pg_temp.id('plan_a'), 'Locked', 'Live', 'Back.');
update app.site_plans set deleted_at = now() where id = pg_temp.id('plan_a');
select app.transition_site_plan(pg_temp.id('plan_c'), 'Locked', 'Live', 'Now c.');
select throws_ok($$update app.site_plans set deleted_at = null where id = pg_temp.id('plan_a')$$, '23505', null,
  'restoring a Live plan while another is Live is refused by the one-live index');

-- A plan deleted before 2900 stays in Trash as a Draft (ADR 0140 D2) ------------------------------------------------------------
select pg_temp.as_platform();
select is((select column_default from information_schema.columns where table_schema = 'app' and table_name = 'site_plans' and column_name = 'plan_state'),
  '''Draft''::app.site_plan_state', 'existing plans took Draft from the column default');
-- A plan "archived" on 4.0 was a plan with deleted_at set; 2900 leaves it so.
with x as (insert into app.site_plans (org_id, project_id, title, image_uri, deleted_at)
  values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Archived on 4.0', 'https://example.test/old.png', now() - interval '30 days') returning id) insert into world select 'plan_old', id from x;
select ok(exists (select 1 from app.trash_items where subject_table = 'site_plans' and subject_id = pg_temp.id('plan_old')),
  'a plan deleted before 2900 is in Trash');
select is((select plan_state::text from app.site_plans where id = pg_temp.id('plan_old')), 'Draft', 'as a Draft');
select pg_temp.as_user('dave');
update app.site_plans set deleted_at = null where id = pg_temp.id('plan_old');
select is((select plan_state::text || ' ' || (deleted_at is null)::text from app.site_plans where id = pg_temp.id('plan_old')), 'Draft true',
  'restoring it from Trash gives a Draft plan');
select ok(exists (select 1 from app.trash_items where subject_table = 'site_plans' and subject_id = pg_temp.id('plan_a')),
  'a Live plan moved to Trash is in Trash too');

-- Levels ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.venue_levels (venue_id, name, level_order) values (pg_temp.id('venue_a'), 'Ground', 0) returning id) insert into world select 'lvl_g', id from x;
with x as (insert into app.venue_levels (venue_id, name, level_order) values (pg_temp.id('venue_a'), 'Basement', -1) returning id) insert into world select 'lvl_b', id from x;
with x as (insert into app.venue_levels (venue_id, name, level_order) values (pg_temp.id('venue_a'), 'Mezzanine', 1) returning id) insert into world select 'lvl_m', id from x;
select throws_ok($$insert into app.venue_levels (venue_id, name, level_order) values (pg_temp.id('venue_a'), ' ground', 4)$$, '23514', null,
  'a level name is trimmed');
select throws_ok($$insert into app.venue_levels (venue_id, name, level_order) values (pg_temp.id('venue_a'), 'GROUND', 4)$$, '23505', null,
  'a level name is unique within the venue');
select throws_ok($$insert into app.venue_levels (venue_id, name, level_order) values (pg_temp.id('venue_a'), 'Roof', 201)$$, '23514', null,
  'the order stays within -20 to 200');
select is((select org_id from app.venue_levels where id = pg_temp.id('lvl_g')), pg_temp.id('org_a'), 'a level takes its venue''s org');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'venue_level.created'), 3, 'venue_level.created is emitted');
select pg_temp.as_user('dave');
select is((select string_agg(name, ',' order by level_order, lower(name)) from app.venue_levels where venue_id = pg_temp.id('venue_a')),
  'Basement,Ground,Mezzanine', 'levels sort by order');
select is(app.reorder_venue_levels(pg_temp.id('venue_a'), array[pg_temp.id('lvl_g'), pg_temp.id('lvl_b'), pg_temp.id('lvl_m')]), 2,
  'a reorder swaps two levels in one call');
select is((select string_agg(name || '=' || level_order, ',' order by level_order) from app.venue_levels where venue_id = pg_temp.id('venue_a')),
  'Ground=-1,Basement=0,Mezzanine=1', 'handing out the venue''s order values in the new order');
select throws_ok($$select app.reorder_venue_levels(pg_temp.id('venue_a'), array[pg_temp.id('lvl_g'), pg_temp.id('lvl_b')])$$, 'XR001', null,
  'a reorder lists every live level');

select lives_ok($$update app.spaces set venue_level_id = null where false$$, 'spaces take a level column');
with x as (insert into app.spaces (venue_id, name, venue_level_id) values (pg_temp.id('venue_a'), 'Main hall', pg_temp.id('lvl_g')) returning id) insert into world select 'space_a', id from x;
select is((select venue_level_id from app.spaces where id = pg_temp.id('space_a')), pg_temp.id('lvl_g'), 'a space is on a level of its venue');
select pg_temp.as_user('xavier');
with x as (insert into app.venue_levels (venue_id, name) values (pg_temp.id('venue_b'), 'Dock') returning id) insert into world select 'lvl_x', id from x;
select pg_temp.as_platform();
select throws_ok($$update app.spaces set venue_level_id = pg_temp.id('lvl_x') where id = pg_temp.id('space_a')$$, 'XR001',
  'space_level_venue: A space''s level is a level of the space''s own venue.', 'a space cannot take a level of another venue');
select pg_temp.as_user('dave');
select app.transition_site_plan(pg_temp.id('plan_d'), 'Live', 'Locked', 'Edit.');
select app.transition_site_plan(pg_temp.id('plan_d'), 'Locked', 'Draft', 'Edit.');
select throws_ok($$update app.site_plans set venue_level_id = pg_temp.id('lvl_g') where id = pg_temp.id('plan_d')$$, 'XR001',
  'site_plan_level_venue: A plan''s level is a level of the venue it draws; choose the venue first.', 'a plan with a level names its venue');
select lives_ok($$update app.site_plans set venue_id = pg_temp.id('venue_a'), venue_level_id = pg_temp.id('lvl_m') where id = pg_temp.id('plan_d')$$,
  'a plan takes a level of its venue');
select pg_temp.as_user('gina');
select throws_ok($$insert into app.venue_levels (venue_id, name) values (pg_temp.id('venue_a'), 'Roof')$$, '42501', null, 'a Viewer cannot add levels');
select ok((select count(*) from app.venue_levels where venue_id = pg_temp.id('venue_a')) = 3, 'but reads them');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.venue_levels where venue_id = pg_temp.id('venue_a')), 0, 'another org reads none');

select * from finish();
rollback;
