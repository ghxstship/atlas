-- pgTAP: moving a project's anchor (2934, B4 G-44). A plain anchor_on update moves nothing; the move's preview equals
-- its commit; dated records move by whole days of the wall clock while pinned, Complete, baseline-locked and undated
-- ones stay; running orders and cues move; project days and unpublished sheets move forward and back with no unique
-- violation while published sheets stay; the project's dates move; shifts are listed and never move; a pinned or locked
-- successor that would be pushed, a called cue, an unset anchor, a far move and missing capabilities are refused.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(29);

create function pg_temp.new_record(p_kind text, p_title text, p_subtype text default null) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), p_kind, p_subtype, p_title, 'Y', 'Declared') returning id into v;
  return v;
end $$;

create temporary table moved (item_kind text, item_id uuid, label text, moves boolean, stays_because text, old_at timestamptz,
  new_at timestamptz, old_on date, new_on date, shift_days integer);
create temporary table committed (like moved);
grant select, insert, delete on moved, committed to public;

select has_function('app', 'move_project_anchor', array['uuid', 'date', 'boolean', 'text'], 'app.move_project_anchor exists');

-- Fixture: Northwind Summer Series (America/New_York) counts from its show day, 2027-06-05.
select pg_temp.as_user('carol');
insert into world values ('t1', pg_temp.new_record('Task', 'Rig the follow spots', 'Execute'));
update app.records set starts_at = '2027-06-01 12:00+00', ends_at = '2027-06-01 14:00+00' where id = pg_temp.id('t1');
insert into world values ('pin', pg_temp.new_record('Task', 'File the noise permit', 'Execute'));
update app.records set due_at = '2027-06-03 16:00+00', anchor_pinned = true where id = pg_temp.id('pin');
insert into world values ('done', pg_temp.new_record('Task', 'Book the follow spot operators', 'Execute'));
update app.records set starts_at = '2027-06-02 12:00+00', ends_at = '2027-06-02 13:00+00' where id = pg_temp.id('done');
select app.transition_record(pg_temp.id('done'), 'Proposed', 'Scheduled', 'Booked.');
select app.transition_record(pg_temp.id('done'), 'Scheduled', 'Active', 'Started.');
select app.transition_record(pg_temp.id('done'), 'Active', 'Complete', 'Operators confirmed.');
insert into world values ('window', pg_temp.new_record('Timeline', 'Load-In Window', 'Show Cycle'));
insert into app.record_timeline (record_id) values (pg_temp.id('window'));
update app.records set starts_at = '2027-06-03 10:00+00', ends_at = '2027-06-04 20:00+00' where id = pg_temp.id('window');
select pg_temp.as_platform();
update app.record_timeline set baseline_locked_at = now() where record_id = pg_temp.id('window');
select pg_temp.as_user('carol');
insert into world values ('undated', pg_temp.new_record('Task', 'Label the cable runs', 'Execute'));
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date, curfew_at)
  values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Opening Night Running Order', '2027-06-05', '2027-06-06 03:00+00') returning id)
  insert into world select 'ros', id from x;
insert into app.cues (run_of_show_id, position, label, planned_at) values
  (pg_temp.id('ros'), 1, 'House to Half', '2027-06-06 00:00+00'), (pg_temp.id('ros'), 2, 'Headliner On', '2027-06-06 01:30+00');
insert into world select 'q' || c.position, c.id from app.cues c where c.run_of_show_id = pg_temp.id('ros');
insert into app.project_days (project_id, day_on, day_type) values
  (pg_temp.id('prj_a'), '2027-06-04', 'Load In'), (pg_temp.id('prj_a'), '2027-06-05', 'Show'), (pg_temp.id('prj_a'), '2027-06-06', 'Load Out');
insert into app.day_sheets (project_id, day, body) values
  (pg_temp.id('prj_a'), '2027-06-05', 'Doors 7 pm.'), (pg_temp.id('prj_a'), '2027-06-06', 'Load-out after curfew.');
with x as (insert into app.call_sheets (project_id, day, published_at) values (pg_temp.id('prj_a'), '2027-06-05', now()) returning id)
  insert into world select 'published', id from x;
with x as (insert into app.call_sheets (project_id, day) values (pg_temp.id('prj_a'), '2027-06-03') returning id)
  insert into world select 'loose', id from x;
with x as (insert into app.shifts (project_id, membership_id, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-06-05 20:00+00', '2027-06-06 04:00+00', 'America/New_York') returning id)
  insert into world select 'shift', id from x;

-- The first anchor is a plain update, and a plain update moves nothing.
update app.projects set anchor_on = '2027-06-03', starts_on = '2027-06-01', ends_on = '2027-06-10' where id = pg_temp.id('prj_a');
update app.projects set anchor_on = '2027-06-05' where id = pg_temp.id('prj_a');
select is((select starts_at from app.records where id = pg_temp.id('t1')), '2027-06-01 12:00+00'::timestamptz,
  'a plain anchor_on update moves no record');

-- An unpublished sheet would land on a published one.
select throws_ok(format('select * from app.move_project_anchor(%L, %L)', pg_temp.id('prj_a'), '2027-06-07'),
  'XR001', 'anchor_sheet_collision: A published sheet already covers 2027-06-05; it stays, so the sheet that would move onto it cannot.',
  'an unpublished sheet that would land on a published one is refused, naming the date');
update app.call_sheets set deleted_at = now() where id = pg_temp.id('loose');

-- The preview.
insert into moved select * from app.move_project_anchor(pg_temp.id('prj_a'), '2027-06-07');
select is((select row(moves, shift_days, new_at)::text from moved where item_id = pg_temp.id('t1')),
  row(true, 2, '2027-06-03 12:00+00'::timestamptz)::text, 'a dated record moves two days on the wall clock');
select is((select string_agg(stays_because, ',' order by stays_because) from moved
           where item_id in (pg_temp.id('pin'), pg_temp.id('done'), pg_temp.id('window'), pg_temp.id('undated'))),
  'baseline_locked,complete,pinned,undated', 'pinned, Complete, baseline-locked and undated records stay, each with its reason');
select is((select row(moves, stays_because)::text from moved where item_id = pg_temp.id('shift')), row(false, 'shift')::text,
  'a shift is listed and never moves');
select is((select row(moves, stays_because)::text from moved where item_id = pg_temp.id('published')), row(false, 'published')::text,
  'a published call sheet stays');
select is((select count(*)::int from moved where item_kind in ('Project Day', 'Day Sheet', 'Running Order', 'Cue') and moves), 8,
  'three days, two day sheets, the running order and its two cues move');
select is((select starts_at from app.records where id = pg_temp.id('t1')), '2027-06-01 12:00+00'::timestamptz, 'the preview writes nothing');

-- The commit returns the preview's rows and writes them.
insert into committed select * from app.move_project_anchor(pg_temp.id('prj_a'), '2027-06-07', true, 'Show moved two days.');
select results_eq($$select item_kind, item_id, moves, stays_because, new_at, new_on from committed order by item_kind, item_id$$,
  $$select item_kind, item_id, moves, stays_because, new_at, new_on from moved order by item_kind, item_id$$,
  'the commit returns exactly the rows the preview showed');
select is((select row(starts_at, ends_at)::text from app.records where id = pg_temp.id('t1')),
  row('2027-06-03 12:00+00'::timestamptz, '2027-06-03 14:00+00'::timestamptz)::text, 'the record moved two days');
select is((select array_agg(coalesce(starts_at, due_at) order by title) from app.records
           where id in (pg_temp.id('pin'), pg_temp.id('done'), pg_temp.id('window'))),
  array['2027-06-02 12:00+00', '2027-06-03 16:00+00', '2027-06-03 10:00+00']::timestamptz[], 'the staying records kept their dates');
select is((select row(show_date, curfew_at)::text from app.run_of_show where id = pg_temp.id('ros')),
  row('2027-06-07'::date, '2027-06-08 03:00+00'::timestamptz)::text, 'the running order and its curfew moved');
select is((select array_agg(planned_at order by position) from app.cues where run_of_show_id = pg_temp.id('ros')),
  array['2027-06-08 00:00+00', '2027-06-08 01:30+00']::timestamptz[], 'its cues moved');
select is((select array_agg(day_on order by day_on) from app.project_days where project_id = pg_temp.id('prj_a') and deleted_at is null),
  array['2027-06-06', '2027-06-07', '2027-06-08']::date[], 'the days moved forward with no unique violation');
select is((select array_agg(day order by day) from app.day_sheets where project_id = pg_temp.id('prj_a') and deleted_at is null),
  array['2027-06-07', '2027-06-08']::date[], 'the unpublished day sheets moved');
select is((select day from app.call_sheets where id = pg_temp.id('published')), '2027-06-05'::date, 'the published call sheet stayed');
select is((select row(anchor_on, starts_on, ends_on)::text from app.projects where id = pg_temp.id('prj_a')),
  row('2027-06-07'::date, '2027-06-03'::date, '2027-06-12'::date)::text, 'the anchor, start and end moved');
select is((select starts_at from app.shifts where id = pg_temp.id('shift')), '2027-06-05 20:00+00'::timestamptz, 'the shift did not move');
select pg_temp.as_platform();
select is((select count(*)::int from app.audit_events where action = 'project.anchor_moved' and subject_id = pg_temp.id('prj_a')), 1,
  'the commit writes one audit event');
select pg_temp.as_user('carol');

-- And back again.
select lives_ok(format('select * from app.move_project_anchor(%L, %L, true)', pg_temp.id('prj_a'), '2027-06-05'),
  'moving the anchor back two days succeeds');
select is((select array_agg(day_on order by day_on) from app.project_days where project_id = pg_temp.id('prj_a') and deleted_at is null),
  array['2027-06-04', '2027-06-05', '2027-06-06']::date[], 'the days moved back with no unique violation');

-- A pinned or locked successor that would be pushed.
insert into world values ('after', pg_temp.new_record('Task', 'Strike the follow spots', 'Execute'));
update app.records set due_at = '2027-06-01 15:00+00', anchor_pinned = true where id = pg_temp.id('after');
insert into app.record_dependencies (predecessor_record_id, successor_record_id) values (pg_temp.id('t1'), pg_temp.id('after'));
select throws_ok(format('select * from app.move_project_anchor(%L, %L)', pg_temp.id('prj_a'), '2027-06-07'),
  'XR001', null, 'a move that would push a pinned successor is refused (anchor_pinned_pushed)');
update app.record_dependencies set deleted_at = now() where successor_record_id = pg_temp.id('after');
insert into app.record_dependencies (predecessor_record_id, successor_record_id) values (pg_temp.id('t1'), pg_temp.id('done'));
select throws_ok(format('select * from app.move_project_anchor(%L, %L)', pg_temp.id('prj_a'), '2027-06-07'),
  'XR001', null, 'a move that would push a Complete successor is refused (reschedule_locked)');
update app.record_dependencies set deleted_at = now() where successor_record_id = pg_temp.id('done');

-- A called cue means the show has started.
select app.call_cue(pg_temp.id('q1'));
select throws_ok(format('select * from app.move_project_anchor(%L, %L)', pg_temp.id('prj_a'), '2027-06-07'),
  'XR001', 'anchor_show_started: A cue of this project''s running orders has been called, so its shows have started and stay on their dates.',
  'a called cue refuses the move');

-- Unset anchors, far moves and capabilities.
select throws_ok(format('select * from app.move_project_anchor(%L, %L)', pg_temp.id('prj_a2'), '2027-06-07'),
  'XR001', 'anchor_unset: Set the project''s anchor day before moving it.', 'a project without an anchor is refused');
select throws_ok(format('select * from app.move_project_anchor(%L, %L)', pg_temp.id('prj_a'), '2040-01-01'),
  '22023', null, 'a move beyond 3660 days is refused');
select pg_temp.as_user('alice');
insert into app.project_members (project_id, membership_id, project_role) values (pg_temp.id('prj_a'), pg_temp.id('gina@org_a'), 'Field');
select pg_temp.as_user('gina');
select throws_ok(format('select * from app.move_project_anchor(%L, %L)', pg_temp.id('prj_a'), '2027-06-07'),
  '42501', null, 'a reader without projects.project.write and schedule.timeline.write cannot move the anchor');
select pg_temp.as_user('xavier');
select throws_ok(format('select * from app.move_project_anchor(%L, %L)', pg_temp.id('prj_a'), '2027-06-07'),
  '42501', null, 'another org cannot move it');

select * from finish();
rollback;
