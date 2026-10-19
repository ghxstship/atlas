-- pgTAP: migration 1171, kiosk upkeep (A50, ADR 0031). An Admin renames a kiosk, moves it to another project of
-- the org and retires it, after which its device key no longer verifies; nobody can rewrite the key hash, the
-- last-seen time or the revocation stamp, or move a kiosk to another org's project. A Manager, another org and
-- anon cannot change kiosks.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(11);

select pg_temp.as_user('bob');
create temporary table kiosk (id uuid, device_key text);
grant select, insert on kiosk to public;
insert into kiosk select r.kiosk_device_id, r.device_key from app.register_kiosk_device(pg_temp.id('org_a'), 'Gate 1 Tablet', pg_temp.id('prj_a')) r;

select lives_ok($$update app.kiosk_devices set name = 'Gate 2 Tablet' where id = (select id from kiosk)$$, 'an Admin renames a kiosk');
select is((select name from app.kiosk_devices where id = (select id from kiosk)), 'Gate 2 Tablet', 'the new name is kept');
select lives_ok($$update app.kiosk_devices set project_id = (select id from world where key = 'prj_a2') where id = (select id from kiosk)$$,
  'an Admin moves a kiosk to another project of the org');
select throws_ok($$update app.kiosk_devices set project_id = (select id from world where key = 'prj_b') where id = (select id from kiosk)$$,
  null, null, 'a project of another org is refused');
select throws_ok($$update app.kiosk_devices set revoked_at = now() where id = (select id from kiosk)$$,
  '42501', null, 'the revocation stamp is not writable');
select throws_ok($$update app.kiosk_devices set last_seen_at = now() where id = (select id from kiosk)$$,
  '42501', null, 'the last-seen time is not writable');

select pg_temp.as_user('carol');
select is((select count(*)::int from app.kiosk_devices), 0, 'a Manager does not see kiosks');

select pg_temp.as_user('xavier');
update app.kiosk_devices set name = 'Taken' where id = (select id from kiosk);
select pg_temp.as_platform();
select is((select name from app.kiosk_devices where id = (select id from kiosk)), 'Gate 2 Tablet', 'cross-tenant: another org changes nothing');

select pg_temp.as_user('bob');
select lives_ok($$update app.kiosk_devices set deleted_at = now() where id = (select id from kiosk)$$, 'an Admin retires a kiosk');
select pg_temp.as_platform();
select ok(not exists (select 1 from app.kiosk_devices d where d.id = (select id from kiosk)
  and d.device_key_hash = extensions.digest((select device_key from kiosk), 'sha256') and d.deleted_at is null and d.revoked_at is null),
  'a retired kiosk no longer matches as a live device');

select pg_temp.as_anon();
select throws_ok('select 1 from app.kiosk_devices', '42501', null, 'anon reads no kiosks');

select * from finish();
rollback;
