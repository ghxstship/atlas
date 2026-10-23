-- pgTAP: migration 1560, recovery codes (A99, RRR-144; A54-001, ADR 0055; Section 7.5 invariant 8,
-- inv_08_token_rpcs_hashed_secrets). Ten single-use codes made server side, shown once and stored only as bcrypt hashes;
-- a new set replaces the old; making them needs a second factor and step-up. A code raises only the caller's own live
-- session to aal2 (the amr claim and the session row Supabase Auth itself writes), is spent at once and never matches
-- again; wrong codes are counted and five in 15 minutes lock the person out; use is written to the account security trail
-- and notifies the person. API keys, other people's sessions and anon are refused.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(44);

create temporary table codes (code text not null);
grant select, insert, delete on codes to public;

-- A real Supabase Auth session row for a user, recorded in world under p_key.
create function pg_temp.new_session(p_user text, p_key text) returns uuid
language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  perform set_config('role', 'postgres', true);
  insert into auth.sessions (id, user_id, created_at, updated_at, aal)
  values (v_id, pg_temp.id(p_user || '_user'), now() - interval '1 hour', now() - interval '1 hour', 'aal1');
  insert into world values (p_key, v_id);
  return v_id;
end $$;

-- Claims of a session: its aal and, optionally, a second factor p_second_ago (NULL for none) or an API key.
create function pg_temp.as_session(p_user text, p_session text, p_aal text, p_second_ago interval, p_key boolean default false)
returns void
language plpgsql as $$
declare
  v_amr jsonb := jsonb_build_array(jsonb_build_object('method', case when p_key then 'xos_api_key' else 'password' end,
    'timestamp', extract(epoch from now() - interval '1 hour')::bigint));
begin
  if p_second_ago is not null then
    v_amr := jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now() - p_second_ago)::bigint)) || v_amr;
  end if;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', pg_temp.id(p_user || '_user'), 'role', 'authenticated', 'aal', p_aal,
      'session_id', pg_temp.id(p_session), 'amr', v_amr,
      'scopes', case when p_key then '["projects"]'::jsonb end)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.add_factor(p_user text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
  values (gen_random_uuid(), pg_temp.id(p_user || '_user'), 'Phone ' || p_user, 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP');
end $$;

select pg_temp.new_session('alice', 's_alice');
select pg_temp.new_session('alice', 's_alice_2');
select pg_temp.new_session('bob', 's_bob');

-- Schema ------------------------------------------------------------------------------------------------------------------

select has_table('private', 'recovery_codes', 'recovery codes live in the private schema');
select ok((select relrowsecurity from pg_class where oid = 'private.recovery_codes'::regclass), 'with row level security');
select ok((select relrowsecurity from pg_class where oid = 'private.account_security_events'::regclass),
  'the account security trail has row level security too');
select ok(not has_table_privilege('authenticated', 'private.recovery_codes', 'SELECT')
  and not has_table_privilege('anon', 'private.recovery_codes', 'SELECT'),
  'inv_08_token_rpcs_hashed_secrets: no signed-in role can select a code hash');
select is((select count(*)::int from pg_attribute a where a.attrelid = 'private.recovery_codes'::regclass and a.attnum > 0
  and not a.attisdropped and col_description(a.attrelid, a.attnum) is null), 0, 'every column is commented');
select ok(obj_description('app.redeem_recovery_code(text)'::regprocedure, 'pg_proc') is not null, 'the RPCs are commented');

-- Making codes ------------------------------------------------------------------------------------------------------------

select pg_temp.as_session('alice', 's_alice', 'aal1', null);
select throws_ok($$select * from app.generate_recovery_codes()$$, 'XR001',
  'step_up_required: Confirm it is you with your second factor to make recovery codes.',
  'making codes needs step-up');

select pg_temp.as_session('alice', 's_alice', 'aal2', interval '1 minute');
select throws_ok($$select * from app.generate_recovery_codes()$$, 'XR001',
  'recovery_codes_need_factor: Set up an authenticator app or a security key first; recovery codes stand in for it.',
  'codes stand in for a second factor the person holds');

select pg_temp.add_factor('alice');
select pg_temp.as_session('alice', 's_alice', 'aal2', interval '1 minute');
insert into codes select code from app.generate_recovery_codes();
select is((select count(distinct code)::int from codes), 10, 'ten distinct codes come back once');
select ok((select bool_and(code ~ '^[0-9a-hjkmnp-tv-z]{5}-[0-9a-hjkmnp-tv-z]{5}$') from codes),
  'each is ten characters from the unambiguous alphabet, shown as two groups of five');
select is((select total from app.my_recovery_code_status()), 10, 'the status counts ten');
select is((select remaining from app.my_recovery_code_status()), 10, 'all unused');
select is((select usable from app.my_recovery_code_status()), true, 'and usable');

select pg_temp.as_platform();
select ok((select bool_and(r.code_hash ~ '^\$2[abxy]\$08\$') from private.recovery_codes r where r.user_id = pg_temp.id('alice_user')),
  'only bcrypt hashes are stored');
select is((select count(*)::int from private.recovery_codes r join codes c on r.code_hash = c.code or r.code_hash = replace(c.code, '-', '')), 0,
  'never the codes themselves');

-- A new set replaces the old one.
create temporary table old_codes as select code from codes;
grant select on old_codes to public;
delete from codes;
select pg_temp.as_session('alice', 's_alice', 'aal2', interval '2 minutes');
insert into codes select code from app.generate_recovery_codes();
select is((select total from app.my_recovery_code_status()), 10, 'regenerating keeps one set of ten');
select is((select count(*)::int from codes c join old_codes o using (code)), 0, 'with new codes');

-- Spending a code ---------------------------------------------------------------------------------------------------------

select pg_temp.as_session('alice', 's_alice', 'aal1', null);
select results_eq($$select outcome from app.redeem_recovery_code((select code from old_codes limit 1))$$,
  array['code_invalid'], 'a code of the replaced set no longer matches');
select results_eq($$select outcome, remaining from app.redeem_recovery_code(upper(replace((select min(code) from codes), '-', ' ')))$$,
  $$values ('ok'::text, 9)$$, 'a current code passes, typed in capitals with a space, and nine are left');

select pg_temp.as_platform();
select is((select authentication_method from auth.mfa_amr_claims where session_id = pg_temp.id('s_alice')),
  'mfa/recovery_code', 'the session records the recovery code as its second factor');
select is((select aal::text from auth.sessions where id = pg_temp.id('s_alice')), 'aal2', 'and is aal2 for its next token');
select is((select aal::text from auth.sessions where id = pg_temp.id('s_alice_2')), 'aal1', 'another session of hers is untouched');
select is((select count(*)::int from private.recovery_codes where user_id = pg_temp.id('alice_user') and used_at is not null
  and used_session_id = pg_temp.id('s_alice')), 1, 'the code is spent, against that session');
select is((select count(*)::int from app.notifications n where n.recipient_person_id = pg_temp.id('alice')
  and n.kind = 'account.recovery_code_used' and n.message_args ->> 'remaining' = '9'), 1, 'alice is told, with the codes left');
select is((select count(*)::int from private.account_security_events where user_id = pg_temp.id('alice_user')
  and kind = 'recovery_code_used' and session_id = pg_temp.id('s_alice') and detail ->> 'remaining' = '9'), 1,
  'the use is on her account security trail, with the session and the codes left');

select pg_temp.as_session('alice', 's_alice_2', 'aal1', null);
select results_eq($$select outcome from app.redeem_recovery_code((select min(code) from codes))$$,
  array['code_invalid'], 'a spent code is refused, even on another session');
select results_eq($$select outcome from app.redeem_recovery_code('not a code')$$, array['code_invalid'], 'so is anything that is not a code');

-- The step-up check counts a recovery code as a second factor.
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.id('alice_user'), 'role', 'authenticated', 'aal', 'aal2',
  'session_id', pg_temp.id('s_alice'), 'amr', jsonb_build_array(
    jsonb_build_object('method', 'mfa/recovery_code', 'timestamp', extract(epoch from now())::bigint),
    jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now() - interval '1 hour')::bigint)))::text, true);
select is((select recent from app.my_second_factor_status()), true, 'a recovery code just used counts as a recent second factor');

-- Wrong codes lock the person out ------------------------------------------------------------------------------------------

select pg_temp.as_session('alice', 's_alice_2', 'aal1', null);
-- Three refused so far (old set, spent code, not a code); two more reach the limit of five.
select results_eq($$select outcome from app.redeem_recovery_code('aaaaa-aaaaa')$$, array['code_invalid'], 'a fourth wrong code is refused');
select results_eq($$select outcome from app.redeem_recovery_code('bbbbb-bbbbb')$$, array['code_invalid'], 'a fifth too');
select results_eq($$select outcome from app.redeem_recovery_code((select max(code) from codes))$$, array['rate_limited'],
  'then even a right code is refused for 15 minutes');
select pg_temp.as_platform();
select is((select count(*)::int from private.account_security_events where user_id = pg_temp.id('alice_user') and kind = 'recovery_code_refused'), 5,
  'each refusal is on the trail');
select is((select count(*)::int from private.recovery_codes where user_id = pg_temp.id('alice_user') and used_at is null), 9,
  'and no code was spent by the refused attempts');

-- Who may spend codes ------------------------------------------------------------------------------------------------------

select pg_temp.as_session('alice', 's_bob', 'aal1', null);
select throws_ok($$select * from app.redeem_recovery_code('aaaaa-aaaaa')$$, '42501', 'session not found',
  'a code never raises a session that is not the caller''s');
select pg_temp.as_session('alice', 's_alice', 'aal1', null, true);
select throws_ok($$select * from app.redeem_recovery_code('aaaaa-aaaaa')$$, 'XR001',
  'step_up_session_only: A recovery code needs a signed-in session, never an API key or an app.', 'nor an API key');
select throws_ok($$select * from app.generate_recovery_codes()$$, 'XR001', null, 'an API key cannot make codes');
select pg_temp.as_session('bob', 's_bob', 'aal1', null);
select is((select total from app.my_recovery_code_status()), 0, 'bob sees no codes of alice''s');
select results_eq($$select outcome from app.redeem_recovery_code((select max(code) from codes))$$, array['no_codes'],
  'and her code does nothing for him: he holds no second factor');
select pg_temp.as_anon();
select throws_ok($$select * from app.redeem_recovery_code('aaaaa-aaaaa')$$, '42501', null, 'anon cannot try a code');

-- Without a factor the codes go ------------------------------------------------------------------------------------------

select pg_temp.as_platform();
delete from auth.mfa_factors where user_id = pg_temp.id('alice_user');
select pg_temp.as_session('alice', 's_alice', 'aal2', interval '1 minute');
select is((select usable from app.my_recovery_code_status()), false, 'with no second factor left the codes are not usable');
select is(app.prune_recovery_codes(), true, 'and pruning deletes them');
select is((select total from app.my_recovery_code_status()), 0, 'none are left');

-- The trail ------------------------------------------------------------------------------------------------------------------

select is((select count(*)::int from app.my_security_events()), 9, 'alice reads her own trail: two sets, one use, five refusals, the clearing');
select pg_temp.as_platform();
select throws_ok($$update private.account_security_events set kind = 'recovery_code_used'$$, 'XR001', null,
  'the trail is append-only');

select * from finish();
rollback;
