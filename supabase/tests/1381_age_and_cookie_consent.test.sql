-- pgTAP: migration 1381, finding A65-014 (RRR-127). Sign-up records "16 or older" from the ticked box; other sign-ins
-- confirm through app.confirm_minimum_age; the cookie banner's decision is stored server-side, and a Global Privacy
-- Control signal is recorded and refuses every non-essential category.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(17);

-- Age confirmation -------------------------------------------------------------------------------------------------
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

select pg_temp.sign_up('ticked', 'ticked@signup.test', '{"full_name": "Tess Ticked", "age_confirmed": "16", "signup_surface": "Gateway"}');
select pg_temp.sign_up('google', 'google@signup.test', '{"full_name": "Gus Google"}');
select pg_temp.sign_up('forged', 'forged@signup.test', '{"full_name": "Fay Forged", "age_confirmed": "yes"}');

select results_eq($$select surface, minimum_age::int from private.age_confirmations where person_id = pg_temp.id('ticked')$$,
  $$values ('Gateway'::text, 16)$$, 'a sign-up with the box ticked records the confirmation and its surface');
select is((select count(*)::int from private.age_confirmations where person_id = pg_temp.id('google')), 0,
  'a sign-in without the box records nothing');
select is((select count(*)::int from private.age_confirmations where person_id = pg_temp.id('forged')), 0,
  'only the exact value the form sends counts');

select pg_temp.as_user('ticked');
select ok(app.minimum_age_confirmed(), 'the person who ticked the box reads their confirmation');
select pg_temp.as_user('google');
select ok(not app.minimum_age_confirmed(), 'a first Google sign-in has not confirmed yet');
select throws_ok($$select app.confirm_minimum_age('Elsewhere')$$, 'XR001', null, 'the surface is one of the three shells');
select ok(app.confirm_minimum_age('Atlas') is not null, 'confirming records the time');
select ok(app.minimum_age_confirmed(), 'the confirmation stands');
create temporary table t (label text primary key, at timestamptz);
grant select, insert on t to public;
insert into t values ('repeat', app.confirm_minimum_age('Gateway'));
select pg_temp.as_platform();
select is((select at from t where label = 'repeat'), (select confirmed_at from private.age_confirmations where person_id = pg_temp.id('google')),
  'a repeat keeps the first confirmation');
select is((select surface from private.age_confirmations where person_id = pg_temp.id('google')), 'Atlas',
  'and its surface');
select pg_temp.as_user('google');
select throws_ok($$select * from private.age_confirmations$$, '42501', null, 'the evidence table is never readable by signed-in callers');
select pg_temp.as_anon();
select throws_ok($$select app.confirm_minimum_age('Atlas')$$, '42501', null, 'nobody confirms without signing in');

-- Cookie consent and Global Privacy Control -----------------------------------------------------------------------
select pg_temp.as_anon();
select set_config('request.headers', '{"x-forwarded-for": "198.51.100.40"}', true);
select ok(api_public.record_cookie_consent('visitor-0000-0000-0001', null, true, false, false, 'cookie-policy 1.0.0-draft', false),
  'a visitor''s choice is recorded');
select ok(api_public.record_cookie_consent('visitor-0000-0000-0002', null, true, true, true, 'cookie-policy 1.0.0-draft', true),
  'a choice under Global Privacy Control is recorded');
select pg_temp.as_platform();
select results_eq($$select functional, analytics, marketing from app.cookie_consent_events
  where visitor_hash = extensions.digest('visitor-0000-0000-0002', 'sha256')$$,
  $$values (false, false, false)$$, 'Global Privacy Control refuses every non-essential category, whatever was ticked');
select is((select count(*)::int from app.privacy_signals where visitor_hash = extensions.digest('visitor-0000-0000-0002', 'sha256')
  and signal = 'Global Privacy Control'), 1, 'the signal is recorded in app.privacy_signals');

create function pg_temp.flood(p_count integer) returns boolean
language plpgsql as $$
declare
  v_last boolean;
begin
  perform pg_temp.as_anon();
  for i in 1..p_count loop
    v_last := api_public.record_cookie_consent('visitor-flood-0000-0001', null, false, false, false, 'v', false);
  end loop;
  perform pg_temp.as_platform();
  return v_last;
end $$;
select is(pg_temp.flood(21), false, 'one visitor gets at most 20 decisions in 10 minutes');

select * from finish();
rollback;
