-- pgTAP: migration 1561, signed-in sessions and devices (A99, RRR-144; A65-002, ADR 0055; Section 4.5.6 personal
-- setting 4). A person lists only their own Supabase Auth sessions, with the device XOS recorded (never Supabase Auth's
-- first-entry address), signs out one other session or every other one (the auth.sessions rows go, with their device),
-- and each is audited and notified. App sessions stay under Connected apps. app.my_org_auth_status says session_ended
-- once the JWT's session is gone. API keys, apps, other people and anon are refused or ignored.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(31);

create function pg_temp.new_session(p_user text, p_key text, p_age interval default interval '1 hour',
  p_client uuid default null) returns uuid
language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  perform set_config('role', 'postgres', true);
  insert into auth.sessions (id, user_id, created_at, updated_at, aal, oauth_client_id, ip, user_agent)
  values (v_id, pg_temp.id(p_user || '_user'), now() - p_age, now() - p_age, 'aal1', p_client, '203.0.113.250', 'node');
  insert into world values (p_key, v_id);
  return v_id;
end $$;

create function pg_temp.as_session(p_user text, p_session text, p_key boolean default false) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', pg_temp.id(p_user || '_user'), 'role', 'authenticated', 'aal', 'aal1',
      'session_id', coalesce(pg_temp.id(p_session), gen_random_uuid()),
      'amr', jsonb_build_array(jsonb_build_object('method', case when p_key then 'xos_api_key' else 'password' end,
        'timestamp', extract(epoch from now() - interval '1 hour')::bigint)),
      'scopes', case when p_key then '["projects"]'::jsonb end)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

select pg_temp.new_session('alice', 'laptop', interval '3 hours');
select pg_temp.new_session('alice', 'phone', interval '2 hours');
select pg_temp.new_session('alice', 'tablet', interval '1 hour');
select pg_temp.new_session('bob', 'bob_laptop');
select pg_temp.as_platform();
insert into auth.oauth_clients (id, client_secret_hash, registration_type, redirect_uris, grant_types, client_name, client_type,
  token_endpoint_auth_method)
values ('00000000-0000-4000-8000-0000000000a9', '', 'manual', 'https://app.example.test/cb', 'authorization_code,refresh_token',
  'Test App', 'public', 'none');
select pg_temp.new_session('alice', 'app_session', interval '1 hour', '00000000-0000-4000-8000-0000000000a9');

select has_table('private', 'session_devices', 'devices live in the private schema');
select ok((select relrowsecurity from pg_class where oid = 'private.session_devices'::regclass), 'with row level security');
select ok(not has_table_privilege('authenticated', 'private.session_devices', 'SELECT'), 'never selected directly');
select is((select count(*)::int from pg_attribute a where a.attrelid = 'private.session_devices'::regclass and a.attnum > 0
  and not a.attisdropped and col_description(a.attrelid, a.attnum) is null), 0, 'every column is commented');

-- Recording the device ------------------------------------------------------------------------------------------------------

select pg_temp.as_session('alice', 'laptop');
select lives_ok($$select app.touch_my_session('Atlas', '198.51.100.7', 'Lisbon, Lisbon, PT', 'Mozilla/5.0 (Macintosh) Chrome/141.0')$$,
  'Atlas records the laptop''s device');
select pg_temp.as_session('alice', 'phone');
select lives_ok($$select app.touch_my_session('Compass', 'not an address', e'Porto\n', 'Compass/1.0 (iPhone; iOS 26)')$$,
  'Compass records the phone, with an unreadable address');
select app.touch_my_session('Kiosk', '198.51.100.9', null, 'x');
select pg_temp.as_session('alice', 'tablet', true);
select app.touch_my_session('API', '198.51.100.10', null, 'curl/8');
select pg_temp.as_session('alice', 'missing');
select app.touch_my_session('Atlas', '198.51.100.11', null, 'Firefox');

select pg_temp.as_platform();
select is((select host(client_address) from private.session_devices where session_id = pg_temp.id('laptop')), '198.51.100.7',
  'the client address is the one Atlas read behind its proxies');
select is((select client_address from private.session_devices where session_id = pg_temp.id('phone')), null,
  'text that is not an address is kept as unknown');
select is((select place from private.session_devices where session_id = pg_temp.id('phone')), 'Porto', 'control characters are dropped');
select is((select count(*)::int from private.session_devices), 2,
  'an unknown surface, an API key and a session that no longer exists record nothing');

-- Listing ---------------------------------------------------------------------------------------------------------------

select pg_temp.as_session('alice', 'laptop');
select is((select count(*)::int from app.my_sessions()), 3, 'alice sees her three sessions, not the app''s');
select is((select session_id from app.my_sessions() limit 1), pg_temp.id('laptop'), 'this session first');
select is((select is_current from app.my_sessions() where session_id = pg_temp.id('laptop')), true, 'marked current');
select is((select place || ' / ' || client_address || ' / ' || surface from app.my_sessions() where session_id = pg_temp.id('laptop')),
  'Lisbon, Lisbon, PT / 198.51.100.7 / Atlas', 'with the place, address and surface XOS recorded');
select is((select client_address from app.my_sessions() where session_id = pg_temp.id('tablet')), null,
  'never the first-entry address Supabase Auth stored');
select is((select count(*)::int from app.my_sessions() where session_id = pg_temp.id('bob_laptop')), 0, 'never bob''s');

-- Signing out --------------------------------------------------------------------------------------------------------------

select throws_ok($$select app.sign_out_my_session((select id from world where key = 'laptop'))$$, 'XR001',
  'session_current: Sign out of this device with Sign out instead.', 'this session signs out with Sign out');
select throws_ok($$select app.sign_out_my_session((select id from world where key = 'bob_laptop'))$$, '42501', 'session not found',
  'another person''s session reads as not found');
select throws_ok($$select app.sign_out_my_session((select id from world where key = 'app_session'))$$, '42501', 'session not found',
  'an app''s session is revoked under Connected apps, not here');
select lives_ok($$select app.sign_out_my_session((select id from world where key = 'phone'))$$, 'she signs out her phone');
select pg_temp.as_platform();
select is((select count(*)::int from auth.sessions where id = pg_temp.id('phone')), 0, 'its Supabase Auth session is gone');
select is((select count(*)::int from private.session_devices where session_id = pg_temp.id('phone')), 0, 'and its device with it');
select is((select detail ->> 'surface' from private.account_security_events where user_id = pg_temp.id('alice_user') and kind = 'session_signed_out'),
  'Compass', 'the trail names what was signed out');

-- The signed-out phone's token ends for every org at once.
select pg_temp.as_session('alice', 'phone');
select is((select session_ended from app.my_org_auth_status(pg_temp.id('org_a'))), true, 'the signed-out session has ended for the org');
select pg_temp.as_session('alice', 'laptop');
select is((select session_ended from app.my_org_auth_status(pg_temp.id('org_a'))), false, 'a live session has not');
select pg_temp.as_session('alice', 'phone', true);
select is((select session_ended from app.my_org_auth_status(pg_temp.id('org_a'))), false, 'API keys stay exempt');

select pg_temp.as_session('alice', 'laptop');
select is(app.sign_out_my_other_sessions(), 1, 'signing out every other session ends the tablet');
select pg_temp.as_platform();
select is((select count(*)::int from auth.sessions where user_id = pg_temp.id('alice_user') and oauth_client_id is null), 1,
  'only this session is left');
select is((select count(*)::int from auth.sessions where id = pg_temp.id('app_session')), 1, 'the app stays connected');
select is((select count(*)::int from app.notifications where recipient_person_id = pg_temp.id('alice') and kind = 'account.session_signed_out'), 2,
  'alice is told each time');

select pg_temp.as_session('alice', 'laptop', true);
select throws_ok($$select app.sign_out_my_other_sessions()$$, '42501', null, 'an API key never signs a person out');

select * from finish();
rollback;
