-- pgTAP: migration 2220, the dashboard layout settings (A129, RRR-174). me.dashboard_layout.home and
-- me.dashboard_layout.partner are personal Text settings of at most 600 characters: each person keeps their own
-- spans for every org, nobody else reads them, and nobody may set them for an org.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(9);

select is((select array_agg(setting_key::text order by setting_key) from private.setting_definitions
  where setting_key like 'me.dashboard_layout.%'), array['me.dashboard_layout.home', 'me.dashboard_layout.partner'],
  'both dashboard layouts are registered');
select ok((select allows_personal and not (allows_organization or allows_workspace or allows_team or allows_project)
  from private.setting_definitions where setting_key = 'me.dashboard_layout.home'), 'a dashboard layout is personal only');
select is((select max_length from private.setting_definitions where setting_key = 'me.dashboard_layout.partner'),
  600, 'a dashboard layout holds at most 600 characters');

select pg_temp.as_user('carol');
select is((select value_text from app.resolve_settings(pg_temp.id('org_a')) where setting_key = 'me.dashboard_layout.home'),
  null, 'Home keeps its default spans until the person arranges it');
select lives_ok($$select app.set_personal_setting('me.dashboard_layout.home', p_value_text => 'checklist:8,plan:4,alerts:6')$$,
  'a person saves the spans they arranged');
select is((select value_text || '/' || source from app.resolve_settings(pg_temp.id('org_a')) where setting_key = 'me.dashboard_layout.home'),
  'checklist:8,plan:4,alerts:6/Personal', 'their Home reads them back in every org');
select throws_ok($$select app.set_personal_setting('me.dashboard_layout.home', p_value_text => repeat('a:1,', 151))$$,
  'XR001', null, 'a layout longer than 600 characters is refused');

select pg_temp.as_user('dave');
select is((select value_text from app.resolve_settings(pg_temp.id('org_a')) where setting_key = 'me.dashboard_layout.home'),
  null, 'another person in the org still sees the default spans');

select pg_temp.as_user('alice');
select throws_ok($$select app.set_setting(pg_temp.id('org_a'), 'me.dashboard_layout.home', 'Organization', pg_temp.id('org_a'),
  p_value_text => 'plan:12')$$, '42501', null, 'an Owner cannot set a dashboard layout for the whole org');

select * from finish();
rollback;
