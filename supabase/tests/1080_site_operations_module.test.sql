-- pgTAP: Site Operations is a switchable module (A38, RRR-82, finding A24-003). An Admin turns `workforce`
-- off and on again; a Member, a Viewer, anon and another org's Owner cannot; modules outside the switchable
-- navigation groups stay always on; and every module item Settings lists is now switchable, so saving the
-- whole Modules form never meets module_not_switchable.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(13);

select is((select nav_group::text || '/' || project_scoped::text from app.capability_modules where code = 'workforce'),
  'operations/false', 'Site Operations is an org-level module in the Operations group');

select pg_temp.as_user('bob');
select lives_ok($$select app.set_module_enabled(pg_temp.id('org_a'), 'workforce', false)$$,
  'an Admin turns Site Operations off');
select is((select enabled from app.org_module_states where org_id = pg_temp.id('org_a') and module_code = 'workforce'),
  false, 'the switch is stored off');
select lives_ok($$select app.set_module_enabled(pg_temp.id('org_a'), 'workforce', true)$$,
  'an Admin turns Site Operations back on');
select is((select enabled from app.org_module_states where org_id = pg_temp.id('org_a') and module_code = 'workforce'),
  true, 'the same switch row is turned back on');
select is((select count(*)::integer from app.org_module_states where org_id = pg_temp.id('org_a') and module_code = 'workforce'),
  1, 'turning a module back on reuses its switch');

-- Every module the Settings form lists (the switchable groups) saves in one pass; Projects and Home stay on.
select lives_ok($$select app.set_module_enabled(pg_temp.id('org_a'), m.code, true)
  from app.capability_modules m
  where m.nav_group in ('production', 'operations', 'people', 'commercial', 'knowledge') and m.code <> 'projects'$$,
  'a full save of every listed module is accepted');
select throws_ok($$select app.set_module_enabled(pg_temp.id('org_a'), 'projects', false)$$, 'XR001', null,
  'Projects stays always on');
select throws_ok($$select app.set_module_enabled(pg_temp.id('org_a'), 'home', false)$$, 'XR001', null,
  'Home stays always on');

select pg_temp.as_user('dave');
select throws_ok($$select app.set_module_enabled(pg_temp.id('org_a'), 'workforce', false)$$, '42501', null,
  'a Member cannot switch Site Operations');
select pg_temp.as_user('gina');
select throws_ok($$select app.set_module_enabled(pg_temp.id('org_a'), 'workforce', false)$$, '42501', null,
  'a Viewer cannot switch Site Operations');
select pg_temp.as_user('xavier');
select throws_ok($$select app.set_module_enabled(pg_temp.id('org_a'), 'workforce', false)$$, '42501', null,
  'another org''s Owner cannot switch it');
select pg_temp.as_anon();
select throws_ok($$select app.set_module_enabled(pg_temp.id('org_a'), 'workforce', false)$$, '42501', null,
  'anon cannot switch modules');

select * from finish();
rollback;
