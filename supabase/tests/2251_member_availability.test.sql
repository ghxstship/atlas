-- pgTAP: migration 2251, members' availability and the org's availability window (A132, RRR-194, ADR 0063).
-- A member opens their calendar kept for the org and states periods on it; the org's planners read it and others do
-- not. While scheduling.availability_required is on, periods inside scheduling.availability_notice_days are locked
-- (notes stay editable), app.my_availability_status lists the unstated days up to scheduling.availability_horizon_days,
-- and app.rank_shift_candidates ranks members for a shift by overlap, availability, role and hours.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(23);

create temporary table c (key text primary key, id uuid);
grant select, insert on c to public;

-- Midnight n days from today on the New York calendar, the zone of the member's calendar and of prj_a.
create function pg_temp.ny_day(p_days integer) returns timestamptz
language sql stable as $$
  select ((now() at time zone 'America/New_York')::date + p_days)::timestamp at time zone 'America/New_York'
$$;

-- The member's calendar -------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
insert into c select 'frank_cal', app.ensure_member_availability_calendar(pg_temp.id('org_a'), 'America/New_York');
select is(app.ensure_member_availability_calendar(pg_temp.id('org_a')), (select id from c where key = 'frank_cal'),
  'a member has one calendar for the org');
select results_eq($$select org_id, person_id, time_zone from app.availability_calendars where id = (select id from c where key = 'frank_cal')$$,
  $$values ((select id from world where key = 'org_a'), (select id from world where key = 'frank'), 'America/New_York'::text)$$,
  'the calendar is the member''s own, kept for the org');
select throws_ok($$select app.ensure_member_availability_calendar((select id from world where key = 'org_b'))$$,
  '42501', null, 'a person opens a calendar only for an org they belong to');

-- Periods: tomorrow (inside the default 7-day notice) and in ten days.
with x as (insert into app.availability_blocks (availability_calendar_id, starts_at, ends_at, availability_kind, note)
  values ((select id from c where key = 'frank_cal'), pg_temp.ny_day(1), pg_temp.ny_day(2), 'Available', 'Dentist after 6') returning id)
insert into c select 'tomorrow', id from x;
with x as (insert into app.availability_blocks (availability_calendar_id, starts_at, ends_at, availability_kind)
  values ((select id from c where key = 'frank_cal'), pg_temp.ny_day(10), pg_temp.ny_day(11), 'Available') returning id)
insert into c select 'ten_days', id from x;
select is((select count(*)::int from c where key in ('tomorrow', 'ten_days')), 2, 'while availability is optional, a member states any period');

-- Who reads it
select pg_temp.as_user('carol');
select is((select count(*)::int from app.availability_calendars where id = (select id from c where key = 'frank_cal')), 1,
  'a planner (crew.shift.write) reads a member''s calendar kept for the org, though Private');
select is((select count(*)::int from api_external.availability where availability_calendar_id = (select id from c where key = 'frank_cal')), 2,
  'and its periods, without the notes');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.availability_calendars where id = (select id from c where key = 'frank_cal')), 0,
  'a viewer without crew.shift.write does not');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.availability_calendars where id = (select id from c where key = 'frank_cal')), 0,
  'another org does not');

-- The rule ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is((select row(r.required, r.notice_days, r.horizon_days)::text from private.availability_rule(pg_temp.id('org_a')) r), '(f,7,28)',
  'by default availability is optional, with 7 days of notice and a 28-day horizon');
select pg_temp.as_user('carol');
select throws_ok($$select app.set_setting((select id from world where key = 'org_a'), 'scheduling.availability_required', 'Organization', (select id from world where key = 'org_a'), p_value_boolean => true)$$,
  '42501', null, 'a manager without org.scheduling.write cannot set the rule');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'scheduling.availability_required', 'Organization', pg_temp.id('org_a'), p_value_boolean => true);

select pg_temp.as_user('frank');
select throws_ok($$insert into app.availability_blocks (availability_calendar_id, starts_at, ends_at, availability_kind) values ((select id from c where key = 'frank_cal'), now() + interval '2 days', now() + interval '2 days 8 hours', 'Unavailable')$$,
  'XR001', 'availability_inside_notice: Availability for the next 7 days is locked; ask a scheduler to change it.',
  'while required, a new period inside the notice period is refused');
select throws_ok($$update app.availability_blocks set availability_kind = 'Unavailable' where id = (select id from c where key = 'tomorrow')$$,
  'XR001', null, 'a period inside the notice period cannot be changed');
select throws_ok($$update app.availability_blocks set deleted_at = now() where id = (select id from c where key = 'tomorrow')$$,
  'XR001', null, 'or removed');
select lives_ok($$update app.availability_blocks set note = 'Dentist moved' where id = (select id from c where key = 'tomorrow')$$,
  'its note stays editable');
select lives_ok($$update app.availability_blocks set availability_kind = 'Tentative' where id = (select id from c where key = 'ten_days')$$,
  'a period after the notice period changes freely');

select results_eq($$select required, notice_days, horizon_days, cardinality(unstated_days) from app.my_availability_status((select id from world where key = 'org_a'))$$,
  $$values (true, 7, 28, 20)$$, 'the member''s status names the 21 days from the notice period to the horizon, one of them stated');

select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'scheduling.availability_notice_days', 'Organization', pg_temp.id('org_a'), p_value_integer => 0);
select pg_temp.as_user('frank');
select lives_ok($$insert into app.availability_blocks (availability_calendar_id, starts_at, ends_at, availability_kind) values ((select id from c where key = 'frank_cal'), now() + interval '2 days', now() + interval '2 days 8 hours', 'Unavailable')$$,
  'with no notice days, a period two days out is accepted');

-- Ranking --------------------------------------------------------------------------------------------------------------
-- A shift in ten days, inside frank's Tentative day; mia is Unavailable then; dave holds an overlapping shift.
select pg_temp.as_user('mia');
insert into c select 'mia_cal', app.ensure_member_availability_calendar(pg_temp.id('org_a'));
insert into app.availability_blocks (availability_calendar_id, starts_at, ends_at, availability_kind)
values ((select id from c where key = 'mia_cal'), pg_temp.ny_day(10), pg_temp.ny_day(11), 'Unavailable');
select pg_temp.as_user('carol');
with x as (insert into app.shifts (project_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), '0000.50.01', pg_temp.ny_day(10) + interval '12 hours', pg_temp.ny_day(10) + interval '18 hours', 'America/New_York') returning id)
insert into c select 'shift', id from x;
insert into app.shifts (project_id, membership_id, starts_at, ends_at, time_zone)
values (pg_temp.id('prj_a'), pg_temp.id('dave@org_a'), pg_temp.ny_day(10) + interval '14 hours', pg_temp.ny_day(10) + interval '20 hours', 'America/New_York');

create temporary table ranked as select * from app.rank_shift_candidates((select id from c where key = 'shift'));
grant select on ranked to public;
select is((select availability from ranked where membership_id = pg_temp.id('frank@org_a')), 'Tentative', 'frank''s Tentative day ranks him Tentative');
select is((select availability from ranked where membership_id = pg_temp.id('mia@org_a')), 'Unavailable', 'mia is Unavailable');
select ok((select conflict from ranked where membership_id = pg_temp.id('dave@org_a')), 'dave holds an overlapping shift');
select ok((select candidate_rank from ranked where membership_id = pg_temp.id('frank@org_a'))
  < (select candidate_rank from ranked where membership_id = pg_temp.id('mia@org_a'))
  and (select candidate_rank from ranked where membership_id = pg_temp.id('mia@org_a'))
  < (select candidate_rank from ranked where membership_id = pg_temp.id('dave@org_a')),
  'Tentative ranks above Unavailable, and an overlapping shift ranks last');
select ok((select overdue from ranked where membership_id = pg_temp.id('erin@org_a')) and not (select overdue from ranked where membership_id = pg_temp.id('frank@org_a')),
  'while required, a member with nothing stated for a shift inside the horizon is overdue');

select pg_temp.as_user('frank');
select throws_ok($$select * from app.rank_shift_candidates((select id from c where key = 'shift'))$$,
  '42501', null, 'only planners rank candidates');

select * from finish();
rollback;
