-- pgTAP: migration 6155 (RRR-248). One minimum age of 18: a confirmation at 16 is kept and no longer counts. An answer of
-- under 18 leaves no account behind an account with no org, deletes as usual one with org records, and records only the
-- surface, the time and the outcome. Compass reads what a sign-in owes, and a declined AI choice binds on the server.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(48);

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
select ok(not app.minimum_age_outdated(), 'and is not outdated');
select pg_temp.as_user('legacy');
select ok(not app.minimum_age_confirmed(), 'a 16 confirmation no longer counts');
select ok(app.minimum_age_outdated(), 'and is asked again at the next sign-in');
select ok(app.confirm_minimum_age('Gateway') is not null, 'answering again records the time');
select ok(app.minimum_age_confirmed(), 'then the person counts');
select ok(not app.minimum_age_outdated(), 'and is no longer outdated');
select pg_temp.as_platform();
select bag_eq($$select minimum_age::int from private.age_confirmations where person_id = pg_temp.id('legacy')$$,
  $$values (16), (18)$$, 'both answers stay as evidence');
select throws_ok($$insert into private.age_confirmations (person_id, user_id, minimum_age, surface)
  values (pg_temp.id('fresh'), pg_temp.id('fresh_user'), 13, 'Atlas')$$, '23514', null, 'no other age can be recorded');

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
select columns_are('private', 'age_refusals', array['id', 'surface', 'minimum_age', 'outcome', 'refused_at'],
  'a refusal has no column that could identify anyone');

select pg_temp.as_user('minor');
select throws_ok($$select app.refuse_minimum_age('Elsewhere')$$, 'XR001', null, 'the surface is one of the three shells');
select is(app.refuse_minimum_age('Compass') ->> 'outcome', 'Account Removed', 'an account with no org behind it is removed');
select pg_temp.as_platform();
select is((select count(*)::int from auth.users where id = pg_temp.id('minor_user')), 0, 'its sign-in is gone');
select is((select count(*)::int from app.people where id = pg_temp.id('minor')), 0, 'and so is the person');
select is((select count(*)::int from private.age_refusals where outcome = 'Account Removed' and surface = 'Compass'), 1,
  'one anonymous row records it');

-- An account that wrote something before answering: the row stays with no name, and the sign-in goes.
select pg_temp.sign_up('wrote', 'wrote@age18.test', '{"full_name": "Wren Wrote"}');
select pg_temp.as_user('wrote');
select app.record_legal_acceptances(null, array['worker-terms'], array['1.0.0-draft']);
select is(app.refuse_minimum_age('Gateway') ->> 'outcome', 'Account Closed', 'an account that wrote something closes as a deletion does');
select pg_temp.as_platform();
select is((select count(*)::int from auth.users where id = pg_temp.id('wrote_user')), 0, 'its sign-in is gone');
select ok((select full_name is null from app.people where id = pg_temp.id('wrote')), 'and it keeps no name');

-- A legal hold, an open shift or being the only owner stops deletion: the answer says why, and the person stays uncounted as 18.
select pg_temp.sign_up('owner', 'owner@age18.test', '{"full_name": "Olive Owner"}');
select pg_temp.as_user('owner');
select app.create_organization('Olive Owns', 'olive-owns-age18');
select is(app.refuse_minimum_age('Atlas') ->> 'outcome', 'Account Held', 'the only owner of an org cannot be deleted by this question');
select is(app.refuse_minimum_age('Atlas') ->> 'reason', 'account_delete_sole_owner', 'and the answer says why');
select pg_temp.as_platform();
select is((select count(*)::int from auth.users where id = pg_temp.id('owner_user')), 1, 'the sign-in stays');

select pg_temp.as_user('adult');
select throws_ok($$select app.refuse_minimum_age('Atlas')$$, 'XR001', null, 'an account that confirmed 18 cannot be closed by this question');

-- A person with org records is deleted as app.delete_my_account does, so the org keeps what the law requires.
select pg_temp.join_org('bob', 'org_a', 'worker', 'field');
select pg_temp.as_user('worker');
select is(app.refuse_minimum_age('Compass') ->> 'outcome', 'Account Closed', 'an account with org records is closed');
select pg_temp.as_platform();
select is((select count(*)::int from auth.users where id = pg_temp.id('worker_user')), 0, 'its sign-in is gone');
select ok((select full_name is null and deleted_at is not null from app.people where id = pg_temp.id('worker')),
  'the person keeps no name');

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

select * from finish();
rollback;
