-- pgTAP: the test identities themselves (ADR 0169, work package 1; RRR-243). Every suite impersonates people through
-- 0199_session_identities.psql and 0200_identity_world.psql, so this file holds those helpers to what they promise: a
-- person a suite signs in has a live auth.sessions row, the amr rows of the factors passed, and the claims of the access
-- token Supabase Auth issues for that session. pg_temp.as_user is a single-factor session, pg_temp.as_user_stepped_up
-- a second-factor one, and pg_temp.as_session lets a suite choose the session's age, last activity, assurance level and
-- whether the row exists at all. The claims and rows were compared with what a local Supabase Auth v2.197.0 issued;
-- 0199_session_identities.psql lists what is modeled and what is not.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(103);

-- What a helper left on the transaction, kept under a key so it can be read back as the platform.
create temporary table seen (key text primary key, claims jsonb, role text not null, uid uuid);
grant select, insert on seen to public;
create function pg_temp.keep(p_key text) returns void
language sql as $$
  insert into seen
  values (p_key, nullif(current_setting('request.jwt.claims', true), '')::jsonb, current_setting('role'), auth.uid())
$$;
create function pg_temp.claim(p_key text, p_claim text) returns text
language sql stable as $$ select s.claims ->> p_claim from seen s where s.key = p_key $$;
-- A time as a token carries it: amr timestamps are whole seconds, and the session rows are built from them.
create function pg_temp.whole(p_at timestamptz) returns timestamptz
language sql immutable as $$ select to_timestamp(extract(epoch from p_at)::bigint) $$;
create function pg_temp.session_of(p_key text) returns uuid
language sql stable as $$ select (s.claims ->> 'session_id')::uuid from seen s where s.key = p_key $$;

-- as_user: a single-factor session ------------------------------------------------------------------------------------------

select pg_temp.as_user('alice');
select pg_temp.keep('alice');
select pg_temp.as_user('bob');
select pg_temp.keep('bob');
select pg_temp.as_user('alice');
select pg_temp.keep('alice again');
select pg_temp.as_platform();

select is((select role from seen where key = 'alice'), 'authenticated', 'as_user acts under the authenticated role');
select is((select uid from seen where key = 'alice'), pg_temp.id('alice_user'), 'as the person named');
select is((select array_agg(k order by k) from seen s, jsonb_object_keys(s.claims) k where s.key = 'alice'),
  array['aal', 'amr', 'app_metadata', 'aud', 'email', 'exp', 'iat', 'is_anonymous', 'iss', 'phone', 'role', 'session_id', 'sub',
        'user_metadata'],
  'the token carries the claims a Supabase Auth access token carries, and no other');
select is(pg_temp.claim('alice', 'sub'), pg_temp.id('alice_user')::text, 'sub is the user');
select is(pg_temp.claim('alice', 'role'), 'authenticated', 'role is authenticated');
select is(pg_temp.claim('alice', 'aud'), 'authenticated', 'aud is authenticated');
select is(pg_temp.claim('alice', 'iss'), 'http://127.0.0.1:55421/auth/v1', 'iss is the local Auth URL');
select is(pg_temp.claim('alice', 'email'), 'alice@northwind.test', 'email is the account''s');
select is(pg_temp.claim('alice', 'is_anonymous'), 'false', 'the person is not anonymous');
select is((select claims -> 'user_metadata' ->> 'full_name' from seen where key = 'alice'), 'Alice Moreno',
  'user_metadata is the account''s');
select is((select claims -> 'user_metadata' from seen where key = 'alice'),
  jsonb_build_object('full_name', 'Alice Moreno', 'age_confirmed', '18', 'signup_surface', 'Atlas', 'sub', pg_temp.id('alice_user'),
    'email', 'alice@northwind.test', 'email_verified', true, 'phone_verified', false),
  'with what Supabase Auth adds to the sign-up form''s answers');
select is((select claims -> 'app_metadata' from seen where key = 'alice'), '{"provider": "email", "providers": ["email"]}'::jsonb,
  'app_metadata names the email provider, as an email sign-up does');
select is(pg_temp.claim('alice', 'aal'), 'aal1', 'a single-factor session is aal1');
select is((select claims -> 'amr' from seen where key = 'alice'),
  jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now() - interval '30 minutes')::bigint)),
  'amr names the password, with the time it was given');
select is(pg_temp.claim('alice', 'exp')::bigint - pg_temp.claim('alice', 'iat')::bigint,
  extract(epoch from pg_temp.token_lifetime())::bigint, 'the token lives for the token lifetime, [auth] jwt_expiry');
select is(pg_temp.claim('alice', 'iat')::bigint, extract(epoch from now())::bigint, 'and was issued just now');

select is((select s.user_id from auth.sessions s where s.id = pg_temp.session_of('alice')), pg_temp.id('alice_user'),
  'session_id names a live auth.sessions row of the person');
select is((select s.aal::text from auth.sessions s where s.id = pg_temp.session_of('alice')), 'aal1', 'the row is aal1');
select is((select s.created_at from auth.sessions s where s.id = pg_temp.session_of('alice')),
  pg_temp.whole(now() - interval '30 minutes'), 'it was created at sign-in');
select is((select s.refreshed_at from auth.sessions s where s.id = pg_temp.session_of('alice')), now() at time zone 'UTC',
  'and refreshed when the token was issued');
select is((select array_agg(a.authentication_method order by a.authentication_method) from auth.mfa_amr_claims a
           where a.session_id = pg_temp.session_of('alice')), array['password'], 'the session has its amr row');
select is((select s.factor_id from auth.sessions s where s.id = pg_temp.session_of('alice')), null, 'which names no second factor');
select is(pg_temp.session_of('alice again'), pg_temp.session_of('alice'), 'the same person keeps the same session');
select isnt(pg_temp.session_of('bob'), pg_temp.session_of('alice'), 'another person has another session');
select is((select s.user_id from auth.sessions s where s.id = pg_temp.session_of('bob')), pg_temp.id('bob_user'),
  'which is their own');

-- as_user_stepped_up: a second-factor session -------------------------------------------------------------------------------

select pg_temp.as_user_stepped_up('alice');
select pg_temp.keep('alice aal2');
select pg_temp.as_platform();

select is((select role from seen where key = 'alice aal2'), 'authenticated', 'as_user_stepped_up acts under the authenticated role');
select is((select uid from seen where key = 'alice aal2'), pg_temp.id('alice_user'), 'as the person named');
select is(pg_temp.claim('alice aal2', 'aal'), 'aal2', 'a second-factor session is aal2');
select is((select claims -> 'amr' from seen where key = 'alice aal2'),
  jsonb_build_array(
    jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now() - interval '1 minute')::bigint),
    jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now() - interval '30 minutes')::bigint)),
  'amr names the TOTP code a minute ago, then the password');
select is((select s.aal::text from auth.sessions s where s.id = pg_temp.session_of('alice aal2') and s.user_id = pg_temp.id('alice_user')),
  'aal2', 'session_id names a live aal2 row of the person');
select is((select array_agg(a.authentication_method order by a.authentication_method) from auth.mfa_amr_claims a
           where a.session_id = pg_temp.session_of('alice aal2')), array['password', 'totp'], 'with an amr row for each factor');
select isnt(pg_temp.session_of('alice aal2'), pg_temp.session_of('alice'), 'it is not the single-factor session');
select is((select array_agg(f.factor_type::text || ' ' || f.status::text) from auth.mfa_factors f where f.user_id = pg_temp.id('alice_user')),
  array['totp verified'], 'the person holds one verified authenticator app in Supabase Auth');
select is((select s.factor_id from auth.sessions s where s.id = pg_temp.session_of('alice aal2')),
  (select f.id from auth.mfa_factors f where f.user_id = pg_temp.id('alice_user')), 'the session names it as the factor it passed');
select ok((select f.created_at < s.created_at from auth.mfa_factors f join auth.sessions s on s.factor_id = f.id
           where s.id = pg_temp.session_of('alice aal2')), 'they enrolled it before this sign-in');
select is(private.has_verified_second_factor(pg_temp.id('alice_user')), true, 'so the database reads the person as enrolled');
select is(private.has_verified_second_factor(pg_temp.id('bob_user')), false, 'and a person who never stepped up as not enrolled');
select is((select count(*)::int from auth.mfa_factors f where f.user_id = pg_temp.id('bob_user')), 0, 'with no factor row');
select is((select array_agg(k order by k) from seen s, jsonb_object_keys(s.claims) k where s.key = 'alice aal2'),
  (select array_agg(k order by k) from seen s, jsonb_object_keys(s.claims) k where s.key = 'alice'),
  'and its token carries the same claims');

-- claims: the same session, under the platform role ---------------------------------------------------------------------------

select pg_temp.claims('alice');
select pg_temp.keep('alice claims');
select pg_temp.as_platform();
select is((select role from seen where key = 'alice claims'), 'postgres', 'claims keeps the platform role');
select is(pg_temp.session_of('alice claims'), pg_temp.session_of('alice'), 'and presents the person''s single-factor session');

-- What the database reads from them ---------------------------------------------------------------------------------------------

select pg_temp.as_user('alice');
select is((select session_ended from app.my_org_auth_status(pg_temp.id('org_a'))), false,
  'the session of as_user is live for the organization');
select is((select session_aal from app.my_second_factor_status()), 'aal1', 'and has passed no second factor');
select pg_temp.as_user_stepped_up('alice');
select is((select recent from app.my_second_factor_status()), true, 'the second factor of as_user_stepped_up is recent');
select pg_temp.as_platform();

-- The token hook ------------------------------------------------------------------------------------------------------------------

select is(pg_temp.claim('alice', 'org_id'), null, 'without a chosen organization the token has no org_id');
select pg_temp.as_user('mia');
select app.set_active_org(pg_temp.id('org_b'));
select pg_temp.as_user('mia');
select pg_temp.keep('mia');
select pg_temp.as_platform();
select is(pg_temp.claim('mia', 'org_id'), pg_temp.id('org_b')::text,
  'the token hook adds the organization the person chose, as it does on a refresh');

-- as_session: a session of the test's choosing ----------------------------------------------------------------------------------

create temporary table opened (key text primary key, id uuid);
grant select, insert on opened to public;

insert into opened select 'default', pg_temp.as_session('carol');
select pg_temp.keep('default');
insert into opened select 'default again', pg_temp.as_session('carol');
select pg_temp.keep('default again');
insert into opened select 'old', pg_temp.as_session('carol', p_age => interval '400 hours');
select pg_temp.keep('old');
insert into opened select 'idle', pg_temp.as_session('carol', p_age => interval '3 hours', p_last_activity => interval '20 minutes');
select pg_temp.keep('idle');
insert into opened select 'never refreshed', pg_temp.as_session('carol', p_age => interval '10 minutes', p_last_activity => interval '2 hours');
select pg_temp.keep('never refreshed');
insert into opened select 'aal2', pg_temp.as_session('carol', 'aal2', p_second_ago => interval '20 minutes');
select pg_temp.keep('aal2');
insert into opened select 'aal2 again', pg_temp.as_session('carol', 'aal2');
select pg_temp.keep('aal2 again');
insert into opened select 'expired', pg_temp.as_session('carol', p_age => interval '3 hours',
  p_last_activity => pg_temp.token_lifetime() + interval '1 minute', p_expired => true);
select pg_temp.keep('expired');
insert into opened select 'signed out', pg_temp.as_session('carol', p_row => false);
select pg_temp.keep('signed out');
insert into opened select 'no session_id', pg_temp.as_session('carol', p_without => array['session_id']);
select pg_temp.keep('no session_id');
insert into opened select 'no amr', pg_temp.as_session('carol', 'aal2', p_without => array['amr', 'aal']);
select pg_temp.keep('no amr');
select pg_temp.as_platform();

select is((select role from seen where key = 'default'), 'authenticated', 'as_session acts under the authenticated role');
select is((select uid from seen where key = 'default'), pg_temp.id('carol_user'), 'as the person named');
select is(pg_temp.session_of('default'), (select id from opened where key = 'default'), 'it returns the session its token names');
select is((select s.aal::text from auth.sessions s where s.id = pg_temp.session_of('default') and s.user_id = pg_temp.id('carol_user')),
  'aal1', 'by default a live single-factor session of the person');
select is((select array_agg(k order by k) from seen s, jsonb_object_keys(s.claims) k where s.key = 'default'),
  (select array_agg(k order by k) from seen s, jsonb_object_keys(s.claims) k where s.key = 'alice'),
  'with the claims as_user carries');
select isnt(pg_temp.session_of('default again'), pg_temp.session_of('default'), 'every call opens a new session');
select is((select count(*)::int from auth.sessions s where s.id in (pg_temp.session_of('default'), pg_temp.session_of('default again'))),
  2, 'and leaves the earlier one live');

select is((select s.created_at from auth.sessions s where s.id = pg_temp.session_of('old')),
  pg_temp.whole(now() - interval '400 hours'), 'p_age is how long ago the person signed in: on the row');
select is((select (claims -> 'amr' -> 0 ->> 'timestamp')::bigint from seen where key = 'old'),
  extract(epoch from now() - interval '400 hours')::bigint, 'and in the amr timestamp');
select is((select a.created_at from auth.mfa_amr_claims a where a.session_id = pg_temp.session_of('old')),
  pg_temp.whole(now() - interval '400 hours'), 'and on the amr row');
select is((select s.refreshed_at from auth.sessions s where s.id = pg_temp.session_of('old')), now() at time zone 'UTC',
  'an old session that was refreshed just now is still active');

select is((select s.refreshed_at from auth.sessions s where s.id = pg_temp.session_of('idle')),
  (now() - interval '20 minutes') at time zone 'UTC', 'p_last_activity is the last token refresh: on the row');
select is((select s.updated_at from auth.sessions s where s.id = pg_temp.session_of('idle')), now() - interval '20 minutes',
  'in its updated_at');
select is(pg_temp.claim('idle', 'iat')::bigint, extract(epoch from now() - interval '20 minutes')::bigint,
  'and in the time the token was issued');
select is(pg_temp.claim('idle', 'exp')::bigint, extract(epoch from now() - interval '20 minutes' + pg_temp.token_lifetime())::bigint,
  'so the token expires one token lifetime after that');
select ok(pg_temp.claim('idle', 'exp')::bigint > extract(epoch from now())::bigint, 'and has not expired');
select is((select s.created_at from auth.sessions s where s.id = pg_temp.session_of('idle')),
  pg_temp.whole(now() - interval '3 hours'), 'the sign-in time stays p_age');

select is((select s.refreshed_at from auth.sessions s where s.id = pg_temp.session_of('never refreshed')), null,
  'a last activity before the sign-in is a session never refreshed');
select is((select s.updated_at from auth.sessions s where s.id = pg_temp.session_of('never refreshed')),
  pg_temp.whole(now() - interval '10 minutes'), 'last active at its sign-in');
select is(pg_temp.claim('never refreshed', 'iat')::bigint, extract(epoch from now() - interval '10 minutes')::bigint,
  'with the token issued then');

select is(pg_temp.claim('aal2', 'aal'), 'aal2', 'p_aal sets the assurance level: in the token');
select is((select s.aal::text from auth.sessions s where s.id = pg_temp.session_of('aal2')), 'aal2', 'and on the row');
select is((select claims -> 'amr' from seen where key = 'aal2'),
  jsonb_build_array(
    jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now() - interval '20 minutes')::bigint),
    jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now() - interval '30 minutes')::bigint)),
  'p_second_ago is when the second factor passed');
select is((select a.updated_at from auth.mfa_amr_claims a where a.session_id = pg_temp.session_of('aal2') and a.authentication_method = 'totp'),
  pg_temp.whole(now() - interval '20 minutes'), 'on its amr row too');

select is((select s.factor_id from auth.sessions s where s.id = pg_temp.session_of('aal2')),
  (select f.id from auth.mfa_factors f where f.user_id = pg_temp.id('carol_user') and f.status::text = 'verified'),
  'and the row names the person''s verified authenticator app');
select is((select s.factor_id from auth.sessions s where s.id = pg_temp.session_of('aal2 again')),
  (select s.factor_id from auth.sessions s where s.id = pg_temp.session_of('aal2')), 'which a later session of theirs passes again');
select is((select count(*)::int from auth.mfa_factors f where f.user_id = pg_temp.id('carol_user')), 1, 'without a second enrollment');

-- The token is issued at the last activity, so a last activity beyond the token lifetime is an expired token.
select throws_ok(
  $$select pg_temp.as_session('carol', p_age => interval '3 hours', p_last_activity => pg_temp.token_lifetime() + interval '1 minute')$$,
  'P0001', null, 'a last activity beyond the token lifetime is refused: PostgREST would reject that token as expired');
select throws_ok(
  $$select pg_temp.as_session('carol', p_age => interval '3 hours', p_last_activity => pg_temp.token_lifetime())$$,
  'P0001', null, 'as is one exactly at the lifetime');
select lives_ok(
  $$select pg_temp.as_session('carol', p_age => interval '3 hours', p_last_activity => pg_temp.token_lifetime() - interval '1 second')$$,
  'one second inside the lifetime is a valid token');
select pg_temp.as_platform();
select ok(pg_temp.claim('expired', 'exp')::bigint < extract(epoch from now())::bigint,
  'p_expired presents the expired token when that is the case under test');
select is((select s.refreshed_at from auth.sessions s where s.id = pg_temp.session_of('expired')),
  (now() - pg_temp.token_lifetime() - interval '1 minute') at time zone 'UTC', 'over a session last refreshed then');

select isnt(pg_temp.session_of('signed out'), null, 'p_row false still names a session in the token');
select is(pg_temp.session_of('signed out'), (select id from opened where key = 'signed out'), 'the one it returns');
select is((select count(*)::int from auth.sessions s where s.id = pg_temp.session_of('signed out')), 0, 'but no auth.sessions row exists');
select is((select count(*)::int from auth.mfa_amr_claims a where a.session_id = pg_temp.session_of('signed out')), 0, 'nor its amr rows');
select ok(pg_temp.claim('signed out', 'exp')::bigint > extract(epoch from now())::bigint, 'and the token has not expired');

select is((select claims ? 'session_id' from seen where key = 'no session_id'), false, 'p_without drops a claim from the token');
select is((select s.user_id from auth.sessions s where s.id = (select id from opened where key = 'no session_id')), pg_temp.id('carol_user'),
  'while the session row stands');
select is((select claims ?| array['amr', 'aal'] from seen where key = 'no amr'), false, 'several claims can be dropped');
select is((select claims ? 'session_id' from seen where key = 'no amr'), true, 'and the others stay');

select pg_temp.as_session('carol', p_row => false);
select is((select session_ended from app.my_org_auth_status(pg_temp.id('org_a'))), true,
  'the database reads a session without its row as ended');
select pg_temp.as_platform();

-- The identities that are not sessions stay as they were ---------------------------------------------------------------------

select pg_temp.as_anon();
select pg_temp.keep('anon');
select pg_temp.as_platform();
select pg_temp.keep('platform');
select is((select claims from seen where key = 'anon'), '{"role": "anon"}'::jsonb, 'as_anon carries the anon role and no session');
select is((select role from seen where key = 'anon'), 'anon', 'under the anon role');
select is((select claims from seen where key = 'platform'), null, 'as_platform carries no token');

-- A token that outlived its account: no user row and no session row can stand behind it.
select pg_temp.token_of_deleted_account('00000000-0000-4000-8000-00000000dead');
select pg_temp.keep('gone');
select pg_temp.as_platform();
select is(pg_temp.claim('gone', 'sub'), '00000000-0000-4000-8000-00000000dead', 'token_of_deleted_account keeps the sub of the account that is gone');
select is((select role from seen where key = 'gone'), 'authenticated', 'under the authenticated role');
select isnt(pg_temp.session_of('gone'), null, 'and names a session');
select is((select count(*)::int from auth.sessions s where s.id = pg_temp.session_of('gone')), 0, 'that has no row');
select throws_ok($$select pg_temp.token_of_deleted_account(pg_temp.id('alice_user'))$$, 'P0001', null,
  'it is refused for a person whose account exists');

-- A person the suite did not make is a mistake in the suite, never a token.
select throws_ok($$select pg_temp.sign_in('00000000-0000-4000-8000-00000000dead')$$, 'P0001', null,
  'sign_in refuses a user with no account');
select throws_ok($$select pg_temp.as_user('nobody_here')$$, 'P0001', 'fixture: the world holds no person nobody_here',
  'as_user refuses a key the world does not hold');
select throws_ok($$select pg_temp.as_user_stepped_up('nobody_here')$$, 'P0001', null, 'as does as_user_stepped_up');
select throws_ok($$select pg_temp.as_session('nobody_here')$$, 'P0001', null, 'and as_session');
select throws_ok($$select pg_temp.as_deleted_user('alice')$$, 'P0001', null, 'as_deleted_user refuses a person who still has an account');
select pg_temp.as_platform();

-- Every session a helper opened is of a world person and rolls back with the suite.
select is((select count(*)::int from auth.sessions s where s.user_agent = 'pgTAP'
           and not exists (select 1 from world w where w.id = s.user_id)), 0, 'the helpers open sessions for world people only');
select is((select count(*)::int from test_sessions t where not exists (select 1 from auth.sessions s where s.id = t.session_id)), 0,
  'and every session they keep for reuse is live');

select * from finish();
rollback;
