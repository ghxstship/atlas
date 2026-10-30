-- pgTAP: bulk edit of record windows and cue times (2852, P8). Records take starts_at and ends_at in bulk, log a replan
-- from Scheduled onward, keep a window locked into a baseline, and undo a shift through their inverse rows with
-- compare-and-set; cues shift by minutes in one transaction, a called cue refuses the whole change, a preview changes
-- nothing, the inverse rows restore the times, the audit trail records each change, and readers, other orgs and anon
-- are refused.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(23);

create function pg_temp.new_record(p_project text, p_kind text, p_title text, p_subtype text default null) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id(p_project), p_kind, p_subtype, p_title, 'Y', 'Declared') returning id into v;
  return v;
end $$;

create temporary table answer (key text primary key, body jsonb);
grant select, insert, delete on answer to public;

select is((select row_function from private.bulk_resources where resource = 'cues'), 'private.bulk_cues_row',
  'cues change in bulk through 1451''s driver');

-- Records: windows in bulk, and the undo of a shift ----------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into world values ('a', pg_temp.new_record('prj_a', 'Task', 'Rig the delay speakers', 'Execute'));
insert into world values ('b', pg_temp.new_record('prj_a', 'Task', 'Time-align the delays', 'Execute'));
update app.records set starts_at = '2027-06-01 12:00+00', ends_at = '2027-06-01 14:00+00' where id = pg_temp.id('a');
update app.records set starts_at = '2027-06-01 14:00+00', ends_at = '2027-06-01 15:00+00' where id = pg_temp.id('b');
insert into app.record_dependencies (predecessor_record_id, successor_record_id) values (pg_temp.id('a'), pg_temp.id('b'));

select pg_temp.as_platform();
create temporary table moves (record_id uuid, is_target boolean, shift_start_days integer, shift_end_days integer,
  old_starts_at timestamptz, old_ends_at timestamptz, old_due_at timestamptz, starts_at timestamptz, ends_at timestamptz,
  due_at timestamptz, baseline_starts_at timestamptz, baseline_ends_at timestamptz, shift_start_minutes integer,
  shift_end_minutes integer, project_id uuid);
grant select, insert on moves to public;
select pg_temp.as_user('carol');
insert into moves select * from app.shift_records(array[pg_temp.id('a')], 30, true);
select is((select count(*)::int from moves), 2, 'the shift moved the record and pushed its successor');

insert into answer values ('undo_preview', app.bulk_update_records(
  (select jsonb_agg(jsonb_build_object('id', m.record_id,
    'set', jsonb_build_object('starts_at', m.old_starts_at, 'ends_at', m.old_ends_at, 'due_at', m.old_due_at),
    'expect', jsonb_build_object('starts_at', m.starts_at, 'ends_at', m.ends_at, 'due_at', m.due_at))) from moves m), true));
select is((select (body ->> 'changed')::int from answer where key = 'undo_preview'), 2, 'the undo previews both rows');
select is((select starts_at from app.records where id = pg_temp.id('b')), '2027-06-01 14:30+00'::timestamptz, 'and changes nothing');

-- Someone else moves B, so the undo is stale and nothing is undone.
update app.records set ends_at = '2027-06-01 16:00+00' where id = pg_temp.id('b');
insert into answer values ('stale', app.bulk_update_records(
  (select jsonb_agg(jsonb_build_object('id', m.record_id,
    'set', jsonb_build_object('starts_at', m.old_starts_at, 'ends_at', m.old_ends_at, 'due_at', m.old_due_at),
    'expect', jsonb_build_object('starts_at', m.starts_at, 'ends_at', m.ends_at, 'due_at', m.due_at))) from moves m)));
select is((select body #>> '{refused,0,rule}' from answer where key = 'stale'), 'bulk_stale', 'an undo after someone else''s change is stale');
select is((select starts_at from app.records where id = pg_temp.id('a')), '2027-06-01 12:30+00'::timestamptz, 'and undoes nothing');
update app.records set ends_at = '2027-06-01 15:30+00' where id = pg_temp.id('b');
insert into answer values ('undo', app.bulk_update_records(
  (select jsonb_agg(jsonb_build_object('id', m.record_id,
    'set', jsonb_build_object('starts_at', m.old_starts_at, 'ends_at', m.old_ends_at, 'due_at', m.old_due_at),
    'expect', jsonb_build_object('starts_at', m.starts_at, 'ends_at', m.ends_at, 'due_at', m.due_at))) from moves m)));
select is((select (body ->> 'committed')::boolean from answer where key = 'undo'), true, 'the undo applies');
select results_eq($$select id, starts_at, ends_at from app.records where id in (select record_id from moves) order by id$$,
  $$select record_id, old_starts_at, old_ends_at from moves order by record_id$$, 'every moved record is back where it was');

-- A date change from Scheduled onward is a replan; a locked window keeps its start and end.
select app.transition_record(pg_temp.id('a'), 'Proposed', 'Ready', 'Planned.');
select app.transition_record(pg_temp.id('a'), 'Ready', 'Scheduled', 'On the schedule.');
select is((select (app.bulk_update_records(jsonb_build_array(jsonb_build_object('id', pg_temp.id('a'),
  'set', jsonb_build_object('starts_at', '2027-06-02 12:00+00', 'ends_at', '2027-06-02 14:00+00'))), false, 'Delays arrive a day late.') ->> 'changed')::int), 1,
  'a scheduled record''s window changes in bulk');
select is((select replan_reason from app.records where id = pg_temp.id('a')), 'Delays arrive a day late.', 'and the change is logged as a replan');
insert into world values ('window', pg_temp.new_record('prj_a', 'Timeline', 'Delay Tower Window', 'Show Cycle'));
insert into app.record_timeline (record_id) values (pg_temp.id('window'));
update app.records set starts_at = '2027-06-20 12:00+00', ends_at = '2027-06-22 22:00+00' where id = pg_temp.id('window');
with x as (insert into app.schedule_baselines (project_id, name) values (pg_temp.id('prj_a'), 'Delay Baseline') returning id) insert into world select 'bl', id from x;
select ok(app.lock_baseline(pg_temp.id('bl')) > 0, 'a baseline locks the window');
select is((select app.bulk_update_records(jsonb_build_array(jsonb_build_object('id', pg_temp.id('window'),
  'set', jsonb_build_object('starts_at', '2027-06-21 12:00+00')))) #>> '{refused,0,rule}'), 'reschedule_locked',
  'a window locked into a baseline keeps its start in bulk too');

-- Cues -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date) values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Opening Night Running Order', '2027-06-05') returning id) insert into world select 'ros', id from x;
insert into app.cues (run_of_show_id, position, label, planned_at) values
  (pg_temp.id('ros'), 1, 'Walk-in music', '2027-06-05 23:00+00'),
  (pg_temp.id('ros'), 2, 'House to half', '2027-06-05 23:30+00'),
  (pg_temp.id('ros'), 3, 'Band on', '2027-06-05 23:35+00'),
  (pg_temp.id('ros'), 4, 'Doors', '2027-06-05 22:00+00');
insert into world select 'cue' || position, id from app.cues where run_of_show_id = pg_temp.id('ros');

insert into answer values ('cue_preview', app.bulk_update_cues(
  (select jsonb_agg(jsonb_build_object('id', pg_temp.id(k), 'set', jsonb_build_object('shift_minutes', -10))) from unnest(array['cue1', 'cue2', 'cue3']) k), true));
select is((select (body ->> 'changed')::int from answer where key = 'cue_preview'), 3, 'a preview counts the three cues that would move');
select is((select planned_at from app.cues where id = pg_temp.id('cue1')), '2027-06-05 23:00+00'::timestamptz, 'and moves none');

insert into answer values ('cue_shift', app.bulk_update_cues(
  (select jsonb_agg(jsonb_build_object('id', pg_temp.id(k), 'set', jsonb_build_object('shift_minutes', -10))) from unnest(array['cue1', 'cue2', 'cue3']) k)));
select is((select string_agg(to_char(planned_at at time zone 'UTC', 'HH24:MI'), ',' order by position) from app.cues where run_of_show_id = pg_temp.id('ros') and position <= 3),
  '22:50,23:20,23:25', 'the three cues move 10 minutes earlier in one transaction');
select pg_temp.as_platform();
select is((select count(*)::int from app.audit_events where action = 'cues.update' and subject_id = pg_temp.id('cue1')), 1,
  'the change of each cue lands in its audit trail');
select pg_temp.as_user('dave');

insert into answer values ('cue_undo', app.bulk_update_cues((select body -> 'inverse' from answer where key = 'cue_shift')));
select is((select string_agg(to_char(planned_at at time zone 'UTC', 'HH24:MI'), ',' order by position) from app.cues where run_of_show_id = pg_temp.id('ros') and position <= 3),
  '23:00,23:30,23:35', 'the inverse rows restore the planned times');

update app.cues set called_at = now() where id = pg_temp.id('cue4');
insert into answer values ('cue_called', app.bulk_update_cues(
  (select jsonb_agg(jsonb_build_object('id', pg_temp.id(k), 'set', jsonb_build_object('shift_minutes', 5))) from unnest(array['cue1', 'cue4']) k)));
select is((select (body #>> '{refused,0,rule}') || ' ' || (body ->> 'committed') from answer where key = 'cue_called'), 'cue_called false',
  'a called cue in the selection refuses the change');
select is((select planned_at from app.cues where id = pg_temp.id('cue1')), '2027-06-05 23:00+00'::timestamptz, 'and nothing changes');
select is((select app.bulk_update_cues(jsonb_build_array(jsonb_build_object('id', pg_temp.id('cue1'),
  'set', jsonb_build_object('shift_minutes', 5, 'planned_at', '2027-06-05 23:00+00')))) #>> '{refused,0,rule}'), 'bulk_shape',
  'a row either shifts or sets the time');

-- Who may shift cues.
select pg_temp.as_platform();
insert into app.project_members (project_id, membership_id, project_role) values (pg_temp.id('prj_a'), pg_temp.id('gina@org_a'), 'Field');
select pg_temp.as_user('gina');
select is((select app.bulk_update_cues(jsonb_build_array(jsonb_build_object('id', pg_temp.id('cue1'), 'set', jsonb_build_object('shift_minutes', 5)))) #>> '{refused,0,rule}'),
  'not_allowed', 'a Viewer on the project reads the running order but cannot shift it');
select pg_temp.as_user('xavier');
select is((select app.bulk_update_cues(jsonb_build_array(jsonb_build_object('id', pg_temp.id('cue1'), 'set', jsonb_build_object('shift_minutes', 5)))) #>> '{refused,0,rule}'),
  'bulk_row_not_found', 'another org does not see the cue');
select pg_temp.as_anon();
select throws_ok($$select app.bulk_update_cues('[]'::jsonb)$$, '42501', null, 'anon cannot shift cues');

select * from finish();
rollback;
