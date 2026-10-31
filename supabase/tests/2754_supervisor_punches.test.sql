-- pgTAP: migrations 2753 and 2754 (R12 parity addition G-126), a supervisor clocks in a whole team. One batch punches a
-- member, an engaged external and a roster entry in, each a Supervisor punch created by the supervisor with an open
-- time entry; a replay answers duplicate and adds nothing, even after the shift is canceled; one refused worker never fails the rest; the agency's lead
-- punches only its roster; every refusal code is reached; record_punch never writes Supervisor; one audit event per
-- call; the RPC replays offline with one signature; the supervisor never approves that time (sod_supervisor_punch).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2750_agency_world.psql

select no_plan();

create function pg_temp.shift_now(p_key text, p_column text, p_worker uuid, p_project text default 'prj_a') returns uuid
language plpgsql as $$
declare
  v uuid;
begin
  execute format('insert into app.shifts (project_id, %s, role_code, starts_at, ends_at, time_zone) values ($1, $2, %L, $3, $4, %L) returning id',
    p_column, '5000.51.02', 'America/New_York')
    into v using pg_temp.id(p_project), p_worker, now() - interval '1 hour', now() + interval '7 hours';
  insert into world values (p_key, v);
  return v;
end $$;
grant execute on function pg_temp.shift_now(text, text, uuid, text) to public;

-- {punch_id, shift_id} pairs for the batch, each punch id named <shift>_<tag> in the world.
create function pg_temp.batch(p_tag text, p_shifts text[]) returns jsonb
language plpgsql as $$
declare
  v_shift text;
  v jsonb := '[]';
begin
  foreach v_shift in array p_shifts loop
    insert into world values (v_shift || '_' || p_tag, gen_random_uuid()) on conflict (key) do nothing;
    v := v || jsonb_build_array(jsonb_build_object('punch_id', pg_temp.id(v_shift || '_' || p_tag), 'shift_id', pg_temp.id(v_shift)));
  end loop;
  return v;
end $$;
grant execute on function pg_temp.batch(text, text[]) to public;

create function pg_temp.outcomes(p_result jsonb) returns text
language sql as $$
  select string_agg(coalesce(w.key, '?') || '=' || (r ->> 'outcome') || coalesce(':' || (r ->> 'code'), ''), ' ' order by w.key)
  from jsonb_array_elements(p_result -> 'results') r
  left join world w on w.id = (r ->> 'shift_id')::uuid
$$;
grant execute on function pg_temp.outcomes(jsonb) to public;

create function pg_temp.audits() returns integer
language sql security definer as $$
  select count(*)::int from app.audit_events where action = 'time.supervisor_punches' and subject_id = pg_temp.id('prj_a')
$$;
grant execute on function pg_temp.audits() to public;

select has_function('app', 'record_supervisor_punches', 'the team punch exists');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'app' and p.proname = 'record_supervisor_punches'), 1, 'with exactly one signature');
select is((select count(*)::int from private.sync_rpcs where rpc = 'app.record_supervisor_punches'), 1, 'and it replays offline');
select ok('Supervisor' = any (enum_range(null::app.punch_source)::text[]), 'punches can come from a supervisor');
select is((select tightens from private.separation_of_duties_rules where code = 'sod_supervisor_punch'), null::text,
  'sod_supervisor_punch is a built-in rule in the registry');

-- Today's crew: frank (member), ivy (engaged external), stella and theo (roster).
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_user('carol');
select pg_temp.shift_now('now_frank', 'membership_id', pg_temp.id('frank@org_a'));
select pg_temp.shift_now('now_ivy', 'engagement_id', pg_temp.id('eng_ivy_a'));
select pg_temp.shift_now('now_slot_s', 'engagement_id', pg_temp.id('eng_agency'));
select pg_temp.shift_now('now_slot_t', 'engagement_id', pg_temp.id('eng_agency'));
select pg_temp.shift_now('now_carol', 'membership_id', pg_temp.id('carol@org_a'));
select pg_temp.shift_now('now_open', 'membership_id', null);
select pg_temp.shift_now('now_a2', 'membership_id', pg_temp.id('dave@org_a'), 'prj_a2');
select app.publish_shifts(array[pg_temp.id('now_frank'), pg_temp.id('now_ivy'), pg_temp.id('now_slot_s'), pg_temp.id('now_slot_t'),
  pg_temp.id('now_carol'), pg_temp.id('now_open'), pg_temp.id('now_a2')]);
select app.assign_roster_shift(pg_temp.id('now_slot_s'), pg_temp.id('e_stella'));
select app.assign_roster_shift(pg_temp.id('now_slot_t'), pg_temp.id('e_theo'));

-- The whole crew in -----------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into world values ('batch_1', gen_random_uuid()), ('batch_2', gen_random_uuid()), ('batch_3', gen_random_uuid()),
  ('batch_4', gen_random_uuid()), ('batch_5', gen_random_uuid());
select pg_temp.as_user('carol');
create temporary table answers (key text primary key, result jsonb);
grant select, insert on answers to public;
insert into answers values ('first', app.record_supervisor_punches(pg_temp.id('batch_1'), pg_temp.id('prj_a'), 'In', now(),
  pg_temp.batch('in', array['now_frank', 'now_ivy', 'now_slot_s'])));
select is(pg_temp.outcomes((select result from answers where key = 'first')), 'now_frank=applied now_ivy=applied now_slot_s=applied',
  'a supervisor with crew.shift.write punches a member, an engaged external and a roster entry in at once, on shifts nobody accepted');
select pg_temp.as_platform();
select is((select string_agg(distinct c.source || '/' || (c.created_by = pg_temp.id('carol'))::text, ',') from app.clock_punches c
           where c.id in (pg_temp.id('now_frank_in'), pg_temp.id('now_ivy_in'), pg_temp.id('now_slot_s_in'))), 'Supervisor/true',
  'each is a Supervisor punch created by the supervisor');
select is((select count(*)::int from app.time_entries t where t.clock_out is null and t.source = 'Mobile'
           and t.shift_id in (pg_temp.id('now_frank'), pg_temp.id('now_ivy'), pg_temp.id('now_slot_s'))), 3,
  'and opens each worker''s time entry, recorded as Mobile');
select is((select roster_entry_id from app.time_entries where shift_id = pg_temp.id('now_slot_s')), pg_temp.id('e_stella'),
  'the roster worker''s entry names the roster entry');
select pg_temp.as_user('carol');
insert into answers values ('replay', app.record_supervisor_punches(pg_temp.id('batch_1'), pg_temp.id('prj_a'), 'In', now(),
  pg_temp.batch('in', array['now_frank', 'now_ivy', 'now_slot_s'])));
select is(pg_temp.outcomes((select result from answers where key = 'replay')), 'now_frank=duplicate now_ivy=duplicate now_slot_s=duplicate',
  'replaying the batch answers duplicate for all three');
select pg_temp.as_platform();
select is((select count(*)::int from app.clock_punches where shift_id in (pg_temp.id('now_frank'), pg_temp.id('now_ivy'), pg_temp.id('now_slot_s'))), 3,
  'and adds no rows');
select is((select result - 'results' from answers where key = 'first'),
  jsonb_build_object('id', pg_temp.id('batch_1'), 'batch_id', pg_temp.id('batch_1'), 'project_id', pg_temp.id('prj_a'),
    'punch_kind', 'In', 'device_time', (select result ->> 'device_time' from answers where key = 'first')),
  'the answer is the whole batch, so it can stand as the device''s row: id, project, kind and device time');
select ok((select (result ->> 'device_time') is not null from answers where key = 'first'), 'with the device time set');
select pg_temp.as_user('carol');
select app.transition_shift(pg_temp.id('now_ivy'), 'Published', 'Canceled', 'Rained out.');
insert into answers values ('late_replay', app.record_supervisor_punches(pg_temp.id('batch_1'), pg_temp.id('prj_a'), 'In', now(),
  pg_temp.batch('in', array['now_ivy'])));
select is(pg_temp.outcomes((select result from answers where key = 'late_replay')), 'now_ivy=duplicate',
  'a replay whose first answer was lost still answers duplicate after the shift was canceled');

-- One refusal never fails the team ------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into answers values ('mixed', app.record_supervisor_punches(pg_temp.id('batch_2'), pg_temp.id('prj_a'), 'In', now(),
  pg_temp.batch('again', array['now_frank', 'now_slot_t'])));
select is(pg_temp.outcomes((select result from answers where key = 'mixed')), 'now_frank=refused:punch_already_in now_slot_t=applied',
  'a worker already in is refused while the others apply');
insert into answers values ('codes', app.record_supervisor_punches(pg_temp.id('batch_3'), pg_temp.id('prj_a'), 'In', now(),
  pg_temp.batch('try', array['now_carol', 'now_open', 'now_a2', 'sh_frank_day'])));
select is(pg_temp.outcomes((select result from answers where key = 'codes')),
  'now_a2=refused:supervisor_punch_project now_carol=refused:supervisor_punch_self now_open=refused:supervisor_punch_no_worker sh_frank_day=refused:supervisor_punch_outside_shift',
  'self, nobody on the shift, another project''s shift and tomorrow''s shift are each refused by name');
select is(pg_temp.refusal($$select app.record_supervisor_punches(pg_temp.id('batch_4'), pg_temp.id('prj_a'), 'In', now(),
  (select jsonb_agg(jsonb_build_object('punch_id', gen_random_uuid(), 'shift_id', pg_temp.id('now_frank'))) from generate_series(1, 101)))$$),
  'supervisor_punch_batch', 'at most 100 people at a time');
select is(pg_temp.refusal($$select app.record_supervisor_punches(null, pg_temp.id('prj_a'), 'In', now(), pg_temp.batch('x', array['now_frank']))$$),
  'supervisor_punch_batch_required', 'and the batch carries its id');
select is(pg_temp.refusal($$select app.record_punch(gen_random_uuid(), pg_temp.id('prj_a'), 'In', now(), null, pg_temp.id('now_frank'), p_source => 'Supervisor')$$),
  'punch_source_mobile', 'app.record_punch never writes a Supervisor punch');

-- The agency's lead ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('olga');
insert into answers values ('lead', app.record_supervisor_punches(pg_temp.id('batch_5'), pg_temp.id('prj_a'), 'Out', now() + interval '1 minute',
  pg_temp.batch('out', array['now_slot_s', 'now_frank'])));
select is(pg_temp.outcomes((select result from answers where key = 'lead')), 'now_frank=refused:supervisor_punch_not_lead now_slot_s=applied',
  'the agency''s lead punches its roster out and is refused a member''s shift');
select pg_temp.as_user('uma');
select is(pg_temp.outcomes(app.record_supervisor_punches(gen_random_uuid(), pg_temp.id('prj_a'), 'Out', now(),
  pg_temp.batch('uma', array['now_slot_t']))), 'now_slot_t=refused:supervisor_punch_not_lead', 'an Account Member is no lead');

select pg_temp.as_platform();
select is(pg_temp.audits(), 7, 'one audit event per call that ran');

-- Separation of duties --------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with t as (insert into app.timesheets (project_id, roster_entry_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('e_stella'), current_date - 1, current_date + 5) returning id)
  insert into world select 'ts_stella', id from t;
select pg_temp.as_user('stella');
select app.submit_timesheet(pg_temp.id('ts_stella'));
select pg_temp.as_user('carol');
select is(pg_temp.refusal($$select app.decide_timesheet(pg_temp.id('ts_stella'), 'Approved', 'Looks right.')$$), 'sod_supervisor_punch',
  'the supervisor who punched Stella in cannot approve her timesheet');
select pg_temp.as_user('alice');
select lives_ok($$select app.decide_timesheet(pg_temp.id('ts_stella'), 'Approved', 'Hours match the call sheet.')$$, 'another approver can');

select * from finish();
rollback;
