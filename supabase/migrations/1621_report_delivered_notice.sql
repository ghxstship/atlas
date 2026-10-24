-- 1621_report_delivered_notice.sql
--
-- Notification and access decisions (ADR 0022, 1620-1629), RRR-125; ADR 0033 decision 77 (2026-10-23). A
-- delivered scheduled report reaches the recipient's Inbox and a push, with no second email: the report.deliver worker
-- (1127, packages/data report-deliveries.ts) already emails the file, and that email stays the only one.
--   * report.delivered reaches In App and Push only (notification-kinds.yaml, seed 1620). private.notify created a
--     delivery on every channel the recipient receives the category on, whether or not the kind has a template there,
--     so an Email delivery of report.delivered would have waited forever unclaimed, or joined the recipient's digest
--     email. It now creates deliveries only on the channels the kind reaches, which also keeps A89's opportunity.matched
--     (In App, Email and Push) off SMS. Recreated from 1590, its latest definition, with nothing else changed.
--   * app.finish_report_delivery (1127) sends the recipient report.delivered once the worker records the email sent,
--     about the report definition when the recipient may open it (its owner, or a reader of its source once it is
--     shared), so the Inbox item and the browser push open the report in Atlas (Reports, Saved reports, with the
--     report's panel open). A recipient who may not is told about no record, so it opens their Inbox. A failed
--     delivery sends nothing.

-- 1. private.notify (from 1590): only the channels the kind reaches -----------------------------------------------------

create or replace function private.notify(
  p_org_id uuid,
  p_recipient_person_id uuid,
  p_kind text,
  p_subject_table text default null,
  p_subject_id uuid default null,
  p_project_id uuid default null,
  p_message_args jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_membership uuid;
  v_category text := (select distinct t.category_code from private.notification_templates t where t.kind = p_kind);
  -- The channels the kind reaches: a kind that names fewer than all of them in notification-kinds.yaml (1620) has no
  -- template row on the others, and a delivery there would never be claimed or would join an email digest.
  v_channels app.notification_channel[] := array(select t.channel from private.notification_templates t where t.kind = p_kind);
  v_urgent boolean;
  v_args jsonb := coalesce(p_message_args, '{}'::jsonb);
  v_bypass boolean;
  v_id uuid;
  v_created timestamptz;
  v_channel app.notification_channel;
  v_quiet timestamptz;
  v_opens timestamptz;
  v_digest timestamptz;
  v_delivery uuid;
begin
  -- The copy of most kinds names who acted ({actorName}). An emitter that passes no actorName gets the signed-in
  -- person, or the org when a job acts. An emitter that names its actor knows who acted, and the signed-in person
  -- may be someone else (an approver whose decision moves a request to the next step), so an actor with no name
  -- yet reads as the org, never as whoever is signed in.
  if not (v_args ? 'actorName') then
    v_args := v_args || jsonb_build_object('actorName', coalesce(
      (select p.full_name from app.people p where p.id = private.current_person_id()),
      (select o.name from app.organizations o where o.id = p_org_id), ''));
  elsif nullif(v_args ->> 'actorName', '') is null then
    v_args := v_args || jsonb_build_object('actorName', coalesce(
      (select o.name from app.organizations o where o.id = p_org_id), ''));
  end if;
  v_bypass := private.bypasses_quiet_hours(p_kind, v_args, now());
  v_opens := private.quiet_hours_bypass_opens(p_kind, v_args);
  select m.id into v_membership from app.memberships m
  where m.org_id = p_org_id and m.person_id = p_recipient_person_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  order by m.valid_from desc limit 1;
  if v_membership is null and p_org_id not in (select private.party_org_ids(p_recipient_person_id))
     and not private.marketplace_notice_open(p_kind, p_subject_table, p_subject_id, p_recipient_person_id) then
    return null;
  end if;
  v_urgent := (select c.urgent from private.notification_categories c where c.code = v_category);
  insert into app.notifications (org_id, recipient_person_id, kind, actor_person_id, subject_table, subject_id, project_id, message_args,
    archived_at)
  values (p_org_id, p_recipient_person_id, p_kind, private.current_person_id(), p_subject_table, p_subject_id, p_project_id,
    v_args,
    case when v_membership is not null and v_category is not null and not private.channel_enabled(v_membership, v_category, 'In App')
         then now() end)
  returning id, created_at into v_id, v_created;

  if v_membership is null then
    -- An external party or a marketplace user: their own Email and Push choices (1131). A push waits out their own quiet
    -- hours unless the kind bypasses them (A89); digests and SMS are membership settings.
    foreach v_channel in array array['Email', 'Push']::app.notification_channel[] loop
      if v_channel = any (v_channels) and private.person_channel_enabled(p_recipient_person_id, v_category, v_channel) then
        v_quiet := case when v_channel = 'Push' and not v_bypass then private.person_quiet_until(p_recipient_person_id, now()) end;
        -- A shift change waits only until its bypass window opens, as a member's does (1393, 1590).
        if v_quiet is not null and v_opens > now() and v_opens < v_quiet then
          v_quiet := v_opens;
        end if;
        insert into app.notification_deliveries (notification_id, notification_created_at, channel, message_status, deliver_after)
        values (v_id, v_created, v_channel, (case when v_quiet is not null then 'Deferred' else 'Queued' end)::app.message_status,
          coalesce(v_quiet, now()));
      end if;
    end loop;
    return v_id;
  end if;

  foreach v_channel in array array['Email', 'SMS', 'Push']::app.notification_channel[] loop
    if v_channel = any (v_channels) and private.channel_enabled(v_membership, v_category, v_channel) then
      v_quiet := case
        when v_bypass then null
        when v_channel = 'SMS' then private.sms_quiet_until(v_membership, p_project_id, now())
        when v_channel = 'Push' then private.local_quiet_until(v_membership, now()) end;
      -- A shift change waits only until its bypass window opens, when that comes before the quiet hours end (1393).
      if v_quiet is not null and v_opens > now() and v_opens < v_quiet then
        v_quiet := v_opens;
      end if;
      v_digest := case when v_channel = 'Email' and not v_urgent then private.next_digest_at(v_membership, now()) end;
      insert into app.notification_deliveries (notification_id, notification_created_at, channel, message_status, deliver_after)
      values (v_id, v_created, v_channel,
        (case when v_digest is not null then 'Digest' when v_quiet is not null then 'Deferred' else 'Queued' end)::app.message_status,
        coalesce(v_digest, v_quiet, now()))
      returning id into v_delivery;
      if v_digest is not null then
        insert into app.email_digest_queue (notification_delivery_id, notification_created_at, membership_id, due_at)
        values (v_delivery, v_created, v_membership, v_digest);
      elsif v_channel = 'SMS' and v_quiet is not null then
        perform private.hold_sms_for_summary(v_delivery, v_created, v_membership, v_quiet);
      end if;
    end if;
  end loop;
  return v_id;
end;
$$;

comment on function private.notify(uuid, uuid, text, text, uuid, uuid, jsonb) is 'Creates a notification and its outside deliveries. Its message arguments always carry actorName (1393): the emitter''s; when the emitter passes none, the signed-in person''s name, else the org''s when a job acts; when the emitter''s actor has no name yet, the org''s, never the signed-in person''s, who may not be the actor. Deliveries go only to the channels the kind reaches (its private.notification_templates rows, 1621). An active member gets one delivery per such channel they receive the category on (their preference, the org default and mandatory categories, 1362). During quiet hours a push waits (Deferred) and a text is held for the member''s summary (1367); only kinds on the bypass list go at once (ADR 0033 decision 35), and a kind with a bypass window waits no later than its opening (1393). Non-urgent email joins the digest when the member chose one. With In App off the notification is recorded already archived. An external party of the org (1131), or a person a marketplace match is about a listing open to (A89), gets the notification and an Email and a Push delivery as their own preferences and the kind''s channels allow; the push waits out their own quiet hours (app.person_notification_settings) unless the kind bypasses them, and no later than the opening of its bypass window (1590). Anyone else gets nothing (invariant 3). Returns the notification id, or null.';
revoke all on function private.notify(uuid, uuid, text, text, uuid, uuid, jsonb) from public, anon, authenticated;

-- 2. app.finish_report_delivery (from 1127): a sent report reaches the Inbox -------------------------------------------

create or replace function app.finish_report_delivery(p_delivery_id uuid, p_sent boolean, p_provider_message_id text default null, p_error text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_delivery app.report_deliveries;
  v_report app.report_definitions;
  v_person uuid;
  v_opens boolean;
begin
  select d.* into v_delivery from app.report_deliveries d where d.id = p_delivery_id and d.deleted_at is null for update;
  if v_delivery.id is null then
    perform private.refuse('report_delivery_missing', 'The report delivery does not exist.');
  end if;
  if v_delivery.delivery_status <> 'Queued' then
    perform private.refuse('report_delivery_finished', 'This report delivery has already finished.');
  end if;
  if p_sent then
    update app.report_deliveries set delivery_status = 'Sent', sent_at = now(),
      provider_message_id = left(p_provider_message_id, 200), last_error = null
    where id = p_delivery_id;
    perform private.emit_event(v_delivery.org_id, 'report.delivered', 'report_deliveries', v_delivery.id, null,
      jsonb_build_object('report_schedule_id', v_delivery.report_schedule_id, 'report_run_id', v_delivery.report_run_id));
    -- The Inbox and a push tell the recipient the report is in their email (decision 77); the email is the worker's.
    select def.* into v_report from app.report_runs r join app.report_definitions def on def.id = r.report_definition_id
    where r.id = v_delivery.report_run_id;
    select m.person_id into v_person from app.memberships m where m.id = v_delivery.membership_id;
    -- The notice is about the report only for a recipient who may open it, as 0550's policy reads: its owner, or anyone
    -- who may read reports on its source once it is shared. Anyone else is told with no record, so the Inbox item and
    -- the push open the Inbox instead of Saved reports with no panel; the file is in their email either way.
    v_opens := v_report.deleted_at is null and (
      exists (select 1 from app.memberships m where m.id = v_report.membership_id and m.person_id = v_person)
      or (v_report.shared
          and private.person_capability_reach(v_person, v_report.org_id, 'reports.report.read', true) = 'organization'
          and private.person_capability_reach(v_person, v_report.org_id,
                (select s.read_capability from private.report_sources s where s.code = v_report.source_code), true) = 'organization'));
    perform private.notify(v_delivery.org_id, v_person, 'report.delivered',
      case when v_opens then 'app.report_definitions' end, case when v_opens then v_report.id end, null,
      jsonb_build_object('title', v_report.name, 'reportRunId', v_delivery.report_run_id));
  else
    if p_error is null or btrim(p_error) = '' then
      perform private.refuse('report_delivery_error', 'A failed delivery records why it failed.');
    end if;
    update app.report_deliveries set delivery_status = 'Failed', last_error = left(p_error, 2000) where id = p_delivery_id;
  end if;
end;
$$;

comment on function app.finish_report_delivery(uuid, boolean, text, text) is 'Worker API (service role): records that a scheduled report email went out (with the transport''s message id) or failed (with the reason). A sent report also sends the recipient report.delivered (1621), in the Inbox and as a push only, about the report definition when the recipient may open it (its owner, or a reader of its source once shared), so it opens the report in Atlas, and about no record otherwise; the worker''s email stays the only email.';
revoke all on function app.finish_report_delivery(uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function app.finish_report_delivery(uuid, boolean, text, text) to service_role;
