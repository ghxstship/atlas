-- pgTAP: migration 1299, finding A69-007 (RRR-114). The org MFA policy, session length and idle timeout are not
-- enforced anywhere, so they keep their defaults: any other value is refused, the defaults may still be saved, and no
-- org holds a value that would claim protection.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(7);

select pg_temp.as_user('alice');
select throws_ok($$select app.set_setting((select id from world where key = 'org_a'), 'security.mfa_policy', 'Organization', null, 'everyone')$$,
  'XR001', 'setting_not_enforced: XOS does not enforce this setting yet, so it keeps its default. Changing it would not protect anyone.',
  'requiring a second factor for everyone is refused while nothing enforces it');
select throws_ok($$select app.set_setting((select id from world where key = 'org_a'), 'security.mfa_policy', 'Organization', null, 'admins')$$,
  'XR001', null, 'requiring it for admins is refused too');
select throws_ok($$select app.set_setting((select id from world where key = 'org_a'), 'security.session_hours', 'Organization', null, null, null, 8)$$,
  'XR001', null, 'a shorter session length is refused');
select throws_ok($$select app.set_setting((select id from world where key = 'org_a'), 'security.idle_timeout_minutes', 'Organization', null, null, null, 15)$$,
  'XR001', null, 'a shorter idle timeout is refused');
select lives_ok($$select app.set_setting((select id from world where key = 'org_a'), 'security.mfa_policy', 'Organization', null, 'optional')$$,
  'the default MFA policy can still be saved');
select lives_ok($$select app.set_setting((select id from world where key = 'org_a'), 'security.session_hours', 'Organization', null, null, null, 336)$$,
  'the default session length can still be saved');

select pg_temp.as_platform();
select is_empty($$
  select v.org_id::text || ' ' || v.setting_key from app.setting_values v
  where v.deleted_at is null and (
       (v.setting_key = 'security.mfa_policy' and coalesce(v.value_text, 'optional') <> 'optional')
    or (v.setting_key = 'security.session_hours' and coalesce(v.value_integer, 336) <> 336)
    or (v.setting_key = 'security.idle_timeout_minutes' and coalesce(v.value_integer, 60) <> 60))
$$, 'no org holds an unenforced security value');

select * from finish();
rollback;
