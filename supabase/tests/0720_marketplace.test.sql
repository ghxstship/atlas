-- pgTAP: the opportunity marketplace and applications (Section 4.4.3, Section 4.4.4, Section 14.9). The
-- opportunity and application state machines (allowed and refused), publishing checks (pay transparency, plan,
-- jurisdiction, bid deadline), visibility (Invited, Pool, Network, Public) with the Do Not Engage flag withheld
-- and never shown, applications by people, representatives and accounts, answers, sealed bids (Section 8.7),
-- agency slates, shortlists and interviews kept internal, notice and action, saved searches and alerts.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create function pg_temp.sees(p_who text, p_opportunity text) returns boolean
language plpgsql as $$
declare v boolean;
begin
  perform pg_temp.claims(p_who);
  v := exists (select 1 from private.visible_opportunity_ids() x where x = pg_temp.id(p_opportunity));
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.opp(p_key text, p_project text, p_role_type text, p_visibility text, p_rate text,
  p_min bigint, p_max bigint, p_deadline interval default interval '7 days') returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.opportunities (project_id, role_type, role_code, title, visibility, rate_type, pay_min_minor, pay_max_minor,
    currency_code, deadline_at, starts_on, ends_on, requisition_id)
  values (pg_temp.id(p_project), p_role_type::app.external_role_type, case when p_role_type in ('Crew', 'Staff') then '5000.51.02' end,
    'Summer Series ' || p_key, p_visibility::app.opportunity_visibility, p_rate::app.rate_type, p_min, p_max,
    case when p_min is not null then 'USD' end, now() + p_deadline, '2027-06-01', '2027-06-03',
    case when p_role_type in ('Crew', 'Staff') then pg_temp.id('requisition_' || substr(p_project, 5)) end)
  returning id into v;
  insert into world values (p_key, v);
  return v;
end $$;
grant execute on function pg_temp.opp(text, text, text, text, text, bigint, bigint, interval) to public;

create function pg_temp.publish(p_key text) returns void
language plpgsql as $$
begin
  perform app.transition_opportunity(pg_temp.id(p_key), 'Draft', 'Pending Approval', 'Ready for approval.');
  perform app.transition_opportunity(pg_temp.id(p_key), 'Pending Approval', 'Published', 'Approved.');
end $$;
grant execute on function pg_temp.publish(text) to public;

-- Pay transparency: the platform records a rule for the venue's jurisdiction chain.
insert into private.pay_transparency_rules (jurisdiction_id, requires_pay_range, effective_from, citation)
values ('US-FL', true, '2026-01-01', 'Fictional Check Statute 1.1');

-- Opportunities and publishing ---------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select pg_temp.opp('opp_crew', 'prj_a', 'Crew', 'Invited', 'Day', 80000, 95000);
insert into app.opportunity_positions (opportunity_id, label, call_at) values
  (pg_temp.id('opp_crew'), 'Rigger 1', '2027-06-01 08:00+00'), (pg_temp.id('opp_crew'), 'Rigger 2', '2027-06-01 08:00+00');
with q as (insert into app.opportunity_questions (opportunity_id, prompt, sort_order, is_required)
  values (pg_temp.id('opp_crew'), 'Which rigging certifications do you hold?', 1, true) returning id) insert into world select 'q_crew', id from q;
insert into app.opportunity_requirements (opportunity_id, requirement_kind, description) values (pg_temp.id('opp_crew'), 'Equipment', 'Own harness.');
insert into app.opportunity_invitations (opportunity_id, person_id) values (pg_temp.id('opp_crew'), pg_temp.id('ivy'));
select is((select position_count from app.opportunity_position_counts where opportunity_id = pg_temp.id('opp_crew')), 2::bigint,
  'the number of positions is derived from the positions');
select throws_ok($$insert into app.opportunity_requirements (opportunity_id, requirement_kind, description) values ((select id from world where key = 'opp_crew'), 'Insurance', 'Liability.')$$,
  '23514', null, 'an insurance requirement states its minimum');
select throws_ok($$select app.transition_opportunity((select id from world where key = 'opp_crew'), 'Draft', 'Published', 'Skip approval.')$$, 'XR001', 'opportunity_transition_not_allowed: A opportunity cannot move from Draft to Published.', 'Draft cannot jump to Published: publishing passes through approval');
select pg_temp.as_user('dave');
select throws_ok($$select app.transition_opportunity((select id from world where key = 'opp_crew'), 'Draft', 'Pending Approval', 'Submit.')$$,
  '42501', null, 'a Member cannot submit postings');
select throws_ok($$select pg_temp.opp('opp_dave', 'prj_a', 'Crew', 'Invited', 'Day', 1, 2)$$, '42501', null, 'a Member cannot create postings');
select pg_temp.as_user('carol');
select lives_ok($$select pg_temp.publish('opp_crew')$$, 'a Manager submits and publishes');
select throws_ok($$update app.opportunities set pay_max_minor = 99000 where id = (select id from world where key = 'opp_crew')$$,
  'XR001', 'opportunity_published_terms: Compensation, visibility, deadline and requisition are fixed once published; pause, close and post a new opportunity.',
  'published compensation is fixed');
select pg_temp.opp('opp_nopay', 'prj_a', 'Crew', 'Invited', null, null, null);
select throws_ok($$select pg_temp.publish('opp_nopay')$$,
  'XR001', 'pay_range_required: A pay range is required to publish work in US-FL-MIAMI-DADE.', 'pay transparency blocks publishing without a range');
select pg_temp.opp('opp_nojur', 'prj_a2', 'Crew', 'Invited', 'Day', 1000, 2000);
select throws_ok($$select pg_temp.publish('opp_nojur')$$,
  'XR001', null, 'an opportunity with no known jurisdiction is not published');
select pg_temp.opp('opp_bid_nodeadline', 'prj_a', 'Vendor', 'Invited', 'Bid', null, null, null);
update app.opportunities set deadline_at = null where id = pg_temp.id('opp_bid_nodeadline');
select throws_ok($$select pg_temp.publish('opp_bid_nodeadline')$$,
  'XR001', 'bid_deadline_required: A bid opportunity needs a deadline; bids stay sealed until it passes.', 'a bid opportunity needs a deadline');
select throws_ok($$insert into app.opportunities (project_id, role_type, title, rate_type, pay_min_minor, pay_max_minor) values ((select id from world where key = 'prj_a'), 'Crew', 'No Currency', 'Day', 1, 2)$$,
  '23514', null, 'posted pay carries its currency');
select throws_ok($$insert into app.opportunities (project_id, role_type, title, rate_type, pay_min_minor, pay_max_minor, currency_code) values ((select id from world where key = 'prj_a'), 'Crew', 'Upside Down', 'Day', 5, 2, 'USD')$$,
  '23514', null, 'the range is ordered');
-- Northwind lists itself publicly (gateway.marketplace_visibility, 1327); the default reaches its network only.
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'gateway.marketplace_visibility', 'Organization', pg_temp.id('org_a'), p_value_text => 'public');
select pg_temp.as_user('carol');
select pg_temp.opp('opp_public', 'prj_a', 'Crew', 'Public', 'Day', 70000, 90000);
select lives_ok($$select pg_temp.publish('opp_public')$$, 'Northwind on Team publishes to the public marketplace');
select pg_temp.as_user('xavier');
select pg_temp.opp('opp_b_public', 'prj_b', 'Crew', 'Public', 'Day', 70000, 90000);
select throws_ok($$select pg_temp.publish('opp_b_public')$$,
  'XR001', 'plan_feature_unavailable: Public marketplace listings need the Pro plan or above.', 'Public listings need the Pro plan');
select pg_temp.as_user('carol');

-- Opportunity state machine
select pg_temp.opp('opp_cycle', 'prj_a', 'Crew', 'Invited', 'Day', 1000, 2000);
select pg_temp.publish('opp_cycle');
select lives_ok($$select app.transition_opportunity((select id from world where key = 'opp_cycle'), 'Published', 'Paused', 'Hold.')$$, 'Published to Paused');
select lives_ok($$select app.transition_opportunity((select id from world where key = 'opp_cycle'), 'Paused', 'Published', 'Resume.')$$, 'Paused to Published');
select lives_ok($$select app.transition_opportunity((select id from world where key = 'opp_cycle'), 'Published', 'Filled', 'All hired.')$$, 'Published to Filled');
select lives_ok($$select app.transition_opportunity((select id from world where key = 'opp_cycle'), 'Filled', 'Closed', 'Done.')$$, 'Filled to Closed');
select throws_ok($$select app.transition_opportunity((select id from world where key = 'opp_cycle'), 'Closed', 'Published', 'Again.')$$, 'XR001', 'opportunity_transition_not_allowed: A opportunity cannot move from Closed to Published.', 'Closed is terminal');
select is((select count(*)::int from app.opportunity_state_transitions where opportunity_id = pg_temp.id('opp_cycle')), 7, 'every move is in the ledger');
select is((select count(*)::int from app.lifecycle_transition_rules where lifecycle = 'opportunity'), 14, 'the opportunity lifecycle declares fourteen moves');
select throws_ok($$update app.opportunities set opportunity_state = 'Closed' where id = (select id from world where key = 'opp_crew')$$,
  '42501', null, 'the state column is not writable');
select pg_temp.as_platform();

-- Visibility -------------------------------------------------------------------------------------------------------
select ok(pg_temp.sees('ivy', 'opp_crew'), 'an invitee sees an Invited opportunity');
select ok(not pg_temp.sees('quinn', 'opp_crew'), 'a stranger does not');
select ok(pg_temp.sees('quinn', 'opp_public'), 'everyone sees a Public opportunity');
select ok(not pg_temp.sees('ivy', 'opp_nopay'), 'nobody sees a Draft');
select pg_temp.as_user('carol');
select pg_temp.opp('opp_pool', 'prj_a', 'Crew', 'Pool', 'Day', 1000, 2000);
select pg_temp.publish('opp_pool');
select pg_temp.opp('opp_net', 'prj_a', 'Crew', 'Network', 'Day', 1000, 2000);
select pg_temp.publish('opp_net');
with p as (insert into app.talent_pools (org_id, name, pool_kind) values (pg_temp.id('org_a'), 'Riggers', 'Talent') returning id) insert into world select 'pool_a', id from p;
with p as (insert into app.talent_pools (org_id, name, pool_kind) values (pg_temp.id('org_a'), 'Audio Vendors', 'Vendor') returning id) insert into world select 'vpool_a', id from p;
insert into app.pool_members (talent_pool_id, person_id, standing) values (pg_temp.id('pool_a'), pg_temp.id('quinn'), 'Approved');
select throws_ok($$insert into app.pool_members (talent_pool_id, person_id, standing) values ((select id from world where key = 'pool_a'), (select id from world where key = 'sam'), 'Do Not Engage')$$,
  '23514', null, 'Do Not Engage needs a reason and a review date');
insert into app.pool_members (talent_pool_id, person_id, standing, reason, review_on)
  values (pg_temp.id('pool_a'), pg_temp.id('sam'), 'Do Not Engage', 'Missed two calls without notice.', '2027-12-31');
select throws_ok($$insert into app.pool_members (talent_pool_id, organization_id, standing) values ((select id from world where key = 'pool_a'), (select id from world where key = 'acct_v'), 'Approved')$$,
  'XR001', null, 'talent pools hold people, vendor pools hold accounts');
select lives_ok($$insert into app.pool_members (talent_pool_id, organization_id, standing) values ((select id from world where key = 'vpool_a'), (select id from world where key = 'acct_t'), 'Preferred')$$,
  'a vendor pool holds an external account');
select pg_temp.as_platform();
select ok(pg_temp.sees('quinn', 'opp_pool'), 'a pool member sees a Pool opportunity');
select ok(pg_temp.sees('rita', 'opp_pool'), 'a member of a pooled account sees it too');
select ok(not pg_temp.sees('ivy', 'opp_pool'), 'someone outside the pools does not');
select ok(not pg_temp.sees('sam', 'opp_public'), 'Do Not Engage withholds even Public opportunities');
select ok(not pg_temp.sees('victor', 'opp_net'), 'Network needs a completed engagement with the org');
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_vendor_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_vendor_a', 'Closing', 'Complete');
select ok(pg_temp.sees('victor', 'opp_net'), 'an account with a completed engagement sees Network opportunities');
select ok(not pg_temp.sees('sam', 'opp_net'), 'but never the person the org flagged Do Not Engage');
select pg_temp.as_user('sam');
select is((select count(*)::int from app.pool_members), 0, 'pools are never visible externally');
select is((select count(*)::int from app.talent_pools), 0, 'not even their names');
select throws_ok($$insert into app.applications (opportunity_id, applicant_person_id) values ((select id from world where key = 'opp_public'), (select id from world where key = 'sam'))$$,
  'XR001', 'opportunity_not_available: This opportunity is not open to you.', 'a flagged person is refused with the same words as an unseen listing');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.pool_members where standing = 'Do Not Engage'), 1, 'members who read applications see the flag internally');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.pool_members), 0, 'another org never sees the flag');
select pg_temp.as_platform();

-- Applications ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
with a as (insert into app.applications (opportunity_id, applicant_person_id, availability_confirmed, cover_note)
  values (pg_temp.id('opp_crew'), pg_temp.id('ivy'), true, 'Ten seasons on the pier rig.') returning id) insert into world select 'app_ivy', id from a;
select is((select submitted_by from app.applications where id = pg_temp.id('app_ivy')), pg_temp.id('ivy'), 'the submitter is stamped from the session');
select throws_ok($$insert into app.applications (opportunity_id, applicant_person_id) values ((select id from world where key = 'opp_crew'), (select id from world where key = 'ivy'))$$,
  '23505', null, 'one application per person per opportunity');
select lives_ok($$insert into app.application_answers (application_id, opportunity_question_id, answer_text) values ((select id from world where key = 'app_ivy'), (select id from world where key = 'q_crew'), 'ETCP Arena and Theatre.')$$,
  'the applicant answers a question');
select is((select count(*)::int from app.application_state_transitions where application_id = pg_temp.id('app_ivy')), 1, 'the applicant reads their application ledger');
select pg_temp.as_user('quinn');
select throws_ok($$insert into app.applications (opportunity_id, applicant_person_id) values ((select id from world where key = 'opp_crew'), (select id from world where key = 'quinn'))$$,
  'XR001', 'opportunity_not_available: This opportunity is not open to you.', 'a stranger cannot apply to an Invited opportunity');
select throws_ok($$insert into app.applications (opportunity_id, applicant_person_id) values ((select id from world where key = 'opp_public'), (select id from world where key = 'ivy'))$$,
  '42501', null, 'nobody applies for someone else without representing them');
select is((select count(*)::int from app.applications), 0, 'a stranger reads no applications');
select is((select count(*)::int from app.application_answers), 0, 'nor answers');
select pg_temp.as_user('carol');
select pg_temp.opp('opp_late', 'prj_a', 'Crew', 'Public', 'Day', 1000, 2000);
select pg_temp.publish('opp_late');
select pg_temp.as_platform();
alter table app.opportunities disable trigger t44_guard_opportunity;
update app.opportunities set deadline_at = now() - interval '1 minute' where id = pg_temp.id('opp_late');
alter table app.opportunities enable trigger t44_guard_opportunity;
select pg_temp.as_user('quinn');
select throws_ok($$insert into app.applications (opportunity_id, applicant_person_id) values ((select id from world where key = 'opp_late'), (select id from world where key = 'quinn'))$$,
  'XR001', 'application_deadline_passed: The deadline for this opportunity has passed.', 'no application after the deadline');
select pg_temp.as_platform();

-- Representatives apply for artists with the Offers scope.
select pg_temp.as_user('carol');
select pg_temp.opp('opp_artist', 'prj_a', 'Artist', 'Invited', 'Flat', 400000, 600000);
insert into app.opportunity_invitations (opportunity_id, person_id) values (pg_temp.id('opp_artist'), pg_temp.id('art'));
select pg_temp.publish('opp_artist');
select pg_temp.as_user('rita');
select throws_ok($$insert into app.applications (opportunity_id, applicant_person_id) values ((select id from world where key = 'opp_artist'), (select id from world where key = 'art'))$$,
  '42501', null, 'a representative without the Offers scope cannot apply for the artist');
with r as (select app.propose_representation(pg_temp.id('acct_t'), pg_temp.id('art'), pg_temp.id('rita'), current_date + 60,
  array['Offers']::app.representation_scope[]) as id) insert into world select 'rep_offers', id from r;
select pg_temp.as_user('art');
select app.accept_representation(pg_temp.id('rep_offers'));
select pg_temp.as_user('rita');
select lives_ok($$with x as (insert into app.applications (opportunity_id, applicant_person_id, proposed_fee_minor, currency_code) values ((select id from world where key = 'opp_artist'), (select id from world where key = 'art'), 550000, 'USD') returning id) insert into world select 'app_art', id from x$$,
  'with Offers the representative applies for the artist and proposes a fee');
select pg_temp.as_platform();

-- Application state machine
select pg_temp.as_user('ivy');
select throws_ok($$select app.transition_application((select id from world where key = 'app_ivy'), 'Submitted', 'In Review', 'Me.')$$,
  '42501', null, 'the applicant cannot review their own application');
select throws_ok($$select app.transition_application((select id from world where key = 'app_ivy'), 'Submitted', 'Accepted', 'Yes.')$$, 'XR001', 'application_transition_not_allowed: A application cannot move from Submitted to Accepted.', 'Submitted cannot jump to Accepted');
select pg_temp.as_user('dave');
select throws_ok($$select app.transition_application((select id from world where key = 'app_ivy'), 'Submitted', 'In Review', 'Look.')$$,
  '42501', null, 'a Member cannot review applications');
select pg_temp.as_user('carol');
select lives_ok($$select app.transition_application((select id from world where key = 'app_ivy'), 'Submitted', 'In Review', 'Screening.')$$, 'Submitted to In Review');
select pg_temp.as_user('ivy');
select throws_ok($$update app.application_answers set answer_text = 'Changed.' where application_id = (select id from world where key = 'app_ivy')$$,
  'XR001', 'application_not_editable: An application changes only while it is Submitted.', 'answers are fixed once review starts');
select pg_temp.as_user('carol');
select lives_ok($$select app.transition_application((select id from world where key = 'app_ivy'), 'In Review', 'Shortlisted', 'Strong.')$$, 'In Review to Shortlisted');
insert into app.shortlists (opportunity_id, application_id, rank, note) values (pg_temp.id('opp_crew'), pg_temp.id('app_ivy'), 1, 'Best rigging references on the list.');
select throws_ok($$insert into app.shortlists (opportunity_id, application_id, rank) values ((select id from world where key = 'opp_public'), (select id from world where key = 'app_ivy'), 2)$$,
  'XR001', null, 'a shortlist entry belongs to the same opportunity');
insert into app.interviews (application_id, interview_kind, scheduled_at, duration_minutes, location_text, internal_note)
  values (pg_temp.id('app_ivy'), 'Interview', '2027-05-01 15:00+00', 30, 'Pier office', 'Ask about the 2026 incident.');
select lives_ok($$select app.transition_application((select id from world where key = 'app_ivy'), 'Shortlisted', 'Offered', 'Offer sent.')$$, 'Shortlisted to Offered');
select throws_ok($$select app.transition_application((select id from world where key = 'app_ivy'), 'Offered', 'Accepted', 'For her.')$$,
  '42501', null, 'the org cannot accept for the applicant');
select pg_temp.as_user('ivy');
select is((select count(*)::int from app.shortlists), 0, 'shortlists stay internal');
select is((select count(*)::int from app.interviews), 0, 'interview rows with their internal notes stay internal');
select lives_ok($$select app.transition_application((select id from world where key = 'app_ivy'), 'Offered', 'Accepted', 'Accepting.')$$, 'the applicant accepts the offer');
select throws_ok($$select app.transition_application((select id from world where key = 'app_ivy'), 'Accepted', 'Withdrawn', 'Changed my mind.')$$, 'XR001', 'application_transition_not_allowed: A application cannot move from Accepted to Withdrawn.', 'Accepted is terminal');
select pg_temp.as_user('rita');
select lives_ok($$select app.transition_application((select id from world where key = 'app_art'), 'Submitted', 'Withdrawn', 'Conflict.')$$, 'the representative withdraws for the artist');
select pg_temp.as_platform();
select is((select count(*)::int from app.lifecycle_transition_rules where lifecycle = 'application'), 14, 'the application lifecycle declares fourteen moves, with the org withdrawing an offer (0764)');

-- Engagements come from accepted applications
select pg_temp.as_user('carol');
select lives_ok($$insert into app.engagements (project_id, person_id, application_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date) values ((select id from world where key = 'prj_a'), (select id from world where key = 'ivy'), (select id from world where key = 'app_ivy'), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-06-01')$$,
  'an engagement records the accepted application it came from');
select throws_ok($$insert into app.engagements (project_id, person_id, application_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date) values ((select id from world where key = 'prj_a'), (select id from world where key = 'quinn'), (select id from world where key = 'app_ivy'), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-06-01')$$,
  'XR001', 'engagement_application_mismatch: An engagement names the project and party of its application.', 'and names the same party');
select throws_ok($$insert into app.engagements (project_id, person_id, application_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date) values ((select id from world where key = 'prj_a'), (select id from world where key = 'art'), (select id from world where key = 'app_art'), 'Artist', '2000.50.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-06-01')$$,
  'XR001', 'engagement_application_not_accepted: An engagement comes from an accepted application.', 'a withdrawn application yields no engagement');
select pg_temp.as_platform();

-- Sealed bids (Section 8.7) ---------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select pg_temp.opp('opp_bid', 'prj_a', 'Vendor', 'Invited', 'Bid', null, null, interval '2 days');
insert into app.opportunity_invitations (opportunity_id, organization_id) values (pg_temp.id('opp_bid'), pg_temp.id('acct_v')), (pg_temp.id('opp_bid'), pg_temp.id('acct_t'));
select pg_temp.publish('opp_bid');
select pg_temp.as_user('victor');
with a as (insert into app.applications (opportunity_id, applicant_organization_id) values (pg_temp.id('opp_bid'), pg_temp.id('acct_v')) returning id) insert into world select 'app_bid_v', id from a;
with b as (insert into app.bids (application_id, currency_code) values (pg_temp.id('app_bid_v'), 'USD') returning id) insert into world select 'bid_v', id from b;
insert into app.bid_lines (bid_id, description, quantity, unit_price_minor) values
  (pg_temp.id('bid_v'), 'Line array system, three days', 3, 450000), (pg_temp.id('bid_v'), 'Delivery and strike', 1, null);
select is((select total_minor from app.bid_totals where bid_id = pg_temp.id('bid_v')), null::bigint, 'a bid with an unpriced line has no total');
select is((select unpriced_line_count from app.bid_totals where bid_id = pg_temp.id('bid_v')), 1::bigint, 'and counts the unpriced line');
update app.bid_lines set unit_price_minor = 120000 where bid_id = pg_temp.id('bid_v') and unit_price_minor is null;
select is((select total_minor from app.bid_totals where bid_id = pg_temp.id('bid_v')), 1470000::bigint, 'totals are derived from the lines');
select pg_temp.as_user('rita');
with a as (insert into app.applications (opportunity_id, applicant_organization_id) values (pg_temp.id('opp_bid'), pg_temp.id('acct_t')) returning id) insert into world select 'app_bid_t', id from a;
with b as (insert into app.bids (application_id, currency_code) values (pg_temp.id('app_bid_t'), 'USD') returning id) insert into world select 'bid_t', id from b;
insert into app.bid_lines (bid_id, description, unit_price_minor) values (pg_temp.id('bid_t'), 'Full audio package', 1300000);
select is((select count(*)::int from app.bids), 1, 'a bidder reads only their own bid');
select is((select count(*)::int from app.bid_lines), 1, 'and only their own lines');
select is((select count(*)::int from app.applications where opportunity_id = pg_temp.id('opp_bid')), 1, 'a bidder never sees another bidder');
select pg_temp.as_user('fiona');
select is((select count(*)::int from app.bids), 0, 'Account Finance does not read the account''s sealed bid');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.bids), 0, 'before the deadline a project member with procurement.bid.read reads no bids');
select is((select count(*)::int from app.bid_lines), 0, 'nor their lines');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.bids), 2, 'procurement.bid.unseal reads sealed bids early');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.bids), 0, 'another org never reads them');
select pg_temp.as_user('ivy');
with a as (insert into app.applications (opportunity_id, applicant_person_id) values (pg_temp.id('opp_public'), pg_temp.id('ivy')) returning id) insert into world select 'app_ivy_pub', id from a;
select throws_ok($$insert into app.bids (application_id, currency_code) values ((select id from world where key = 'app_ivy_pub'), 'USD')$$,
  'XR001', 'bid_not_bid_opportunity: Bids are submitted only to Bid opportunities.', 'bids go only to Bid opportunities');
select pg_temp.as_platform();
alter table app.opportunities disable trigger t44_guard_opportunity;
update app.opportunities set deadline_at = now() - interval '1 minute' where id = pg_temp.id('opp_bid');
alter table app.opportunities enable trigger t44_guard_opportunity;
select pg_temp.as_user('dave');
select is((select count(*)::int from app.bids), 2, 'after the deadline procurement.bid.read reads the bids');
select is((select count(*)::int from app.bid_lines), 3, 'and their lines');
select pg_temp.as_user('victor');
select throws_ok($$update app.bid_lines set unit_price_minor = 1 where bid_id = (select id from world where key = 'bid_v')$$,
  'XR001', 'application_deadline_passed: The deadline for this opportunity has passed.', 'a bid is fixed once the deadline passes');
select is((select count(*)::int from app.bids), 1, 'the bidder still reads only their own bid');
select pg_temp.as_platform();

-- Agency slates -------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select pg_temp.opp('opp_staff', 'prj_a', 'Staff', 'Invited', 'Hourly', 2500, 3500);
insert into app.opportunity_invitations (opportunity_id, organization_id) values (pg_temp.id('opp_staff'), pg_temp.id('acct_v'));
select pg_temp.publish('opp_staff');
select pg_temp.as_user('victor');
with a as (insert into app.applications (opportunity_id, applicant_organization_id) values (pg_temp.id('opp_staff'), pg_temp.id('acct_v')) returning id) insert into world select 'app_slate', id from a;
select lives_ok($$insert into app.agency_slates (application_id, person_id) values ((select id from world where key = 'app_slate'), (select id from world where key = 'sam'))$$,
  'an agency names its own staff on a slate');
select throws_ok($$insert into app.agency_slates (application_id, person_id) values ((select id from world where key = 'app_slate'), (select id from world where key = 'quinn'))$$,
  'XR001', 'slate_member_required: A slate names members of the agency''s own account.', 'a slate names only the agency''s members');
select pg_temp.as_user('sam');
select throws_ok($$insert into app.applications (opportunity_id, applicant_organization_id) values ((select id from world where key = 'opp_public'), (select id from world where key = 'acct_v'))$$,
  'XR001', null, 'the Do Not Engage flag on a member withholds the opportunity from them');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.agency_slates), 1, 'the org reads slates');
select pg_temp.as_platform();

-- Notice and action --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('quinn');
select throws_ok($$insert into app.listing_reports (opportunity_id, reason) values ((select id from world where key = 'opp_crew'), 'Fraud')$$,
  '42501', null, 'only someone who can see a listing reports it');
with r as (insert into app.listing_reports (opportunity_id, reason, details) values (pg_temp.id('opp_public'), 'Missing Pay Range', 'The range looks wrong.') returning id)
  insert into world select 'report_q', id from r;
select is((select count(*)::int from app.listing_reports), 1, 'the reporter reads their report');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.listing_reports), 1, 'the org with marketplace.manage reads reports on its listings');
select throws_ok($$insert into app.moderation_actions (opportunity_id, action, statement_of_reasons) values ((select id from world where key = 'opp_public'), 'Restored', 'Self.')$$,
  '42501', null, 'orgs cannot moderate their own listings');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.listing_reports), 0, 'another org reads no reports');
select pg_temp.as_platform();
insert into app.moderation_actions (opportunity_id, listing_report_id, action, statement_of_reasons)
  values (pg_temp.id('opp_public'), pg_temp.id('report_q'), 'Removed', 'The posted range does not match the role.');
select ok(not pg_temp.sees('quinn', 'opp_public'), 'a removed listing disappears from the marketplace');
select pg_temp.as_user('quinn');
select throws_ok($$insert into app.applications (opportunity_id, applicant_person_id) values ((select id from world where key = 'opp_public'), (select id from world where key = 'quinn'))$$,
  'XR001', null, 'a removed listing takes no applications');
select is((select count(*)::int from app.moderation_actions), 1, 'the reporter reads the decision and its statement of reasons');
select pg_temp.as_user('dave');
select is((select statement_of_reasons from app.moderation_actions), 'The posted range does not match the role.', 'the affected org reads the statement of reasons');
select pg_temp.as_platform();
insert into app.moderation_actions (opportunity_id, action, statement_of_reasons) values (pg_temp.id('opp_public'), 'Restored', 'Range corrected on review.');
select ok(pg_temp.sees('quinn', 'opp_public'), 'a restored listing returns');
select throws_ok($$update app.moderation_actions set action = 'Removed'$$, 'XR001', null, 'moderation decisions are append-only');

-- Saved searches and alerts ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
with s as (insert into app.saved_searches (person_id, name, role_type, jurisdiction_id) values (pg_temp.id('ivy'), 'Miami Rigging', 'Crew', 'US-FL') returning id)
  insert into world select 'search_ivy', id from s;
select throws_ok($$insert into app.saved_searches (person_id, name) values ((select id from world where key = 'quinn'), 'For Quinn')$$,
  '42501', null, 'a search is saved only for oneself');
select pg_temp.as_platform();
insert into app.opportunity_alerts (saved_search_id, opportunity_id) values (pg_temp.id('search_ivy'), pg_temp.id('opp_public'));
select pg_temp.as_user('ivy');
select is((select count(*)::int from app.opportunity_alerts), 1, 'the owner reads their alerts');
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.saved_searches), 0, 'nobody else reads a saved search');
select is((select count(*)::int from app.opportunity_alerts), 0, 'nor its alerts');

-- Anon deny ----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select throws_ok(format('select 1 from %s', t), '42501', null, 'anon cannot read ' || t)
from unnest(array['app.opportunities', 'app.applications', 'app.bids', 'app.bid_lines', 'app.pool_members', 'app.talent_pools',
  'app.shortlists', 'app.interviews', 'app.agency_slates', 'app.listing_reports', 'app.moderation_actions', 'app.saved_searches',
  'app.opportunity_alerts', 'app.bid_totals', 'app.pay_transparency_rules']) as t;
select pg_temp.as_platform();

select * from finish();
rollback;
