-- pgTAP: migration 1299, finding A69-007 (RRR-114). 1299 pinned the org MFA policy, session length and idle timeout to
-- their defaults while nothing enforced them. A77 enforces all three (migration 1330: the Atlas proxy and org contexts,
-- the API runtime and Compass read app.my_org_auth_status) and lifts the pin, so the guard is gone and every registered
-- value saves again; 1330_auth_assurance.test.sql shows each value enforced.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(6);

select hasnt_trigger('app', 'setting_values', 't43_guard_unenforced_security_settings',
  'the 1299 guard trigger is lifted now that the settings are enforced');
select hasnt_function('private', 'guard_unenforced_security_settings', 'and its function is gone');

select pg_temp.as_user('alice');
select lives_ok($$select app.set_setting((select id from world where key = 'org_a'), 'security.mfa_policy', 'Organization', null, 'everyone')$$,
  'requiring a second factor for everyone saves');
select lives_ok($$select app.set_setting((select id from world where key = 'org_a'), 'security.mfa_policy', 'Organization', null, 'admins')$$,
  'requiring it for admins saves');
select lives_ok($$select app.set_setting((select id from world where key = 'org_a'), 'security.session_hours', 'Organization', null, null, null, 8)$$,
  'a shorter session length saves');
select lives_ok($$select app.set_setting((select id from world where key = 'org_a'), 'security.idle_timeout_minutes', 'Organization', null, null, null, 15)$$,
  'a shorter idle timeout saves');

select * from finish();
rollback;
