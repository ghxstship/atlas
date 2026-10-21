-- 1463_expiry_reminders.sql
-- A89 (RRR-134), finding A65-008, work package WP8: expiry reminders that were computed (0730's reminder_due) or
-- promised (Sections 4.3 item 13, 4.4.4, 4.9 Documents) but never sent. An hourly pg_cron job,
-- private.send_expiry_reminders, reminds the person responsible before each of these expires:
--   onboarding.item_expiring  a passed onboarding item on an open engagement (Onboarding, Blocked, Active, Closing),
--                             at the requirement's own remind_days_before and then at the standard days below it
--   certification.expiring    a certification an org recorded for a holder (app.certification_holders), and a
--                             certification a person entered on their own profile (app.person_certifications; one
--                             carried from an org record is reminded through that record)
--   document.expiring         a signed or executed engagement document, a vendor's certificate of insurance on file
--                             with an org, and the person's passport (A78's app.person_work_details)
-- Days are counted on the org's calendar for org items (private.org_today) and on the person's own calendar for
-- personal items (private.person_today, their personal locale.time_zone), never on the database's UTC date.
-- Each item reminds once per threshold: the standard thresholds are 30, 7 and 1 days
-- (private.expiry_reminder_thresholds). A run sends the smallest threshold the days left have reached, so an item
-- first seen 5 days out reminds once at 7 and again at 1, never at 30. private.expiry_reminders_sent records every
-- threshold reminded per item, recipient and expiry date before the notification is queued, so the job is
-- idempotent; renewing an item (a new expiry date) starts its reminders again.
-- The recipient is the engaged person, or the Owner and Admin members of the external account an engagement or a
-- vendor record names. A personal item goes through the org the person works with most directly (an active
-- membership, then an open engagement, then any org they work with as a party): the notification queue is per org.
-- A person who works with no org gets no outside reminder for a personal item; Gateway's Profile and Documents still
-- call out what expires within 30 days. Notifications go through A80's queue, so the person's preferences for the
-- Expiry reminders category and their quiet hours apply.

-- Thresholds and the ledger --------------------------------------------------------------------------------------------

create table private.expiry_reminder_thresholds (
  days smallint primary key,
  constraint expiry_reminder_thresholds_days check (days between 0 and 365)
);

comment on table private.expiry_reminder_thresholds is 'Days before expiry a reminder goes out (A89): 30, 7 and 1. An onboarding requirement''s remind_days_before replaces the thresholds at or above it with its own.';
comment on column private.expiry_reminder_thresholds.days is 'Days left before the expiry date when a reminder is due.';

alter table private.expiry_reminder_thresholds enable row level security;
revoke all on private.expiry_reminder_thresholds from public, anon, authenticated;
grant select on private.expiry_reminder_thresholds to service_role;

insert into private.expiry_reminder_thresholds (days) values (30), (7), (1);

create table private.expiry_reminders_sent (
  subject_table text not null,
  subject_id uuid not null,
  recipient_person_id uuid not null references app.people (id),
  expires_on date not null,
  threshold_days smallint not null,
  org_id uuid references app.organizations (id),
  notification_id uuid,
  sent_at timestamptz not null default now(),
  primary key (subject_table, subject_id, recipient_person_id, expires_on, threshold_days),
  constraint expiry_reminders_sent_subject_table check (subject_table in (
    'onboarding_items', 'certification_holders', 'person_certifications', 'engagement_documents', 'insurance_certificates',
    'person_work_details'))
);

create index expiry_reminders_sent_recipient_idx on private.expiry_reminders_sent (recipient_person_id);
create index expiry_reminders_sent_org_idx on private.expiry_reminders_sent (org_id);

comment on table private.expiry_reminders_sent is 'Every expiry reminder threshold already reminded, per item, recipient and expiry date (A89). Written before the notification is queued, so private.send_expiry_reminders never reminds a threshold twice.';
comment on column private.expiry_reminders_sent.subject_table is 'Table of the expiring item.';
comment on column private.expiry_reminders_sent.subject_id is 'Id of the expiring item.';
comment on column private.expiry_reminders_sent.recipient_person_id is 'Person reminded.';
comment on column private.expiry_reminders_sent.expires_on is 'Expiry date the reminder was for; a renewed item has a new one and is reminded again.';
comment on column private.expiry_reminders_sent.threshold_days is 'Threshold reminded, in days before expiry.';
comment on column private.expiry_reminders_sent.org_id is 'Org the reminder was sent through; NULL when the person works with no org.';
comment on column private.expiry_reminders_sent.notification_id is 'Notification queued; NULL when the queue reached nobody (no org to send through, or the recipient no longer works with it).';
comment on column private.expiry_reminders_sent.sent_at is 'When the threshold was reminded.';

alter table private.expiry_reminders_sent enable row level security;
revoke all on private.expiry_reminders_sent from public, anon, authenticated;
grant all on private.expiry_reminders_sent to service_role;

-- Helpers --------------------------------------------------------------------------------------------------------------

create or replace function private.expiry_threshold(p_days_left integer, p_window integer default null)
returns smallint
language sql
stable
security definer
set search_path = ''
as $$
  select min(t.days)::smallint
  from (
    select r.days::integer from private.expiry_reminder_thresholds r where p_window is null or r.days < p_window
    union
    select p_window where p_window is not null
  ) t (days)
  where p_days_left is not null and p_days_left >= 0 and t.days >= p_days_left;
$$;

comment on function private.expiry_threshold(integer, integer) is 'The threshold a reminder is due for with p_days_left days before expiry: the smallest threshold at or above the days left, from the standard thresholds (or, with p_window, that window and the standard thresholds below it). NULL once the item has expired or before the first threshold.';
revoke all on function private.expiry_threshold(integer, integer) from public, anon, authenticated;

create or replace function private.person_reminder_org(p_person_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select m.org_id from app.memberships m
     where m.person_id = p_person_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
     order by m.valid_from desc, m.id limit 1),
    (select e.org_id from app.engagements e
     where e.person_id = p_person_id and e.deleted_at is null and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
     order by e.start_date desc, e.id limit 1),
    (select x.org_id from private.party_org_ids(p_person_id) x (org_id) order by x.org_id limit 1));
$$;

comment on function private.person_reminder_org(uuid) is 'The org a reminder about a personal item goes through (the notification queue is per org): the person''s newest active membership, then their newest open engagement, then any org they work with as a party. NULL when they work with no org.';
revoke all on function private.person_reminder_org(uuid) from public, anon, authenticated;

create or replace function private.party_recipient_ids(p_person_id uuid, p_account_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p_person_id where p_account_id is null and p_person_id is not null
  union
  select distinct m.person_id from app.account_memberships m
  join app.account_membership_roles r on r.account_membership_id = m.id and r.deleted_at is null
  where p_account_id is not null and m.org_id = p_account_id and m.deleted_at is null and m.valid_from <= now()
    and (m.valid_to is null or m.valid_to > now()) and r.account_role in ('Account Owner', 'Account Admin');
$$;

comment on function private.party_recipient_ids(uuid, uuid) is 'Who answers for an external party''s item: the person, or the Owner and Admin members of the external account when one is named.';
revoke all on function private.party_recipient_ids(uuid, uuid) from public, anon, authenticated;

create or replace function private.remind_expiry(
  p_kind text,
  p_subject_table text,
  p_subject_id uuid,
  p_recipient_person_id uuid,
  p_org_id uuid,
  p_project_id uuid,
  p_expires_on date,
  p_threshold smallint,
  p_days_left integer,
  p_args jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claimed boolean;
  v_notification uuid;
  v_args jsonb := coalesce(p_args, '{}'::jsonb) || jsonb_build_object('days', p_days_left, 'expiresOn', p_expires_on::text);
begin
  if p_threshold is null or p_recipient_person_id is null then
    return false;
  end if;
  insert into private.expiry_reminders_sent (subject_table, subject_id, recipient_person_id, expires_on, threshold_days, org_id)
  values (p_subject_table, p_subject_id, p_recipient_person_id, p_expires_on, p_threshold, p_org_id)
  on conflict do nothing
  returning true into v_claimed;
  if not coalesce(v_claimed, false) then
    return false;
  end if;
  if p_org_id is not null then
    -- A member's link opens Atlas; anyone else's opens Gateway.
    if exists (select 1 from app.memberships m where m.org_id = p_org_id and m.person_id = p_recipient_person_id and m.deleted_at is null
               and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
      v_args := v_args - 'gatewayPath';
    end if;
    v_notification := private.notify(p_org_id, p_recipient_person_id, p_kind, p_subject_table, p_subject_id, p_project_id, v_args);
    update private.expiry_reminders_sent set notification_id = v_notification
    where subject_table = p_subject_table and subject_id = p_subject_id and recipient_person_id = p_recipient_person_id
      and expires_on = p_expires_on and threshold_days = p_threshold;
  end if;
  return v_notification is not null;
end;
$$;

comment on function private.remind_expiry(text, text, uuid, uuid, uuid, uuid, date, smallint, integer, jsonb) is 'Reminds one recipient of one expiring item at one threshold, once: claims the threshold in private.expiry_reminders_sent, then queues the notification through the org (private.notify) with the days left and the expiry date. Returns true when a notification was queued.';
revoke all on function private.remind_expiry(text, text, uuid, uuid, uuid, uuid, date, smallint, integer, jsonb) from public, anon, authenticated;

-- The job ----------------------------------------------------------------------------------------------------------------

create or replace function private.send_expiry_reminders()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_max integer := (select max(t.days) from private.expiry_reminder_thresholds t);
  v_row record;
  v_person uuid;
  v_days integer;
  v_threshold smallint;
  v_org uuid;
  v_sent integer := 0;
begin
  -- Onboarding items: org items, on the org's calendar, at the requirement's window and the standard days below it.
  for v_row in
    select i.id, i.org_id, e.id as engagement_id, e.person_id, e.project_id, c.organization_id as account_id, r.name,
      r.remind_days_before, lv.expires_on, og.name as org_name, pr.name as project_name,
      lv.expires_on - private.org_today(i.org_id) as days_left
    from app.onboarding_items i
    join app.engagements e on e.id = i.engagement_id and e.deleted_at is null
      and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
    join app.onboarding_requirements r on r.id = i.onboarding_requirement_id
    left join app.counterparties c on c.id = e.counterparty_id
    join app.organizations og on og.id = i.org_id
    join app.projects pr on pr.id = e.project_id
    cross join lateral (
      select v.outcome, v.expires_on from app.onboarding_verifications v
      where v.onboarding_item_id = i.id order by v.verified_at desc, v.id desc limit 1) lv
    where i.deleted_at is null and lv.outcome = 'Passed' and lv.expires_on is not null
      and lv.expires_on - private.org_today(i.org_id) between 0 and greatest(v_max, coalesce(r.remind_days_before, 0))
  loop
    v_threshold := private.expiry_threshold(v_row.days_left, v_row.remind_days_before);
    for v_person in select x from private.party_recipient_ids(v_row.person_id, v_row.account_id) x loop
      if private.remind_expiry('onboarding.item_expiring', 'onboarding_items', v_row.id, v_person, v_row.org_id, v_row.project_id,
           v_row.expires_on, v_threshold, v_row.days_left,
           jsonb_build_object('title', v_row.name, 'orgName', v_row.org_name, 'projectName', v_row.project_name,
             'gatewayPath', '/work/engagements/' || private.gateway_display_key('ENG', v_row.engagement_id))) then
        v_sent := v_sent + 1;
      end if;
    end loop;
  end loop;

  -- Certifications an org recorded: org items, on the org's calendar; a renewed record supersedes the old one.
  for v_row in
    select h.id, h.org_id, h.person_id, ce.name, h.expires_on, og.name as org_name,
      h.expires_on - private.org_today(h.org_id) as days_left
    from app.certification_holders h
    join app.certifications ce on ce.id = h.certification_id
    join app.organizations og on og.id = h.org_id
    where h.deleted_at is null and h.expires_on is not null
      and h.expires_on - private.org_today(h.org_id) between 0 and v_max
      and not exists (select 1 from app.certification_holders h2
                      where h2.person_id = h.person_id and h2.certification_id = h.certification_id and h2.deleted_at is null
                        and h2.id <> h.id and (h2.expires_on is null or h2.expires_on > h.expires_on))
  loop
    if private.remind_expiry('certification.expiring', 'certification_holders', v_row.id, v_row.person_id, v_row.org_id, null,
         v_row.expires_on, private.expiry_threshold(v_row.days_left), v_row.days_left,
         jsonb_build_object('title', v_row.name, 'orgName', v_row.org_name, 'gatewayPath', '/profile')) then
      v_sent := v_sent + 1;
    end if;
  end loop;

  -- Certifications a person entered on their profile: personal items, on the person's calendar.
  for v_row in
    select pc.id, pc.person_id, pc.name, pc.expires_on, pc.expires_on - private.person_today(pc.person_id) as days_left
    from app.person_certifications pc
    join app.people p on p.id = pc.person_id and p.deleted_at is null
    where pc.deleted_at is null and pc.expires_on is not null and pc.source_certification_holder_id is null
      and pc.expires_on - private.person_today(pc.person_id) between 0 and v_max
      and not exists (select 1 from app.person_certifications p2
                      where p2.person_id = pc.person_id and p2.deleted_at is null and p2.id <> pc.id
                        and lower(btrim(p2.name)) = lower(btrim(pc.name)) and (p2.expires_on is null or p2.expires_on > pc.expires_on))
  loop
    v_org := private.person_reminder_org(v_row.person_id);
    if private.remind_expiry('certification.expiring', 'person_certifications', v_row.id, v_row.person_id, v_org, null,
         v_row.expires_on, private.expiry_threshold(v_row.days_left), v_row.days_left,
         jsonb_build_object('title', v_row.name, 'orgName', (select o.name from app.organizations o where o.id = v_org),
           'gatewayPath', '/profile')) then
      v_sent := v_sent + 1;
    end if;
  end loop;

  -- Engagement documents in force: org items, on the org's calendar.
  for v_row in
    select d.id, d.org_id, d.title, d.expires_on, e.person_id, e.project_id, c.organization_id as account_id, og.name as org_name,
      pr.name as project_name, d.expires_on - private.org_today(d.org_id) as days_left
    from app.engagement_documents d
    join app.engagements e on e.id = d.engagement_id and e.deleted_at is null and e.engagement_state <> 'Canceled'
    left join app.counterparties c on c.id = e.counterparty_id
    join app.organizations og on og.id = d.org_id
    join app.projects pr on pr.id = e.project_id
    where d.deleted_at is null and d.expires_on is not null and d.engagement_document_state in ('Signed', 'Executed')
      and d.expires_on - private.org_today(d.org_id) between 0 and v_max
  loop
    v_threshold := private.expiry_threshold(v_row.days_left);
    for v_person in select x from private.party_recipient_ids(v_row.person_id, v_row.account_id) x loop
      if private.remind_expiry('document.expiring', 'engagement_documents', v_row.id, v_person, v_row.org_id, v_row.project_id,
           v_row.expires_on, v_threshold, v_row.days_left,
           jsonb_build_object('kind', 'document', 'title', v_row.title, 'orgName', v_row.org_name, 'projectName', v_row.project_name,
             'gatewayPath', '/documents')) then
        v_sent := v_sent + 1;
      end if;
    end loop;
  end loop;

  -- Certificates of insurance a vendor keeps on file with an org: org items, on the org's calendar, to the vendor's
  -- account; a later certificate of the same coverage supersedes it.
  for v_row in
    select ic.id, ic.org_id, ic.coverage_type, ic.valid_to as expires_on, c.organization_id as account_id, og.name as org_name,
      ic.valid_to - private.org_today(ic.org_id) as days_left
    from app.insurance_certificates ic
    join app.vendors vd on vd.id = ic.vendor_id and vd.deleted_at is null
    join app.counterparties c on c.id = vd.counterparty_id and c.organization_id is not null
    join app.organizations og on og.id = ic.org_id
    where ic.deleted_at is null and ic.valid_to - private.org_today(ic.org_id) between 0 and v_max
      and not exists (select 1 from app.insurance_certificates i2
                      where i2.vendor_id = ic.vendor_id and i2.deleted_at is null and i2.id <> ic.id
                        and lower(btrim(i2.coverage_type)) = lower(btrim(ic.coverage_type)) and i2.valid_to > ic.valid_to)
  loop
    v_threshold := private.expiry_threshold(v_row.days_left);
    for v_person in select x from private.party_recipient_ids(null, v_row.account_id) x loop
      if private.remind_expiry('document.expiring', 'insurance_certificates', v_row.id, v_person, v_row.org_id, null,
           v_row.expires_on, v_threshold, v_row.days_left,
           jsonb_build_object('kind', 'insurance', 'title', v_row.coverage_type, 'orgName', v_row.org_name,
             'gatewayPath', '/settings/company/insurance-and-compliance-documents')) then
        v_sent := v_sent + 1;
      end if;
    end loop;
  end loop;

  -- The passport in a person's work details: a personal item, on the person's calendar.
  for v_row in
    select w.id, w.person_id, w.passport_expires_on as expires_on, w.passport_expires_on - private.person_today(w.person_id) as days_left
    from app.person_work_details w
    join app.people p on p.id = w.person_id and p.deleted_at is null
    where w.deleted_at is null and w.passport_expires_on is not null
      and w.passport_expires_on - private.person_today(w.person_id) between 0 and v_max
  loop
    v_org := private.person_reminder_org(v_row.person_id);
    if private.remind_expiry('document.expiring', 'person_work_details', v_row.id, v_row.person_id, v_org, null,
         v_row.expires_on, private.expiry_threshold(v_row.days_left), v_row.days_left,
         jsonb_build_object('kind', 'passport', 'title', 'passport', 'orgName', (select o.name from app.organizations o where o.id = v_org),
           'gatewayPath', '/settings/work-details')) then
      v_sent := v_sent + 1;
    end if;
  end loop;

  return v_sent;
end;
$$;

comment on function private.send_expiry_reminders() is 'The expiry reminder job (A65-008), run hourly by pg_cron so each item is reminded on the right day of its own calendar: onboarding items, certifications (org records and profile entries), engagement documents, certificates of insurance and passports, each once per threshold (private.expiry_threshold) per recipient and expiry date. Org items count days on the org''s calendar, personal items on the person''s. Returns how many notifications it queued.';
revoke all on function private.send_expiry_reminders() from public, anon, authenticated;

select cron.schedule('xos_send_expiry_reminders', '13 * * * *', 'select private.send_expiry_reminders()');
