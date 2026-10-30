-- pgTAP: timeline reschedule (2260, A133). Moving and resizing by whole days on the project's wall clock, successors
-- pushed through the chain by the days their dependency needs (every dependency type, lag, a gap broken before the
-- change kept), nothing pulled earlier, preview equal to commit and writing nothing, cycles, locked windows, canceled
-- records, bad windows, one-date resizes and undated records refused, the latest baseline window returned, one-date records pushed
-- by the instants they hold, a schedule whose chains split and rejoin previewed quickly, and capability, cross-tenant
-- and anon denial. P8 (2850) adds trailing minute offsets and two trailing columns; the assertions are A133's.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(35);

create function pg_temp.new_record(p_project text, p_kind text, p_title text, p_subtype text default null) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id(p_project), p_kind, p_subtype, p_title, 'Y', 'Declared') returning id into v;
  return v;
end $$;

select pg_temp.as_platform();
create temporary table preview_rows (record_id uuid, is_target boolean, shift_start_days integer, shift_end_days integer,
  old_starts_at timestamptz, old_ends_at timestamptz, old_due_at timestamptz, starts_at timestamptz, ends_at timestamptz,
  due_at timestamptz, baseline_starts_at timestamptz, baseline_ends_at timestamptz, shift_start_minutes integer,
  shift_end_minutes integer);
grant select, insert, delete on preview_rows to public;
create temporary table fan (phase integer, slot integer, id uuid);
create temporary table fan_moves (like preview_rows);
grant select, insert on fan, fan_moves to public;

select has_function('app', 'reschedule_record', array['uuid', 'integer', 'integer', 'boolean', 'text', 'integer', 'integer'], 'app.reschedule_record exists');
select is((select prosecdef from pg_catalog.pg_proc where oid = 'app.reschedule_record(uuid, integer, integer, boolean, text, integer, integer)'::regprocedure),
  true, 'app.reschedule_record is security definer');
select is(private.add_local_days('2027-11-06 14:00+00', 1, 'America/New_York'), '2027-11-07 15:00+00'::timestamptz,
  'a day on the project''s calendar keeps the wall-clock time across the end of daylight saving');

-- A chain on Northwind Summer Series (America/New_York): A then B then C, each Finish to Start.
select pg_temp.as_user('carol');
insert into world values ('a', pg_temp.new_record('prj_a', 'Task', 'Hang the main truss', 'Execute'));
insert into world values ('b', pg_temp.new_record('prj_a', 'Task', 'Focus the wash lights', 'Execute'));
insert into world values ('c', pg_temp.new_record('prj_a', 'Task', 'Program the cue stack', 'Execute'));
update app.records set starts_at = '2027-06-01 12:00+00', ends_at = '2027-06-01 22:00+00' where id = pg_temp.id('a');
update app.records set starts_at = '2027-06-02 12:00+00', ends_at = '2027-06-03 22:00+00' where id = pg_temp.id('b');
update app.records set starts_at = '2027-06-04 12:00+00', ends_at = '2027-06-04 22:00+00' where id = pg_temp.id('c');
insert into app.record_dependencies (predecessor_record_id, successor_record_id) values
  (pg_temp.id('a'), pg_temp.id('b')), (pg_temp.id('b'), pg_temp.id('c'));

insert into preview_rows select * from app.reschedule_record(pg_temp.id('a'), 1, 1);
select is((select count(*)::int from preview_rows), 3, 'moving A a day later moves A and pushes B and C');
select is((select shift_start_days from preview_rows where record_id = pg_temp.id('c')), 1, 'C is pushed through B by one day');
select is((select starts_at from preview_rows where record_id = pg_temp.id('b')), '2027-06-03 12:00+00'::timestamptz,
  'B keeps its wall-clock start, a day later');
select is((select starts_at from app.records where id = pg_temp.id('a')), '2027-06-01 12:00+00'::timestamptz, 'a preview writes nothing');
select is((select count(*)::int from preview_rows where is_target), 1, 'the preview marks the moved record');

select results_eq(
  $$select record_id, is_target, shift_start_days, shift_end_days, starts_at, ends_at, due_at
    from app.reschedule_record((select id from world where key = 'a'), 1, 1, true) order by record_id$$,
  $$select record_id, is_target, shift_start_days, shift_end_days, starts_at, ends_at, due_at from preview_rows order by record_id$$,
  'commit moves exactly the rows the preview showed');
select results_eq(
  $$select r.id, r.starts_at, r.ends_at from app.records r where r.id in (select record_id from preview_rows) order by r.id$$,
  $$select record_id, starts_at, ends_at from preview_rows order by record_id$$,
  'the records hold the previewed dates after the commit');

select is((select count(*)::int from app.reschedule_record(pg_temp.id('a'), -1, -1)), 1, 'moving A earlier pulls no successor');
select is((select count(*)::int from app.reschedule_record(pg_temp.id('b'), 0, 0)), 1, 'a change of nothing moves nothing else');

-- Resizing the end of B pushes C by the days B now overlaps it.
delete from preview_rows;
insert into preview_rows select * from app.reschedule_record(pg_temp.id('b'), 0, 2);
select is((select ends_at from preview_rows where record_id = pg_temp.id('b')), '2027-06-06 22:00+00'::timestamptz, 'resizing moves only the end');
select is((select shift_start_days from preview_rows where record_id = pg_temp.id('c')), 2, 'resizing B two days pushes C two days');
select is((select count(*)::int from preview_rows where record_id = pg_temp.id('a')), 0, 'a predecessor never moves');

-- Start to Start with a day of lag, and a dependency already broken before the change.
insert into world values ('d', pg_temp.new_record('prj_a', 'Task', 'Rig the delay towers', 'Execute'));
update app.records set starts_at = '2027-06-03 12:00+00', ends_at = '2027-06-03 22:00+00' where id = pg_temp.id('d');
insert into app.record_dependencies (predecessor_record_id, successor_record_id, dependency_type, lag)
values (pg_temp.id('a'), pg_temp.id('d'), 'Start to Start', '1 day');
select is((select shift_start_days from app.reschedule_record(pg_temp.id('a'), 1, 1) where record_id = pg_temp.id('d')), 1,
  'Start to Start with a day of lag pushes the successor a day');
insert into world values ('f', pg_temp.new_record('prj_a', 'Task', 'Fly the line array', 'Execute'));
insert into world values ('g', pg_temp.new_record('prj_a', 'Task', 'Tune the system', 'Execute'));
update app.records set starts_at = '2027-06-10 12:00+00', ends_at = '2027-06-10 22:00+00' where id = pg_temp.id('f');
update app.records set starts_at = '2027-06-10 20:00+00', ends_at = '2027-06-10 23:00+00' where id = pg_temp.id('g');
insert into app.record_dependencies (predecessor_record_id, successor_record_id) values (pg_temp.id('f'), pg_temp.id('g'));
select is((select shift_start_days from app.reschedule_record(pg_temp.id('f'), 1, 1) where record_id = pg_temp.id('g')), 1,
  'a gap broken before the change is kept: only the day the change adds is pushed');
insert into world values ('h', pg_temp.new_record('prj_a', 'Task', 'Hang the soft goods', 'Execute'));
update app.records set starts_at = '2027-06-11 12:00+00', ends_at = '2027-06-11 22:00+00' where id = pg_temp.id('h');
insert into app.record_dependencies (predecessor_record_id, successor_record_id, dependency_type)
values (pg_temp.id('f'), pg_temp.id('h'), 'Finish to Finish');
select is((select count(*)::int from app.reschedule_record(pg_temp.id('f'), 0, 1) where record_id = pg_temp.id('h')), 0,
  'Finish to Finish leaves a successor that still finishes after');
select is((select shift_end_days from app.reschedule_record(pg_temp.id('f'), 0, 2) where record_id = pg_temp.id('h')), 1,
  'Finish to Finish pushes a successor the predecessor would finish after');

-- Refusals.
select throws_ok($$select * from app.reschedule_record((select id from world where key = 'b'), 0, -10)$$, 'XR001',
  'reschedule_window: A record cannot end before it starts.', 'a record cannot end before it starts');
insert into world values ('due', pg_temp.new_record('prj_a', 'Task', 'Send the advance sheet', 'Execute'));
update app.records set due_at = '2027-06-02 16:00+00' where id = pg_temp.id('due');
select throws_ok($$select * from app.reschedule_record((select id from world where key = 'due'), 0, 1)$$, 'XR001',
  'reschedule_single_date: A record with one date moves; give it a start and an end to resize it.', 'a one-date record cannot be resized');
select is((select due_at from app.reschedule_record(pg_temp.id('due'), 1, 1)), '2027-06-03 16:00+00'::timestamptz, 'a one-date record moves');
insert into world values ('undated', pg_temp.new_record('prj_a', 'Task', 'Label the cable runs', 'Execute'));
select throws_ok($$select * from app.reschedule_record((select id from world where key = 'undated'), 1, 1)$$, 'XR001',
  'reschedule_undated: Give the record a date before moving it on the timeline.', 'an undated record cannot be moved');
insert into world values ('gone', pg_temp.new_record('prj_a', 'Task', 'Hang the side fills', 'Execute'));
update app.records set starts_at = '2027-06-05 12:00+00', ends_at = '2027-06-05 22:00+00' where id = pg_temp.id('gone');
select app.transition_record(pg_temp.id('gone'), 'Proposed', 'Canceled', 'Cut from the design.');
select throws_ok($$select * from app.reschedule_record((select id from world where key = 'gone'), 1, 1)$$, 'XR001',
  'reschedule_canceled: A canceled record stays where it was.', 'a canceled record cannot be moved');

-- A Timeline window locked into a baseline stays put, and every row carries its baseline window.
insert into world values ('window', pg_temp.new_record('prj_a', 'Timeline', 'Load-In Window', 'Show Cycle'));
insert into app.record_timeline (record_id) values (pg_temp.id('window'));
update app.records set starts_at = '2027-06-20 12:00+00', ends_at = '2027-06-22 22:00+00' where id = pg_temp.id('window');
insert into app.record_dependencies (predecessor_record_id, successor_record_id) values (pg_temp.id('c'), pg_temp.id('window'));
with x as (insert into app.schedule_baselines (project_id, name) values (pg_temp.id('prj_a'), 'Gate 3 Baseline') returning id) insert into world select 'bl', id from x;
select ok(app.lock_baseline(pg_temp.id('bl')) > 0, 'a baseline locks the window');
select throws_like($$select * from app.reschedule_record((select id from world where key = 'a'), 20, 20)$$,
  'reschedule_locked: % Load-In Window is locked: %', 'a change that would push a locked window is refused, naming the window');
select throws_ok($$select * from app.reschedule_record((select id from world where key = 'window'), 1, 1)$$, 'XR001', null,
  'a locked window cannot be moved');
select is((select baseline_starts_at from app.reschedule_record(pg_temp.id('a'), 1, 1) where is_target), '2027-06-02 12:00+00'::timestamptz,
  'each row carries its window in the latest baseline, which the change never touches');

-- A cycle planted past the guard trigger is refused before anything moves.
select pg_temp.as_platform();
alter table app.record_dependencies disable trigger t40_guard_record_dependency;
insert into app.record_dependencies (predecessor_record_id, successor_record_id) values (pg_temp.id('c'), pg_temp.id('a'));
alter table app.record_dependencies enable trigger t40_guard_record_dependency;
select pg_temp.as_user('carol');
select throws_ok($$select * from app.reschedule_record((select id from world where key = 'a'), 1, 1, true)$$, 'XR001',
  'reschedule_cycle: This schedule is circular; remove a dependency before moving the record.', 'a cycle is refused');
select pg_temp.as_platform();
update app.record_dependencies set deleted_at = now() where predecessor_record_id = pg_temp.id('c') and successor_record_id = pg_temp.id('a');

-- One-date records push by the instants they hold: a successor due a day after its predecessor moves one day when the
-- predecessor moves two (the case the timeline journey drags).
select pg_temp.as_user('carol');
insert into world values ('due1', pg_temp.new_record('prj_a', 'Task', 'Confirm the rigging plot', 'Execute'));
insert into world values ('due2', pg_temp.new_record('prj_a', 'Task', 'Send the rigging plot to the venue', 'Execute'));
update app.records set due_at = '2027-04-12 14:00+00' where id = pg_temp.id('due1');
update app.records set due_at = '2027-04-13 14:00+00' where id = pg_temp.id('due2');
insert into app.record_dependencies (predecessor_record_id, successor_record_id) values (pg_temp.id('due1'), pg_temp.id('due2'));
select is((select due_at from app.reschedule_record(pg_temp.id('due1'), 2, 2) where record_id = pg_temp.id('due2')),
  '2027-04-14 14:00+00'::timestamptz, 'a one-date successor is pushed by what the change adds to the gap between the instants');

-- A schedule whose chains split and rejoin: eight phases of twelve tasks, each task depending on every task of the
-- phase before (12^7, about 36 million paths from the first task, 96 records). The cycle check walks records, not
-- paths, so it stays well inside the timeout; a walk that listed every path would not finish.
insert into fan select p, n, pg_temp.new_record('prj_a', 'Task', 'Phase ' || p || ' department ' || n, 'Execute')
from generate_series(1, 8) p, generate_series(1, 12) n;
update app.records r set starts_at = '2027-08-01 12:00+00'::timestamptz + pg_catalog.make_interval(days => f.phase * 2),
  ends_at = '2027-08-01 22:00+00'::timestamptz + pg_catalog.make_interval(days => f.phase * 2)
from fan f where r.id = f.id;
insert into app.record_dependencies (predecessor_record_id, successor_record_id)
select a.id, b.id from fan a join fan b on b.phase = a.phase + 1;
set local statement_timeout = '10s';
insert into fan_moves select * from app.reschedule_record((select id from fan where phase = 1 and slot = 1), 10, 10);
select is((select count(*)::int from fan_moves), 85,
  'a schedule that splits and rejoins previews within the statement timeout, pushing every later phase');
select is((select count(*)::int from fan_moves m join fan f on f.id = m.record_id where f.phase = 8 and m.shift_start_days = 3), 12,
  'the last phase moves by what the change adds through the whole chain (a day less each phase, as slack opens), every task of it');
reset statement_timeout;

-- Who may reschedule.
select pg_temp.as_user('gina');
select throws_ok($$select * from app.reschedule_record((select id from world where key = 'a'), 1, 1)$$, '42501', null, 'a Viewer cannot reschedule');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.reschedule_record((select id from world where key = 'a'), 1, 1)$$, '42501', null, 'another org cannot reschedule');
select pg_temp.as_anon();
select throws_ok($$select * from app.reschedule_record((select id from world where key = 'a'), 1, 1)$$, '42501', null, 'anon cannot reschedule');

select * from finish();
rollback;
