-- pgTAP: migration 1206, blocks (A52, Section 4.5.6 Profile Privacy). A person blocks another person or an organization
-- by URN. The block hides the blocker's profile from the blocked person and from every member of a blocked organization,
-- whatever its visibility, and hides the blocked profile from the blocker; anon and everyone else still see it. Lifting the
-- block restores it. Nobody blocks themselves or their own org, bad URNs are refused, and a person reads only their own
-- blocks.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(23);

select has_table('app', 'blocks', 'app.blocks exists');

-- Public profiles for Dave (Northwind) and Xavier (Harbor Lights), and Harbor Lights' org profile.
select pg_temp.as_user('dave');
select app.ensure_my_profile();
update app.person_profiles set visibility = 'Public', headline = 'Lead rigger';
select pg_temp.as_user('xavier');
select app.ensure_my_profile();
update app.person_profiles set visibility = 'Public', headline = 'Producer';
select app.ensure_organization_profile(pg_temp.id('org_b'));
update app.organization_profiles set visibility = 'Public' where org_id = pg_temp.id('org_b');

select is((select count(*)::int from api_public.person_profile('dave-lindqvist')), 1, 'before: Xavier sees Dave''s Public profile');

-- Refusals.
select pg_temp.as_user('dave');
select throws_ok($$insert into app.blocks (blocked_urn) values ('urn:xpms:person:' || (select id from world where key = 'dave'))$$,
  'XR001', 'block_self: A person cannot block themselves.', 'nobody blocks themselves');
select throws_ok($$insert into app.blocks (blocked_urn) values ('urn:xpms:organization:' || (select id from world where key = 'org_a'))$$,
  'XR001', 'block_own_org: Leave an organization before blocking it.', 'nor an organization they belong to');
select throws_ok($$insert into app.blocks (blocked_urn) values ('urn:xpms:venue:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f')$$,
  'XR001', null, 'only people and organizations can be blocked');
select throws_ok($$insert into app.blocks (blocked_urn) values ('urn:xpms:person:0192f1e2-7c3a-7b4d-9e8f-1a2b3c4d5e6f')$$,
  'XR001', 'block_target: No such person.', 'a URN must name someone who exists');

-- Dave blocks Xavier.
select lives_ok($$insert into app.blocks (blocked_urn) values ('urn:xpms:person:' || upper((select id from world where key = 'xavier')::text))$$,
  'Dave blocks Xavier by URN');
select is((select blocked_person_id from app.blocks where deleted_at is null), pg_temp.id('xavier'), 'the URN resolves to the person');
select is((select blocked_urn from app.blocks where deleted_at is null), 'urn:xpms:person:' || pg_temp.id('xavier')::text, 'and is stored normalized');
select throws_ok($$insert into app.blocks (blocked_urn) values ('urn:xpms:person:' || (select id from world where key = 'xavier'))$$,
  '23505', null, 'a block appears once');
select is((select count(*)::int from api_public.person_profile('xavier-dubois')), 0, 'the blocker no longer sees the blocked person''s profile');

select pg_temp.as_user('xavier');
select is((select count(*)::int from api_public.person_profile('dave-lindqvist')), 0, 'the blocked person no longer sees the blocker''s Public profile');
select is((select count(*)::int from api_public.person_profile_skills('dave-lindqvist')), 0, 'nor any section of it');
select is((select count(*)::int from app.blocks), 0, 'and cannot read the block');

select pg_temp.as_user('paul');
select is((select count(*)::int from api_public.person_profile('dave-lindqvist')), 1, 'everyone else still sees it');
select pg_temp.as_anon();
select is((select count(*)::int from api_public.person_profile('dave-lindqvist')), 1, 'anon too');

-- Lift it, then block the organization.
select pg_temp.as_user('dave');
update app.blocks set deleted_at = now() where blocked_person_id = pg_temp.id('xavier');
select lives_ok($$insert into app.blocks (blocked_urn) values ('urn:xpms:organization:' || (select id from world where key = 'org_b'))$$,
  'Dave blocks Harbor Lights');
select is((select count(*)::int from api_public.organization_profile('harbor-lights')), 0, 'the blocker no longer sees the organization''s profile');

select pg_temp.as_user('mia');
select is((select count(*)::int from api_public.person_profile('dave-lindqvist')), 0,
  'a member of the blocked organization loses sight of the profile, even one who also works with him elsewhere');
select pg_temp.as_user('xavier');
select is((select count(*)::int from api_public.person_profile('dave-lindqvist')), 0, 'every member of a blocked organization loses sight of the profile');

select pg_temp.as_user('dave');
update app.blocks set deleted_at = now() where blocked_organization_id = pg_temp.id('org_b');
select pg_temp.as_user('xavier');
select is((select count(*)::int from api_public.person_profile('dave-lindqvist')), 1, 'lifting the block restores the profile');

select pg_temp.as_user('dave');
insert into app.blocks (blocked_urn) values ('urn:xpms:person:' || pg_temp.id('xavier'));
select pg_temp.as_platform();
update app.people set deleted_at = now() where id = pg_temp.id('dave');
select is((select count(*)::int from app.blocks where person_id = pg_temp.id('dave')), 0, 'deleting the account removes the blocks the person made');

select pg_temp.as_anon();
select throws_ok('select 1 from app.blocks', '42501', null, 'anon reads no blocks');

select * from finish();
rollback;
