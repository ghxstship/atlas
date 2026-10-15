-- pgTAP: show and schedule operations (0412). Cue project stamping, cue calls (capability, once,
-- stamped, emitted), realtime publication, baseline capture and lock (capability, refusal when
-- locked, never unlocks, Timeline marking, event), dependency events, sheet publication (capability,
-- once, stamped, emitted) and cross-tenant and anon denial on the RPCs.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(29);

create function pg_temp.new_record(p_project text, p_kind text, p_title text, p_subtype text default null) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id(p_project), p_kind, p_subtype, p_title, 'Y', 'Declared') returning id into v;
  return v;
end $$;

-- Cues carry their project -----------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date) values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Opening Night Running Order', '2027-06-05') returning id)
  insert into world select 'ros', id from x;
with x as (insert into app.cues (run_of_show_id, position, label, project_id) values (pg_temp.id('ros'), 1, 'House to Half', pg_temp.id('prj_a2')) returning id)
  insert into world select 'cue1', id from x;
with x as (insert into app.cues (run_of_show_id, position, label) values (pg_temp.id('ros'), 2, 'Walk-in Music Out') returning id)
  insert into world select 'cue2', id from x;
with x as (insert into app.cues (run_of_show_id, position, label) values (pg_temp.id('ros'), 3, 'Headliner On') returning id)
  insert into world select 'cue3', id from x;
select is((select project_id from app.cues where id = pg_temp.id('cue1')), pg_temp.id('prj_a'), 'a cue''s project is stamped from its running order, never taken from the caller');
select is((select count(*)::int from app.cues where project_id = pg_temp.id('prj_a')), 3, 'cues filter by project');
select ok(exists (select 1 from pg_catalog.pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'app' and tablename = 'cues')
  or not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime'), 'cues are in the realtime publication');
select ok(exists (select 1 from pg_catalog.pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'app' and tablename = 'run_of_show')
  or not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime'), 'running orders are in the realtime publication');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'run_of_show.created' and subject_id = pg_temp.id('ros')), 1, 'creating a running order emits run_of_show.created');

-- Calling cues -------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select ok(app.call_cue(pg_temp.id('cue1')) is not null, 'a project member with show.cue.call calls a cue');
select is((select called_by from app.cues where id = pg_temp.id('cue1')), pg_temp.id('dave'), 'the call is stamped with the caller');
select throws_ok($$select app.call_cue((select id from world where key = 'cue1'))$$, 'XR001', null, 'a cue is called once');
update app.cues set called_at = null where id = pg_temp.id('cue1');
select is((select called_at is not null from app.cues where id = pg_temp.id('cue1')), true, 'clearing a call leaves the stamp in place');
select pg_temp.as_user('gina');
select throws_ok($$select app.call_cue((select id from world where key = 'cue2'))$$, '42501', null, 'a Viewer cannot call a cue');
select pg_temp.as_user('xavier');
select throws_ok($$select app.call_cue((select id from world where key = 'cue2'))$$, '42501', null, 'another org cannot call the cue');
select pg_temp.as_anon();
select throws_ok($$select app.call_cue((select id from world where key = 'cue2'))$$, '42501', null, 'anon cannot call a cue');
select pg_temp.as_user('frank');
select lives_ok($$update app.cues set called_at = now() where id = (select id from world where key = 'cue2')$$, 'a Field project member with show.cue.call stamps a call directly');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'cue.called' and project_id = pg_temp.id('prj_a')), 2, 'each call emits cue.called with the project');

-- Baselines --------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into world values ('t1', pg_temp.new_record('prj_a', 'Task', 'Hang the main truss', 'Execute'));
insert into world values ('t2', pg_temp.new_record('prj_a', 'Task', 'Focus the wash lights', 'Execute'));
insert into world values ('undated', pg_temp.new_record('prj_a', 'Task', 'Label the cable runs', 'Execute'));
insert into world values ('window', pg_temp.new_record('prj_a', 'Timeline', 'Load-In Window', 'Show Cycle'));
insert into app.record_timeline (record_id) values (pg_temp.id('window'));
update app.records set starts_at = '2027-06-01 08:00+00', ends_at = '2027-06-01 18:00+00' where id = pg_temp.id('t1');
update app.records set due_at = '2027-06-02 12:00+00' where id = pg_temp.id('t2');
update app.records set starts_at = '2027-06-01 06:00+00', ends_at = '2027-06-03 06:00+00' where id = pg_temp.id('window');
with x as (insert into app.schedule_baselines (project_id, name) values (pg_temp.id('prj_a'), 'Gate 3 Baseline') returning id) insert into world select 'bl', id from x;
select pg_temp.as_user('dave');
select throws_ok($$select app.lock_baseline((select id from world where key = 'bl'))$$, '42501', null, 'a Member cannot lock a baseline');
select pg_temp.as_user('carol');
select is(app.lock_baseline(pg_temp.id('bl')), 3, 'locking captures every dated record of the project');
select ok((select locked_at is not null from app.schedule_baselines where id = pg_temp.id('bl')), 'the baseline is locked');
select is((select planned_ends_at from app.schedule_baseline_items where schedule_baseline_id = pg_temp.id('bl') and record_id = pg_temp.id('t2')),
  '2027-06-02 12:00+00'::timestamptz, 'a record with only a due time is planned at its due time');
select is((select count(*)::int from app.schedule_baseline_items where schedule_baseline_id = pg_temp.id('bl') and record_id = pg_temp.id('undated')), 0, 'undated records are not captured');
select ok((select baseline_locked_at is not null from app.record_timeline where record_id = pg_temp.id('window')), 'Timeline records in the baseline are marked locked');
select throws_ok($$select app.lock_baseline((select id from world where key = 'bl'))$$, 'XR001', null, 'a locked baseline cannot be locked again');
select throws_ok($$update app.schedule_baselines set locked_at = null where id = (select id from world where key = 'bl')$$, 'XR001', null, 'a locked baseline never unlocks');
select throws_ok($$update app.schedule_baselines set deleted_at = now() where id = (select id from world where key = 'bl')$$, 'XR001', null, 'a locked baseline is retained');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'schedule_baseline.locked' and subject_id = pg_temp.id('bl')), 1, 'locking emits schedule_baseline.locked');

-- Dependencies ------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.record_dependencies (predecessor_record_id, successor_record_id) values (pg_temp.id('t1'), pg_temp.id('t2'));
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'record_dependency.created' and subject_id = pg_temp.id('t2')), 1, 'a new dependency emits record_dependency.created on the successor');

-- Sheets ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.day_sheets (project_id, day, body) values (pg_temp.id('prj_a'), '2027-06-05', 'Doors 7 pm. Load-out after curfew.') returning id) insert into world select 'ds', id from x;
update app.day_sheets set published_at = '2000-01-01' where id = pg_temp.id('ds');
select ok((select published_at > '2020-01-01' from app.day_sheets where id = pg_temp.id('ds')), 'publishing stamps the database time');
update app.day_sheets set published_at = null where id = pg_temp.id('ds');
select ok((select published_at is not null from app.day_sheets where id = pg_temp.id('ds')), 'a published sheet stays published');
select pg_temp.as_user('erin');
with x as (insert into app.day_sheets (project_id, day, body) values (pg_temp.id('prj_a'), '2027-06-06', 'Rain plan in effect.') returning id) insert into world select 'ds2', id from x;
select throws_ok($$update app.day_sheets set published_at = now() where id = (select id from world where key = 'ds2')$$,
  'XR001', null, 'a Collaborator who edits day sheets cannot publish one');
select pg_temp.as_user('carol');
with x as (insert into app.call_sheets (project_id, day) values (pg_temp.id('prj_a'), '2027-06-05') returning id) insert into world select 'cs', id from x;
update app.call_sheets set published_at = now() where id = pg_temp.id('cs');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type in ('day_sheet.published', 'call_sheet.published') and project_id = pg_temp.id('prj_a')), 2, 'each publication is emitted once');

select * from finish();
rollback;
