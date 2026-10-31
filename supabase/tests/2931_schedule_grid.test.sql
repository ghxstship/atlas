-- pgTAP: the schedule grid (2931, B4 G-41). The day grid creates and updates records in one call, as quick add creates
-- them; its preview writes nothing and returns what the commit writes; stale, grammar and baseline-locked rows are
-- refused in place and nothing of that save is written; 200 rows at most. The cue grid reorders, adds and retimes
-- uncalled cues densely, keeps called cues and the places before them, and lists every cue. Capability denial.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(28);

create function pg_temp.new_record(p_kind text, p_title text, p_subtype text default null) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), p_kind, p_subtype, p_title, 'Y', 'Declared') returning id into v;
  return v;
end $$;

create temporary table grid (row_index integer, record_id uuid, action text, refusal_code text, refusal_message text);
grant select, insert, delete on grid to public;

select has_function('app', 'save_day_grid', array['uuid', 'date', 'jsonb', 'boolean'], 'app.save_day_grid exists');
select has_function('app', 'save_cue_grid', array['uuid', 'jsonb', 'boolean'], 'app.save_cue_grid exists');

-- The day grid ------------------------------------------------------------------------------------------------------------
-- Northwind Summer Series (America/New_York) on 2027-06-01 holds one task, rigging the follow spots from 08:00 local.
select pg_temp.as_user('carol');
insert into world values ('rig', pg_temp.new_record('Task', 'Rig the follow spots', 'Execute'));
update app.records set starts_at = '2027-06-01 12:00+00', ends_at = '2027-06-01 14:00+00' where id = pg_temp.id('rig');

create function pg_temp.rows() returns jsonb language sql stable as $$
  select jsonb_build_array(
    jsonb_build_object('title', 'Focus the follow spots', 'record_kind', 'Task',
      'starts_at', '2027-06-01T14:00:00-04:00', 'ends_at', '2027-06-01T16:00:00-04:00'),
    jsonb_build_object('title', 'Doors Open', 'record_kind', 'Milestone', 'due_at', '2027-06-01T19:00:00-04:00'),
    jsonb_build_object('title', 'Sweep the stage', 'record_kind', 'Task',
      'starts_at', '2027-06-01T22:30:00-04:00', 'ends_at', '2027-06-02T00:30:00-04:00', 'start_tbc', true),
    jsonb_build_object('id', (select id from world where key = 'rig'), 'title', 'Rig the follow spots',
      'starts_at', '2027-06-01T09:00:00-04:00', 'ends_at', '2027-06-01T11:00:00-04:00',
      'expect', jsonb_build_object('title', 'Rig the follow spots', 'starts_at', '2027-06-01T12:00:00+00:00')))
$$;

insert into grid select * from app.save_day_grid(pg_temp.id('prj_a'), '2027-06-01', pg_temp.rows());
select is((select string_agg(action, ',' order by row_index) from grid), 'create,create,create,update',
  'the preview lists the three new rows and the edited one');
select is((select count(*)::int from app.records where project_id = pg_temp.id('prj_a') and deleted_at is null), 1,
  'the preview writes nothing');
select is((select starts_at from app.records where id = pg_temp.id('rig')), '2027-06-01 12:00+00'::timestamptz,
  'the edited row keeps its times after a preview');

delete from grid;
insert into grid select * from app.save_day_grid(pg_temp.id('prj_a'), '2027-06-01', pg_temp.rows(), true);
select is((select string_agg(action, ',' order by row_index) from grid), 'create,create,create,update',
  'the commit returns the same actions as the preview');
select is((select count(*)::int from app.records where project_id = pg_temp.id('prj_a') and deleted_at is null), 4,
  'the commit creates exactly the three new records');
select is((select starts_at from app.records where id = pg_temp.id('rig')), '2027-06-01 13:00+00'::timestamptz,
  'and moves the edited one to 09:00 local');
select is((select row(xyz, xyz_basis, time_zone, scope_node_id = pg_temp.id('root_a'))::text from app.records
           where id = (select record_id from grid where row_index = 1)),
  row('Y', 'Declared', 'America/New_York', true)::text,
  'a new row is created as quick add creates one: Y for a non-Time kind, Declared, the project zone, under the Engagement Root');
select is((select xyz::text from app.records r join xpms.dim_record_kind k on k.record_kind = r.record_kind
           where r.id = (select record_id from grid where row_index = 2)), 'Z',
  'a Milestone, a kind of the Time class, is tagged Z');
select ok((select start_tbc and ends_at = '2027-06-02 04:30+00' from app.records where id = (select record_id from grid where row_index = 3)),
  'a window past midnight and TBC are kept');

-- Refusals in place, nothing written.
delete from grid;
insert into grid select * from app.save_day_grid(pg_temp.id('prj_a'), '2027-06-01', jsonb_build_array(
  jsonb_build_object('title', 'Coil the cables', 'record_kind', 'Task', 'due_at', '2027-06-01T20:00:00-04:00'),
  jsonb_build_object('title', 'Installing the truss', 'record_kind', 'Task', 'due_at', '2027-06-01T20:00:00-04:00'),
  jsonb_build_object('id', (select id from world where key = 'rig'), 'title', 'Rig both follow spots',
    'expect', jsonb_build_object('title', 'Rig a follow spot'))), true);
select is((select string_agg(coalesce(refusal_code, action), ',' order by row_index) from grid),
  'create,record_title_grammar,bulk_stale', 'a grammar refusal and a stale row come back on their rows');
select ok((select refusal_message from grid where row_index = 2) like 'A Task title starts with an imperative verb%',
  'the grammar refusal carries the correction');
select is((select count(*)::int from app.records where title = 'Coil the cables'), 0,
  'with a refused row, no row of that save is written');

-- A window locked into a baseline keeps its start and end.
insert into world values ('window', pg_temp.new_record('Timeline', 'Load-In Window', 'Show Cycle'));
insert into app.record_timeline (record_id) values (pg_temp.id('window'));
update app.records set starts_at = '2027-06-01 10:00+00', ends_at = '2027-06-01 20:00+00' where id = pg_temp.id('window');
select pg_temp.as_platform();
update app.record_timeline set baseline_locked_at = now() where record_id = pg_temp.id('window');
select pg_temp.as_user('carol');
select is((select refusal_code from app.save_day_grid(pg_temp.id('prj_a'), '2027-06-01', jsonb_build_array(
  jsonb_build_object('id', (select id from world where key = 'window'), 'starts_at', '2027-06-01T07:00:00-04:00')), true)),
  'reschedule_locked', 'a baseline-locked window is refused through the grid');

select throws_ok(format('select * from app.save_day_grid(%L, %L, %L)', pg_temp.id('prj_a'), '2027-06-01',
  (select jsonb_agg(jsonb_build_object('title', 'Coil the cables', 'record_kind', 'Task')) from generate_series(1, 201))),
  'XR001', 'grid_too_large: A grid saves at most 200 rows at a time.', 'more than 200 rows are refused');

select pg_temp.as_user('frank');
select lives_ok(format('select * from app.save_day_grid(%L, %L, %L)', pg_temp.id('prj_a'), '2027-06-01',
  jsonb_build_array(jsonb_build_object('title', 'Coil the cables', 'record_kind', 'Task'))),
  'a project member with schedule.timeline.write previews the grid');
select pg_temp.as_user('xavier');
select throws_ok(format('select * from app.save_day_grid(%L, %L, %L)', pg_temp.id('prj_a'), '2027-06-01',
  jsonb_build_array(jsonb_build_object('title', 'Coil the cables', 'record_kind', 'Task'))),
  '42501', null, 'another org cannot save the grid');

-- The cue grid ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date)
  values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Opening Night Running Order', '2027-06-05') returning id)
  insert into world select 'ros', id from x;
insert into app.cues (run_of_show_id, position, label, planned_at)
select pg_temp.id('ros'), v.p, v.label, '2027-06-05 23:00+00'::timestamptz + make_interval(mins => v.p * 5)
from (values (1, 'House to Half'), (2, 'Walk-in Music Out'), (3, 'Host Welcome'), (4, 'Award One'), (5, 'Headliner On')) v (p, label);
insert into world select 'q' || c.position, c.id from app.cues c where c.run_of_show_id = pg_temp.id('ros');
select app.call_cue(pg_temp.id('q1'));

-- Reorder 4 before 3, retime 5, and add an encore at the end.
delete from grid;
insert into grid select * from app.save_cue_grid(pg_temp.id('ros'), jsonb_build_array(
  jsonb_build_object('id', (select id from world where key = 'q1')),
  jsonb_build_object('id', (select id from world where key = 'q2')),
  jsonb_build_object('id', (select id from world where key = 'q4')),
  jsonb_build_object('id', (select id from world where key = 'q3')),
  jsonb_build_object('id', (select id from world where key = 'q5'), 'planned_at', '2027-06-05T23:40:00+00:00',
    'duration_minutes', 45),
  jsonb_build_object('label', 'Encore', 'planned_at', '2027-06-06T00:30:00+00:00', 'segment', 'Act II')), true);
select is((select string_agg(action, ',' order by row_index) from grid), 'unchanged,unchanged,move,move,update,create',
  'the cue grid reports moves, edits and the new cue');
select is((select string_agg(label, ',' order by position) from app.cues where run_of_show_id = pg_temp.id('ros') and deleted_at is null),
  'House to Half,Walk-in Music Out,Award One,Host Welcome,Headliner On,Encore', 'the running order follows the grid');
select is((select array_agg(position order by position) from app.cues where run_of_show_id = pg_temp.id('ros') and deleted_at is null),
  array[1, 2, 3, 4, 5, 6], 'positions are dense');
select is((select duration from app.cues where id = pg_temp.id('q5')), interval '45 minutes', 'minutes become the cue''s length');

select is((select refusal_code from app.save_cue_grid(pg_temp.id('ros'), jsonb_build_array(
  jsonb_build_object('id', (select id from world where key = 'q1'), 'label', 'House Out'),
  jsonb_build_object('id', (select id from world where key = 'q2')),
  jsonb_build_object('id', (select id from world where key = 'q4')),
  jsonb_build_object('id', (select id from world where key = 'q3')),
  jsonb_build_object('id', (select id from world where key = 'q5')),
  jsonb_build_object('id', (select c.id from app.cues c where c.run_of_show_id = (select id from world where key = 'ros') and c.label = 'Encore')))
  ) where row_index = 1), 'cue_called', 'a change to a called cue is refused');
select is((select refusal_code from app.save_cue_grid(pg_temp.id('ros'), jsonb_build_array(
  jsonb_build_object('label', 'Preshow Announcement'),
  jsonb_build_object('id', (select id from world where key = 'q1')),
  jsonb_build_object('id', (select id from world where key = 'q2')),
  jsonb_build_object('id', (select id from world where key = 'q4')),
  jsonb_build_object('id', (select id from world where key = 'q3')),
  jsonb_build_object('id', (select id from world where key = 'q5')),
  jsonb_build_object('id', (select c.id from app.cues c where c.run_of_show_id = (select id from world where key = 'ros') and c.label = 'Encore')))
  ) where row_index = 1), 'cue_move_before_called', 'nothing moves to or before the last called cue');
select throws_ok(format('select * from app.save_cue_grid(%L, %L)', pg_temp.id('ros'),
  jsonb_build_array(jsonb_build_object('id', pg_temp.id('q1')))),
  'XR001', null, 'a grid that leaves out a live cue is refused (grid_incomplete); the grid never deletes a cue');
select is((select count(*)::int from app.cues where run_of_show_id = pg_temp.id('ros') and deleted_at is null), 6,
  'refused saves change nothing');

select pg_temp.as_user('alice');
insert into app.project_members (project_id, membership_id, project_role) values (pg_temp.id('prj_a'), pg_temp.id('gina@org_a'), 'Field');
select pg_temp.as_user('gina');
select throws_ok(format('select * from app.save_cue_grid(%L, %L)', pg_temp.id('ros'),
  jsonb_build_array(jsonb_build_object('id', pg_temp.id('q1')))),
  '42501', null, 'a reader of the run of show cannot save its grid');
select pg_temp.as_user('xavier');
select throws_ok(format('select * from app.save_cue_grid(%L, %L)', pg_temp.id('ros'),
  jsonb_build_array(jsonb_build_object('id', pg_temp.id('q1')))),
  '42501', null, 'another org cannot save the cue grid');

select * from finish();
rollback;
