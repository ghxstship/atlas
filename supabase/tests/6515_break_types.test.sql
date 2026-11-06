-- pgTAP: migration 6515 (B9, RRR-233, ADR 0148), break types. An org's members read its break types, external workers
-- through api_external.break_types; org.time_attendance.write writes them, one default per org. A Break Start with a
-- paid type followed by Break End adds the minutes to time_entries.paid_break_minutes and leaves break_minutes alone;
-- an untyped break takes the org's default (unpaid here) and an Out closing it adds to break_minutes as before; another
-- org's type refuses break_type_unknown. A paid break counts as worked time. Retiring the default clears it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2750_agency_world.psql

select no_plan();

select pg_temp.as_user('alice');
with x as (insert into app.break_types (org_id, name, paid, planned_minutes, is_default)
  values (pg_temp.id('org_a'), 'Meal break', false, 30, true) returning id) insert into world select 'bt_meal', id from x;
with x as (insert into app.break_types (org_id, name, paid, planned_minutes)
  values (pg_temp.id('org_a'), 'Rest break', true, 15) returning id) insert into world select 'bt_rest', id from x;
select throws_ok(format($$insert into app.break_types (org_id, name, is_default) values (%L, 'Second default', true)$$, pg_temp.id('org_a')),
  '23505', null, 'one default per org');
select throws_ok(format($$insert into app.break_types (org_id, name) values (%L, ' meal BREAK')$$, pg_temp.id('org_a')),
  '23505', null, 'names are unique among the org''s live types');
select pg_temp.as_user('xavier');
with x as (insert into app.break_types (org_id, name, paid) values (pg_temp.id('org_b'), 'Harbor rest', true) returning id)
insert into world select 'bt_other', id from x;

-- Who reads and writes -------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select is((select count(*)::int from app.break_types), 2, 'members read their org''s break types');
select throws_ok(format($$insert into app.break_types (org_id, name) values (%L, 'Smoke break')$$, pg_temp.id('org_a')),
  '42501', null, 'without org.time_attendance.write nobody adds one');
select pg_temp.as_user('stella');
select is((select count(*)::int from app.break_types), 0, 'an external worker reads none from the app table');
select is((select array_agg(name order by name) from api_external.break_types), array['Meal break', 'Rest break'],
  'but reads the break types of the org they work for through api_external.break_types');

-- Breaks on punches -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '0000.50.01', now() - interval '1 hour', now() + interval '7 hours', 'America/New_York')
  returning id) insert into world select 'sh_b', id from x;
select app.publish_shifts(array[pg_temp.id('sh_b')]);
select pg_temp.as_user('frank');
select app.accept_shift(pg_temp.id('sh_b'));
select app.record_punch(gen_random_uuid(), pg_temp.id('prj_a'), 'In', now() - interval '50 minutes', p_shift_id => pg_temp.id('sh_b'));
select throws_ok(format($$select app.record_punch(gen_random_uuid(), %L, 'Break Start', now() - interval '45 minutes', p_break_type_id => %L)$$,
  pg_temp.id('prj_a'), pg_temp.id('bt_other')), 'XR001',
  'break_type_unknown: That break type is retired or belongs to another organization. Pick one of this organization''s break types.',
  'another org''s break type is refused');
select app.record_punch(gen_random_uuid(), pg_temp.id('prj_a'), 'Break Start', now() - interval '40 minutes', p_break_type_id => pg_temp.id('bt_rest'));
select app.record_punch(gen_random_uuid(), pg_temp.id('prj_a'), 'Break End', now() - interval '25 minutes');
select pg_temp.as_platform();
select results_eq(format($$select paid_break_minutes, break_minutes from app.time_entries where shift_id = %L$$, pg_temp.id('sh_b')),
  $$values (15, 0)$$, 'a paid break''s minutes go to paid_break_minutes and break_minutes is unchanged');
select is((select break_type_id from app.clock_punches where shift_id = pg_temp.id('sh_b') and punch_kind = 'Break Start'),
  pg_temp.id('bt_rest'), 'the Break Start carries its type');
select pg_temp.as_user('frank');
select app.record_punch(gen_random_uuid(), pg_temp.id('prj_a'), 'Break Start', now() - interval '20 minutes');
select app.record_punch(gen_random_uuid(), pg_temp.id('prj_a'), 'Out', now() - interval '5 minutes');
select pg_temp.as_platform();
select results_eq(format($$select paid_break_minutes, break_minutes from app.time_entries where shift_id = %L$$, pg_temp.id('sh_b')),
  $$values (15, 15)$$, 'an untyped break takes the org''s default, unpaid here, and an Out closing it adds to break_minutes');
select is((select count(*)::int from app.clock_punches where shift_id = pg_temp.id('sh_b') and punch_kind = 'Break Start'
  and break_type_id = pg_temp.id('bt_meal')), 1, 'the default type is stored on that Break Start');
select ok(exists (select 1 from pg_constraint where conname = 'clock_punches_break_type' and conrelid = 'app.clock_punches'::regclass),
  'only a Break Start carries a break type');
-- Worked time: the entry's length less only the unpaid break; the paid quarter hour is paid as worked time.
select is((select (extract(epoch from (clock_out - clock_in)) / 60)::integer - break_minutes from app.time_entries where shift_id = pg_temp.id('sh_b')),
  30, 'worked minutes are 45 less the 15 unpaid, the paid 15 included');

-- Payroll pays a paid break as worked time ----------------------------------------------------------------------------------------------
-- Two 8-hour days in a pinned week: a 15-minute paid break costs nothing, a 15-minute unpaid break costs 0.25 hours.
select pg_temp.as_user('bob');
insert into app.pay_rates (membership_id, role_code, rate_minor, currency_code, effective_from)
values (pg_temp.id('frank@org_a'), '0000.50.01', 3200, 'USD', '2027-01-01');
insert into app.earning_codes (org_id, code, name) values (pg_temp.id('org_a'), 'REG', 'Regular');
select pg_temp.as_platform();
insert into app.time_entries (project_id, membership_id, clock_in, clock_out, paid_break_minutes, break_minutes) values
  (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), timestamptz '2027-06-14 08:00 America/New_York', timestamptz '2027-06-14 16:00 America/New_York', 15, 0),
  (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), timestamptz '2027-06-15 08:00 America/New_York', timestamptz '2027-06-15 16:00 America/New_York', 0, 15);
select pg_temp.as_user('frank');
with x as (insert into app.timesheets (project_id, membership_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-06-13', '2027-06-19') returning id) insert into world select 'ts', id from x;
select app.submit_timesheet(pg_temp.id('ts'));
select pg_temp.as_user('carol');
select app.decide_timesheet(pg_temp.id('ts'), 'Approved', 'Matches the call sheet.');
with x as (insert into app.pay_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-06-13', '2027-06-26') returning id) insert into world select 'pp', id from x;
with x as (insert into app.payroll_runs (pay_period_id, currency_code) values (pg_temp.id('pp'), 'USD') returning id) insert into world select 'run', id from x;
select is(app.calculate_payroll_run(pg_temp.id('run')), 1, 'one regular line');
select is((select l.hours from app.payroll_lines l where l.payroll_run_id = pg_temp.id('run') and l.deleted_at is null), 15.75::numeric,
  'the paid quarter hour is paid as worked time: 8 hours and 7.75 hours');

-- The default ---------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select throws_ok(format($$select app.set_default_break_type(%L)$$, pg_temp.id('bt_rest')), '42501', null, 'a member does not choose the default');
select pg_temp.as_user('alice');
select lives_ok(format($$select app.set_default_break_type(%L)$$, pg_temp.id('bt_rest')), 'the org moves the default in one step');
select is((select array_agg(name) from app.break_types where org_id = pg_temp.id('org_a') and is_default), array['Rest break'],
  'one default, the new one');
update app.break_types set deleted_at = now() where id = pg_temp.id('bt_rest');
select is((select is_default from app.break_types where id = pg_temp.id('bt_rest')), false, 'retiring the default clears it');
update app.break_types set deleted_at = null where id = pg_temp.id('bt_rest');
select is((select is_default from app.break_types where id = pg_temp.id('bt_rest')), false, 'so a restored type comes back as not the default');
select pg_temp.as_platform();
select ok(exists (select 1 from private.trash_tables where table_name = 'break_types'), 'break types are Trash eligible');
select has_function('app', 'record_supervisor_punches', 'the supervisor''s team punch still resolves private.apply_punch positionally');

select * from finish();
rollback;
