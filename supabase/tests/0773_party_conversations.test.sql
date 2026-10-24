-- pgTAP: migrations 0772 and 0773. Sponsor entitlements for the sponsor account (Section 8.7), and org-level
-- conversations with read receipts: who may start and read a party thread (the org, the person, the account, an
-- applicant), messages stamped and append-only, unread counts, receipts on engagement and party threads, RLS (same
-- tenant, cross tenant, anon, role band) and the time box.
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

-- Sponsor entitlements --------------------------------------------------------------------------------------------------------
select pg_temp.new_user('sol', 'sol@brightwave-drinks.test', 'Sol Ferreira');
select pg_temp.as_user('sol');
insert into world values ('acct_s', app.create_external_account('Brightwave Drinks', 'brightwave-drinks'));
select pg_temp.as_user('alice');
insert into world values ('cp_s_a', app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_s')));
with e as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('sol'), pg_temp.id('cp_s_a'), 'Sponsor', '2027-06-01') returning id) insert into world select 'eng_sponsor', id from e;
insert into app.sponsor_entitlements (project_id, counterparty_id, description, quantity, due_on) values
  (pg_temp.id('prj_a'), pg_temp.id('cp_s_a'), 'Main stage banner placement', 2,
    (select (now() at time zone p.time_zone)::date - 1 from app.projects p where p.id = pg_temp.id('prj_a'))),
  (pg_temp.id('prj_a'), pg_temp.id('cp_v_a'), 'Vendor logo on the site map', 1, null);
select pg_temp.as_platform();
select is(pg_temp.n('sol', 'select 1 from api_external.sponsor_entitlements'), 0, 'Onboarding: entitlements wait for Active');
select pg_temp.move_engagement('eng_sponsor', 'Onboarding', 'Active');
select is(pg_temp.n('sol', 'select 1 from api_external.sponsor_entitlements'), 1, 'own account: the sponsor reads its entitlement only');
select pg_temp.as_user('sol');
select ok((select is_overdue from api_external.sponsor_entitlements), 'a past-due undelivered entitlement is overdue');
select pg_temp.as_platform();
select is(pg_temp.n('victor', 'select 1 from api_external.sponsor_entitlements'), 0, 'a non-sponsor engagement reads none');
select is(pg_temp.n('ivy', 'select 1 from api_external.sponsor_entitlements'), 0, 'denial: another party');

-- Party threads: starting -----------------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.start_party_thread('%s', '%s', null, 'Hello', 'Any work?')$$, pg_temp.id('org_a'), pg_temp.id('quinn')),
  '42501', null, 'a stranger to the org cannot start a conversation with it');
select pg_temp.as_user('gina');
select throws_ok(format($$select app.start_party_thread('%s', '%s', null, 'Hello', 'Hi.')$$, pg_temp.id('org_a'), pg_temp.id('ivy')),
  '42501', null, 'role band: a Viewer cannot start one');
select pg_temp.as_user('carol');
with t as (select app.start_party_thread(pg_temp.id('org_a'), pg_temp.id('ivy'), null, 'Next Season', 'Are you free for the autumn series?') as id)
  insert into world select 'pt_ivy', id from t;
select pg_temp.as_user('victor');
with t as (select app.start_party_thread(pg_temp.id('org_a'), null, pg_temp.id('acct_v'), 'Rate Card 2028', 'Our 2028 rates are attached.') as id)
  insert into world select 'pt_v', id from t;
select pg_temp.as_platform();
select is((select author_person_id from app.party_messages where party_thread_id = pg_temp.id('pt_ivy')), pg_temp.id('carol'), 'the author comes from the session');

-- Reading -----------------------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('ivy', 'select 1 from api_external.party_threads'), 1, 'the person reads her conversation with the org');
select is(pg_temp.n('ivy', 'select unread_count from api_external.party_threads where unread_count = 1'), 1, 'one unread message');
select is(pg_temp.n('sam', 'select 1 from api_external.party_threads'), 1, 'account: an Account Member reads the account conversation');
select is(pg_temp.n('fiona', 'select 1 from api_external.party_messages'), 0, 'Account Finance is not a conversation member');
select is(pg_temp.n('quinn', 'select 1 from api_external.party_threads'), 0, 'denial: another person');
select is(pg_temp.n('carol', 'select 1 from app.party_threads'), 2, 'same tenant: the org reads both');
select is(pg_temp.n('xavier', 'select 1 from app.party_threads'), 0, 'cross tenant: none');
select pg_temp.as_anon();
select throws_ok('select 1 from app.party_threads', '42501', null, 'anon deny');
select throws_ok('select 1 from api_external.party_threads', '42501', null, 'anon deny on the projection');
select pg_temp.as_platform();

-- Writing ----------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select lives_ok(format($$insert into app.party_messages (party_thread_id, body) values ('%s', 'Yes, from September.')$$, pg_temp.id('pt_ivy')), 'the person replies');
select pg_temp.as_user('quinn');
select throws_ok(format($$insert into app.party_messages (party_thread_id, body) values ('%s', 'Me too.')$$, pg_temp.id('pt_ivy')), '42501', null,
  'another person cannot post');
select pg_temp.as_user('ivy');
select throws_ok(format($$insert into app.party_messages (party_thread_id, body, author_person_id) values ('%s', 'Spoof.', '%s')$$, pg_temp.id('pt_ivy'), pg_temp.id('carol')),
  '42501', null, 'the author is never written by the caller');
select pg_temp.as_platform();
select throws_ok('update app.party_messages set body = ''Edited.''', 'XR001', null, 'messages are append-only on every path');

-- Read receipts ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select lives_ok(format($$select app.mark_thread_read(null, '%s')$$, pg_temp.id('pt_ivy')), 'the person marks the thread read');
select is((select unread_count from api_external.party_threads), 0::bigint, 'nothing unread after reading');
select throws_ok(format($$select app.mark_thread_read('%s', '%s')$$, pg_temp.id('pt_ivy'), pg_temp.id('pt_ivy')), 'XR001', null, 'one thread at a time');
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.mark_thread_read(null, '%s')$$, pg_temp.id('pt_ivy')), '42501', null, 'another person cannot mark it read');
select pg_temp.as_user('carol');
select app.mark_thread_read(null, pg_temp.id('pt_ivy'));
with t as (insert into app.engagement_threads (engagement_id, subject) values (pg_temp.id('eng_ivy_a'), 'Load-In Call') returning id)
  insert into world select 'et', id from t;
select app.mark_thread_read(pg_temp.id('et'), null);
select pg_temp.as_user('ivy');
select is((select count(*)::int from api_external.thread_read_receipts where party_thread_id = pg_temp.id('pt_ivy')), 2, 'both sides'' receipts on the party thread');
select is((select person_name from api_external.thread_read_receipts where engagement_thread_id = pg_temp.id('et')), 'Carol Nguyen',
  'the party sees that the org read the engagement thread');
select pg_temp.as_platform();
select is(pg_temp.n('carol', 'select 1 from app.thread_reads'), 3, 'same tenant: the org reads receipts');
select is(pg_temp.n('quinn', 'select 1 from api_external.thread_read_receipts'), 0, 'denial: another person''s receipts');
select pg_temp.as_user('ivy');
select throws_ok(format($$insert into app.thread_reads (org_id, person_id, party_thread_id) values ('%s', '%s', '%s')$$,
  pg_temp.id('org_a'), pg_temp.id('carol'), pg_temp.id('pt_ivy')), '42501', null, 'receipts are written only through the RPC');
select pg_temp.as_platform();

-- Time box: the party thread closes when the engagement area does ------------------------------------------------------------------------
select pg_temp.move_engagement('eng_ivy_a', 'Active', 'Closing');
select pg_temp.move_engagement('eng_ivy_a', 'Closing', 'Complete');
select is(pg_temp.n('ivy', 'select 1 from api_external.party_threads'), 1, 'Complete: the engagement area stays open, so the conversation does');
select pg_temp.backdate_close('eng_ivy_a', interval '19 months');
select is(pg_temp.n('ivy', 'select 1 from api_external.party_threads'), 0, '18 months after Complete the conversation closes');

select * from finish();
rollback;
