-- pgTAP: migrations 6145 and 6146 (RRR-248, ADR 0158).
--   * An org's rating of an individual reads only inside the org that gave it and for that person: not from another org's
--     roles, a partner on a shared project, or the account that supplied the person, through the table or api_external.
--   * Company and vendor ratings and a party's rating of an org read as before, without naming a vendor's contact.
--   * A person's opt-in is recorded, off by default and withdrawn at once, and it opens one path only: their profile, for
--     viewers who decide no hiring anywhere. It never opens the table, the view or a list across people.
--   * The rated person disputes through a route that exists; the org answers; an operator decides, on grounds that do not
--     read the score. The rating_dispute lifecycle refuses a second decision.
--   * The opt-in and the dispute route belong to the person's own session: an API key, an app or a connector records nothing,
--     and a scoped session never reads a shared rating. A company's own bid on Contractor work is a company's rating.
--   * People who manage a crew roster count as staffing: a live Advancing Lead, an artist's representative and the artist
--     themselves read no shared rating, and neither does a holder of any hiring capability, by grant or record grant.
--   * An org's soft delete of an engagement hides nothing: the person reads, answers and disputes, a shared list keeps it,
--     and a party can still rate the org.
--   * Gates: every view reading app.ratings applies the rule, every function that reads it is classified, every capability
--     in every group is classified, and so is each account role, duty and way into a roster, so a later package cannot undo
--     this unnoticed.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

-- A session an app or connector holds, and one an API key holds: scoped, though the person's own JWT shape otherwise.
create function pg_temp.as_app(p_key text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated',
    'aal', 'aal1', 'client_id', gen_random_uuid())::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.as_api_key(p_key text, p_scopes text[]) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated',
    'amr', jsonb_build_array(jsonb_build_object('method', 'xos_api_key')), 'scopes', to_jsonb(p_scopes))::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- World: ivy, a person rated by org_a and org_b. sam, the named contact on a vendor engagement of acct_v and crew acct_v
-- supplied on another engagement. nia, field staff in org_b who decide no hiring. nina, a person in no org. tess, an operator.
create temporary table k (key text primary key, txt text);
grant select, insert, update on k to public;
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
  insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('sam'), pg_temp.id('cp_v_a'), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-06-01')
  returning id)
insert into world select 'eng_sam_crew', id from e;
select pg_temp.move_engagement('eng_sam_crew', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_sam_crew', 'Active', 'Closing');
select pg_temp.move_engagement('eng_sam_crew', 'Closing', 'Complete');

select pg_temp.as_user('carol');
with r as (insert into app.ratings (engagement_id, rater_side, score, comment) values (pg_temp.id('eng_ivy_a'), 'Organization', 2, 'Late to load-in twice.') returning id)
  insert into world select 'rate_ivy_a', id from r;
with r as (insert into app.ratings (engagement_id, rater_side, score, comment) values (pg_temp.id('eng_sam_crew'), 'Organization', 3, 'Missed the rigging call.') returning id)
  insert into world select 'rate_sam_a', id from r;
with r as (insert into app.ratings (engagement_id, rater_side, score, comment) values (pg_temp.id('eng_vendor_a'), 'Organization', 1, 'Trucks arrived a day late.') returning id)
  insert into world select 'rate_vendor_a', id from r;
select pg_temp.as_user('xavier');
with r as (insert into app.ratings (engagement_id, rater_side, score, comment) values (pg_temp.id('eng_ivy_b'), 'Organization', 5, 'Calm and prepared.') returning id)
  insert into world select 'rate_ivy_b', id from r;
select pg_temp.as_user('ivy');
with r as (insert into app.ratings (engagement_id, rater_side, score, comment) values (pg_temp.id('eng_ivy_a'), 'Party', 4, 'Clear call sheets.') returning id)
  insert into world select 'party_ivy_a', id from r;
with r as (insert into app.ratings (engagement_id, rater_side, score) values (pg_temp.id('eng_ivy_b'), 'Party', 4) returning id)
  insert into world select 'party_ivy_b', id from r;
select pg_temp.as_user('sam');
insert into app.ratings (engagement_id, rater_side, score) values (pg_temp.id('eng_sam_crew'), 'Party', 4);
select pg_temp.as_user('victor');
insert into app.ratings (engagement_id, rater_side, score) values (pg_temp.id('eng_vendor_a'), 'Party', 4);

select pg_temp.as_platform();
select pg_temp.new_user('nia', 'nia@harbor.test', 'Nia Okafor');
select pg_temp.join_org('xavier', 'org_b', 'nia', 'field');
select pg_temp.new_user('tess', 'tess@platform.test', 'Tess Morales');
select pg_temp.as_platform();
select private.grant_platform_operator('tess@platform.test', 'Trust and Safety', 'Moderation.');
select pg_temp.as_user('ivy');
select app.ensure_my_profile();
update app.person_profiles set visibility = 'Public';
insert into k select 'ivy', handle from app.person_profiles;
select pg_temp.as_platform();
select ok(private.rating_released(pg_temp.id('eng_ivy_a')) and private.rating_released(pg_temp.id('eng_ivy_b')), 'both of ivy''s engagements are released');
insert into k select 'ivy_a_released', released_at::text from private.rating_releases where engagement_id = pg_temp.id('eng_ivy_a');

-- Off by default: another org's roles read nothing ---------------------------------------------------------------------
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.ratings where id = pg_temp.id('rate_ivy_a')), 0,
  'another org''s manager cannot read the table row of a person''s rating');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('rate_ivy_a')), 0,
  'nor through the Gateway view');
select is((select count(*)::int from api_external.ratings where rated_person_id = pg_temp.id('ivy') and rater_organization_id = pg_temp.id('org_a')), 0,
  'filtering by the person finds nothing from the other org');
select is_empty($$select 1 from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))$$,
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
select is((select count(*)::int from app.ratings where id = pg_temp.id('rate_sam_a')), 0, 'the account that supplied crew does not read their rating');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('rate_sam_a')), 0, 'nor through the view');
select throws_ok($$insert into app.rating_replies (rating_id, body) values ((select id from world where key = 'rate_sam_a'), 'Sam was on time.')$$,
  '42501', null, 'nor does it answer for them');
select pg_temp.as_user('sam');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('rate_sam_a')), 1, 'the named person does');
select lives_ok($$insert into app.rating_replies (rating_id, body) values ((select id from world where key = 'rate_sam_a'), 'I covered for a sick colleague.')$$,
  'and answers it');

select pg_temp.as_user('alice');
insert into app.project_shares (project_id, partner_organization_id, project_role) values (pg_temp.id('prj_a'), pg_temp.id('org_b'), 'Coordinator');
select set_config('role', 'postgres', true);
-- Shared project roles carry no engagement read today; this proves the rule does not rest on that.
insert into private.project_role_capabilities (project_role, capability_code) values ('Coordinator', 'opportunities.engagement.read') on conflict do nothing;
select pg_temp.as_user('xavier');
select set_config('role', 'postgres', true);
select ok(pg_temp.id('eng_ivy_a') in (select private.internal_engagement_ids('opportunities.engagement.read')),
  'a partner holding engagement read on a shared project reads the engagement');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.ratings where id = pg_temp.id('rate_ivy_a')), 0, 'but never the person''s rating');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('rate_ivy_a')), 0, 'by any path');
select is((select released_at::text from app.rating_release_times where engagement_id = pg_temp.id('eng_ivy_a')), (select txt from k where key = 'ivy_a_released'),
  'API v1''s release time still reads for the partner, from the release record rather than from both ratings');

-- Company and vendor ratings stay as they are ---------------------------------------------------------------------------
select pg_temp.as_user('quinn');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('rate_vendor_a')), 1, 'a vendor''s rating still reads for anyone signed in, low score included');
select is((select rated_organization_id from api_external.ratings where id = pg_temp.id('rate_vendor_a')), pg_temp.id('acct_v'), 'naming the account');
select is((select rated_person_id from api_external.ratings where id = pg_temp.id('rate_vendor_a')), null::uuid, 'and not the contact on it');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('party_ivy_a')), 1, 'a party''s rating of an org still reads too');
select pg_temp.as_user('victor');
select is((select count(*)::int from app.ratings where id = pg_temp.id('rate_vendor_a')), 1, 'the vendor''s account owner reads its rating');
select pg_temp.as_user('sam');
select is((select rated_person_id from api_external.ratings where id = pg_temp.id('rate_vendor_a')), pg_temp.id('sam'), 'the named contact still finds it on their profile');

-- A company's own bid on work a person could do alone stays a company's rating -------------------------------------------
select pg_temp.as_user('carol');
with o as (insert into app.opportunities (project_id, role_type, role_code, title, visibility, starts_on)
  values (pg_temp.id('prj_a'), 'Contractor', '5000.51.02', 'Summer Series Rigging Contract', 'Invited', '2027-06-01') returning id)
insert into world select 'opp_rig', id from o;
insert into app.opportunity_invitations (opportunity_id, organization_id) values (pg_temp.id('opp_rig'), pg_temp.id('acct_v'));
select app.transition_opportunity(pg_temp.id('opp_rig'), 'Draft', 'Pending Approval', 'Ready.');
select app.transition_opportunity(pg_temp.id('opp_rig'), 'Pending Approval', 'Published', 'Approved.');
select pg_temp.as_user('victor');
with a as (insert into app.applications (opportunity_id, applicant_organization_id) values (pg_temp.id('opp_rig'), pg_temp.id('acct_v')) returning id)
insert into world select 'app_rig', id from a;
select pg_temp.as_user('carol');
select app.transition_application(pg_temp.id('app_rig'), 'Submitted', 'In Review', 'Shortlisted.');
with o as (select app.send_offer(pg_temp.id('app_rig'), 'Flat', 1500000, 'USD', null, null, null, null) as id)
insert into world select 'offer_rig', id from o;
select pg_temp.as_user('victor');
select app.accept_offer(pg_temp.id('offer_rig'));
select pg_temp.as_user('carol');
-- app.create_engagement_from_application names only the account, since an application has one applicant. An engagement made
-- from the same application directly may also name a contact, which the application guard allows.
with e as (
  insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date, application_id)
  values (pg_temp.id('prj_a'), pg_temp.id('victor'), pg_temp.id('cp_v_a'), 'Contractor', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-06-01', pg_temp.id('app_rig'))
  returning id)
insert into world select 'eng_rig', id from e;
select pg_temp.as_platform();
select ok(not private.rating_is_of_individual('Contractor', null, pg_temp.id('cp_v_a'), pg_temp.id('app_rig')),
  'a company''s winning bid on Contractor work names only the account, so its rating is the company''s');
select ok((select person_id is not null and counterparty_id is not null and role_type = 'Contractor' from app.engagements where id = pg_temp.id('eng_rig')),
  'and when the engagement also names a contact');
select pg_temp.move_engagement('eng_rig', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_rig', 'Active', 'Closing');
select pg_temp.move_engagement('eng_rig', 'Closing', 'Complete');
select pg_temp.as_user('carol');
with r as (insert into app.ratings (engagement_id, rater_side, score, comment) values (pg_temp.id('eng_rig'), 'Organization', 2, 'Load-in ran long.') returning id)
  insert into world select 'rate_rig', id from r;
select pg_temp.as_user('victor');
insert into app.ratings (engagement_id, rater_side, score) values (pg_temp.id('eng_rig'), 'Party', 4);
select pg_temp.as_user('quinn');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('rate_rig') and not is_of_individual), 1,
  'so its rating reads for anyone signed in, as a company''s');
select is((select rated_person_id from api_external.ratings where id = pg_temp.id('rate_rig')), null::uuid, 'naming no person');
select pg_temp.as_user('fiona');
select is((select count(*)::int from app.ratings where id = pg_temp.id('rate_rig')), 0, 'an account member who does not run it reads it only through the view');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('rate_rig')), 1, 'like everyone else');
select pg_temp.as_user('victor');
select is((select count(*)::int from app.ratings where id = pg_temp.id('rate_rig')), 1, 'the account owner reads and may answer it');
select throws_ok($$select app.file_rating_dispute((select id from world where key = 'rate_rig'), 'False Statement', 'Not me.')$$,
  '42501', null, 'and whoever clicked submit cannot dispute it as a rating of them');
select pg_temp.as_user('sam');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('rate_sam_a') and is_of_individual), 1,
  'while crew an account supplied, with no bid behind it, stays an individual');

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
select is_empty($$select 1 from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))$$,
  'and someone who decides hiring in any org reads nothing on the profile');
select pg_temp.as_user('gina');
select is_empty($$select 1 from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))$$,
  'nor does a viewer who can read applications');
select pg_temp.as_user('victor');
select is_empty($$select 1 from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))$$,
  'nor does someone who runs an external account');
select pg_temp.as_user('nia');
select is((select count(*)::int from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))), 2,
  'a member of another org who decides no hiring reads all of them, low scores included');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('rate_ivy_a')), 0, 'and still nothing through the view');
select pg_temp.as_platform();
select is_empty($$select 1 from information_schema.routine_privileges where routine_schema = 'api_public' and routine_name = 'person_profile_shared_ratings' and grantee in ('anon', 'PUBLIC')$$,
  'no one signed out may call it');

-- The hiring gate holds in a scoped session, and for a capability held any way at all.
select pg_temp.as_app('nia');
select is_empty($$select 1 from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))$$,
  'an app''s session never reads a shared rating, even for someone who decides no hiring');
select pg_temp.as_app('xavier');
select is_empty($$select 1 from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))$$,
  'and a hirer''s narrowly scoped app does not open the gate');
select pg_temp.as_api_key('xavier', array['docs']);
select is_empty($$select 1 from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))$$,
  'nor does an API key scoped away from hiring');
select pg_temp.as_platform();
with g as (
  insert into app.user_capability_grants (membership_id, capability_code, scope_kind, scope_id, reason)
  select m.id, 'crew.swap.approve', 'project', pg_temp.id('prj_b'), 'Covers the shift desk.'
  from app.memberships m where m.person_id = pg_temp.id('nia') returning id)
insert into world select 'nia_grant', id from g;
select pg_temp.as_user('nia');
select is_empty($$select 1 from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))$$,
  'a project-scoped grant of one hiring capability closes it too');
select pg_temp.as_platform();
update app.user_capability_grants set deleted_at = now() where id = pg_temp.id('nia_grant');
select pg_temp.as_user('nia');
select is((select count(*)::int from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))), 2, 'and ending it opens it again');

-- Every capability on the list closes it, by a grant at any scope and by a record grant on anything.
create function pg_temp.reads_with_grant(p_code text) returns int
language plpgsql as $$
declare
  v_id uuid;
  v_count int;
begin
  perform pg_temp.as_platform();
  insert into app.user_capability_grants (membership_id, capability_code, reason)
  select m.id, p_code, 'Covers the desk.' from app.memberships m where m.person_id = pg_temp.id('nia') returning id into v_id;
  perform pg_temp.as_user('nia');
  select count(*)::int into v_count from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'));
  perform pg_temp.as_platform();
  update app.user_capability_grants set deleted_at = now() where id = v_id;
  return v_count;
end $$;
create function pg_temp.reads_with_record_grant(p_code text) returns int
language plpgsql as $$
declare
  v_id uuid;
  v_count int;
begin
  perform pg_temp.as_platform();
  insert into app.record_grants (target_kind, target_id, capability_code, grantee_person_id, valid_to, reason)
  values ('workspace', pg_temp.id('ws_a'), p_code, pg_temp.id('nia'), now() + interval '1 day', 'Covers the desk.') returning id into v_id;
  perform pg_temp.as_user('nia');
  select count(*)::int into v_count from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'));
  perform pg_temp.as_platform();
  update app.record_grants set deleted_at = now() where id = v_id;
  return v_count;
end $$;
select pg_temp.as_platform();
select is_empty($$select c from unnest(private.hiring_capability_codes()) c where pg_temp.reads_with_grant(c) <> 0$$,
  'a grant of any capability on the list closes the profile, the three roster and membership ones included');
select is(pg_temp.reads_with_record_grant('advancing.submission.review'), 0, 'and so does a record grant of one, on a target that is not a project');
select is(pg_temp.reads_with_grant('crew.shift.read'), 2, 'while one that decides nothing leaves it open');
select pg_temp.as_user('nia');
select is((select count(*)::int from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))), 2, 'and nia is back where she started');

-- The people who manage a roster on the external side.
select pg_temp.as_user('sam');
select is((select count(*)::int from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))), 2, 'an account member with no duty reads them');
select pg_temp.as_user('alice');
with e as (
  insert into app.engagements (project_id, counterparty_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('cp_v_a'), 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement', '2027-06-01')
  returning id)
insert into world select 'eng_v_live', id from e;
select pg_temp.as_platform();
insert into world select 'sam_in_acct_v', m.id from app.account_memberships m where m.org_id = pg_temp.id('acct_v') and m.person_id = pg_temp.id('sam');
select pg_temp.as_user('victor');
select app.assign_engagement_member(pg_temp.id('eng_v_live'), pg_temp.id('sam_in_acct_v'), 'Advancing Lead');
select pg_temp.as_user('sam');
select set_config('role', 'postgres', true);
select ok(private.can_manage_roster(pg_temp.id('eng_v_live')), 'an Advancing Lead manages that engagement''s roster');
select pg_temp.as_user('sam');
select is_empty($$select 1 from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))$$,
  'so reads no shared rating, with no other access');
select pg_temp.as_user('victor');
select app.assign_engagement_member(pg_temp.id('eng_v_live'), pg_temp.id('sam_in_acct_v'), 'Member');
select pg_temp.as_user('sam');
select set_config('role', 'postgres', true);
select ok(not private.can_manage_roster(pg_temp.id('eng_v_live')), 'a Member duty manages nothing');
select pg_temp.as_user('sam');
select is((select count(*)::int from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))), 2, 'so it leaves the profile open');

select pg_temp.as_platform();
select pg_temp.new_user('rory', 'rory@lumen-artists.test', 'Rory Blake');
select pg_temp.new_user('ava', 'ava@performer.test', 'Ava Lindqvist');
select pg_temp.as_user('rita');
select app.add_account_member(pg_temp.id('acct_t'), pg_temp.id('rory'), 'Account Member');
select pg_temp.as_user('rory');
select app.accept_account_membership((select m.id from app.account_memberships m where m.org_id = pg_temp.id('acct_t') and m.person_id = pg_temp.id('rory')));
select is((select count(*)::int from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))), 2, 'a member of an agency who represents no one reads them');
select pg_temp.as_user('rita');
insert into world values ('rep_ava', app.propose_representation(pg_temp.id('acct_t'), pg_temp.id('ava'), pg_temp.id('rory'), (current_date + 365), array['Offers']::app.representation_scope[]));
select pg_temp.as_user('rory');
select is((select count(*)::int from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))), 2, 'a representation the artist has not accepted opens nothing and closes nothing');
select pg_temp.as_user('ava');
select app.accept_representation(pg_temp.id('rep_ava'));
select pg_temp.as_user('rory');
select is_empty($$select 1 from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))$$,
  'an artist''s representative with the Offers scope reads no shared rating');
select pg_temp.as_user('rita');
select app.revoke_representation(pg_temp.id('rep_ava'));
insert into world values ('rep_ava2', app.propose_representation(pg_temp.id('acct_t'), pg_temp.id('ava'), pg_temp.id('rory'), (current_date + 365), array['Advance']::app.representation_scope[]));
select pg_temp.as_user('ava');
select app.accept_representation(pg_temp.id('rep_ava2'));
select pg_temp.as_user('rory');
select is_empty($$select 1 from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))$$,
  'nor does one with the Advance scope, who manages the roster');
select pg_temp.as_user('rita');
select app.revoke_representation(pg_temp.id('rep_ava2'));
select pg_temp.as_user('rory');
select is((select count(*)::int from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))), 2, 'and revoking it opens it again');

select pg_temp.as_user('art');
select set_config('role', 'postgres', true);
select ok(private.can_manage_roster(pg_temp.id('eng_art_a')), 'an artist manages their own roster');
select pg_temp.as_user('art');
select is_empty($$select 1 from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))$$,
  'so reads no shared rating');
select pg_temp.as_user('quinn');
select is((select count(*)::int from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))), 2, 'while a freelancer with no roster to manage does');

-- An org's soft delete of the engagement hides nothing from the rated person -----------------------------------------------
select pg_temp.as_user('alice');
update app.engagements set deleted_at = now() where id = pg_temp.id('eng_ivy_a');
select pg_temp.as_platform();
select ok((select deleted_at is not null from app.engagements where id = pg_temp.id('eng_ivy_a')), 'a member with engagement write can soft-delete a completed engagement');
select pg_temp.as_user('ivy');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('rate_ivy_a') and is_of_individual), 1, 'the person still reads the rating, disputable, through the view');
select is((select count(*)::int from app.ratings where id = pg_temp.id('rate_ivy_a')), 1, 'and the table');
select is((select count(*)::int from app.ratings where id = pg_temp.id('party_ivy_a')), 1, 'and their own rating of the org');
select lives_ok($$insert into app.rating_replies (rating_id, body) values ((select id from world where key = 'rate_ivy_a'), 'I was there at 07:00.')$$, 'and still answers it');
select pg_temp.as_user('nia');
select is((select count(*)::int from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))), 2, 'the rating stays on the shared list');
select is((select count(*)::int from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy')) where score = 2), 1, 'low score and all');
select is((select reply from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy')) where score = 2), 'I was there at 07:00.', 'with the person''s answer');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.ratings where id = pg_temp.id('rate_ivy_a')), 1, 'the org reads what it gave, as before');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.ratings where id = pg_temp.id('rate_ivy_a')), 0, 'and it opens nothing to another org');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('rate_ivy_a')), 0, 'through the view either');

-- Nor can an org stop a party rating it by deleting the engagement.
select pg_temp.move_engagement('eng_quinn_b', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_quinn_b', 'Active', 'Closing');
select pg_temp.move_engagement('eng_quinn_b', 'Closing', 'Complete');
select pg_temp.as_user('xavier');
update app.engagements set deleted_at = now() where id = pg_temp.id('eng_quinn_b');
select pg_temp.as_user('quinn');
select lives_ok($$insert into app.ratings (engagement_id, rater_side, score) values ((select id from world where key = 'eng_quinn_b'), 'Party', 1)$$,
  'a party still rates the org after it soft-deleted the engagement');
select pg_temp.as_platform();
update app.engagements set deleted_at = null where id = pg_temp.id('eng_quinn_b');

-- Only the person's own session chooses.
select pg_temp.as_app('ivy');
select throws_ok($$select app.set_rating_sharing(false)$$, '42501', null, 'an app cannot withdraw for the person');
select pg_temp.as_api_key('ivy', array['opportunities']);
select throws_ok($$select app.set_rating_sharing(false)$$, '42501', null, 'nor can an API key');
select pg_temp.as_user('ivy');
select is(app.set_rating_sharing(false), false, 'the person withdraws');
select pg_temp.as_app('ivy');
select throws_ok($$select app.set_rating_sharing(true, 'x')$$, '42501', null, 'an app or connector token cannot record an opt-in');
select pg_temp.as_api_key('ivy', array['opportunities']);
select throws_ok($$select app.set_rating_sharing(true, 'x')$$, '42501', null, 'nor can an API key');
select pg_temp.as_user('ivy');
select is((select count(*)::int from app.rating_sharing_consents where withdrawn_at is null), 0, 'and neither records anything');
select pg_temp.as_user('nia');
select is_empty($$select 1 from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))$$,
  'withdrawal takes effect at once');
select pg_temp.as_user('ivy');
select ok((select withdrawn_at is not null from app.rating_sharing_consents limit 1), 'the record stays, closed');

-- Disputes ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_app('ivy');
select throws_ok($$select app.file_rating_dispute((select id from world where key = 'rate_ivy_a'), 'False Statement', 'From an app.')$$,
  '42501', null, 'an app cannot spend the person''s one dispute');
select pg_temp.as_user('xavier');
select throws_ok($$select app.file_rating_dispute((select id from world where key = 'rate_ivy_a'), 'False Statement', 'Not true.')$$,
  '42501', null, 'only the rated person disputes a rating');
select pg_temp.as_user('ivy');
select throws_ok($$select app.file_rating_dispute((select id from world where key = 'party_ivy_a'), 'False Statement', 'Mine.')$$,
  '42501', null, 'a party''s own rating of an org is not theirs to dispute');
insert into world select 'dispute_a', app.file_rating_dispute(pg_temp.id('rate_ivy_a'), 'False Statement', 'I was on time on both days.');
select ok(pg_temp.id('dispute_a') is not null, 'the dispute route stays open though the org soft-deleted the engagement');
select throws_ok($$select app.file_rating_dispute((select id from world where key = 'rate_ivy_a'), 'Other', 'Again.')$$,
  'XR001', null, 'one dispute per rating');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('rate_ivy_a')), 1, 'filing a dispute does not hide the rating');
select pg_temp.as_platform();
update app.engagements set deleted_at = null where id = pg_temp.id('eng_ivy_a');
select pg_temp.as_user('ivy');

select pg_temp.as_app('carol');
select throws_ok($$select app.respond_to_rating_dispute((select id from world where key = 'dispute_a'), 'From a connector.')$$,
  '42501', null, 'an app cannot spend the org''s one answer');
select pg_temp.as_user('carol');
select is((select dispute_details from app.rating_disputes where id = pg_temp.id('dispute_a')), 'I was on time on both days.', 'the org sees the dispute');
select results_eq($$select party_name, rating_score::int, rating_comment from app.rating_dispute_subjects() where dispute_id = (select id from world where key = 'dispute_a')$$,
  $$values ('Ivy Marchetti', 2, 'Late to load-in twice.')$$, 'and which rating it is about');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.rating_dispute_subjects() where dispute_id = pg_temp.id('dispute_a')), 0, 'no other org reads what a dispute is about');
select pg_temp.as_user('carol');
select lives_ok($$select app.respond_to_rating_dispute((select id from world where key = 'dispute_a'), 'The call sheet shows 07:00.')$$, 'and answers it');
select throws_ok($$select app.respond_to_rating_dispute((select id from world where key = 'dispute_a'), 'Again.')$$, 'XR001', null, 'once');
select throws_ok($$select app.console_decide_rating_dispute((select id from world where key = 'dispute_a'), 'Upheld', 'Abusive Content', 'No.')$$,
  '42501', null, 'the org cannot decide its own dispute');

create function pg_temp.as_op(p_key text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

select pg_temp.as_op('tess');
select is((select dispute_state::text from app.console_rating_dispute_queue() where dispute_id = pg_temp.id('dispute_a')), 'Open', 'the operator sees the open dispute');
select ok(not (app.console_rating_dispute_detail(pg_temp.id('dispute_a')) ? 'score'), 'the detail never carries the score');
select is_empty($$select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'app' and p.proname in ('console_rating_dispute_queue', 'console_rating_dispute_detail', 'console_decide_rating_dispute')
    and p.prosrc ~ '\.score\M'$$, 'no console dispute function reads the score');
select throws_ok($$select app.console_decide_rating_dispute((select id from world where key = 'dispute_a'), 'Upheld', 'Other', 'It is low.')$$,
  'XR001', null, 'upholding needs a named ground, not Other');
select throws_ok($$select app.console_decide_rating_dispute((select id from world where key = 'dispute_a'), 'Upheld', null, 'It is low.')$$,
  'XR001', null, 'nor no ground at all');
select lives_ok($$select app.console_decide_rating_dispute((select id from world where key = 'dispute_a'), 'Upheld', 'False Statement', 'Call sheets show you were on time.')$$,
  'the operator upholds it');
select throws_ok($$select app.console_decide_rating_dispute((select id from world where key = 'dispute_a'), 'Not Upheld', null, 'Changed my mind.')$$,
  'XR001', 'rating_dispute_transition_not_allowed: A rating dispute cannot move from Upheld to Not Upheld.', 'a decided dispute cannot move again');

select pg_temp.as_user('ivy');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('rate_ivy_a')), 0, 'an upheld dispute removes the rating for the person');
select is((select dispute_state::text from app.rating_disputes where id = pg_temp.id('dispute_a')), 'Upheld', 'who still sees what became of the dispute');
select is((select decision_statement from app.rating_disputes where id = pg_temp.id('dispute_a')), 'Call sheets show you were on time.', 'with the reasons');
select throws_ok($$select decided_by from app.rating_disputes$$, '42501', null, 'and never who decided');
select is((select count(*)::int from app.rating_dispute_state_transitions where rating_dispute_id = pg_temp.id('dispute_a')), 2, 'the ledger reads for the person');
select throws_ok($$select created_by from app.rating_dispute_state_transitions$$, '42501', null, 'without who decided');
select results_eq($$select org_name, rating_score::int, rating_comment from app.rating_dispute_subjects() where dispute_id = (select id from world where key = 'dispute_a')$$,
  $$values ('Northwind Live', null::int, null::text)$$, 'the person can still tell which rating it was, not what it said');
select is((select count(*)::int from app.notifications where kind = 'rating_dispute.decided' and recipient_person_id = pg_temp.id('ivy')), 1, 'the person is told');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.ratings where id = pg_temp.id('rate_ivy_a')), 0, 'and for the org');
select is((select released_at::text from app.rating_release_times where engagement_id = pg_temp.id('eng_ivy_a')), (select txt from k where key = 'ivy_a_released'),
  'the org still reads when the ratings were released, though its own rating was removed');
select is((select count(*)::int from app.rating_disputes where id = pg_temp.id('dispute_a')), 1, 'which still sees the dispute');
select results_eq($$select party_name, rating_score::int, rating_comment from app.rating_dispute_subjects() where dispute_id = (select id from world where key = 'dispute_a')$$,
  $$values ('Ivy Marchetti', null::int, null::text)$$, 'and can still tell who it was about, without the removed words');
select is((select count(*)::int from app.notifications where kind = 'rating_dispute.filed' and recipient_person_id = pg_temp.id('carol')), 1, 'the org was told when it was filed');
select is((select count(*)::int from app.notifications where kind = 'rating_dispute.decided' and recipient_person_id = pg_temp.id('carol')), 1, 'and when it was decided');
select pg_temp.as_platform();
select is((select score::int from app.ratings where id = pg_temp.id('rate_ivy_a')), 2, 'the rating row itself is not edited');

-- Not upheld, and neither the score nor who files changes the rule.
select pg_temp.as_user('ivy');
insert into world select 'dispute_b', app.file_rating_dispute(pg_temp.id('rate_ivy_b'), 'Other', 'I would like this gone.');
select pg_temp.as_op('tess');
select lives_ok($$select app.console_decide_rating_dispute((select id from world where key = 'dispute_b'), 'Not Upheld', null, 'Nothing here breaks a rule.')$$, 'the operator does not uphold');
select pg_temp.as_user('ivy');
select is((select count(*)::int from api_external.ratings where id = pg_temp.id('rate_ivy_b')), 1, 'the rating stays');
select is((select decision_ground from app.rating_disputes where id = pg_temp.id('dispute_b')), null::app.rating_dispute_ground, 'with no ground recorded');

-- Separation of duties, while the org that gave the rating is read-only ------------------------------------------------
select pg_temp.as_platform();
select pg_temp.join_org('alice', 'org_a', 'sam', 'manager');
select pg_temp.as_platform();
select pg_temp.join_org('alice', 'org_a', 'tess', 'field');
select pg_temp.new_user('uma', 'uma@platform.test', 'Uma Reyes');
select pg_temp.as_platform();
select private.grant_platform_operator('uma@platform.test', 'Trust and Safety', 'Moderation.');
insert into app.org_cancellations (org_id, canceled_at, read_only_until, purge_after, reason)
values (pg_temp.id('org_a'), now(), now() + interval '30 days', now() + interval '90 days', 'Season over.');
select pg_temp.as_user('sam');
select lives_ok($$select app.file_rating_dispute((select id from world where key = 'rate_sam_a'), 'Wrong Person', 'Someone else ran that call.')$$,
  'a person still disputes a rating while the org that gave it is read-only');
select throws_ok(format($$select app.respond_to_rating_dispute((select id from app.rating_disputes where rating_id = %L), 'I say so.')$$, pg_temp.id('rate_sam_a')),
  'XR001', 'sod_rating_dispute_answer: A person cannot answer their own dispute for the organization. Someone else with rating access answers.',
  'and a rated person who is also a manager there never answers for the org');
select pg_temp.as_op('tess');
select throws_ok(format($$select app.console_decide_rating_dispute((select d.dispute_id from app.console_rating_dispute_queue() d where d.org_id = %L and d.dispute_state = 'Open' limit 1), 'Not Upheld', null, 'Mine to call.')$$, pg_temp.id('org_a')),
  'XR001', 'sod_rating_dispute_decide: Another operator decides this dispute: you belong to the organization that gave the rating.',
  'an operator who belongs to the rating org never decides it');
select ok(not (app.console_rating_dispute_detail((select d.dispute_id from app.console_rating_dispute_queue() d where d.org_id = pg_temp.id('org_a') and d.dispute_state = 'Open' limit 1)) ->> 'decidable_by_me')::boolean,
  'and the console says so');
select pg_temp.as_op('uma');
select lives_ok(format($$select app.console_decide_rating_dispute((select d.dispute_id from app.console_rating_dispute_queue() d where d.org_id = %L and d.dispute_state = 'Open' limit 1), 'Not Upheld', null, 'Nothing here breaks a rule.')$$, pg_temp.id('org_a')),
  'another operator decides it, read-only org or not');
select pg_temp.as_platform();
select is_empty($$select code from unnest(array['sod_rating_dispute_answer', 'sod_rating_dispute_decide']) code where code not in (select r.code from private.separation_of_duties_rules r)$$,
  'both rules are registered');

-- Gates: a later package cannot undo this unnoticed ---------------------------------------------------------------------
select set_config('role', 'postgres', true);
-- An owner-rights view skips row level security, so any view that reads app.ratings carries the rule itself. Two are
-- exempt: app.engagement_board only says whether a rating exists on the reader's engagements, and
-- api_external.my_given_ratings returns only the ratings the signed-in party gave.
select is_empty($$
  select format('%I.%I', n.nspname, c.relname)
  from pg_depend d
  join pg_rewrite rw on rw.oid = d.objid
  join pg_class c on c.oid = rw.ev_class
  join pg_namespace n on n.oid = c.relnamespace
  where d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_class'::regclass and d.refobjid = 'app.ratings'::regclass
    and c.relkind in ('v', 'm')
    and not coalesce('security_invoker=true' = any (c.reloptions), false)
    and format('%I.%I', n.nspname, c.relname) not in ('app.engagement_board', 'api_external.my_given_ratings')
    and not (pg_get_viewdef(c.oid) ~ 'internal_rating_engagement_ids' and pg_get_viewdef(c.oid) ~ 'removed_rating_ids')
$$, 'every owner-rights view of app.ratings applies the org''s rule and leaves out removed ratings');
-- Each function that reads the table is classified here; a new one must be added after reading what it returns.
select is_empty($$
  select format('%I.%I', n.nspname, p.proname)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('app', 'api_public', 'api_external', 'private', 'xpms')
    and p.prosrc ~ 'app\.ratings\M'
    and format('%I.%I', n.nspname, p.proname) not in (
      'api_public.person_profile_shared_ratings', 'app.console_decide_rating_dispute', 'app.console_rating_dispute_detail',
      'app.file_rating_dispute', 'app.rating_dispute_subjects', 'app.respond_to_rating_dispute', 'private.guard_rating_reply',
      'private.org_rating_ids', 'private.readable_rating_ids', 'private.release_ratings')
$$, 'every function that reads app.ratings has been classified');
-- Every capability in every group is on the list or, here, off it for a stated reason. These groups run the show, the books or
-- the person's own settings and decide nothing about who is hired, booked or put on a shift or roster.
select is_empty($$
  select c.code from app.capabilities c
  where c.code <> all (private.hiring_capability_codes())
    and split_part(c.code, '.', 1) not in (
      'activity', 'assets', 'audit', 'canon', 'credentials', 'data', 'finance', 'home', 'hospitality', 'inbox', 'knowledge', 'logistics', 'me', 'my_work', 'places', 'reports', 'safety', 'schedule', 'show')
    -- In the groups that do hire, these read, run time and pay, give the org's own rating or configure things.
    and c.code not in (
      'advancing.packet.read', 'advancing.packet.send', 'advancing.packet.write', 'advancing.reconciliation.write',
      'advancing.rider.write', 'crew.pay_period.manage', 'crew.payroll.export', 'crew.rate_card.read',
      'crew.rate_card.write', 'crew.schedule.read', 'crew.shift.read', 'crew.swap.request', 'crew.time_entry.read',
      'crew.time_entry.write', 'crew.time_off.approve', 'crew.time_off.request', 'crew.timesheet.approve',
      'crew.timesheet.read', 'crew.timesheet.submit', 'opportunities.engagement.read',
      'opportunities.marketplace.manage', 'opportunities.posting.read', 'opportunities.rating.write',
      'org.access_reviews.manage', 'org.ai.write', 'org.api_keys.manage', 'org.approval_policies.write',
      'org.automations.write', 'org.billing.manage', 'org.billing.read', 'org.break_glass.use',
      'org.communication.write', 'org.custom_fields.write', 'org.custom_objects.write', 'org.departments.write',
      'org.general.write', 'org.help.write', 'org.integrations.manage', 'org.legal.accept', 'org.legal.read',
      'org.legal_entities.write', 'org.localization.write', 'org.locations.write', 'org.members.read',
      'org.modules.write', 'org.notifications.write', 'org.numbering.write', 'org.organization.archive',
      'org.organization.delete', 'org.ownership.transfer', 'org.partner.manage', 'org.payroll.write',
      'org.profile.write', 'org.scheduling.write', 'org.security.write', 'org.separation_of_duties.write',
      'org.settings.read', 'org.spend_authority.write', 'org.support_session.grant', 'org.teams.manage',
      'org.templates.write', 'org.time_attendance.write', 'org.usage.read', 'org.view_as_role.use', 'org.views.write',
      'org.webhooks.manage', 'org.white_label.write', 'org.workspaces.manage', 'people.agreement.write',
      'people.certification.read', 'people.certification.verify', 'people.certification.write',
      'people.directory.read', 'people.profile.read', 'people.profile.write', 'people.requisition.read',
      'procurement.catalog.read', 'procurement.catalog.write', 'procurement.invoice_match.write',
      'procurement.po.read', 'procurement.po.send', 'procurement.receipt.write', 'procurement.rfq.read',
      'procurement.rfq.write', 'projects.gate.evidence.write', 'projects.gate.read', 'projects.gate.transition',
      'projects.project.archive', 'projects.project.create', 'projects.project.export', 'projects.project.read',
      'projects.project.write', 'projects.scope.write', 'projects.settings.write', 'projects.template.write',
      'vendors.bank_details.write', 'vendors.class.write', 'vendors.coi.write', 'vendors.entitlement.write',
      'vendors.scorecard.write', 'vendors.vendor.read', 'work.punch_list.write', 'work.record.export',
      'work.record.read', 'work.record.write', 'work.recurring.write', 'work.work_order.read', 'work.work_order.write')
$$, 'every capability in every group is classified');
select is_empty($$select c from unnest(private.hiring_capability_codes()) c where c not in (select code from app.capabilities)$$,
  'every hiring capability exists');
-- The external side: every way into a roster, and each account role and duty, is classified. A new one fails here until it is
-- read against private.viewer_decides_hiring.
select is((select count(*)::int from pg_proc p, regexp_matches(p.prosrc, '''roster''', 'g')
           where p.oid = 'private.engagement_party_areas(uuid, uuid, uuid, app.external_role_type)'::regprocedure), 4,
  'private.engagement_party_areas opens a roster the four ways the hiring gate counts: the artist or solo person, an account owner or admin, an Advancing Lead, an Advance representative');
select is(enum_range(null::app.account_role)::text[], array['Account Owner', 'Account Admin', 'Account Finance', 'Account Member'],
  'every account role is classified: owners and admins count as staffing, finance and members do not');
select is(enum_range(null::app.account_engagement_duty)::text[], array['Advancing Lead', 'Member'],
  'every account duty is classified: an Advancing Lead counts as staffing, a Member does not');
-- Who is rated: a new external role type would otherwise count as a company and read for anyone signed in, so it fails here
-- until it is read against private.rating_is_of_individual.
select is(enum_range(null::app.external_role_type)::text[],
  array['Client', 'Vendor', 'Contractor', 'Crew', 'Staff', 'Artist', 'Artist Representative', 'Sponsor'],
  'every external role type is classified: Contractor, Crew, Staff and Artist work can be an individual''s, the rest is a company''s');

-- Account deletion knows about the opt-in, and a deleted account withdraws it ---------------------------------------------
select ok('app.rating_sharing_consents' = any (private.account_deletion_tables()), 'a legal hold naming the opt-in record blocks the deletion that writes to it');
select is((select time_column from private.retention_policies where table_name = 'app.rating_sharing_consents'), 'withdrawn_at', 'a closed opt-in goes 7 years after it closed');
select ok(exists (select 1 from private.personal_data_keys where json_key = 'dispute_details'), 'what a person wrote in a dispute is redacted from the audit trail like other free text');
select pg_temp.as_user('ivy');
select app.set_rating_sharing(true, 'rating-sharing-2026-11-06');
select ok(app.account_deletion_preview() -> 'kept' @> '[{"category": "rating_sharing"}, {"category": "rating_disputes"}]', 'the deletion preview says the opt-in record and the disputes are kept');
select pg_temp.as_platform();
update app.people set deleted_at = now() where id = pg_temp.id('ivy');
select is((select count(*)::int from app.rating_sharing_consents where person_id = pg_temp.id('ivy') and withdrawn_at is null), 0, 'a deleted account withdraws its opt-in');

select * from finish();
rollback;
