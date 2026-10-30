-- pgTAP: migration 2963 (B7, RRR-231, ADR 0146 decisions 2 and 3; G-52), app.day_sheet_schedule. A day sheet for a team
-- or a department lists only that audience's shifts of the project's local day and its records starting or due that
-- day, with the scenario of 2961 (a team, a department by role and by Department group, an ended membership); the
-- reader's own reach still applies; the refusals and not-found answers the document route maps to 400 and 404.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update on k to public;

create function pg_temp.ids(p_sheet text, p_team text, p_dept text, p_part text) returns setof uuid
language sql as $$
  select x::uuid from jsonb_array_elements_text(app.day_sheet_schedule(pg_temp.id(p_sheet), pg_temp.id(p_team), p_dept) -> p_part) x
$$;

-- The audience scenario of 2961.
select pg_temp.as_platform();
insert into app.team_members (team_id, membership_id) values (pg_temp.id('team_a'), pg_temp.id('gina@org_a'));
set local session_replication_role = replica;
insert into app.role_assignments (org_id, project_id, role_code, person_id, staffing_basis, assignment_state)
values (pg_temp.id('org_a'), pg_temp.id('prj_a'), '5000.50.01', pg_temp.id('frank'), 'Declared', 'Active');
update app.memberships set valid_from = now() - interval '1 day', valid_to = now() - interval '1 minute' where id = pg_temp.id('gina@org_a');
set local session_replication_role = origin;
insert into k (key, id) values ('dept_group', gen_random_uuid());
insert into app.groups (id, org_id, name, group_kind, department_code)
values ((select id from k where key = 'dept_group'), pg_temp.id('org_a'), 'Production crew', 'Department', '5000');
insert into app.group_members (group_id, membership_id) values ((select id from k where key = 'dept_group'), pg_temp.id('erin@org_a'));

-- 2027-06-05 in New York: shifts of erin, frank (Production role), dave, gina (ended) and an open Production shift; one of
-- erin's on the next local day (03:30 UTC on the 6th is still the 5th in New York; 04:30 is the 6th).
insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone)
select pg_temp.id('prj_a'), m, r, s::timestamptz, s::timestamptz + interval '6 hours', 'America/New_York'
from (values (pg_temp.id('erin@org_a'), '0000.50.01', '2027-06-05 14:00+00'), (pg_temp.id('frank@org_a'), '5000.50.01', '2027-06-05 15:00+00'),
  (pg_temp.id('dave@org_a'), '0000.50.01', '2027-06-05 16:00+00'), (null::uuid, '5000.51.02', '2027-06-06 03:30+00'),
  (pg_temp.id('erin@org_a'), '0000.50.01', '2027-06-06 04:30+00')) v (m, r, s);
insert into world select case when s.membership_id is null then 'open_shift'
    when s.starts_at = '2027-06-06 04:30+00' then 'erin_next' else lower(split_part(p.full_name, ' ', 1)) || '_shift' end, s.id
from app.shifts s left join app.memberships m on m.id = s.membership_id left join app.people p on p.id = m.person_id
where s.project_id = pg_temp.id('prj_a');
set local session_replication_role = replica;
insert into app.shifts (org_id, project_id, membership_id, role_code, starts_at, ends_at, time_zone)
values (pg_temp.id('org_a'), pg_temp.id('prj_a'), pg_temp.id('gina@org_a'), '0000.50.01', '2027-06-05 17:00+00', '2027-06-05 23:00+00', 'America/New_York');
set local session_replication_role = origin;
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis, starts_at, time_zone)
  values (pg_temp.id('prj_a'), 'Meeting', 'Lighting focus', 'Y', 'Declared', '2027-06-05 18:00+00', 'America/New_York') returning id)
  insert into world select 'meeting', id from r;
insert into app.record_assignments (record_id, membership_id) values (pg_temp.id('meeting'), pg_temp.id('erin@org_a'));
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis, due_at, time_zone, owner_party_id)
  values (pg_temp.id('prj_a'), 'Milestone', 'Rig signed off', 'Y', 'Declared', '2027-06-05 20:00+00', 'America/New_York', pg_temp.id('frank')) returning id)
  insert into world select 'milestone', id from r;
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis, due_at, time_zone, owner_party_id)
  values (pg_temp.id('prj_a'), 'Deadline', 'Advance due', 'Y', 'Declared', '2027-06-06 20:00+00', 'America/New_York', pg_temp.id('frank')) returning id)
  insert into world select 'next_deadline', id from r;

select pg_temp.as_user('dave');
with d as (insert into app.day_sheets (project_id, day, body) values (pg_temp.id('prj_a'), '2027-06-05', 'Doors 19:00.') returning id)
  insert into world select 'sheet', id from d;
select pg_temp.as_user('xavier');
with d as (insert into app.day_sheets (project_id, day, body) values (pg_temp.id('prj_b'), '2027-06-05', 'Pier closed.') returning id)
  insert into world select 'sheet_b', id from d;

-- A team -----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is(app.day_sheet_schedule(pg_temp.id('sheet'), pg_temp.id('team_a')) ->> 'audience_name', 'Load-In Crew', 'a team sheet names the team');
select set_eq($$select pg_temp.ids('sheet', 'team_a', null, 'shift_ids')$$, array[pg_temp.id('erin_shift')],
  'it lists only the team''s live members'' shifts that start on the project''s local day');
select set_eq($$select pg_temp.ids('sheet', 'team_a', null, 'record_ids')$$, array[pg_temp.id('meeting')],
  'and only the records assigned to, owned by or accountable to them that day');

-- A department ---------------------------------------------------------------------------------------------------------------------
select is(app.day_sheet_schedule(pg_temp.id('sheet'), null, '5000') ->> 'audience_name',
  (select department::text from xpms.dim_department where dept_code = '5000'), 'a department sheet names the department');
select set_eq($$select pg_temp.ids('sheet', null, '5000', 'shift_ids')$$,
  array[pg_temp.id('erin_shift'), pg_temp.id('frank_shift'), pg_temp.id('open_shift')],
  'it lists its role holders'' and group members'' shifts and the shifts in its roles, open shifts included');
select set_eq($$select pg_temp.ids('sheet', null, '5000', 'record_ids')$$, array[pg_temp.id('meeting'), pg_temp.id('milestone')],
  'and its members'' records of that day only');

-- Reach and refusals -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select set_eq($$select pg_temp.ids('sheet', null, '5000', 'shift_ids')$$, array[pg_temp.id('frank_shift')],
  'a reader who sees only their own shift sees only it, whatever the audience');
select pg_temp.as_user('dave');
select throws_ok(format($$select app.day_sheet_schedule(%L, %L, '5000')$$, pg_temp.id('sheet'), pg_temp.id('team_a')),
  'XR001', 'day_sheet_audience: Choose one audience for the day sheet: a team or a department.', 'a team and a department at once are refused');
select throws_ok(format($$select app.day_sheet_schedule(%L)$$, pg_temp.id('sheet')), 'XR001', null, 'and so is no audience');
select throws_ok(format($$select app.day_sheet_schedule(%L, null, '5100')$$, pg_temp.id('sheet')),
  'XR001', 'day_sheet_audience: That department does not exist.', 'an unknown department is refused');
select throws_ok(format($$select app.day_sheet_schedule(%L, %L)$$, pg_temp.id('sheet'), pg_temp.id('team_b')),
  '42501', 'team not found', 'another org''s team is not found');
select throws_ok(format($$select app.day_sheet_schedule(%L, %L)$$, pg_temp.id('sheet_b'), pg_temp.id('team_a')),
  '42501', 'day sheet not found', 'another org''s day sheet is not found');
select pg_temp.as_user('gina');
select throws_ok(format($$select app.day_sheet_schedule(%L, %L)$$, pg_temp.id('sheet'), pg_temp.id('team_a')),
  '42501', 'day sheet not found', 'a reader without show.run_of_show.read on the project gets nothing');
select pg_temp.as_platform();
update app.day_sheets set deleted_at = now() where id = pg_temp.id('sheet');
select pg_temp.as_user('dave');
select throws_ok(format($$select app.day_sheet_schedule(%L, %L)$$, pg_temp.id('sheet'), pg_temp.id('team_a')),
  '42501', 'day sheet not found', 'a deleted sheet is not found');

select * from finish();
rollback;
