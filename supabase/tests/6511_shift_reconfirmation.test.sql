-- pgTAP: migration 6511 (B9, RRR-233, ADR 0148), the "Still coming?" reconfirmation. With
-- scheduling.reconfirm_shifts on and scheduling.reconfirm_lead_hours 24, private.send_shift_reconfirmations asks the
-- worker of an Accepted shift starting in 20 hours that was accepted three days earlier, once, by shift.reconfirm; not
-- a shift accepted inside the window, not a project with the setting off, never twice; a Waiting ask turns No Answer
-- once the shift starts. app.respond_shift_reconfirmation by the asked person confirms or declines: with
-- scheduling.reconfirm_reopen on a member shift becomes an open shift another member claims and a roster shift goes back
-- to its agency's slot; with it off the shift keeps its worker. The creator hears of a decline
-- (shift.reconfirm_declined). Anyone else gets 42501, and a second answer or any answer once the shift has started gets
-- shift_reconfirm_answered. The email link accepts while the ask waits and the shift has not started, push declines
-- through app.act_on_notification, and app.decline_shift returns a roster person's Published shift to the agency's slot.
-- A swap approved inside the window asks nobody; a Waiting ask only sits on an Accepted shift; and every way an ask ends
-- retires its notification (answers, the job's No Answer, the withdrawal of t93).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2750_agency_world.psql

select no_plan();

create function pg_temp.accepted_shift(p_key text, p_creator text, p_membership text, p_project text, p_starts interval) returns void
language plpgsql as $$
declare
  v_id uuid;
begin
  perform pg_temp.as_user(p_creator);
  insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id(p_project), pg_temp.id(p_membership), '0000.50.01', now() + p_starts, now() + p_starts + interval '8 hours',
          'America/New_York')
  returning id into v_id;
  perform app.publish_shifts(array[v_id]);
  perform pg_temp.as_platform();
  insert into world values (p_key, v_id);
  -- The worker accepts, through their own session.
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', json_build_object('sub', (select p.user_id from app.memberships m join app.people p on p.id = m.person_id
    where m.id = pg_temp.id(p_membership)), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  perform app.accept_shift(v_id);
  perform pg_temp.as_platform();
end $$;

-- Accepted well before the window: the ledger's acceptance is moved back, as the job would find it days later.
create function pg_temp.backdate_acceptance(p_key text, p_age interval) returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  set local session_replication_role = replica;
  update app.shift_state_transitions set created_at = now() - p_age where shift_id = pg_temp.id(p_key) and to_state = 'Accepted';
  set local session_replication_role = origin;
end $$;

create function pg_temp.ask(p_key text) returns text
language sql security definer as $$
  select coalesce(string_agg(r.answer::text, ',' order by r.answer::text), '') from app.shift_responses r
  where r.shift_id = pg_temp.id(p_key) and r.ask_kind = 'Reconfirmation' and r.deleted_at is null
$$;
grant execute on function pg_temp.ask(text) to public;

create function pg_temp.note(p_person text, p_kind text, p_subject text) returns uuid
language sql security definer as $$
  select n.id from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_person) and n.kind = p_kind and n.subject_id = pg_temp.id(p_subject)
  order by n.created_at desc, n.id desc limit 1
$$;
grant execute on function pg_temp.note(text, text, text) to public;

create function pg_temp.archived(p_note uuid) returns boolean
language sql security definer as $$ select n.archived_at is not null from app.notifications n where n.id = p_note $$;
grant execute on function pg_temp.archived(uuid) to public;

-- Settings ----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'scheduling.reconfirm_shifts', 'Project', pg_temp.id('prj_a'), p_value_boolean => true);
select app.set_setting(pg_temp.id('org_a'), 'scheduling.reconfirm_lead_hours', 'Project', pg_temp.id('prj_a'), p_value_integer => 24);

select pg_temp.accepted_shift('r1', 'carol', 'frank@org_a', 'prj_a', interval '20 hours');
select pg_temp.backdate_acceptance('r1', interval '3 days');
select pg_temp.accepted_shift('r2', 'carol', 'mia@org_a', 'prj_a', interval '5 hours');
select pg_temp.accepted_shift('r3', 'alice', 'frank@org_a', 'prj_a2', interval '20 hours');
select pg_temp.backdate_acceptance('r3', interval '3 days');

-- Asking --------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is(private.send_shift_reconfirmations(), 1, 'one shift qualifies');
select is(pg_temp.ask('r1'), 'Waiting', 'the worker of a shift accepted three days ago is asked');
select is(pg_temp.ask('r2'), '', 'a shift accepted 5 hours before it starts is not asked');
select is(pg_temp.ask('r3'), '', 'a project with scheduling.reconfirm_shifts off is not asked');
select isnt(pg_temp.note('frank', 'shift.reconfirm', 'r1'), null, 'the worker is told by shift.reconfirm');
select is(private.send_shift_reconfirmations(), 0, 'running again asks nobody twice');
select is((select count(*)::int from app.notifications where kind = 'shift.reconfirm' and subject_id = pg_temp.id('r1')), 1,
  'and sends no second notification');

-- One-tap links and Gateway's Needs You
select is((select array_agg(action || '/' || audience) from private.notification_link_actions(pg_temp.note('frank', 'shift.reconfirm', 'r1'))),
  array['accept/Atlas'], 'the email carries Confirm you''re coming, confirmed in Atlas for a member');
select pg_temp.as_user('frank');
select ok(pg_temp.note('frank', 'shift.reconfirm', 'r1') in (select app.my_notifications_awaiting_answer()),
  'the ask waits on the person''s answer, so For Your Information leaves it out');

-- Answering --------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('mia');
select throws_ok(format($$select app.respond_shift_reconfirmation(%L, true)$$, pg_temp.id('r1')), '42501', null,
  'someone else cannot answer');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.respond_shift_reconfirmation(%L, false, 'Not you.')$$, pg_temp.id('r1')), '42501', null,
  'nor can the planner');
select pg_temp.as_user('frank');
select lives_ok(format($$select app.respond_shift_reconfirmation(%L, true)$$, pg_temp.id('r1')), 'the worker confirms');
select is(pg_temp.ask('r1'), 'Accepted', 'the answer is Accepted');
select throws_ok(format($$select app.respond_shift_reconfirmation(%L, false)$$, pg_temp.id('r1')), 'XR001',
  'shift_reconfirm_answered: This shift was already confirmed, or nobody is asking any more.', 'a second answer is refused');
select pg_temp.as_platform();
select is((select count(*)::int from private.notification_link_actions(pg_temp.note('frank', 'shift.reconfirm', 'r1'))), 0,
  'once answered, the email link no longer acts');
select ok(pg_temp.archived(pg_temp.note('frank', 'shift.reconfirm', 'r1')), 'and an answer retires the notification');

-- No Answer once the shift starts
select pg_temp.accepted_shift('r6', 'carol', 'dave@org_a', 'prj_a', interval '19 hours');
select pg_temp.backdate_acceptance('r6', interval '2 days');
select is(private.send_shift_reconfirmations(), 1, 'the next shift is asked');
update app.shifts set starts_at = now() - interval '1 minute' where id = pg_temp.id('r6');
select private.send_shift_reconfirmations();
select is(pg_temp.ask('r6'), 'No Answer', 'a Waiting ask becomes No Answer once the shift starts');
select ok(pg_temp.archived(pg_temp.note('dave', 'shift.reconfirm', 'r6')), 'and the job retires its notification');

-- Started, before the job has run: nothing left to answer (correction d) ----------------------------------------------------------------
select pg_temp.accepted_shift('r7', 'carol', 'erin@org_a', 'prj_a', interval '18 hours');
select pg_temp.backdate_acceptance('r7', interval '2 days');
select is(private.send_shift_reconfirmations(), 1, 'another shift is asked');
select is((select count(*)::int from private.notification_link_actions(pg_temp.note('erin', 'shift.reconfirm', 'r7'))), 1, 'its email link offers accept');
update app.shifts set starts_at = now() - interval '1 minute' where id = pg_temp.id('r7');
select is((select count(*)::int from private.notification_link_actions(pg_temp.note('erin', 'shift.reconfirm', 'r7'))), 0,
  'once the shift has started the email offers nothing, even with the ask still Waiting');
select pg_temp.as_user('erin');
select throws_ok(format($$select app.respond_shift_reconfirmation(%L, false, 'Too late.')$$, pg_temp.id('r7')), 'XR001',
  'shift_reconfirm_answered: This shift was already confirmed, or nobody is asking any more.', 'and a late answer is refused, so a decline cannot reopen a running shift');
select pg_temp.as_platform();
select is((select shift_state::text from app.shifts where id = pg_temp.id('r7')), 'Accepted', 'the running shift keeps its worker');
select private.send_shift_reconfirmations();

-- A swap approved inside the window asks nobody ------------------------------------------------------------------------------------------
select pg_temp.accepted_shift('r8', 'carol', 'frank@org_a', 'prj_a', interval '60 hours');
select pg_temp.backdate_acceptance('r8', interval '3 days');
select pg_temp.as_user('frank');
with x as (insert into app.shift_swaps (shift_id, requested_by_membership_id, proposed_membership_id)
  values (pg_temp.id('r8'), pg_temp.id('frank@org_a'), pg_temp.id('gina@org_a')) returning id)
insert into world select 'swap_r8', id from x;
select pg_temp.as_user('alice');
select app.decide_shift_swap(pg_temp.id('swap_r8'), 'Approved', 'Covered.');
select pg_temp.as_platform();
update app.shifts set starts_at = now() + interval '16 hours', ends_at = now() + interval '24 hours' where id = pg_temp.id('r8');
select is(private.send_shift_reconfirmations(), 0, 'whoever took a shift by a swap approved inside the window is not asked');
select is(pg_temp.ask('r8'), '', 'so the shift has no ask');

-- A Waiting ask only sits on an Accepted shift ---------------------------------------------------------------------------------------------
select pg_temp.accepted_shift('r9', 'carol', 'erin@org_a', 'prj_a', interval '15 hours');
select pg_temp.backdate_acceptance('r9', interval '3 days');
select private.send_shift_reconfirmations();
select is(pg_temp.ask('r9'), 'Waiting', 'the worker is asked');
select pg_temp.as_user('carol');
select app.transition_shift(pg_temp.id('r9'), 'Accepted', 'Published', 'Times may move.');
select pg_temp.as_platform();
select is(pg_temp.ask('r9'), 'Withdrawn', 'a planner stepping the shift off Accepted withdraws the ask');
select ok(pg_temp.archived(pg_temp.note('erin', 'shift.reconfirm', 'r9')), 'and retires its notification');
select is((select count(*)::int from app.shift_responses r join app.shifts s on s.id = r.shift_id
  where r.ask_kind = 'Reconfirmation' and r.answer = 'Waiting' and r.deleted_at is null and s.shift_state <> 'Accepted'), 0,
  'no Waiting ask sits on a shift that is not Accepted');
select throws_ok(format($$select private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions', 'shift_id', %L, 'Draft', 'Accepted', 'Skip the offer.')$$, pg_temp.id('r9')), 'XR001',
  'shift_transition_not_allowed: A shift cannot move from Draft to Accepted.', 'the shift lifecycle is unchanged: no new state, no new transition');
select pg_temp.as_platform();

-- Declining with reopen on: a member shift becomes an open shift ---------------------------------------------------------------------
select pg_temp.accepted_shift('r4', 'alice', 'dave@org_a', 'prj_a', interval '21 hours');
select pg_temp.backdate_acceptance('r4', interval '3 days');
select private.send_shift_reconfirmations();
select pg_temp.as_user('dave');
select lives_ok(format($$select app.act_on_notification(%L, 'decline', 'Sick.')$$, pg_temp.note('dave', 'shift.reconfirm', 'r4')),
  'the worker declines from the push (notifications act)');
select pg_temp.as_platform();
select is(pg_temp.ask('r4'), 'Declined', 'the answer is Declined');
select is((select reason from app.shift_responses where shift_id = pg_temp.id('r4') and ask_kind = 'Reconfirmation'), 'Sick.',
  'with the reason');
select results_eq(format($$select shift_state::text, membership_id, engagement_id, roster_entry_id, project_position_id from app.shifts where id = %L$$, pg_temp.id('r4')),
  $$values ('Published'::text, null::uuid, null::uuid, null::uuid, null::uuid)$$,
  'with scheduling.reconfirm_reopen on (the default), the shift is a Published open shift with every worker column NULL');
select is((select reason from app.shift_state_transitions where shift_id = pg_temp.id('r4') order by created_at desc, id desc limit 1),
  'Declined at reconfirmation: Sick.', 'the ledger says why');
select isnt(pg_temp.note('alice', 'shift.reconfirm_declined', 'r4'), null, 'the planner who created it is told');
select is((select message_args ->> 'workerName' from app.notifications where id = pg_temp.note('alice', 'shift.reconfirm_declined', 'r4')), 'Dave Lindqvist',
  'by name, for a member');
select ok(pg_temp.archived(pg_temp.note('dave', 'shift.reconfirm', 'r4')), 'a decline retires the ask''s notification too');
select pg_temp.as_user('mia');
select lives_ok(format($$select app.claim_open_shift(%L)$$, pg_temp.id('r4')), 'another member claims it under the project''s rule');

-- Declining with reopen off: the shift keeps its worker
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'scheduling.reconfirm_reopen', 'Project', pg_temp.id('prj_a'), p_value_boolean => false);
select pg_temp.accepted_shift('r5', 'carol', 'mia@org_a', 'prj_a', interval '23 hours');
select pg_temp.backdate_acceptance('r5', interval '3 days');
select private.send_shift_reconfirmations();
select pg_temp.as_user('mia');
select lives_ok(format($$select app.respond_shift_reconfirmation(%L, false)$$, pg_temp.id('r5')), 'the worker declines without a reason');
select pg_temp.as_platform();
select results_eq(format($$select shift_state::text, membership_id from app.shifts where id = %L$$, pg_temp.id('r5')),
  format($$values ('Accepted'::text, %L::uuid)$$, pg_temp.id('mia@org_a')),
  'with scheduling.reconfirm_reopen off, the shift keeps its worker');
select is((select reason from app.shift_responses where shift_id = pg_temp.id('r5') and ask_kind = 'Reconfirmation'), 'No reason given.',
  'a decline without a reason says so');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'scheduling.reconfirm_reopen', 'Project', pg_temp.id('prj_a'), p_value_boolean => true);

-- A roster shift goes back to its agency's slot ----------------------------------------------------------------------------------
select app.set_setting(pg_temp.id('org_a'), 'scheduling.reconfirm_lead_hours', 'Project', pg_temp.id('prj_a'), p_value_integer => 72);
select pg_temp.as_user('olga');
select app.assign_roster_shift(pg_temp.id('slot_2'), pg_temp.id('e_stella'));
select pg_temp.as_user('stella');
select app.accept_engaged_shift(pg_temp.id('slot_2'));
select pg_temp.backdate_acceptance('slot_2', interval '4 days');
select private.send_shift_reconfirmations();
select is(pg_temp.ask('slot_2'), 'Waiting', 'the roster person is asked');
select is((select array_agg(action || '/' || audience) from private.notification_link_actions(pg_temp.note('stella', 'shift.reconfirm', 'slot_2'))),
  array['accept/Gateway'], 'and confirms in Gateway');
select pg_temp.as_user('stella');
select lives_ok(format($$select app.respond_shift_reconfirmation(%L, false, 'Family matter.')$$, pg_temp.id('slot_2')),
  'the roster person declines');
select pg_temp.as_platform();
select results_eq(format($$select shift_state::text, engagement_id, roster_entry_id from app.shifts where id = %L$$, pg_temp.id('slot_2')),
  format($$values ('Published'::text, %L::uuid, null::uuid)$$, pg_temp.id('eng_agency')),
  'the shift is the agency''s Published slot again, for the agency to fill');
select is((select message_args ->> 'workerName' from app.notifications where id = pg_temp.note('carol', 'shift.reconfirm_declined', 'slot_2')), 'Stella Okafor',
  'a creator who reads the advancing packet hears the roster person''s name');

-- app.decline_shift on a roster shift (6511, from 2200) ---------------------------------------------------------------------------
select pg_temp.as_user('olga');
select app.assign_roster_shift(pg_temp.id('slot_1'), pg_temp.id('e_theo'));
select pg_temp.as_user('frank');
select throws_ok(format($$select app.decline_shift(%L, 'Not mine.')$$, pg_temp.id('slot_1')), '42501', null,
  'a member does not decline a roster person''s shift');
select pg_temp.as_user('theo');
select lives_ok(format($$select app.decline_shift(%L, 'Double booked.')$$, pg_temp.id('slot_1')),
  'the roster person declines their Published shift');
select pg_temp.as_platform();
select results_eq(format($$select shift_state::text, engagement_id, roster_entry_id from app.shifts where id = %L$$, pg_temp.id('slot_1')),
  format($$values ('Published'::text, %L::uuid, null::uuid)$$, pg_temp.id('eng_agency')),
  'it goes back to the agency''s slot (engagement_id restored, roster_entry_id null)');
select is((select string_agg(answer::text, ',') from app.shift_responses where shift_id = pg_temp.id('slot_1') and ask_kind = 'Offer'
  and person_id = pg_temp.id('theo')), 'Declined', 'and their offer is answered Declined');

select is((select schedule from cron.job where jobname = 'xos_send_shift_reconfirmations'), '27 * * * *', 'the job runs hourly');

select * from finish();
rollback;
