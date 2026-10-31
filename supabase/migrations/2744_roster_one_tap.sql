-- 2744_roster_one_tap.sql
-- R11 One-tap answers to a roster invitation (RRR-192; A127, ADR 0106, Section 11.10 rule 5). R4's
-- roster_entry.invited (2642) tells a person they were put on a crew roster; it now carries the actions A127 gives
-- offers. Each function is recreated from its latest definition (2200) with the roster branch added; nothing else
-- changes.
--
--   * private.notification_link_actions: the email carries an Accept link, confirmed in Gateway, while the entry is
--     live, not Withdrawn, still Pending and the person's own.
--   * app.my_notifications_awaiting_answer: such an invitation waits on the person, so Gateway's For Your Information
--     list leaves it out until they answer.
--   * app.act_on_notification: accept and decline answer the entry through R4's app.respond_roster_entry, so its
--     rules decide (the confirm page in Gateway, which never acts on GET, and Compass's push actions both call it).
-- The push reaches Compass in the engagement_offer category, whose Accept and Decline actions call notifications.act
-- (packages/platform/src/notifications/push.ts).

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
       and private.shift_worker_person_id(v_shift.membership_id, v_shift.engagement_id) = v_note.recipient_person_id then
      return query select 'accept'::text, (case when v_shift.membership_id is null then 'Gateway' else 'Atlas' end)::text;
    end if;
  elsif v_note.kind = 'offer.sent' and v_note.subject_table = 'app.offers' then
    if exists (select 1 from app.offers o where o.id = v_note.subject_id and o.deleted_at is null and o.offer_state = 'Sent') then
      return query values ('accept'::text, 'Gateway'::text);
    end if;
  elsif v_note.kind = 'roster_entry.invited' and v_note.subject_table = 'engagement_roster_entries' then
    -- R11: a roster invitation the person has not answered yet.
    if exists (
        select 1 from app.engagement_roster_entries r
        join app.engagements e on e.id = r.engagement_id and e.deleted_at is null
        where r.id = v_note.subject_id and r.deleted_at is null and r.entry_state <> 'Withdrawn'
          and r.person_response = 'Pending'
          and private.roster_entry_person_id(r.is_self, r.person_id, e.person_id) = v_note.recipient_person_id) then
      return query values ('accept'::text, 'Gateway'::text);
    end if;
  end if;
end;
$$;

comment on function private.notification_link_actions(uuid) is 'The actions an email of a notification carries links for, with the app that confirms them, exactly where its Inbox item or push offers them now: approve and reject for an approval or a timesheet awaiting a decision (Atlas), accept for a published shift the recipient works (Atlas for a member, Gateway for an engaged worker), for an offer awaiting the applicant (Gateway) and for a roster invitation the person has not answered (Gateway, R11). None once the notification is Done.';
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
    and n.kind in ('shift.assigned', 'shift.changed', 'offer.sent', 'roster_entry.invited')
    and n.archived_at is null and n.deleted_at is null
    and exists (select 1 from private.notification_link_actions(n.id) a where a.action = 'accept');
$$;

comment on function app.my_notifications_awaiting_answer() is 'The signed-in person''s live notifications that still wait on their answer: a published shift they work, an offer awaiting them, or a roster invitation they have not answered (R11) (the ones whose email offers Accept now, private.notification_link_actions). Gateway leaves them out of For Your Information, where Done would retire their email links while the shift, offer or invitation is still unanswered (ADR 0106).';
revoke all on function app.my_notifications_awaiting_answer() from public, anon;
grant execute on function app.my_notifications_awaiting_answer() to authenticated, service_role;

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
  -- Approving and rejecting are a member's. Done and answering a shift, an offer, a roster invitation or a message are
  -- the recipient's while the notification is still theirs to see (private.is_my_notification: a member, an external
  -- party or an applicant the org works with, as row level security on notifications reads it) (A127).
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
      elsif v_shift.membership_id is null and v_shift.engagement_id is not null then
        perform app.accept_engaged_shift(v_note.subject_id, 'Accepted from a notification.');
      else
        perform app.accept_shift(v_note.subject_id, 'Accepted from a notification.');
      end if;
    elsif v_note.kind = 'offer.sent' and v_note.subject_table = 'app.offers' then
      if p_action = 'accept' then
        perform app.accept_offer(v_note.subject_id);
      else
        perform app.decline_offer(v_note.subject_id, coalesce(v_comment, 'Declined from a notification.'));
      end if;
    elsif v_note.kind = 'roster_entry.invited' and v_note.subject_table = 'engagement_roster_entries' then
      -- R11: the person answers their roster entry; R4's RPC decides who may and when.
      perform app.respond_roster_entry(v_note.subject_id,
        (case when p_action = 'accept' then 'Accepted' else 'Declined' end)::app.roster_person_response);
    else
      perform private.refuse('inbox_action_not_offered', 'Only a shift, an offer or a roster invitation is accepted or declined from a notification.');
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
comment on function app.act_on_notification(uuid, text, text) is 'Acts on a notification where it arrives (Section 11.10 rule 5), for its recipient only, while it is still theirs to see (private.is_my_notification): approve or reject the approval or the timesheet an approval request asks for (a member''s; app.decide_approval and app.decide_timesheet decide every rule); accept or decline a published shift (app.accept_shift, app.accept_engaged_shift, app.decline_shift), an offer awaiting the applicant (app.accept_offer, app.decline_offer) or a roster invitation (app.respond_roster_entry, R11); reply to a message (app.send_chat_message, the reply in p_comment); or mark it Done. A refusal names its rule and the item stays; a handled or Done item leaves the Inbox. Push notification actions call it through the API (notifications.act) and one-tap email links through app.use_notification_action. Returns the notification id.';
revoke all on function app.act_on_notification(uuid, text, text) from public, anon;
grant execute on function app.act_on_notification(uuid, text, text) to authenticated, service_role;
