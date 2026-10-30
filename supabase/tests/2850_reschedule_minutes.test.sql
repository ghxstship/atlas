-- pgTAP: minute offsets and Shift time (2850, P8). app.reschedule_record moving by minutes and pushing successors by
-- whole minutes of the project's wall clock (across a daylight saving change too), whole-day changes pushing by days as
-- 2260 does, one-date resizes and oversized offsets refused; app.shift_records moving a selection rigidly, pushing
-- successors outside it only by what they need, leaving undated and canceled records out, refusing empty, oversized and
-- locked selections and move sets over 500 rows, taking every project's lock on commit, preview equal to commit, and
-- capability denial across projects.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(32);

create function pg_temp.new_record(p_project text, p_kind text, p_title text, p_subtype text default null) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id(p_project), p_kind, p_subtype, p_title, 'Y', 'Declared') returning id into v;
  return v;
end $$;

select pg_temp.as_platform();
create temporary table moves (record_id uuid, is_target boolean, shift_start_days integer, shift_end_days integer,
  old_starts_at timestamptz, old_ends_at timestamptz, old_due_at timestamptz, starts_at timestamptz, ends_at timestamptz,
  due_at timestamptz, baseline_starts_at timestamptz, baseline_ends_at timestamptz, shift_start_minutes integer,
  shift_end_minutes integer, project_id uuid);
grant select, insert, delete on moves to public;

select has_function('app', 'shift_records', array['uuid[]', 'integer', 'boolean', 'text'], 'app.shift_records exists');
select is(private.add_local_minutes('2027-03-14 06:00+00', 120, 'America/New_York'), '2027-03-14 07:00+00'::timestamptz,
  'minutes are added on the wall clock: two hours from 01:00 on the night clocks go forward is 03:00, one hour later');

-- One record by minutes -------------------------------------------------------------------------------------------------
-- A then B then C on Northwind Summer Series (America/New_York), Finish to Start: B starts as A ends, C two hours later.
select pg_temp.as_user('carol');
insert into world values ('a', pg_temp.new_record('prj_a', 'Task', 'Rig the follow spots', 'Execute'));
insert into world values ('b', pg_temp.new_record('prj_a', 'Task', 'Focus the follow spots', 'Execute'));
insert into world values ('c', pg_temp.new_record('prj_a', 'Task', 'Rehearse the spot cues', 'Execute'));
update app.records set starts_at = '2027-06-01 12:00+00', ends_at = '2027-06-01 14:00+00' where id = pg_temp.id('a');
update app.records set starts_at = '2027-06-01 14:00+00', ends_at = '2027-06-01 16:00+00' where id = pg_temp.id('b');
update app.records set starts_at = '2027-06-01 18:00+00', ends_at = '2027-06-01 19:00+00' where id = pg_temp.id('c');
insert into app.record_dependencies (predecessor_record_id, successor_record_id) values
  (pg_temp.id('a'), pg_temp.id('b')), (pg_temp.id('b'), pg_temp.id('c'));

insert into moves (record_id, is_target, shift_start_days, shift_end_days, old_starts_at, old_ends_at, old_due_at, starts_at,
  ends_at, due_at, baseline_starts_at, baseline_ends_at, shift_start_minutes, shift_end_minutes)
select * from app.reschedule_record(pg_temp.id('a'), 0, 0, false, null, 30, 30);
select is((select count(*)::int from moves), 2, 'moving A 30 minutes later moves A and pushes B; C has two hours of slack');
select is((select row(shift_start_minutes, shift_end_minutes, starts_at)::text from moves where record_id = pg_temp.id('b')),
  row(30, 30, '2027-06-01 14:30+00'::timestamptz)::text, 'B, Finish to Start with no gap, is pushed exactly 30 minutes');
select is((select shift_start_days from moves where record_id = pg_temp.id('b')), 0, 'a minute change pushes by minutes, not days');
select is((select starts_at from app.records where id = pg_temp.id('a')), '2027-06-01 12:00+00'::timestamptz, 'a preview writes nothing');

select results_eq(
  $$select record_id, shift_start_days, shift_start_minutes, shift_end_minutes from app.reschedule_record((select id from world where key = 'a'), 1, 1)
    order by record_id$$,
  $$values ((select id from world where key = 'a'), 1, 0, 0), ((select id from world where key = 'b'), 1, 0, 0),
    ((select id from world where key = 'c'), 1, 0, 0)$$,
  'with minutes 0 a change is whole days and pushes by whole days, as 2260 does');
select is((select count(*)::int from app.reschedule_record(pg_temp.id('a'), 0, 0, false, null, 0, 0)), 1,
  'a change of nothing returns only the record and moves nothing');

select results_eq(
  $$select record_id, starts_at, ends_at from app.reschedule_record((select id from world where key = 'a'), 0, 0, true, 'Spots arrive late.', 30, 30)
    order by record_id$$,
  $$select record_id, starts_at, ends_at from moves order by record_id$$,
  'a commit moves exactly the rows the preview showed');
select results_eq(
  $$select r.id, r.starts_at, r.ends_at from app.records r where r.id in (select record_id from moves) order by r.id$$,
  $$select record_id, starts_at, ends_at from moves order by record_id$$,
  'the records hold the previewed times');

select is((select row(shift_start_minutes, shift_end_minutes, ends_at)::text
           from app.reschedule_record(pg_temp.id('b'), 0, 0, false, null, 0, 45) where is_target),
  row(0, 45, '2027-06-01 17:15+00'::timestamptz)::text, 'a record''s end moves by minutes alone, a resize');

-- A one-date record moves by minutes but is not resized; offsets stay within fourteen days.
insert into world values ('due', pg_temp.new_record('prj_a', 'Task', 'Confirm the spot operators', 'Execute'));
update app.records set due_at = '2027-06-02 16:00+00' where id = pg_temp.id('due');
select throws_ok($$select * from app.reschedule_record((select id from world where key = 'due'), 0, 0, false, null, 0, 30)$$,
  'XR001', 'reschedule_single_date: A record with one date moves; give it a start and an end to resize it.',
  'a one-date record cannot be resized by minutes');
select is((select due_at from app.reschedule_record(pg_temp.id('due'), 0, 0, false, null, 30, 30)),
  '2027-06-02 16:30+00'::timestamptz, 'a one-date record moves by minutes');
select throws_ok($$select * from app.reschedule_record((select id from world where key = 'a'), 0, 0, false, null, 20161, 20161)$$,
  '22023', null, 'a minute offset beyond fourteen days is refused');

-- Minutes across the start of daylight saving (America/New_York, 2027-03-14 02:00 becomes 03:00): E ends at 01:00 and F
-- starts then. Moving E two hours on the wall clock ends it at 03:00; F keeps its gap on the wall clock too.
insert into world values ('e', pg_temp.new_record('prj_a', 'Task', 'Strike the overnight set', 'Execute'));
insert into world values ('f', pg_temp.new_record('prj_a', 'Task', 'Sweep the stage', 'Execute'));
update app.records set starts_at = '2027-03-14 05:00+00', ends_at = '2027-03-14 06:00+00' where id = pg_temp.id('e');
update app.records set starts_at = '2027-03-14 06:00+00', ends_at = '2027-03-14 07:00+00' where id = pg_temp.id('f');
insert into app.record_dependencies (predecessor_record_id, successor_record_id) values (pg_temp.id('e'), pg_temp.id('f'));
select is((select row(shift_start_minutes, starts_at)::text from app.reschedule_record(pg_temp.id('e'), 0, 0, false, null, 120, 120)
           where record_id = pg_temp.id('f')),
  row(120, '2027-03-14 07:00+00'::timestamptz)::text,
  'a push across a daylight saving change keeps the wall-clock gap: 01:00 plus two hours is 03:00 daylight time');

-- Several records by the same minutes ---------------------------------------------------------------------------------
-- P then Q then R, Finish to Start: Q starts as P ends, R five minutes after Q ends. P and Q are selected.
insert into world values ('p', pg_temp.new_record('prj_a', 'Task', 'Hang the scrim', 'Execute'));
insert into world values ('q', pg_temp.new_record('prj_a', 'Task', 'Light the scrim', 'Execute'));
insert into world values ('r', pg_temp.new_record('prj_a', 'Task', 'Record the scrim look', 'Execute'));
insert into world values ('u', pg_temp.new_record('prj_a', 'Task', 'Order more gaffer tape', 'Execute'));
insert into world values ('x', pg_temp.new_record('prj_a', 'Task', 'Rent a second scrim', 'Execute'));
update app.records set starts_at = '2027-07-01 12:00+00', ends_at = '2027-07-01 13:00+00' where id = pg_temp.id('p');
update app.records set starts_at = '2027-07-01 13:00+00', ends_at = '2027-07-01 14:00+00' where id = pg_temp.id('q');
update app.records set starts_at = '2027-07-01 14:05+00', ends_at = '2027-07-01 15:00+00' where id = pg_temp.id('r');
update app.records set starts_at = '2027-07-01 09:00+00', ends_at = '2027-07-01 10:00+00' where id = pg_temp.id('x');
select app.transition_record(pg_temp.id('x'), 'Proposed', 'Canceled', 'One scrim is enough.');
insert into app.record_dependencies (predecessor_record_id, successor_record_id) values
  (pg_temp.id('p'), pg_temp.id('q')), (pg_temp.id('q'), pg_temp.id('r'));

delete from moves;
insert into moves select * from app.shift_records(array[pg_temp.id('p'), pg_temp.id('q'), pg_temp.id('u'), pg_temp.id('x')], 15);
select is((select count(*)::int from moves), 3, 'P and Q move and R is pushed; the undated and canceled records are left out');
select is((select shift_start_minutes from moves where record_id = pg_temp.id('q')), 15,
  'Q, selected and a successor of P, moves once with P, so their dependency keeps its gap');
select is((select row(is_target, shift_start_minutes, starts_at)::text from moves where record_id = pg_temp.id('r')),
  row(false, 10, '2027-07-01 14:15+00'::timestamptz)::text, 'R, outside the selection, is pushed only the 10 minutes its dependency needs');
select is((select count(*)::int from moves where project_id = pg_temp.id('prj_a')), 3, 'each row names its project');

-- Across projects: S on Northwind Winter Gala moves with P, under both projects' locks.
insert into world values ('s', pg_temp.new_record('prj_a2', 'Task', 'Book the gala band', 'Execute'));
update app.records set due_at = '2027-12-01 20:00+00' where id = pg_temp.id('s');
delete from moves;
insert into moves select * from app.shift_records(array[pg_temp.id('p'), pg_temp.id('s')], -20);
select results_eq(
  $$select record_id, starts_at, ends_at, due_at, project_id
    from app.shift_records(array[(select id from world where key = 'p'), (select id from world where key = 's')], -20, true)
    order by record_id$$,
  $$select record_id, starts_at, ends_at, due_at, project_id from moves order by record_id$$,
  'a commit across two projects moves exactly the rows its preview showed');
select is((select due_at from app.records where id = pg_temp.id('s')), '2027-12-01 19:40+00'::timestamptz, 'the commit wrote the gala record');
select is((select count(*)::int from pg_catalog.pg_locks l
           where l.locktype = 'advisory' and l.pid = pg_catalog.pg_backend_pid() and l.granted
             and ((l.classid::bigint << 32) | l.objid::bigint) in (
               pg_catalog.hashtextextended('reschedule:' || pg_temp.id('prj_a')::text, 0),
               pg_catalog.hashtextextended('reschedule:' || pg_temp.id('prj_a2')::text, 0))), 2,
  'the commit holds the reschedule lock of each project, as app.reschedule_record takes it');

-- Refusals.
select throws_ok($$select * from app.shift_records('{}'::uuid[], 15)$$, 'XR001',
  'shift_empty: Select at least one record to shift.', 'an empty selection is refused');
select throws_ok($$select * from app.shift_records((select array_agg(gen_random_uuid()) from generate_series(1, 501)), 15)$$, 'XR001',
  'shift_too_large: Shift at most 500 records at a time.', 'more than 500 records are refused');
select throws_ok($$select * from app.shift_records(array[(select id from world where key = 'p')], 0)$$, '22023', null,
  'a shift of nothing is refused');
insert into world values ('window', pg_temp.new_record('prj_a', 'Timeline', 'Scrim Load-In Window', 'Show Cycle'));
insert into app.record_timeline (record_id) values (pg_temp.id('window'));
update app.records set starts_at = '2027-07-03 12:00+00', ends_at = '2027-07-03 22:00+00' where id = pg_temp.id('window');
with x as (insert into app.schedule_baselines (project_id, name) values (pg_temp.id('prj_a'), 'Scrim Baseline') returning id) insert into world select 'bl', id from x;
select ok(app.lock_baseline(pg_temp.id('bl')) > 0, 'a baseline locks the window');
select throws_like($$select * from app.shift_records(array[(select id from world where key = 'p'), (select id from world where key = 'window')], 15)$$,
  'reschedule_locked: % Scrim Load-In Window is locked: %', 'a selection holding a locked window is refused, naming it');

-- A move set over 500 rows: Z with 501 successors that start as it ends.
insert into world values ('z', pg_temp.new_record('prj_a', 'Task', 'Open the house', 'Execute'));
update app.records set starts_at = '2027-08-01 12:00+00', ends_at = '2027-08-01 13:00+00' where id = pg_temp.id('z');
create temporary table fan (id uuid);
grant select, insert on fan to public;
insert into fan select pg_temp.new_record('prj_a', 'Task', 'Usher station ' || n, 'Execute') from generate_series(1, 501) n;
update app.records r set starts_at = '2027-08-01 13:00+00', ends_at = '2027-08-01 14:00+00' from fan f where r.id = f.id;
insert into app.record_dependencies (predecessor_record_id, successor_record_id) select pg_temp.id('z'), f.id from fan f;
select throws_ok($$select * from app.shift_records(array[(select id from world where key = 'z')], 5)$$, 'XR001',
  'shift_too_large: This shift would move more than 500 records with their successors; shift fewer at a time.',
  'a shift that would move more than 500 records with their successors is refused, so its undo fits one bulk call');

-- Who may shift.
select pg_temp.as_user('xavier');
insert into world values ('hlp', pg_temp.new_record('prj_b', 'Task', 'Tie off the dock lines', 'Execute'));
update app.records set starts_at = '2027-07-01 12:00+00', ends_at = '2027-07-01 13:00+00' where id = pg_temp.id('hlp');
select pg_temp.as_user('carol');
select throws_ok($$select * from app.shift_records(array[(select id from world where key = 'p'), (select id from world where key = 'hlp')], 15, true)$$,
  '42501', null, 'a selection holding a record of a project the caller cannot reschedule is refused');
select is((select starts_at from app.records where id = pg_temp.id('p')), '2027-07-01 11:40+00'::timestamptz, 'and nothing changed');
select pg_temp.as_user('gina');
select throws_ok($$select * from app.shift_records(array[(select id from world where key = 'p')], 15)$$, '42501', null,
  'a Viewer cannot shift records');
select pg_temp.as_anon();
select throws_ok($$select * from app.shift_records(array[(select id from world where key = 'p')], 15)$$, '42501', null,
  'anon cannot shift records');

select * from finish();
rollback;
