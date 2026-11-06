-- pgTAP: migrations 6145 and 6146 (RRR-248, ADR 0156).
--   * An org's rating of a named person reads only inside the org that gave it and for that person: not from another org's
--     roles, a partner on a shared project, or the account that supplied the person, through the table or api_external.
--   * Company ratings and a party's rating of an org read as before.
--   * A person's opt-in is recorded, off by default and withdrawn at once, and it opens one path only: their profile, for
--     viewers who decide no hiring anywhere. It never opens the table, the view or a list across people.
--   * The rated person disputes through a route that exists; the org answers; an operator decides, on grounds that do not
--     read the score. The rating_dispute lifecycle refuses a second decision.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(52);

-- World: ivy, a person, rated by org_a and by org_b. sam, a named person acct_v supplied to org_a. A company engagement
-- naming no person. A plain member of org_b who decides no hiring, and an operator.
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_ivy_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_ivy_a', 'Closing', 'Complete');
select pg_temp.move_engagement('eng_ivy_b', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_ivy_b', 'Active', 'Closing');
select pg_temp.move_engagement('eng_ivy_b', 'Closing', 'Complete');
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_vendor_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_vendor_a', 'Closing', 'Complete');

select pg_temp.as_user('alice');
with e as (
  insert into app.engagements (project_id, counterparty_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('cp_v_a'), 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement', '2027-06-01')
  returning id)
insert into world select 'eng_company_a', id from e;
select pg_temp.move_engagement('eng_company_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_company_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_company_a', 'Closing', 'Complete');

select pg_temp.as_user('carol');
with r as (insert into app.ratings (engagement_id, rater_side, score, comment) values (pg_temp.id('eng_ivy_a'), 'Organization', 2, 'Late to load-in twice.') returning id)
  insert into world select 'rate_ivy_a', id from r;
with r as (insert into app.ratings (engagement_id, rater_side, score, comment) values (pg_temp.id('eng_vendor_a'), 'Organization', 3, 'Sam missed the rigging call.') returning id)
  insert into world select 'rate_sam_a', id from r;
with r as (insert into app.ratings (engagement_id, rater_side, score, comment) values (pg_temp.id('eng_company_a'), 'Organization', 1, 'Trucks arrived a day late.') returning id)
  insert into world select 'rate_company_a', id from r;
select pg_temp.as_user('xavier');
with r as (insert into app.ratings (engagement_id, rater_side, score, comment) values (pg_temp.id('eng_ivy_b'), 'Organization', 5, 'Calm and prepared.') returning id)
  insert into world select 'rate_ivy_b', id from r;
select pg_temp.as_user('ivy');
with r as (insert into app.ratings (engagement_id, rater_side, score, comment) values (pg_temp.id('eng_ivy_a'), 'Party', 4, 'Clear call sheets.') returning id)
  insert into world select 'party_ivy_a', id from r;
with r as (insert into app.ratings (engagement_id, rater_side, score) values (pg_temp.id('eng_ivy_b'), 'Party', 4) returning id)
  insert into world select 'party_ivy_b', id from r;
select pg_temp.as_user('sam');
insert into app.ratings (engagement_id, rater_side, score) values (pg_temp.id('eng_vendor_a'), 'Party', 4);
select pg_temp.as_user('victor');
insert into app.ratings (engagement_id, rater_side, score) values (pg_temp.id('eng_company_a'), 'Party', 4);

select pg_temp.as_platform();
select pg_temp.new_user('nia', 'nia@harbor.test', 'Nia Okafor');
select pg_temp.new_user('oscar', 'oscar@console.test', 'Oscar Lind');
insert into app.memberships (org_id, person_id, valid_from) values (pg_temp.id('org_b'), pg_temp.id('nia'), now() - interval '1 day');
select ok(private.rating_released(pg_temp.id('eng_ivy_a')) and private.rating_released(pg_temp.id('eng_ivy_b')), 'both of ivy''s engagements are released');

-- Off by default: another org's roles read nothing ---------------------------------------------------------------------
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.ratings where id = pg_temp.id('rate_ivy_a')), 0,
  'another org''s manager cannot read the table row of a person''s rating');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('rate_ivy_a')), 0,
  'nor through the Gateway view');
select is((select count(*)::int from api_external.ratings where rated_person_id = pg_temp.id('ivy') and rater_organization_id = pg_temp.id('org_a')), 0,
  'filtering by the person finds nothing from the other org');
select is_empty($$select 1 from api_public.person_profile_shared_ratings((select pp.handle from app.person_profiles pp where pp.person_id = (select id from world where key = 'ivy')))$$,
  'and no profile path opens without an opt-in');

select pg_temp.as_user('quinn');
select is((select count(*)::int from api_external.ratings where id in (pg_temp.id('rate_ivy_a'), pg_temp.id('rate_ivy_b'), pg_temp.id('rate_sam_a'))), 0,
  'a marketplace viewer reads no rating of a person');
select is((select count(*)::int from api_external.ratings where rated_person_id is not null), 0,
  'no other person''s row is reachable at all');

-- Inside the org and for the person ------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select count(*)::int from app.ratings where id = pg_temp.id('rate_ivy_a')), 1, 'the org that gave the rating reads it');
select is((select count(*)::int from app.ratings where id = pg_temp.id('rate_ivy_b')), 0, 'but not the other org''s rating of the same person');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('rate_ivy_a')), 1, 'its own rating also reads through the view');
select pg_temp.as_user('ivy');
select is((select count(*)::int from api_external.ratings where rated_person_id = pg_temp.id('ivy')), 2, 'the rated person reads every rating of them');
select is((select count(*)::int from app.ratings where id in (pg_temp.id('rate_ivy_a'), pg_temp.id('rate_ivy_b'))), 2, 'also from the table');
select ok((select rater_organization_name is not null from api_external.ratings where id = pg_temp.id('rate_ivy_a')), 'and sees which organization said it');

-- The supplying account, and a partner on a shared project ---------------------------------------------------------------
select pg_temp.as_user('victor');
select is((select count(*)::int from app.ratings where id = pg_temp.id('rate_sam_a')), 0, 'the account that supplied a named person does not read their rating');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('rate_sam_a')), 0, 'nor through the view');
select throws_ok($$insert into app.rating_replies (rating_id, body) values ((select id from world where key = 'rate_sam_a'), 'Sam was on time.')$$,
  '42501', null, 'nor does it answer for them');
select pg_temp.as_user('sam');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('rate_sam_a')), 1, 'the named person does');
select lives_ok($$insert into app.rating_replies (rating_id, body) values ((select id from world where key = 'rate_sam_a'), 'I covered for a sick colleague.')$$,
  'and answers it');

select pg_temp.as_user('alice');
insert into app.project_shares (project_id, partner_organization_id, project_role) values (pg_temp.id('prj_a'), pg_temp.id('org_b'), 'Coordinator');
select pg_temp.as_platform();
insert into private.project_role_capabilities (project_role, capability_code) values ('Coordinator', 'opportunities.engagement.read') on conflict do nothing;
select pg_temp.as_user('xavier');
select ok(pg_temp.id('eng_ivy_a') in (select private.internal_engagement_ids('opportunities.engagement.read')),
  'a partner holding engagement read on a shared project reads the engagement');
select is((select count(*)::int from app.ratings where id = pg_temp.id('rate_ivy_a')), 0, 'but never the person''s rating');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('rate_ivy_a')), 0, 'by any path');

-- Company ratings stay as they are ---------------------------------------------------------------------------------------
select pg_temp.as_user('quinn');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('rate_company_a')), 1, 'a company''s rating still reads for anyone signed in');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('party_ivy_a')), 1, 'so does a party''s rating of an org');
select is((select rated_person_id from api_external.ratings where id = pg_temp.id('party_ivy_a')), null::uuid, 'which names no person as rated');
select pg_temp.as_user('victor');
select is((select count(*)::int from app.ratings where id = pg_temp.id('rate_company_a')), 1, 'the company''s account owner reads its rating');

-- Opt-in: recorded, one path, withdrawn at once ------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select throws_ok($$select app.set_rating_sharing(true)$$, 'XR001', null, 'an opt-in needs the notice the person saw');
select throws_ok($$insert into app.rating_sharing_consents (person_id, notice_version, source) values ((select id from world where key = 'ivy'), '1', 'Web')$$,
  '42501', null, 'no direct write records an opt-in');
select is(app.set_rating_sharing(true, 'rating-sharing-2026-11-06'), true, 'the person opts in');
select is((select count(*)::int from app.rating_sharing_consents where withdrawn_at is null and notice_version = 'rating-sharing-2026-11-06' and captured_at is not null), 1,
  'the choice is recorded with its notice and time');
select is(app.set_rating_sharing(true, 'rating-sharing-2026-11-06'), true, 'opting in twice changes nothing');
select is((select count(*)::int from app.rating_sharing_consents), 1, 'one standing row');

select pg_temp.as_user('xavier');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('rate_ivy_a')), 0, 'an opt-in does not open the view to another org');
select is((select count(*)::int from app.ratings where id = pg_temp.id('rate_ivy_a')), 0, 'nor the table');
select is_empty($$select 1 from api_public.person_profile_shared_ratings((select pp.handle from app.person_profiles pp where pp.person_id = (select id from world where key = 'ivy')))$$,
  'and someone who decides hiring in any org reads nothing on the profile');
select pg_temp.as_user('victor');
select is_empty($$select 1 from api_public.person_profile_shared_ratings((select pp.handle from app.person_profiles pp where pp.person_id = (select id from world where key = 'ivy')))$$,
  'nor does someone who runs an external account');
select pg_temp.as_user('nia');
select is((select count(*)::int from api_public.person_profile_shared_ratings((select pp.handle from app.person_profiles pp where pp.person_id = pg_temp.id('ivy')))), 2,
  'a member of another org who decides no hiring reads all of them, low scores included');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('rate_ivy_a')), 0, 'and still nothing through the view');
reset role;
select is_empty($$select 1 from information_schema.routine_privileges where routine_schema = 'api_public' and routine_name = 'person_profile_shared_ratings' and grantee in ('anon', 'PUBLIC')$$,
  'no one signed out may call it');

select pg_temp.as_user('ivy');
select is(app.set_rating_sharing(false), false, 'the person withdraws');
select pg_temp.as_user('nia');
select is_empty($$select 1 from api_public.person_profile_shared_ratings((select pp.handle from app.person_profiles pp where pp.person_id = (select id from world where key = 'ivy')))$$,
  'withdrawal takes effect at once');
select pg_temp.as_user('ivy');
select ok((select withdrawn_at is not null from app.rating_sharing_consents limit 1), 'the record stays, closed');

-- Disputes ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('xavier');
select throws_ok($$select app.file_rating_dispute((select id from world where key = 'rate_ivy_a'), 'False Statement', 'Not true.')$$,
  '42501', null, 'only the rated person disputes a rating');
select pg_temp.as_user('ivy');
select throws_ok($$select app.file_rating_dispute((select id from world where key = 'party_ivy_a'), 'False Statement', 'Mine.')$$,
  '42501', null, 'a party''s own rating of an org is not theirs to dispute');
insert into world select 'dispute_a', app.file_rating_dispute(pg_temp.id('rate_ivy_a'), 'False Statement', 'I was on time on both days.');
select throws_ok($$select app.file_rating_dispute((select id from world where key = 'rate_ivy_a'), 'Other', 'Again.')$$,
  'XR001', null, 'one dispute per rating');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('rate_ivy_a')), 1, 'filing a dispute does not hide the rating');

select pg_temp.as_user('carol');
select is((select details from app.rating_disputes where id = pg_temp.id('dispute_a')), 'I was on time on both days.', 'the org sees the dispute');
select lives_ok($$select app.respond_to_rating_dispute((select id from world where key = 'dispute_a'), 'The call sheet shows 07:00.')$$, 'and answers it');
select throws_ok($$select app.respond_to_rating_dispute((select id from world where key = 'dispute_a'), 'Again.')$$, 'XR001', null, 'once');
select throws_ok($$select app.console_decide_rating_dispute((select id from world where key = 'dispute_a'), 'Upheld', 'Abusive Content', 'No.')$$,
  '42501', null, 'the org cannot decide its own dispute');

select pg_temp.as_platform();
insert into private.platform_operators (person_id, operator_role) select pg_temp.id('oscar'), 'Moderator';
select * from finish();
rollback;
