-- 2913_stakeholder_pack_deliveries.sql
-- B2 (RRR-226, ADR 0141; parity gap G-30). Scheduled delivery to people outside the org. Report files still reach
-- only members (1127, ADR 0029 item 6, Section 4.6.4); an outside recipient instead gets an email with a sign-in link
-- to their stakeholder pack (2910) that expires within 7 days, never a report file. On A18's job queue (0510):
--   1. app.send_stakeholder_pack (the editor's Send invite and Resend) and app.queue_due_pack_schedules (pg_cron,
--      every five minutes) record one app.stakeholder_pack_deliveries row per recipient and queue a pack.deliver job.
--      The scheduler takes every due, unpaused schedule of an unrevoked, unexpired pack in an org that is not
--      read-only, skips recipients who are revoked, unsubscribed or locked after 5 wrong codes, and pauses a schedule
--      whose next slot falls after the pack's expiry.
--   2. The pack.deliver worker (packages/data stakeholder-packs, the report-run Edge Function) mints the link with
--      app.mint_stakeholder_pack_link, which revokes the link of any earlier attempt of the same delivery (ADR 0106
--      decision 5) and prunes links more than 30 days past their pack's expiry, sends the email and records the
--      outcome with app.finish_stakeholder_pack_delivery. A failed send revokes its link, so it leaves no working one.
--   3. The email never carries the access code; the recipient was given it out of band. It carries an unsubscribe
--      link and the List-Unsubscribe and List-Unsubscribe-Post headers (RFC 8058).
--   4. An address on the org's app.suppression_list (0520) gets nothing: both senders skip it and the worker marks a
--      queued delivery Skipped with the reason (private.pack_email_suppressed). The list keeps hard bounces, complaints
--      and an unsubscribe from any of the org's packs.
--   5. One year after a pack ended (revoked or expired, whichever came first), the daily job
--      xos_retire_ended_stakeholder_packs soft-deletes the pack, its items, recipients, schedule and deliveries, and
--      drops its links, grants and tickets, so the retention of those tables reaches them: a non-user's name and email
--      go two years after the pack ended. Events age out at two years on their own.

insert into private.job_kinds (code, subject_table, max_attempts, description) values
  ('pack.deliver', 'app.stakeholder_pack_deliveries', 5, 'Emails a stakeholder pack sign-in link to one outside recipient.')
on conflict (code) do nothing;

-- Schedules ------------------------------------------------------------------------------------------------------------

create table app.stakeholder_pack_schedules (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  stakeholder_pack_id uuid not null references app.stakeholder_packs (id),
  cadence app.schedule_cadence not null,
  local_hour smallint not null,
  weekday smallint,
  month_day smallint,
  time_zone text not null,
  next_run_at timestamptz not null,
  paused_at timestamptz,
  constraint stakeholder_pack_schedules_hour check (local_hour between 0 and 23),
  constraint stakeholder_pack_schedules_weekday check ((cadence = 'Weekly') = (weekday is not null) and (weekday is null or weekday between 1 and 7)),
  constraint stakeholder_pack_schedules_month_day check ((cadence = 'Monthly') = (month_day is not null) and (month_day is null or month_day between 1 and 28))
);

call private.install_domain_table('app.stakeholder_pack_schedules', 'app.stakeholder_packs', 'stakeholder_pack_id');
create unique index stakeholder_pack_schedules_pack_key on app.stakeholder_pack_schedules (stakeholder_pack_id) where deleted_at is null;
create index stakeholder_pack_schedules_due_idx on app.stakeholder_pack_schedules (next_run_at) where deleted_at is null and paused_at is null;
call private.describe('app.stakeholder_pack_schedules', 'When a stakeholder pack emails its recipients a fresh sign-in link (ADR 0141): Daily, Weekly or Monthly at a local hour, with the 0550 report schedule rules. One per pack. Written only by app.set_stakeholder_pack_schedule, app.clear_stakeholder_pack_schedule and the scheduler.', array[
  'stakeholder_pack_id', 'Pack the schedule sends.',
  'cadence', 'Daily, Weekly or Monthly.',
  'local_hour', 'Hour of the day it sends, 0 to 23, in time_zone.',
  'weekday', 'Weekly only: day of the week, 1 (Monday) to 7.',
  'month_day', 'Monthly only: day of the month, 1 to 28.',
  'time_zone', 'IANA time zone the hour is in; the project''s zone by default.',
  'next_run_at', 'Next slot, from private.next_schedule_run.',
  'paused_at', 'When the scheduler ended the schedule because its next slot fell after the pack''s expiry.'
]);
call private.install_audit_trail('app.stakeholder_pack_schedules');
call private.install_default_retention('app.stakeholder_pack_schedules', interval '1 year');

call private.install_policies('app.stakeholder_pack_schedules',
  $$stakeholder_pack_id in (select p.id from app.stakeholder_packs p
    where p.project_id in (select private.project_ids_with('projects.settings.write')) and private.is_member(p.org_id))$$);
revoke insert, update, delete on app.stakeholder_pack_schedules from authenticated;

-- Deliveries -----------------------------------------------------------------------------------------------------------

create table app.stakeholder_pack_deliveries (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  stakeholder_pack_id uuid not null references app.stakeholder_packs (id),
  recipient_id uuid not null,
  delivery_kind text not null,
  scheduled_for timestamptz not null,
  delivery_status text not null default 'Queued',
  sent_at timestamptz,
  provider_message_id text,
  last_error text,
  constraint stakeholder_pack_deliveries_recipient_fkey foreign key (recipient_id, stakeholder_pack_id)
    references app.stakeholder_pack_recipients (id, stakeholder_pack_id),
  constraint stakeholder_pack_deliveries_kind check (delivery_kind in ('Invite', 'Scheduled', 'Resend')),
  constraint stakeholder_pack_deliveries_status check (delivery_status in ('Queued', 'Sent', 'Failed', 'Skipped')),
  constraint stakeholder_pack_deliveries_sent check ((delivery_status = 'Sent') = (sent_at is not null)),
  constraint stakeholder_pack_deliveries_error_length check (last_error is null or char_length(last_error) <= 2000),
  constraint stakeholder_pack_deliveries_message_id_length check (provider_message_id is null or char_length(provider_message_id) <= 200),
  constraint stakeholder_pack_deliveries_recipient_key unique (id, recipient_id)
);

create index stakeholder_pack_deliveries_pack_idx on app.stakeholder_pack_deliveries (stakeholder_pack_id);
create index stakeholder_pack_deliveries_recipient_idx on app.stakeholder_pack_deliveries (recipient_id, created_at);

call private.install_domain_table('app.stakeholder_pack_deliveries', 'app.stakeholder_packs', 'stakeholder_pack_id');
create unique index stakeholder_pack_deliveries_scheduled_once on app.stakeholder_pack_deliveries (recipient_id, scheduled_for)
  where delivery_kind = 'Scheduled' and deleted_at is null;
call private.describe('app.stakeholder_pack_deliveries', 'One email of a stakeholder pack sign-in link to one recipient (ADR 0141): an Invite, a Resend or a Scheduled send, and whether it went out. Written only by app.send_stakeholder_pack, the scheduler and the delivery worker. The email never carries the access code.', array[
  'stakeholder_pack_id', 'Pack the email signs in to.',
  'recipient_id', 'Recipient emailed.',
  'delivery_kind', 'Invite (the first send to the recipient), Resend, or Scheduled (a schedule slot).',
  'scheduled_for', 'When the send was asked for: the schedule slot, or the moment of a manual send.',
  'delivery_status', 'Queued, Sent, Failed, or Skipped when the pack or recipient was revoked, expired or unsubscribed before it went out.',
  'sent_at', 'When the email was handed to the transport.',
  'provider_message_id', 'Message id from the email transport.',
  'last_error', 'Why the delivery failed or was skipped.'
]);
call private.install_audit_trail('app.stakeholder_pack_deliveries');
call private.install_default_retention('app.stakeholder_pack_deliveries', interval '1 year');

call private.install_policies('app.stakeholder_pack_deliveries',
  $$stakeholder_pack_id in (select p.id from app.stakeholder_packs p
    where p.project_id in (select private.project_ids_with('projects.settings.write')) and private.is_member(p.org_id))$$);
revoke insert, update, delete on app.stakeholder_pack_deliveries from authenticated;

-- An emailed link belongs to one delivery of its recipient.
alter table private.stakeholder_pack_links
  add constraint stakeholder_pack_links_delivery_fkey foreign key (stakeholder_pack_delivery_id, recipient_id)
    references app.stakeholder_pack_deliveries (id, recipient_id);

insert into private.trash_excluded_tables (table_name, rationale) values
  ('stakeholder_pack_schedules', 'Revoked, replaced, never restored: a cleared schedule is set again instead.'),
  ('stakeholder_pack_deliveries', 'A record of emails sent; it is never restored.')
on conflict (table_name) do nothing;

select private.sync_trash_tables();

-- Sending --------------------------------------------------------------------------------------------------------------

create or replace function app.send_stakeholder_pack(p_pack_id uuid, p_recipient_ids uuid[] default null)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pack app.stakeholder_packs := private.manageable_stakeholder_pack(p_pack_id);
  v_recipient record;
  v_delivery uuid;
  v_count integer := 0;
begin
  if v_pack.revoked_at is not null then
    perform private.refuse('stakeholder_pack_revoked', 'This pack is revoked. Make a new pack instead.');
  end if;
  if v_pack.expires_at <= now() then
    perform private.refuse('stakeholder_pack_expired', 'This pack has expired. Move its expiry before you send it.');
  end if;
  if private.org_read_only(v_pack.org_id) then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only. The Owner can reactivate it in Settings, Danger zone, during the 30 days.');
  end if;
  for v_recipient in
    select r.id, exists (select 1 from app.stakeholder_pack_deliveries d
                         where d.recipient_id = r.id and d.delivery_status = 'Sent' and d.deleted_at is null) as sent_before
    from app.stakeholder_pack_recipients r
    where r.stakeholder_pack_id = v_pack.id and r.revoked_at is null and r.deleted_at is null and r.unsubscribed_at is null
      and not private.pack_email_suppressed(v_pack.org_id, r.email)
      and (p_recipient_ids is null or r.id = any (p_recipient_ids))
      -- At most 3 manual sends per recipient an hour.
      and (select count(*) from app.stakeholder_pack_deliveries d
           where d.recipient_id = r.id and d.delivery_kind in ('Invite', 'Resend') and d.created_at > now() - interval '1 hour') < 3
    order by r.created_at, r.id
  loop
    insert into app.stakeholder_pack_deliveries as d (stakeholder_pack_id, recipient_id, delivery_kind, scheduled_for)
    values (v_pack.id, v_recipient.id, case when v_recipient.sent_before then 'Resend' else 'Invite' end, now())
    returning d.id into v_delivery;
    perform private.enqueue_job(v_pack.org_id, 'pack.deliver', v_delivery);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function app.send_stakeholder_pack(uuid, uuid[]) is 'Emails a sign-in link to a stakeholder pack''s recipients now (ADR 0141): every live recipient, or those named. An Invite for a recipient never sent to, a Resend otherwise; revoked and unsubscribed recipients, addresses on the org''s suppression list, and any recipient already sent 3 manual emails in the last hour, are skipped. Refused for a revoked or expired pack and in a read-only org. Needs projects.settings.write on the pack''s project. Returns the deliveries queued.';
revoke all on function app.send_stakeholder_pack(uuid, uuid[]) from public, anon;
grant execute on function app.send_stakeholder_pack(uuid, uuid[]) to authenticated, service_role;

create or replace function app.set_stakeholder_pack_schedule(
  p_pack_id uuid,
  p_cadence app.schedule_cadence,
  p_local_hour smallint,
  p_weekday smallint default null,
  p_month_day smallint default null,
  p_time_zone text default null
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pack app.stakeholder_packs := private.manageable_stakeholder_pack(p_pack_id);
  v_zone text := coalesce(nullif(btrim(coalesce(p_time_zone, '')), ''),
    (select nullif(btrim(p.time_zone), '') from app.projects p where p.id = v_pack.project_id),
    private.org_setting_text(v_pack.org_id, 'locale.time_zone'), 'UTC');
  v_next timestamptz;
  v_id uuid;
begin
  if v_pack.revoked_at is not null then
    perform private.refuse('stakeholder_pack_revoked', 'This pack is revoked. Make a new pack instead.');
  end if;
  if private.org_read_only(v_pack.org_id) then
    perform private.refuse('org_read_only', 'This organization is canceled and read-only. The Owner can reactivate it in Settings, Danger zone, during the 30 days.');
  end if;
  perform private.assert_time_zone(v_zone);
  v_next := private.next_schedule_run(p_cadence, p_local_hour, p_weekday, p_month_day, v_zone, now());
  if v_next is null or v_next > v_pack.expires_at then
    perform private.refuse('stakeholder_pack_schedule_past_expiry', 'The first send falls after the pack expires. Move the pack''s expiry or pick an earlier slot.');
  end if;
  select s.id into v_id from app.stakeholder_pack_schedules s
  where s.stakeholder_pack_id = v_pack.id and s.deleted_at is null for update;
  if v_id is null then
    insert into app.stakeholder_pack_schedules (stakeholder_pack_id, cadence, local_hour, weekday, month_day, time_zone, next_run_at)
    values (v_pack.id, p_cadence, p_local_hour, p_weekday, p_month_day, v_zone, v_next);
  else
    update app.stakeholder_pack_schedules
    set cadence = p_cadence, local_hour = p_local_hour, weekday = p_weekday, month_day = p_month_day, time_zone = v_zone,
      next_run_at = v_next, paused_at = null
    where id = v_id;
  end if;
  return v_next;
end;
$$;

comment on function app.set_stakeholder_pack_schedule(uuid, app.schedule_cadence, smallint, smallint, smallint, text) is 'Sets when a stakeholder pack emails its recipients a fresh sign-in link (ADR 0141): Daily, Weekly (weekday 1 to 7) or Monthly (day 1 to 28) at a local hour in a time zone, by default the project''s. Refuses a slot after the pack''s expiry, a revoked pack and a read-only org. Needs projects.settings.write on the pack''s project. Returns the first slot.';
revoke all on function app.set_stakeholder_pack_schedule(uuid, app.schedule_cadence, smallint, smallint, smallint, text) from public, anon;
grant execute on function app.set_stakeholder_pack_schedule(uuid, app.schedule_cadence, smallint, smallint, smallint, text) to authenticated, service_role;

create or replace function app.clear_stakeholder_pack_schedule(p_pack_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pack app.stakeholder_packs := private.manageable_stakeholder_pack(p_pack_id);
begin
  update app.stakeholder_pack_schedules set deleted_at = now()
  where stakeholder_pack_id = v_pack.id and deleted_at is null;
end;
$$;

comment on function app.clear_stakeholder_pack_schedule(uuid) is 'Turns a stakeholder pack''s schedule off; deliveries already queued still go. Needs projects.settings.write on the pack''s project.';
revoke all on function app.clear_stakeholder_pack_schedule(uuid) from public, anon;
grant execute on function app.clear_stakeholder_pack_schedule(uuid) to authenticated, service_role;

create or replace function app.queue_due_pack_schedules(p_limit integer default 100)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_schedule record;
  v_recipient record;
  v_delivery uuid;
  v_next timestamptz;
  v_count integer := 0;
begin
  for v_schedule in
    select s.*, p.expires_at as pack_expires_at, p.org_id as pack_org_id
    from app.stakeholder_pack_schedules s
    join app.stakeholder_packs p on p.id = s.stakeholder_pack_id and p.deleted_at is null and p.revoked_at is null
    where s.deleted_at is null and s.paused_at is null and s.next_run_at <= now()
    order by s.next_run_at
    limit greatest(coalesce(p_limit, 100), 1)
    for update of s skip locked
  loop
    if v_schedule.pack_expires_at <= now() then
      update app.stakeholder_pack_schedules set paused_at = now() where id = v_schedule.id;
      continue;
    end if;
    -- A read-only org sends nothing new; its slot passes.
    if not private.org_read_only(v_schedule.pack_org_id) then
      for v_recipient in
        select r.id from app.stakeholder_pack_recipients r
        where r.stakeholder_pack_id = v_schedule.stakeholder_pack_id and r.revoked_at is null and r.deleted_at is null
          and r.unsubscribed_at is null and r.failed_attempts < 5
          and not private.pack_email_suppressed(v_schedule.pack_org_id, r.email)
      loop
        v_delivery := null;
        insert into app.stakeholder_pack_deliveries as d (stakeholder_pack_id, recipient_id, delivery_kind, scheduled_for)
        values (v_schedule.stakeholder_pack_id, v_recipient.id, 'Scheduled', v_schedule.next_run_at)
        on conflict do nothing
        returning d.id into v_delivery;
        if v_delivery is not null then
          perform private.enqueue_job(v_schedule.pack_org_id, 'pack.deliver', v_delivery);
          v_count := v_count + 1;
        end if;
      end loop;
    end if;
    v_next := private.next_schedule_run(v_schedule.cadence, v_schedule.local_hour, v_schedule.weekday, v_schedule.month_day,
      v_schedule.time_zone, greatest(now(), v_schedule.next_run_at));
    update app.stakeholder_pack_schedules
    set next_run_at = v_next, paused_at = case when v_next > v_schedule.pack_expires_at then now() end
    where id = v_schedule.id;
  end loop;
  return v_count;
end;
$$;

comment on function app.queue_due_pack_schedules(integer) is 'Scheduler (service role, pg_cron): for each due, unpaused schedule of an unrevoked, unexpired stakeholder pack, records one Scheduled delivery per recipient who is not revoked, unsubscribed, locked after 5 wrong codes or on the org''s suppression list, queues pack.deliver for each, and moves next_run_at to the next slot; once per slot (a second run makes no duplicate). A schedule whose pack has expired, or whose next slot falls after the pack''s expiry, is paused. A read-only org''s slot passes without sends. Returns the deliveries queued.';
revoke all on function app.queue_due_pack_schedules(integer) from public, anon, authenticated;
grant execute on function app.queue_due_pack_schedules(integer) to service_role;

select cron.schedule('xos_queue_due_pack_schedules', '*/5 * * * *', 'select app.queue_due_pack_schedules()');

-- Delivery worker API --------------------------------------------------------------------------------------------------

create or replace function app.mint_stakeholder_pack_link(p_delivery_id uuid)
returns table (token text, unsubscribe_token text, expires_at timestamptz, email jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_delivery app.stakeholder_pack_deliveries;
  v_recipient app.stakeholder_pack_recipients;
  v_pack app.stakeholder_packs;
  v_token text := 'xpkl_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_unsubscribe text := 'xpku_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_expires timestamptz;
  v_skip text;
  v_locale text;
begin
  select * into v_delivery from app.stakeholder_pack_deliveries d where d.id = p_delivery_id and d.deleted_at is null for update;
  if v_delivery.id is null or v_delivery.delivery_status <> 'Queued' then
    return;
  end if;
  select * into v_recipient from app.stakeholder_pack_recipients r where r.id = v_delivery.recipient_id;
  select * into v_pack from app.stakeholder_packs p where p.id = v_delivery.stakeholder_pack_id;
  v_skip := case
    when v_pack.revoked_at is not null or v_pack.deleted_at is not null then 'The pack was revoked before the email went out.'
    when v_pack.expires_at <= now() then 'The pack expired before the email went out.'
    when v_recipient.revoked_at is not null or v_recipient.deleted_at is not null then 'The recipient was revoked before the email went out.'
    when v_recipient.unsubscribed_at is not null then 'The recipient stopped these emails.'
    when private.pack_email_suppressed(v_pack.org_id, v_recipient.email) then 'The address is on the organization''s suppression list.'
  end;
  -- Links of earlier attempts of this delivery stop (ADR 0106 decision 5); links past their pack's expiry by 30 days go.
  update private.stakeholder_pack_links l set revoked_at = now()
  where l.stakeholder_pack_delivery_id = v_delivery.id and l.revoked_at is null;
  delete from private.stakeholder_pack_links l
  using app.stakeholder_pack_recipients r, app.stakeholder_packs p
  where l.recipient_id = r.id and p.id = r.stakeholder_pack_id and p.expires_at < now() - interval '30 days';
  if v_skip is not null then
    update app.stakeholder_pack_deliveries set delivery_status = 'Skipped', last_error = v_skip where id = v_delivery.id;
    return;
  end if;

  v_expires := least(now() + interval '7 days', v_pack.expires_at);
  insert into private.stakeholder_pack_links (org_id, stakeholder_pack_delivery_id, recipient_id, token_hash, token_hint, unsubscribe_hash, expires_at)
  values (v_pack.org_id, v_delivery.id, v_recipient.id, private.share_token_hash(v_token), right(v_token, 4),
    private.share_token_hash(v_unsubscribe), v_expires);
  v_locale := private.org_setting_text(v_pack.org_id, 'locale.language');
  return query
  select v_token, v_unsubscribe, v_expires, jsonb_build_object(
    'recipient_name', v_recipient.full_name,
    'recipient_email', v_recipient.email,
    'locale', case when v_locale in ('en-US', 'es-US') then v_locale else 'en-US' end,
    'org_name', o.name,
    'brand_name', coalesce(b.display_name, o.name),
    'pack_name', v_pack.name,
    'message', v_pack.message,
    'item_titles', coalesce((select jsonb_agg(i.title order by i.position, i.id) from app.stakeholder_pack_items i
                             where i.stakeholder_pack_id = v_pack.id and i.deleted_at is null), '[]'::jsonb),
    'sender_name', (select pe.full_name from app.people pe where pe.id = v_pack.created_by),
    'expires_at', v_expires,
    'time_zone', coalesce((select nullif(btrim(p.time_zone), '') from app.projects p where p.id = v_pack.project_id),
      private.org_setting_text(v_pack.org_id, 'locale.time_zone'), 'UTC'))
  from app.organizations o
  left join app.org_brands b on b.org_id = o.id and b.deleted_at is null
  where o.id = v_pack.org_id;
end;
$$;

comment on function app.mint_stakeholder_pack_link(uuid) is 'Worker API (service role): mints the sign-in link of one queued stakeholder pack delivery (ADR 0141): an xpkl_ token valid until the earlier of 7 days and the pack''s expiry, and an xpku_ unsubscribe token; only their hashes are kept. Revokes the links of earlier attempts of the same delivery (ADR 0106 decision 5) and deletes links whose pack expired more than 30 days ago. Answers the tokens and what the email says (recipient name and email, locale, org and brand name, pack name and message, item titles, sender''s name, expiry and the project''s time zone to show it in), never the access code. A delivery whose pack or recipient was revoked, whose pack expired, whose recipient unsubscribed or whose address is on the org''s suppression list is marked Skipped and answers nothing.';
revoke all on function app.mint_stakeholder_pack_link(uuid) from public, anon, authenticated;
grant execute on function app.mint_stakeholder_pack_link(uuid) to service_role;

create or replace function app.finish_stakeholder_pack_delivery(
  p_delivery_id uuid,
  p_sent boolean,
  p_provider_message_id text default null,
  p_error text default null,
  p_retry boolean default false
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_delivery app.stakeholder_pack_deliveries;
begin
  select d.* into v_delivery from app.stakeholder_pack_deliveries d where d.id = p_delivery_id and d.deleted_at is null for update;
  if v_delivery.id is null then
    perform private.refuse('stakeholder_pack_delivery_missing', 'The stakeholder pack delivery does not exist.');
  end if;
  if v_delivery.delivery_status <> 'Queued' then
    perform private.refuse('stakeholder_pack_delivery_finished', 'This stakeholder pack delivery has already finished.');
  end if;
  if p_sent then
    update app.stakeholder_pack_deliveries set delivery_status = 'Sent', sent_at = now(),
      provider_message_id = left(p_provider_message_id, 200), last_error = null
    where id = v_delivery.id;
    perform private.log_stakeholder_pack_event(v_delivery.stakeholder_pack_id, v_delivery.recipient_id, 'Sent');
    return;
  end if;
  if p_error is null or btrim(p_error) = '' then
    perform private.refuse('stakeholder_pack_delivery_error', 'A failed delivery records why it failed.');
  end if;
  -- A failed send leaves no working link, whether or not the job tries again.
  update private.stakeholder_pack_links l set revoked_at = now()
  where l.stakeholder_pack_delivery_id = v_delivery.id and l.revoked_at is null;
  update app.stakeholder_pack_deliveries
  set delivery_status = case when coalesce(p_retry, false) then 'Queued' else 'Failed' end, last_error = left(p_error, 2000)
  where id = v_delivery.id;
end;
$$;

comment on function app.finish_stakeholder_pack_delivery(uuid, boolean, text, text, boolean) is 'Worker API (service role): records that a stakeholder pack email went out (with the transport''s message id), logging Sent, or failed (with the reason). A failed send revokes the link it carried, so it leaves no working link; p_retry says the job will try again, so the delivery stays Queued for the next attempt, which mints a new link.';
revoke all on function app.finish_stakeholder_pack_delivery(uuid, boolean, text, text, boolean) from public, anon, authenticated;
grant execute on function app.finish_stakeholder_pack_delivery(uuid, boolean, text, text, boolean) to service_role;

-- Ending what a pack held --------------------------------------------------------------------------------------------

create or replace function private.retire_ended_stakeholder_packs(p_limit integer default 500)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pack record;
  v_count integer := 0;
begin
  -- An emailed link stays 30 days past its pack's expiry, so an old email's unsubscribe still works until then.
  delete from private.stakeholder_pack_links l
  using app.stakeholder_pack_recipients r, app.stakeholder_packs p
  where l.recipient_id = r.id and p.id = r.stakeholder_pack_id and p.expires_at < now() - interval '30 days';
  for v_pack in
    select p.id from app.stakeholder_packs p
    where p.deleted_at is null and least(coalesce(p.revoked_at, p.expires_at), p.expires_at) < now() - interval '1 year'
    order by p.id
    limit greatest(coalesce(p_limit, 500), 1)
    for update skip locked
  loop
    delete from private.stakeholder_pack_grants g
    using app.stakeholder_pack_recipients r
    where g.recipient_id = r.id and r.stakeholder_pack_id = v_pack.id;
    delete from private.stakeholder_pack_links l
    using app.stakeholder_pack_recipients r
    where l.recipient_id = r.id and r.stakeholder_pack_id = v_pack.id;
    delete from private.file_download_tickets t
    using app.stakeholder_pack_recipients r
    where t.stakeholder_pack_recipient_id = r.id and r.stakeholder_pack_id = v_pack.id;
    perform private.begin_trusted_operation('stakeholder_pack_service');
    update app.stakeholder_pack_deliveries set deleted_at = now() where stakeholder_pack_id = v_pack.id and deleted_at is null;
    update app.stakeholder_pack_schedules set deleted_at = now() where stakeholder_pack_id = v_pack.id and deleted_at is null;
    update app.stakeholder_pack_items set deleted_at = now() where stakeholder_pack_id = v_pack.id and deleted_at is null;
    update app.stakeholder_pack_recipients set deleted_at = now() where stakeholder_pack_id = v_pack.id and deleted_at is null;
    update app.stakeholder_packs set deleted_at = now() where id = v_pack.id;
    perform private.end_trusted_operation('stakeholder_pack_service');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function private.retire_ended_stakeholder_packs(integer) is 'Daily job: deletes emailed links 30 days past their pack''s expiry, and one year after a stakeholder pack ended (revoked or expired, whichever came first), soft-deletes it with its items, recipients, schedule and deliveries and deletes its emailed links, device grants and download tickets, so the tables'' one-year retention then purges them (ADR 0141). A non-user''s name and email leave two years after the pack ended. Returns the packs retired.';
revoke all on function private.retire_ended_stakeholder_packs(integer) from public, anon, authenticated;

select cron.schedule('xos_retire_ended_stakeholder_packs', '57 4 * * *', 'select private.retire_ended_stakeholder_packs()');
