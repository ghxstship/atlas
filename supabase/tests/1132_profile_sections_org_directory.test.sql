-- pgTAP: migration 1132 (finding A38-003, journeys 61 and 62). A person shares chosen sections of their own profile
-- with one org as a snapshot read from the profile, including a Private rate; the org with people.profile.read reads
-- them, another org, another person and anon read none; refusals for no section, unshareable sections, someone
-- else's share, a revoked share and another org. Explore lists Public organization profiles only, to signed-in
-- people, with the verified domain and open Public opportunities, indexing off by default.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(24);

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

-- Ivy's profile: Network, with a Private rate ------------------------------------------------------------------------
select pg_temp.as_user('ivy');
insert into app.person_profiles (person_id, handle)
select pg_temp.id('ivy'), 'ivy-marchetti-1132'
where not exists (select 1 from app.person_profiles p where p.person_id = pg_temp.id('ivy') and p.deleted_at is null);
update app.person_profiles set headline = 'Head rigger, arenas and festivals', city = 'Miami', country_code = 'US',
  visibility = 'Network', rate_minor = 45000, rate_currency = 'USD', rate_unit = 'Day'
where person_id = pg_temp.id('ivy') and deleted_at is null;
insert into app.profile_section_visibility (person_id, section, visibility) values (pg_temp.id('ivy'), 'rates', 'Private');
insert into app.person_links (person_id, label, url) values (pg_temp.id('ivy'), 'Reel', 'https://ivy.example.com/reel');

-- Sharing sections -----------------------------------------------------------------------------------------------------
select throws_ok(format($$select app.share_profile_sections('%s', null, '{}')$$, pg_temp.id('org_a')), 'XR001',
  'profile_share_sections: Choose at least one profile section to share.', 'at least one section');
select throws_ok(format($$select app.share_profile_sections('%s', null, '{photo}')$$, pg_temp.id('org_a')), 'XR001', null,
  'photo, portfolio and the other media sections are not shared this way');
insert into world select 'share', app.share_profile_sections(pg_temp.id('org_a'), null,
  array['headline', 'location', 'rates', 'links', 'skills']::app.profile_section[]);
select is((select count(*)::int from app.profile_share_fields where profile_share_id = pg_temp.id('share')), 5, 'one field per section');
select is((select field_value from app.profile_share_fields where profile_share_id = pg_temp.id('share') and field_key = 'profile.headline'),
  'Head rigger, arenas and festivals', 'the value is read from the profile');
select is((select field_value::jsonb from app.profile_share_fields where profile_share_id = pg_temp.id('share') and field_key = 'profile.rates'),
  '{"amount_minor": 45000, "currency": "USD", "unit": "Day"}'::jsonb, 'a Private rate is shared because the owner chose to');
select is((select field_value from app.profile_share_fields where profile_share_id = pg_temp.id('share') and field_key = 'profile.location'),
  'Miami, US', 'location is city and country');
select ok((select field_value is null from app.profile_share_fields where profile_share_id = pg_temp.id('share') and field_key = 'profile.skills'),
  'an empty section is shared empty');
select lives_ok(format($$select app.share_profile_sections('%s', '%s', '{headline,bio}')$$, pg_temp.id('org_a'), pg_temp.id('share')),
  'more sections add to the same share');
select is((select count(*)::int from app.profile_share_fields where profile_share_id = pg_temp.id('share')), 6, 'a repeated section is refreshed, not duplicated');
select throws_ok(format($$select app.share_profile_sections('%s', '%s', '{bio}')$$, pg_temp.id('org_b'), pg_temp.id('share')), 'XR001',
  'profile_share_org: A share goes to one org.', 'a share goes to one org');
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.share_profile_sections('%s', '%s', '{bio}')$$, pg_temp.id('org_a'), pg_temp.id('share')), '42501', null,
  'nobody adds to another person''s share');
select pg_temp.as_anon();
select throws_ok(format($$select app.share_profile_sections('%s', null, '{bio}')$$, pg_temp.id('org_a')), '42501', null, 'anon cannot share');

-- Who reads the shared fields -------------------------------------------------------------------------------------------
select is(pg_temp.n('alice', format($$select 1 from app.profile_share_fields where profile_share_id = '%s'$$, pg_temp.id('share'))), 6,
  'the org applied to reads every shared field');
select is(pg_temp.n('xavier', format($$select 1 from app.profile_share_fields where profile_share_id = '%s'$$, pg_temp.id('share'))), 0,
  'another org reads none');
select is(pg_temp.n('quinn', format($$select 1 from app.profile_share_fields where profile_share_id = '%s'$$, pg_temp.id('share'))), 0,
  'another person reads none');
select is(pg_temp.n('ivy', format($$select 1 from app.profile_share_fields where profile_share_id = '%s'$$, pg_temp.id('share'))), 6,
  'the owner reads what they shared');
select pg_temp.as_user('ivy');
select app.revoke_profile_share(pg_temp.id('share'));
select throws_ok(format($$select app.share_profile_sections('%s', '%s', '{bio}')$$, pg_temp.id('org_a'), pg_temp.id('share')), 'XR001',
  'profile_share_revoked: This share was revoked. Share your profile again.', 'a revoked share takes no more sections');

-- Explore organizations ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into app.organization_profiles (org_id, handle)
select pg_temp.id('org_a'), 'northwind-live-1132'
where not exists (select 1 from app.organization_profiles p where p.org_id = pg_temp.id('org_a') and p.deleted_at is null);
update app.organization_profiles set visibility = 'Public', about = 'Touring and festival production.' where org_id = pg_temp.id('org_a');
with d as (insert into app.org_domains (org_id, hostname, purpose)
  values (pg_temp.id('org_a'), 'northwind-1132.example.com', 'Verified Domain') returning id)
  insert into world select 'dom', id from d;
select pg_temp.as_platform();
select app.record_domain_verification(pg_temp.id('dom'), true);
select pg_temp.as_user('xavier');
update app.organization_profiles set visibility = 'Network' where org_id = pg_temp.id('org_b');
select pg_temp.as_user('ivy');
select ok(exists (select 1 from app.explore_organizations() e where e.name = 'Northwind Live'), 'a Public org profile appears in Explore');
select ok(not exists (select 1 from app.explore_organizations() e where e.name = 'Harbor Lights Productions'), 'a Network one does not');
select is((select verified_domain from app.explore_organizations() e where e.name = 'Northwind Live'), 'northwind-1132.example.com',
  'with its verified domain');
select is((select indexable from app.explore_organizations() e where e.name = 'Northwind Live'), false, 'indexing is off by default');
select ok(exists (select 1 from app.explore_organizations('festival') e where e.name = 'Northwind Live'), 'the query matches the about text');
select ok(not exists (select 1 from app.explore_organizations('nothing like this') e), 'and filters the rest out');
select pg_temp.as_anon();
select throws_ok('select * from app.explore_organizations()', '42501', null, 'Explore of organizations is for signed-in people');

select * from finish();
rollback;
