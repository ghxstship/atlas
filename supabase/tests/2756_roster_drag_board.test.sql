-- pgTAP: migration 2756 (R12 with A132), agency staff on the schedule's drag board. The accepted people of the agency's
-- roster are ranked for an open shift, free people and the availability they share first; planners alone rank them; a
-- drop makes the open shift the agency's slot and places the person in one step, and a refused drop leaves it open.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2750_agency_world.psql

select no_plan();

create function pg_temp.ranked(p_shift text) returns text
language sql as $$
  select string_agg(w.key || ':' || r.availability || case when r.conflict then ':busy' else '' end, ' ' order by r.candidate_rank)
  from app.rank_roster_candidates(pg_temp.id(p_shift)) r
  join world w on w.id = r.roster_entry_id
$$;
grant execute on function pg_temp.ranked(text) to public;

create function pg_temp.holder(p_shift text) returns text
language sql security definer as $$
  select coalesce(w_m.key, w_e.key, w_r.key, 'nobody')
  from app.shifts s
  left join world w_m on w_m.id = s.membership_id
  left join world w_e on w_e.id = s.engagement_id
  left join world w_r on w_r.id = s.roster_entry_id
  where s.id = pg_temp.id(p_shift)
$$;
grant execute on function pg_temp.holder(text) to public;

-- Stella shares a Public calendar that has her available all of tomorrow; Theo works slot_2 (10:00 to 18:00).
select pg_temp.as_platform();
with c as (insert into app.availability_calendars (person_id, time_zone, visibility)
  values (pg_temp.id('stella'), 'America/New_York', 'Public') returning id)
  insert into app.availability_blocks (availability_calendar_id, starts_at, ends_at, availability_kind)
  select id, pg_temp.at_day(0), pg_temp.at_day(24), 'Available' from c;
select pg_temp.as_user('olga');
select app.assign_roster_shift(pg_temp.id('slot_2'), pg_temp.id('e_theo'));

select pg_temp.as_user('carol');
select is(pg_temp.ranked('sh_open'), 'e_stella:Available e_theo:Unstated:busy',
  'the agency''s accepted people are ranked for the open shift: Stella, free and available, before Theo, busy then');
select is((select count(*)::int from app.rank_roster_candidates(pg_temp.id('sh_open')) r
           where r.person_id in (pg_temp.id('uma'), pg_temp.id('vic'))), 0, 'people without an accepted entry are not ranked');
select is((select r.account_name from app.rank_roster_candidates(pg_temp.id('sh_open')) r limit 1), 'Crestline Staffing',
  'each with their agency');
select pg_temp.as_user('dave');
select throws_ok($$select * from app.rank_roster_candidates(pg_temp.id('sh_open'))$$, '42501', null,
  'only a planner with crew.shift.write ranks them');

-- A drop on the open shift ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is(pg_temp.refusal($$select app.assign_open_shift_to_roster(pg_temp.id('sh_open'), pg_temp.id('e_theo'))$$),
  'roster_shift_overlap', 'dropping Theo, who works slot_2 then, is refused');
select is(pg_temp.holder('sh_open'), 'nobody', 'and the shift stays open, not the agency''s slot');
select lives_ok($$select app.assign_open_shift_to_roster(pg_temp.id('sh_open'), pg_temp.id('e_stella'))$$,
  'dropping Stella places her');
select is(pg_temp.holder('sh_open'), 'e_stella', 'the shift names her roster entry');
select is(pg_temp.refusal($$select app.assign_open_shift_to_roster(pg_temp.id('sh_open'), pg_temp.id('e_theo'))$$),
  'shift_already_filled', 'a second drop on the same shift is refused');
select pg_temp.as_user('dave');
select throws_ok($$select app.assign_open_shift_to_roster(pg_temp.id('slot_1'), pg_temp.id('e_theo'))$$, '42501', null,
  'and a member without crew.shift.write cannot drop anyone');

select * from finish();
rollback;
