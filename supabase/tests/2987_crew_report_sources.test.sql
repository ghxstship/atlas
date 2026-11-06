-- pgTAP: migration 2987 (B9, RRR-233, ADR 0148), the four crew report sources. Each is an owner-rights view with its own
-- row filter: crew_shift_hours shows scheduled hours to shift readers and actual hours only to time entry readers;
-- crew_responses shows shift asks to shift readers and roster invitation answers to engagement readers; crew_removals
-- keeps the state an entry left; crew_ratings the org's own ratings. The sources are registered for the report builder,
-- private.report_source_relation maps them, and the backup login reads none of the views.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2750_agency_world.psql

select no_plan();

-- A worked member shift: 8 hours scheduled with a 30-minute break, 8 hours worked with a 30-minute unpaid break.
select pg_temp.as_user('carol');
with x as (insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone, scheduled_break_minutes)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '0000.50.01', now() - interval '9 hours', now() - interval '1 hour', 'America/New_York', 30)
  returning id) insert into world select 'worked', id from x;
select app.publish_shifts(array[pg_temp.id('worked')]);
select pg_temp.as_user('frank');
select app.accept_shift(pg_temp.id('worked'));
select app.record_punch(gen_random_uuid(), pg_temp.id('prj_a'), 'In', now() - interval '9 hours', p_shift_id => pg_temp.id('worked'));
select app.record_punch(gen_random_uuid(), pg_temp.id('prj_a'), 'Break Start', now() - interval '5 hours');
select app.record_punch(gen_random_uuid(), pg_temp.id('prj_a'), 'Break End', now() - interval '4 hours 30 minutes');
select app.record_punch(gen_random_uuid(), pg_temp.id('prj_a'), 'Out', now() - interval '30 minutes');

select pg_temp.as_user('carol');
select results_eq(format($$select worker_kind, scheduled_hours, actual_hours, variance_hours, no_show from app.crew_shift_hours where shift_id = %L$$,
    pg_temp.id('worked')),
  $$values ('Member'::text, 7.50::numeric(8, 2), 8.00::numeric(8, 2), 0.50::numeric(8, 2), false)$$,
  'scheduled hours net of the scheduled break, actual hours net of the unpaid break, and the difference');
select is((select worker_kind from app.crew_shift_hours where shift_id = pg_temp.id('slot_1')), 'Agency', 'an agency slot is Agency');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.crew_shift_hours), 0, 'another org reads none');

-- crew_responses
select pg_temp.as_user('carol');
select ok((select count(*) from app.crew_responses where kind = 'Offer' and person_name = 'Frank Adeyemi') >= 1,
  'shift asks appear for shift readers');
select is((select count(*)::int from app.crew_responses where kind = 'Roster invitation' and answer = 'Accepted'), 2,
  'roster invitation answers appear for engagement readers');

-- crew_removals: an accepted entry withdrawn keeps the state it left.
select pg_temp.as_platform();
select private.transition_lifecycle('roster_entry', 'app.engagement_roster_entries', 'entry_state', 'app.roster_entry_state_transitions',
  'roster_entry_id', pg_temp.id('e_theo'), 'Accepted', 'Withdrawn', 'Not needed.');
select pg_temp.as_user('carol');
select results_eq($$select from_state, reason from app.crew_removals where person_name = 'Theo Ramires'$$,
  $$values ('Accepted'::text, 'Not needed.'::text)$$, 'a removal keeps the state it left, which the standard report filters on');

-- crew_ratings reads only the org's own side, under 0740's rule.
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.crew_ratings), 0, 'another org reads none of the org''s ratings');

-- Registration ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select results_eq($$select code, read_capability, sort_order::int from private.report_sources where sort_order between 8 and 11 order by sort_order$$,
  $$values ('crew_hours'::text, 'crew.shift.read'::text, 8), ('crew_responses', 'crew.shift.read', 9),
           ('crew_removals', 'opportunities.engagement.read', 10), ('crew_ratings', 'opportunities.engagement.read', 11)$$,
  'the four sources are registered with their read capability');
select is(array[private.report_source_relation('crew_hours'), private.report_source_relation('crew_responses'),
    private.report_source_relation('crew_removals'), private.report_source_relation('crew_ratings'), private.report_source_relation('crew')],
  array['crew_shift_hours', 'crew_responses', 'crew_removals', 'crew_ratings', 'shifts'], 'and mapped to their views, the old ones unchanged');
select ok(not has_table_privilege('xos_backup', 'app.crew_shift_hours', 'select')
  and not has_table_privilege('xos_backup', 'app.crew_responses', 'select')
  and not has_table_privilege('xos_backup', 'app.crew_removals', 'select')
  and not has_table_privilege('xos_backup', 'app.crew_ratings', 'select'), 'the backup login reads none of the views');

select * from finish();
rollback;
