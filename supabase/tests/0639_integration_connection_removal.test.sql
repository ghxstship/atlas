-- pgTAP: removing an integration connection. Only a Disconnected connection is removed, so its Vault secret is
-- destroyed first; a Disconnected connection is otherwise frozen; role bands and tenancy still apply.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

select pg_temp.as_user('bob');
with c as (insert into app.integration_connections (org_id, provider_code, display_name) values (pg_temp.id('org_a'), 'slack', 'Slack') returning id) insert into world select 'slack', id from c;
select app.store_integration_credential(pg_temp.id('slack'), 'fixture-token', 'OAuth Token');
select app.transition_integration_connection(pg_temp.id('slack'), 'Pending', 'Connected', 'Authorized.');

select throws_ok($$update app.integration_connections set deleted_at = now() where id = (select id from world where key = 'slack')$$,
  'XR001', 'integration_disconnect_first: Disconnect the connection before removing it, so its credential is destroyed.', 'a Connected connection is not removed');
select app.transition_integration_connection(pg_temp.id('slack'), 'Connected', 'Disconnected', 'Moving to Teams.');
select throws_ok($$update app.integration_connections set display_name = 'Old Slack' where id = (select id from world where key = 'slack')$$,
  'XR001', 'integration_disconnected: A disconnected connection is kept for its history and cannot change.', 'a Disconnected connection stays frozen');
select throws_ok($$update app.integration_connections set display_name = 'Old Slack', deleted_at = now() where id = (select id from world where key = 'slack')$$,
  'XR001', 'integration_disconnected: A disconnected connection is kept for its history and cannot change.', 'removal cannot carry other changes');
select pg_temp.as_user('carol');
update app.integration_connections set deleted_at = now() where id = pg_temp.id('slack');
select pg_temp.as_platform();
select is((select deleted_at from app.integration_connections where id = pg_temp.id('slack')), null::timestamptz, 'a Manager cannot remove it');
select pg_temp.as_user('xavier');
update app.integration_connections set deleted_at = now() where id = pg_temp.id('slack');
select pg_temp.as_platform();
select is((select deleted_at from app.integration_connections where id = pg_temp.id('slack')), null::timestamptz, 'nor another org');
select pg_temp.as_user('bob');
select lives_ok($$update app.integration_connections set deleted_at = now() where id = (select id from world where key = 'slack')$$, 'an Admin removes the Disconnected connection');
select pg_temp.as_platform();
select is((select count(*)::int from private.integration_credentials where integration_connection_id = pg_temp.id('slack')), 0, 'and no credential remains');
select pg_temp.as_user('bob');
select is((select count(*)::int from app.integration_connections where deleted_at is null), 0, 'the removed connection leaves the live list');

select * from finish();
rollback;
