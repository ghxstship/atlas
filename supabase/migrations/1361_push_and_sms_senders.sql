-- 1361_push_and_sms_senders.sql
-- A80 (RRR-125), finding A65-012: private.notify (0520, 1131) resolves Push and SMS deliveries, but only email
-- ever left the platform. This migration gives the push and SMS senders in @xos/platform (notification-dispatch)
-- what they need:
--   * app.push_tickets: one row per delivery and device the Expo push service accepted or refused, so a retried
--     delivery never pushes the same device twice (idempotency per delivery), and receipts are checked later
--   * app.claim_notification_deliveries, replaced: returns the notification id, category and the devices still
--     to push, and checks quiet hours again when the delivery is claimed (Section 14.5: quiet hours by recipient
--     time zone). SMS also keeps a default window of 21:00 to 08:00 in the recipient's time zone when the member
--     set no quiet hours of their own
--   * private.recipient_address: the verified phone in E.164 (Supabase Auth stores it without the plus), so
--     consent and suppression lookups match
--   * receipts: app.claim_push_receipts and app.record_push_receipts; DeviceNotRegistered revokes the device
--     (app.push_subscriptions.revoked_at), which prunes it from every later claim
--   * SMS: app.record_sms_keyword (inbound STOP, START and HELP from the Twilio webhook: the consent ledger and
--     the STOP suppression in every org that texts the number) and app.record_sms_status (Twilio status
--     callbacks: delivered or failed)

-- Verified addresses ------------------------------------------------------------------------------------------------

create or replace function private.recipient_address(p_person_id uuid, p_channel app.notification_channel)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case p_channel
    when 'Email' then (select lower(u.email) from auth.users u join app.people p on p.user_id = u.id where p.id = p_person_id)
    when 'SMS' then (select '+' || ltrim(u.phone, '+') from auth.users u join app.people p on p.user_id = u.id
                     where p.id = p_person_id and u.phone_confirmed_at is not null and coalesce(u.phone, '') <> '')
  end;
$$;

comment on function private.recipient_address(uuid, app.notification_channel) is 'Verified sign-in email or phone of a person, the only addresses notifications go to. Phones come back in E.164 with the plus (1361), as consent and suppression rows store them.';

-- Push tickets ---------------------------------------------------------------------------------------------------------

create table app.push_tickets (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  notification_delivery_id uuid not null,
  notification_created_at timestamptz not null,
  push_subscription_id uuid not null references app.push_subscriptions (id),
  expo_ticket_id text,
  message_status app.message_status not null,
  error_code text,
  error_message text,
  receipt_checked_at timestamptz,
  foreign key (notification_delivery_id, notification_created_at) references app.notification_deliveries (id, notification_created_at),
  constraint push_tickets_status check (message_status in ('Sent', 'Delivered', 'Failed', 'Bounced')),
  constraint push_tickets_ticket_when_sent check (message_status not in ('Sent', 'Delivered') or expo_ticket_id is not null),
  constraint push_tickets_ticket_id_length check (expo_ticket_id is null or char_length(expo_ticket_id) <= 200),
  constraint push_tickets_error_code_length check (error_code is null or char_length(error_code) <= 100),
  constraint push_tickets_error_message_length check (error_message is null or char_length(error_message) <= 1000)
);

create index push_tickets_delivery_idx on app.push_tickets (notification_delivery_id, notification_created_at);
create index push_tickets_subscription_idx on app.push_tickets (push_subscription_id);
create unique index push_tickets_expo_ticket_key on app.push_tickets (expo_ticket_id) where expo_ticket_id is not null;

call private.install_domain_table('app.push_tickets', 'app.push_subscriptions', 'push_subscription_id');
create unique index push_tickets_delivery_device_key on app.push_tickets (notification_delivery_id, push_subscription_id) where deleted_at is null;
create index push_tickets_receipt_due_idx on app.push_tickets (created_at) where message_status = 'Sent' and receipt_checked_at is null;
call private.describe('app.push_tickets', 'One push of one delivery to one device through the Expo push service (A65-012, ADR 0030): the ticket Expo returned, or why it refused the message, then the receipt. One row per delivery and device, so a retried delivery never pushes a device twice. Written only by the push sender''s RPCs.', array[
  'notification_delivery_id', 'Push delivery the ticket belongs to.',
  'notification_created_at', 'Partition key of the delivery, checked by the foreign key.',
  'push_subscription_id', 'Device pushed.',
  'expo_ticket_id', 'Ticket id the Expo push service returned; receipts are fetched by it.',
  'message_status', 'Sent when Expo accepted the message, Delivered once the receipt confirms it reached Apple or Google, Failed on an error worth retrying, Bounced when the device is gone (DeviceNotRegistered) or the message can never be sent.',
  'error_code', 'Expo error code, for example DeviceNotRegistered or MessageRateExceeded.',
  'error_message', 'Expo error message.',
  'receipt_checked_at', 'When the receipt was read.'
]);

call private.install_policies('app.push_tickets',
  $$org_id in (select private.orgs_with_capability('org.notifications.write'))$$);

-- Quiet hours at claim time -------------------------------------------------------------------------------------------

create or replace function private.member_time_zone(p_membership_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select s.time_zone from app.notification_settings s where s.membership_id = p_membership_id and s.deleted_at is null),
    (select pv.value_text from app.personal_setting_values pv
     join app.memberships m on m.id = p_membership_id and m.person_id = pv.person_id
     where pv.setting_key = 'locale.time_zone' and pv.deleted_at is null and (pv.org_id is null or pv.org_id = m.org_id)
     order by pv.org_id nulls last limit 1),
    (select v.value_text from app.setting_values v
     join app.memberships m on m.id = p_membership_id and m.org_id = v.org_id
     where v.setting_key = 'locale.time_zone' and v.scope_kind = 'Organization' and v.scope_id = v.org_id and v.deleted_at is null));
$$;

comment on function private.member_time_zone(uuid) is 'The time zone a member is reached in: their notification settings, else their own locale.time_zone, else their org''s. Null when none was ever chosen.';

create or replace function private.sms_quiet_until(p_membership_id uuid, p_at timestamptz)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_own timestamptz := private.local_quiet_until(p_membership_id, p_at);
  v_zone text;
  v_local timestamp;
begin
  if v_own is not null or exists (
    select 1 from app.notification_settings s
    where s.membership_id = p_membership_id and s.deleted_at is null and s.quiet_hours_start is not null) then
    return v_own;
  end if;
  v_zone := private.member_time_zone(p_membership_id);
  if v_zone is null or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_zone) then
    return null;
  end if;
  v_local := p_at at time zone v_zone;
  if v_local::time >= time '21:00' then
    return ((v_local::date + 1) + time '08:00') at time zone v_zone;
  elsif v_local::time < time '08:00' then
    return (v_local::date + time '08:00') at time zone v_zone;
  end if;
  return null;
end;
$$;

comment on function private.sms_quiet_until(uuid, timestamptz) is 'When a non-urgent SMS to a member may go, if p_at is inside quiet hours: the member''s own quiet hours when set; otherwise the default SMS window of 21:00 to 08:00 in the member''s time zone (Section 14.5, TCPA). Null when the text may go now or no time zone is known.';

-- The delivery worker, with the push devices and the quiet hours check -------------------------------------------------

drop function app.claim_notification_deliveries(app.notification_channel, integer);

create function app.claim_notification_deliveries(p_channel app.notification_channel, p_limit integer default 50)
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
  v_devices jsonb;
  v_ticketed boolean;
begin
  for v_row in
    select d.id, d.notification_created_at, n.id as notification_id, n.org_id, n.recipient_person_id, n.kind, n.message_args,
      n.subject_table, n.subject_id, t.email_template_code, t.category_code, c.urgent
    from app.notification_deliveries d
    join app.notifications n on n.id = d.notification_id and n.created_at = d.notification_created_at
    join private.notification_templates t on t.kind = n.kind and t.channel = d.channel
    join private.notification_categories c on c.code = t.category_code
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

    -- Quiet hours may have begun since private.notify queued the delivery.
    if p_channel in ('SMS', 'Push') and not v_row.urgent and v_membership is not null then
      v_quiet := case when p_channel = 'SMS' then private.sms_quiet_until(v_membership, now())
                      else private.local_quiet_until(v_membership, now()) end;
      if v_quiet is not null then
        update app.notification_deliveries set message_status = 'Deferred', deliver_after = v_quiet
        where id = v_row.id and notification_created_at = v_row.notification_created_at;
        continue;
      end if;
    end if;

    if v_membership is null and v_row.org_id not in (select private.party_org_ids(v_row.recipient_person_id)) then
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

comment on function app.claim_notification_deliveries(app.notification_channel, integer) is 'Worker API (service role): claims due deliveries of a channel with SKIP LOCKED. A non-urgent SMS or push whose member is now inside quiet hours waits again (Deferred) until they end; SMS also waits out 21:00 to 08:00 in the member''s time zone when they set no quiet hours (1361). Suppresses, with the reason, any delivery whose recipient neither belongs to the org nor works with it as an external party, has no verified address, is suppressed, lacks SMS consent or has no device. Push rows list the devices not yet pushed for the delivery (push_devices), so a retry never pushes a device twice; an empty list with a ticket already sent means the delivery only needs its outcome recorded. A claimed delivery becomes due again after 10 minutes unless its outcome is recorded.';

-- Push tickets and receipts -----------------------------------------------------------------------------------------------

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
begin
  select d.id, d.notification_created_at, d.channel into v_d from app.notification_deliveries d where d.id = p_delivery_id;
  if v_d.id is null or v_d.channel <> 'Push' then
    perform private.refuse('delivery_unknown', 'No such push delivery.');
  end if;
  if jsonb_typeof(p_tickets) <> 'array' then
    perform private.refuse('push_tickets_invalid', 'Tickets come as an array.');
  end if;
  for v_t in select * from jsonb_array_elements(p_tickets) loop
    v_code := left(v_t #>> '{error}', 100);
    v_status := case
      when v_t ->> 'status' = 'ok' then 'Sent'
      when v_code in ('DeviceNotRegistered', 'MessageTooBig') then 'Bounced'
      else 'Failed' end;
    insert into app.push_tickets (notification_delivery_id, notification_created_at, push_subscription_id, expo_ticket_id,
      message_status, error_code, error_message)
    values (v_d.id, v_d.notification_created_at, (v_t ->> 'subscriptionId')::uuid,
      case when v_status = 'Sent' then left(v_t ->> 'ticketId', 200) end, v_status, v_code, left(v_t ->> 'message', 1000))
    on conflict (notification_delivery_id, push_subscription_id) where deleted_at is null do update
      set expo_ticket_id = excluded.expo_ticket_id, message_status = excluded.message_status,
        error_code = excluded.error_code, error_message = excluded.error_message, receipt_checked_at = null;
    if v_code = 'DeviceNotRegistered' then
      update app.push_subscriptions set revoked_at = now()
      where id = (v_t ->> 'subscriptionId')::uuid and revoked_at is null;
    end if;
  end loop;
end;
$$;

comment on function app.record_push_tickets(uuid, jsonb) is 'Push sender API (service role): records the Expo tickets of one delivery, [{subscriptionId, status ok|error, ticketId, error, message}]. An accepted message is Sent; DeviceNotRegistered and MessageTooBig are Bounced, and DeviceNotRegistered revokes the device so no later claim lists it; any other error is Failed and the device is pushed again on the retry.';

create or replace function app.claim_push_receipts(p_limit integer default 1000)
returns table (ticket_id text)
language sql
volatile
security definer
set search_path = ''
as $$
  select t.expo_ticket_id from app.push_tickets t
  where t.message_status = 'Sent' and t.receipt_checked_at is null and t.deleted_at is null
    and t.created_at <= now() - interval '15 minutes' and t.created_at > now() - interval '24 hours'
  order by t.created_at
  limit least(greatest(p_limit, 1), 1000);
$$;

comment on function app.claim_push_receipts(integer) is 'Push sender API (service role): Expo ticket ids whose receipt is due, at least 15 minutes after the push and before Expo forgets the receipt at 24 hours, oldest first, at most 1,000 (one getReceipts call).';

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
    select t.id, t.notification_delivery_id, t.notification_created_at, t.push_subscription_id into v_t
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

comment on function app.record_push_receipts(jsonb) is 'Push sender API (service role): records Expo receipts, [{ticketId, status ok|error, error, message}]. An ok receipt marks the ticket and its delivery Delivered. DeviceNotRegistered revokes the device (pruning it from later claims). A delivery none of whose devices accepted the push becomes Bounced. Returns how many devices were pruned.';

-- SMS: inbound keywords and status callbacks ----------------------------------------------------------------------------

create or replace function app.record_sms_keyword(p_phone_e164 text, p_action app.sms_consent_action, p_keyword text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_person uuid;
  v_count integer := 0;
begin
  if p_phone_e164 is null or p_phone_e164 !~ '^\+[1-9][0-9]{6,14}$' then
    perform private.refuse('sms_phone_invalid', 'The number is not in E.164 format.');
  end if;
  select p.id into v_person from auth.users u join app.people p on p.user_id = u.id
  where '+' || ltrim(u.phone, '+') = p_phone_e164 and u.phone_confirmed_at is not null
  limit 1;
  -- Every org that ever recorded consent for the number is an org that may text it.
  for v_org in select distinct e.org_id from app.sms_consent_events e where e.phone_e164 = p_phone_e164 and e.deleted_at is null loop
    insert into app.sms_consent_events (org_id, person_id, phone_e164, action, keyword, source)
    values (v_org, v_person, p_phone_e164, p_action, left(upper(btrim(p_keyword)), 20), 'SMS');
    if p_action = 'Opt Out' then
      insert into app.suppression_list (org_id, channel, address, reason)
      select v_org, 'SMS', p_phone_e164, 'STOP'
      where not exists (select 1 from app.suppression_list s where s.org_id = v_org and s.channel = 'SMS' and s.address = p_phone_e164
                        and s.reason = 'STOP' and s.lifted_at is null and s.deleted_at is null);
    elsif p_action = 'Opt In' then
      update app.suppression_list set lifted_at = now()
      where org_id = v_org and channel = 'SMS' and address = p_phone_e164 and reason = 'STOP' and lifted_at is null and deleted_at is null;
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function app.record_sms_keyword(text, app.sms_consent_action, text) is 'SMS webhook API (service role): records an inbound keyword (TCPA and 10DLC, Section 14.5) in every org that ever recorded consent for the number. STOP and its synonyms record an Opt Out and the STOP suppression; START records an Opt In and lifts the STOP suppression; HELP is recorded as a Help event. Returns how many orgs it touched.';

create or replace function app.record_sms_status(p_provider_message_id text, p_status text, p_error text default null)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_d record;
begin
  select d.id, d.notification_created_at, d.message_status into v_d from app.notification_deliveries d
  where d.channel = 'SMS' and d.provider_message_id = p_provider_message_id
  order by d.notification_created_at desc limit 1;
  if v_d.id is null then
    return false;
  end if;
  if p_status = 'delivered' then
    update app.notification_deliveries set message_status = 'Delivered'
    where id = v_d.id and notification_created_at = v_d.notification_created_at and message_status in ('Sent', 'Delivered');
  elsif p_status in ('undelivered', 'failed') then
    update app.notification_deliveries set message_status = 'Bounced', last_error = left(coalesce(p_error, p_status), 2000)
    where id = v_d.id and notification_created_at = v_d.notification_created_at and message_status in ('Sent', 'Delivered');
  end if;
  return true;
end;
$$;

comment on function app.record_sms_status(text, text, text) is 'SMS webhook API (service role): records a Twilio status callback by message SID. delivered marks the delivery Delivered; undelivered and failed mark it Bounced with the carrier error (a retry would fail the same way). Other statuses change nothing. Returns false for an unknown SID.';

-- Retention -------------------------------------------------------------------------------------------------------------

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.push_tickets', 'Age', 'created_at', interval '30 days', 'Delete', 'Expo forgets receipts after 24 hours; tickets are kept 30 days for support.');

-- Privileges ------------------------------------------------------------------------------------------------------------

revoke all on function private.recipient_address(uuid, app.notification_channel) from public, anon, authenticated;
revoke all on function private.member_time_zone(uuid) from public, anon, authenticated;
revoke all on function private.sms_quiet_until(uuid, timestamptz) from public, anon, authenticated;
revoke all on function app.claim_notification_deliveries(app.notification_channel, integer) from public, anon, authenticated;
grant execute on function app.claim_notification_deliveries(app.notification_channel, integer) to service_role;
revoke all on function app.record_push_tickets(uuid, jsonb) from public, anon, authenticated;
grant execute on function app.record_push_tickets(uuid, jsonb) to service_role;
revoke all on function app.claim_push_receipts(integer) from public, anon, authenticated;
grant execute on function app.claim_push_receipts(integer) to service_role;
revoke all on function app.record_push_receipts(jsonb) from public, anon, authenticated;
grant execute on function app.record_push_receipts(jsonb) to service_role;
revoke all on function app.record_sms_keyword(text, app.sms_consent_action, text) from public, anon, authenticated;
grant execute on function app.record_sms_keyword(text, app.sms_consent_action, text) to service_role;
revoke all on function app.record_sms_status(text, text, text) from public, anon, authenticated;
grant execute on function app.record_sms_status(text, text, text) to service_role;
