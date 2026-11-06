-- pgTAP: migration 2982 (B9, RRR-233, ADR 0148), no-shows and swap reasons. A crew.shift.write holder marks the worker
-- of a started Accepted shift with no clock-in as a no-show, the worker is told (shift.no_show), and a replacement
-- opens from now to the shift's end. The worker themself, a shift not yet started, a shift with a clock-in and a
-- missing reason are refused. A replay with the same client id returns the same row (even once withdrawn), another
-- shift's refuses no_show_id_conflict; while live the shift's worker and times are frozen; a later clock-in withdraws
-- it; an agency lead marks their roster staff, whose replacement is an agency slot, and nobody else's. With
-- scheduling.swap_reason_required on a swap needs a reason, and a reason never changes.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2750_agency_world.psql

select no_plan();

create function pg_temp.started_shift(p_key text, p_membership text, p_started interval) returns void
language plpgsql as $$
declare
  v_id uuid;
begin
  perform pg_temp.as_user('carol');
  insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone, scheduled_break_minutes)
  values (pg_temp.id('prj_a'), pg_temp.id(p_membership), '0000.50.01', now() - p_started, now() - p_started + interval '8 hours',
          'America/New_York', 30)
  returning id into v_id;
  perform app.publish_shifts(array[v_id]);
  perform pg_temp.as_platform();
  insert into world values (p_key, v_id);
end $$;

select pg_temp.started_shift('ns1', 'frank@org_a', interval '30 minutes');
select pg_temp.as_user('frank');
select app.accept_shift(pg_temp.id('ns1'));
insert into world values ('nid1', gen_random_uuid()), ('nid2', gen_random_uuid()), ('nid3', gen_random_uuid()),
  ('nid4', gen_random_uuid()), ('nid5', gen_random_uuid());

-- Who marks ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select throws_ok(format($$select app.mark_shift_no_show(%L, %L, 'I overslept.')$$, pg_temp.id('nid1'), pg_temp.id('ns1')), 'XR001',
  'shift_no_show_self: You cannot mark yourself as a no-show. Tell your supervisor.', 'the worker never marks themself');
select pg_temp.as_user('gina');
select throws_ok(format($$select app.mark_shift_no_show(%L, %L, 'Not here.')$$, pg_temp.id('nid1'), pg_temp.id('ns1')), '42501', null,
  'a viewer cannot mark a no-show');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.mark_shift_no_show(%L, %L, '  ')$$, pg_temp.id('nid1'), pg_temp.id('ns1')), 'XR001',
  'shift_no_show_reason: Say what happened.', 'a reason is required');
select is(app.mark_shift_no_show(pg_temp.id('nid1'), pg_temp.id('ns1'), 'Did not arrive by call time.', true), pg_temp.id('nid1'),
  'a shift writer marks the worker of a started, Accepted shift with no clock-in');
select pg_temp.as_platform();
select isnt((select id from app.notifications where kind = 'shift.no_show' and recipient_person_id = pg_temp.id('frank')
  and subject_id = pg_temp.id('ns1')), null, 'the worker is told (shift.no_show)');
select results_eq(format($$select s.shift_state::text, s.role_code, s.membership_id, s.ends_at = o.ends_at, s.starts_at >= date_trunc('minute', now()),
    s.project_position_id from app.shift_no_shows n join app.shifts s on s.id = n.replacement_shift_id join app.shifts o on o.id = n.shift_id
    where n.id = %L$$, pg_temp.id('nid1')),
  $$values ('Published'::text, '0000.50.01'::text, null::uuid, true, true, null::uuid)$$,
  'one Published open replacement of the same role runs from now, to the minute, to the shift''s end');
select is((select count(*)::int from app.audit_events where action = 'crew.no_show' and subject_id = pg_temp.id('ns1')), 1,
  'the mark is audited');

-- Replays ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is(app.mark_shift_no_show(pg_temp.id('nid1'), pg_temp.id('ns1'), 'Again from the outbox.', true), pg_temp.id('nid1'),
  'a replay with the same client id returns the same no-show');
select is((select count(*)::int from app.shift_no_shows where shift_id = pg_temp.id('ns1')), 1, 'and records nothing new');
select is((select count(*)::int from app.shifts where project_id = pg_temp.id('prj_a') and starts_at >= date_trunc('minute', now())
  and ends_at = (select ends_at from app.shifts where id = pg_temp.id('ns1')) and membership_id is null), 1, 'nor a second replacement');

-- Frozen while live
select throws_ok(format($$update app.shifts set ends_at = ends_at + interval '1 hour' where id = %L$$, pg_temp.id('ns1')), 'XR001',
  'shift_no_show_frozen: This shift has a no-show. Withdraw the no-show before changing its worker, times or state, or cancel the shift.',
  'the shift''s times are frozen while the no-show is live');
select throws_ok(format($$update app.shifts set membership_id = %L where id = %L$$, pg_temp.id('mia@org_a'), pg_temp.id('ns1')), 'XR001',
  null, 'so is its worker');

-- Not started, clocked in --------------------------------------------------------------------------------------------------------
select pg_temp.started_shift('ns2', 'mia@org_a', interval '-1 day');
select pg_temp.as_user('mia');
select app.accept_shift(pg_temp.id('ns2'));
select pg_temp.as_user('carol');
select throws_ok(format($$select app.mark_shift_no_show(%L, %L, 'Not here.')$$, pg_temp.id('nid2'), pg_temp.id('ns2')), 'XR001',
  'shift_no_show_state: Mark a no-show once the shift has started and someone is on it.', 'a shift that has not started is refused');
select throws_ok(format($$select app.mark_shift_no_show(%L, %L, 'Not here.')$$, pg_temp.id('nid1'), pg_temp.id('ns2')), 'XR001',
  'no_show_id_conflict: This no-show id was already used for another shift.', 'a client id used for another shift is refused');

select pg_temp.started_shift('ns3', 'dave@org_a', interval '20 minutes');
select pg_temp.as_user('dave');
select app.accept_shift(pg_temp.id('ns3'));
select app.record_punch(gen_random_uuid(), pg_temp.id('prj_a'), 'In', now(), p_shift_id => pg_temp.id('ns3'));
select pg_temp.as_user('carol');
select throws_ok(format($$select app.mark_shift_no_show(%L, %L, 'Not here.')$$, pg_temp.id('nid3'), pg_temp.id('ns3')), 'XR001',
  'shift_no_show_clocked_in: This person clocked in on the shift, so they are not a no-show.', 'a worker who clocked in is not a no-show');

-- A later clock-in withdraws it --------------------------------------------------------------------------------------------------
select pg_temp.started_shift('ns4', 'erin@org_a', interval '15 minutes');
select pg_temp.as_user('erin');
select app.accept_shift(pg_temp.id('ns4'));
select pg_temp.as_user('carol');
select app.mark_shift_no_show(pg_temp.id('nid4'), pg_temp.id('ns4'), 'Late.');
select pg_temp.as_user('erin');
select app.record_punch(gen_random_uuid(), pg_temp.id('prj_a'), 'In', now(), p_shift_id => pg_temp.id('ns4'));
select pg_temp.as_platform();
select isnt((select deleted_at from app.shift_no_shows where id = pg_temp.id('nid4')), null,
  'the worker clocking in on the shift withdraws the no-show');
select is((select diff ->> 'reason' from app.audit_events where action = 'crew.no_show_withdrawn' and subject_id = pg_temp.id('ns4')),
  'Clocked in after being marked a no-show.', 'with the reason in the audit trail');

-- Withdrawing by hand, and the replay of a withdrawn mark
select pg_temp.as_user('carol');
select throws_ok(format($$select app.withdraw_shift_no_show(%L, '')$$, pg_temp.id('nid1')), 'XR001', null, 'withdrawing needs a reason');
select lives_ok(format($$select app.withdraw_shift_no_show(%L, 'He called in sick before call time.')$$, pg_temp.id('nid1')),
  'a shift writer withdraws a no-show');
select lives_ok(format($$update app.shifts set ends_at = ends_at + interval '1 hour' where id = %L$$, pg_temp.id('ns1')),
  'and the shift can change again');
select is(app.mark_shift_no_show(pg_temp.id('nid1'), pg_temp.id('ns1'), 'Outbox replay.', true), pg_temp.id('nid1'),
  'replaying a withdrawn mark returns its id');
select pg_temp.as_platform();
select is((select count(*)::int from app.shift_no_shows where shift_id = pg_temp.id('ns1') and deleted_at is null), 0, 'and recreates nothing');

-- The agency's lead -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('olga');
select app.assign_roster_shift(pg_temp.id('slot_1'), pg_temp.id('e_stella'));
select pg_temp.as_user('stella');
select app.accept_engaged_shift(pg_temp.id('slot_1'));
select pg_temp.as_platform();
update app.shifts set starts_at = now() - interval '10 minutes' where id = pg_temp.id('slot_1');
select pg_temp.as_user('olga');
select throws_ok(format($$select app.mark_shift_no_show(%L, %L, 'Not here.')$$, pg_temp.id('nid5'), pg_temp.id('ns2')), '42501', null,
  'the agency''s lead cannot mark anyone else''s shift');
select is(app.mark_shift_no_show(pg_temp.id('nid5'), pg_temp.id('slot_1'), 'No call, no show.', true), pg_temp.id('nid5'),
  'the agency''s lead marks their roster staff');
select pg_temp.as_platform();
select results_eq(format($$select s.engagement_id, s.roster_entry_id, s.shift_state::text from app.shift_no_shows n
    join app.shifts s on s.id = n.replacement_shift_id where n.id = %L$$, pg_temp.id('nid5')),
  format($$values (%L::uuid, null::uuid, 'Published'::text)$$, pg_temp.id('eng_agency')),
  'their replacement is a Published slot of the same engagement, for the agency to fill');
select pg_temp.as_user('stella');
select is((select count(*)::int from app.shift_no_shows where shift_id = pg_temp.id('slot_1')), 1, 'the worker reads their no-show');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.shift_no_shows), 0, 'another org reads none');

-- Swap reasons ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'scheduling.swap_reason_required', 'Organization', pg_temp.id('org_a'), p_value_boolean => true);
select pg_temp.as_user('mia');
select throws_ok(format($$insert into app.shift_swaps (shift_id, requested_by_membership_id, proposed_membership_id) values (%L, %L, %L)$$,
  pg_temp.id('ns2'), pg_temp.id('mia@org_a'), pg_temp.id('frank@org_a')), 'XR001',
  'swap_reason_required: Say why you are asking to swap this shift.', 'with scheduling.swap_reason_required on, a swap needs a reason');
with x as (insert into app.shift_swaps (shift_id, requested_by_membership_id, proposed_membership_id, reason)
  values (pg_temp.id('ns2'), pg_temp.id('mia@org_a'), pg_temp.id('frank@org_a'), 'Exam that morning.') returning id)
insert into world select 'swap_r', id from x;
select is((select reason from app.shift_swaps where id = pg_temp.id('swap_r')), 'Exam that morning.', 'the swap keeps its reason');
select pg_temp.as_platform();
select throws_ok(format($$update app.shift_swaps set reason = 'Changed my mind.' where id = %L$$, pg_temp.id('swap_r')), 'XR001',
  'swap_immutable: A swap keeps its shift, people and reason; cancel it and ask again.', 'a reason never changes');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'scheduling.swap_reason_required', 'Organization', pg_temp.id('org_a'), p_value_boolean => false);
select pg_temp.as_user('mia');
select lives_ok(format($$insert into app.shift_swaps (shift_id, requested_by_membership_id, proposed_membership_id) values (%L, %L, %L)$$,
  pg_temp.id('ns2'), pg_temp.id('mia@org_a'), pg_temp.id('dave@org_a')), 'with it off, a reason is optional');

select * from finish();
rollback;
