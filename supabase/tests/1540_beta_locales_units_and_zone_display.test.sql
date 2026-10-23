-- pgTAP: migration 1540, the Section 15 settings beyond en-US and es-US (A97, RRR-142, ADR 0053). A person may
-- choose a Beta locale and nothing outside the shipped locales; locale.units follows the jurisdiction by default
-- and still takes a fixed system; me.time_zone_display is personal only, defaults to the event's zone and
-- refuses anything but event or viewer. The canon locale list agrees with the shipped Beta locales.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(13);

-- locale.language ---------------------------------------------------------------------------------------------
select results_eq(
  $$select choice from private.setting_choices where setting_key = 'locale.language' order by sort_order$$,
  $$values ('en-US'::text), ('es-US'), ('fr-FR'), ('de-DE'), ('it-IT'), ('pt-BR'), ('ja-JP')$$,
  'locale.language offers the launch locales, then the five Beta locales');
select pg_temp.as_user('bob');
select lives_ok($$select app.set_personal_setting('locale.language', null, p_value_text => 'ja-JP')$$,
  'a person may choose a Beta locale');
select results_eq(
  $$select value_text from app.resolve_settings(pg_temp.id('org_a')) where setting_key = 'locale.language'$$,
  $$values ('ja-JP'::text)$$, 'the chosen Beta locale resolves for that person');
select throws_ok($$select app.set_personal_setting('locale.language', null, p_value_text => 'en-GB')$$,
  'XR001', null, 'a locale that does not ship is refused');

-- locale.units -----------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select results_eq(
  $$select value_text, source::text from app.resolve_settings(pg_temp.id('org_a')) where setting_key = 'locale.units'$$,
  $$values ('jurisdiction'::text, 'Default'::text)$$,
  'units follow the project''s jurisdiction unless someone chooses a system');
select lives_ok($$select app.set_personal_setting('locale.units', null, p_value_text => 'metric')$$,
  'a person may still choose metric');
select results_eq(
  $$select value_text, source::text from app.resolve_settings(pg_temp.id('org_a')) where setting_key = 'locale.units'$$,
  $$values ('metric'::text, 'Personal'::text)$$, 'and their choice wins over the jurisdiction');
select throws_ok($$select app.set_personal_setting('locale.units', null, p_value_text => 'nautical')$$,
  'XR001', null, 'an unknown unit system is refused');

-- me.time_zone_display -------------------------------------------------------------------------------------------
select results_eq(
  $$select value_text from app.resolve_settings(pg_temp.id('org_a')) where setting_key = 'me.time_zone_display'$$,
  $$values ('event'::text)$$, 'schedule times show in the event''s zone by default');
select lives_ok($$select app.set_personal_setting('me.time_zone_display', null, p_value_text => 'viewer')$$,
  'a person may show schedule times in their own zone');
select throws_ok($$select app.set_personal_setting('me.time_zone_display', null, p_value_text => 'utc')$$,
  'XR001', null, 'only event or viewer is accepted');
select pg_temp.as_platform();
select is((select allows_organization or allows_workspace or allows_project or allows_team
  from private.setting_definitions where setting_key = 'me.time_zone_display'), false,
  'the time zone display is the person''s own: no shared scope can set it');

-- Canon locales -----------------------------------------------------------------------------------------------------
select results_eq(
  $$select (locale_code::text) collate "default" from xpms.dim_locale where release_stage::text = 'beta' order by 1$$,
  $$values ('de-DE'::text), ('fr-FR'), ('it-IT'), ('ja-JP'), ('pt-BR')$$,
  'xpms.dim_locale marks the same five locales Beta');

select * from finish();
rollback;
