-- pgTAP: Section 18 gate 18, separation of duties by rule code (A47, RRR-91). Every sod_ rule a migration raises is
-- asserted somewhere in supabase/tests by its code (packages/testing/test/sod-coverage.test.ts checks that). This
-- suite covers the engagement rules whose refusals were tested only by SQLSTATE: a person cannot send an offer on
-- their own application, accept work they handed in themselves, or rate their own engagement for the org. The
-- people who hold both sides are a Manager who applies to their own listing and a Manager the same org engages.
-- It also checks from the catalog that every rule a function refuses with is in the registry.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(6);

-- The registry names every rule a function refuses with (migration 1150) -------------------------------------------
select is_empty($$
  select distinct m[1] from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
    regexp_matches(p.prosrc, '(?:refuse|assert_separation)\(\s*''(sod_[a-z_]+)''', 'g') m
  where n.nspname in ('app', 'private', 'api_public', 'api_external')
  except select code from private.separation_of_duties_rules
$$, 'every sod_ rule a function refuses with is registered in private.separation_of_duties_rules');

-- sod_offer_self: carol, a Northwind Manager, applies to her own org's listing and cannot send herself an offer ------
select pg_temp.as_user('carol');
with o as (insert into app.opportunities (project_id, role_type, role_code, title, visibility, starts_on, ends_on, requisition_id)
  values (pg_temp.id('prj_a'), 'Crew', '5000.51.02', 'Summer Series Riggers', 'Invited', '2027-06-01', '2027-06-03', pg_temp.id('requisition_a'))
  returning id) insert into world select 'opp', id from o;
insert into app.opportunity_invitations (opportunity_id, person_id) values (pg_temp.id('opp'), pg_temp.id('carol'));
select app.transition_opportunity(pg_temp.id('opp'), 'Draft', 'Pending Approval', 'Ready.');
select app.transition_opportunity(pg_temp.id('opp'), 'Pending Approval', 'Published', 'Approved.');
with a as (insert into app.applications (opportunity_id, applicant_person_id, availability_confirmed)
  values (pg_temp.id('opp'), pg_temp.id('carol'), true) returning id) insert into world select 'app_carol', id from a;
select pg_temp.as_user('alice');
select app.transition_application(pg_temp.id('app_carol'), 'Submitted', 'In Review', 'Screening.');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.send_offer('%s', 'Day', 90000, 'USD', null, null, null, null)$$, pg_temp.id('app_carol')),
  'XR001', 'sod_offer_self: A person cannot send an offer on their own application.',
  'sod_offer_self: nobody sends an offer on their own application');
select pg_temp.as_user('alice');
select lives_ok(format($$select app.send_offer('%s', 'Day', 90000, 'USD', null, null, null, now() + interval '7 days')$$, pg_temp.id('app_carol')),
  'another Manager of the org sends the offer');
select pg_temp.as_platform();

-- sod_deliverable_self: xavier, a Harbor Lights Manager, is engaged by his own org and hands in work -----------------
select pg_temp.as_user('xavier');
with e as (insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement,
    start_date)
  values (pg_temp.id('prj_b'), pg_temp.id('xavier'), 'Contractor', '2000.50.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement',
    '2027-07-02') returning id) insert into world select 'eng_xavier_b', id from e;
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_xavier_b', 'Onboarding', 'Active');
select pg_temp.as_user('xavier');
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis) values (pg_temp.id('prj_b'), 'Document', 'Lighting Plot', 'Y', 'Declared') returning id)
  insert into world select 'rec_b', id from r;
with d as (select app.add_engagement_deliverable(pg_temp.id('eng_xavier_b'), pg_temp.id('rec_b')) as id) insert into world select 'dlv_xavier', id from d;
select app.submit_deliverable(pg_temp.id('dlv_xavier'), null, 'Plot attached.');
select throws_ok(format($$select app.decide_deliverable('%s', 'Approved', null)$$, pg_temp.id('dlv_xavier')),
  'XR001', 'sod_deliverable_self: The party who handed in work cannot accept it.',
  'sod_deliverable_self: the party who handed in work cannot accept it, even with engagement write');
select pg_temp.as_platform();

-- sod_rating_self: once the engagement is Complete, xavier cannot rate it for the org --------------------------------
select pg_temp.move_engagement('eng_xavier_b', 'Active', 'Closing');
select pg_temp.move_engagement('eng_xavier_b', 'Closing', 'Complete');
select pg_temp.as_user('xavier');
select throws_ok(format($$insert into app.ratings (engagement_id, rater_side, score) values ('%s', 'Organization', 5)$$, pg_temp.id('eng_xavier_b')),
  'XR001', 'sod_rating_self: A person cannot rate their own engagement for the org.',
  'sod_rating_self: a person cannot rate their own engagement for the org');
select lives_ok(format($$insert into app.ratings (engagement_id, rater_side, score) values ('%s', 'Party', 5)$$, pg_temp.id('eng_xavier_b')),
  'the same person still rates the org from the party side');
select pg_temp.as_platform();

select * from finish();
rollback;
