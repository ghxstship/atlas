-- pgTAP: migration 2983 (B9, RRR-233, ADR 0148), the org's scheduling warnings. With scheduling.min_rest_hours 10,
-- scheduling.max_daily_hours 12 and scheduling.max_weekly_hours 50: shift_rest_short for a person whose previous shift
-- ends 8 hours before the candidate shift, shift_day_over when the day totals 13 scheduled hours net of
-- scheduled_break_minutes, shift_week_over above 50 hours in the week starting on payroll.week_start; with all three at
-- 0 nothing. Writers ask about anyone, a person only about themself, 1 to 200 people at once; the other shift's id
-- appears only to a caller who reads it. Nothing is refused for policy.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select no_plan();

create function pg_temp.shift(p_key text, p_membership text, p_from text, p_to text, p_break integer default null) returns void
language plpgsql as $$
declare
  v_id uuid;
begin
  perform pg_temp.as_user('carol');
  insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone, scheduled_break_minutes)
  values (pg_temp.id('prj_a'), case when p_membership is null then null else pg_temp.id(p_membership) end, '0000.50.01',
          (p_from || ' America/New_York')::timestamptz, (p_to || ' America/New_York')::timestamptz, 'America/New_York', p_break)
  returning id into v_id;
  perform pg_temp.as_platform();
  insert into world values (p_key, v_id);
end $$;

create function pg_temp.codes(p_person text) returns text
language sql security definer as $$
  select coalesce(string_agg(w.code || ':' || w.minutes || '/' || w.limit_minutes, ',' order by w.code, w.minutes), '')
  from private.shift_policy_warnings(pg_temp.id('cand'), pg_temp.id(p_person)) w
$$;
grant execute on function pg_temp.codes(text) to public;

-- The candidate: Wednesday 8 September 2027, 10:00 to 18:00 in New York (8 hours), open.
select pg_temp.shift('cand', null, '2027-09-08 10:00', '2027-09-08 18:00');
-- Frank: the night before, ending at 02:00, 8 hours before the candidate.
select pg_temp.shift('f1', 'frank@org_a', '2027-09-07 20:00', '2027-09-08 02:00');
-- Mia: 00:00 to 06:00 the same day with an hour's scheduled break, 5 hours net: 13 with the candidate.
select pg_temp.shift('m1', 'mia@org_a', '2027-09-08 00:00', '2027-09-08 06:00', 60);
-- Dave: 10 hours on each of Sunday, Monday, Tuesday, Thursday and Friday of that week: 58 with the candidate.
select pg_temp.shift('d1', 'dave@org_a', '2027-09-05 08:00', '2027-09-05 18:00');
select pg_temp.shift('d2', 'dave@org_a', '2027-09-06 08:00', '2027-09-06 18:00');
select pg_temp.shift('d3', 'dave@org_a', '2027-09-07 08:00', '2027-09-07 18:00');
select pg_temp.shift('d4', 'dave@org_a', '2027-09-09 08:00', '2027-09-09 18:00');
select pg_temp.shift('d5', 'dave@org_a', '2027-09-10 08:00', '2027-09-10 18:00');

select pg_temp.as_platform();
select is(pg_temp.codes('frank') || pg_temp.codes('mia') || pg_temp.codes('dave'), '', 'with every limit at 0 (the default), nothing warns');

select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'scheduling.min_rest_hours', 'Organization', pg_temp.id('org_a'), p_value_integer => 10);
select app.set_setting(pg_temp.id('org_a'), 'scheduling.max_daily_hours', 'Organization', pg_temp.id('org_a'), p_value_integer => 12);
select app.set_setting(pg_temp.id('org_a'), 'scheduling.max_weekly_hours', 'Organization', pg_temp.id('org_a'), p_value_integer => 50);
select app.set_setting(pg_temp.id('org_a'), 'payroll.week_start', 'Organization', pg_temp.id('org_a'), p_value_text => 'sunday');

select pg_temp.as_platform();
select is(pg_temp.codes('frank'), 'shift_rest_short:480/600', 'a previous shift ending 8 hours before is under the 10 hour rest');
select ok(pg_temp.codes('mia') like '%shift_day_over:780/720%', 'the day totals 13 scheduled hours net of the scheduled break, over 12');
select is(pg_temp.codes('dave'), 'shift_week_over:3480/3000', 'the week from Sunday totals 58 hours, over 50');
select is(pg_temp.codes('gina'), '', 'someone with no other shift gets no warning');

-- The week starts on payroll.week_start: from Monday, Sunday's 10 hours fall in the week before.
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'payroll.week_start', 'Organization', pg_temp.id('org_a'), p_value_text => 'monday');
select pg_temp.as_platform();
select is(pg_temp.codes('dave'), '', 'from Monday the week holds 48 hours, under 50');

-- Who asks --------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select results_eq(format($$select person_id, code, other_shift_id from app.shift_policy_warnings(%L, array[%L]::uuid[])$$,
    pg_temp.id('cand'), pg_temp.id('frank')),
  format($$values (%L::uuid, 'shift_rest_short'::text, %L::uuid)$$, pg_temp.id('frank'), pg_temp.id('f1')),
  'a shift writer reads anyone''s warnings, with the shift they come from');
select throws_ok(format($$select * from app.shift_policy_warnings(%L, '{}'::uuid[])$$, pg_temp.id('cand')), 'XR001',
  'shift_policy_batch: Ask about 1 to 200 people at a time.', 'at least one person');
select throws_ok(format($$select * from app.shift_policy_warnings(%L, (select array_agg(gen_random_uuid()) from generate_series(1, 201)))$$,
  pg_temp.id('cand')), 'XR001', 'shift_policy_batch: Ask about 1 to 200 people at a time.', 'at most 200 people');
select pg_temp.as_user('frank');
select results_eq(format($$select code, other_shift_id from app.shift_policy_warnings(%L, array[%L]::uuid[])$$,
    pg_temp.id('cand'), pg_temp.id('frank')),
  format($$values ('shift_rest_short'::text, %L::uuid)$$, pg_temp.id('f1')),
  'a person asks about themself and sees their own shift');
select throws_ok(format($$select * from app.shift_policy_warnings(%L, array[%L]::uuid[])$$, pg_temp.id('cand'), pg_temp.id('mia')),
  '42501', null, 'but not about anyone else');

-- Warnings never refuse
select pg_temp.as_user('carol');
select lives_ok(format($$select app.assign_open_shift(%L, %L)$$, pg_temp.id('cand'), pg_temp.id('frank@org_a')),
  'the warned person is still assigned');

select * from finish();
rollback;
