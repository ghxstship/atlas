-- pgTAP: migrations 6145 and 6146 (RRR-248, ADR 0156).
--   * An org's rating of an individual reads only inside the org that gave it and for that person: not from another org's
--     roles, a partner on a shared project, or the account that supplied the person, through the table or api_external.
--   * Company and vendor ratings and a party's rating of an org read as before, without naming a vendor's contact.
--   * A person's opt-in is recorded, off by default and withdrawn at once, and it opens one path only: their profile, for
--     viewers who decide no hiring anywhere. It never opens the table, the view or a list across people.
--   * The rated person disputes through a route that exists; the org answers; an operator decides, on grounds that do not
--     read the score. The rating_dispute lifecycle refuses a second decision.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

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

select pg_temp.as_user('ivy');
select is(app.set_rating_sharing(false), false, 'the person withdraws');
select pg_temp.as_user('nia');
select is_empty($$select 1 from api_public.person_profile_shared_ratings((select txt from k where key = 'ivy'))$$,
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
select is((select count(*)::int from app.notifications where kind = 'rating_dispute.decided' and recipient_person_id = pg_temp.id('ivy')), 1, 'the person is told');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.ratings where id = pg_temp.id('rate_ivy_a')), 0, 'and for the org');
select is((select count(*)::int from app.rating_disputes where id = pg_temp.id('dispute_a')), 1, 'which still sees the dispute');
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

-- The hiring capability list names real capabilities, and a deleted account withdraws its opt-in.
select set_config('role', 'postgres', true);
select is_empty($$select c from unnest(private.hiring_capability_codes()) c where c not in (select code from app.capabilities)$$,
  'every hiring capability exists');
select pg_temp.as_user('ivy');
select app.set_rating_sharing(true, 'rating-sharing-2026-11-06');
select pg_temp.as_platform();
update app.people set deleted_at = now() where id = pg_temp.id('ivy');
select is((select count(*)::int from app.rating_sharing_consents where person_id = pg_temp.id('ivy') and withdrawn_at is null), 0, 'a deleted account withdraws its opt-in');

select * from finish();
rollback;
