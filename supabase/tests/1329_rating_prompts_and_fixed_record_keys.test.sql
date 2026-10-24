-- pgTAP: migration 1329, owner decisions of 2026-10-20 (ADR 0038).
--   * numbering.record_key_format is fixed: no value can be saved or locked, by any path, and a value stored earlier can
--     still be cleared.
--   * gateway.ratings_enabled decides only whether the org's members are prompted to rate: with prompts off every rating
--     stays visible to the org, the rated party and marketplace viewers, and ratings can still be given.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(16);

-- Record keys are fixed ---------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select throws_ok($$select app.set_setting((select id from world where key = 'org_a'), 'numbering.record_key_format', 'Organization', null, '{PROJECT}/{SEQ}')$$,
  'XR001', 'setting_fixed: Record keys are fixed: URLs, QR codes, offline Compass data and API v1 depend on them.',
  'an Owner cannot save another record key format');
select throws_ok($$select app.set_setting((select id from world where key = 'org_a'), 'numbering.record_key_format', 'Organization', null, '{PROJECT}-{SEQ}')$$,
  'XR001', null, 'nor the default: the format is not a value anyone sets');
select throws_ok($$select app.set_setting((select id from world where key = 'org_a'), 'numbering.record_key_format', 'Organization', null, '{PROJECT}-{SEQ}', null, null, true)$$,
  'XR001', null, 'nor lock it');

select pg_temp.as_platform();
select throws_ok($$insert into app.setting_values (org_id, setting_key, scope_kind, scope_id, value_text)
  values ((select id from world where key = 'org_a'), 'numbering.record_key_format', 'Organization', (select id from world where key = 'org_a'), '{SEQ}')$$,
  'XR001', null, 'a direct write is refused too');
-- A value stored before migration 1329 does nothing, and the Owner can still clear it.
alter table app.setting_values disable trigger t44_guard_fixed_settings;
insert into app.setting_values (org_id, setting_key, scope_kind, scope_id, value_text)
  values (pg_temp.id('org_a'), 'numbering.record_key_format', 'Organization', pg_temp.id('org_a'), '{SEQ}');
alter table app.setting_values enable trigger t44_guard_fixed_settings;
select pg_temp.as_user('alice');
select lives_ok($$select app.clear_setting((select id from world where key = 'org_a'), 'numbering.record_key_format', 'Organization', null)$$,
  'a value stored earlier can be cleared');
select pg_temp.as_platform();
select is_empty($$select id from app.setting_values where setting_key = 'numbering.record_key_format' and deleted_at is null$$,
  'no org holds a record key format');

-- Rating prompts never hide a rating -------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_vendor_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_vendor_a', 'Closing', 'Complete');
select pg_temp.as_user('carol');
with r as (insert into app.ratings (engagement_id, rater_side, score, comment) values (pg_temp.id('eng_vendor_a'), 'Organization', 2, 'Late to load-in twice.') returning id)
  insert into world select 'rating_org', id from r;
select pg_temp.as_user('sam');
with r as (insert into app.ratings (engagement_id, rater_side, score, comment) values (pg_temp.id('eng_vendor_a'), 'Party', 1, 'Call sheets arrived the night before.') returning id)
  insert into world select 'rating_party', id from r;
select pg_temp.as_platform();
select ok(private.rating_released(pg_temp.id('eng_vendor_a')), 'both ratings are in and released');
select pg_temp.as_user('quinn');
select is((select count(*)::int from api_external.ratings where id in (pg_temp.id('rating_org'), pg_temp.id('rating_party'))), 2,
  'with prompts on, a marketplace viewer sees both ratings');

select pg_temp.as_user('alice');
select lives_ok($$select app.set_setting((select id from world where key = 'org_a'), 'gateway.ratings_enabled', 'Organization', null, null, false)$$,
  'the Owner turns rating prompts off');
select pg_temp.as_platform();
select is(private.setting_boolean(pg_temp.id('org_a'), 'gateway.ratings_enabled', null, null, null), false, 'prompts are off for the org');

select pg_temp.as_user('carol');
select is((select count(*)::int from app.ratings where engagement_id = pg_temp.id('eng_vendor_a')), 2,
  'with prompts off, the org still reads both ratings, low scores included');
select pg_temp.as_user('victor');
select is((select count(*)::int from app.ratings where engagement_id = pg_temp.id('eng_vendor_a')), 2,
  'the rated party''s account still reads both');
select pg_temp.as_user('quinn');
select is((select count(*)::int from api_external.ratings where id in (pg_temp.id('rating_org'), pg_temp.id('rating_party'))), 2,
  'a marketplace viewer still sees both, unchanged');
select pg_temp.as_user('sam');
select ok((select is_released from api_external.my_given_ratings where id = pg_temp.id('rating_party')),
  'the party still sees its own rating released');

-- Members can still rate without a prompt.
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_ivy_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_ivy_a', 'Closing', 'Complete');
select pg_temp.as_user('carol');
select lives_ok($$insert into app.ratings (engagement_id, rater_side, score) values ((select id from world where key = 'eng_ivy_a'), 'Organization', 4)$$,
  'with prompts off, a member can still rate a completed engagement');

-- Nothing in the database reads the prompt setting to filter ratings.
select pg_temp.as_platform();
select is_empty($$
  select viewname::text from pg_views where definition like '%ratings_enabled%'
  union all select policyname::text from pg_policies where coalesce(qual, '') like '%ratings_enabled%' or coalesce(with_check, '') like '%ratings_enabled%'
  union all select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('app', 'private', 'api_external', 'api_public') and p.prosrc like '%gateway.ratings_enabled%'
$$, 'no view, policy or function reads gateway.ratings_enabled');

select * from finish();
rollback;
