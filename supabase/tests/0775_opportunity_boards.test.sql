-- pgTAP: migration 0775, the Atlas read models and stage 5 to 6. The application board (applicant names, offer in force,
-- bid totals only once unsealed), the engagement board (onboarding progress and rating status) with their row filters
-- (same tenant, cross tenant, role band, externals, anon), and create_engagement_from_application with its refusals.
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

-- Fixture: a Crew listing with ivy's application and an audio Bid listing with Bayside's sealed bid --------------------------
select pg_temp.as_user('carol');
with o as (insert into app.opportunities (project_id, role_type, role_code, title, visibility, starts_on, ends_on, requisition_id)
  values (pg_temp.id('prj_a'), 'Crew', '5000.51.02', 'Summer Series Riggers', 'Invited', '2027-06-01', '2027-06-03', pg_temp.id('requisition_a'))
  returning id) insert into world select 'opp', id from o;
insert into app.opportunity_invitations (opportunity_id, person_id) values (pg_temp.id('opp'), pg_temp.id('ivy'));
with o as (insert into app.opportunities (project_id, role_type, role_code, title, visibility, rate_type, deadline_at, starts_on)
  values (pg_temp.id('prj_a'), 'Vendor', '9000.50.02', 'Audio System Package', 'Invited', 'Bid', now() + interval '2 days', '2027-06-01')
  returning id) insert into world select 'opp_bid', id from o;
insert into app.opportunity_invitations (opportunity_id, organization_id) values (pg_temp.id('opp_bid'), pg_temp.id('acct_v'));
select app.transition_opportunity(pg_temp.id('opp'), 'Draft', 'Pending Approval', 'Ready.');
select app.transition_opportunity(pg_temp.id('opp'), 'Pending Approval', 'Published', 'Approved.');
select app.transition_opportunity(pg_temp.id('opp_bid'), 'Draft', 'Pending Approval', 'Ready.');
select app.transition_opportunity(pg_temp.id('opp_bid'), 'Pending Approval', 'Published', 'Approved.');
select pg_temp.as_user('ivy');
with a as (insert into app.applications (opportunity_id, applicant_person_id, availability_confirmed) values (pg_temp.id('opp'), pg_temp.id('ivy'), true) returning id)
  insert into world select 'app_ivy', id from a;
select pg_temp.as_user('victor');
with a as (insert into app.applications (opportunity_id, applicant_organization_id) values (pg_temp.id('opp_bid'), pg_temp.id('acct_v')) returning id)
  insert into world select 'app_v', id from a;
with b as (insert into app.bids (application_id, currency_code) values (pg_temp.id('app_v'), 'USD') returning id) insert into world select 'bid', id from b;
insert into app.bid_lines (bid_id, description, quantity, unit_price_minor) values (pg_temp.id('bid'), 'Line array system', 1, 4200000);
select pg_temp.as_platform();

-- Application board --------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('carol', 'select 1 from app.application_board'), 2, 'same tenant: the Manager sees both applications');
select pg_temp.as_user('carol');
select is((select applicant_name from app.application_board where application_id = pg_temp.id('app_ivy')), 'Ivy Marchetti', 'a person applicant shows by name');
select is((select applicant_name from app.application_board where application_id = pg_temp.id('app_v')), 'Bayside Audio', 'an account applicant shows by account name');
select is((select bid_total_minor from app.application_board where application_id = pg_temp.id('app_v')), 4200000::bigint,
  'a Manager holding procurement.bid.unseal reads the bid early');
select pg_temp.as_user('dave');
select ok((select bid_sealed and bid_total_minor is null from app.application_board where application_id = pg_temp.id('app_v')),
  'before the deadline the bid stays sealed for a Member without procurement.bid.unseal');
select pg_temp.as_platform();
alter table app.opportunities disable trigger user;
update app.opportunities set deadline_at = now() - interval '1 minute' where id = pg_temp.id('opp_bid');
alter table app.opportunities enable trigger user;
select pg_temp.as_user('dave');
select is((select bid_total_minor from app.application_board where application_id = pg_temp.id('app_v')), 4200000::bigint,
  'after the deadline the Member with procurement.bid.read reads the total');
select pg_temp.as_platform();
select is(pg_temp.n('xavier', 'select 1 from app.application_board'), 0, 'cross tenant: none');
select is(pg_temp.n('gina', 'select 1 from app.application_board'), 0, 'role band: a Viewer outside the project reads none');
select is(pg_temp.n('ivy', 'select 1 from app.application_board'), 0, 'an applicant never reads the org''s board');
select pg_temp.as_anon();
select throws_ok('select 1 from app.application_board', '42501', null, 'anon deny');
select pg_temp.as_platform();

-- Offer in force and stage 5 to 6 -------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select app.transition_application(pg_temp.id('app_ivy'), 'Submitted', 'In Review', 'Screening.');
select throws_ok(format($$select app.create_engagement_from_application('%s', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', null, null)$$, pg_temp.id('app_ivy')),
  'XR001', null, 'only an accepted application becomes an engagement');
with o as (select app.send_offer(pg_temp.id('app_ivy'), 'Day', 95000, 'USD', '2027-06-01', '2027-06-03', 'Welcome.', null) as id) insert into world select 'offer', id from o;
select is((select offer_turn_side::text from app.application_board where application_id = pg_temp.id('app_ivy')), 'Organization', 'the board shows whose terms are in force');
select pg_temp.as_user('ivy');
select app.accept_offer(pg_temp.id('offer'));
select pg_temp.as_user('gina');
select throws_ok(format($$select app.create_engagement_from_application('%s', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', null, null)$$, pg_temp.id('app_ivy')),
  '42501', null, 'role band: a Viewer cannot engage');
select pg_temp.as_user('carol');
with e as (select app.create_engagement_from_application(pg_temp.id('app_ivy'), 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', null, null) as id)
  insert into world select 'eng_new', id from e;
select throws_ok(format($$select app.create_engagement_from_application('%s', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', null, null)$$, pg_temp.id('app_ivy')),
  'XR001', null, 'an application is engaged once');
select is((select engagement_id from app.application_board where application_id = pg_temp.id('app_ivy')), pg_temp.id('eng_new'), 'the board links the engagement');
select pg_temp.as_platform();
select is((select agreed_rate_minor from app.engagements where id = pg_temp.id('eng_new')), 95000::bigint, 'the accepted offer becomes the agreed rate');
select is((select start_date from app.engagements where id = pg_temp.id('eng_new')), '2027-06-01'::date, 'and its dates');
select is((select engagement_state::text from app.engagements where id = pg_temp.id('eng_new')), 'Onboarding', 'the engagement starts Onboarding');

-- An account applicant gets its counterparty -----------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select app.transition_application(pg_temp.id('app_v'), 'Submitted', 'In Review', 'Leveling.');
with o as (select app.send_offer(pg_temp.id('app_v'), 'Flat', 4200000, 'USD', null, null, null, null) as id) insert into world select 'offer_v', id from o;
select pg_temp.as_user('victor');
select app.accept_offer(pg_temp.id('offer_v'));
select pg_temp.as_user('carol');
select throws_ok(format($$select app.create_engagement_from_application('%s', 'VENDOR_SUPPLIED', null, null, null, null)$$, pg_temp.id('app_v')),
  'XR001', null, 'the engagement contract still applies: a paid classification needs a pay basis');
with e as (select app.create_engagement_from_application(pg_temp.id('app_v'), 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement', '2027-06-01', null) as id)
  insert into world select 'eng_v_new', id from e;
select pg_temp.as_platform();
select is((select c.organization_id from app.engagements e join app.counterparties c on c.id = e.counterparty_id where e.id = pg_temp.id('eng_v_new')),
  pg_temp.id('acct_v'), 'the account applicant is engaged through its existing counterparty row');

-- Engagement board ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select party_name from app.engagement_board where engagement_id = pg_temp.id('eng_new')), 'Ivy Marchetti', 'the board names the party');
select is((select account_name from app.engagement_board where engagement_id = pg_temp.id('eng_v_new')), 'Bayside Audio', 'and the account');
select is((select open_blocking_count from app.engagement_board where engagement_id = pg_temp.id('eng_new')), 0::bigint, 'no blocking requirement is open');
select is((select ratings_released from app.engagement_board where engagement_id = pg_temp.id('eng_new')), false, 'ratings are not released before close-out');
select pg_temp.as_platform();
select is(pg_temp.n('xavier', 'select 1 from app.engagement_board where org_id = (select id from world where key = ''org_a'')'), 0, 'cross tenant: none');
select is(pg_temp.n('ivy', 'select 1 from app.engagement_board'), 0, 'externals read engagements through api_external only');
select is((select private.open_blocking_count(pg_temp.id('eng_new'))), 0::bigint, 'the helper answers for the platform');
select pg_temp.as_anon();
select throws_ok('select 1 from app.engagement_board', '42501', null, 'anon deny');
select pg_temp.as_platform();

select * from finish();
rollback;
