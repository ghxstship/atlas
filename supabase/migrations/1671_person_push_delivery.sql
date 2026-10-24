-- 1671_person_push_delivery.sql
--
-- A101 (RRR-147), trace rows S4.3-15 and S4.4-20, ADR 0045. The push sender's database side delivers to the person's
-- own devices (1670):
--   * private.person_push_fallback: a delivery goes to the recipient's own devices when they have no device
--     registered with the notification's org, and only for an org they work with as an external party
--     (private.party_org_ids, 1131) or a marketplace match about a listing open to them
--     (private.marketplace_notice_open, 1461). Anyone else's own devices never carry an org's push (invariant 3)
--   * app.claim_notification_deliveries (from 1590, its latest definition): the Push row lists those devices when
--     the fallback applies, with the membership devices exactly as before otherwise. A marketplace match about a
--     listing open to the recipient is no longer suppressed because they work with no org: 1461 let private.notify
--     queue it, but its claim then suppressed the email and the push of a person who is not a party of the posting org
--   * app.web_push_devices (from 1533): the person's Gateway browsers, under the same fallback
--   * app.record_push_tickets, app.record_push_receipts (from 1361) and app.record_web_push_tickets (from 1533): a
--     ticket names whichever device it pushed, and a device a push service no longer knows is revoked in its own table
-- No later migration redefines any of them.

-- 1. When a person's own devices take an org's push -------------------------------------------------------------------

create or replace function private.person_push_fallback(p_person_id uuid, p_org_id uuid, p_kind text, p_subject_table text, p_subject_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
      select 1 from app.push_subscriptions ps join app.memberships m on m.id = ps.membership_id
      where m.person_id = p_person_id and ps.org_id = p_org_id and ps.revoked_at is null and ps.deleted_at is null)
    and (p_org_id in (select private.party_org_ids(p_person_id))
         or private.marketplace_notice_open(p_kind, p_subject_table, p_subject_id, p_person_id));
$$;

comment on function private.person_push_fallback(uuid, uuid, text, text, uuid) is 'Whether a push of an org goes to the recipient''s own devices (app.person_push_devices, A101): only when they have no device registered with the org, and the org is one they work with as an external party (an engagement or a company account the org holds as a counterparty) or the push is a marketplace match about a listing open to them (invariant 3).';
revoke all on function private.person_push_fallback(uuid, uuid, text, text, uuid) from public, anon, authenticated;

-- 2. app.claim_notification_deliveries (from 1590) --------------------------------------------------------------------

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

    -- A marketplace match that passes the first test is about a listing open to the recipient, who may work with no org
    -- at all (A89): only every other kind needs a membership or a party relationship (A101).
    if v_row.kind = 'opportunity.matched'
       and not private.marketplace_notice_open(v_row.kind, v_row.subject_table, v_row.subject_id, v_row.recipient_person_id) then
      v_reason := 'The listing is no longer open to the recipient.';
    elsif v_membership is null and v_row.kind <> 'opportunity.matched'
          and v_row.org_id not in (select private.party_org_ids(v_row.recipient_person_id)) then
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
      -- The devices registered with the org take the push. With none, the person's own devices do, for an org they work
      -- with as a party or a match about a listing open to them (A101).
      if private.person_push_fallback(v_row.recipient_person_id, v_row.org_id, v_row.kind, v_row.subject_table, v_row.subject_id) then
        select coalesce(jsonb_agg(jsonb_build_object('subscriptionId', pd.id, 'token', pd.expo_push_token) order by pd.last_seen_at desc), '[]'::jsonb)
        into v_devices
        from app.person_push_devices pd
        where pd.person_id = v_row.recipient_person_id and pd.revoked_at is null and pd.deleted_at is null
          and not exists (select 1 from app.push_tickets pt
                          where pt.notification_delivery_id = v_row.id and pt.person_push_device_id = pd.id and pt.deleted_at is null
                            and pt.message_status in ('Sent', 'Delivered', 'Bounced'));
      else
        select coalesce(jsonb_agg(jsonb_build_object('subscriptionId', ps.id, 'token', ps.expo_push_token) order by ps.last_seen_at desc), '[]'::jsonb)
        into v_devices
        from app.push_subscriptions ps join app.memberships m on m.id = ps.membership_id
        where m.person_id = v_row.recipient_person_id and ps.org_id = v_row.org_id and ps.revoked_at is null and ps.deleted_at is null
          and not exists (select 1 from app.push_tickets pt
                          where pt.notification_delivery_id = v_row.id and pt.push_subscription_id = ps.id and pt.deleted_at is null
                            and pt.message_status in ('Sent', 'Delivered', 'Bounced'));
      end if;
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

comment on function app.claim_notification_deliveries(app.notification_channel, integer) is 'Worker API (service role): claims due deliveries of a channel with SKIP LOCKED. Quiet hours are checked again unless the kind is on the bypass list (ADR 0033 decision 35): a member''s push waits until they end (Deferred) and a text is held for the member''s summary (1367); the push of someone with no membership waits out their own quiet hours (A89); in every case no later than the opening of the kind''s bypass window, as for a shift starting within 12 hours (1393). Suppresses, with the reason, a marketplace match whose listing is no longer open to the recipient (A89), and any other delivery whose recipient neither belongs to the org nor works with it as an external party; a match about a listing open to them goes out though they work with no org (A101). Also suppresses a delivery with no verified address, a suppressed address, no SMS consent or no device. Push rows list the devices not yet pushed for the delivery (push_devices): those registered with the org, or, when the recipient has none there and works with the org as a party or the push is a marketplace match open to them, their own devices (app.person_push_devices, A101). A claimed delivery becomes due again after 10 minutes unless its outcome is recorded.';
revoke all on function app.claim_notification_deliveries(app.notification_channel, integer) from public, anon, authenticated;
grant execute on function app.claim_notification_deliveries(app.notification_channel, integer) to service_role;

-- 3. Browsers the sender pushes (from 1533) ---------------------------------------------------------------------------

create or replace function app.web_push_devices(p_delivery_id uuid)
returns table (subscription_id uuid, endpoint text, p256dh text, auth text, app text)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id, b.web_endpoint, b.web_p256dh, b.web_auth, b.web_app
  from (
    select ps.id, ps.web_endpoint, ps.web_p256dh, ps.web_auth, ps.web_app, ps.last_seen_at
    from app.notification_deliveries d
    join app.notifications n on n.id = d.notification_id and n.created_at = d.notification_created_at
    join app.memberships m on m.person_id = n.recipient_person_id
    join app.push_subscriptions ps on ps.membership_id = m.id and ps.org_id = n.org_id
    where d.id = p_delivery_id and d.channel = 'Push'
      and ps.web_endpoint is not null and ps.revoked_at is null and ps.deleted_at is null
      and not exists (select 1 from app.push_tickets pt
                      where pt.notification_delivery_id = d.id and pt.push_subscription_id = ps.id and pt.deleted_at is null
                        and pt.message_status in ('Sent', 'Delivered', 'Bounced'))
    union all
    select pd.id, pd.web_endpoint, pd.web_p256dh, pd.web_auth, pd.web_app, pd.last_seen_at
    from app.notification_deliveries d
    join app.notifications n on n.id = d.notification_id and n.created_at = d.notification_created_at
    join app.person_push_devices pd on pd.person_id = n.recipient_person_id
    where d.id = p_delivery_id and d.channel = 'Push'
      and pd.web_endpoint is not null and pd.revoked_at is null and pd.deleted_at is null
      and private.person_push_fallback(n.recipient_person_id, n.org_id, n.kind, n.subject_table, n.subject_id)
      and not exists (select 1 from app.push_tickets pt
                      where pt.notification_delivery_id = d.id and pt.person_push_device_id = pd.id and pt.deleted_at is null
                        and pt.message_status in ('Sent', 'Delivered', 'Bounced'))
  ) b
  order by b.last_seen_at desc;
$$;

comment on function app.web_push_devices(uuid) is 'Push sender API (service role): the browsers a claimed Push delivery still goes to, with their endpoint and keys, as app.claim_notification_deliveries lists them: the recipient''s unrevoked browser rows in the delivery''s org not yet pushed for it, or, when the recipient has no device there and works with the org as a party or the push is a marketplace match open to them, their own Gateway browsers (A101), each with the app it subscribed in.';
revoke all on function app.web_push_devices(uuid) from public, anon, authenticated;
grant execute on function app.web_push_devices(uuid) to service_role;

-- 4. Tickets and receipts (from 1361 and 1533) ------------------------------------------------------------------------

create or replace function app.record_push_tickets(p_delivery_id uuid, p_tickets jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_d record;
  v_t jsonb;
  v_status app.message_status;
  v_code text;
  v_device uuid;
begin
  select d.id, d.notification_created_at, d.channel into v_d from app.notification_deliveries d where d.id = p_delivery_id;
  if v_d.id is null or v_d.channel <> 'Push' then
    perform private.refuse('delivery_unknown', 'No such push delivery.');
  end if;
  if jsonb_typeof(p_tickets) <> 'array' then
    perform private.refuse('push_tickets_invalid', 'Tickets come as an array.');
  end if;
  for v_t in select * from jsonb_array_elements(p_tickets) loop
    v_device := (v_t ->> 'subscriptionId')::uuid;
    v_code := left(v_t #>> '{error}', 100);
    v_status := case
      when v_t ->> 'status' = 'ok' then 'Sent'
      when v_code in ('DeviceNotRegistered', 'MessageTooBig') then 'Bounced'
      else 'Failed' end;
    if not exists (select 1 from app.push_subscriptions ps where ps.id = v_device)
       and exists (select 1 from app.person_push_devices pd where pd.id = v_device) then
      insert into app.push_tickets (notification_delivery_id, notification_created_at, person_push_device_id, expo_ticket_id,
        message_status, error_code, error_message)
      values (v_d.id, v_d.notification_created_at, v_device,
        case when v_status = 'Sent' then left(v_t ->> 'ticketId', 200) end, v_status, v_code, left(v_t ->> 'message', 1000))
      on conflict (notification_delivery_id, person_push_device_id) where deleted_at is null do update
        set expo_ticket_id = excluded.expo_ticket_id, message_status = excluded.message_status,
          error_code = excluded.error_code, error_message = excluded.error_message, receipt_checked_at = null;
    else
      insert into app.push_tickets (notification_delivery_id, notification_created_at, push_subscription_id, expo_ticket_id,
        message_status, error_code, error_message)
      values (v_d.id, v_d.notification_created_at, v_device,
        case when v_status = 'Sent' then left(v_t ->> 'ticketId', 200) end, v_status, v_code, left(v_t ->> 'message', 1000))
      on conflict (notification_delivery_id, push_subscription_id) where deleted_at is null do update
        set expo_ticket_id = excluded.expo_ticket_id, message_status = excluded.message_status,
          error_code = excluded.error_code, error_message = excluded.error_message, receipt_checked_at = null;
    end if;
    if v_code = 'DeviceNotRegistered' then
      update app.push_subscriptions set revoked_at = now() where id = v_device and revoked_at is null;
      update app.person_push_devices set revoked_at = now() where id = v_device and revoked_at is null;
    end if;
  end loop;
end;
$$;

comment on function app.record_push_tickets(uuid, jsonb) is 'Push sender API (service role): records the Expo tickets of one delivery, [{subscriptionId, status ok|error, ticketId, error, message}], where subscriptionId names a membership device or one of the person''s own (A101). An accepted message is Sent; DeviceNotRegistered and MessageTooBig are Bounced, and DeviceNotRegistered revokes the device so no later claim lists it; any other error is Failed and the device is pushed again on the retry.';
revoke all on function app.record_push_tickets(uuid, jsonb) from public, anon, authenticated;
grant execute on function app.record_push_tickets(uuid, jsonb) to service_role;

create or replace function app.record_push_receipts(p_receipts jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_r jsonb;
  v_t record;
  v_code text;
  v_status app.message_status;
  v_pruned integer := 0;
begin
  if jsonb_typeof(p_receipts) <> 'array' then
    perform private.refuse('push_receipts_invalid', 'Receipts come as an array.');
  end if;
  for v_r in select * from jsonb_array_elements(p_receipts) loop
    select t.id, t.notification_delivery_id, t.notification_created_at, t.push_subscription_id, t.person_push_device_id into v_t
    from app.push_tickets t where t.expo_ticket_id = v_r ->> 'ticketId' and t.deleted_at is null;
    if v_t.id is null then
      continue;
    end if;
    v_code := left(v_r ->> 'error', 100);
    v_status := case when v_r ->> 'status' = 'ok' then 'Delivered'
                     when v_code in ('DeviceNotRegistered', 'MessageTooBig') then 'Bounced' else 'Failed' end;
    update app.push_tickets set message_status = v_status, error_code = v_code, error_message = left(v_r ->> 'message', 1000),
      receipt_checked_at = now()
    where id = v_t.id;
    if v_code = 'DeviceNotRegistered' then
      update app.push_subscriptions set revoked_at = now() where id = v_t.push_subscription_id and revoked_at is null;
      update app.person_push_devices set revoked_at = now() where id = v_t.person_push_device_id and revoked_at is null;
      v_pruned := v_pruned + 1;
    end if;
    if v_status = 'Delivered' then
      update app.notification_deliveries set message_status = 'Delivered'
      where id = v_t.notification_delivery_id and notification_created_at = v_t.notification_created_at and message_status = 'Sent';
    elsif not exists (select 1 from app.push_tickets o where o.notification_delivery_id = v_t.notification_delivery_id
                      and o.deleted_at is null and o.message_status in ('Sent', 'Delivered')) then
      update app.notification_deliveries set message_status = 'Bounced', last_error = left(coalesce(v_r ->> 'message', v_code), 2000)
      where id = v_t.notification_delivery_id and notification_created_at = v_t.notification_created_at and message_status = 'Sent';
    end if;
  end loop;
  return v_pruned;
end;
$$;

comment on function app.record_push_receipts(jsonb) is 'Push sender API (service role): records Expo receipts, [{ticketId, status ok|error, error, message}]. An ok receipt marks the ticket and its delivery Delivered. DeviceNotRegistered revokes the device, a membership device or one of the person''s own (A101), pruning it from later claims. A delivery none of whose devices accepted the push becomes Bounced. Returns how many devices were pruned.';
revoke all on function app.record_push_receipts(jsonb) from public, anon, authenticated;
grant execute on function app.record_push_receipts(jsonb) to service_role;

create or replace function app.record_web_push_tickets(p_delivery_id uuid, p_tickets jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_d record;
  v_t jsonb;
  v_status app.message_status;
  v_code text;
  v_device uuid;
  v_own boolean;
begin
  select d.id, d.notification_created_at, d.channel into v_d from app.notification_deliveries d where d.id = p_delivery_id;
  if v_d.id is null or v_d.channel <> 'Push' then
    perform private.refuse('delivery_unknown', 'No such push delivery.');
  end if;
  if jsonb_typeof(p_tickets) <> 'array' then
    perform private.refuse('push_tickets_invalid', 'Tickets come as an array.');
  end if;
  for v_t in select * from jsonb_array_elements(p_tickets) loop
    v_device := (v_t ->> 'subscriptionId')::uuid;
    v_own := exists (select 1 from app.person_push_devices pd where pd.id = v_device and pd.web_endpoint is not null);
    if not v_own and not exists (select 1 from app.push_subscriptions ps where ps.id = v_device and ps.web_endpoint is not null) then
      perform private.refuse('push_tickets_invalid', 'A Web Push ticket names a browser subscription.');
    end if;
    v_code := left(v_t #>> '{error}', 100);
    v_status := case
      when v_t ->> 'status' = 'ok' then 'Delivered'
      when v_code in ('DeviceNotRegistered', 'MessageTooBig') then 'Bounced'
      else 'Failed' end;
    if v_own then
      insert into app.push_tickets (notification_delivery_id, notification_created_at, person_push_device_id, push_service,
        message_status, error_code, error_message, receipt_checked_at)
      values (v_d.id, v_d.notification_created_at, v_device, 'Web Push', v_status, v_code, left(v_t ->> 'message', 1000), now())
      on conflict (notification_delivery_id, person_push_device_id) where deleted_at is null do update
        set push_service = 'Web Push', expo_ticket_id = null, message_status = excluded.message_status,
          error_code = excluded.error_code, error_message = excluded.error_message, receipt_checked_at = excluded.receipt_checked_at;
    else
      insert into app.push_tickets (notification_delivery_id, notification_created_at, push_subscription_id, push_service,
        message_status, error_code, error_message, receipt_checked_at)
      values (v_d.id, v_d.notification_created_at, v_device, 'Web Push', v_status, v_code, left(v_t ->> 'message', 1000), now())
      on conflict (notification_delivery_id, push_subscription_id) where deleted_at is null do update
        set push_service = 'Web Push', expo_ticket_id = null, message_status = excluded.message_status,
          error_code = excluded.error_code, error_message = excluded.error_message, receipt_checked_at = excluded.receipt_checked_at;
    end if;
    if v_code = 'DeviceNotRegistered' then
      update app.push_subscriptions set revoked_at = now() where id = v_device and revoked_at is null;
      update app.person_push_devices set revoked_at = now() where id = v_device and revoked_at is null;
    end if;
  end loop;
end;
$$;

comment on function app.record_web_push_tickets(uuid, jsonb) is 'Push sender API (service role): records what each push service answered for one delivery, [{subscriptionId, status ok|error, error, message}], where subscriptionId names a membership browser or one of the person''s own Gateway browsers (A101). 201 Created (ok) is Delivered, as push services give no receipt; DeviceNotRegistered (404 or 410) revokes the browser and MessageTooBig (413) are Bounced; anything else is Failed and the browser is pushed again on the retry.';
revoke all on function app.record_web_push_tickets(uuid, jsonb) from public, anon, authenticated;
grant execute on function app.record_web_push_tickets(uuid, jsonb) to service_role;
