-- pgTAP: migration 2333, a sponsor's entitlements carry their org's media.keep_photo_location (A140, RRR-204; ADR 0117
-- decision 1), so Compass applies the org's rule to proof-of-performance photos although the sponsor has no
-- membership. Tested for the default (off), the org turning it on, another tenant's value, the sponsor not being able
-- to change it, and the view keeping its columns and row filter.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(8);

-- Fixture: Brightwave Drinks sponsors prj_a (org_a) through sol's engagement and owns one entitlement there.
select pg_temp.new_user('sol', 'sol@brightwave-drinks.test', 'Sol Ferreira');
select pg_temp.as_user('sol');
insert into world values ('acct_s', app.create_external_account('Brightwave Drinks', 'brightwave-drinks'));
select pg_temp.as_user('alice');
insert into world values ('cp_s_a', app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_s')));
with e as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('sol'), pg_temp.id('cp_s_a'), 'Sponsor', '2027-06-01') returning id)
  insert into world select 'eng_sponsor', id from e;
select pg_temp.as_user('carol');
insert into app.sponsor_entitlements (project_id, counterparty_id, description, quantity)
  values (pg_temp.id('prj_a'), pg_temp.id('cp_s_a'), 'Main stage banner placement', 2);
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_sponsor', 'Onboarding', 'Active');

-- 1. Shape -------------------------------------------------------------------------------------------------------------
select is((select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
    where table_schema = 'api_external' and table_name = 'sponsor_entitlements'),
  'id,project_id,project_name,account_id,description,quantity,due_on,fulfilled_at,is_overdue,keep_photo_location',
  'the view keeps 1307''s columns in order and appends keep_photo_location');
select ok(not has_table_privilege('anon', 'api_external.sponsor_entitlements', 'select'), 'anon still reads nothing');

-- 2. The org's value ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('sol');
select is((select keep_photo_location from api_external.sponsor_entitlements), false, 'off by default: proof photos keep no location');
select pg_temp.as_user('xavier');
select app.set_setting(pg_temp.id('org_b'), 'media.keep_photo_location', 'Organization', pg_temp.id('org_b'), p_value_boolean => true);
select pg_temp.as_user('sol');
select is((select keep_photo_location from api_external.sponsor_entitlements), false,
  'denial: another tenant turning it on does not reach org_a''s entitlement');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'media.keep_photo_location', 'Organization', pg_temp.id('org_a'), p_value_boolean => true);
select pg_temp.as_user('sol');
select is((select keep_photo_location from api_external.sponsor_entitlements), true,
  'the org turning it on reaches the sponsor, who has no membership');
select is((select count(*)::int from api_external.sponsor_entitlements), 1, 'the sponsor still reads only its own entitlement');
select throws_ok(format($$select app.set_setting(%L, 'media.keep_photo_location', 'Organization', %L, p_value_boolean => false)$$,
  pg_temp.id('org_a'), pg_temp.id('org_a')), null, null, 'denial: the sponsor cannot change the org''s rule');
select pg_temp.as_platform();

-- 3. After close -------------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_sponsor', 'Active', 'Closing');
select pg_temp.move_engagement('eng_sponsor', 'Closing', 'Complete');
select pg_temp.as_user('sol');
select is((select count(*)::int from api_external.sponsor_entitlements), 0, 'denial after close: the entitlement leaves the sponsor''s view');
select pg_temp.as_platform();

select * from finish();
rollback;
