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
select is((select count(*)::int from app.crew_responses where kind = 'Roster invitation' and answer = 'Accepted'
    and person_name in ('Stella Okafor', 'Theo Ramires')), 2,
  'roster invitation answers appear for engagement readers');

-- Names: a crew.shift.read and engagement reader without advancing.packet.read sees members and engaged people by name,
-- never a roster person; a reader without the capability sees no rows.
select pg_temp.as_user('olga');
select app.assign_roster_shift(pg_temp.id('slot_1'), pg_temp.id('e_stella'));
select pg_temp.as_user('carol');
select is((select worker_name from app.crew_shift_hours where shift_id = pg_temp.id('slot_1')), 'Stella Okafor', 'an advancing reader sees the roster person''s name');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.crew_shift_hours), 0, 'without the capability the sources are empty');
select is((select count(*)::int from app.crew_responses), 0, 'all of them');
select pg_temp.as_user('alice');
insert into app.record_grants (target_kind, target_id, capability_code, grantee_person_id, valid_to, reason) values
  ('project', pg_temp.id('prj_a'), 'crew.shift.read', pg_temp.id('gina'), now() + interval '7 days', 'Reviewing coverage.'),
  ('project', pg_temp.id('prj_a'), 'opportunities.engagement.read', pg_temp.id('gina'), now() + interval '7 days', 'Reviewing coverage.');
select pg_temp.as_user('gina');
select is((select worker_name from app.crew_shift_hours where shift_id = pg_temp.id('worked')), 'Frank Adeyemi', 'a shift reader sees a member''s name');
select results_eq(format($$select worker_kind, worker_name from app.crew_shift_hours where shift_id = %L$$, pg_temp.id('slot_1')),
  $$values ('Agency'::text, null::text)$$, 'and a null name for a roster person');
select is((select person_name from app.crew_responses where id = pg_temp.id('e_stella')), null, 'the roster invitation row too');
select is((select actual_hours from app.crew_shift_hours where shift_id = pg_temp.id('worked')), null, 'and no actual hours without crew.time_entry.read');
select pg_temp.as_platform();
with x as (insert into app.shifts (org_id, project_id, engagement_id, role_code, starts_at, ends_at, time_zone)
  select org_id, project_id, id, '0000.50.01', now() + interval '30 days', now() + interval '30 days 8 hours', 'America/New_York'
  from app.engagements where id = pg_temp.id('eng_ivy_a') returning id)
insert into world select 'engaged', id from x;
select pg_temp.as_user('gina');
select is((select worker_name from app.crew_shift_hours where shift_id = pg_temp.id('engaged')),
  'Ivy Marchetti', 'an engaged external''s name appears for a reader with the capability');

-- crew_removals: an accepted entry withdrawn keeps the state it left.
select pg_temp.as_platform();
select private.transition_lifecycle('roster_entry', 'app.engagement_roster_entries', 'entry_state', 'app.roster_entry_state_transitions',
  'roster_entry_id', pg_temp.id('e_theo'), 'Accepted', 'Withdrawn', 'Not needed.');
select pg_temp.as_user('carol');
select results_eq($$select from_state, reason from app.crew_removals where person_name = 'Theo Ramires'$$,
  $$values ('Accepted'::text, 'Not needed.'::text)$$, 'a removal keeps the state it left, which the standard report filters on');
select pg_temp.as_user('gina');
select results_eq(format($$select person_name, from_state from app.crew_removals where id in (select id from app.roster_entry_state_transitions where roster_entry_id = %L and to_state = 'Withdrawn')$$, pg_temp.id('e_theo')),
  $$values (null::text, 'Accepted'::text)$$, 'an engagement reader without advancing.packet.read sees the removal, not the name');

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
