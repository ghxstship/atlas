-- 1590_notification_and_settings_integration.sql
--
-- Orchestrator block (ADR 0022, 1590-1599), RRR-125. The batch-c audit fixes (1392 to 1397) were written before A83 to
-- A99 merged. A89's 1461 then recreated private.notify and app.claim_notification_deliveries from their 1367 bodies, and
-- because 1461 runs after 1393 it dropped 1393's changes to both:
--   * every notification carries the actorName its copy names, and an emitter's actor with no name reads as the org;
--   * a held shift change waits no later than the opening of its bypass window (private.quiet_hours_bypass_opens).
-- Of every function 1392 to 1397 define, these two are the only ones a later migration redefines. This recreates each
-- from 1461's body, which keeps the marketplace match (private.marketplace_notice_open) and the quiet hours of people
-- with no membership (private.person_quiet_until), with 1393's changes put back. The bypass window now also caps the
-- push of someone with no membership, which 1461 holds for their own quiet hours: an external crew member's shift change
-- waits no longer than a member's.

-- 1. private.notify (from 1461, with 1393's actor and bypass window) ----------------------------------------------------

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
      if private.person_channel_enabled(p_recipient_person_id, v_category, v_channel) then
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
    if private.channel_enabled(v_membership, v_category, v_channel) then
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

comment on function private.notify(uuid, uuid, text, text, uuid, uuid, jsonb) is 'Creates a notification and its outside deliveries. Its message arguments always carry actorName (1393): the emitter''s; when the emitter passes none, the signed-in person''s name, else the org''s when a job acts; when the emitter''s actor has no name yet, the org''s, never the signed-in person''s, who may not be the actor. An active member gets one delivery per channel they receive the category on (their preference, the org default and mandatory categories, 1362). During quiet hours a push waits (Deferred) and a text is held for the member''s summary (1367); only kinds on the bypass list go at once (ADR 0033 decision 35), and a kind with a bypass window waits no later than its opening (1393). Non-urgent email joins the digest when the member chose one. With In App off the notification is recorded already archived. An external party of the org (1131), or a person a marketplace match is about a listing open to (A89), gets the notification and an Email and a Push delivery as their own preferences allow; the push waits out their own quiet hours (app.person_notification_settings) unless the kind bypasses them, and no later than the opening of its bypass window (1590). Anyone else gets nothing (invariant 3). Returns the notification id, or null.';

-- 2. app.claim_notification_deliveries (from 1461, with 1393's bypass window) -------------------------------------------

create or replace function app.claim_notification_deliveries(p_channel app.notification_channel, p_limit integer default 50)
returns table (
  delivery_id uuid, org_id uuid, recipient_person_id uuid, address text, kind text, email_template_code text,
  message_args jsonb, subject_table text, subject_id uuid, push_tokens text[],
  notification_id uuid, category_code text, push_devices jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_address text;
  v_reason text;
  v_transactional boolean;
  v_membership uuid;
  v_quiet timestamptz;
  v_opens timestamptz;
  v_devices jsonb;
  v_ticketed boolean;
begin
  for v_row in
    select d.id, d.notification_created_at, n.id as notification_id, n.org_id, n.recipient_person_id, n.kind, n.message_args,
      n.subject_table, n.subject_id, n.project_id, t.email_template_code, t.category_code
    from app.notification_deliveries d
    join app.notifications n on n.id = d.notification_id and n.created_at = d.notification_created_at
    join private.notification_templates t on t.kind = n.kind and t.channel = d.channel
    where d.channel = p_channel and d.message_status in ('Queued', 'Deferred') and d.deliver_after <= now()
    order by d.deliver_after
    limit least(greatest(p_limit, 1), 500)
    for update of d skip locked
  loop
    v_reason := null;
    v_devices := null;
    v_address := private.recipient_address(v_row.recipient_person_id, p_channel);
    v_transactional := coalesce((select e.transactional from private.email_templates e where e.code = v_row.email_template_code), false);
    select m.id into v_membership from app.memberships m
    where m.org_id = v_row.org_id and m.person_id = v_row.recipient_person_id and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    order by m.valid_from desc limit 1;

    -- Quiet hours may have begun since private.notify queued the delivery: a member's (1367), or for someone with no
    -- membership their own (A89).
    if p_channel in ('SMS', 'Push') and not private.bypasses_quiet_hours(v_row.kind, v_row.message_args, now()) then
      if v_membership is not null then
        v_quiet := case when p_channel = 'SMS' then private.sms_quiet_until(v_membership, v_row.project_id, now())
                        else private.local_quiet_until(v_membership, now()) end;
      elsif p_channel = 'Push' then
        v_quiet := private.person_quiet_until(v_row.recipient_person_id, now());
      else
        v_quiet := null;
      end if;
      -- A shift change waits only until its bypass window opens, when that comes first (1393), member or not.
      v_opens := private.quiet_hours_bypass_opens(v_row.kind, v_row.message_args);
      if v_quiet is not null and v_opens > now() and v_opens < v_quiet then
        v_quiet := v_opens;
      end if;
      if v_quiet is not null then
        if p_channel = 'SMS' then
          perform private.hold_sms_for_summary(v_row.id, v_row.notification_created_at, v_membership, v_quiet);
        else
          update app.notification_deliveries set message_status = 'Deferred', deliver_after = v_quiet
          where id = v_row.id and notification_created_at = v_row.notification_created_at;
        end if;
        continue;
      end if;
    end if;

    if v_row.kind = 'opportunity.matched'
       and not private.marketplace_notice_open(v_row.kind, v_row.subject_table, v_row.subject_id, v_row.recipient_person_id) then
      v_reason := 'The listing is no longer open to the recipient.';
    elsif v_membership is null and v_row.org_id not in (select private.party_org_ids(v_row.recipient_person_id)) then
      v_reason := 'Recipient no longer belongs to the org or works with it.';
    elsif p_channel in ('Email', 'SMS') and v_address is null then
      v_reason := 'No verified address on the channel.';
    elsif p_channel in ('Email', 'SMS') and exists (
      select 1 from app.suppression_list s
      where s.org_id = v_row.org_id and s.channel = p_channel and s.address = v_address and s.lifted_at is null and s.deleted_at is null
        and (s.reason in ('Hard Bounce', 'Complaint', 'STOP', 'Manual')
             or (not v_transactional and (s.category_code is null or s.category_code = v_row.category_code)))) then
      v_reason := 'Address is on the suppression list.';
    elsif p_channel = 'SMS' and not coalesce((select c.may_text from app.sms_consent_status c
                                              where c.org_id = v_row.org_id and c.phone_e164 = v_address), false) then
      v_reason := 'No SMS consent for the number.';
    elsif p_channel = 'Push' then
      select coalesce(jsonb_agg(jsonb_build_object('subscriptionId', ps.id, 'token', ps.expo_push_token) order by ps.last_seen_at desc), '[]'::jsonb)
      into v_devices
      from app.push_subscriptions ps join app.memberships m on m.id = ps.membership_id
      where m.person_id = v_row.recipient_person_id and ps.org_id = v_row.org_id and ps.revoked_at is null and ps.deleted_at is null
        and not exists (select 1 from app.push_tickets pt
                        where pt.notification_delivery_id = v_row.id and pt.push_subscription_id = ps.id and pt.deleted_at is null
                          and pt.message_status in ('Sent', 'Delivered', 'Bounced'));
      v_ticketed := exists (select 1 from app.push_tickets pt
                            where pt.notification_delivery_id = v_row.id and pt.deleted_at is null and pt.message_status in ('Sent', 'Delivered'));
      if jsonb_array_length(v_devices) = 0 and not v_ticketed then
        v_reason := 'No registered device.';
      end if;
    end if;
    if v_reason is not null then
      update app.notification_deliveries set message_status = 'Suppressed', last_error = v_reason
      where id = v_row.id and notification_created_at = v_row.notification_created_at;
      continue;
    end if;
    update app.notification_deliveries set attempt_count = attempt_count + 1, message_status = 'Queued', deliver_after = now() + interval '10 minutes'
    where id = v_row.id and notification_created_at = v_row.notification_created_at;
    delivery_id := v_row.id;
    org_id := v_row.org_id;
    recipient_person_id := v_row.recipient_person_id;
    address := v_address;
    kind := v_row.kind;
    email_template_code := v_row.email_template_code;
    message_args := v_row.message_args;
    subject_table := v_row.subject_table;
    subject_id := v_row.subject_id;
    push_tokens := case when p_channel = 'Push' then (select array_agg(d ->> 'token') from jsonb_array_elements(v_devices) d) end;
    notification_id := v_row.notification_id;
    category_code := v_row.category_code;
    push_devices := v_devices;
    return next;
  end loop;
end;
$$;

comment on function app.claim_notification_deliveries(app.notification_channel, integer) is 'Worker API (service role): claims due deliveries of a channel with SKIP LOCKED. Quiet hours are checked again unless the kind is on the bypass list (ADR 0033 decision 35): a member''s push waits until they end (Deferred) and a text is held for the member''s summary (1367); the push of someone with no membership waits out their own quiet hours (A89); in every case no later than the opening of the kind''s bypass window, as for a shift starting within 12 hours (1393). Suppresses, with the reason, a marketplace match whose listing is no longer open to the recipient (A89), and any delivery whose recipient neither belongs to the org nor works with it as an external party nor may see the listing a match is about, has no verified address, is suppressed, lacks SMS consent or has no device. Push rows list the devices not yet pushed for the delivery (push_devices). A claimed delivery becomes due again after 10 minutes unless its outcome is recorded.';

-- Privileges (create or replace keeps them; restated for review) -------------------------------------------------------

revoke all on function private.notify(uuid, uuid, text, text, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function app.claim_notification_deliveries(app.notification_channel, integer) from public, anon, authenticated;
grant execute on function app.claim_notification_deliveries(app.notification_channel, integer) to service_role;
