-- pgTAP: 1780, bulk edit of projects, work orders, punch items and documents (A119, RRR-164, Section 11.7). For each
-- resource: a preview that changes nothing, a committed call with its inverse rows, one refused row undoing the whole
-- call with the refusal naming that row, another org refused, and the capability checked on every row.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(59);

create function pg_temp.bulk(p_resource text, p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language plpgsql as $$
begin
  return case p_resource
    when 'projects' then app.bulk_update_projects(p_rows, p_preview, p_reason)
    when 'work_orders' then app.bulk_update_work_orders(p_rows, p_preview, p_reason)
    when 'punch_items' then app.bulk_update_punch_items(p_rows, p_preview, p_reason)
    when 'documents' then app.bulk_update_documents(p_rows, p_preview, p_reason)
  end;
end $$;

/** The same set for every row named by its world key. */
create function pg_temp.rows(p_keys text[], p_set jsonb) returns jsonb
language sql as $$
  select jsonb_agg(jsonb_build_object('id', pg_temp.id(k), 'set', p_set)) from unnest(p_keys) k;
$$;

create temporary table answer (resource text primary key, r jsonb);
grant all on answer to public;

-- Fixtures ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.work_orders (project_id, title) values (pg_temp.id('prj_a'), 'Rig the Main Stage Truss') returning id)
  insert into world select 'wo1', id from x;
with x as (insert into app.work_orders (project_id, title) values (pg_temp.id('prj_a'), 'Install Barricade Line') returning id)
  insert into world select 'wo2', id from x;
insert into world values ('p1', app.create_punch_item(pg_temp.id('prj_a'), 'Loose handrail at stair B'));
insert into world values ('p2', app.create_punch_item(pg_temp.id('prj_a'), 'Scuffed dance floor panel'));
with x as (insert into app.documents (org_id, title) values (pg_temp.id('org_a'), 'Rigging Plot') returning id)
  insert into world select 'd1', id from x;
with x as (insert into app.documents (org_id, title) values (pg_temp.id('org_a'), 'Site Map') returning id)
  insert into world select 'd2', id from x;
select pg_temp.as_user('carol');
with x as (insert into app.work_orders (project_id, title) values (pg_temp.id('prj_a2'), 'Hang the Gala Drape') returning id)
  insert into world select 'wo3', id from x;
insert into world values ('p3', app.create_punch_item(pg_temp.id('prj_a2'), 'Chipped bar top'));
select pg_temp.as_user('xavier');
with x as (insert into app.documents (org_id, title) values (pg_temp.id('org_b'), 'Dock Stage Plot') returning id)
  insert into world select 'd3', id from x;
select pg_temp.as_platform();

-- Projects ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is(
  (select r ->> 'changed' from (select pg_temp.bulk('projects', pg_temp.rows(array['prj_a', 'prj_a2'], '{"archived_at": true}'), true) r) x),
  '2', 'a project preview counts the rows it would change');
select is((select count(*)::int from app.projects where id in (pg_temp.id('prj_a'), pg_temp.id('prj_a2')) and archived_at is not null), 0,
  'and archives nothing');

insert into answer select 'projects',
  pg_temp.bulk('projects', pg_temp.rows(array['prj_a', 'prj_a2'], '{"project_state": "Active"}'), false, 'Contracts signed.');
select is((select r ->> 'committed' from answer where resource = 'projects'), 'true', 'projects change state in bulk');
select is((select count(*)::int from app.projects where id in (pg_temp.id('prj_a'), pg_temp.id('prj_a2')) and project_state = 'Active'), 2,
  'both are Active');
select is((select count(*)::int from app.project_state_transitions where project_id = pg_temp.id('prj_a2') and reason = 'Contracts signed.'), 1,
  'through the project lifecycle, with the reason in its ledger');

select is(
  (select r ->> 'unchanged' from (select pg_temp.bulk('projects',
    pg_temp.rows(array['prj_a', 'prj_a2'], jsonb_build_object('venue_id', pg_temp.id('venue_a')))) r) x),
  '1', 'a project already at the venue counts as unchanged');
select is((select venue_id from app.projects where id = pg_temp.id('prj_a2')), pg_temp.id('venue_a'), 'and the other moves to it');

delete from answer;
insert into answer select 'projects', pg_temp.bulk('projects', pg_temp.rows(array['prj_a', 'prj_a2'], '{"archived_at": true}'));
select is((select count(*)::int from app.projects where id in (pg_temp.id('prj_a'), pg_temp.id('prj_a2')) and archived_at is not null), 2,
  'projects archive in bulk');
select isnt((select r -> 'inverse' -> 0 -> 'expect' ->> 'archived_at' from answer), null, 'the inverse expects the time they were archived');
select is(
  (select r ->> 'committed' from (select pg_temp.bulk('projects', (select r -> 'inverse' from answer)) r) x),
  'true', 'sending the inverse back restores them');
select is((select count(*)::int from app.projects where id in (pg_temp.id('prj_a'), pg_temp.id('prj_a2')) and archived_at is not null), 0,
  'both are live again');

select pg_temp.as_user('dave');
delete from answer;
insert into answer select 'projects', pg_temp.bulk('projects', pg_temp.rows(array['prj_a', 'prj_a2'], '{"venue_id": null}'));
select is((select r ->> 'committed' from answer), 'false', 'a call with a project the caller cannot reach commits nothing');
select is((select venue_id from app.projects where id = pg_temp.id('prj_a')), pg_temp.id('venue_a'), 'so the project they may edit is unchanged too');
select is((select r -> 'refused' -> 0 ->> 'id' from answer), pg_temp.id('prj_a2')::text, 'the refusal names the row');
select is((select r -> 'refused' -> 0 ->> 'rule' from answer), 'bulk_row_not_found', 'a project they are not on reads as not found (invariant 2)');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('projects', pg_temp.rows(array['prj_a'], '{"project_state": "Blocked"}')) r) x),
  'not_allowed', 'a project state change needs projects.settings.write, even on a project they edit');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('projects', pg_temp.rows(array['prj_a'], '{"archived_at": true}')) r) x),
  'not_allowed', 'and archiving needs projects.project.archive');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('projects', pg_temp.rows(array['prj_a'], '{"name": "Renamed"}')) r) x),
  'bulk_field_not_editable', 'only state, venue and archived change in bulk');
select pg_temp.as_user('xavier');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('projects', pg_temp.rows(array['prj_a'], '{"archived_at": true}')) r) x),
  'bulk_row_not_found', 'another org cannot change them');
select pg_temp.as_user('carol');
select is(
  (select r ->> 'committed' from (select pg_temp.bulk('projects', pg_temp.rows(array['prj_a'], jsonb_build_object('venue_id', pg_temp.id('venue_b')))) r) x),
  'false', 'a venue of another org is refused');

-- Work orders ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is(
  (select r ->> 'changed' from (select pg_temp.bulk('work_orders', pg_temp.rows(array['wo1', 'wo2'], '{"work_order_state": "Open"}'), true) r) x),
  '2', 'a work order preview counts the rows it would change');
select is((select count(*)::int from app.work_orders where id in (pg_temp.id('wo1'), pg_temp.id('wo2')) and work_order_state = 'Draft'), 2,
  'and moves nothing');
delete from answer;
insert into answer select 'work_orders',
  pg_temp.bulk('work_orders', pg_temp.rows(array['wo1', 'wo2'], '{"work_order_state": "Open"}'), false, 'Out for bids.');
select is((select r ->> 'committed' from answer), 'true', 'work orders open in bulk');
select is((select count(*)::int from app.work_order_state_transitions where work_order_id = pg_temp.id('wo2') and reason = 'Out for bids.'), 1,
  'through their lifecycle, with the reason');
select is((select r -> 'inverse' -> 0 -> 'set' ->> 'work_order_state' from answer), 'Draft', 'the inverse holds the state before');
select is(
  (select r ->> 'committed' from (select pg_temp.bulk('work_orders', (select r -> 'inverse' from answer)) r) x),
  'true', 'sending it back undoes the change');
select is((select count(*)::int from app.work_orders where id in (pg_temp.id('wo1'), pg_temp.id('wo2')) and work_order_state = 'Draft'), 2,
  'both are Draft again');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('work_orders', (select r -> 'inverse' from answer)) r) x),
  'bulk_stale', 'a second undo is refused, never silently applied');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('work_orders', pg_temp.rows(array['wo1'], '{"work_order_state": "Awarded"}')) r) x),
  'work_order_award_rpc_only', 'Awarded stays with the award');

delete from answer;
insert into answer select 'work_orders', pg_temp.bulk('work_orders', pg_temp.rows(array['wo1', 'wo3'], '{"work_order_state": "Canceled"}'), false, 'Scope cut.');
select is((select r ->> 'committed' from answer), 'false', 'a work order the caller cannot reach undoes the whole call');
select is((select work_order_state::text from app.work_orders where id = pg_temp.id('wo1')), 'Draft', 'so the reachable one stays Draft');
select is((select r -> 'refused' -> 0 ->> 'id' from answer), pg_temp.id('wo3')::text, 'the refusal names the row');
select pg_temp.as_user('gina');
select ok(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('work_orders', pg_temp.rows(array['wo1'], '{"work_order_state": "Open"}')) r) x)
    in ('not_allowed', 'bulk_row_not_found'), 'a Viewer cannot move them');
select pg_temp.as_user('xavier');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('work_orders', pg_temp.rows(array['wo1'], '{"work_order_state": "Open"}')) r) x),
  'bulk_row_not_found', 'another org cannot change them');

-- Punch items ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is(
  (select r ->> 'changed' from (select pg_temp.bulk('punch_items', pg_temp.rows(array['p1', 'p2'], jsonb_build_object('owner_party_id', pg_temp.id('erin'))), true) r) x),
  '2', 'a punch preview counts the items it would change');
select is((select count(*)::int from app.records r join app.punch_items i on i.record_id = r.id
  where i.id in (pg_temp.id('p1'), pg_temp.id('p2')) and r.owner_party_id is not null), 0, 'and changes no record');
delete from answer;
insert into answer select 'punch_items', pg_temp.bulk('punch_items', pg_temp.rows(array['p1', 'p2'], jsonb_build_object('owner_party_id', pg_temp.id('erin'))));
select is((select r ->> 'committed' from answer), 'true', 'punch items change owner in bulk');
select is((select count(*)::int from app.records r join app.punch_items i on i.record_id = r.id
  where i.id in (pg_temp.id('p1'), pg_temp.id('p2')) and r.owner_party_id = pg_temp.id('erin')), 2, 'on their Task records');
select is((select r -> 'inverse' -> 0 ->> 'id' from answer), pg_temp.id('p1')::text, 'the inverse names the punch item, not its record');
select is(
  (select r ->> 'committed' from (select pg_temp.bulk('punch_items', (select r -> 'inverse' from answer)) r) x),
  'true', 'and sending it back undoes the change');
select is((select count(*)::int from app.records r join app.punch_items i on i.record_id = r.id
  where i.id in (pg_temp.id('p1'), pg_temp.id('p2')) and r.owner_party_id is null), 2, 'both are unowned again');
select is(
  (select r ->> 'changed' from (select pg_temp.bulk('punch_items', pg_temp.rows(array['p1', 'p2'], '{"record_state": "Ready"}'), false, 'Ready to fix.') r) x),
  '2', 'punch items move through the record lifecycle in bulk');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('punch_items', pg_temp.rows(array['p1'], '{"phase_code": "SCP"}')) r) x),
  'bulk_field_not_editable', 'only state, owner and due time change in bulk');

delete from answer;
insert into answer select 'punch_items', pg_temp.bulk('punch_items', pg_temp.rows(array['p1', 'p3'], jsonb_build_object('owner_party_id', pg_temp.id('dave'))));
select is((select r ->> 'committed' from answer), 'false', 'a punch item the caller cannot reach undoes the whole call');
select is((select r.owner_party_id from app.records r join app.punch_items i on i.record_id = r.id where i.id = pg_temp.id('p1')), null,
  'so the reachable one is unchanged');
select is((select r -> 'refused' -> 0 ->> 'id' from answer), pg_temp.id('p3')::text, 'the refusal names the row');
select pg_temp.as_user('gina');
select ok(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('punch_items', pg_temp.rows(array['p1'], '{"record_state": "Proposed"}')) r) x)
    in ('not_allowed', 'bulk_row_not_found'), 'a Viewer cannot change them');
select pg_temp.as_user('xavier');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('punch_items', pg_temp.rows(array['p1'], '{"record_state": "Proposed"}')) r) x),
  'bulk_row_not_found', 'another org cannot change them');

-- Documents -----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is(
  (select r ->> 'changed' from (select pg_temp.bulk('documents', pg_temp.rows(array['d1', 'd2'], jsonb_build_object('project_id', pg_temp.id('prj_a'))), true) r) x),
  '2', 'a document preview counts the documents it would move');
select is((select count(*)::int from app.documents where id in (pg_temp.id('d1'), pg_temp.id('d2')) and project_id is null), 2, 'and moves nothing');
delete from answer;
insert into answer select 'documents', pg_temp.bulk('documents', pg_temp.rows(array['d1', 'd2'], jsonb_build_object('project_id', pg_temp.id('prj_a'))));
select is((select count(*)::int from app.documents where id in (pg_temp.id('d1'), pg_temp.id('d2')) and project_id = pg_temp.id('prj_a')), 2,
  'documents move to a project in bulk');
select is(
  (select r ->> 'committed' from (select pg_temp.bulk('documents', (select r -> 'inverse' from answer)) r) x),
  'true', 'and the inverse makes them org-wide again');

delete from answer;
insert into answer select 'documents', pg_temp.bulk('documents', pg_temp.rows(array['d1', 'd3'], jsonb_build_object('project_id', pg_temp.id('prj_a'))));
select is((select r ->> 'committed' from answer), 'false', 'a document of another org undoes the whole call');
select is((select project_id from app.documents where id = pg_temp.id('d1')), null, 'so the other stays org-wide');
select is((select r -> 'refused' -> 0 ->> 'id' from answer), pg_temp.id('d3')::text, 'the refusal names the row');
select pg_temp.as_user('carol');
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('documents', pg_temp.rows(array['d1'], jsonb_build_object('project_id', pg_temp.id('prj_b')))) r) x),
  'not_allowed', 'a document never moves to another org''s project');
select pg_temp.as_user('frank');
select ok(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.bulk('documents', pg_temp.rows(array['d1'], jsonb_build_object('project_id', pg_temp.id('prj_a')))) r) x)
    in ('not_allowed', 'bulk_row_not_found'), 'a person without knowledge.document.write cannot move it');

-- Audit -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select ok((select count(*) from app.audit_events where action = 'projects.bulk_update' and org_id = pg_temp.id('org_a')) >= 3,
  'each committed project call writes one projects.bulk_update event');
select ok((select count(*) from app.audit_events where action = 'work_orders.update' and subject_id = pg_temp.id('wo1')) >= 2,
  'and work order changes reach the ledger through their new audit trail');

select * from finish();
rollback;
