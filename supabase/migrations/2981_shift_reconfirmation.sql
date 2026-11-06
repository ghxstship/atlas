-- 2981_shift_reconfirmation.sql
-- B9 (RRR-233; ADR 0148; parity gap G-123): a day-before "Still coming?" reconfirmation, answered with A127's one-tap
-- actions, that can reopen a declined shift to claiming (1322).
--
--   * private.send_shift_reconfirmations, hourly (pg_cron, minute 27): on projects with scheduling.reconfirm_shifts on,
--     the worker of every live Accepted shift that starts within scheduling.reconfirm_lead_hours (default 24), accepted
--     before that window opened, not taken by a swap approved inside it and not yet asked, gets a Waiting Reconfirmation
--     and the notification shift.reconfirm. A Waiting ask whose shift has started becomes No Answer and its notification
--     is retired. Running it again asks nobody twice.
--   * app.respond_shift_reconfirmation(shift, coming, reason): the person asked, who still works the shift, answers.
--     Coming answers Accepted. Not coming answers Declined with the reason (optional); with scheduling.reconfirm_reopen
--     on (the default) the shift reopens: a member or engaged shift becomes an ordinary Published open shift with
--     every worker column NULL, and a roster shift goes back to its agency's slot, as app.unassign_roster_shift does.
--     With it off the shift keeps its worker and shows on the shortages page (2986). Either way the shift's creator is
--     told (shift.reconfirm_declined) while they still hold crew.shift.write and can open the shift. Once the shift has
--     started it can no longer be answered, even in the hour before the job turns it to No Answer: a late decline would
--     reopen a running shift.
--   * private.guard_shift (from 0460) lets the reopen clear the worker (trusted operation shift_reconfirm).
--     private.return_reassigned_shift is not recreated: the reopen steps the shift to Published before it clears the
--     worker, so the trigger has nothing to return.
--   * app.decline_shift (from 2200) also lets the person on a roster entry decline their Published shift, which goes
--     back to the agency's slot, and answers the Waiting Offer Declined with the reason before the transition.
--   * private.notification_link_actions, app.act_on_notification and app.my_notifications_awaiting_answer (from 2200)
--     learn shift.reconfirm: an email carries an Accept link (Confirm you're coming) while the ask waits on its
--     recipient; push and the Inbox answer accept or decline. Shift kinds resolve the worker with R12's three-argument
--     private.shift_worker_person_id, so a roster person's offer is accepted through app.accept_engaged_shift (2752).
--     P9 (2861) and B14 (3034) also rebuild some of these: whichever merges later restates the others' branches.

-- Trusted operation shift_reconfirm on the shift guard (latest: 0460) ----------------------------------------------------------

create or replace function private.guard_shift()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_time_zone(new.time_zone);
  if new.record_id is not null then
    if (select r.project_id from app.records r where r.id = new.record_id) <> new.project_id
       or (select r.record_kind from app.records r where r.id = new.record_id) <> 'Shift' then
      perform private.refuse('shift_record', 'A shift staffs a Shift record of its own project.');
    end if;
  end if;
  if new.scope_node_id is not null and (select n.project_id from app.scope_nodes n where n.id = new.scope_node_id) <> new.project_id then
    perform private.refuse('shift_scope_project', 'A shift''s scope node belongs to its project.');
  end if;
  if tg_op = 'UPDATE' then
    if new.membership_id is distinct from old.membership_id
       and not private.in_trusted_operation('swap_transition') and not private.in_trusted_operation('shift_claim')
       and not private.in_trusted_operation('shift_reconfirm')
       and auth.uid() is not null and not private.can_on_project(new.project_id, 'crew.shift.write') then
      raise exception using errcode = '42501', message = 'crew.shift.write is required to reassign a shift';
    end if;
    if (new.starts_at <> old.starts_at or new.ends_at <> old.ends_at or new.role_code is distinct from old.role_code
        or new.time_zone <> old.time_zone or new.project_id <> old.project_id
        or new.scope_node_id is distinct from old.scope_node_id or new.record_id is distinct from old.record_id)
       and auth.uid() is not null and not private.can_on_project(new.project_id, 'crew.shift.write') then
      raise exception using errcode = '42501', message = 'crew.shift.write is required to change a shift';
    end if;
    if old.shift_state = 'Canceled' and new.shift_state = 'Canceled'
       and (new.starts_at <> old.starts_at or new.ends_at <> old.ends_at or new.membership_id is distinct from old.membership_id) then
      perform private.refuse('shift_canceled', 'A canceled shift keeps its times and person; plan a new shift instead.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_shift() is 'Shifts: IANA zone, Shift record and scope node of the same project, reassignment only by shift writers, an approved swap, a claim or a reopen after a declined reconfirmation (trusted operation shift_reconfirm, 2981), times and role only by shift writers, and a canceled shift is frozen.';
revoke all on function private.guard_shift() from public, anon, authenticated;

-- Asking ------------------------------------------------------------------------------------------------------------------------

create or replace function private.send_shift_reconfirmations()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shift record;
  v_id uuid;
  v_count integer := 0;
  v_gone record;
begin
  -- An ask nobody answered before the shift started ran out, and its notification goes with it.
  for v_gone in
    update app.shift_responses r set answer = 'No Answer', answered_at = now()
    from app.shifts s
    where s.id = r.shift_id and r.ask_kind = 'Reconfirmation' and r.answer = 'Waiting' and r.deleted_at is null
      and s.starts_at <= now()
    returning r.shift_id, r.person_id
  loop
    perform private.retire_shift_reconfirm_notices(v_gone.shift_id, v_gone.person_id);
  end loop;

  for v_shift in
    select s.id, s.org_id, s.project_id, s.starts_at, s.ends_at, w.person_id
    from app.shifts s
    join app.projects p on p.id = s.project_id and p.deleted_at is null
    cross join lateral (select private.shift_worker_person_id(s.membership_id, s.engagement_id, s.roster_entry_id) as person_id) w
    cross join lateral (select coalesce(private.setting_integer(p.org_id, 'scheduling.reconfirm_lead_hours', p.workspace_id, p.id), 24)::integer as hours) lead
    where s.deleted_at is null and s.shift_state = 'Accepted' and w.person_id is not null
      and s.starts_at > now() and s.starts_at <= now() + make_interval(hours => lead.hours)
      and coalesce(private.project_setting_boolean(s.project_id, 'scheduling.reconfirm_shifts'), false)
      -- Accepted before the window opened: a shift taken up inside it was just answered.
      and (select max(t.created_at) from app.shift_state_transitions t where t.shift_id = s.id and t.to_state = 'Accepted')
          < s.starts_at - make_interval(hours => lead.hours)
      -- A swap keeps the shift Accepted with its old ledger entry: whoever took it inside the window just answered too.
      and not exists (select 1 from app.swap_state_transitions t join app.shift_swaps w on w.id = t.swap_id
                      where w.shift_id = s.id and t.to_state = 'Approved'
                        and t.created_at >= s.starts_at - make_interval(hours => lead.hours))
      and not exists (select 1 from app.shift_responses r
                      where r.shift_id = s.id and r.person_id = w.person_id and r.ask_kind = 'Reconfirmation' and r.deleted_at is null)
    order by s.starts_at, s.id
  loop
    insert into app.shift_responses (project_id, shift_id, person_id, ask_kind)
    values (v_shift.project_id, v_shift.id, v_shift.person_id, 'Reconfirmation')
    returning id into v_id;
    perform private.notify(v_shift.org_id, v_shift.person_id, 'shift.reconfirm', 'app.shifts', v_shift.id, v_shift.project_id,
      jsonb_build_object('title', private.shift_notification_title(v_shift.id),
        'startsAt', to_char(v_shift.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'endsAt', to_char(v_shift.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'shiftResponseId', v_id));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function private.send_shift_reconfirmations() is 'Hourly (ADR 0148): asks the worker of each live Accepted shift on a project with scheduling.reconfirm_shifts on, starting within scheduling.reconfirm_lead_hours (default 24), accepted before that window opened and not taken by a swap approved inside it, whether they are still coming: one Waiting Reconfirmation per shift and person and the notification shift.reconfirm (title, startsAt, endsAt; shiftResponseId is for display). Waiting asks of shifts that started become No Answer and their notifications are retired. Idempotent. Returns how many it asked.';
revoke all on function private.send_shift_reconfirmations() from public, anon, authenticated;

select cron.schedule('xos_send_shift_reconfirmations', '27 * * * *', 'select private.send_shift_reconfirmations()');

-- Reopening a declined shift ----------------------------------------------------------------------------------------------------

create or replace function private.reopen_declined_shift(p_shift_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shift app.shifts;
  v_engagement uuid;
begin
  select * into v_shift from app.shifts s where s.id = p_shift_id and s.deleted_at is null for update;
  if v_shift.id is null or v_shift.shift_state = 'Canceled' then
    return;
  end if;
  if v_shift.roster_entry_id is not null then
    -- A roster shift goes back to its agency's slot, as app.unassign_roster_shift does, for the agency to fill again.
    v_engagement := (select r.engagement_id from app.engagement_roster_entries r where r.id = v_shift.roster_entry_id);
    perform private.begin_trusted_operation('roster_shift_assignment');
    if v_shift.shift_state = 'Accepted' then
      perform private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions',
        'shift_id', v_shift.id, 'Accepted', 'Published', p_reason);
    end if;
    update app.shifts set engagement_id = v_engagement, roster_entry_id = null where id = v_shift.id;
    perform private.end_trusted_operation('roster_shift_assignment');
    return;
  end if;
  -- A member or engaged shift becomes an ordinary open shift: Published first, with its worker, then no worker.
  perform private.begin_trusted_operation('shift_reconfirm');
  if v_shift.shift_state = 'Accepted' then
    perform private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions',
      'shift_id', v_shift.id, 'Accepted', 'Published', p_reason);
  end if;
  if v_shift.engagement_id is not null then
    -- private.guard_engaged_worker (R12, 2750) is not redefined: its trusted operation roster_shift_assignment is the
    -- one that lets a definer RPC clear engagement_id for a caller without crew.shift.write.
    perform private.begin_trusted_operation('roster_shift_assignment');
    update app.shifts set engagement_id = null where id = v_shift.id;
    perform private.end_trusted_operation('roster_shift_assignment');
  end if;
  update app.shifts set membership_id = null where id = v_shift.id;
  perform private.end_trusted_operation('shift_reconfirm');
end;
$$;

comment on function private.reopen_declined_shift(uuid, text) is 'Reopens a shift whose worker said they are not coming (2981): a member or engaged shift becomes a Published open shift with every worker column NULL (trusted operation shift_reconfirm), claimable under the project''s 1322 rule; a roster shift goes back to its agency''s slot (trusted operation roster_shift_assignment). The reason goes in the shift''s ledger.';
revoke all on function private.reopen_declined_shift(uuid, text) from public, anon, authenticated;

-- Answering ----------------------------------------------------------------------------------------------------------------------

create or replace function app.respond_shift_reconfirmation(p_shift_id uuid, p_coming boolean, p_reason text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_shift app.shifts;
  v_ask app.shift_responses;
  v_reason text := left(coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'No reason given.'), 500);
  v_creator uuid;
  v_reopen boolean;
begin
  select * into v_shift from app.shifts s where s.id = p_shift_id and s.deleted_at is null for update;
  if v_shift.id is null or p_coming is null
     or private.shift_worker_person_id(v_shift.membership_id, v_shift.engagement_id, v_shift.roster_entry_id) is distinct from v_person then
    raise exception using errcode = '42501', message = 'only the person asked, who still works the shift, answers';
  end if;
  select * into v_ask from app.shift_responses r
  where r.shift_id = p_shift_id and r.ask_kind = 'Reconfirmation' and r.answer = 'Waiting' and r.deleted_at is null
  for update;
  -- Once the shift has started there is nothing left to answer, even in the hour before the job records No Answer.
  if v_ask.id is null or v_shift.starts_at <= now() then
    perform private.refuse('shift_reconfirm_answered', 'This shift was already confirmed, or nobody is asking any more.');
  end if;
  if v_ask.person_id <> v_person then
    raise exception using errcode = '42501', message = 'only the person asked answers';
  end if;
  perform private.retire_shift_reconfirm_notices(v_shift.id, v_person);
  if p_coming then
    update app.shift_responses set answer = 'Accepted', answered_at = now() where id = v_ask.id;
    return v_ask.id;
  end if;

  update app.shift_responses set answer = 'Declined', answered_at = now(), reason = v_reason where id = v_ask.id;
  v_reopen := coalesce(private.project_setting_boolean(v_shift.project_id, 'scheduling.reconfirm_reopen'), true);
  if v_reopen then
    perform private.reopen_declined_shift(v_shift.id, left('Declined at reconfirmation: ' || v_reason, 500));
  end if;
  -- The planner who created the shift hears of it, while they may still staff it and open it.
  v_creator := v_shift.created_by;
  if v_creator is not null and v_creator <> v_person
     and private.person_capability_reach(v_creator, v_shift.org_id, 'crew.shift.write', false) is not null
     and private.person_may_read_subject(v_creator, to_jsonb(v_shift)) then
    perform private.notify(v_shift.org_id, v_creator, 'shift.reconfirm_declined', 'app.shifts', v_shift.id, v_shift.project_id,
      jsonb_build_object('title', private.shift_notification_title(v_shift.id),
        'startsAt', to_char(v_shift.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'endsAt', to_char(v_shift.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        -- A roster person's name is an advancing.packet.read fact (ADR 0148): without it the message names nobody.
        'workerName', case when v_shift.roster_entry_id is null
                             or private.person_capability_reach(v_creator, v_shift.org_id, 'advancing.packet.read', false) is not null
                           then coalesce((select p.full_name from app.people p where p.id = v_person), '') else '' end,
        'reopened', case when v_reopen then 'yes' else 'no' end));
  end if;
  return v_ask.id;
end;
$$;

comment on function app.respond_shift_reconfirmation(uuid, boolean, text) is 'The person asked "Still coming?" about a shift (2981), who still works it, answers its single Waiting Reconfirmation: coming answers Accepted; not coming answers Declined with the reason (optional, ''No reason given.'' by default) and, with scheduling.reconfirm_reopen on, reopens the shift (private.reopen_declined_shift), then tells the shift''s creator (shift.reconfirm_declined) while they hold crew.shift.write and can open it. Anyone else gets 42501; no Waiting ask, or a shift that has started, refuses shift_reconfirm_answered. The ask''s notification is retired. Returns the response id.';
revoke all on function app.respond_shift_reconfirmation(uuid, boolean, text) from public, anon;
grant execute on function app.respond_shift_reconfirmation(uuid, boolean, text) to authenticated, service_role;

-- Declining a published shift (latest: 2200) ----------------------------------------------------------------------------------------

create or replace function app.decline_shift(p_shift_id uuid, p_reason text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_shift app.shifts;
  v_reason text := coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'No reason given.');
  v_assigned boolean;
  v_entry uuid;
  v_engagement uuid;
begin
  select * into v_shift from app.shifts s where s.id = p_shift_id and s.deleted_at is null for update;
  -- The shift's member, its engaged worker or the person on its roster entry while the operational area is open. Every
  -- test is written so it is never null: an open or engaged shift has no membership, and `null in (...)` would let
  -- anyone through a negated check.
  v_assigned := v_shift.id is not null and (
    (v_shift.membership_id is not null
      and exists (select 1 from private.my_membership_ids() m (id) where m.id = v_shift.membership_id))
    or (v_shift.membership_id is null and v_shift.engagement_id is not null
      and exists (select 1 from app.engagements e where e.id = v_shift.engagement_id and e.person_id = v_person)
      and exists (select 1 from private.my_engagement_ids('operational') x (id) where x.id = v_shift.engagement_id))
    or (v_shift.membership_id is null and v_shift.roster_entry_id is not null
      and private.roster_entry_person(v_shift.roster_entry_id) = v_person
      and exists (select 1 from private.my_roster_entry_ids('operational') x (id) where x.id = v_shift.roster_entry_id)));
  if not coalesce(v_assigned, false) then
    raise exception using errcode = '42501', message = 'only the person assigned declines a shift';
  end if;
  if v_shift.shift_state <> 'Published' then
    perform private.refuse('shift_decline_state', 'Only a published shift you have not accepted can be declined.');
  end if;
  -- The offer is answered first, so the transition below finds nothing Waiting to withdraw.
  update app.shift_responses r set answer = 'Declined', answered_at = now(), reason = left(v_reason, 500)
  where r.shift_id = p_shift_id and r.ask_kind = 'Offer' and r.answer = 'Waiting' and r.deleted_at is null
    and r.person_id = v_person;
  if v_shift.roster_entry_id is not null then
    -- A roster shift goes back to the agency's slot, still Published, for the agency to place someone else.
    v_engagement := (select r.engagement_id from app.engagement_roster_entries r where r.id = v_shift.roster_entry_id);
    perform private.begin_trusted_operation('roster_shift_assignment');
    update app.shifts set engagement_id = v_engagement, roster_entry_id = null where id = p_shift_id;
    perform private.end_trusted_operation('roster_shift_assignment');
    perform private.write_audit_event(v_shift.org_id, 'crew.shift_declined', 'app.shifts', p_shift_id,
      jsonb_build_object('reason', left('Declined by the worker: ' || v_reason, 500), 'roster_entry_id', v_shift.roster_entry_id));
    return (select t.id from app.shift_state_transitions t where t.shift_id = p_shift_id order by t.created_at desc, t.id desc limit 1);
  end if;
  v_entry := private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions',
    'shift_id', p_shift_id, 'Published', 'Draft', left('Declined by the worker: ' || v_reason, 500));
  return v_entry;
end;
$$;

comment on function app.decline_shift(uuid, text) is 'The person assigned to a Published shift (its member, its engaged worker or the person on its roster entry, while the operational area is open) declines it, and their Waiting Offer is answered Declined with the reason (2981). A member or engaged shift returns to Draft with the reason in its ledger, for the scheduler to reassign and publish again; a roster shift goes back to its agency''s slot, still Published, with the reason in the audit trail. Returns the shift''s latest ledger entry id.';
revoke all on function app.decline_shift(uuid, text) from public, anon;
grant execute on function app.decline_shift(uuid, text) to authenticated, service_role;

-- What an email's links do (latest: 2200) ---------------------------------------------------------------------------------------------

create or replace function private.notification_link_actions(p_notification_id uuid)
returns table (action text, audience text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_note app.notifications;
  v_shift app.shifts;
begin
  select * into v_note from app.notifications n
  where n.id = p_notification_id and n.deleted_at is null and n.archived_at is null;
  if v_note.id is null or v_note.subject_id is null then
    return;
  end if;
  if v_note.kind = 'approval.requested' then
    if (v_note.subject_table = 'approval_instances' and exists (
          select 1 from app.approval_instances a where a.id = v_note.subject_id and a.deleted_at is null and a.approval_state = 'In Review'))
       or (v_note.subject_table = 'timesheets' and exists (
          select 1 from app.timesheets t where t.id = v_note.subject_id and t.deleted_at is null and t.timesheet_state = 'Submitted')) then
      return query values ('approve'::text, 'Atlas'::text), ('reject', 'Atlas');
    end if;
  elsif v_note.kind in ('shift.assigned', 'shift.changed') and v_note.subject_table = 'app.shifts' then
    select * into v_shift from app.shifts s where s.id = v_note.subject_id and s.deleted_at is null;
    if v_shift.shift_state = 'Published'
       and private.shift_worker_person_id(v_shift.membership_id, v_shift.engagement_id, v_shift.roster_entry_id) = v_note.recipient_person_id then
      return query select 'accept'::text, (case when v_shift.membership_id is null then 'Gateway' else 'Atlas' end)::text;
    end if;
  elsif v_note.kind = 'shift.reconfirm' and v_note.subject_table = 'app.shifts' then
    -- "Still coming?" (2981): Confirm you're coming, while the ask waits on the recipient and the shift has not started.
    -- Declining is in the app or from the push, where the person can say why.
    select * into v_shift from app.shifts s where s.id = v_note.subject_id and s.deleted_at is null;
    if v_shift.id is not null and v_shift.starts_at > now() and exists (
         select 1 from app.shift_responses r
         where r.shift_id = v_shift.id and r.ask_kind = 'Reconfirmation' and r.answer = 'Waiting' and r.deleted_at is null
           and r.person_id = v_note.recipient_person_id) then
      return query select 'accept'::text, (case when v_shift.membership_id is null then 'Gateway' else 'Atlas' end)::text;
    end if;
  elsif v_note.kind = 'offer.sent' and v_note.subject_table = 'app.offers' then
    if exists (select 1 from app.offers o where o.id = v_note.subject_id and o.deleted_at is null and o.offer_state = 'Sent') then
      return query values ('accept'::text, 'Gateway'::text);
    end if;
  end if;
end;
$$;

comment on function private.notification_link_actions(uuid) is 'The actions an email of a notification carries links for, with the app that confirms them, exactly where its Inbox item or push offers them now: approve and reject for an approval or a timesheet awaiting a decision (Atlas), accept for a published shift the recipient works through any worker column (Atlas for a member, Gateway for an engaged worker or a person on an agency''s roster), accept for a "Still coming?" ask still waiting on the recipient about a shift not yet started (2981, the same apps) and for an offer awaiting the applicant (Gateway). None once the notification is Done.';
revoke all on function private.notification_link_actions(uuid) from public, anon, authenticated;

create or replace function app.my_notifications_awaiting_answer()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select n.id from app.notifications n
  where n.recipient_person_id = private.current_person_id()
    and n.kind in ('shift.assigned', 'shift.changed', 'shift.reconfirm', 'offer.sent')
    and n.archived_at is null and n.deleted_at is null
    and exists (select 1 from private.notification_link_actions(n.id) a where a.action = 'accept');
$$;

comment on function app.my_notifications_awaiting_answer() is 'The signed-in person''s live notifications that still wait on their answer: a published shift they work, a "Still coming?" ask about a shift they work (2981), or an offer awaiting them (the ones whose email offers Accept now, private.notification_link_actions). Gateway leaves them out of For Your Information, where Done would retire their email links while the shift or offer is still unanswered (ADR 0106), and shows the asks in Needs You (ADR 0148).';
revoke all on function app.my_notifications_awaiting_answer() from public, anon;
grant execute on function app.my_notifications_awaiting_answer() to authenticated, service_role;

-- Acting where notifications arrive (latest: 2200) -----------------------------------------------------------------------------------

create or replace function app.act_on_notification(p_notification_id uuid, p_action text, p_comment text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_note app.notifications;
  v_shift app.shifts;
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  v_conversation uuid;
begin
  select * into v_note from app.notifications n
  where n.id = p_notification_id and n.recipient_person_id = v_person and n.deleted_at is null;
  -- Approving and rejecting are a member's. Done and answering a shift, an offer or a message are the recipient's while
  -- the notification is still theirs to see (private.is_my_notification: a member, an external party or an applicant
  -- the org works with, as row level security on notifications reads it) (A127).
  if v_note.id is null or not coalesce(case when p_action in ('approve', 'reject')
                                            then v_note.org_id in (select private.my_org_ids())
                                            else private.is_my_notification(v_note.id) end, false) then
    raise exception using errcode = '42501', message = 'notification not found';
  end if;
  if p_action is null or p_action not in ('approve', 'reject', 'done', 'accept', 'decline', 'reply') then
    perform private.refuse('inbox_action_unknown', 'An Inbox item is approved, rejected, accepted, declined, answered or marked Done.');
  end if;
  if p_action in ('approve', 'reject') then
    if v_note.kind <> 'approval.requested' or v_note.subject_table not in ('approval_instances', 'timesheets') then
      perform private.refuse('inbox_action_not_offered', 'Only an approval request is approved or rejected from the Inbox.');
    end if;
    if v_note.subject_table = 'timesheets' then
      if p_action = 'reject' and v_comment is null then
        perform private.refuse('timesheet_rejection_reason', 'Say why when you reject a timesheet.');
      end if;
      perform app.decide_timesheet(v_note.subject_id,
        (case when p_action = 'approve' then 'Approved' else 'Rejected' end)::app.approval_decision,
        coalesce(v_comment, 'Approved from a notification.'));
    else
      perform app.decide_approval(v_note.subject_id, p_action = 'approve', p_comment);
    end if;
  elsif p_action in ('accept', 'decline') then
    if v_note.kind in ('shift.assigned', 'shift.changed') and v_note.subject_table = 'app.shifts' then
      select * into v_shift from app.shifts s where s.id = v_note.subject_id;
      if p_action = 'decline' then
        perform app.decline_shift(v_note.subject_id, v_comment);
      elsif v_shift.membership_id is null and (v_shift.engagement_id is not null or v_shift.roster_entry_id is not null) then
        -- An engaged worker's shift, or a roster person's (R12, 2752), is accepted through app.accept_engaged_shift.
        perform app.accept_engaged_shift(v_note.subject_id, 'Accepted from a notification.');
      else
        perform app.accept_shift(v_note.subject_id, 'Accepted from a notification.');
      end if;
    elsif v_note.kind = 'shift.reconfirm' and v_note.subject_table = 'app.shifts' then
      -- "Still coming?" (2981): the ask is the recipient's single Waiting Reconfirmation of the shift.
      perform app.respond_shift_reconfirmation(v_note.subject_id, p_action = 'accept', v_comment);
    elsif v_note.kind = 'offer.sent' and v_note.subject_table = 'app.offers' then
      if p_action = 'accept' then
        perform app.accept_offer(v_note.subject_id);
      else
        perform app.decline_offer(v_note.subject_id, coalesce(v_comment, 'Declined from a notification.'));
      end if;
    else
      perform private.refuse('inbox_action_not_offered', 'Only a shift or an offer is accepted or declined from a notification.');
    end if;
  elsif p_action = 'reply' then
    v_conversation := case when v_note.message_args ->> 'conversation_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                           then (v_note.message_args ->> 'conversation_id')::uuid end;
    if v_note.kind <> 'message.received' or v_conversation is null then
      perform private.refuse('inbox_action_not_offered', 'Only a message is answered from a notification.');
    end if;
    if v_comment is null then
      perform private.refuse('notification_reply_empty', 'Write a reply first.');
    end if;
    perform app.send_chat_message(v_conversation, v_comment);
  end if;
  update app.notifications set read_at = coalesce(read_at, now()), archived_at = now()
  where id = v_note.id and created_at = v_note.created_at;
  return v_note.id;
end;
$$;

comment on function app.act_on_notification(uuid, text, text) is 'Acts on a notification where it arrives (Section 11.10 rule 5), for its recipient only, while it is still theirs to see (private.is_my_notification): approve or reject the approval or the timesheet an approval request asks for (a member''s; app.decide_approval and app.decide_timesheet decide every rule); accept or decline a published shift (app.accept_shift, app.accept_engaged_shift for an engaged or roster worker, app.decline_shift), a "Still coming?" ask (app.respond_shift_reconfirmation, 2981) or an offer awaiting the applicant (app.accept_offer, app.decline_offer); reply to a message (app.send_chat_message, the reply in p_comment); or mark it Done. A refusal names its rule and the item stays; a handled or Done item leaves the Inbox. Push notification actions call it through the API (notifications.act) and one-tap email links through app.use_notification_action. Returns the notification id.';
revoke all on function app.act_on_notification(uuid, text, text) from public, anon;
grant execute on function app.act_on_notification(uuid, text, text) to authenticated, service_role;
