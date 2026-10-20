-- 1367_sms_quiet_hours_refinements.sql
-- A80 (RRR-125), ADR 0033 decision 35 (owner, 2026-10-20). The owner approved the default SMS window of 21:00 to
-- 08:00 in the recipient's time zone (1361) with three refinements:
--   1. Urgent kinds bypass quiet hours, the default window and personal quiet hours alike, for SMS and push:
--      private.notification_quiet_hours_bypass, seeded from the bypasses_quiet_hours flag in
--      packages/schemas/notification-kinds.yaml (1368, checked by its drift test): safety alerts, and a change to a
--      shift starting within 12 hours. A mandatory or urgent category alone no longer bypasses quiet hours; urgent
--      categories still skip the email digest. Sign-in and verification codes are sent by Supabase Auth and never
--      wait in this queue.
--   2. The recipient's time zone falls back, never to UTC: their notification settings zone, their own
--      locale.time_zone, the zone of the project the notification is about, the zone of their engagement's
--      project, the org's own locale.time_zone, then the org's newest project.
--   3. Texts held by quiet hours go out together as one summary per recipient and org when the quiet hours end
--      (08:00 local by default): app.sms_summary_queue, app.claim_sms_summaries and app.record_sms_summary.
--      Push is unaffected: a held push waits (Deferred) and goes on its own.

-- 1. The bypass list --------------------------------------------------------------------------------------------------

create table private.notification_quiet_hours_bypass (
  kind text primary key,
  starts_within interval,
  constraint notification_quiet_hours_bypass_kind_format check (kind ~ '^[a-z][a-z_]*\.[a-z][a-z_]*$'),
  constraint notification_quiet_hours_bypass_window check (starts_within is null or starts_within > interval '0')
);

comment on table private.notification_quiet_hours_bypass is 'Notification kinds that reach a person during quiet hours (ADR 0033 decision 35), the default SMS window and their own alike. Seeded only from packages/schemas/notification-kinds.yaml (bypasses_quiet_hours); its drift test keeps the two equal. The list stays short: safety alerts and imminent shift changes.';
comment on column private.notification_quiet_hours_bypass.kind is 'Notification kind.';
comment on column private.notification_quiet_hours_bypass.starts_within is 'Null to bypass always; otherwise the kind bypasses only while the startsAt instant in its message arguments falls within this long from now, as for a shift change.';

alter table private.notification_quiet_hours_bypass enable row level security;
revoke all on private.notification_quiet_hours_bypass from public, anon, authenticated;
grant select on private.notification_quiet_hours_bypass to service_role;

create or replace function private.bypasses_quiet_hours(p_kind text, p_message_args jsonb, p_at timestamptz)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_found boolean := false;
  v_within interval;
  v_starts timestamptz;
begin
  select true, b.starts_within into v_found, v_within from private.notification_quiet_hours_bypass b where b.kind = p_kind;
  if not coalesce(v_found, false) then
    return false;
  end if;
  if v_within is null then
    return true;
  end if;
  begin
    v_starts := (p_message_args ->> 'startsAt')::timestamptz;
  exception when others then
    return false;
  end;
  return v_starts is not null and v_starts >= p_at and v_starts <= p_at + v_within;
end;
$$;

comment on function private.bypasses_quiet_hours(text, jsonb, timestamptz) is 'Whether a notification reaches the person at once during quiet hours: its kind is on the bypass list and, for a kind with a window (a shift change), its startsAt argument falls within the window from p_at. A missing or unreadable startsAt waits.';

-- 2. The recipient's time zone, never UTC ----------------------------------------------------------------------------

create or replace function private.recipient_time_zone(p_org_id uuid, p_person_id uuid, p_project_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select s.time_zone from app.notification_settings s join app.memberships m on m.id = s.membership_id
     where m.org_id = p_org_id and m.person_id = p_person_id and s.deleted_at is null and m.deleted_at is null
     order by s.updated_at desc limit 1),
    (select pv.value_text from app.personal_setting_values pv
     where pv.person_id = p_person_id and pv.setting_key = 'locale.time_zone' and pv.deleted_at is null
       and (pv.org_id is null or pv.org_id = p_org_id)
     order by pv.org_id nulls last limit 1),
    (select pr.time_zone from app.projects pr where pr.id = p_project_id and pr.org_id = p_org_id),
    (select pr.time_zone from app.engagements e join app.projects pr on pr.id = e.project_id
     where e.person_id = p_person_id and e.org_id = p_org_id and e.deleted_at is null
     order by (e.engagement_state = 'Active') desc, e.start_date desc nulls last limit 1),
    (select v.value_text from app.setting_values v
     where v.setting_key = 'locale.time_zone' and v.scope_kind = 'Organization' and v.scope_id = p_org_id and v.deleted_at is null),
    (select pr.time_zone from app.projects pr where pr.org_id = p_org_id and pr.deleted_at is null order by pr.created_at desc, pr.id desc limit 1));
$$;

comment on function private.recipient_time_zone(uuid, uuid, uuid) is 'The time zone a person is reached in by an org (ADR 0033 decision 35), never UTC by default: their notification settings zone, their own locale.time_zone, the zone of the project the notification is about, their engagement''s project zone, the org''s own locale.time_zone, then the org''s newest project. Null only for an org with no zone and no project.';

drop function private.sms_quiet_until(uuid, timestamptz);
drop function private.member_time_zone(uuid);

create function private.sms_quiet_until(p_membership_id uuid, p_project_id uuid, p_at timestamptz)
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
  v_zone := (select private.recipient_time_zone(m.org_id, m.person_id, p_project_id) from app.memberships m where m.id = p_membership_id);
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

comment on function private.sms_quiet_until(uuid, uuid, timestamptz) is 'When a held text to a member may go, if p_at is inside quiet hours: the member''s own quiet hours when set, otherwise 21:00 to 08:00 in their time zone (private.recipient_time_zone, with the notification''s project). Null when the text may go now.';

-- 3. Held texts become one summary -------------------------------------------------------------------------------------

create table app.sms_summary_queue (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  notification_delivery_id uuid not null,
  notification_created_at timestamptz not null,
  membership_id uuid not null references app.memberships (id),
  due_at timestamptz not null,
  sent_at timestamptz,
  foreign key (notification_delivery_id, notification_created_at) references app.notification_deliveries (id, notification_created_at)
);

create index sms_summary_queue_delivery_idx on app.sms_summary_queue (notification_delivery_id, notification_created_at);

call private.install_domain_table('app.sms_summary_queue', 'app.memberships', 'membership_id');
create index sms_summary_queue_membership_due_idx on app.sms_summary_queue (membership_id, due_at) where sent_at is null and deleted_at is null;
create index sms_summary_queue_due_idx on app.sms_summary_queue (due_at) where sent_at is null and deleted_at is null;
create unique index sms_summary_queue_delivery_key on app.sms_summary_queue (notification_delivery_id) where deleted_at is null;
call private.describe('app.sms_summary_queue', 'Texts held by quiet hours (ADR 0033 decision 35). When the quiet hours end, the SMS sender sends one summary per member and org, the count of held texts and the most important one, instead of a burst; push is never held here.', array[
  'notification_delivery_id', 'SMS delivery held for the summary.',
  'notification_created_at', 'Partition key of the delivery, checked by the foreign key.',
  'membership_id', 'Member the summary goes to.',
  'due_at', 'When the member''s quiet hours end, so the summary may go.',
  'sent_at', 'When the summary carrying this delivery was sent, or the delivery was settled otherwise.'
]);

call private.install_policies('app.sms_summary_queue', $$membership_id in (select private.my_membership_ids())$$);

create or replace function private.hold_sms_for_summary(p_delivery_id uuid, p_created timestamptz, p_membership_id uuid, p_until timestamptz)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update app.notification_deliveries set message_status = 'Digest', deliver_after = p_until
  where id = p_delivery_id and notification_created_at = p_created;
  update app.sms_summary_queue set due_at = p_until
  where notification_delivery_id = p_delivery_id and sent_at is null and deleted_at is null;
  if not found then
    insert into app.sms_summary_queue (notification_delivery_id, notification_created_at, membership_id, due_at)
    values (p_delivery_id, p_created, p_membership_id, p_until);
  end if;
end;
$$;

comment on function private.hold_sms_for_summary(uuid, timestamptz, uuid, timestamptz) is 'Holds an SMS delivery for the member''s next summary (status Digest, never claimed on its own) until quiet hours end.';

-- private.notify: kinds on the bypass list skip quiet hours; held texts join the summary --------------------------------

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
  if v_membership is null and p_org_id not in (select private.party_org_ids(p_recipient_person_id)) then
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
    -- An external party: their own Email and Push choices; quiet hours and digests are membership settings.
    foreach v_channel in array array['Email', 'Push']::app.notification_channel[] loop
      if private.person_channel_enabled(p_recipient_person_id, v_category, v_channel) then
        insert into app.notification_deliveries (notification_id, notification_created_at, channel, message_status, deliver_after)
        values (v_id, v_created, v_channel, 'Queued', now());
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

comment on function private.notify(uuid, uuid, text, text, uuid, uuid, jsonb) is 'Creates a notification and its outside deliveries. An active member gets one delivery per channel they receive the category on (their preference, the org default and mandatory categories, 1362). During quiet hours a push waits (Deferred) and a text is held for the member''s summary (1367); only kinds on the bypass list go at once (ADR 0033 decision 35). Non-urgent email joins the digest when the member chose one. With In App off the notification is recorded already archived. An external party of the org (1131) gets the notification and an Email and a Push delivery as their own preferences allow, at once. Anyone else gets nothing (invariant 3). Returns the notification id, or null.';

-- The delivery worker: quiet hours by the bypass list; held texts join the summary --------------------------------------

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

    -- Quiet hours may have begun since private.notify queued the delivery.
    if p_channel in ('SMS', 'Push') and v_membership is not null
       and not private.bypasses_quiet_hours(v_row.kind, v_row.message_args, now()) then
      v_quiet := case when p_channel = 'SMS' then private.sms_quiet_until(v_membership, v_row.project_id, now())
                      else private.local_quiet_until(v_membership, now()) end;
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

comment on function app.claim_notification_deliveries(app.notification_channel, integer) is 'Worker API (service role): claims due deliveries of a channel with SKIP LOCKED. Quiet hours are checked again unless the kind is on the bypass list (ADR 0033 decision 35): a push waits until they end (Deferred), a text is held for the member''s summary (1367). Suppresses, with the reason, any delivery whose recipient neither belongs to the org nor works with it as an external party, has no verified address, is suppressed, lacks SMS consent or has no device. Push rows list the devices not yet pushed for the delivery (push_devices). A claimed delivery becomes due again after 10 minutes unless its outcome is recorded.';

create or replace function app.claim_sms_summaries(p_limit integer default 50)
returns table (
  org_id uuid, recipient_person_id uuid, address text, delivery_ids uuid[], held_count integer,
  kind text, message_args jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_group record;
  v_person uuid;
  v_active boolean;
  v_project uuid;
  v_quiet timestamptz;
  v_address text;
  v_reason text;
  v_ids uuid[];
  v_top record;
begin
  for v_group in
    select q.org_id, q.membership_id from app.sms_summary_queue q
    where q.sent_at is null and q.deleted_at is null and q.due_at <= now()
    group by q.org_id, q.membership_id
    order by min(q.due_at)
    limit least(greatest(p_limit, 1), 200)
  loop
    select array_agg(q.notification_delivery_id order by q.notification_created_at) into v_ids
    from (select q2.notification_delivery_id, q2.notification_created_at from app.sms_summary_queue q2
          where q2.org_id = v_group.org_id and q2.membership_id = v_group.membership_id
            and q2.sent_at is null and q2.deleted_at is null and q2.due_at <= now()
          for update skip locked) q;
    if v_ids is null then
      continue;
    end if;
    select m.person_id, (m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()))
    into v_person, v_active from app.memberships m where m.id = v_group.membership_id;
    select n.project_id into v_project from app.notification_deliveries d
    join app.notifications n on n.id = d.notification_id and n.created_at = d.notification_created_at
    where d.id = any (v_ids) order by n.created_at desc limit 1;

    v_reason := null;
    v_address := private.recipient_address(v_person, 'SMS');
    if not coalesce(v_active, false) then
      v_reason := 'Recipient no longer belongs to the org.';
    else
      -- The member may have moved their quiet hours or their zone since the texts were held.
      v_quiet := private.sms_quiet_until(v_group.membership_id, v_project, now());
      if v_quiet is not null then
        update app.sms_summary_queue set due_at = v_quiet
        where notification_delivery_id = any (v_ids) and sent_at is null;
        continue;
      end if;
      if v_address is null then
        v_reason := 'No verified address on the channel.';
      elsif exists (select 1 from app.suppression_list s
                    where s.org_id = v_group.org_id and s.channel = 'SMS' and s.address = v_address and s.lifted_at is null
                      and s.deleted_at is null
                      and (s.reason in ('Hard Bounce', 'Complaint', 'STOP', 'Manual') or s.category_code is null)) then
        v_reason := 'Address is on the suppression list.';
      elsif not coalesce((select c.may_text from app.sms_consent_status c
                          where c.org_id = v_group.org_id and c.phone_e164 = v_address), false) then
        v_reason := 'No SMS consent for the number.';
      end if;
    end if;
    if v_reason is not null then
      update app.notification_deliveries set message_status = 'Suppressed', last_error = v_reason where id = any (v_ids);
      update app.sms_summary_queue set sent_at = now() where notification_delivery_id = any (v_ids) and sent_at is null;
      continue;
    end if;

    -- The most important held text: an urgent category first, then the latest.
    select n.kind, n.message_args into v_top
    from app.notification_deliveries d
    join app.notifications n on n.id = d.notification_id and n.created_at = d.notification_created_at
    join private.notification_templates t on t.kind = n.kind and t.channel = 'SMS'
    join private.notification_categories c on c.code = t.category_code
    where d.id = any (v_ids)
    order by c.urgent desc, n.created_at desc
    limit 1;

    -- Claimed: due again in 10 minutes unless the outcome is recorded.
    update app.sms_summary_queue set due_at = now() + interval '10 minutes'
    where notification_delivery_id = any (v_ids) and sent_at is null;
    update app.notification_deliveries set attempt_count = attempt_count + 1 where id = any (v_ids);

    org_id := v_group.org_id;
    recipient_person_id := v_person;
    address := v_address;
    delivery_ids := v_ids;
    held_count := cardinality(v_ids);
    kind := v_top.kind;
    message_args := v_top.message_args;
    return next;
  end loop;
end;
$$;

comment on function app.claim_sms_summaries(integer) is 'SMS sender API (service role): claims the members whose held texts are due (their quiet hours ended), one row per member and org with every held delivery, the count and the most important text (an urgent category first, then the latest). Holds again a member still inside quiet hours, and suppresses, with the reason, the held texts of someone who left the org, lost their verified number, is suppressed or withdrew consent. A claimed summary is due again after 10 minutes unless its outcome is recorded.';

create or replace function app.record_sms_summary(
  p_delivery_ids uuid[],
  p_status app.message_status,
  p_provider_message_id text default null,
  p_error text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_attempts smallint;
begin
  if p_status not in ('Sent', 'Bounced', 'Failed') then
    perform private.refuse('delivery_status_invalid', 'A summary records Sent, Bounced or Failed.');
  end if;
  if coalesce(cardinality(p_delivery_ids), 0) = 0 then
    perform private.refuse('sms_summary_empty', 'A summary carries at least one held text.');
  end if;
  select min(d.org_id::text)::uuid, max(d.attempt_count) into v_org, v_attempts
  from app.notification_deliveries d where d.id = any (p_delivery_ids) and d.channel = 'SMS';
  if v_org is null then
    perform private.refuse('delivery_unknown', 'No such SMS delivery.');
  end if;
  if p_status = 'Failed' and v_attempts < 5 then
    update app.notification_deliveries set last_error = left(p_error, 2000) where id = any (p_delivery_ids);
    update app.sms_summary_queue set due_at = now() + private.webhook_retry_delay(v_attempts)
    where notification_delivery_id = any (p_delivery_ids) and sent_at is null;
    return;
  end if;
  update app.notification_deliveries
  set message_status = p_status,
    provider_message_id = coalesce(left(p_provider_message_id, 200), provider_message_id),
    last_error = left(p_error, 2000),
    sent_at = case when p_status = 'Sent' then coalesce(sent_at, now()) else sent_at end
  where id = any (p_delivery_ids);
  update app.sms_summary_queue set sent_at = now() where notification_delivery_id = any (p_delivery_ids) and sent_at is null;
  if p_status = 'Sent' then
    perform private.record_usage(v_org, 'sms_segments', 1, p_delivery_ids[1]);
  end if;
end;
$$;

comment on function app.record_sms_summary(uuid[], app.message_status, text, text) is 'SMS sender API (service role): records the outcome of one summary text for every held delivery it carried. Sent marks them Sent with the message SID and counts one text toward usage; Bounced settles them; Failed retries the summary with backoff, up to 5 attempts.';

create or replace function app.my_notification_time_zone(p_org_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select private.recipient_time_zone(p_org_id, private.current_person_id(), null)
  where private.my_membership_in(p_org_id) is not null;
$$;

comment on function app.my_notification_time_zone(uuid) is 'The time zone the signed-in member is reached in by an org (private.recipient_time_zone), the default of their quiet hours zone in Personal settings, Notifications.';

-- Retention and privileges ----------------------------------------------------------------------------------------------

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.sms_summary_queue', 'Age', 'due_at', interval '90 days', 'Delete', 'Summary bookkeeping kept 90 days, as the email digest queue.');

revoke all on function private.bypasses_quiet_hours(text, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function private.recipient_time_zone(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.sms_quiet_until(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.hold_sms_for_summary(uuid, timestamptz, uuid, timestamptz) from public, anon, authenticated;
revoke all on function private.notify(uuid, uuid, text, text, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function app.claim_notification_deliveries(app.notification_channel, integer) from public, anon, authenticated;
grant execute on function app.claim_notification_deliveries(app.notification_channel, integer) to service_role;
revoke all on function app.claim_sms_summaries(integer) from public, anon, authenticated;
grant execute on function app.claim_sms_summaries(integer) to service_role;
revoke all on function app.record_sms_summary(uuid[], app.message_status, text, text) from public, anon, authenticated;
grant execute on function app.record_sms_summary(uuid[], app.message_status, text, text) to service_role;
revoke all on function app.my_notification_time_zone(uuid) from public, anon;
grant execute on function app.my_notification_time_zone(uuid) to authenticated;
