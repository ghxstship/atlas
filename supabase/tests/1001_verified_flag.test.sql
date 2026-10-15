-- pgTAP: migration 1001, the verified badge on Gateway listings and accounts (Section 4.8.3, A30's 0860).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

select pg_temp.as_user('carol');
with o as (insert into app.opportunities (project_id, role_type, role_code, title, visibility, starts_on, requisition_id)
  values (pg_temp.id('prj_a'), 'Crew', '5000.51.02', 'Summer Series Riggers', 'Invited', '2027-06-01', pg_temp.id('requisition_a')) returning id)
  insert into world select 'opp', id from o;
insert into app.opportunity_invitations (opportunity_id, person_id) values (pg_temp.id('opp'), pg_temp.id('ivy'));
select app.transition_opportunity(pg_temp.id('opp'), 'Draft', 'Pending Approval', 'Ready.');
select app.transition_opportunity(pg_temp.id('opp'), 'Pending Approval', 'Published', 'Approved.');

select pg_temp.as_user('ivy');
select is((select org_verified from api_external.opportunities where id = pg_temp.id('opp')), false, 'an unverified org shows no badge');
select pg_temp.as_platform();
select app.record_organization_verification(pg_temp.id('org_a'), 'Stripe Identity', 'vs_fixture_1');
select pg_temp.as_user('ivy');
select is((select org_verified from api_external.opportunities where id = pg_temp.id('opp')), true, 'a verified org shows the badge');
select pg_temp.as_user('victor');
select is((select verified from api_external.my_accounts where account_id = pg_temp.id('acct_v')), false, 'the account sees its own unverified state');
select pg_temp.as_platform();
select app.record_organization_verification(pg_temp.id('acct_v'), 'Stripe Identity', 'vs_fixture_2');
select pg_temp.as_user('victor');
select is((select verified from api_external.my_accounts where account_id = pg_temp.id('acct_v')), true, 'and the verified state once recorded');
select pg_temp.as_platform();

select * from finish();
rollback;
