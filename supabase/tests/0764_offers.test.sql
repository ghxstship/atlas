-- pgTAP: migration 0764, offers (Section 4.4.4 stage 5). The Offer state machine (allowed and refused moves), turn
-- taking between the org and the applicant side, counters and revisions as append-only versions, expiry, the
-- application kept in step, Accepted only through an accepted offer, separation of duties, RLS (same tenant, cross
-- tenant, anon, role band, applicant side) and the Gateway projections including my_given_ratings.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.app_state(p_key text) returns text language sql as $$
  select application_state::text from app.applications where id = pg_temp.id(p_key);
$$;
create function pg_temp.offer_state(p_key text) returns text language sql as $$
  select offer_state::text from app.offers where id = pg_temp.id(p_key);
$$;

-- Fixture: one Invited listing with applications from ivy, quinn and dave ---------------------------------------------------
select pg_temp.as_user('carol');
with o as (insert into app.opportunities (project_id, role_type, role_code, title, visibility, starts_on, ends_on, requisition_id)
  values (pg_temp.id('prj_a'), 'Crew', '5000.51.02', 'Summer Series Riggers', 'Invited', '2027-06-01', '2027-06-03', pg_temp.id('requisition_a'))
  returning id) insert into world select 'opp', id from o;
insert into app.opportunity_invitations (opportunity_id, person_id)
values (pg_temp.id('opp'), pg_temp.id('ivy')), (pg_temp.id('opp'), pg_temp.id('quinn')), (pg_temp.id('opp'), pg_temp.id('carol'));
select app.transition_opportunity(pg_temp.id('opp'), 'Draft', 'Pending Approval', 'Ready.');
select app.transition_opportunity(pg_temp.id('opp'), 'Pending Approval', 'Published', 'Approved.');
create function pg_temp.apply(p_who text, p_key text) returns void language plpgsql as $$
begin
  perform pg_temp.as_user(p_who);
  with a as (insert into app.applications (opportunity_id, applicant_person_id, availability_confirmed)
    values (pg_temp.id('opp'), pg_temp.id(p_who), true) returning id) insert into world select p_key, id from a;
  perform pg_temp.as_user('alice');
  perform app.transition_application(pg_temp.id(p_key), 'Submitted', 'In Review', 'Screening.');
  perform pg_temp.as_platform();
end $$;
select pg_temp.apply('ivy', 'app_ivy');
select pg_temp.apply('quinn', 'app_quinn');
select pg_temp.apply('carol', 'app_carol');

-- Sending ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok(format($$select app.send_offer('%s', 'Day', 90000, 'USD', '2027-06-01', '2027-06-03', 'Welcome aboard.', null)$$, pg_temp.id('app_ivy')),
  '42501', null, 'role band: a Viewer cannot send an offer');
select pg_temp.as_user('xavier');
select throws_ok(format($$select app.send_offer('%s', 'Day', 90000, 'USD', null, null, null, null)$$, pg_temp.id('app_ivy')),
  '42501', null, 'cross tenant: another org cannot send an offer');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.send_offer('%s', 'Day', 90000, 'USD', null, null, null, null)$$, pg_temp.id('app_carol')),
  'XR001', null, 'separation of duties: nobody sends an offer on their own application');
select throws_ok(format($$select app.send_offer('%s', 'Day', 90000, 'USD', null, null, null, now() - interval '1 day')$$, pg_temp.id('app_ivy')),
  'XR001', null, 'an offer expires in the future');
select throws_ok(format($$select app.send_offer('%s', null, 90000, 'USD', null, null, null, null)$$, pg_temp.id('app_ivy')),
  '23514', null, 'an amount needs a rate type');
with o as (select app.send_offer(pg_temp.id('app_ivy'), 'Day', 90000, 'USD', '2027-06-01', '2027-06-03', 'Welcome aboard.', now() + interval '7 days') as id)
  insert into world select 'offer_ivy', id from o;
select pg_temp.as_platform();
select is(pg_temp.offer_state('offer_ivy'), 'Sent', 'a new offer is Sent');
select is(pg_temp.app_state('app_ivy'), 'Offered', 'sending moves the application to Offered');
select is((select proposed_by from app.offer_versions where offer_id = pg_temp.id('offer_ivy')), pg_temp.id('carol'), 'the proposer comes from the session');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.send_offer('%s', 'Day', 1, 'USD', null, null, null, null)$$, pg_temp.id('app_ivy')),
  'XR001', null, 'offers go only to applications In Review or Shortlisted');
select pg_temp.as_platform();

-- Turn taking and counters ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok(format($$select app.revise_offer('%s', 'Day', 95000, 'USD', null, null, null, null)$$, pg_temp.id('offer_ivy')),
  'XR001', null, 'the org cannot revise its own terms before the applicant answers');
select throws_ok(format($$select app.accept_offer('%s')$$, pg_temp.id('offer_ivy')), 'XR001', null, 'the org cannot accept its own terms');
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.counter_offer('%s', 'Day', 1, 'USD', null, null, null)$$, pg_temp.id('offer_ivy')),
  '42501', null, 'another applicant cannot counter ivy''s offer');
select pg_temp.as_user('ivy');
select lives_ok(format($$select app.counter_offer('%s', 'Day', 105000, 'USD', '2027-06-01', '2027-06-03', 'My day rate is 1,050.')$$, pg_temp.id('offer_ivy')),
  'the applicant counters');
select throws_ok(format($$select app.counter_offer('%s', 'Day', 1, 'USD', null, null, null)$$, pg_temp.id('offer_ivy')),
  'XR001', null, 'the applicant cannot counter their own counter');
select throws_ok(format($$select app.accept_offer('%s')$$, pg_temp.id('offer_ivy')), 'XR001', null, 'the applicant cannot accept their own counter');
select throws_ok(format($$select app.transition_application('%s', 'Offered', 'Accepted', 'Skip the offer.')$$, pg_temp.id('app_ivy')),
  'XR001', 'offer_not_accepted: Accept the offer in force to accept this application.', 'Accepted only through an accepted offer');
select pg_temp.as_platform();
select is(pg_temp.offer_state('offer_ivy'), 'Countered', 'a counter moves the offer to Countered');
select is((select count(*)::int from app.offer_versions where offer_id = pg_temp.id('offer_ivy')), 2, 'each proposal is a version');
select is((select max(version_number) from app.offer_versions where offer_id = pg_temp.id('offer_ivy')), 2, 'versions are numbered');
select throws_ok(format($$update app.offer_versions set amount_minor = 1 where offer_id = '%s'$$, pg_temp.id('offer_ivy')),
  'XR001', null, 'versions are append-only on every path');
select pg_temp.as_user('carol');
select lives_ok(format($$select app.revise_offer('%s', 'Day', 100000, 'USD', '2027-06-01', '2027-06-03', 'Meet at 1,000.', now() + interval '3 days')$$, pg_temp.id('offer_ivy')),
  'the org revises after the counter');
select pg_temp.as_platform();
select is(pg_temp.offer_state('offer_ivy'), 'Sent', 'a revision returns the offer to Sent');
select pg_temp.as_user('ivy');
select lives_ok(format($$select app.accept_offer('%s')$$, pg_temp.id('offer_ivy')), 'the applicant accepts the terms in force');
select pg_temp.as_platform();
select is(pg_temp.offer_state('offer_ivy'), 'Accepted', 'the offer is Accepted');
select is(pg_temp.app_state('app_ivy'), 'Accepted', 'and the application with it');
select pg_temp.as_user('ivy');
select throws_ok(format($$select app.decline_offer('%s', 'Changed my mind.')$$, pg_temp.id('offer_ivy')), 'XR001', 'offer_transition_not_allowed: A offer cannot move from Accepted to Declined.',
  'Accepted is final: no decline after acceptance');
select pg_temp.as_platform();

-- The org accepts a counter; the applicant declines; the org withdraws -------------------------------------------------------------
select pg_temp.as_user('carol');
with o as (select app.send_offer(pg_temp.id('app_quinn'), 'Day', 80000, 'USD', null, null, null, null) as id) insert into world select 'offer_quinn', id from o;
select pg_temp.as_user('quinn');
select app.counter_offer(pg_temp.id('offer_quinn'), 'Day', 85000, 'USD', null, null, 'Rigging lead rate.');
select pg_temp.as_user('carol');
select lives_ok(format($$select app.accept_offer('%s')$$, pg_temp.id('offer_quinn')), 'the org accepts a counter');
select pg_temp.as_platform();
select is(pg_temp.app_state('app_quinn'), 'Accepted', 'accepting a counter accepts the application');

select pg_temp.as_user('alice');
select app.transition_application(pg_temp.id('app_carol'), 'In Review', 'Shortlisted', 'Strong fit.');
with o as (select app.send_offer(pg_temp.id('app_carol'), 'Flat', 50000, 'USD', null, null, null, null) as id) insert into world select 'offer_carol', id from o;
select pg_temp.as_user('carol');
select lives_ok(format($$select app.decline_offer('%s', 'Booked elsewhere.')$$, pg_temp.id('offer_carol')), 'the applicant declines');
select pg_temp.as_platform();
select is(pg_temp.app_state('app_carol'), 'Declined', 'declining declines the application');
select is(pg_temp.offer_state('offer_carol'), 'Declined', 'and the offer');

-- Withdraw, applicant withdrawal and expiry use a fresh application each ---------------------------------------------------------------
select pg_temp.as_platform();
update app.applications set deleted_at = now() where id in (pg_temp.id('app_quinn'), pg_temp.id('app_carol'));
update app.offers set deleted_at = now() where id in (pg_temp.id('offer_quinn'), pg_temp.id('offer_carol'));
select pg_temp.apply('quinn', 'app_quinn2');
select pg_temp.as_user('carol');
with o as (select app.send_offer(pg_temp.id('app_quinn2'), 'Day', 80000, 'USD', null, null, null, now() + interval '1 day') as id)
  insert into world select 'offer_quinn2', id from o;
select lives_ok(format($$select app.withdraw_offer('%s', 'Budget cut.')$$, pg_temp.id('offer_quinn2')), 'the org withdraws');
select pg_temp.as_platform();
select is(pg_temp.app_state('app_quinn2'), 'Not Selected', 'a withdrawn offer ends the selection');
select is((select count(*)::int from app.offer_state_transitions where offer_id = pg_temp.id('offer_quinn2')), 2, 'creation and withdrawal are in the ledger');

update app.applications set deleted_at = now() where id = pg_temp.id('app_quinn2');
select pg_temp.apply('quinn', 'app_quinn3');
select pg_temp.as_user('carol');
with o as (select app.send_offer(pg_temp.id('app_quinn3'), 'Day', 80000, 'USD', null, null, null, now() + interval '1 day') as id)
  insert into world select 'offer_quinn3', id from o;
select pg_temp.as_user('quinn');
select app.transition_application(pg_temp.id('app_quinn3'), 'Offered', 'Withdrawn', 'Taking another job.');
select pg_temp.as_platform();
select is(pg_temp.offer_state('offer_quinn3'), 'Declined', 'withdrawing the application closes the open offer');

update app.applications set deleted_at = now() where id = pg_temp.id('app_quinn3');
select pg_temp.apply('quinn', 'app_quinn4');
select pg_temp.as_user('carol');
with o as (select app.send_offer(pg_temp.id('app_quinn4'), 'Day', 80000, 'USD', null, null, null, now() + interval '1 hour') as id)
  insert into world select 'offer_quinn4', id from o;
select pg_temp.as_platform();
alter table app.offer_versions disable trigger user;
update app.offer_versions set expires_at = now() - interval '1 minute' where offer_id = pg_temp.id('offer_quinn4');
alter table app.offer_versions enable trigger user;
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.accept_offer('%s')$$, pg_temp.id('offer_quinn4')), 'XR001', null, 'lapsed terms cannot be accepted');
select throws_ok('select app.expire_offers()', '42501', null, 'only the platform job expires offers');
select pg_temp.as_platform();
select is(app.expire_offers(), 1, 'the job expires lapsed offers');
select is(pg_temp.offer_state('offer_quinn4'), 'Expired', 'the offer is Expired');
select is(pg_temp.app_state('app_quinn4'), 'Offered', 'the application waits for new terms');

-- RLS and projections -------------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('carol', format($$select 1 from app.offers where id = '%s'$$, pg_temp.id('offer_ivy'))), 1, 'same tenant: the org reads the offer');
select is(pg_temp.n('xavier', 'select 1 from app.offers'), 0, 'cross tenant: another org reads none');
select is(pg_temp.n('ivy', 'select 1 from app.offers'), 1, 'the applicant reads their own offer');
select is(pg_temp.n('ivy', 'select 1 from api_external.offers'), 1, 'and through api_external');
select is(pg_temp.n('ivy', 'select 1 from api_external.offer_versions'), 3, 'with every version of the terms');
select is(pg_temp.n('quinn', format($$select 1 from api_external.offers where id = '%s'$$, pg_temp.id('offer_ivy'))), 0, 'denial: another applicant');
select hasnt_column('api_external', 'offer_versions', 'proposed_by', 'the org-side proposer never reaches externals');
select pg_temp.as_anon();
select throws_ok('select 1 from app.offers', '42501', null, 'anon deny');
select throws_ok('select 1 from api_external.offers', '42501', null, 'anon cannot read offers');
select pg_temp.as_platform();
select pg_temp.as_user('ivy');
select throws_ok(format($$update app.offers set offer_state = 'Accepted' where id = '%s'$$, pg_temp.id('offer_ivy')), '42501', null,
  'offers change only through the RPCs');
select pg_temp.as_platform();

-- my_given_ratings ------------------------------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_ivy_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_ivy_a', 'Closing', 'Complete');
select pg_temp.as_user('ivy');
insert into app.ratings (engagement_id, rater_side, score, comment) values (pg_temp.id('eng_ivy_a'), 'Party', 5, 'Clear call times.');
select is((select count(*)::int from api_external.my_given_ratings), 1, 'the party lists the rating they gave');
select is((select is_released from api_external.my_given_ratings), false, 'held until the org rates too');
select pg_temp.as_user('carol');
insert into app.ratings (engagement_id, rater_side, score) values (pg_temp.id('eng_ivy_a'), 'Organization', 4);
select pg_temp.as_user('ivy');
select is((select is_released from api_external.my_given_ratings), true, 'released once both are in');
select pg_temp.as_platform();
select is(pg_temp.n('quinn', 'select 1 from api_external.my_given_ratings'), 0, 'denial: another party');
select is(pg_temp.n('carol', 'select 1 from api_external.my_given_ratings'), 0, 'the org''s own rating is not a given party rating');

select * from finish();
rollback;
