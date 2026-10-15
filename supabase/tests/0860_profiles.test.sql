-- pgTAP: person and organization profiles, visibility (Section 4.8.3, journeys 61 and 62), handles with
-- redirects, organization verification, case study consent, team member opt-in and certification carry-over.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(82);

create function pg_temp.as_service() returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
end $$;

create temporary table k (key text primary key, id uuid, txt text);
grant select, insert, update on k to public;

-- Person profiles -------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into k (key, id) values ('dave_profile', app.ensure_my_profile());
select is(app.ensure_my_profile(), (select id from k where key = 'dave_profile'), 'ensure_my_profile is idempotent');
update k set txt = (select handle from app.person_profiles) where key = 'dave_profile';
select is((select handle from app.person_profiles), 'dave-lindqvist', 'the handle comes from the person''s name');
select is((select visibility::text from app.person_profiles), 'Private', 'new profiles start Private');
update app.person_profiles set headline = 'Lead rigger, arena tours', bio = 'Twenty years of arena rigging.', city = 'Miami',
  country_code = 'US', rate_minor = 85000, rate_currency = 'USD', rate_unit = 'Day';
select pg_temp.as_user('nina');
select is((select count(*)::integer from api_public.person_profile('dave-lindqvist')), 0, 'a stranger sees nothing of a Private profile');
select is((select count(*)::integer from app.person_profiles), 0, 'nobody else reads the profile table');
select throws_ok($$insert into app.person_skills (person_id, cat_urid) values (pg_temp.id('dave'), '0000.01.01')$$, '42501', null,
  'nobody else writes someone''s profile');
select pg_temp.as_user('carol');
select is((select count(*)::integer from api_public.person_profile('dave-lindqvist')), 0, 'a colleague sees nothing of a Private profile');

select pg_temp.as_user('dave');
update app.person_profiles set visibility = 'Network';
insert into app.profile_section_visibility (person_id, section, visibility) values (pg_temp.id('dave'), 'rates', 'Private');
insert into app.person_skills (person_id, cat_urid, sort_order) values (pg_temp.id('dave'), '0000.01.01', 1);
insert into app.person_references (person_id, referee_name, relationship, contact_email, statement)
values (pg_temp.id('dave'), 'Riley Ward', 'Production manager on two tours', 'riley@example.com', 'Safe, fast and calm.');
select is((select headline || '/' || coalesce(rate_minor::text, 'hidden') from api_public.person_profile('dave-lindqvist')),
  'Lead rigger, arena tours/85000', 'the owner sees every section');
select is((select viewer_is_owner from api_public.person_profile('dave-lindqvist')), true, 'the owner is told it is their profile');

select pg_temp.as_user('carol');
select is((select headline || '/' || coalesce(rate_minor::text, 'hidden') from api_public.person_profile('dave-lindqvist')),
  'Lead rigger, arena tours/hidden', 'a colleague sees Network sections but not the hidden rates');
select is((select count(*)::integer from api_public.person_profile_skills('dave-lindqvist')), 1, 'a colleague sees the skills');
select is((select statement from api_public.person_profile_references('dave-lindqvist')), 'Safe, fast and calm.',
  'references show without the referee contact');
select pg_temp.as_user('nina');
select is((select count(*)::integer from api_public.person_profile('dave-lindqvist')), 0, 'a stranger sees nothing of a Network profile');
select is((select count(*)::integer from api_public.person_profile_skills('dave-lindqvist')), 0, 'nor its skills');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from api_public.person_profile('dave-lindqvist')), 0, 'another org''s Owner sees nothing');
select pg_temp.as_platform();
update app.memberships set valid_to = now() where id = pg_temp.id('mia@org_a');
select pg_temp.as_user('mia');
select is((select headline from api_public.person_profile('dave-lindqvist')), 'Lead rigger, arena tours',
  'a past collaborator still sees Network sections');
select pg_temp.as_anon();
select is((select count(*)::integer from api_public.person_profile('dave-lindqvist')), 0, 'anon sees nothing of a Network profile');

select pg_temp.as_user('dave');
update app.profile_section_visibility set visibility = 'Public' where section = 'rates';
insert into app.profile_section_visibility (person_id, section, visibility) values (pg_temp.id('dave'), 'skills', 'Private');
select pg_temp.as_anon();
select is((select count(*)::integer from api_public.person_profile('dave-lindqvist')), 0,
  'a Public section never widens a Network profile');
select pg_temp.as_user('dave');
select throws_ok($$update app.person_profiles set search_indexing = true$$, '23514', null, 'only a Public profile can be indexed');
update app.person_profiles set visibility = 'Public';
select pg_temp.as_anon();
select is((select headline || '/' || indexable from api_public.person_profile('dave-lindqvist')), 'Lead rigger, arena tours/false',
  'anon sees a Public profile, noindex by default');
select is((select count(*)::integer from api_public.person_profile_skills('dave-lindqvist')), 0, 'a Private section stays hidden from anon');
select pg_temp.as_user('dave');
select is((select count(*)::integer from api_public.person_profile_skills('dave-lindqvist')), 1, 'the owner still sees the Private section');
update app.person_profiles set search_indexing = true;
select pg_temp.as_anon();
select is((select indexable from api_public.person_profile('dave-lindqvist')), true, 'turning indexing on makes it indexable');

-- Handles ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select lives_ok($$update app.person_profiles set handle = 'dave-rigs'$$, 'a person changes their handle');
select pg_temp.as_platform();
select is((select count(*)::integer from private.handle_redirects where handle = 'dave-lindqvist'), 1, 'the old handle keeps a redirect');
select pg_temp.as_user('dave');
select throws_ok($$update app.person_profiles set handle = 'dave-rigs-again'$$, 'XR001', null, 'a handle changes once every 30 days');
select throws_ok($$update app.person_profiles set handle_changed_at = now() - interval '60 days'$$, 'XR001', null,
  'the change time is kept by the platform');
select pg_temp.as_anon();
select is((select handle || '/' || redirected from api_public.person_profile('dave-lindqvist')), 'dave-rigs/true',
  'the old handle redirects to the new one');
select pg_temp.as_user('carol');
select throws_ok($$insert into app.person_profiles (person_id, handle) values (pg_temp.id('carol'), 'dave-lindqvist')$$, 'XR001', null,
  'nobody takes a handle during its redirect');
select throws_ok($$insert into app.person_profiles (person_id, handle) values (pg_temp.id('carol'), 'settings')$$, 'XR001', null,
  'reserved words are refused');
select throws_ok($$insert into app.person_profiles (person_id, handle) values (pg_temp.id('carol'), 'Carol_N')$$, 'XR001', null,
  'handles are lowercase letters, digits and hyphens');
select throws_ok($$insert into app.person_profiles (person_id, handle) values (pg_temp.id('carol'), 'dave-rigs')$$, '23505', null,
  'handles are unique');
select throws_ok($$insert into app.person_profiles (person_id, handle) values (pg_temp.id('dave'), 'carol-n')$$, '42501', null,
  'nobody creates a profile for someone else');
select pg_temp.as_platform();
update private.handle_redirects set expires_at = now() - interval '1 second' where handle = 'dave-lindqvist';
select pg_temp.as_user('carol');
select lives_ok($$insert into app.person_profiles (person_id, handle) values (pg_temp.id('carol'), 'dave-lindqvist')$$,
  'an expired redirect frees the handle');
select pg_temp.as_platform();
select is((select count(*)::integer from private.handle_redirects where handle = 'dave-lindqvist'), 0, 'claiming the handle removes the expired redirect');

-- Organization profiles ---------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into k (key, id) values ('org_profile', app.ensure_organization_profile(pg_temp.id('org_a')));
select is((select handle || '/' || visibility from app.organization_profiles where org_id = pg_temp.id('org_a')), 'northwind-live/Network',
  'an org profile takes the slug as handle and starts Network');
update app.organization_profiles set about = 'Touring and festival production.', website_url = 'https://northwind.test'
where org_id = pg_temp.id('org_a');
select pg_temp.as_user('dave');
select throws_ok($$select app.ensure_organization_profile(pg_temp.id('org_b'))$$, '42501', null, 'only profile editors create an org profile');
update app.organization_profiles set about = 'Changed by a member.';
select is((select about from app.organization_profiles where org_id = pg_temp.id('org_a')), 'Touring and festival production.',
  'a Member without org.profile.write cannot edit the org profile');
select is((select count(*)::integer from api_public.organization_profile('northwind-live')), 1, 'members see their org''s profile');
select pg_temp.as_user('nina');
select is((select count(*)::integer from api_public.organization_profile('northwind-live')), 0, 'a stranger does not see a Network org profile');
select pg_temp.as_user('alice');
insert into app.organization_profile_capabilities (org_id, cat_urid) values (pg_temp.id('org_a'), '0000.01.01');
update app.organization_profiles set visibility = 'Public' where org_id = pg_temp.id('org_a');
select pg_temp.as_anon();
select is((select name || '/' || verified || '/' || indexable from api_public.organization_profile('northwind-live')),
  'Northwind Live/false/false', 'anon sees a Public org profile, unverified and noindex by default');
select is((select count(*)::integer from api_public.organization_profile_details('northwind-live') where detail_kind = 'capability'), 1,
  'capabilities by URID appear');
select pg_temp.as_user('dave');
select throws_ok($$insert into app.organization_profile_capabilities (org_id, cat_urid) values (pg_temp.id('org_a'), '0000.02.01')$$,
  '42501', null, 'a Member cannot add capabilities');
select is((select count(*)::integer from api_public.person_profile_organizations('dave-rigs')), 1,
  'a Public org appears among the orgs a person worked with');

-- Verification ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select throws_ok($$select app.record_organization_verification(pg_temp.id('org_a'), 'Stripe Identity', 'vs_test_1')$$, '42501', null,
  'members cannot record verification');
select throws_ok($$insert into app.organization_verifications (org_id, method, provider_reference) values (pg_temp.id('org_a'), 'Stripe Identity', 'x')$$,
  '42501', null, 'nobody writes verifications directly');
select pg_temp.as_service();
insert into k (key, id) values ('verification', app.record_organization_verification(pg_temp.id('org_a'), 'Stripe Identity', 'vs_test_1'));
select pg_temp.as_anon();
select is((select verified from api_public.organization_profile('northwind-live')), true, 'a recorded verification shows the badge');
select pg_temp.as_user('xavier');
select is(app.organization_verified(pg_temp.id('org_a')), true, 'the verified flag is readable by anyone signed in');
select is(app.organization_verified(pg_temp.id('org_b')), false, 'an unverified org is not flagged');
select pg_temp.as_service();
select lives_ok($$select app.revoke_organization_verification((select id from k where key = 'verification'), 'Registry record withdrawn.')$$,
  'the platform revokes a verification');
select is(app.organization_verified(pg_temp.id('org_a')), false, 'a revoked verification removes the flag');
select pg_temp.as_service();
select lives_ok($$select app.record_organization_verification(pg_temp.id('org_a'), 'Business Registry', 'reg-1', now() + interval '1 year')$$,
  'a new verification can follow');
select pg_temp.as_platform();
select is((select count(*)::integer from app.domain_events where event_type = 'organization.verified' and org_id = pg_temp.id('org_a')), 2,
  'each verification emits organization.verified');

-- Case studies and team members ----------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select throws_ok($$insert into app.organization_case_studies (org_id, title, summary, client_organization_id, published)
  values (pg_temp.id('org_a'), 'Harbor Fest', 'Three stages over two days.', pg_temp.id('org_b'), true)$$, 'XR001', null,
  'a case study naming a client cannot publish before consent');
insert into app.organization_case_studies (org_id, title, summary, client_organization_id)
values (pg_temp.id('org_a'), 'Harbor Fest', 'Three stages over two days.', pg_temp.id('org_b'));
insert into k (key, id) select 'case', id from app.organization_case_studies;
select throws_ok($$update app.organization_case_studies set client_consented_at = now()$$, 'XR001', null, 'the author cannot record client consent');
select pg_temp.as_user('dave');
select throws_ok($$select app.consent_to_case_study((select id from k where key = 'case'))$$, '42501', null, 'only the client consents');
select pg_temp.as_user('xavier');
select lives_ok($$select app.consent_to_case_study((select id from k where key = 'case'))$$, 'the client''s Owner consents');
select pg_temp.as_user('alice');
select lives_ok($$update app.organization_case_studies set published = true$$, 'after consent the author publishes');
select pg_temp.as_anon();
select is((select count(*)::integer from api_public.organization_profile_details('northwind-live') where detail_kind = 'case_study'), 1,
  'the published case study appears');
select pg_temp.as_user('alice');
select throws_ok($$insert into app.organization_profile_members (org_id, person_id) values (pg_temp.id('org_a'), pg_temp.id('dave'))$$,
  '42501', null, 'nobody opts someone else in to the team list');
select pg_temp.as_user('nina');
select throws_ok($$insert into app.organization_profile_members (org_id, person_id) values (pg_temp.id('org_a'), pg_temp.id('nina'))$$,
  '42501', null, 'only members opt in');
select pg_temp.as_user('dave');
select lives_ok($$insert into app.organization_profile_members (org_id, person_id, title) values (pg_temp.id('org_a'), pg_temp.id('dave'), 'Head Rigger')$$,
  'a member opts in to the team list');
select pg_temp.as_anon();
select is((select label from api_public.organization_profile_details('northwind-live') where detail_kind = 'team_member'),
  'Dave Lindqvist · Head Rigger', 'the member appears with their title');

-- Certification carry-over ------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into app.certifications (org_id, name, issuing_body) values (pg_temp.id('org_a'), 'Arena Rigging Level 2', 'ETCP');
insert into app.certification_holders (certification_id, person_id, issued_on, expires_on)
select id, pg_temp.id('dave'), '2026-01-10', '2029-01-10' from app.certifications where org_id = pg_temp.id('org_a');
insert into k (key, id) select 'holder_a', id from app.certification_holders where org_id = pg_temp.id('org_a');
select pg_temp.as_user('carol');
select throws_ok($$select app.carry_certification_to_profile((select id from k where key = 'holder_a'))$$, 'XR001', null,
  'only the holder carries a certification');
select pg_temp.as_user('dave');
insert into k (key, id) values ('pcert', app.carry_certification_to_profile((select id from k where key = 'holder_a')));
select is(app.carry_certification_to_profile((select id from k where key = 'holder_a')), (select id from k where key = 'pcert'),
  'carrying is idempotent');
select is((select verified_by_org_id from app.person_certifications where id = (select id from k where key = 'pcert')), pg_temp.id('org_a'),
  'the carried certification keeps the org''s verification');
select throws_ok($$update app.person_certifications set expires_on = '2035-01-01' where id = (select id from k where key = 'pcert')$$,
  'XR001', null, 'verified facts cannot change');
insert into app.person_certifications (person_id, name, issuing_body, issued_on, verified_at, verified_by_org_id)
values (pg_temp.id('dave'), 'First Aid', 'Red Cross', '2025-05-01', now(), pg_temp.id('org_a'));
select is((select verified_at from app.person_certifications where name = 'First Aid'), null, 'a person never verifies their own entry');
select pg_temp.as_anon();
select is((select count(*)::integer from api_public.person_profile_certifications('dave-rigs') where verified), 1,
  'the profile shows one verified badge');
select pg_temp.as_user('dave');
insert into k (key, id) values ('share', app.share_certification((select id from k where key = 'pcert'), pg_temp.id('org_b')));
select is((select count(*)::integer from app.consent_records where person_id = pg_temp.id('dave') and org_id = pg_temp.id('org_b')
  and purpose_code = 'profile_sharing'), 1, 'sharing records profile_sharing consent for that org');
select is(app.share_certification((select id from k where key = 'pcert'), pg_temp.id('org_b')), (select id from k where key = 'share'),
  'sharing again while the share stands returns the same share');
select pg_temp.as_user('xavier');
select is((select name from app.shared_certifications), 'Arena Rigging Level 2', 'the receiving org reads the shared certification');
insert into app.certifications (org_id, name, issuing_body) values (pg_temp.id('org_b'), 'Rigging L2', 'ETCP');
select pg_temp.as_user('carol');
select is((select count(*)::integer from app.shared_certifications), 0, 'another org does not read it');
select throws_ok($$select app.accept_shared_certification((select id from k where key = 'share'), (select id from app.certifications where name = 'Rigging L2'))$$,
  '42501', null, 'only the receiving org records it');
select pg_temp.as_user('xavier');
insert into k (key, id) values ('holder_b', app.accept_shared_certification((select id from k where key = 'share'),
  (select id from app.certifications where name = 'Rigging L2')));
select is((select verified_by from app.certification_holders where id = (select id from k where key = 'holder_b')), pg_temp.id('xavier'),
  'the receiving org records its own holder row, verified by its verifier');
select is((select expires_on from app.certification_holders where id = (select id from k where key = 'holder_b')), '2029-01-10'::date,
  'the dates carry over');
select pg_temp.as_user('dave');
select lives_ok($$select app.revoke_certification_share((select id from k where key = 'share'))$$, 'the person revokes the share');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.shared_certifications), 0, 'a revoked share is no longer readable');
select throws_ok($$select app.accept_shared_certification((select id from k where key = 'share'), (select id from app.certifications where name = 'Rigging L2'))$$,
  'XR001', null, 'a revoked share cannot be recorded again');
select is((select count(*)::integer from app.certification_holders where id = (select id from k where key = 'holder_b')), 1,
  'the org keeps the record it already made');

select pg_temp.as_platform();
select is((select count(*)::integer from app.domain_events where event_type = 'certification.shared' and org_id = pg_temp.id('org_b')), 1,
  'sharing emits certification.shared to the receiving org');
select is((select count(*)::integer from private.retention_policies where table_name in ('app.person_profiles', 'app.person_skills',
  'app.person_certifications', 'app.certification_shares', 'app.organization_profiles', 'app.organization_verifications')), 6,
  'profile tables have retention policies');

select * from finish();
rollback;
