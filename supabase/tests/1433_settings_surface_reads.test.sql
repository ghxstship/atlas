-- pgTAP: reads behind the settings panels (A86, RRR-131, finding A65-004): the person's own connected apps, the
-- custom field targets and an org's usage per meter.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(13);

-- Connected apps ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
with a as (insert into app.oauth_apps (org_id, name, redirect_uri) values (pg_temp.id('org_a'), 'Show Planner', 'https://planner.example.com/callback')
           returning id)
insert into world select 'client_app', id from a;
create temporary table k (key text primary key, val text);
grant select, insert on k to public;
insert into k select 'client', client_id from app.oauth_apps where id = pg_temp.id('client_app');

select pg_temp.as_user('dave');
select is((select count(*)::integer from app.oauth_apps), 0, 'a member cannot read the org''s app registry');
insert into world select 'dave_grant',
  app.grant_oauth_consent((select val from k where key = 'client'), array['work', 'projects']);

select pg_temp.as_user('dave');
select is((select concat_ws('|', app_name, org_name, array_to_string(scopes, ',')) from app.my_oauth_grants()),
  'Show Planner|Northwind Live|projects,work', 'the person lists their own grants with the app and org names');
select lives_ok($$update app.oauth_grants set deleted_at = now() where id = pg_temp.id('dave_grant')$$, 'and revokes one');
select is((select count(*)::integer from app.my_oauth_grants()), 0, 'a revoked grant leaves the list');

select pg_temp.as_user('erin');
select is((select count(*)::integer from app.my_oauth_grants()), 0, 'nobody lists another person''s grants');
select pg_temp.as_anon();
select throws_ok($$select * from app.my_oauth_grants()$$, '42501', null, 'anon cannot call it');

-- Custom field targets ----------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select ok((select count(*) from app.custom_field_targets) >= 9, 'members read the tables custom fields may target');
select ok(exists (select 1 from app.custom_field_targets where table_name = 'app.projects'), 'projects among them');
select pg_temp.as_anon();
select throws_ok($$select 1 from app.custom_field_targets$$, '42501', null, 'anon cannot read them');

-- Usage -------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select private.record_usage(pg_temp.id('org_a'), 'emails_sent', 3);
select private.record_usage(pg_temp.id('org_a'), 'emails_sent', 2);
select private.record_usage(pg_temp.id('org_b'), 'emails_sent', 40);
insert into k select 'meters', count(*)::text from private.usage_meters;

select pg_temp.as_user('alice');
select is((select quantity from app.org_usage(pg_temp.id('org_a')) where meter_code = 'emails_sent' and not closed), 5::bigint,
  'the open month sums this org''s usage events only');
select is((select unit from app.org_usage(pg_temp.id('org_a')) where meter_code = 'emails_sent' and not closed), 'message',
  'with the meter''s unit');
select is((select count(*)::integer from app.org_usage(pg_temp.id('org_a')) where not closed),
  (select val::integer from k where key = 'meters'), 'every meter appears for the open month, zero included');

select pg_temp.as_user('dave');
select throws_ok($$select * from app.org_usage(pg_temp.id('org_a'))$$, '42501', null, 'usage needs org.usage.read');

select * from finish();
rollback;
