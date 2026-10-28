-- pgTAP: migration 2250, shift templates and creating shifts from one (A132, RRR-194, ADR 0063).
-- Holders of org.scheduling.write keep the templates and every member reads them; a planner with crew.shift.write
-- lays one onto days of a project as open Draft shifts in the project's zone, all or none; overnight wraps end the
-- next day; another org's template and repeated days are refused.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(20);

create temporary table c (key text primary key, id uuid);
grant select, insert on c to public;

-- Templates ----------------------------------------------------------------------------------------------------------
select has_table('app', 'shift_templates', 'app.shift_templates exists');
select policies_are('app', 'shift_templates', array['shift_templates_read', 'shift_templates_insert', 'shift_templates_update'],
  'read, insert and update policies, no delete');

select pg_temp.as_user('alice');
with x as (insert into app.shift_templates (org_id, name, role_code, call_time, wrap_time, headcount, break_minutes)
  values (pg_temp.id('org_a'), 'Stagehand day', '0000.50.01', '08:00', '16:30', 2, 30) returning id)
insert into c select 'day', id from x;
with x as (insert into app.shift_templates (org_id, name, call_time, wrap_time)
  values (pg_temp.id('org_a'), 'Load-out night', '22:00', '06:00') returning id)
insert into c select 'night', id from x;
select is((select count(*)::int from c), 2, 'the owner (org.scheduling.write) keeps templates');
select throws_ok($$insert into app.shift_templates (org_id, name, call_time, wrap_time) values ((select id from world where key = 'org_a'), 'stagehand DAY ', '09:00', '17:00')$$,
  '23505', null, 'a template name is unique in the org, ignoring case and spaces');
select throws_ok($$insert into app.shift_templates (org_id, name, call_time, wrap_time, break_minutes) values ((select id from world where key = 'org_a'), 'Short', '09:00', '10:00', 60)$$,
  '23514', null, 'the break is shorter than the shift');
select throws_ok($$insert into app.shift_templates (org_id, name, call_time, wrap_time, headcount) values ((select id from world where key = 'org_a'), 'Crowd', '09:00', '17:00', 51)$$,
  '23514', null, 'at most 50 people per template');

select pg_temp.as_user('carol');
select throws_ok($$insert into app.shift_templates (org_id, name, call_time, wrap_time) values ((select id from world where key = 'org_a'), 'Carol''s', '09:00', '17:00')$$,
  '42501', null, 'a manager without org.scheduling.write cannot add a template');

select pg_temp.as_user('frank');
select is((select count(*)::int from app.shift_templates), 2, 'a Field member reads the org''s templates');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.shift_templates), 0, 'another org reads none');
with x as (insert into app.shift_templates (org_id, name, call_time, wrap_time)
  values (pg_temp.id('org_b'), 'Harbor day', '09:00', '17:00') returning id)
insert into c select 'other_org', id from x;

-- Creating shifts ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into c select 'made_' || ordinality, id
from unnest(app.create_shifts_from_template((select id from c where key = 'day'), pg_temp.id('prj_a'), array['2027-08-02', '2027-08-03']::date[])) with ordinality as u(id, ordinality);
select is((select count(*)::int from c where key like 'made_%'), 4, 'headcount 2 on two days plans four shifts');
select results_eq(
  $$select count(*)::int, count(distinct starts_at)::int from app.shifts where id in (select id from c where key like 'made_%') and membership_id is null and shift_state = 'Draft' and role_code = '0000.50.01' and scheduled_break_minutes = 30$$,
  $$values (4, 2)$$, 'open Draft shifts with the template''s role and break, two per call time');
select results_eq(
  $$select starts_at, ends_at, time_zone from app.shifts where id = (select id from c where key = 'made_1')$$,
  $$values ('2027-08-02 08:00 America/New_York'::timestamptz, '2027-08-02 16:30 America/New_York'::timestamptz, 'America/New_York'::text)$$,
  'call and wrap are read in the project''s time zone');
select is((select org_id from app.shifts where id = (select id from c where key = 'made_1')), pg_temp.id('org_a'), 'the shifts are the project org''s');

insert into c select 'night_shift', u from unnest(app.create_shifts_from_template((select id from c where key = 'night'), pg_temp.id('prj_a'), array['2027-08-05']::date[])) u;
select results_eq($$select starts_at, ends_at from app.shifts where id = (select id from c where key = 'night_shift')$$,
  $$values ('2027-08-05 22:00 America/New_York'::timestamptz, '2027-08-06 06:00 America/New_York'::timestamptz)$$,
  'a wrap before the call ends the next day');

select throws_ok($$select app.create_shifts_from_template((select id from c where key = 'other_org'), (select id from world where key = 'prj_a'), array['2027-08-02']::date[])$$,
  'XR001', 'shift_template_unknown: Pick a shift template of this organization.', 'another org''s template is refused');
select throws_ok($$select app.create_shifts_from_template((select id from c where key = 'day'), (select id from world where key = 'prj_a'), array['2027-08-02', '2027-08-02']::date[])$$,
  'XR001', 'shift_template_days: Pick up to 31 different days to plan.', 'a day given twice is refused');
select throws_ok($$select app.create_shifts_from_template((select id from c where key = 'day'), (select id from world where key = 'prj_a'), '{}'::date[])$$,
  'XR001', 'shift_template_days: Pick at least one day to plan.', 'no day is refused');
select is((select count(*)::int from app.shifts where project_id = pg_temp.id('prj_a') and starts_at >= '2027-08-01' and starts_at < '2027-08-10'), 5,
  'a refused call plans nothing');

select pg_temp.as_user('frank');
select throws_ok($$select app.create_shifts_from_template((select id from c where key = 'day'), (select id from world where key = 'prj_a'), array['2027-08-09']::date[])$$,
  '42501', null, 'a Field member cannot plan shifts');
select pg_temp.as_user('alice');
select lives_ok($$update app.shift_templates set deleted_at = now() where id = (select id from c where key = 'day')$$, 'the owner moves a template to Trash');

select * from finish();
rollback;
