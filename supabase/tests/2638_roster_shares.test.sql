-- pgTAP: migration 2638 (R4), work details shares keyed on the roster entry (owner decisions 0/1 and 4). A share names the
-- sharer's own entry (the self entry for the engaged person); a rostered person shares only after accepting; two people
-- share on one engagement. The company reads every category of a person who accepted its roster entry, whatever they
-- shared with the producing org but the retired Uniform Sizes (R6a), with the passport number and allergies masked; before the
-- person accepts, and after a decline or a withdrawal, it gets 42501, and the account consent follows. A Member-duty
-- assignee and the worker the engagement names are refused. Producing-org readers read the shared categories their capabilities cover. Every read writes the
-- access log and the audit ledger, without dedupe. shared_work_details answers for the self entry and
-- reveal_roster_passport_number needs step-up and a reason. An Advancing Lead is an engagement principal (R1's views).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

create function pg_temp.membership(p_account text, p_person text) returns uuid
language plpgsql as $$
declare
  v_role text := current_setting('role');
  v_claims text := current_setting('request.jwt.claims', true);
  v uuid;
begin
  perform set_config('role', 'postgres', true);
  select m.id into v from app.account_memberships m
  where m.org_id = pg_temp.id(p_account) and m.person_id = pg_temp.id(p_person) and m.deleted_at is null
    and (m.valid_to is null or m.valid_to > now());
  perform set_config('role', v_role, true);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return v;
end $$;

-- A read of a roster entry's work details as someone, back as the platform.
create function pg_temp.read(p_who text, p_entry text) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(p_who);
  v := app.roster_shared_work_details(pg_temp.id(p_entry));
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.principal(p_who text, p_engagement text) returns boolean
language plpgsql as $$
declare v boolean;
begin
  perform pg_temp.claims(p_who);
  v := private.engagement_principal(pg_temp.id(p_engagement));
  perform pg_temp.as_platform();
  return v;
end $$;

-- Fixture: Kai and Mo on Bayside's team, Pia its Advancing Lead on the vendor engagement, Kai's work details ---------------------
select pg_temp.new_user('kai', 'kai@bayside-audio.test', 'Kai Morgan');
select pg_temp.new_user('mo', 'mo@bayside-audio.test', 'Mo Lindqvist');
select pg_temp.new_user('pia', 'pia@bayside-audio.test', 'Pia Larsen');
select pg_temp.as_user('victor');
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id(p), 'Account Member') from unnest(array['kai', 'mo', 'pia']) p;
select pg_temp.as_user('kai');
select app.accept_account_membership(pg_temp.membership('acct_v', 'kai'));
select app.ensure_my_work_details();
update app.person_work_details set allergies = 'Peanuts', dietary_needs = array['Vegetarian']::app.dietary_need[]
where person_id = pg_temp.id('kai');
select app.set_my_passport_number('X1234567');
select pg_temp.as_user('mo');
select app.accept_account_membership(pg_temp.membership('acct_v', 'mo'));
select pg_temp.as_user('pia');
select app.accept_account_membership(pg_temp.membership('acct_v', 'pia'));
select pg_temp.as_user('victor');
select app.assign_engagement_member(pg_temp.id('eng_vendor_a'), pg_temp.membership('acct_v', 'pia'), 'Advancing Lead');
select app.assign_engagement_member(pg_temp.id('eng_vendor_a'), pg_temp.membership('acct_v', 'mo'), 'Member');
insert into world select 'e_kai', app.add_roster_entry(pg_temp.id('eng_vendor_a'), pg_temp.id('kai'));
select pg_temp.as_platform();
insert into world select 'self_vendor', r.id from app.engagement_roster_entries r where r.engagement_id = pg_temp.id('eng_vendor_a') and r.is_self;
insert into world select 'self_ivy', r.id from app.engagement_roster_entries r where r.engagement_id = pg_temp.id('eng_ivy_a') and r.is_self;

-- Shares key on the entry --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select lives_ok($$insert into world select 'share_ivy', app.share_work_details((select id from world where key = 'eng_ivy_a'),
  array['Emergency Contacts', 'Dietary Needs']::app.work_detail_category[])$$, 'the engaged person shares');
select pg_temp.as_platform();
select is((select roster_entry_id from app.work_detail_shares where id = pg_temp.id('share_ivy')), pg_temp.id('self_ivy'),
  'an engaged person''s share keys on their self entry');
select throws_like($$insert into app.work_detail_shares (engagement_id, person_id, consent_record_id, categories)
  select pg_temp.id('eng_ivy_a'), pg_temp.id('ivy'), consent_record_id, array['Passport']::app.work_detail_category[]
  from app.work_detail_shares where id = pg_temp.id('share_ivy')$$, 'work_detail_share_roster_entry:%', 'a new share names a roster entry');
select throws_like($$update app.work_detail_shares set roster_entry_id = pg_temp.id('e_kai') where id = pg_temp.id('share_ivy')$$,
  'work_detail_share_entry_mismatch:%', 'a share''s engagement and person are its entry''s');

select pg_temp.as_user('kai');
select throws_like(format($$select app.share_work_details(%L, array['Dietary Needs']::app.work_detail_category[])$$, pg_temp.id('eng_vendor_a')),
  'roster_entry_not_accepted:%', 'a rostered person shares only after accepting the entry');
select pg_temp.as_platform();
select throws_ok(format($$select pg_temp.read('victor', 'e_kai')$$), '42501', null, 'before the person accepts, the company reads nothing');
select pg_temp.as_user('kai');
select app.respond_roster_entry(pg_temp.id('e_kai'), 'Accepted');
select lives_ok(format($$insert into world select 'share_kai', app.share_work_details(%L, array['Emergency Contacts', 'Passport']::app.work_detail_category[])$$,
  pg_temp.id('eng_vendor_a')), 'after accepting, they share');
select pg_temp.as_user('sam');
select lives_ok(format($$select app.share_work_details(%L, array['Emergency Contacts']::app.work_detail_category[])$$, pg_temp.id('eng_vendor_a')),
  'the engaged person shares on the same engagement');
select pg_temp.as_platform();
select is((select count(*)::int from app.work_detail_shares where engagement_id = pg_temp.id('eng_vendor_a') and revoked_at is null), 2,
  'two people share on one engagement');
select ok(private.account_roster_consent(pg_temp.id('acct_v'), pg_temp.id('kai')) is not null,
  'an account_roster_sharing consent exists for the company account after acceptance');

-- The company reads ----------------------------------------------------------------------------------------------------------------
select is(pg_temp.read('victor', 'e_kai') ->> 'reader', 'company', 'the account''s Owner reads as the company');
select is(jsonb_array_length(pg_temp.read('victor', 'e_kai') -> 'readable'), 6,
  'every category but the retired Uniform Sizes (R6a), not only those shared with the producing org');
select ok(pg_temp.read('victor', 'e_kai') -> 'uniform' = 'null'::jsonb, 'uniform sizes are entered per roster entry now (R6a)');
select is(pg_temp.read('pia', 'e_kai') #>> '{dietary,dietary_needs,0}', 'Vegetarian', 'the Advancing Lead reads the dietary needs, never shared with the org');
select ok(pg_temp.read('victor', 'e_kai') #> '{dietary,allergies}' = 'null'::jsonb, 'allergies are masked for a company reader');
select is(pg_temp.read('victor', 'e_kai') #>> '{dietary,allergies_on_file}', 'true', 'with allergies_on_file');
select ok(pg_temp.read('victor', 'e_kai') #> '{passport,passport_number}' = 'null'::jsonb, 'the passport number stays masked');
select is(pg_temp.read('victor', 'e_kai') #>> '{passport,passport_number_last4}', '4567', 'showing its last four');
select throws_ok($$select pg_temp.read('mo', 'e_kai')$$, '42501', null, 'an Account Member with Member duty is refused');
select throws_ok($$select pg_temp.read('fiona', 'e_kai')$$, '42501', null, 'Account Finance is refused');
select throws_ok($$select pg_temp.read('kai', 'e_kai')$$, '42501', null, 'the person reads their own details elsewhere');
select throws_ok($$select pg_temp.read('xavier', 'e_kai')$$, '42501', null, 'another tenant is refused');
select throws_ok($$select pg_temp.read('sam', 'e_kai')$$, '42501', null,
  'the worker the engagement names is refused: they are on the company''s roster, not its manager');

-- Producing-org readers ---------------------------------------------------------------------------------------------------------
select is(pg_temp.read('bob', 'e_kai') ->> 'reader', 'org', 'a member of the producing org reads as the org');
select ok((pg_temp.read('bob', 'e_kai') -> 'readable') <@ '["Emergency Contacts", "Passport"]'::jsonb
  and (pg_temp.read('bob', 'e_kai') -> 'readable') ? 'Emergency Contacts', 'only the shared categories their capabilities cover');
select ok(pg_temp.read('bob', 'e_kai') -> 'dietary' = 'null'::jsonb, 'an unshared category stays NULL for the org');
select ok(pg_temp.read('alice', 'self_ivy') #>> '{dietary,allergies}' is null
  and pg_temp.read('alice', 'self_ivy') #>> '{dietary,allergies_on_file}' = 'false', 'an org reader of shared dietary needs sees no allergies when none are on file');
select pg_temp.as_user('ivy');
select app.ensure_my_work_details();
update app.person_work_details set allergies = 'Shellfish' where person_id = pg_temp.id('ivy');
select pg_temp.as_platform();
select is(pg_temp.read('alice', 'self_ivy') #>> '{dietary,allergies}', 'Shellfish',
  'the Owner, who holds data.restricted.read.medical, reads the Restricted allergies (R6a, 2663)');
select is((select count(*)::int from app.work_detail_events where person_id = pg_temp.id('ivy') and action = 'allergies.viewed'
  and roster_entry_id = pg_temp.id('self_ivy')), 1, 'an unmasked allergy read is logged as allergies.viewed');

-- Logging ------------------------------------------------------------------------------------------------------------------------
create temporary table counts as
select (select count(*) from app.work_detail_events where person_id = pg_temp.id('kai') and action = 'work_details.viewed') as views,
  (select count(*) from app.audit_events where action = 'work_details.viewed' and subject_id = pg_temp.id('e_kai')) as audits;
select pg_temp.read('victor', 'e_kai');
select pg_temp.read('victor', 'e_kai');
select is((select count(*) from app.work_detail_events where person_id = pg_temp.id('kai') and action = 'work_details.viewed')
  - (select views from counts), 2::bigint, 'every read writes the person''s access log, with no ten-minute dedupe');
select is((select count(*) from app.audit_events where action = 'work_details.viewed' and subject_id = pg_temp.id('e_kai'))
  - (select audits from counts), 2::bigint, 'and the producing org''s audit ledger');
select is((select roster_entry_id from app.work_detail_events where person_id = pg_temp.id('kai') and action = 'work_details.viewed'
  order by created_at desc, id desc limit 1), pg_temp.id('e_kai'), 'naming the roster entry');
select is((select diff ->> 'reader' from app.audit_events where action = 'work_details.viewed' and subject_id = pg_temp.id('e_kai')
  order by created_at desc, id desc limit 1), 'company', 'and the audit event names the reader');

-- shared_work_details and reveals -----------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select is((app.shared_work_details(pg_temp.id('eng_ivy_a')) ->> 'roster_entry_id')::uuid, pg_temp.id('self_ivy'),
  'shared_work_details still answers, for the self entry');
select throws_like(format($$select app.reveal_roster_passport_number(%L, 'Booking the flight to Miami.')$$, pg_temp.id('e_kai')),
  'step_up_required:%', 'a reveal needs step-up');
select pg_temp.as_user_stepped_up('alice');
select throws_like(format($$select app.reveal_roster_passport_number(%L, 'Flight.')$$, pg_temp.id('e_kai')),
  'passport_reveal_reason:%', 'and a reason of at least 10 characters');
select is(app.reveal_roster_passport_number(pg_temp.id('e_kai'), 'Booking the flight to Miami.'), 'X1234567',
  'a producing-org reader reveals the number shared on the entry');
select pg_temp.as_user_stepped_up('victor');
select throws_ok(format($$select app.reveal_roster_passport_number(%L, 'Booking the flight to Miami.')$$, pg_temp.id('e_kai')),
  '42501', null, 'never the company');
select pg_temp.as_platform();
select is((select reason from app.work_detail_events where person_id = pg_temp.id('kai') and action = 'passport.revealed'
  and roster_entry_id = pg_temp.id('e_kai')), 'Booking the flight to Miami.', 'the reveal is logged with its reason and entry');

-- Decline and withdrawal end the company read --------------------------------------------------------------------------------
select pg_temp.as_user('kai');
select app.respond_roster_entry(pg_temp.id('e_kai'), 'Declined');
select pg_temp.as_platform();
select throws_ok($$select pg_temp.read('victor', 'e_kai')$$, '42501', null, 'after a decline the company reads nothing');
select ok(private.account_roster_consent(pg_temp.id('acct_v'), pg_temp.id('kai')) is null, 'the account consent is withdrawn on decline');
select ok((select revoked_at is not null from app.work_detail_shares where id = pg_temp.id('share_kai')), 'and the entry''s share is closed');
select pg_temp.as_user('kai');
select app.respond_roster_entry(pg_temp.id('e_kai'), 'Accepted');
select pg_temp.as_platform();
select is(pg_temp.read('victor', 'e_kai') ->> 'reader', 'company', 'accepting again restores the company read');
select pg_temp.as_user('victor');
select app.withdraw_roster_entry(pg_temp.id('e_kai'), 'Off the show.');
select pg_temp.as_platform();
select throws_ok($$select pg_temp.read('victor', 'e_kai')$$, '42501', null, 'after a withdrawal the company reads nothing');
select ok(private.account_roster_consent(pg_temp.id('acct_v'), pg_temp.id('kai')) is null, 'and the consent is withdrawn');

-- Advancing Lead as an engagement principal (R1's views) ------------------------------------------------------------------------
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select ok(pg_temp.principal('pia', 'eng_vendor_a'), 'an Advancing Lead answers for the engagement assigned to them');
select ok(not pg_temp.principal('mo', 'eng_vendor_a'), 'a Member-duty assignee does not');
select ok(not pg_temp.principal('fiona', 'eng_vendor_a'), 'nor Account Finance');
select pg_temp.as_user('alice');
-- Per diem is an offering since R3 (2625).
select app.set_setting(pg_temp.id('org_a'), 'offerings.per_diem', 'Project', pg_temp.id('prj_a'), 'provided');
select app.add_per_diems(pg_temp.id('prj_a'), null, pg_temp.id('eng_vendor_a'), '2027-06-01', '2027-06-01', 5000, 'USD');
select pg_temp.as_user('pia');
select is((select count(*)::int from api_external.per_diems where engagement_id = pg_temp.id('eng_vendor_a')), 1,
  'so the Advancing Lead reads its per diems through R1''s view');
select pg_temp.as_user('mo');
select is((select count(*)::int from api_external.per_diems where engagement_id = pg_temp.id('eng_vendor_a')), 0, 'the Member does not');
select pg_temp.as_platform();

-- Shares no roster entry keys (Client and Sponsor engagements, engagements closed before R4) ------------------------------------
select pg_temp.as_user('alice');
with x as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('victor'), pg_temp.id('cp_v_a'), 'Client', '2027-06-01') returning id)
insert into world select 'eng_client', id from x;
select pg_temp.as_user('victor');
select throws_like(format($$select app.share_work_details(%L, array['Dietary Needs']::app.work_detail_category[])$$, pg_temp.id('eng_client')),
  'work_detail_share_not_yours:%', 'the person of a Client engagement, which carries no roster entry, shares nothing (POST /work-detail-shares: 422)');
select pg_temp.as_platform();
-- A share made before R4, as 1340 allowed it.
with c as (insert into app.consent_records (org_id, person_id, purpose_code, notice_version, source)
  values (pg_temp.id('org_a'), pg_temp.id('victor'), 'work_details_sharing', '1.0.0', 'Web') returning id)
insert into world select 'consent_client', id from c;
alter table app.work_detail_shares disable trigger t41_guard_work_detail_share_entry;
with s as (insert into app.work_detail_shares (engagement_id, person_id, consent_record_id, categories)
  values (pg_temp.id('eng_client'), pg_temp.id('victor'), pg_temp.id('consent_client'), array['Dietary Needs']::app.work_detail_category[])
  returning id)
insert into world select 'share_client', id from s;
alter table app.work_detail_shares enable trigger t41_guard_work_detail_share_entry;
select is(private.close_unkeyed_work_detail_shares(), 1, '2638 closes every live share no roster entry keys');
select ok((select revoked_at is not null from app.work_detail_shares where id = pg_temp.id('share_client')), 'as a revocation');
select ok((select withdrawn_at is not null from app.consent_records where id = pg_temp.id('consent_client')),
  'withdrawing the org''s consent with its last live share');
select is((select count(*)::int from app.work_detail_events where person_id = pg_temp.id('victor') and action = 'work_details.share_revoked'
  and engagement_id = pg_temp.id('eng_client') and reason is not null), 1, 'logged in the person''s access log with the reason');
select is((select count(*)::int from app.work_detail_shares where roster_entry_id is null and revoked_at is null and deleted_at is null), 0,
  'no live share is left without an entry');

select * from finish();
rollback;
