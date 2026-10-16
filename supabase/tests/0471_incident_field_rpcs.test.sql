-- pgTAP: A14 incident field RPCs (migration 0471) and the comment subjects of 0986. Each RPC
-- authorizes the session person on the incident's project (the sync wrapper runs as its owner),
-- replays a client id for the same person, refuses another person's id, and the RPCs are on the
-- sync allowlist. Same-tenant allow, cross-tenant deny, anon deny and role bands.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(27);

-- report_incident ------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select is((select replayed from app.report_incident(pg_temp.id('prj_a'), 'Spill at Bar 3', 'ENM-100', now(), null, 25.8, -80.2, 8, now(),
  '01920000-0000-7000-8000-00000000c001'::uuid)), false, 'a Field member on the project files an incident');
select is((select replayed from app.report_incident(pg_temp.id('prj_a'), 'Spill at Bar 3', 'ENM-100', now(), null, 25.8, -80.2, 8, now(),
  '01920000-0000-7000-8000-00000000c001'::uuid)), true, 'replaying the client id returns the stored incident');
select is((select count(*)::int from app.incidents where id = '01920000-0000-7000-8000-00000000c001'), 1, 'and files it once');
select is((select reported_by from app.incidents where id = '01920000-0000-7000-8000-00000000c001'), pg_temp.id('frank'), 'the reporter is the session person');
insert into world values ('inc', '01920000-0000-7000-8000-00000000c001');
select pg_temp.as_user('dave');
select throws_ok($$select * from app.report_incident((select id from world where key = 'prj_a'), 'Spill', 'ENM-100', now(), null, null, null, null, null, '01920000-0000-7000-8000-00000000c001'::uuid)$$,
  'XR001', 'incident_id_taken: Another incident already uses this id.', 'another person cannot replay an incident id');
select pg_temp.as_user('gina');
select throws_ok($$select * from app.report_incident((select id from world where key = 'prj_a'), 'Spill', 'ENM-100', now())$$, '42501', null, 'a Viewer cannot file an incident');
select pg_temp.as_user('frank');
select throws_ok($$select * from app.report_incident((select id from world where key = 'prj_a2'), 'Spill', 'ENM-100', now())$$, '42501', null, 'nor anyone off the project');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.report_incident((select id from world where key = 'prj_a'), 'Spill', 'ENM-100', now())$$, '42501', null, 'another org cannot file on this project');
select pg_temp.as_anon();
select throws_ok($$select * from app.report_incident((select id from world where key = 'prj_a'), 'Spill', 'ENM-100', now())$$, '42501', null, 'anon cannot file an incident');

-- Parties and media ------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select is(app.add_incident_party(pg_temp.id('inc'), 'Bartender, witness', null, '01920000-0000-7000-8000-00000000c002'::uuid),
  '01920000-0000-7000-8000-00000000c002'::uuid, 'a party is added with its client id');
select is(app.add_incident_party(pg_temp.id('inc'), 'Bartender, witness', null, '01920000-0000-7000-8000-00000000c002'::uuid),
  '01920000-0000-7000-8000-00000000c002'::uuid, 'and replayed without a second row');
select is((select count(*)::int from app.incident_parties where incident_id = pg_temp.id('inc')), 1, 'one party stored');
select is(app.add_incident_media(pg_temp.id('inc'), 'org/incidents/spill.jpg', now(), '01920000-0000-7000-8000-00000000c003'::uuid),
  '01920000-0000-7000-8000-00000000c003'::uuid, 'media is attached with its client id');
select is((select project_id from app.incident_media where id = '01920000-0000-7000-8000-00000000c003'), pg_temp.id('prj_a'), 'and carries the project');
select pg_temp.as_user('gina');
select throws_ok($$select app.add_incident_party((select id from world where key = 'inc'), 'Witness')$$, '42501', null, 'a Viewer cannot add parties');
select throws_ok($$select app.add_incident_media((select id from world where key = 'inc'), 'x.jpg')$$, '42501', null, 'or media');
select pg_temp.as_user('dave');
select throws_ok($$select app.add_incident_party((select id from world where key = 'inc'), 'Witness', null, '01920000-0000-7000-8000-00000000c002'::uuid)$$,
  'XR001', 'incident_party_id_taken: Another party already uses this id.', 'another person cannot reuse a party id');

-- Dispatch and arrival -------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is(app.dispatch_responder(pg_temp.id('inc'), pg_temp.id('frank@org_a'), '01920000-0000-7000-8000-00000000c004'::uuid),
  '01920000-0000-7000-8000-00000000c004'::uuid, 'a Manager dispatches a responder');
select is(app.dispatch_responder(pg_temp.id('inc'), pg_temp.id('frank@org_a'), '01920000-0000-7000-8000-00000000c004'::uuid),
  '01920000-0000-7000-8000-00000000c004'::uuid, 'and the replay stores nothing new');
select is((select count(*)::int from app.dispatch_assignments where incident_id = pg_temp.id('inc')), 1, 'one dispatch stored');
select pg_temp.as_user('gina');
select throws_ok($$select app.dispatch_responder((select id from world where key = 'inc'), (select id from world where key = 'gina@org_a'))$$, '42501', null, 'a Viewer cannot dispatch');
select throws_ok($$select app.mark_dispatch_arrived('01920000-0000-7000-8000-00000000c004'::uuid)$$, '42501', null, 'nor record someone else''s arrival');
select pg_temp.as_user('frank');
select ok(app.mark_dispatch_arrived('01920000-0000-7000-8000-00000000c004'::uuid) is not null, 'the responder records the arrival');
select is(app.mark_dispatch_arrived('01920000-0000-7000-8000-00000000c004'::uuid),
  (select arrived_at from app.dispatch_assignments where id = '01920000-0000-7000-8000-00000000c004'), 'a second call keeps the first arrival');

-- Allowlist and comment subjects -----------------------------------------------------------------------------------
select pg_temp.as_platform();
select is((select count(*)::int from private.sync_rpcs where rpc in ('app.record_scan', 'app.report_incident', 'app.add_incident_party',
  'app.add_incident_media', 'app.dispatch_responder', 'app.mark_dispatch_arrived', 'app.transition_incident')), 7, 'the field RPCs are on the sync allowlist');
select pg_temp.as_user('frank');
select is((select (app.apply_sync_mutation('01920000-0000-7000-8000-00000000c005'::uuid, pg_temp.id('org_a'), 'device-1', 'app.mark_dispatch_arrived',
  jsonb_build_object('p_dispatch_assignment_id', '01920000-0000-7000-8000-00000000c004')) ? 'data')), true, 'a device replays an arrival through the sync wrapper');
select pg_temp.as_platform();
select ok(exists (select 1 from app.domain_events where event_type = 'dispatch.arrived' and subject_id = pg_temp.id('inc')), 'the arrival emitted dispatch.arrived');

select * from finish();
rollback;
