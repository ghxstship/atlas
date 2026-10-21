-- 1461_marketplace_notifications_and_person_quiet_hours.sql
-- A89 (RRR-134), finding A65-008, work package WP8. Two changes to the notification queue (0520, 1131, 1362, 1367) so
-- saved-search alerts and expiry reminders reach Gateway users as A80 and ADR 0033 decision 35 intend:
--   1. A marketplace match reaches a person the posting org has no relationship with yet. private.notify reached only
--      members and external parties of the org (invariant 3). A notification of kind opportunity.matched about an
--      opportunity now also reaches a person while that listing is open to them (private.opportunity_open_to_person,
--      with the org's marketplace visibility cap from 1327). The rule is the listing's own visibility, so it never
--      widens who sees a listing: when the listing closes, is hidden by moderation or by a Do Not Engage flag, or the
--      org narrows its visibility, the delivery is suppressed and the notification leaves the person's inbox.
--   2. People without a membership keep quiet hours too. app.person_notification_settings holds a person's own quiet
--      hours and the time zone they are read in, set in Gateway Settings, Notifications. A push to an external party or
--      a marketplace user waits out those quiet hours (Deferred) unless its kind is on the bypass list
--      (private.notification_quiet_hours_bypass, ADR 0033 decision 35), at queue time and again at claim time. Email is
--      never held by quiet hours, for members either; external parties receive no SMS.
-- private.notify and app.claim_notification_deliveries start from their latest definitions (1367) and keep every later
-- behavior: the bypass list, the SMS summary, org defaults and mandatory categories, the push devices and tickets.
-- The notifications read and update policy and private.is_my_notification start from 1131.

-- Marketplace relationship -----------------------------------------------------------------------------------------------

create or replace function private.marketplace_notice_open(p_kind text, p_subject_table text, p_subject_id uuid, p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_kind = 'opportunity.matched' and p_subject_table = 'opportunities' and p_subject_id is not null and exists (
    select 1 from app.opportunities o
    where o.id = p_subject_id and o.deleted_at is null
      and private.opportunity_open_to_person(o.id, o.org_id, o.visibility, o.opportunity_state, p_person_id));
$$;

comment on function private.marketplace_notice_open(text, text, uuid, uuid) is 'True when a notification is a marketplace match (opportunity.matched about an opportunity) whose listing is open to the person now (private.opportunity_open_to_person, A76 1327). It lets a match reach someone the posting org has no relationship with, for exactly as long as they may see the listing (A89).';
revoke all on function private.marketplace_notice_open(text, text, uuid, uuid) from public, anon, authenticated;

create or replace function private.marketplace_notice_open_to_me(p_kind text, p_subject_table text, p_subject_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.marketplace_notice_open(p_kind, p_subject_table, p_subject_id, private.current_person_id());
$$;

comment on function private.marketplace_notice_open_to_me(text, text, uuid) is 'private.marketplace_notice_open for the signed-in person, for the notifications read policy: it never answers for anyone else.';
revoke all on function private.marketplace_notice_open_to_me(text, text, uuid) from public, anon;
grant execute on function private.marketplace_notice_open_to_me(text, text, uuid) to authenticated, service_role;

-- A person's own quiet hours ------------------------------------------------------------------------------------------------

create table app.person_notification_settings (
  id uuid primary key default private.uuid_v7(),
  deleted_at timestamptz,
  person_id uuid not null references app.people (id),
  time_zone text not null,
  quiet_hours_start time,
  quiet_hours_end time,
  constraint person_notification_settings_quiet_pair check ((quiet_hours_start is null) = (quiet_hours_end is null)),
  constraint person_notification_settings_quiet_distinct check (quiet_hours_start is distinct from quiet_hours_end or quiet_hours_start is null)
);

create unique index person_notification_settings_person_key on app.person_notification_settings (person_id) where deleted_at is null;

call private.install_person_table('app.person_notification_settings');
call private.describe('app.person_notification_settings', 'A person''s own quiet hours, for notifications from orgs they have no membership in (external parties and marketplace alerts, A89). Members keep per-org quiet hours in app.notification_settings. A push waits while the quiet hours last, unless its kind bypasses quiet hours (ADR 0033 decision 35).', array[
  'id', 'Primary key, UUID v7.',
  'person_id', 'Owner.',
  'time_zone', 'IANA time zone the quiet hours are read in; never assumed to be UTC.',
  'quiet_hours_start', 'Local time quiet hours begin; may be later than the end to span midnight. NULL for none.',
  'quiet_hours_end', 'Local time quiet hours end.'
]);

create or replace function private.guard_person_notification_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_time_zone(new.time_zone);
  return new;
end;
$$;

comment on function private.guard_person_notification_settings() is 'A person''s notification settings carry a known IANA time zone.';
revoke all on function private.guard_person_notification_settings() from public, anon, authenticated;

create trigger t40_guard_person_notification_settings before insert or update on app.person_notification_settings
  for each row execute function private.guard_person_notification_settings();

call private.install_default_retention('app.person_notification_settings');

create or replace function private.person_quiet_until(p_person_id uuid, p_at timestamptz)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_s app.person_notification_settings;
  v_local timestamp;
  v_t time;
  v_end_local timestamp;
begin
  select * into v_s from app.person_notification_settings s where s.person_id = p_person_id and s.deleted_at is null;
  if v_s.id is null or v_s.quiet_hours_start is null
     or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_s.time_zone) then
    return null;
  end if;
  v_local := p_at at time zone v_s.time_zone;
  v_t := v_local::time;
  if v_s.quiet_hours_start < v_s.quiet_hours_end then
    if v_t >= v_s.quiet_hours_start and v_t < v_s.quiet_hours_end then
      v_end_local := v_local::date + v_s.quiet_hours_end;
    end if;
  elsif v_t >= v_s.quiet_hours_start then
    v_end_local := (v_local::date + 1) + v_s.quiet_hours_end;
  elsif v_t < v_s.quiet_hours_end then
    v_end_local := v_local::date + v_s.quiet_hours_end;
  end if;
  if v_end_local is null then
    return null;
  end if;
  return v_end_local at time zone v_s.time_zone;
end;
$$;

comment on function private.person_quiet_until(uuid, timestamptz) is 'When a person''s own quiet hours end, if p_at falls inside them in their chosen time zone; NULL otherwise or when they set none. Handles quiet hours that span midnight (A89, the person-level twin of private.local_quiet_until).';
revoke all on function private.person_quiet_until(uuid, timestamptz) from public, anon, authenticated;

create or replace function app.set_my_quiet_hours(p_time_zone text, p_quiet_hours_start time, p_quiet_hours_end time)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
begin
  update app.person_notification_settings
  set time_zone = p_time_zone, quiet_hours_start = p_quiet_hours_start, quiet_hours_end = p_quiet_hours_end
  where person_id = v_me and deleted_at is null;
  if not found then
    insert into app.person_notification_settings (person_id, time_zone, quiet_hours_start, quiet_hours_end)
    values (v_me, p_time_zone, p_quiet_hours_start, p_quiet_hours_end);
  end if;
end;
$$;

comment on function app.set_my_quiet_hours(text, time, time) is 'Records the signed-in person''s own quiet hours and the time zone they are read in (Gateway Settings, Notifications), updating their live row or adding one. Both times NULL turns quiet hours off.';

-- private.notify: the marketplace relationship and a person's own quiet hours --------------------------------------------------

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
  v_bypass boolean := private.bypasses_quiet_hours(p_kind, coalesce(p_message_args, '{}'::jsonb), now());
  v_id uuid;
  v_created timestamptz;
  v_channel app.notification_channel;
  v_quiet timestamptz;
  v_digest timestamptz;
  v_delivery uuid;
begin
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
    coalesce(p_message_args, '{}'::jsonb),
    case when v_membership is not null and v_category is not null and not private.channel_enabled(v_membership, v_category, 'In App')
         then now() end)
  returning id, created_at into v_id, v_created;

  if v_membership is null then
    -- An external party or a marketplace user: their own Email and Push choices (1131). A push waits out their own quiet
    -- hours unless the kind bypasses them (A89); digests and SMS are membership settings.
    foreach v_channel in array array['Email', 'Push']::app.notification_channel[] loop
      if private.person_channel_enabled(p_recipient_person_id, v_category, v_channel) then
        v_quiet := case when v_channel = 'Push' and not v_bypass then private.person_quiet_until(p_recipient_person_id, now()) end;
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

comment on function private.notify(uuid, uuid, text, text, uuid, uuid, jsonb) is 'Creates a notification and its outside deliveries. An active member gets one delivery per channel they receive the category on (their preference, the org default and mandatory categories, 1362). During quiet hours a push waits (Deferred) and a text is held for the member''s summary (1367); only kinds on the bypass list go at once (ADR 0033 decision 35). Non-urgent email joins the digest when the member chose one. With In App off the notification is recorded already archived. An external party of the org (1131), or a person a marketplace match is about a listing open to (A89), gets the notification and an Email and a Push delivery as their own preferences allow; the push waits out their own quiet hours (app.person_notification_settings) unless the kind bypasses them. Anyone else gets nothing (invariant 3). Returns the notification id, or null.';

-- The delivery worker ------------------------------------------------------------------------------------------------------------

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

comment on function app.claim_notification_deliveries(app.notification_channel, integer) is 'Worker API (service role): claims due deliveries of a channel with SKIP LOCKED. Quiet hours are checked again unless the kind is on the bypass list (ADR 0033 decision 35): a member''s push waits until they end (Deferred) and a text is held for the member''s summary (1367); the push of someone with no membership waits out their own quiet hours (A89). Suppresses, with the reason, a marketplace match whose listing is no longer open to the recipient (A89), and any delivery whose recipient neither belongs to the org nor works with it as an external party nor may see the listing a match is about, has no verified address, is suppressed, lacks SMS consent or has no device. Push rows list the devices not yet pushed for the delivery (push_devices). A claimed delivery becomes due again after 10 minutes unless its outcome is recorded.';

-- Reading: a match stays in the person's inbox while its listing is open to them ----------------------------------------------------

call private.install_policies('app.notifications',
  $$recipient_person_id = (select private.current_person_id())
    and (org_id in (select private.my_org_ids()) or org_id in (select private.my_party_org_ids())
      or (kind = 'opportunity.matched' and private.marketplace_notice_open_to_me(kind, subject_table, subject_id)))$$,
  null,
  $$recipient_person_id = (select private.current_person_id())
    and (org_id in (select private.my_org_ids()) or org_id in (select private.my_party_org_ids())
      or (kind = 'opportunity.matched' and private.marketplace_notice_open_to_me(kind, subject_table, subject_id)))$$);

create or replace function private.is_my_notification(p_notification_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.notifications n
    where n.id = p_notification_id and n.recipient_person_id = private.current_person_id()
      and (n.org_id in (select private.my_org_ids()) or n.org_id in (select private.my_party_org_ids())
        or (n.kind = 'opportunity.matched' and private.marketplace_notice_open_to_me(n.kind, n.subject_table, n.subject_id)))
  );
$$;

comment on function private.is_my_notification(uuid) is 'True when the signed-in person is the recipient of a notification and still belongs to its org, works with it as an external party (1131), or, for a marketplace match, may still see the listing it is about (A89). Takes the id as an argument (ADR 0016 rule 14).';

-- Privileges -------------------------------------------------------------------------------------------------------------------------

revoke all on function private.notify(uuid, uuid, text, text, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function app.claim_notification_deliveries(app.notification_channel, integer) from public, anon, authenticated;
grant execute on function app.claim_notification_deliveries(app.notification_channel, integer) to service_role;
revoke all on function private.is_my_notification(uuid) from public, anon;
grant execute on function private.is_my_notification(uuid) to authenticated;
revoke all on function app.set_my_quiet_hours(text, time, time) from public, anon;
grant execute on function app.set_my_quiet_hours(text, time, time) to authenticated, service_role;
