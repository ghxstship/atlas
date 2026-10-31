-- pgTAP: migration 2755 (R12 review repairs). The shift editor's app.save_roster_shift places agency staff in one
-- transaction, so a refused placement leaves no slot behind and keeps the member on their shift; it takes a person off
-- the roster and onto a member in one step too. An agency staff member's submitted timesheet asks for approval with
-- their name and never asks them, and they submit it from Gateway's bulk table.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2750_agency_world.psql

select no_plan();

create function pg_temp.save(p_shift text, p_membership uuid, p_engagement uuid, p_entry uuid, p_from numeric, p_to numeric)
returns uuid
language sql as $$
  select app.save_roster_shift(pg_temp.id(p_shift), pg_temp.id('org_a'), pg_temp.id('prj_a'), '5000.51.02',
    pg_temp.at_day(p_from), pg_temp.at_day(p_to), 'America/New_York', p_membership, p_engagement, p_entry, 'Moved.')
$$;
grant execute on function pg_temp.save(text, uuid, uuid, uuid, numeric, numeric) to public;

create function pg_temp.holder(p_shift text) returns text
language sql security definer as $$
  select coalesce(w_m.key, w_e.key, w_r.key, 'nobody') || '/' || s.shift_state
  from app.shifts s
  left join world w_m on w_m.id = s.membership_id
  left join world w_e on w_e.id = s.engagement_id
  left join world w_r on w_r.id = s.roster_entry_id
  where s.id = pg_temp.id(p_shift)
$$;
grant execute on function pg_temp.holder(text) to public;

create function pg_temp.shifts_on_prj() returns integer
language sql security definer as $$
  select count(*)::int from app.shifts where project_id = pg_temp.id('prj_a') and deleted_at is null
$$;
grant execute on function pg_temp.shifts_on_prj() to public;

select has_function('app', 'save_roster_shift', 'the shift editor saves through one function');
select is((select prosecdef from pg_proc where oid = 'app.save_roster_shift(uuid, uuid, uuid, text, timestamptz, timestamptz, text, uuid, uuid, uuid, text)'::regprocedure),
  false, 'which runs as the caller, so the shift''s own policies and guards decide the write');

-- Placing through the editor -----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is(pg_temp.holder('slot_1'), 'eng_agency/Published', 'slot_1 is the agency''s slot');
select lives_ok($$select pg_temp.save('slot_1', null, pg_temp.id('eng_agency'), pg_temp.id('e_stella'), 8, 16)$$,
  'a planner places Stella on the agency''s slot from the editor');
select is(pg_temp.holder('slot_1'), 'e_stella/Published', 'the slot now names her roster entry');

select is(pg_temp.refusal($$select pg_temp.save('sh_frank_day', null, pg_temp.id('eng_agency'), pg_temp.id('e_stella'), 8, 16)$$),
  'roster_shift_overlap', 'moving Frank''s shift to Stella while she works slot_1 is refused');
select is(pg_temp.holder('sh_frank_day'), 'frank@org_a/Published', 'and Frank keeps his shift: the refusal undid the move to the slot');

select is(pg_temp.refusal($$select app.save_roster_shift(null, pg_temp.id('org_a'), pg_temp.id('prj_a'), '5000.51.02',
    pg_temp.at_day(20), pg_temp.at_day(23), 'America/New_York', null, pg_temp.id('eng_agency'), pg_temp.id('e_stella'))$$),
  null, 'a new evening shift for Stella saves');
create temporary table counts (n integer);
grant all on counts to public;
insert into counts select pg_temp.shifts_on_prj();
select is(pg_temp.refusal($$select app.save_roster_shift(null, pg_temp.id('org_a'), pg_temp.id('prj_a'), '5000.51.02',
    pg_temp.at_day(9), pg_temp.at_day(12), 'America/New_York', null, pg_temp.id('eng_agency'), pg_temp.id('e_stella'))$$),
  'roster_shift_overlap', 'a new shift overlapping her day is refused');
select is(pg_temp.shifts_on_prj(), (select n from counts), 'and leaves no agency slot behind');
select is(pg_temp.refusal($$select pg_temp.save('slot_2', pg_temp.id('frank@org_a'), pg_temp.id('eng_agency'), null, 10, 18)$$),
  'roster_shift_worker', 'a shift names one worker');

-- Off the roster in one step ---------------------------------------------------------------------------------------------------------
select lives_ok($$select pg_temp.save('slot_1', pg_temp.id('dave@org_a'), null, null, 9, 17)$$,
  'the planner gives Stella''s shift to Dave, with new times');
select is(pg_temp.holder('slot_1'), 'dave@org_a/Published', 'it leaves the roster and names Dave');
select is((select to_char(starts_at at time zone 'UTC', 'HH24:MI') from app.shifts where id = pg_temp.id('slot_1')), '09:00',
  'with the new times');
select pg_temp.as_user('dave');
select throws_ok($$select pg_temp.save('slot_2', null, pg_temp.id('eng_agency'), pg_temp.id('e_theo'), 10, 18)$$, '42501', null,
  'a member without crew.shift.write cannot place agency staff from the editor');
select is(pg_temp.holder('slot_2'), 'eng_agency/Published', 'and the slot is unchanged');

-- Approval requests name agency staff ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with t as (insert into app.timesheets (project_id, roster_entry_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('e_stella'), current_date, current_date + 6) returning id)
  insert into world select 'ts_stella', id from t;
select pg_temp.as_user('stella');
select is(app.bulk_update_my_timesheets(jsonb_build_array(jsonb_build_object('id', pg_temp.id('ts_stella'),
  'set', jsonb_build_object('timesheet_state', 'Submitted')))) -> 'refused' -> 0 ->> 'rule', null,
  'Stella submits her timesheet from Gateway''s bulk table');
select pg_temp.as_platform();
select is((select timesheet_state::text from app.timesheets where id = pg_temp.id('ts_stella')), 'Submitted', 'it is submitted');
select ok((select bool_and(n.message_args ->> 'title' like 'Timesheet Stella Okafor, %' and n.message_args ->> 'workerName' = 'Stella Okafor')
           from app.notifications n where n.subject_id = pg_temp.id('ts_stella') and n.kind = 'approval.requested'),
  'every approval request names Stella');
select ok((select count(*) > 0 from app.notifications n where n.subject_id = pg_temp.id('ts_stella') and n.kind = 'approval.requested'),
  'and approvers are asked');
select is((select count(*)::int from app.notifications n where n.subject_id = pg_temp.id('ts_stella') and n.kind = 'approval.requested'
           and n.recipient_person_id = pg_temp.id('stella')), 0, 'Stella is never asked to approve her own time');

select * from finish();
rollback;
