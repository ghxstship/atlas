-- pgTAP: migration 6155 (RRR-248). One minimum age of 18: a confirmation at 16 is kept and no longer counts. Nobody without
-- an 18 confirmation joins an org or reaches the AI provider, whichever app or API asks. An answer of under 18 leaves
-- nothing of an account with no org, deletes as usual one with org records, erases what XOS itself holds, and records only
-- the surface, the month and the outcome. Compass reads what a sign-in owes, and a declined AI choice binds on the server.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(116);

create function pg_temp.sign_up(p_key text, p_email text, p_meta jsonb) returns void
language plpgsql as $$
declare
  v_user uuid := gen_random_uuid();
begin
  perform pg_temp.as_platform();
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
  values (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', p_email, now(), p_meta, now(), now());
  insert into world values (p_key || '_user', v_user);
  insert into world select p_key, p.id from app.people p where p.user_id = v_user;
end $$;

-- As a provisioning service does: the person is added by someone else, and has answered nothing.
create function pg_temp.provision(p_person text, p_org text) returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  perform private.begin_trusted_operation('membership_write');
  insert into app.memberships (org_id, person_id) values (pg_temp.id(p_org), pg_temp.id(p_person));
  perform private.end_trusted_operation('membership_write');
end $$;

-- Minimum age ------------------------------------------------------------------------------------------------------------
select pg_temp.sign_up('adult', 'adult@age18.test', '{"full_name": "Ada Adult", "age_confirmed": "18", "signup_surface": "Atlas"}');
select pg_temp.sign_up('legacy', 'legacy@age18.test', '{"full_name": "Lee Legacy", "age_confirmed": "16", "signup_surface": "Gateway"}');
select pg_temp.sign_up('fresh', 'fresh@age18.test', '{"full_name": "Fay Fresh"}');
select pg_temp.sign_up('minor', 'minor@age18.test', '{"full_name": "Mo Minor"}');
select pg_temp.sign_up('worker', 'worker@age18.test', '{"full_name": "Wes Worker"}');

select results_eq($$select surface, minimum_age::int from private.age_confirmations where person_id = pg_temp.id('adult')$$,
  $$values ('Atlas'::text, 18)$$, 'a sign-up that answered 18 or older records an 18 confirmation');
select results_eq($$select surface, minimum_age::int from private.age_confirmations where person_id = pg_temp.id('legacy')$$,
  $$values ('Gateway'::text, 16)$$, 'a form loaded before the change is kept as what it said');
select is((select count(*)::int from private.age_confirmations where person_id = pg_temp.id('fresh')), 0, 'no answer records nothing');

select pg_temp.as_user('adult');
select ok(app.minimum_age_confirmed(), 'an 18 confirmation counts');
select pg_temp.as_user('legacy');
select ok(not app.minimum_age_confirmed(), 'a 16 confirmation no longer counts');
select throws_ok($$select app.create_organization('Legacy Org', 'legacy-org-age18')$$, 'XR001', null,
  'and a person holding only one cannot create an org');
select ok(app.confirm_minimum_age('Gateway') is not null, 'answering again records the time');
select ok(app.minimum_age_confirmed(), 'then the person counts');
select pg_temp.as_platform();
select bag_eq($$select minimum_age::int from private.age_confirmations where person_id = pg_temp.id('legacy')$$,
  $$values (16), (18)$$, 'both answers stay as evidence');
select throws_ok($$insert into private.age_confirmations (person_id, user_id, minimum_age, surface)
  values (pg_temp.id('fresh'), pg_temp.id('fresh_user'), 13, 'Atlas')$$, '23514', null, 'no other age can be recorded');

-- Joining needs the answer, however it is reached ------------------------------------------------------------------------
select pg_temp.as_user('fresh');
select throws_like($$select app.create_organization('Fresh Org', 'fresh-org-age18')$$,
  'minimum_age_unconfirmed%', 'someone with no answer cannot create an org');
select pg_temp.claims('fresh');
select throws_like($$insert into app.memberships (org_id, person_id) values (pg_temp.id('org_a'), pg_temp.id('fresh'))$$,
  'minimum_age_unconfirmed%', 'nor add themselves to one, whichever function does it');
select throws_like($$insert into app.account_memberships (org_id, person_id) values (pg_temp.id('org_a'), pg_temp.id('fresh'))$$,
  'minimum_age_unconfirmed%', 'nor to a company account');
select pg_temp.as_platform();
select throws_like($$select pg_temp.join_org('bob', 'org_a', 'fresh', 'field')$$,
  'minimum_age_unconfirmed%', 'nor accept an invitation');
select pg_temp.sign_up('added', 'added@age18.test', '{"full_name": "Ann Added"}');
insert into app.account_memberships (org_id, person_id) values (pg_temp.id('org_a'), pg_temp.id('added'));
insert into world select 'added_membership', m.id from app.account_memberships m where m.person_id = pg_temp.id('added');
select pg_temp.as_user('added');
select throws_like($$select app.accept_account_membership(pg_temp.id('added_membership'))$$,
  'minimum_age_unconfirmed%', 'nor confirm a company account membership someone else added');
select ok(app.confirm_minimum_age('Gateway') is not null, 'once they have answered');
select lives_ok($$select app.accept_account_membership(pg_temp.id('added_membership'))$$, 'they can confirm it');
select pg_temp.as_platform();
select lives_ok($$select pg_temp.provision('worker', 'org_a')$$,
  'a provisioning service can still add them: the person is asked before their first page');
select pg_temp.as_user('worker');
select is((select count(*)::int from app.ai_enabled_features(pg_temp.id('org_a'))), 0,
  'and a member with no answer has no AI features');
select throws_like($$select app.ai_begin_request(pg_temp.id('org_a'), 'assistant', 'test-model')$$,
  'ai_age_unconfirmed%', 'and the server refuses their request before anything is sent');

-- What a sign-in owes ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('fresh');
select is((app.my_legal_standing() ->> 'age_confirmed')::boolean, false, 'a new sign-in owes the age');
select is(app.my_legal_standing() -> 'accepted_documents', '[]'::jsonb, 'and has accepted nothing');
select is((app.my_legal_standing() ->> 'worker_terms_apply')::boolean, true, 'with no membership, the Worker Terms apply');
select ok(app.my_legal_standing() ->> 'ai_choice' is null, 'and no AI choice is recorded');
select app.record_legal_acceptances(null, array['mobile-eula'], array['1.0.0-draft']);
select is(app.my_legal_standing() -> 'accepted_documents', '["mobile-eula"]'::jsonb, 'an acceptance shows at once');
select pg_temp.as_user('dave');
select is((app.my_legal_standing() ->> 'worker_terms_apply')::boolean, false, 'a member with no engagement owes no Worker Terms');
select pg_temp.as_anon();
select throws_ok($$select app.my_legal_standing()$$, '42501', null, 'nobody reads this signed out');

-- Refusals ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select set_config('request.headers', '{"x-forwarded-for": "198.51.100.77"}', true);
select ok(api_public.record_age_refusal('Atlas'), 'an answer before any account is counted');
select ok(not api_public.record_age_refusal('Elsewhere'), 'only the three shells are counted');
select pg_temp.as_platform();
select results_eq($$select surface, outcome from private.age_refusals$$, $$values ('Atlas'::text, 'No Account'::text)$$,
  'and keeps only the surface and the outcome');
select columns_are('private', 'age_refusals', array['id', 'surface', 'minimum_age', 'outcome', 'refused_month'],
  'a refusal has no column that could identify anyone');
select is((select extract(day from refused_month)::int from private.age_refusals limit 1), 1,
  'its time is kept to the month, so it cannot be matched to a deletion');
select is((select substr(id::text, 15, 1) from private.age_refusals limit 1), '4', 'and its id is random, not time-ordered');

-- A sign-in that holds a second factor passes it before this question can close the account, as before any page.
select pg_temp.sign_up('guarded', 'guarded@age18.test', '{"full_name": "Gus Guarded"}');
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values (gen_random_uuid(), pg_temp.id('guarded_user'), 'age18 phone app', 'totp', 'verified', now(), now());
select pg_temp.as_user('guarded');
select throws_ok($$select app.refuse_minimum_age('Gateway')$$, 'XR001', null,
  'a password alone cannot close an account that holds a second factor');
select pg_temp.as_platform();
select is((select count(*)::int from app.people where id = pg_temp.id('guarded') and deleted_at is null), 1, 'and nothing was changed');
select pg_temp.as_user_stepped_up('guarded');
select is(app.refuse_minimum_age('Gateway') ->> 'outcome', 'Account Removed', 'once the second factor is passed, it closes');

select pg_temp.as_user('minor');
select throws_ok($$select app.refuse_minimum_age('Elsewhere')$$, 'XR001', null, 'the surface is one of the three shells');
select is(app.refuse_minimum_age('Compass') ->> 'outcome', 'Account Removed', 'an account with no org behind it is removed');
select pg_temp.as_platform();
select is((select count(*)::int from auth.users where id = pg_temp.id('minor_user')), 0, 'its sign-in is gone');
select is((select count(*)::int from app.people where id = pg_temp.id('minor')), 0, 'and so is the person');
select is((select count(*)::int from private.age_refusals where outcome = 'Account Removed' and surface = 'Compass'), 1,
  'one anonymous row records it');

-- An account that accepted documents, answered 16 and made a choice before answering: nothing of it stays.
select pg_temp.sign_up('wrote', 'wrote@age18.test', '{"full_name": "Wren Wrote", "age_confirmed": "16", "signup_surface": "Gateway"}');
select pg_temp.as_user('wrote');
select app.record_legal_acceptances(null, array['worker-terms'], array['1.0.0-draft']);
select app.record_ai_choice('Compass', '2026-11-06', 'Declined');
select is(app.refuse_minimum_age('Gateway') ->> 'outcome', 'Account Removed', 'an account that only accepted documents is removed too');
select pg_temp.as_platform();
select is((select count(*)::int from auth.users where id = pg_temp.id('wrote_user')), 0, 'its sign-in is gone');
select is((select count(*)::int from app.people where id = pg_temp.id('wrote')), 0, 'and the person');
select is((select count(*)::int from app.legal_acceptances where user_id = pg_temp.id('wrote_user')), 0,
  'and its acceptances, with their sign-in id and address');
select is((select count(*)::int from private.age_confirmations where user_id = pg_temp.id('wrote_user')), 0,
  'and its answer at 16, with its sign-in id and address');
select is((select count(*)::int from private.account_deletions where user_id = pg_temp.id('wrote_user')), 0,
  'and no deletion record names it');

-- Profile data the person wrote is cleared the usual way, and still no deletion record stays.
select pg_temp.sign_up('profiled', 'profiled@age18.test', '{"full_name": "Pat Profiled"}');
insert into app.person_links (person_id, label, url) values (pg_temp.id('profiled'), 'Website', 'https://example.com/pat');
select pg_temp.as_user('profiled');
select is(app.refuse_minimum_age('Atlas') ->> 'outcome', 'Account Removed', 'an account with profile data is removed too');
select pg_temp.as_platform();
select is((select count(*)::int from app.people where id = pg_temp.id('profiled')), 0, 'the person is gone');
select is((select count(*)::int from private.account_deletions where user_id = pg_temp.id('profiled_user')), 0,
  'and no deletion record names it');

-- A sign-in with no email address can close too.
select pg_temp.sign_up('noemail', 'noemail@age18.test', '{"full_name": "Nia Noemail"}');
update auth.users set email = null where id = pg_temp.id('noemail_user');
select pg_temp.as_user('noemail');
select is(app.refuse_minimum_age('Compass') ->> 'outcome', 'Account Removed', 'a sign-in with no email address closes');
select pg_temp.as_platform();
select is((select count(*)::int from auth.users where id = pg_temp.id('noemail_user')), 0, 'and is gone');

-- With org records its erasure entry needs an address, so it holds a stand-in and says so.
select pg_temp.sign_up('noemailorg', 'noemailorg@age18.test', '{"full_name": "Noa Noemail"}');
select pg_temp.provision('noemailorg', 'org_a');
update auth.users set email = null where id = pg_temp.id('noemailorg_user');
select pg_temp.as_user('noemailorg');
select is(app.refuse_minimum_age('Gateway') ->> 'outcome', 'Account Closed', 'a sign-in with no email address and org records closes');
select pg_temp.as_platform();
select ok((select subject_email like 'closed-%@example.invalid' and details like '%stand-in%' from app.dsar_requests
  where subject_person_id = pg_temp.id('noemailorg')), 'and the org''s erasure entry says its address is a stand-in');

-- What a signed-in person leaves on a common path, with no org: none of it keeps the account from going, and none stays.
select pg_temp.sign_up('browsed', 'browsed@age18.test', '{"full_name": "Bea Browsed"}');
select pg_temp.as_user('browsed');
select api_public.record_cookie_consent('visitor-browsed-age18-0001', null, true, false, false, 'cookie-policy 1.0.0-draft', true);
select app.send_feedback('Atlas', 'The page is hard to find.', '/home', null, null, null, null);
select app.open_account_support_request('Question', 'A question', 'What can I do here?');
select pg_temp.as_anon();
select api_public.record_cookie_consent('visitor-anonymous-age18-01', null, true, false, false, 'cookie-policy 1.0.0-draft', true);
select pg_temp.as_platform();
insert into app.shortcut_bindings (person_id, shell, shortcut_id, keys) values (pg_temp.id('browsed'), 'Atlas', 'go.home', 'g h');
insert into app.person_emergency_contacts (person_id, full_name, relationship, phone_e164) values (pg_temp.id('browsed'), 'Bo Browsed', 'Parent', '+13055550100');
insert into app.blocks (person_id, blocked_person_id, blocked_urn) values (pg_temp.id('dave'), pg_temp.id('browsed'), 'urn:xpms:person:' || pg_temp.id('browsed'));
select is((select count(*)::int from app.cookie_consent_events where person_id = pg_temp.id('browsed')), 1, 'a signed-in cookie choice names the person');
select is((select count(*)::int from app.privacy_signals where person_id = pg_temp.id('browsed')), 1, 'and so does a browser''s opt-out signal');
select pg_temp.as_user('browsed');
select is(app.refuse_minimum_age('Atlas') ->> 'outcome', 'Account Removed', 'an account that used the site with no org is still removed, not left nameless');
select pg_temp.as_platform();
select is((select count(*)::int from app.people where id = pg_temp.id('browsed')), 0, 'the person is gone');
select is((select count(*)::int from app.cookie_consent_events where person_id = pg_temp.id('browsed') or created_by = pg_temp.id('browsed')), 0, 'and their cookie choices');
select is((select count(*)::int from app.privacy_signals where person_id = pg_temp.id('browsed') or created_by = pg_temp.id('browsed')), 0, 'and their opt-out signals');
select is((select count(*)::int from app.feedback_submissions where person_id = pg_temp.id('browsed')), 0, 'and their feedback');
select is((select count(*)::int from private.account_support_requests where person_id = pg_temp.id('browsed')), 0, 'and their support requests');
select is((select count(*)::int from app.shortcut_bindings where person_id = pg_temp.id('browsed')), 0, 'and their settings');
select is((select count(*)::int from app.person_emergency_contacts where person_id = pg_temp.id('browsed')), 0, 'and their work details');
select is((select count(*)::int from app.blocks where blocked_person_id = pg_temp.id('browsed')), 0, 'and blocks that name them');
select is((select count(*)::int from app.cookie_consent_events where person_id is null), 1, 'a visitor who never signed in is untouched');

-- A legal hold, an open shift or being the only owner stops deletion: the answer says why, and the person is listed.
select pg_temp.sign_up('owner', 'owner@age18.test', '{"full_name": "Olive Owner", "age_confirmed": "18", "signup_surface": "Atlas"}');
select pg_temp.as_user('owner');
select app.create_organization('Olive Owns', 'olive-owns-age18');
select pg_temp.as_platform();
delete from private.age_confirmations where person_id = pg_temp.id('owner');
select pg_temp.as_user('owner');
select is((app.my_legal_standing() ->> 'closing_blocked')::boolean, true, 'Compass can read that this account would not close');
select is(app.refuse_minimum_age('Atlas') ->> 'outcome', 'Account Held', 'the only owner of an org cannot be deleted by this question');
select is(app.refuse_minimum_age('Gateway') ->> 'reason', 'account_delete_sole_owner', 'and the answer says why');
select pg_temp.as_platform();
select is((select count(*)::int from private.age_refusals where outcome = 'Account Held'), 1, 'answering again does not count the person twice');
select is((select count(*)::int from auth.users where id = pg_temp.id('owner_user')), 1, 'the sign-in stays');
select results_eq($$select surface, reason from private.age_refusal_holds where person_id = pg_temp.id('owner')$$,
  $$values ('Gateway'::text, 'account_delete_sole_owner'::text)$$, 'and one row tells the platform team which account to finish closing');
select pg_temp.as_user('owner');
select ok(not app.minimum_age_confirmed(), 'the person is still unconfirmed, so every sign-in asks again');
select is((select count(*)::int from app.ai_enabled_features(pg_temp.id('org_a'))), 0, 'and has no AI features');
select ok(app.confirm_minimum_age('Atlas') is not null, 'if they then answer 18 or older it is recorded');
select pg_temp.as_platform();
select is((select count(*)::int from private.age_refusal_holds where person_id = pg_temp.id('owner')), 1,
  'but the hold stays, so the conflict stays visible to the platform team');
delete from private.age_confirmations where person_id = pg_temp.id('owner');
-- Someone else takes on the org, so nothing blocks closing any more.
insert into world select 'olive', o.id from app.organizations o where o.slug = 'olive-owns-age18';
select pg_temp.join_org('owner', 'olive', 'adult', 'owner');
select pg_temp.as_user('owner');
select is((app.my_legal_standing() ->> 'closing_blocked')::boolean, false, 'once nothing blocks it');
select is(app.refuse_minimum_age('Atlas') ->> 'outcome', 'Account Closed', 'answering again closes the account');
select pg_temp.as_platform();
select is((select count(*)::int from private.age_refusal_holds where person_id = pg_temp.id('owner')), 0, 'and the hold goes');
select is((select count(*)::int from private.age_refusals where outcome = 'Account Closed' and surface = 'Atlas'), 0,
  'and closing later adds no second row for the same person');

-- A person who deletes their account in Settings while held comes off the list.
select pg_temp.sign_up('heldout', 'heldout@age18.test', '{"full_name": "Hal Heldout"}');
insert into private.age_refusal_holds (person_id, surface, reason) values (pg_temp.id('heldout'), 'Atlas', 'account_delete_on_shift');
update app.people set deleted_at = now() where id = pg_temp.id('heldout');
select is((select count(*)::int from private.age_refusal_holds where person_id = pg_temp.id('heldout')), 0,
  'a deleted person leaves the list');

select pg_temp.as_user('adult');
select throws_ok($$select app.refuse_minimum_age('Atlas')$$, 'XR001', null, 'an account that confirmed 18 cannot be closed by this question');

-- A person with org records is deleted as app.delete_my_account does, so the org keeps what the law requires. What XOS
-- itself holds about them goes.
select pg_temp.as_user('worker');
select app.record_legal_acceptances(null, array['mobile-eula'], array['1.0.0-draft']);
select is(app.refuse_minimum_age('Compass') ->> 'outcome', 'Account Closed', 'an account with org records is closed');
select pg_temp.as_platform();
select is((select count(*)::int from auth.users where id = pg_temp.id('worker_user')), 0, 'its sign-in is gone');
select ok((select full_name is null and deleted_at is not null from app.people where id = pg_temp.id('worker')),
  'the person keeps no name');
select is((select count(*)::int from app.legal_acceptances where person_id = pg_temp.id('worker') and org_id is null), 0,
  'its personal acceptances are gone');
select is((select count(*)::int from app.dsar_requests where subject_person_id = pg_temp.id('worker') and org_id = pg_temp.id('org_a')), 1,
  'and the org has its erasure entry');
select is((select count(*)::int from private.account_deletions where person_id = pg_temp.id('worker')), 1,
  'and the deletion record holds the ids, as for anyone');
select is((select count(*)::int from private.age_refusals where outcome = 'Account Closed' and surface = 'Compass'), 1, 'one anonymous row records it');

-- The AI choice ----------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into app.ai_settings (org_id, assistant_enabled) values (pg_temp.id('org_a'), true);
select pg_temp.as_user('dave');
select ok((select count(*)::int from app.ai_enabled_features(pg_temp.id('org_a'))) > 0, 'with no recorded choice the org''s setting holds');
select throws_ok($$select app.record_ai_choice('Compass', '2026-11-06', 'Maybe')$$, 'XR001', null, 'the choice is Allowed or Declined');
select ok(app.record_ai_choice('Compass', '2026-11-06', 'Declined') is not null, 'a decline is recorded');
select is(app.my_legal_standing() ->> 'ai_choice', 'Declined', 'and stands');
select is((select count(*)::int from app.ai_enabled_features(pg_temp.id('org_a'))), 0, 'a person who declined has no AI features');
select throws_ok($$select app.ai_begin_request(pg_temp.id('org_a'), 'assistant', 'test-model')$$, 'XR001', null,
  'and the server refuses their request before anything is sent');
select ok(app.record_ai_choice('Compass', '2026-11-06', 'Allowed') is not null, 'they can change their mind');
select is(app.my_legal_standing() ->> 'ai_disclosure_version', '2026-11-06', 'the words they saw are recorded');
select ok((select count(*)::int from app.ai_enabled_features(pg_temp.id('org_a'))) > 0, 'and the latest choice stands');
select pg_temp.as_platform();
select is((select count(*)::int from private.ai_disclosure_choices where person_id = pg_temp.id('dave')), 2, 'each choice stays in the log');
select pg_temp.as_user('dave');
select ok(not app.ai_declined_by_me(), 'a person whose latest choice is Allowed has not declined');

-- A surface that cannot change the choice reads it, so it can say why AI is off rather than blame an org setting.
select pg_temp.sign_up('chooser', 'chooser@age18.test', '{"full_name": "Cy Chooser", "age_confirmed": "18", "signup_surface": "Atlas"}');
select pg_temp.as_user('chooser');
select ok(not app.ai_declined_by_me(), 'no recorded choice is not a decline');
select app.record_ai_choice('Compass', '2026-11-06', 'Declined');
select ok(app.ai_declined_by_me(), 'a decline reads as one');
select pg_temp.as_anon();
select throws_ok($$select app.ai_declined_by_me()$$, '42501', null, 'nobody reads it signed out');
-- Deleting the person (app.delete_my_account soft-deletes the row an org still needs) takes their choices and addresses.
select pg_temp.as_platform();
update app.people set deleted_at = now() where id = pg_temp.id('chooser');
select is((select count(*)::int from private.ai_disclosure_choices where person_id = pg_temp.id('chooser')), 0,
  'a deleted person''s AI choices go, with the addresses they came from');

-- An API key acts as its service account, a person row with no age to give and no screen to answer on. It keeps Aurora,
-- and the frozen API keeps what it did before this rule.
select pg_temp.as_user('bob');
insert into world select 'bot_account', app.create_service_account(pg_temp.id('org_a'), 'Aurora Bot', pg_temp.system_role('member'));
select pg_temp.as_platform();
insert into world select 'bot_user', s.user_id from app.service_accounts s where s.id = pg_temp.id('bot_account');
insert into world select 'bot', s.person_id from app.service_accounts s where s.id = pg_temp.id('bot_account');
select is((select count(*)::int from private.age_confirmations where person_id = pg_temp.id('bot')), 0, 'a service account has no age answer');
select pg_temp.as_user('bot');
select ok((select count(*)::int from app.ai_enabled_features(pg_temp.id('org_a'))) > 0, 'but an API key still sees the org''s AI features');
select lives_ok($$select app.ai_begin_request(pg_temp.id('org_a'), 'assistant', 'test-model')$$, 'and its Aurora request is not refused for age');
select ok(not app.ai_declined_by_me(), 'and it has declined nothing');
select throws_ok($$select app.refuse_minimum_age('Atlas')$$, 'XR001', null, 'and nothing can close it by this question');
select pg_temp.as_platform();
update app.service_accounts set deleted_at = now() where id = pg_temp.id('bot_account');
select ok(not private.minimum_age_met(pg_temp.id('bot')), 'a retired service account passes nothing');

-- Support screenshots: only the owner removes one, as a closure after an answer of under 18 has to.
select pg_temp.as_user('dave');
insert into storage.objects (bucket_id, name) values ('support-screenshots', pg_temp.id('dave')::text || '/age18.png');
set local storage.allow_delete_query = 'true';
select pg_temp.as_user('erin');
delete from storage.objects where bucket_id = 'support-screenshots';
select pg_temp.as_platform();
select is((select count(*)::int from storage.objects where bucket_id = 'support-screenshots' and name like '%/age18.png'), 1, 'someone else cannot remove a support screenshot');
select pg_temp.as_user('dave');
delete from storage.objects where bucket_id = 'support-screenshots' and name like '%/age18.png';
select pg_temp.as_platform();
select is((select count(*)::int from storage.objects where bucket_id = 'support-screenshots' and name like '%/age18.png'), 0, 'its owner can');

-- Profile media: a public bucket read by URL, whose owner the Storage API could not list for, so nothing was ever removed.
select pg_temp.as_platform();
insert into storage.objects (bucket_id, name) values ('profile-media', pg_temp.id('dave')::text || '/certificates/age18.png');
select pg_temp.as_user('dave');
select is((select count(*)::int from storage.objects where bucket_id = 'profile-media' and name like '%/age18.png'), 1, 'a person sees their own profile media, so it can be listed and removed');
select pg_temp.as_user('erin');
select is((select count(*)::int from storage.objects where bucket_id = 'profile-media' and name like '%/age18.png'), 0, 'nobody else lists it');
delete from storage.objects where bucket_id = 'profile-media';
select pg_temp.as_platform();
select is((select count(*)::int from storage.objects where bucket_id = 'profile-media' and name like '%/age18.png'), 1, 'or removes it');
select pg_temp.as_user('dave');
delete from storage.objects where bucket_id = 'profile-media' and name like '%/age18.png';
select pg_temp.as_platform();
select is((select count(*)::int from storage.objects where bucket_id = 'profile-media' and name like '%/age18.png'), 0, 'its owner can, nested folders included');

select * from finish();
rollback;
