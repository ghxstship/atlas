-- pgTAP: the workload view (2935, B4 G-45). A shift across midnight split in its own zone; task estimates spread over
-- their days and shared by their assignees; Canceled records left out; unestimated tasks counted; the setting and the
-- Heatmap view type defined; a viewer without access to the project sees none of its hours; the range limit.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(12);

create function pg_temp.new_record(p_kind text, p_title text, p_subtype text default null) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), p_kind, p_subtype, p_title, 'Y', 'Declared') returning id into v;
  return v;
end $$;

create temporary table load (person_id uuid, person_name text, day date, shift_minutes integer, task_hours numeric,
  unestimated_tasks integer, total_hours numeric);
grant select, insert, delete on load to public;

select has_function('app', 'workload', array['uuid', 'date', 'date', 'uuid'], 'app.workload exists');
select ok(exists (select 1 from app.setting_definitions where setting_key = 'scheduling.workload_day_hours' and default_integer = 10
  and min_integer = 4 and max_integer = 24), 'scheduling.workload_day_hours defaults to 10 hours, 4 to 24');
select ok('Heatmap' = any (enum_range(null::app.view_type)::text[]), 'Heatmap is a saved view type');

-- frank works 17:00 to 01:00 Los Angeles time, which crosses midnight there; dave and erin share a 6-hour task over three
-- days; frank owns an unestimated task; a canceled task is left out.
select pg_temp.as_user('carol');
insert into app.shifts (project_id, membership_id, starts_at, ends_at, time_zone)
values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-06-06 00:00+00', '2027-06-06 08:00+00', 'America/Los_Angeles');
insert into world values ('task', pg_temp.new_record('Task', 'Paint the scenic flats', 'Execute'));
update app.records set starts_at = '2027-06-10 12:00+00', ends_at = '2027-06-12 20:00+00' where id = pg_temp.id('task');
insert into app.record_task (record_id, effort_hours) values (pg_temp.id('task'), 6);
insert into app.record_assignments (record_id, membership_id) values
  (pg_temp.id('task'), pg_temp.id('dave@org_a')), (pg_temp.id('task'), pg_temp.id('erin@org_a'));
insert into world values ('plain', pg_temp.new_record('Task', 'Order more gaffer tape', 'Execute'));
update app.records set due_at = '2027-06-10 16:00+00', owner_party_id = pg_temp.id('frank') where id = pg_temp.id('plain');
insert into world values ('gone', pg_temp.new_record('Task', 'Rent a second scrim', 'Execute'));
update app.records set due_at = '2027-06-10 16:00+00', owner_party_id = pg_temp.id('frank') where id = pg_temp.id('gone');
insert into app.record_task (record_id, effort_hours) values (pg_temp.id('gone'), 8);
select app.transition_record(pg_temp.id('gone'), 'Proposed', 'Canceled', 'One scrim is enough.');

insert into load select * from app.workload(pg_temp.id('org_a'), '2027-06-01', '2027-06-30');
select is((select array_agg(shift_minutes order by day) from load where person_id = pg_temp.id('frank') and shift_minutes > 0),
  array[420, 60], 'a shift across midnight is split in its own zone: 7 hours on the 5th and 1 on the 6th, Los Angeles time');
select is((select array_agg(day order by day) from load where person_id = pg_temp.id('frank') and shift_minutes > 0),
  array['2027-06-05', '2027-06-06']::date[], 'on the shift''s local days');
select is((select array_agg(task_hours order by day) from load where person_id = pg_temp.id('dave')),
  array[1.00, 1.00, 1.00]::numeric[], 'a 6-hour task over 3 days with 2 assignees adds 1 hour per assignee per day');
select is((select array_agg(task_hours order by day) from load where person_id = pg_temp.id('erin')),
  array[1.00, 1.00, 1.00]::numeric[], 'the second assignee carries the same share');
select is((select row(unestimated_tasks, task_hours)::text from load where person_id = pg_temp.id('frank') and day = '2027-06-10'),
  row(1, 0.00)::text, 'an unestimated task is counted on its day, and the canceled task adds nothing');
select is((select total_hours from load where person_id = pg_temp.id('frank') and day = '2027-06-05'), 7.00::numeric,
  'total hours add shift and task hours');

-- Visibility and limits.
select pg_temp.as_user('gina');
select is((select count(*)::int from app.workload(pg_temp.id('org_a'), '2027-06-01', '2027-06-30')), 0,
  'a viewer without access to the project sees none of its hours');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.workload(pg_temp.id('org_a'), '2027-06-01', '2027-06-30')), 0,
  'another org sees none');
select throws_ok(format('select * from app.workload(%L, %L, %L)', pg_temp.id('org_a'), '2027-06-01', '2027-09-30'),
  '22023', null, 'the workload covers at most 92 days');

select * from finish();
rollback;
