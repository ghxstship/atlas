-- pgTAP: Sign in with Google (ADR 0036, RRR-117) goes through the same bootstrap as an email sign-up.
-- Supabase Auth writes the rows itself; this suite writes them the way it does for Google, so it covers what
-- the database does with them: the person row (private.handle_new_auth_user, 0206), invitations and org
-- creation, and the active org claim (private.custom_access_token_hook, 0920).
--   * A first Google sign-in inserts auth.users with Google's claims in raw_user_meta_data (full_name among
--     them), a confirmed email (Google verified it) and a google identity.
--   * Automatic linking: when the Google email is verified and matches an account, Supabase Auth adds a
--     google identity to that user and merges Google's claims into raw_user_meta_data. No user is inserted.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(14);

-- Writes a first Google sign-in as Supabase Auth does: the user, then its google identity.
create function pg_temp.google_sign_up(p_key text, p_email text, p_name text, p_sub text) returns void
language plpgsql as $$
declare
  v_user uuid := gen_random_uuid();
  v_claims jsonb := jsonb_build_object(
    'iss', 'https://accounts.google.com', 'sub', p_sub, 'name', p_name, 'full_name', p_name,
    'email', p_email, 'email_verified', true, 'phone_verified', false, 'provider_id', p_sub,
    'picture', 'https://lh3.googleusercontent.com/a/example', 'avatar_url', 'https://lh3.googleusercontent.com/a/example');
begin
  perform pg_temp.as_platform();
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at)
  values (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', p_email, now(),
          '{"provider": "google", "providers": ["google"]}', v_claims, now(), now());
  insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), p_sub, v_user, v_claims, 'google', now(), now(), now());
  insert into world values (p_key || '_user', v_user);
  insert into world select p_key, p.id from app.people p where p.user_id = v_user;
end $$;

-- Links a Google identity to an existing user as automatic linking does.
create function pg_temp.google_link(p_key text, p_name text, p_sub text) returns void
language plpgsql as $$
declare
  v_user uuid := pg_temp.id(p_key || '_user');
  v_claims jsonb;
begin
  perform pg_temp.as_platform();
  v_claims := jsonb_build_object(
    'iss', 'https://accounts.google.com', 'sub', p_sub, 'name', p_name, 'full_name', p_name,
    'email', (select u.email from auth.users u where u.id = v_user), 'email_verified', true, 'provider_id', p_sub);
  insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), p_sub, v_user, v_claims, 'google', now(), now(), now());
  update auth.users
  set raw_user_meta_data = coalesce(raw_user_meta_data, '{}') || v_claims,
      raw_app_meta_data = coalesce(raw_app_meta_data, '{}') || '{"providers": ["email", "google"]}',
      updated_at = now()
  where id = v_user;
end $$;

create function pg_temp.hook(p_key text) returns jsonb
language sql as $$
  select private.custom_access_token_hook(jsonb_build_object('user_id', pg_temp.id(p_key || '_user'),
    'claims', '{"role": "authenticated"}'::jsonb))
$$;

-- A first Google sign-in --------------------------------------------------------------------------------------
select pg_temp.google_sign_up('grace', 'grace@harbor.test', 'Grace Hopper', '110000000000000000001');
select is((select count(*)::integer from app.people p where p.user_id = pg_temp.id('grace_user')), 1,
  'a first Google sign-in creates the person row, as an email sign-up does');
select is((select p.full_name from app.people p where p.id = pg_temp.id('grace')), 'Grace Hopper',
  'the person takes the name Google returns as full_name');
select is(pg_temp.hook('grace') -> 'claims' -> 'org_id', null, 'with no org yet, the token carries no org claim');

-- She creates her organization on /auth/organization, as a new email account does.
select pg_temp.as_user('grace');
select lives_ok($$select app.create_organization('Harbor Crew', 'harbor-crew-google')$$,
  'a Google account creates its organization');
select ok(exists (select 1 from app.memberships m join app.organizations o on o.id = m.org_id
                  where m.person_id = pg_temp.id('grace') and o.slug = 'harbor-crew-google' and m.deleted_at is null),
  'and holds its membership');
select lives_ok($$select app.set_active_org((select id from app.organizations where slug = 'harbor-crew-google'))$$,
  'and selects it in the context switcher');
select pg_temp.as_platform();
select is(pg_temp.hook('grace') -> 'claims' ->> 'org_id',
  (select id::text from app.organizations where slug = 'harbor-crew-google'),
  'the custom access token hook writes her org into the Google session''s token');

-- An invitation to a Google account's email -----------------------------------------------------------------
select pg_temp.google_sign_up('hedy', 'hedy@northwind.test', 'Hedy Lamarr', '110000000000000000002');
create temporary table invite as select pg_temp.invite_token('bob', 'org_a', 'hedy@northwind.test', 'member') as token;
grant select on invite to public;
select pg_temp.as_user('hedy');
select is((select refusal from app.accept_invite((select token from invite))), null,
  'an invitation to the address Google verified is accepted after signing in with Google');
select pg_temp.as_platform();
select ok(exists (select 1 from app.memberships m where m.person_id = pg_temp.id('hedy') and m.org_id = pg_temp.id('org_a')
                  and m.deleted_at is null), 'and she becomes a member');

-- Automatic linking to an existing email account -------------------------------------------------------------
select pg_temp.as_user('dave');
select app.set_active_org(pg_temp.id('org_a'));
select pg_temp.google_link('dave', 'Dave L.', '110000000000000000003');
select is((select count(*)::integer from app.people p where p.user_id = pg_temp.id('dave_user')), 1,
  'linking Google to an existing account adds no second person');
select is((select p.full_name from app.people p where p.id = pg_temp.id('dave')), 'Dave Lindqvist',
  'the person keeps the name they chose; Google''s name stays in the auth metadata');
select is((select count(*)::integer from auth.identities i where i.user_id = pg_temp.id('dave_user') and i.provider = 'google'), 1,
  'the account now has a google identity');
select ok(exists (select 1 from app.memberships m where m.person_id = pg_temp.id('dave') and m.org_id = pg_temp.id('org_a')
                  and m.deleted_at is null), 'memberships are untouched');
select is(pg_temp.hook('dave') -> 'claims' ->> 'org_id', pg_temp.id('org_a')::text,
  'a session started with Google carries the same org claim as one started with email');

select * from finish();
rollback;
