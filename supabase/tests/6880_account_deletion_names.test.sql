-- pgTAP: migration 6880 (RRR-248). Deleting an account clears every name on the person, full, given and family, and
-- the account's own addresses (its SCIM identities and the invitations it accepted), while the records the law and the
-- retention schedule require stay with a person who has no name. An org's wage records keep the worker's name apart
-- from the person, 7 years after the latest of them, including the payroll lines and time entries written after the
-- deletion; an org that could still pay the person but has no record yet keeps it 90 days. The names are readable only
-- where a wage record prints them (the certified payroll), and purged when the period ends unless a legal hold over any
-- wage record table covers them. A hold over the invitations the deletion rewrites blocks it in that org even where the
-- person's membership is gone.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(46);

create function pg_temp.as_user_aal2(p_key text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- Frank, a Field member of org_a, gave a given and family name, worked a certified week and was provisioned by SCIM.
select pg_temp.as_platform();
insert into app.feature_flag_overrides (org_id, flag_key, enabled, reason)
values (pg_temp.id('org_a'), 'compliance.us_forms', true, 'Test: the forms are on for org_a.');
update app.people set given_name = 'Frank', family_name = 'Adeyemi' where id = pg_temp.id('frank');
update app.people set given_name = 'Ivy', family_name = 'Marchetti' where id = pg_temp.id('ivy');
insert into app.person_emergency_contacts (person_id, full_name, relationship, phone_e164, email, sort_order)
values (pg_temp.id('frank'), 'Ada Adeyemi', 'Sister', '+13055550100', 'ada@family.test', 1);
update app.subscriptions set plan_code = 'enterprise' where org_id = pg_temp.id('org_a');
with p as (insert into app.identity_providers (org_id, protocol, name, auth_provider_id, default_role_id, scim_enabled)
  values (pg_temp.id('org_a'), 'SAML', 'Okta', 'prov-1', pg_temp.system_role('member'), true) returning id)
  insert into world select 'idp', id from p;
with s as (insert into app.scim_identities (identity_provider_id, external_id, user_name, person_id, active, groups)
  values (pg_temp.id('idp'), '00u1frank', 'frank@northwind.test', pg_temp.id('frank'), true, '{}') returning id)
  insert into world select 'scim_frank', id from s;
with i as (insert into app.invites (org_id, email, role_id, token_hash, expires_at, invited_by, accepted_at, accepted_person_id)
  values (pg_temp.id('org_a'), 'frank@northwind.test', pg_temp.system_role('field'), sha256('frank-invite'::bytea),
          now() + interval '1 day', pg_temp.id('bob'), now() - interval '1 day', pg_temp.id('frank')) returning id)
  insert into world select 'invite_frank', id from i;
with i as (insert into app.invites (org_id, email, role_id, token_hash, expires_at, invited_by)
  values (pg_temp.id('org_a'), 'frank.other@northwind.test', pg_temp.system_role('field'), sha256('pending-invite'::bytea),
          now() + interval '1 day', pg_temp.id('bob')) returning id)
  insert into world select 'invite_pending', id from i;
with i as (insert into app.account_invitations (org_id, email, account_role, invited_by, expires_at, accepted_at, accepted_person_id)
  values (pg_temp.id('acct_v'), 'frank@northwind.test', 'Account Member', pg_temp.id('victor'), now() + interval '7 days',
          now() - interval '1 day', pg_temp.id('frank')) returning id)
  insert into world select 'acct_invite_frank', id from i;

select pg_temp.as_user('bob');
insert into app.pay_rates (membership_id, role_code, rate_minor, currency_code, effective_from)
values (pg_temp.id('frank@org_a'), '0000.50.01', 3200, 'USD', '2027-01-01');
select pg_temp.as_user('frank');
insert into app.time_entries (project_id, membership_id, clock_in, clock_out)
select pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), (d::date + time '12:00') at time zone 'UTC', (d::date + time '22:00') at time zone 'UTC'
from generate_series(date '2027-06-07', date '2027-06-11', interval '1 day') d;
with x as (insert into app.timesheets (project_id, membership_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-06-07', '2027-06-13') returning id) insert into world select 'ts', id from x;
select app.submit_timesheet(pg_temp.id('ts'));
select pg_temp.as_user('carol');
select app.decide_timesheet(pg_temp.id('ts'), 'Approved', 'Matches the call sheet.');
select pg_temp.as_user_aal2('alice');
insert into app.certified_payroll_projects (project_id, contract_number, wage_determinations, business_name, business_address, project_location)
values (pg_temp.id('prj_a'), 'GS-07P-27-0001', 'FL20270001 Mod 2', 'Northwind Live LLC', '100 Harbor Way, Miami, FL 33132', 'Miami-Dade County, FL');
select results_eq($$select last_name, first_name from app.certified_payroll((select id from world where key = 'prj_a'), '2027-06-13')$$,
  $$values ('Adeyemi'::text, 'Frank'::text)$$, 'before the deletion the certified payroll names Frank from his person');

-- His payroll line for the pay period of 7 to 20 June, written before the deletion.
select pg_temp.as_platform();
with x as (insert into app.pay_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-06-07', '2027-06-20') returning id)
  insert into world select 'pp1', id from x;
with x as (insert into app.payroll_runs (pay_period_id, currency_code) values (pg_temp.id('pp1'), 'USD') returning id)
  insert into world select 'run1', id from x;
with x as (insert into app.earning_codes (org_id, code, name) values (pg_temp.id('org_a'), 'REG', 'Regular') returning id)
  insert into world select 'reg', id from x;
insert into app.payroll_lines (payroll_run_id, membership_id, earning_code_id, hours, rate_minor, role_code)
values (pg_temp.id('run1'), pg_temp.id('frank@org_a'), pg_temp.id('reg'), 40, 3200, '0000.50.01');

-- A crew roster invitation of Bayside Audio (acct_v), which Frank claims.
select pg_temp.as_user('victor');
insert into world select 'e_frank', app.invite_to_roster(pg_temp.id('eng_vendor_a'), 'frank@northwind.test', '9000.50.02');
select pg_temp.as_platform();
insert into world select 'roster_invite_frank', id from app.roster_invitations where roster_entry_id = pg_temp.id('e_frank');
select pg_temp.as_user('frank');
select is(app.respond_party_invitation('roster', pg_temp.id('roster_invite_frank'), true), pg_temp.id('e_frank'),
  'Frank claims a crew roster invitation');

-- A legal hold over the tables the deletion now also writes blocks it ---------------------------------------------------
select pg_temp.as_platform();
select ok(private.account_deletion_tables() @> array['app.scim_identities', 'app.invites', 'app.account_invitations', 'app.roster_invitations'],
  'the SCIM identities and invitations the deletion erases are among the tables a legal hold can cover');
with x as (insert into app.legal_holds (org_id, table_name, matter) values (pg_temp.id('org_a'), 'app.scim_identities', 'Access review 2027') returning id)
  insert into world select 'hold_scim', id from x;
select pg_temp.as_user('frank');
select is(app.account_deletion_preview() -> 'blockers' -> 0 ->> 'code', 'account_delete_legal_hold', 'a hold over SCIM identities blocks the deletion');
select pg_temp.as_platform();
update app.legal_holds set released_at = now() where id = pg_temp.id('hold_scim');
-- org_b, where Frank was never a member, keeps an invitation he accepted; a hold over its invitations blocks the deletion.
with i as (insert into app.invites (org_id, email, role_id, token_hash, expires_at, invited_by, accepted_at, accepted_person_id)
  values (pg_temp.id('org_b'), 'frank@northwind.test', pg_temp.system_role('field'), sha256('frank-invite-b'::bytea),
          now() + interval '1 day', pg_temp.id('xavier'), now() - interval '1 day', pg_temp.id('frank')) returning id)
  insert into world select 'invite_frank_b', id from i;
with x as (insert into app.legal_holds (org_id, table_name, matter) values (pg_temp.id('org_b'), 'app.invites', 'Hiring review 2027') returning id)
  insert into world select 'hold_invites_b', id from x;
select pg_temp.as_user('frank');
select is(app.account_deletion_preview() -> 'blockers' -> 0 ->> 'org_id', pg_temp.id('org_b')::text,
  'a hold over invitations in an org where he holds no membership blocks the deletion too');
select pg_temp.as_platform();
update app.legal_holds set released_at = now() where id = pg_temp.id('hold_invites_b');

-- Frank deletes his account -----------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select is((select r ->> 'replayed' from app.delete_my_account('frank@northwind.test') r), 'false', 'Frank deletes his account');
select pg_temp.as_platform();
select is((select row(full_name, given_name, family_name)::text from app.people where id = pg_temp.id('frank')), '(,,)',
  'the person keeps no full, given or family name');
select ok((select deleted_at is not null and user_id is null from app.people where id = pg_temp.id('frank')), 'and no sign-in');
select is((select count(*)::int from auth.identities where user_id = pg_temp.id('frank_user')), 0,
  'the sign-in''s identities, where Sign in with Apple keeps a name and email, are gone with it');
select is((select count(*)::int from app.person_emergency_contacts where person_id = pg_temp.id('frank')), 0,
  'his emergency contacts, with their names, phones and emails, are erased');
select is((select row(active, deleted_at is not null, user_name <> 'frank@northwind.test', external_id <> '00u1frank')::text
  from app.scim_identities where id = pg_temp.id('scim_frank')), '(f,t,t,t)',
  'his SCIM identity is ended, without the provider''s user name or id for him');
select is((select email from app.invites where id = pg_temp.id('invite_frank')),
  'erased-' || replace(pg_temp.id('invite_frank')::text, '-', '') || '@erased.invalid', 'the invitation he accepted keeps no address of his');
select ok((select accepted_at is not null and accepted_person_id = pg_temp.id('frank') from app.invites where id = pg_temp.id('invite_frank')),
  'and stays in the org''s record with its dates');
select is((select email from app.account_invitations where id = pg_temp.id('acct_invite_frank')),
  'erased-' || replace(pg_temp.id('acct_invite_frank')::text, '-', '') || '@erased.invalid', 'so does the external account invitation he accepted');
select is((select row(email, claimed_at is not null, claimed_person_id = pg_temp.id('frank'))::text from app.roster_invitations
  where id = pg_temp.id('roster_invite_frank')),
  '(erased-' || replace(pg_temp.id('roster_invite_frank')::text, '-', '') || '@erased.invalid,t,t)',
  'and the crew roster invitation he claimed, which keeps its claim');
select is((select email from app.invites where id = pg_temp.id('invite_frank_b')),
  'erased-' || replace(pg_temp.id('invite_frank_b')::text, '-', '') || '@erased.invalid', 'and the one he accepted in org_b');
select is((select email from app.invites where id = pg_temp.id('invite_pending')), 'frank.other@northwind.test',
  'an invitation he never accepted is the org''s own record and is left alone');

-- The records the law requires stay, with a person who has no name -------------------------------------------------------
select is((select count(*)::int from app.time_entries where membership_id = pg_temp.id('frank@org_a') and deleted_at is null), 5,
  'his time entries stay for payroll retention');
select is((select timesheet_state::text from app.timesheets where id = pg_temp.id('ts')), 'Approved', 'and so does his approved timesheet');
select is((select count(*)::int from app.time_entries t join app.memberships m on m.id = t.membership_id
  join app.people p on p.id = m.person_id where t.membership_id = pg_temp.id('frank@org_a') and p.full_name is null and p.given_name is null
  and p.family_name is null), 5, 'every one of them points to a person with no name');
select is((select dsar_state::text from app.dsar_requests where subject_person_id = pg_temp.id('frank') and org_id = pg_temp.id('org_a')),
  'Completed', 'the org''s register keeps the completed erasure request');

-- The wage records' own copy of his name ----------------------------------------------------------------------------------
select results_eq($$select org_id, full_name, given_name, family_name, last_wage_record_on, retain_until from private.wage_record_names
  where person_id = (select id from world where key = 'frank') order by org_id$$,
  $$values ((select id from world where key = 'org_a'), 'Frank Adeyemi'::text, 'Frank'::text, 'Adeyemi'::text, date '2027-06-20', date '2034-06-20')$$,
  'only org_a, which has his wage records, keeps his names, until 7 years after the end of the pay period his payroll line pays, his latest record');

-- Records written after the deletion extend the period ---------------------------------------------------------------------
select pg_temp.as_platform();
with x as (insert into app.pay_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-06-21', '2027-07-04') returning id)
  insert into world select 'pp2', id from x;
with x as (insert into app.payroll_runs (pay_period_id, currency_code) values (pg_temp.id('pp2'), 'USD') returning id)
  insert into world select 'run2', id from x;
insert into app.payroll_lines (payroll_run_id, membership_id, earning_code_id, hours, rate_minor, role_code)
values (pg_temp.id('run2'), pg_temp.id('frank@org_a'), pg_temp.id('reg'), 8, 3200, '0000.50.01');
select is((select row(last_wage_record_on, retain_until)::text from private.wage_record_names
  where person_id = pg_temp.id('frank') and org_id = pg_temp.id('org_a')), '(2027-07-04,2034-07-04)',
  'the final payroll run, written after the deletion, keeps his names 7 years after its pay period ends');
insert into app.time_entries (project_id, membership_id, clock_in, clock_out)
values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), timestamptz '2027-07-12 12:00Z', timestamptz '2027-07-12 20:00Z');
select is((select row(last_wage_record_on, retain_until)::text from private.wage_record_names
  where person_id = pg_temp.id('frank') and org_id = pg_temp.id('org_a')), '(2027-07-12,2034-07-12)',
  'and so does a time entry a manager adds for him afterwards');
insert into app.time_entries (project_id, membership_id, clock_in, clock_out)
values (pg_temp.id('prj_a'), pg_temp.id('dave@org_a'), timestamptz '2027-08-02 12:00Z', timestamptz '2027-08-02 20:00Z');
select is((select count(*)::int from private.wage_record_names where person_id = pg_temp.id('dave')), 0,
  'the records of a person who still has an account copy no name');
select pg_temp.as_user_aal2('alice');
select results_eq($$select last_name, first_name from app.certified_payroll((select id from world where key = 'prj_a'), '2027-06-13')$$,
  $$values ('Adeyemi'::text, 'Frank'::text)$$, 'the certified payroll for his week still names him, as wage law requires');
select throws_ok($$select full_name from private.wage_record_names$$, '42501', null, 'no signed-in caller reads the kept names directly');
select is((select count(*)::int from app.people where id = pg_temp.id('frank') and full_name is not null), 0,
  'and the person they read stays nameless');

-- Purge after the retention period ----------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is((select count(*)::int from cron.job where jobname = 'xos_purge_wage_record_names' and schedule = '19 3 * * *'), 1,
  'the purge runs nightly');
select is(private.purge_wage_record_names(), 0, 'nothing is purged before the period ends');
update private.wage_record_names set retain_until = current_date - 1 where person_id = pg_temp.id('frank');
with x as (insert into app.legal_holds (org_id, table_name, matter) values (pg_temp.id('org_a'), 'app.time_entries', 'Wage audit 2034') returning id)
  insert into world select 'hold_wages', id from x;
select is(private.purge_wage_record_names(), 0, 'a legal hold over the wage records keeps the names past the period');
update app.legal_holds set released_at = now() where id = pg_temp.id('hold_wages');
with x as (insert into app.legal_holds (org_id, table_name, matter) values (pg_temp.id('org_a'), 'app.payroll_runs', 'Payroll audit 2034') returning id)
  insert into world select 'hold_runs', id from x;
select is(private.purge_wage_record_names(), 0, 'and so does one over payroll runs, or any other wage record table');
update app.legal_holds set released_at = now() where id = pg_temp.id('hold_runs');
select is(private.purge_wage_record_names(), 1, 'once the holds are released they are purged');
select is((select count(*)::int from private.wage_record_names where person_id = pg_temp.id('frank')), 0, 'and nothing of his name is left');

-- A member who could still be paid -------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select is((select r ->> 'replayed' from app.delete_my_account('gina@northwind.test') r), 'false', 'Gina, a member of org_a with no time entries, deletes her account');
select pg_temp.as_platform();
select is((select row(last_wage_record_on, retain_until = current_date + 90)::text from private.wage_record_names
  where person_id = pg_temp.id('gina') and org_id = pg_temp.id('org_a')), '(,t)',
  'org_a, which could still pay her, keeps her names 90 days with no wage record yet');
select ok(not (private.account_deletion_kept(pg_temp.id('gina')) @> '[{"category": "time_and_pay"}]'),
  'and her deletion sheet lists no time and pay records, as she has none');
insert into app.payroll_lines (payroll_run_id, membership_id, earning_code_id, hours, rate_minor, role_code)
values (pg_temp.id('run2'), pg_temp.id('gina@org_a'), pg_temp.id('reg'), 4, 2800, '0000.50.01');
select is((select row(last_wage_record_on, retain_until)::text from private.wage_record_names
  where person_id = pg_temp.id('gina') and org_id = pg_temp.id('org_a')), '(2027-07-04,2034-07-04)',
  'her final pay, written within the 90 days, keeps them 7 years after its pay period ends');
select pg_temp.as_user('dave');
select is((select r ->> 'replayed' from app.delete_my_account('dave@northwind.test') r), 'false', 'Dave, another member with no time entries, deletes his account');
select pg_temp.as_platform();
update private.wage_record_names set retain_until = current_date - 1 where person_id = pg_temp.id('dave');
select is(private.purge_wage_record_names(), 1, 'with no wage record of his once the 90 days pass, his names are purged');
select is((select count(*)::int from private.wage_record_names where person_id = pg_temp.id('gina')), 1, 'while Gina''s stay');

-- A person with no wage records ----------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select is((select r ->> 'replayed' from app.delete_my_account('ivy@freelance.test') r), 'false', 'Ivy, engaged as crew with no time entries, deletes her account');
select pg_temp.as_platform();
select is((select row(full_name, given_name, family_name)::text from app.people where id = pg_temp.id('ivy')), '(,,)',
  'her full, given and family names are cleared');
select is((select count(*)::int from private.wage_record_names where person_id = pg_temp.id('ivy')), 0,
  'and with no wage records or open pay, no copy of her name is kept anywhere');
select ok(not (private.account_deletion_kept(pg_temp.id('ivy')) @> '[{"category": "time_and_pay"}]'),
  'her deletion sheet lists no time and pay records either');

select is((select count(*)::int from information_schema.role_routine_grants where routine_schema = 'private'
  and routine_name in ('retain_wage_record_names', 'purge_wage_record_names', 'erase_account_contacts', 'extend_wage_record_names',
                       'wage_record_tables', 'account_contact_org_ids')
  and grantee in ('anon', 'authenticated')), 0, 'none of the new functions is granted to a signed-in caller');

select * from finish();
rollback;
