-- pgTAP: communication connectors (Section 17: Slack and Teams). Channel routes (RLS, role bands, category and
-- cross-org guards, catalog event types), routed events (org and project scope, Connected only, cross-org deny), and
-- chat identity resolution through the Membership mapping (current memberships only, service role only).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

select pg_temp.as_user('bob');
with c as (insert into app.integration_connections (org_id, provider_code, display_name, external_account_id) values (pg_temp.id('org_a'), 'slack', 'Northwind Slack', 'T0NORTH') returning id)
  insert into world select 'slack', id from c;
with c as (insert into app.integration_connections (org_id, provider_code, display_name) values (pg_temp.id('org_a'), 'google_drive', 'Drive') returning id)
  insert into world select 'drive', id from c;
select app.store_integration_credential(pg_temp.id('slack'), 'fixture-token', 'OAuth Token');
select app.transition_integration_connection(pg_temp.id('slack'), 'Pending', 'Connected', 'Authorized.');
select pg_temp.as_user('xavier');
with c as (insert into app.integration_connections (org_id, provider_code, display_name, external_account_id) values (pg_temp.id('org_b'), 'slack', 'Harbor Slack', 'T0HARBOR') returning id)
  insert into world select 'slack_b', id from c;

-- Routes -------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select lives_ok($$insert into app.integration_channel_routes (integration_connection_id, project_id, event_type, external_channel_id) values ((select id from world where key = 'slack'), (select id from world where key = 'prj_a'), 'record.created', 'C0PROD')$$,
  'an Admin routes project record events to a channel');
select lives_ok($$insert into app.integration_channel_routes (integration_connection_id, event_type, external_channel_id) values ((select id from world where key = 'slack'), 'project.created', 'C0OPS')$$,
  'and org-wide project events to another');
select throws_ok($$insert into app.integration_channel_routes (integration_connection_id, event_type, external_channel_id) values ((select id from world where key = 'slack'), 'project.created', 'C0OPS')$$,
  '23505', null, 'a route is declared once');
select throws_ok($$insert into app.integration_channel_routes (integration_connection_id, event_type, external_channel_id) values ((select id from world where key = 'slack'), 'nothing.happened', 'C0OPS')$$,
  '23503', null, 'only catalog event types route');
select throws_ok($$insert into app.integration_channel_routes (integration_connection_id, event_type, external_channel_id) values ((select id from world where key = 'drive'), 'project.created', 'C0OPS')$$,
  'XR001', 'integration_category_mismatch: integration_channel_routes rows belong to a Communication connection, not a Storage connection.', 'routes belong to chat connections');
select throws_ok($$insert into app.integration_channel_routes (integration_connection_id, project_id, event_type, external_channel_id) values ((select id from world where key = 'slack'), (select id from world where key = 'prj_b'), 'record.created', 'C0X')$$,
  'XR001', 'cross_org_reference: integration_channel_routes.project_id points to a row of another org.', 'a route cannot name another org''s project');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.integration_channel_routes), 0, 'a Manager reads no routes');
select throws_ok($$insert into app.integration_channel_routes (integration_connection_id, event_type, external_channel_id) values ((select id from world where key = 'slack'), 'record.created', 'C1')$$, '42501', null, 'a Manager cannot add routes');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.integration_channel_routes), 0, 'another org reads none');
select pg_temp.as_anon();
select throws_ok('select 1 from app.integration_channel_routes', '42501', null, 'anon cannot read routes');
select throws_ok('select 1 from app.integration_route_events', '42501', null, 'anon cannot read routed events');

-- Routed events ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.records (project_id, record_kind, title, xyz, xyz_basis) values (pg_temp.id('prj_a'), 'Meeting', 'Production Meeting', 'Y', 'Declared');
insert into app.records (project_id, record_kind, title, xyz, xyz_basis) values (pg_temp.id('prj_a2'), 'Meeting', 'Gala Planning Session', 'Y', 'Declared');
select pg_temp.as_user('alice');
insert into app.projects (org_id, project_key, name, time_zone) values (pg_temp.id('org_a'), 'NWF', 'Northwind Fall Fair', 'America/New_York');
select pg_temp.as_platform();
insert into app.domain_events (org_id, event_type, subject_table, subject_id, project_id) values (pg_temp.id('org_b'), 'project.created', 'projects', pg_temp.id('prj_b'), pg_temp.id('prj_b'));
select is((select count(*)::int from app.integration_route_events where event_type = 'record.created'), 1, 'only the routed project''s record events match');
select is((select project_name from app.integration_route_events where event_type = 'record.created'), 'Northwind Summer Series', 'with the project name');
select is((select data ->> 'title' from app.integration_route_events where event_type = 'record.created'), 'Production Meeting', 'and the event payload');
select is((select count(*)::int from app.integration_route_events where event_type = 'project.created'), 3, 'org-wide routes match every project of the org and no other org');
select pg_temp.as_user('bob');
select is((select count(*)::int from app.integration_route_events), 4, 'an Admin reads the routed events');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.integration_route_events), 0, 'another org reads none');
select pg_temp.as_user('bob');
select app.transition_integration_connection(pg_temp.id('slack'), 'Connected', 'Paused', 'Quiet week.');
select pg_temp.as_platform();
select is((select count(*)::int from app.integration_route_events), 0, 'a paused connection posts nothing');
select pg_temp.as_user('bob');
select app.transition_integration_connection(pg_temp.id('slack'), 'Paused', 'Connected', 'Back.');

-- Chat identity ----------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is(app.find_chat_connection('slack', 'T0NORTH'), pg_temp.id('slack'), 'the workspace id finds its connection');
select is(app.find_chat_connection('slack', 'T0HARBOR'), null, 'a connection that is not Connected is not found');
select is(app.find_chat_connection('microsoft_teams', 'T0NORTH'), null, 'nor under another provider');
select is((select count(*)::int from app.resolve_chat_member(pg_temp.id('slack'), 'U0DAVE')), 0, 'an unmapped chat user resolves to nobody');
select app.upsert_integration_external_id(pg_temp.id('slack'), 'Membership', pg_temp.id('dave@org_a'), 'U0DAVE');
select is((select person_id from app.resolve_chat_member(pg_temp.id('slack'), 'U0DAVE')), pg_temp.id('dave'), 'a mapped chat user resolves to the person');
select is((select user_id from app.resolve_chat_member(pg_temp.id('slack'), 'U0DAVE')), pg_temp.id('dave_user'), 'and the auth user the handler acts as');
update app.memberships set deleted_at = now() where id = pg_temp.id('dave@org_a');
select is((select count(*)::int from app.resolve_chat_member(pg_temp.id('slack'), 'U0DAVE')), 0, 'an ended membership resolves to nobody');
select pg_temp.as_user('bob');
select throws_ok($$select app.resolve_chat_member((select id from world where key = 'slack'), 'U0DAVE')$$, '42501', null, 'signed-in callers cannot resolve chat users');
select throws_ok($$select app.find_chat_connection('slack', 'T0NORTH')$$, '42501', null, 'nor find connections by workspace');

select * from finish();
rollback;
