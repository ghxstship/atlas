-- pgTAP: migration 6514 (B9, RRR-233, ADR 0148), project positions. A position with no holder holds open shifts nobody
-- claims, drags or writes a worker onto (shift_held_for_position) and that the open-shift policy hides; filling it with a
-- member gives its future shifts to them (shift.assigned) and turns its record assignments into app.record_assignments,
-- except one they already held; vacating returns the future shifts and removes only what filling made. A position goes
-- to Trash only when nothing hangs on it (position_in_use). An agency position names an agency-slot engagement
-- (position_engagement_not_agency); filling it with an Accepted roster entry whose training is complete places the
-- person on its slots under R12's checks, an entry with training due refuses roster_training_incomplete, and the
-- holder reads the position's records through api_external.position_records. Filling reports the org's scheduling
-- warnings without refusing. A position keeps its agency and project while it holds shifts or records, a shift keeps to
-- its position's project, and a shift with waiting claims is not put on a position. app.save_roster_shift refuses
-- another worker on a held shift.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2750_agency_world.psql

select no_plan();

create function pg_temp.held_shift(p_key text, p_position text, p_days integer) returns void
language plpgsql as $$
declare
  v_id uuid;
begin
  perform pg_temp.as_user('carol');
  insert into app.shifts (project_id, role_code, starts_at, ends_at, time_zone, project_position_id)
  values (pg_temp.id('prj_a'), '0000.50.01', now() + make_interval(days => p_days), now() + make_interval(days => p_days, hours => 8),
          'America/New_York', pg_temp.id(p_position))
  returning id into v_id;
  perform app.publish_shifts(array[v_id]);
  perform pg_temp.as_platform();
  insert into world values (p_key, v_id);
end $$;

create function pg_temp.new_record(p_key text, p_title text) returns void
language plpgsql as $$
declare
  v_id uuid;
begin
  perform pg_temp.as_user('alice');
  insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Task', p_title, 'Y', 'Declared') returning id into v_id;
  perform pg_temp.as_platform();
  insert into world values (p_key, v_id);
end $$;

-- A member position -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.project_positions (project_id, title, role_code) values (pg_temp.id('prj_a'), 'Stage Manager', '0000.50.01')
  returning id) insert into world select 'pos_sm', id from x;
select throws_ok(format($$insert into app.project_positions (project_id, title) values (%L, '  stage manager ')$$, pg_temp.id('prj_a')),
  '23505', null, 'titles are unique among a project''s live positions');
select throws_ok(format($$update app.project_positions set membership_id = %L where id = %L$$, pg_temp.id('frank@org_a'), pg_temp.id('pos_sm')),
  'XR001', 'position_holder_rpc: Fill a position with app.fill_position and vacate it with app.vacate_position.',
  'the holder changes only through app.fill_position');

select pg_temp.held_shift('s1', 'pos_sm', 5);
select pg_temp.held_shift('s2', 'pos_sm', 6);

select pg_temp.as_user('mia');
select is((select count(*)::int from app.shifts where id = pg_temp.id('s1')), 0, 'an open shift held for a position is not offered to claim');
select throws_ok(format($$select app.claim_open_shift(%L)$$, pg_temp.id('s1')), 'XR001',
  'shift_held_for_position: This shift is held for a position until someone fills it.', 'so nobody claims it');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.assign_open_shift(%L, %L)$$, pg_temp.id('s1'), pg_temp.id('frank@org_a')), 'XR001',
  'shift_held_for_position: This shift is held for a position. Fill the position instead.', 'nor is anyone dragged onto it');
select throws_ok(format($$update app.shifts set membership_id = %L where id = %L$$, pg_temp.id('frank@org_a'), pg_temp.id('s1')), 'XR001',
  'shift_held_for_position: This shift is held for a position. Fill the position, or take the shift off it first.',
  'nor written onto it directly');

select throws_ok(format($$select app.save_roster_shift(%L, %L, %L, '0000.50.01', now() + interval '5 days', now() + interval '5 days 8 hours', 'America/New_York', %L, null, null)$$,
    pg_temp.id('s1'), pg_temp.id('org_a'), pg_temp.id('prj_a'), pg_temp.id('frank@org_a')), 'XR001',
  'shift_held_for_position: This shift is held for a position. Fill the position, or take the shift off it first.',
  'nor saved through the shift editor with another worker');
select throws_ok(format($$update app.shifts set project_id = %L where id = %L$$, pg_temp.id('prj_a2'), pg_temp.id('s1')), 'XR001',
  'same_project: shifts.project_position_id points to a position of another project.', 'a shift keeps to its position''s project');

-- A shift with waiting claims is decided first
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'scheduling.open_shift_claiming', 'Organization', pg_temp.id('org_a'), p_value_text => 'approval');
select pg_temp.as_user('carol');
with x as (insert into app.shifts (project_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), '0000.50.01', now() + interval '20 days', now() + interval '20 days 8 hours', 'America/New_York') returning id)
insert into world select 'claimed', id from x;
select app.publish_shifts(array[pg_temp.id('claimed')]);
select pg_temp.as_user('mia');
select app.claim_open_shift(pg_temp.id('claimed'));
select pg_temp.as_user('carol');
select throws_ok(format($$update app.shifts set project_position_id = %L where id = %L$$, pg_temp.id('pos_sm'), pg_temp.id('claimed')), 'XR001',
  'shift_claims_waiting: Members claimed this shift; approve or reject their claims on the shift first.',
  'a shift with waiting claims is not put on a position, where approving would be refused and filling would skip it');

-- Records on the position: r1 only through it, r2 also assigned to frank directly.
select pg_temp.new_record('r1', 'Call the riggers');
select pg_temp.new_record('r2', 'Walk the stage');
select pg_temp.as_user('alice');
insert into app.record_assignments (record_id, membership_id) values (pg_temp.id('r2'), pg_temp.id('frank@org_a'));
insert into app.record_position_assignments (record_id, project_position_id) values
  (pg_temp.id('r1'), pg_temp.id('pos_sm')), (pg_temp.id('r2'), pg_temp.id('pos_sm'));

-- Filling ------------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok(format($$select app.fill_position(%L)$$, pg_temp.id('pos_sm')), 'XR001',
  'position_holder_one: Fill a position with one member or one person of an agency''s roster.', 'exactly one holder');
select throws_ok(format($$select app.fill_position(%L, p_roster_entry_id => %L)$$, pg_temp.id('pos_sm'), pg_temp.id('e_stella')), 'XR001',
  null, 'a member position is not filled from a roster');
select pg_temp.as_user('mia');
select throws_ok(format($$select app.fill_position(%L, %L)$$, pg_temp.id('pos_sm'), pg_temp.id('mia@org_a')), '42501', null,
  'without crew.shift.write nobody fills a member position');
select pg_temp.as_user('xavier');
select throws_ok(format($$select app.fill_position(%L)$$, pg_temp.id('pos_sm')), '42501',
  'crew.shift.write on the project, or the agency''s lead for an agency position, fills it',
  'a stranger gets the same answer for a real position');
select throws_ok(format($$select app.fill_position(%L)$$, gen_random_uuid()), '42501',
  'crew.shift.write on the project, or the agency''s lead for an agency position, fills it',
  'as for an id that does not exist, so a uuid is no existence oracle');
select pg_temp.as_user('carol');
select is(app.fill_position(pg_temp.id('pos_sm'), pg_temp.id('frank@org_a')) - 'position_id',
  '{"shifts_filled": 2, "shifts_skipped": [], "policy_warnings": [], "records_resolved": 1}'::jsonb,
  'filling gives both future shifts to the member and resolves the one record they did not hold');
select pg_temp.as_platform();
select results_eq(format($$select membership_id, shift_state::text from app.shifts where id in (%L, %L) order by starts_at$$,
    pg_temp.id('s1'), pg_temp.id('s2')),
  format($$values (%L::uuid, 'Published'::text), (%L::uuid, 'Published'::text)$$, pg_temp.id('frank@org_a'), pg_temp.id('frank@org_a')),
  'the shifts are theirs, Published for them to accept');
select isnt((select id from app.notifications where kind = 'shift.assigned' and recipient_person_id = pg_temp.id('frank')
  and subject_id = pg_temp.id('s1')), null, 'and they are told (shift.assigned)');
select is((select count(*)::int from app.record_assignments where record_id = pg_temp.id('r1') and membership_id = pg_temp.id('frank@org_a')
  and deleted_at is null), 1, 'the position''s record is assigned to them');
select is((select resolved_assignment_id from app.record_position_assignments where record_id = pg_temp.id('r2')), null,
  'a record they already held stays unresolved on the position');
select isnt((select filled_at from app.project_positions where id = pg_temp.id('pos_sm')), null, 'the position is filled');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.fill_position(%L, %L)$$, pg_temp.id('pos_sm'), pg_temp.id('mia@org_a')), 'XR001',
  'position_filled: Someone holds this position. Vacate it first.', 'a held position is refilled only after vacating');
select pg_temp.as_user('frank');
select throws_ok(format($$insert into app.shift_swaps (shift_id, requested_by_membership_id, proposed_membership_id) values (%L, %L, %L)$$,
  pg_temp.id('s1'), pg_temp.id('frank@org_a'), pg_temp.id('dave@org_a')), 'XR001',
  'shift_held_for_position: This shift is held for a position. Fill the position, or take the shift off it first.',
  'the holder of a held shift is told when asking to swap it, not when the swap is applied');

-- Filling reports the org's warnings and never refuses for them
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'scheduling.max_daily_hours', 'Organization', pg_temp.id('org_a'), p_value_integer => 4);
select pg_temp.as_user('carol');
with x as (insert into app.project_positions (project_id, title) values (pg_temp.id('prj_a'), 'Long Day') returning id)
insert into world select 'pos_long', id from x;
select pg_temp.held_shift('s_long', 'pos_long', 8);
select pg_temp.as_user('carol');
select is(app.fill_position(pg_temp.id('pos_long'), pg_temp.id('dave@org_a')) -> 'policy_warnings',
  jsonb_build_array(jsonb_build_object('shift_id', pg_temp.id('s_long'), 'code', 'shift_day_over')),
  'filling names the shift a warning applies to and still fills it');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'scheduling.max_daily_hours', 'Organization', pg_temp.id('org_a'), p_value_integer => 0);

-- Vacating -------------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select app.accept_shift(pg_temp.id('s1'));
select pg_temp.as_user('carol');
select is(app.vacate_position(pg_temp.id('pos_sm'), 'Moved to the winter show.') - 'position_id',
  '{"shifts_returned": 2, "records_unassigned": 1}'::jsonb, 'vacating returns the future shifts and removes one assignment');
select pg_temp.as_platform();
select results_eq(format($$select membership_id, shift_state::text, project_position_id from app.shifts where id in (%L, %L) order by starts_at$$,
    pg_temp.id('s1'), pg_temp.id('s2')),
  format($$values (null::uuid, 'Published'::text, %L::uuid), (null::uuid, 'Published'::text, %L::uuid)$$,
    pg_temp.id('pos_sm'), pg_temp.id('pos_sm')),
  'the shifts go back to the position, the accepted one to Published');
select is((select count(*)::int from app.record_assignments where membership_id = pg_temp.id('frank@org_a') and deleted_at is null
  and record_id in (pg_temp.id('r1'), pg_temp.id('r2'))), 1, 'only the assignment filling made is removed; the one they held stays');

-- Trash -------------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok(format($$update app.project_positions set project_id = %L where id = %L$$, pg_temp.id('prj_a2'), pg_temp.id('pos_sm')), 'XR001',
  'position_in_use: Move this position''s shifts and records off it before changing its agency or project.',
  'a position with live shifts does not move to another project');
select throws_ok(format($$update app.project_positions set deleted_at = now() where id = %L$$, pg_temp.id('pos_sm')), 'XR001',
  'position_in_use: Vacate the position and move its shifts and records off it before moving it to Trash.',
  'a position with live shifts or records does not go to Trash');
update app.shifts set project_position_id = null where id in (pg_temp.id('s1'), pg_temp.id('s2'));
select pg_temp.as_user('alice');
update app.record_position_assignments set deleted_at = now() where project_position_id = pg_temp.id('pos_sm');
select pg_temp.as_user('carol');
select lives_ok(format($$update app.project_positions set deleted_at = now() where id = %L$$, pg_temp.id('pos_sm')),
  'once nothing hangs on it, it goes to Trash');
select pg_temp.as_platform();
select ok(exists (select 1 from private.trash_tables where table_name = 'project_positions'), 'positions are Trash eligible');

-- An agency position ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok(format($$insert into app.project_positions (project_id, title, engagement_id) values (%L, 'Rigger', %L)$$,
  pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a')), 'XR001',
  'position_engagement_not_agency: An agency position names a staffing agency''s Staff engagement.', 'an agency position names an agency');
with x as (insert into app.project_positions (project_id, title, engagement_id) values (pg_temp.id('prj_a'), 'Crowd Lead', pg_temp.id('eng_agency'))
  returning id) insert into world select 'pos_ag', id from x;
update app.shifts set project_position_id = pg_temp.id('pos_ag') where id = pg_temp.id('slot_2');
select throws_ok(format($$update app.project_positions set engagement_id = null where id = %L$$, pg_temp.id('pos_ag')), 'XR001',
  'position_in_use: Move this position''s shifts and records off it before changing its agency or project.',
  'an unfilled agency position holding slots does not turn into a member position');
select throws_ok(format($$update app.shifts set engagement_id = null, membership_id = %L where id = %L$$, pg_temp.id('frank@org_a'), pg_temp.id('slot_2')), 'XR001',
  'shift_held_for_position: This shift is held for a position. Fill the position, or take the shift off it first.',
  'an agency position''s slot does not go to a member');
select throws_ok(format($$update app.shifts set project_position_id = %L where id = %L$$, pg_temp.id('pos_ag'), pg_temp.id('sh_frank_day')),
  'XR001', null, 'a member''s shift is not held for an agency position');
select pg_temp.new_record('r3', 'Brief the gate team');
select pg_temp.as_user('alice');
insert into app.record_position_assignments (record_id, project_position_id) values (pg_temp.id('r3'), pg_temp.id('pos_ag'));

-- Training first
select pg_temp.as_user('carol');
with x as (insert into app.onboarding_requirements (org_id, name, item_kind, role_type, jurisdiction_id, verification_method, is_blocking)
  values (pg_temp.id('org_a'), 'Code of Conduct', 'Acknowledgment', null, null, 'Automatic', true) returning id)
insert into world select 'req_conduct', id from x;
select pg_temp.as_user('olga');
select throws_ok(format($$select app.fill_position(%L, p_roster_entry_id => %L)$$, pg_temp.id('pos_ag'), pg_temp.id('e_theo')), 'XR001',
  'roster_training_incomplete: This person has training to acknowledge, or to be verified, before their first shift.',
  'an entry with training due does not fill the position');
select pg_temp.as_user('stella');
select app.acknowledge_roster_training(pg_temp.id('e_stella'), pg_temp.id('req_conduct'));
select pg_temp.as_user('olga');
select is((app.fill_position(pg_temp.id('pos_ag'), p_roster_entry_id => pg_temp.id('e_stella')) ->> 'shifts_filled')::int, 1,
  'the agency''s lead fills it with an Accepted, trained entry, placing them on the position''s slot');
select pg_temp.as_platform();
select results_eq(format($$select roster_entry_id, engagement_id from app.shifts where id = %L$$, pg_temp.id('slot_2')),
  format($$values (%L::uuid, null::uuid)$$, pg_temp.id('e_stella')), 'under R12''s rules the slot names the entry');
select is((select count(*)::int from app.record_assignments where record_id = pg_temp.id('r3') and deleted_at is null), 0,
  'a roster holder''s records stay on the position');
select pg_temp.as_user('stella');
select is((select array_agg(title) from api_external.position_records), array['Brief the gate team'],
  'the holder reads the position''s records in Gateway');
select results_eq(format($$select position_title, has_no_show from api_external.shifts where id = %L$$, pg_temp.id('slot_2')),
  $$values ('Crowd Lead'::text, false)$$, 'and their shift names its position, with no no-show');
select pg_temp.as_user('olga');
select is((select count(*)::int from api_external.position_records), 1, 'the agency''s lead reads them too');
select pg_temp.as_user('ivy');
select is((select count(*)::int from api_external.position_records), 0, 'nobody else does');

select * from finish();
rollback;
