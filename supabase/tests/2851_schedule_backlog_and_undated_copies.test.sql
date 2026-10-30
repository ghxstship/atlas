-- pgTAP: the schedule's unscheduled backlog and copies without dates (2851, P8). app.place_record placing an undated
-- record on a project-local day (09:00 to 17:00, a Milestone due at 17:00), pushing successors by whole days, writing
-- nothing in preview and exactly the preview on commit, its undo through app.bulk_update_records, and refusing dated,
-- complete and canceled records and callers without schedule.timeline.write; app.apply_template leaving records undated
-- and app.create_template_from_project saving no due offsets.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(20);

create function pg_temp.new_record(p_project text, p_kind text, p_title text, p_subtype text default null) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id(p_project), p_kind, p_subtype, p_title, 'Y', 'Declared') returning id into v;
  return v;
end $$;

select pg_temp.as_platform();
create temporary table placed (record_id uuid, is_target boolean, shift_start_days integer, shift_end_days integer,
  old_starts_at timestamptz, old_ends_at timestamptz, old_due_at timestamptz, starts_at timestamptz, ends_at timestamptz,
  due_at timestamptz, baseline_starts_at timestamptz, baseline_ends_at timestamptz, shift_start_minutes integer,
  shift_end_minutes integer);
grant select, insert, delete on placed to public;

select has_function('app', 'place_record', array['uuid', 'date', 'boolean', 'text'], 'app.place_record exists');

-- An undated task with a dated successor on Northwind Summer Series (America/New_York, daylight time in June).
select pg_temp.as_user('carol');
insert into world values ('load', pg_temp.new_record('prj_a', 'Task', 'Load in the backline', 'Execute'));
insert into world values ('check', pg_temp.new_record('prj_a', 'Task', 'Line check', 'Execute'));
insert into world values ('open', pg_temp.new_record('prj_a', 'Milestone', 'Doors open'));
update app.records set starts_at = '2027-06-10 13:00+00', ends_at = '2027-06-10 15:00+00' where id = pg_temp.id('check');
insert into app.record_dependencies (predecessor_record_id, successor_record_id) values (pg_temp.id('load'), pg_temp.id('check'));

insert into placed select * from app.place_record(pg_temp.id('load'), '2027-06-10');
select is((select row(starts_at, ends_at, due_at)::text from placed where is_target),
  row('2027-06-10 13:00+00'::timestamptz, '2027-06-10 21:00+00'::timestamptz, null::timestamptz)::text,
  'a placed task runs from 09:00 to 17:00 on the day, project time');
select is((select row(old_starts_at, old_ends_at, old_due_at)::text from placed where is_target), row(null::timestamptz, null::timestamptz, null::timestamptz)::text,
  'its old dates are null');
select is((select row(shift_start_days, starts_at)::text from placed where record_id = pg_temp.id('check')),
  row(1, '2027-06-11 13:00+00'::timestamptz)::text, 'a successor the placement breaks is pushed by whole days until its dependency holds');
select is((select starts_at from app.records where id = pg_temp.id('load')), null, 'a preview writes nothing');

select results_eq(
  $$select record_id, starts_at, ends_at, due_at from app.place_record((select id from world where key = 'load'), '2027-06-10', true) order by record_id$$,
  $$select record_id, starts_at, ends_at, due_at from placed order by record_id$$,
  'a commit places exactly what the preview showed');
select results_eq(
  $$select id, starts_at, ends_at from app.records where id in (select record_id from placed) order by id$$,
  $$select record_id, starts_at, ends_at from placed order by record_id$$,
  'the records hold the placed dates');

select is((select due_at from app.place_record(pg_temp.id('open'), '2027-06-12') where is_target), '2027-06-12 21:00+00'::timestamptz,
  'a placed Milestone is due at 17:00 project time');
select throws_ok($$select * from app.place_record((select id from world where key = 'load'), '2027-06-11')$$, 'XR001',
  'place_dated: This record already has dates; drag its bar instead.', 'a dated record is not placed');

-- The undo sends the dates back to null through bulk edit, so the record returns to the backlog; a later change by someone
-- else makes that undo stale.
select is((select (app.bulk_update_records(
  (select jsonb_agg(jsonb_build_object('id', p.record_id,
    'set', jsonb_build_object('starts_at', p.old_starts_at, 'ends_at', p.old_ends_at, 'due_at', p.old_due_at),
    'expect', jsonb_build_object('starts_at', p.starts_at, 'ends_at', p.ends_at, 'due_at', p.due_at))) from placed p)) ->> 'changed')::int), 2,
  'the undo restores the record and its pushed successor in one bulk call');
select is((select row(starts_at, ends_at, due_at)::text from app.records where id = pg_temp.id('load')),
  row(null::timestamptz, null::timestamptz, null::timestamptz)::text, 'the record is undated again, back in the backlog');
select is((select starts_at from app.records where id = pg_temp.id('check')), '2027-06-10 13:00+00'::timestamptz,
  'and its successor is back where it was');

-- Locked and refused.
insert into world values ('gone', pg_temp.new_record('prj_a', 'Task', 'Hire a second truck', 'Execute'));
select app.transition_record(pg_temp.id('gone'), 'Proposed', 'Canceled', 'One truck is enough.');
select throws_like($$select * from app.place_record((select id from world where key = 'gone'), '2027-06-10')$$,
  'reschedule_locked: % Hire a second truck is locked: %', 'a canceled record stays unscheduled');
select pg_temp.as_user('gina');
select throws_ok($$select * from app.place_record((select id from world where key = 'load'), '2027-06-10')$$, '42501', null,
  'a Viewer cannot place a record');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.place_record((select id from world where key = 'load'), '2027-06-10')$$, '42501', null,
  'another org cannot place a record');

-- Templates without dates ------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.templates (org_id, name) values (pg_temp.id('org_a'), 'Club Night') returning id) insert into world select 'tpl', id from x;
with x as (insert into app.template_versions (template_id, default_time_zone, default_currency_code, duration_days)
  values (pg_temp.id('tpl'), 'America/New_York', 'USD', 2) returning id) insert into world select 'v1', id from x;
insert into app.template_items (template_version_id, item_kind, sort_order, name, record_kind, xyz, phase_code, due_offset_days)
values (pg_temp.id('v1'), 'Record', 1, 'Confirm the DJ rider', 'Task', 'Y', 'SCP', 1),
  (pg_temp.id('v1'), 'Record', 2, 'Book the door staff', 'Task', 'Y', 'SCP', 0);
select app.publish_template_version(pg_temp.id('v1'));

insert into world values ('app1', app.apply_template(pg_temp.id('tpl'), 'NCN', 'Club Night One', null, '2027-09-03', null, true));
insert into world select 'prj_t', project_id from app.template_applications where id = pg_temp.id('app1');
select is((select starts_on from app.projects where id = pg_temp.id('prj_t')), '2027-09-03'::date,
  'a project applied without dates still takes its start date');
select is((select count(*)::int from app.records where project_id = pg_temp.id('prj_t') and starts_at is null and ends_at is null and due_at is null), 2,
  'and every templated record is undated, waiting in the Unscheduled list');
insert into world values ('app2', app.apply_template(pg_temp.id('tpl'), 'NCT', 'Club Night Two', null, '2027-09-10'));
select is((select count(*)::int from app.records r join app.template_applications a on a.project_id = r.project_id
           where a.id = pg_temp.id('app2') and r.due_at is not null), 2, 'applied as before, the records are due on their offsets');

update app.records set due_at = '2027-09-04 21:00+00' where project_id = pg_temp.id('prj_t');
insert into world values ('tpl_kept', app.create_template_from_project(pg_temp.id('prj_t'), 'Club Night Kept'));
insert into world values ('tpl_bare', app.create_template_from_project(pg_temp.id('prj_t'), 'Club Night Bare', null, false));
select is((select count(*)::int from app.template_items i join app.templates t on t.current_version_id = i.template_version_id
           where t.id = pg_temp.id('tpl_kept') and i.item_kind = 'Record' and i.due_offset_days = 1), 2,
  'saving a project as a template keeps due offsets by default');
select is((select count(*)::int from app.template_items i join app.templates t on t.current_version_id = i.template_version_id
           where t.id = pg_temp.id('tpl_bare') and i.item_kind = 'Record' and i.due_offset_days is null), 2,
  'with Keep due dates off, every record item is saved without one');

select * from finish();
rollback;
