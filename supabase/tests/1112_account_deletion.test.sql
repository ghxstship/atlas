-- pgTAP: a person deletes their own account (A42, SIM-004, journey 38). The confirmation, every refusal
-- (legal hold, on shift, sole owner) with nothing deleted, what is erased, what is kept, memberships ended,
-- engagements canceled, the DSAR register in every related org, the auth user gone, idempotent replay,
-- and anon denied.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(31);

select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_platform();
insert into app.person_links (person_id, label, url) values (pg_temp.id('ivy'), 'Showreel', 'https://ivy.freelance.test/reel');
insert into app.person_languages (person_id, language_tag, proficiency)
  select pg_temp.id('ivy'), 'it', p.p from (select (enum_range(null::app.language_proficiency))[1] as p) p;
-- dave worked a shift for org_a last week; frank is clocked in now.
insert into app.time_entries (project_id, membership_id, clock_in, clock_out, source)
values (pg_temp.id('prj_a'), pg_temp.id('dave@org_a'), now() - interval '7 days 8 hours', now() - interval '7 days', 'Mobile');
insert into app.time_entries (project_id, membership_id, clock_in, source)
values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), now() - interval '2 hours', 'Mobile');

-- anon ------------------------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select throws_ok($$select app.delete_my_account('ivy@freelance.test')$$, '42501', null, 'anon cannot delete an account');
select throws_ok($$select app.account_deletion_preview()$$, '42501', null, 'nor preview a deletion');

-- Preview and confirmation ----------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select is(app.account_deletion_preview() -> 'blockers', '[]'::jsonb, 'an external crew member with no hold may delete their account');
select ok(app.account_deletion_preview() -> 'kept' @> '[{"category": "engagements"}]', 'the preview says their engagement records are kept');
select throws_ok($$select app.delete_my_account('someone@else.test')$$, 'XR001',
  'account_delete_confirmation: Type the email address you sign in with to confirm.', 'the typed email must match the sign-in');

-- A legal hold over the records refuses, with the org and matter named, and deletes nothing -----------------------
select pg_temp.as_user('xavier');
with x as (insert into app.legal_holds (org_id, table_name, matter) values (pg_temp.id('org_b'), 'app.people', 'Pier Nights injury claim') returning id)
  insert into world select 'hold', id from x;
select pg_temp.as_user('ivy');
select is(app.account_deletion_preview() -> 'blockers' -> 0 ->> 'code', 'account_delete_legal_hold', 'the preview names the legal hold');
select throws_ok($$select app.delete_my_account('IVY@freelance.test ')$$, 'XR001',
  'account_delete_legal_hold: Harbor Lights Productions keeps your records under a legal hold (Pier Nights injury claim). Nothing was deleted. Ask Harbor Lights Productions to release the hold, then delete your account again.',
  'deletion under a legal hold is refused and says what is kept and why');
select pg_temp.as_platform();
select is((select count(*)::int from auth.users where id = pg_temp.id('ivy_user')), 1, 'the refused deletion left the sign-in');
select is((select count(*)::int from app.person_links where person_id = pg_temp.id('ivy')), 1, 'and the profile');
select pg_temp.as_user('xavier');
update app.legal_holds set released_at = now() where id = pg_temp.id('hold');
insert into app.legal_holds (org_id, table_name, matter) values (pg_temp.id('org_b'), 'app.time_entries', 'Wage audit 2026');
select pg_temp.as_user('ivy');
select is(app.account_deletion_preview() -> 'blockers', '[]'::jsonb, 'a hold over records the deletion keeps, such as time entries, does not block it');

-- On shift and sole owner -------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select throws_ok($$select app.delete_my_account('frank@northwind.test')$$, 'XR001',
  'account_delete_on_shift: You are clocked in at Northwind Live. Clock out, then delete your account.', 'a person on shift clocks out first');
select pg_temp.as_user('xavier');
select throws_ok($$select app.delete_my_account('xavier@harborlights.test')$$, 'XR001',
  'account_delete_sole_owner: You are the only owner of Harbor Lights Productions. Make someone else an owner, then delete your account.',
  'the only Owner of an org transfers ownership first');
select pg_temp.as_user('victor');
select is(app.account_deletion_preview() -> 'blockers' -> 0 ->> 'code', 'account_delete_sole_owner', 'and so does the only Account Owner of an external account');

-- An external crew member deletes their account --------------------------------------------------------------------
select pg_temp.as_user('ivy');
select is((select r ->> 'replayed' from app.delete_my_account('ivy@freelance.test') r), 'false', 'the crew member deletes their account');
select pg_temp.as_platform();
select is((select count(*)::int from auth.users where id = pg_temp.id('ivy_user')), 0, 'the sign-in is gone');
select is((select (full_name is null and user_id is null and deleted_at is not null) from app.people where id = pg_temp.id('ivy')), true,
  'the person keeps no name and no sign-in, so records that name them name no one');
select is((select count(*)::int from app.person_links where person_id = pg_temp.id('ivy'))
  + (select count(*)::int from app.person_languages where person_id = pg_temp.id('ivy')), 0, 'their profile data is erased');
select is((select array_agg(engagement_state::text order by id) from app.engagements where person_id = pg_temp.id('ivy')),
  array['Canceled', 'Canceled'], 'their Active and Onboarding engagements are canceled');
select is((select count(*)::int from app.engagement_state_transitions t join app.engagements e on e.id = t.engagement_id
  where e.person_id = pg_temp.id('ivy') and t.to_state = 'Canceled' and t.reason = 'The person deleted their account.'), 2,
  'each cancellation is in the engagement ledger with the reason');
select is((select array_agg(o.name order by o.name) from app.dsar_requests d join app.organizations o on o.id = d.org_id
  where d.subject_person_id = pg_temp.id('ivy') and d.request_type = 'Erasure' and d.dsar_state = 'Completed'),
  array['Harbor Lights Productions', 'Northwind Live'], 'both orgs she worked for hold a Completed erasure request');
select is((select result -> 'engagements_canceled' from private.account_deletions where user_id = pg_temp.id('ivy_user')), '2'::jsonb,
  'the deletion is recorded with what it did');

-- The same session again: idempotent ------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select is((select r ->> 'replayed' from app.delete_my_account('ivy@freelance.test') r), 'true', 'a repeat answers with the stored result');
select pg_temp.as_platform();
select is((select count(*)::int from app.dsar_requests where subject_person_id = pg_temp.id('ivy')), 2, 'and records nothing twice');

-- An internal member deletes their account --------------------------------------------------------------------------
select pg_temp.as_user('dave');
select ok(app.account_deletion_preview() -> 'kept' @> '[{"category": "time_and_pay"}]', 'a member who worked a shift is told their time and pay records are kept');
select is((select r ->> 'memberships_ended' from app.delete_my_account('dave@northwind.test') r), '1', 'the member deletes their account, ending their membership');
select pg_temp.as_platform();
select is((select (valid_to is not null or deleted_at is not null) from app.memberships where id = pg_temp.id('dave@org_a')), true, 'the membership has ended (one that began this instant is withdrawn instead)');
select is((select count(*)::int from app.time_entries where membership_id = pg_temp.id('dave@org_a')), 1, 'their time entry stays for payroll retention');
select is((select count(*)::int from app.memberships where id = pg_temp.id('frank@org_a') and valid_to is null), 1, 'nobody else''s membership changed');
select pg_temp.as_user('dave');
select throws_ok($$select app.account_deletion_preview()$$, '42501', null, 'the deleted session no longer resolves to a person');
select is((select count(*)::int from app.projects where org_id = pg_temp.id('org_a')), 0, 'and reads nothing of the org');

select pg_temp.as_platform();
select is((select count(*)::int from information_schema.role_routine_grants where routine_schema = 'app'
  and routine_name in ('delete_my_account', 'account_deletion_preview') and grantee = 'anon'), 0, 'neither function is granted to anon');

select * from finish();
rollback;
