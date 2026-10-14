-- pgTAP: onboarding (Section 4.4.4, Section 14.9). Requirements per role type and jurisdiction, the onboarding
-- packet created with each engagement, verifications with expiry and carry-over, separation of duties for
-- reviewers, the database rule that an engagement becomes Active only when every blocking item passes, tax forms
-- (encrypted, last four only), payout accounts (provider references only) and background checks (result and
-- reference only).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create function pg_temp.item(p_engagement text, p_requirement text) returns uuid
language sql stable as $$
  select i.id from app.onboarding_items i where i.engagement_id = pg_temp.id(p_engagement) and i.onboarding_requirement_id = pg_temp.id(p_requirement)
$$;
grant execute on function pg_temp.item(text, text) to public;

-- Requirements -----------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with r as (insert into app.onboarding_requirements (org_id, name, item_kind, role_type, jurisdiction_id, verification_method, valid_for_days, remind_days_before)
  values (pg_temp.id('org_a'), 'Certificate of Insurance', 'Document Upload', 'Crew', 'US-FL', 'Reviewer', 365, 30) returning id) insert into world select 'req_coi', id from r;
with r as (insert into app.onboarding_requirements (org_id, name, item_kind, verification_method)
  values (pg_temp.id('org_a'), 'Crew Agreement', 'Electronic Signature', 'Reviewer') returning id) insert into world select 'req_agreement', id from r;
with r as (insert into app.onboarding_requirements (org_id, name, item_kind, verification_method, is_blocking)
  values (pg_temp.id('org_a'), 'Uniform Sizes', 'Form', 'Reviewer', false) returning id) insert into world select 'req_uniform', id from r;
with r as (insert into app.onboarding_requirements (org_id, name, item_kind, role_type, jurisdiction_id, verification_method)
  values (pg_temp.id('org_a'), 'Right to Work Check', 'Background Check', 'Crew', 'GB', 'Automatic') returning id) insert into world select 'req_gb', id from r;
with r as (insert into app.onboarding_requirements (org_id, name, item_kind, role_type, verification_method)
  values (pg_temp.id('org_a'), 'Vendor Insurance Feed', 'Document Upload', 'Vendor', 'Automatic') returning id) insert into world select 'req_auto', id from r;
select throws_ok($$insert into app.onboarding_requirements (org_id, name, item_kind, verification_method, remind_days_before) values ((select id from world where key = 'org_a'), 'Reminder Without Expiry', 'Form', 'Reviewer', 10)$$,
  '23514', null, 'a reminder needs an expiry');
select pg_temp.as_user('dave');
select throws_ok($$insert into app.onboarding_requirements (org_id, name, item_kind, verification_method) values ((select id from world where key = 'org_a'), 'Nope', 'Form', 'Reviewer')$$,
  '42501', null, 'a Member cannot define requirements');
select pg_temp.as_platform();

-- The onboarding packet ---------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with e as (insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('quinn'), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-06-01') returning id)
  insert into world select 'eng_quinn_a', id from e;
select is((select count(*)::int from app.onboarding_items where engagement_id = pg_temp.id('eng_quinn_a')), 3,
  'a new engagement gets one item per requirement that applies (role type and jurisdiction chain)');
select ok(pg_temp.item('eng_quinn_a', 'req_gb') is null, 'a requirement for another jurisdiction does not apply');
select throws_ok($$select app.transition_engagement((select id from world where key = 'eng_quinn_a'), 'Onboarding', 'Active', 'Go.')$$,
  'XR001', 'onboarding_incomplete: Every blocking onboarding item must pass before the engagement is Active; open: Certificate of Insurance, Crew Agreement.',
  'an engagement cannot become Active while a blocking item is open');
select throws_ok($$select app.transition_engagement((select id from world where key = 'eng_ivy_a'), 'Onboarding', 'Active', 'Go.')$$,
  'XR001', null, 'requirements added after an engagement was created still block it');
select pg_temp.as_platform();
select throws_ok($$update app.engagements set engagement_state = 'Active' where id = (select id from world where key = 'eng_quinn_a')$$,
  'XR001', null, 'no path around the transition RPC');

-- Party side
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.onboarding_items), 3, 'the engaged person reads their onboarding items');
select is((select count(*)::int from app.onboarding_item_status where engagement_id = pg_temp.id('eng_quinn_a') and not passes), 3, 'and their progress');
select lives_ok($$select app.submit_onboarding_item(pg_temp.item('eng_quinn_a', 'req_coi'))$$, 'the party submits an item');
select ok((select submitted_at is not null from app.onboarding_items where id = pg_temp.item('eng_quinn_a', 'req_coi')), 'submission is stamped');
select throws_ok($$insert into app.onboarding_verifications (onboarding_item_id, outcome) values (pg_temp.item('eng_quinn_a', 'req_coi'), 'Passed')$$,
  'XR001', 'sod_onboarding_self_verify: An engaged party cannot verify their own onboarding.', 'the party cannot verify their own items');
select pg_temp.as_user('ivy');
select is((select count(*)::int from app.onboarding_items where engagement_id = pg_temp.id('eng_quinn_a')), 0, 'denial for another party''s onboarding items');
select pg_temp.as_platform();
select pg_temp.as_user('ivy');
select throws_ok(format($$select app.submit_onboarding_item(%L)$$, pg_temp.item('eng_quinn_a', 'req_coi')), '42501', null, 'another party cannot submit the item');
select pg_temp.as_platform();

-- Verification
select pg_temp.as_user('carol');
select lives_ok(format($$insert into app.onboarding_verifications (onboarding_item_id, outcome, note) values (%L, 'Passed', 'Names Northwind as additional insured.')$$,
  pg_temp.item('eng_quinn_a', 'req_coi')), 'a reviewer passes the insurance certificate');
select is((select expires_on from app.onboarding_verifications where onboarding_item_id = pg_temp.item('eng_quinn_a', 'req_coi')), current_date + 365,
  'a pass expires after the requirement''s validity');
select is((select verified_by from app.onboarding_verifications where onboarding_item_id = pg_temp.item('eng_quinn_a', 'req_coi')), pg_temp.id('carol'), 'the reviewer is stamped');
select throws_ok($$select app.transition_engagement((select id from world where key = 'eng_quinn_a'), 'Onboarding', 'Active', 'Go.')$$,
  'XR001', 'onboarding_incomplete: Every blocking onboarding item must pass before the engagement is Active; open: Crew Agreement.', 'one blocking item is still open');
select lives_ok(format($$insert into app.onboarding_verifications (onboarding_item_id, outcome) values (%L, 'Failed')$$, pg_temp.item('eng_quinn_a', 'req_agreement')), 'a reviewer fails an item');
select throws_ok($$select app.transition_engagement((select id from world where key = 'eng_quinn_a'), 'Onboarding', 'Active', 'Go.')$$,
  'XR001', null, 'a failed item still blocks');
select lives_ok(format($$insert into app.onboarding_verifications (onboarding_item_id, outcome) values (%L, 'Passed')$$, pg_temp.item('eng_quinn_a', 'req_agreement')), 'then passes it on resubmission');
select lives_ok($$select app.transition_engagement((select id from world where key = 'eng_quinn_a'), 'Onboarding', 'Active', 'Onboarded.')$$,
  'every blocking item passes, so the engagement becomes Active; a non-blocking item may stay open');
select throws_ok(format($$update app.onboarding_verifications set outcome = 'Failed' where onboarding_item_id = %L$$, pg_temp.item('eng_quinn_a', 'req_coi')),
  '42501', null, 'verifications are never edited');
select pg_temp.as_platform();
select throws_ok(format($$update app.onboarding_verifications set outcome = 'Failed' where onboarding_item_id = %L$$, pg_temp.item('eng_quinn_a', 'req_coi')),
  'XR001', null, 'verifications are append-only');
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.onboarding_verifications), 0, 'reviewer notes and verification rows stay internal');
select is((select count(*)::int from app.onboarding_item_status where engagement_id = pg_temp.id('eng_quinn_a') and passes), 2, 'the party sees which items pass');
select pg_temp.as_platform();

-- Expiry and carry-over
select pg_temp.as_user('carol');
with e as (insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a2'), pg_temp.id('quinn'), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-12-01') returning id)
  insert into world select 'eng_quinn_a2', id from e;
select is((select count(*)::int from app.onboarding_items where engagement_id = pg_temp.id('eng_quinn_a2')), 2,
  'a project with no jurisdiction gets only the requirements without one');
select ok((select carried_over from app.onboarding_item_status where onboarding_item_id = pg_temp.item('eng_quinn_a2', 'req_agreement')),
  'a verified, unexpired item carries over to a later engagement with the same org');
select lives_ok($$select app.transition_engagement((select id from world where key = 'eng_quinn_a2'), 'Onboarding', 'Active', 'Returning crew.')$$,
  'carried-over items satisfy the blocking rule');
select pg_temp.as_platform();
insert into app.onboarding_verifications (onboarding_item_id, outcome, expires_on) values (pg_temp.item('eng_quinn_a', 'req_coi'), 'Passed', current_date - 1);
select ok(not private.onboarding_item_passes(pg_temp.item('eng_quinn_a', 'req_coi')), 'an expired verification no longer passes');
insert into app.onboarding_verifications (onboarding_item_id, outcome, expires_on) values (pg_temp.item('eng_quinn_a', 'req_coi'), 'Passed', current_date + 10);
select pg_temp.as_user('carol');
select ok((select reminder_due from app.onboarding_item_status where onboarding_item_id = pg_temp.item('eng_quinn_a', 'req_coi')),
  'a reminder is due inside the window before expiry');
select pg_temp.as_platform();

-- Automatic verification
select pg_temp.as_user('carol');
select throws_ok(format($$insert into app.onboarding_verifications (onboarding_item_id, outcome) values (%L, 'Passed')$$, pg_temp.item('eng_vendor_a', 'req_auto')),
  '23502', null, 'requirements added after creation have no item until the org adds one');
insert into app.onboarding_items (engagement_id, onboarding_requirement_id) values (pg_temp.id('eng_vendor_a'), pg_temp.id('req_auto'));
select throws_ok(format($$insert into app.onboarding_verifications (onboarding_item_id, outcome) values (%L, 'Passed')$$, pg_temp.item('eng_vendor_a', 'req_auto')),
  'XR001', 'verification_automatic: This item is verified automatically by its integration.', 'an automatic item is not passed by a person');
select throws_ok(format($$select app.verify_onboarding_item_automatically(%L, 'Passed')$$, pg_temp.item('eng_vendor_a', 'req_auto')),
  '42501', null, 'signed-in callers cannot record automatic verifications');
select pg_temp.as_platform();
select lives_ok(format($$select app.verify_onboarding_item_automatically(%L, 'Passed')$$, pg_temp.item('eng_vendor_a', 'req_auto')), 'the platform records an automatic pass');

-- Separation of duties: an internal reviewer who is also the engaged party (Section 4.8.1)
select pg_temp.as_user('xavier');
with r as (insert into app.onboarding_requirements (org_id, name, item_kind, verification_method) values (pg_temp.id('org_b'), 'Performer Agreement', 'Electronic Signature', 'Reviewer') returning id)
  insert into world select 'req_b', id from r;
with e as (insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_b'), pg_temp.id('xavier'), 'Artist', '2000.50.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-07-04') returning id)
  insert into world select 'eng_xavier_b', id from e;
select throws_ok(format($$insert into app.onboarding_verifications (onboarding_item_id, outcome) values (%L, 'Passed')$$, pg_temp.item('eng_xavier_b', 'req_b')),
  'XR001', 'sod_onboarding_self_verify: An engaged party cannot verify their own onboarding.', 'an employee booked as an artist cannot verify their own onboarding');
update app.onboarding_requirements set deleted_at = now() where id = pg_temp.id('req_b');
select pg_temp.as_platform();

-- Tax forms -------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
with t as (select app.submit_tax_form(pg_temp.id('org_a'), 'W-9', '123-45-6789') as id) insert into world select 'tax_ivy', id from t;
select is((select tin_last4 from app.tax_forms where id = pg_temp.id('tax_ivy')), '6789', 'only the last four are kept for display');
select throws_ok('select tin_encrypted from app.tax_forms', '42501', null, 'the encrypted identifier is never selectable');
select throws_ok($$select app.submit_tax_form((select id from world where key = 'org_a'), 'W-9', '12-345')$$,
  'XR001', 'tin_format: A W-9 taxpayer identification number has nine digits.', 'TIN format is validated (Section 14.9)');
select throws_ok($$select app.submit_tax_form((select id from world where key = 'org_a'), 'W-8BEN-E', 'GB123456789')$$,
  'XR001', null, 'a person does not file W-8BEN-E');
select throws_ok($$insert into app.tax_forms (org_id, person_id, form_kind, tin_encrypted, tin_last4) values ((select id from world where key = 'org_a'), (select id from world where key = 'ivy'), 'W-9', '\x00', '0000')$$,
  '42501', null, 'tax forms are written only through the secure form path');
select pg_temp.as_platform();
select is(private.tax_form_tin(pg_temp.id('tax_ivy')), '123456789', 'the service role decrypts for the year-end export');
select ok((select tin_encrypted::text not like '%123456789%' from app.tax_forms where id = pg_temp.id('tax_ivy')), 'the identifier is stored encrypted');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.tax_forms), 0, 'a Member without data.restricted.read.tax reads no tax forms');
select pg_temp.as_user('alice');
select is((select tin_last4 from app.tax_forms where id = pg_temp.id('tax_ivy')), '6789', 'the Owner reads the form, still only the last four');
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.tax_forms), 0, 'another payee reads nothing');
select pg_temp.as_user('victor');
select lives_ok($$insert into world select 'tax_v', app.submit_tax_form((select id from world where key = 'org_a'), 'W-9', '98-7654321', (select id from world where key = 'acct_v'))$$,
  'an Account Owner files the account''s W-9');
select pg_temp.as_user('fiona');
select is((select count(*)::int from app.tax_forms), 1, 'Account Finance reads the account''s tax form');
select pg_temp.as_user('sam');
select is((select count(*)::int from app.tax_forms), 0, 'an Account Member does not');
select throws_ok($$select app.submit_tax_form((select id from world where key = 'org_a'), 'W-9', '987654321', (select id from world where key = 'acct_v'))$$,
  '42501', null, 'nor files one for the account');
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_ivy_b', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_ivy_b', 'Active', 'Closing');
select pg_temp.move_engagement('eng_ivy_b', 'Closing', 'Complete');
select pg_temp.backdate_close('eng_ivy_b', interval '3 years');
select pg_temp.as_user('ivy');
select is((select count(*)::int from app.tax_forms), 1, 'a person''s own tax forms never close (Section 8.7)');
select pg_temp.as_platform();

-- Payout accounts --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select lives_ok($$insert into app.payout_accounts (org_id, person_id, provider, provider_account_reference, account_last4) values ((select id from world where key = 'org_a'), (select id from world where key = 'ivy'), 'Stripe Connect', 'acct_check_ivy', '4242')$$,
  'a payee records their provider reference');
select throws_ok($$insert into app.payout_accounts (org_id, person_id, provider, provider_account_reference) values ((select id from world where key = 'org_a'), (select id from world where key = 'quinn'), 'Stripe Connect', 'acct_x')$$,
  '42501', null, 'nobody records payout details for someone else');
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.payout_accounts), 0, 'another payee reads none');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.payout_accounts), 0, 'a Member without data.restricted.read.banking reads none');
select pg_temp.as_user('alice');
select is((select provider_account_reference from app.payout_accounts), 'acct_check_ivy', 'the Owner reads the provider reference');
select pg_temp.as_platform();

-- Background checks -------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with b as (insert into app.background_checks (engagement_id, provider_reference) values (pg_temp.id('eng_quinn_a'), 'chk_check_0001') returning id) insert into world select 'bg_quinn', id from b;
select throws_ok($$insert into app.background_checks (engagement_id, provider, provider_reference) values ((select id from world where key = 'eng_quinn_a'), 'Other', 'x')$$,
  '23514', null, 'checks run through the provider');
select pg_temp.as_platform();
update app.background_checks set result = 'Clear', completed_at = now() where id = pg_temp.id('bg_quinn');
select throws_ok($$update app.background_checks set result = 'Consider', completed_at = null where id = (select id from world where key = 'bg_quinn')$$,
  '23514', null, 'a completed result carries its completion time');
select pg_temp.as_user('quinn');
select is((select result::text from app.background_checks), 'Clear', 'the subject reads their own result');
select pg_temp.as_user('ivy');
select is((select count(*)::int from app.background_checks), 0, 'nobody else outside the org does');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.background_checks), 0, 'nor members without opportunities.onboarding.write');
select pg_temp.as_platform();

-- Anon deny -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select throws_ok(format('select 1 from %s', t), '42501', null, 'anon cannot read ' || t)
from unnest(array['app.onboarding_requirements', 'app.onboarding_items', 'app.onboarding_verifications', 'app.tax_forms',
  'app.payout_accounts', 'app.background_checks', 'app.onboarding_item_status']) as t;
select throws_ok($$select app.submit_tax_form(gen_random_uuid(), 'W-9', '123456789')$$, '42501', null, 'anon cannot submit tax forms');
select pg_temp.as_platform();

select * from finish();
rollback;
