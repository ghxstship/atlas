-- 1131_external_party_notifications.sql
-- A44 Gateway, notification and Compass gaps (RRR-88), finding A38-002 (journey 56: the vendor "receives a push
-- notification at each step" from Submitted to Paid). private.notify (0520) reached only people with a live membership,
-- so external parties (vendors, contractors, artists, clients, sponsors) were never notified. This migration:
--   * app.person_notification_preferences: an external party's own Email and Push choice per category, kept in
--     Gateway settings (a person without a membership has no app.notification_preferences rows)
--   * private.party_org_ids(person): the orgs a person works with as an external party, through an engagement or
--     an account membership in an account the org holds as a counterparty
--   * private.notify, replaced: a member is notified as before; an external party of the org now gets the in-app
--     notification and one Email and one Push delivery per channel their preferences allow (no quiet hours or
--     digest: those are membership settings). Anyone else still gets nothing (invariant 3, extended)
--   * the notification read policy, private.is_my_notification and app.claim_notification_deliveries accept the
--     recipient's external party orgs too; Push for a party with no registered device is recorded and then
--     suppressed with its reason, so the delivery record exists and reaching a device stays a device step
--   * invoice status notifications to the invoicing account's Owner, Admin and Finance members, under the finance
--     category, following the Money tracker's steps (A43's invoice states on main 5bd927f, packages/data
--     invoiceTrackerStep): invoice.submitted when a payable invoice is recorded, invoice.approved when it is
--     approved, invoice.scheduled when a payment is applied to it (or an approved payment leaves a balance), and
--     invoice.paid when approved payments settle it

-- Preferences ------------------------------------------------------------------------------------------------------

create table app.person_notification_preferences (
  id uuid primary key default private.uuid_v7(),
  person_id uuid not null references app.people (id),
  category_code text not null references private.notification_categories (code),
  channel app.notification_channel not null,
  enabled boolean not null,
  constraint person_notification_preferences_channel check (channel in ('Email', 'Push'))
);

call private.install_person_table('app.person_notification_preferences');
create unique index person_notification_preferences_key on app.person_notification_preferences (person_id, category_code, channel)
  where deleted_at is null;
create index person_notification_preferences_category_idx on app.person_notification_preferences (category_code);
call private.describe('app.person_notification_preferences', 'An external party''s own notification choice per category and outside channel (Email or Push), set in Gateway settings. Without a row the channel default applies. Members keep their per-org app.notification_preferences.', array[
  'id', 'Primary key, UUID v7.',
  'person_id', 'Owner.',
  'category_code', 'Notification category.',
  'channel', 'Email or Push.',
  'enabled', 'True to receive the category on the channel.'
]);

call private.install_default_retention('app.person_notification_preferences');

create or replace function private.person_channel_enabled(p_person_id uuid, p_category text, p_channel app.notification_channel)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.enabled from app.person_notification_preferences p
     where p.person_id = p_person_id and p.category_code = p_category and p.channel = p_channel and p.deleted_at is null),
    (select d.enabled_by_default from private.channel_defaults d where d.channel = p_channel));
$$;

comment on function private.person_channel_enabled(uuid, text, app.notification_channel) is 'Whether an external party receives a category on a channel: their own preference, or the channel default.';

-- External party orgs --------------------------------------------------------------------------------------------------

create or replace function private.party_org_ids(p_person_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.org_id from app.engagements e
  where e.person_id = p_person_id and e.deleted_at is null
  union
  select c.org_id from app.counterparties c
  join app.account_memberships m on m.org_id = c.organization_id and m.person_id = p_person_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  where c.deleted_at is null;
$$;

comment on function private.party_org_ids(uuid) is 'Orgs a person works with as an external party: through an engagement of their own, or an active membership in an external account the org holds as a counterparty.';

create or replace function private.my_party_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select private.party_org_ids(private.current_person_id());
$$;

comment on function private.my_party_org_ids() is 'Orgs the signed-in person works with as an external party.';

-- private.notify, with the external party path ---------------------------------------------------------------------------

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
  insert into app.notifications (org_id, recipient_person_id, kind, actor_person_id, subject_table, subject_id, project_id, message_args)
  values (p_org_id, p_recipient_person_id, p_kind, private.current_person_id(), p_subject_table, p_subject_id, p_project_id,
    coalesce(p_message_args, '{}'::jsonb))
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
      v_quiet := case when v_channel in ('SMS', 'Push') and not v_urgent then private.local_quiet_until(v_membership, now()) end;
      v_digest := case when v_channel = 'Email' and not v_urgent then private.next_digest_at(v_membership, now()) end;
      insert into app.notification_deliveries (notification_id, notification_created_at, channel, message_status, deliver_after)
      values (v_id, v_created, v_channel,
        (case when v_digest is not null then 'Digest' when v_quiet is not null then 'Deferred' else 'Queued' end)::app.message_status,
        coalesce(v_digest, v_quiet, now()))
      returning id into v_delivery;
      if v_digest is not null then
        insert into app.email_digest_queue (notification_delivery_id, notification_created_at, membership_id, due_at)
        values (v_delivery, v_created, v_membership, v_digest);
      end if;
    end if;
  end loop;
  return v_id;
end;
$$;

comment on function private.notify(uuid, uuid, text, text, uuid, uuid, jsonb) is 'Creates a notification and its outside deliveries. An active member gets one delivery per channel they receive the category on: SMS and push wait out quiet hours and non-urgent email joins the digest when the member chose one; urgent categories go at once. An external party of the org (1131) gets the notification and an Email and a Push delivery as their own preferences allow, at once. Anyone else gets nothing (invariant 3). Returns the notification id, or null.';

-- Reading and claiming --------------------------------------------------------------------------------------------------

call private.install_policies('app.notifications',
  $$recipient_person_id = (select private.current_person_id())
    and (org_id in (select private.my_org_ids()) or org_id in (select private.my_party_org_ids()))$$,
  null,
  $$recipient_person_id = (select private.current_person_id())
    and (org_id in (select private.my_org_ids()) or org_id in (select private.my_party_org_ids()))$$);

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
      and (n.org_id in (select private.my_org_ids()) or n.org_id in (select private.my_party_org_ids()))
  );
$$;

comment on function private.is_my_notification(uuid) is 'True when the signed-in person is the recipient of a notification and still belongs to its org or works with it as an external party (1131). Takes the id as an argument (ADR 0016 rule 14).';

-- The delivery worker: a recipient who works with the org as an external party is not suppressed as having left it.

create or replace function app.claim_notification_deliveries(p_channel app.notification_channel, p_limit integer default 50)
returns table (
  delivery_id uuid, org_id uuid, recipient_person_id uuid, address text, kind text, email_template_code text,
  message_args jsonb, subject_table text, subject_id uuid, push_tokens text[]
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
  v_category text;
  v_transactional boolean;
begin
  for v_row in
    select d.id, d.notification_created_at, n.org_id, n.recipient_person_id, n.kind, n.message_args, n.subject_table, n.subject_id,
      t.email_template_code, t.category_code
    from app.notification_deliveries d
    join app.notifications n on n.id = d.notification_id and n.created_at = d.notification_created_at
    join private.notification_templates t on t.kind = n.kind and t.channel = d.channel
    where d.channel = p_channel and d.message_status in ('Queued', 'Deferred') and d.deliver_after <= now()
    order by d.deliver_after
    limit least(greatest(p_limit, 1), 500)
    for update of d skip locked
  loop
    v_reason := null;
    v_address := private.recipient_address(v_row.recipient_person_id, p_channel);
    v_transactional := coalesce((select e.transactional from private.email_templates e where e.code = v_row.email_template_code), false);
    if v_row.org_id not in (select private.person_org_ids(v_row.recipient_person_id))
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
    elsif p_channel = 'Push' and not exists (
      select 1 from app.push_subscriptions ps join app.memberships m on m.id = ps.membership_id
      where m.person_id = v_row.recipient_person_id and ps.org_id = v_row.org_id and ps.revoked_at is null and ps.deleted_at is null) then
      v_reason := 'No registered device.';
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
    push_tokens := case when p_channel = 'Push' then (
      select array_agg(ps.expo_push_token order by ps.last_seen_at desc) from app.push_subscriptions ps
      join app.memberships m on m.id = ps.membership_id
      where m.person_id = v_row.recipient_person_id and ps.org_id = v_row.org_id and ps.revoked_at is null and ps.deleted_at is null) end;
    return next;
  end loop;
end;
$$;

comment on function app.claim_notification_deliveries(app.notification_channel, integer) is 'Worker API (service role): claims due deliveries of a channel with SKIP LOCKED. Suppresses, with the reason, any delivery whose recipient neither belongs to the org nor works with it as an external party (1131), has no verified address, is suppressed, lacks SMS consent or has no device. Returns what the sender needs; a claimed delivery becomes due again after 10 minutes unless its outcome is recorded.';

-- Invoice status notifications ------------------------------------------------------------------------------------------

insert into private.notification_templates (kind, channel, category_code, email_template_code)
select k.kind, c.channel, 'finance', case when c.channel = 'Email' then 'notification' end
from (values ('invoice.submitted'), ('invoice.scheduled'), ('invoice.paid')) as k (kind)
cross join (values ('In App'::app.notification_channel), ('Email'), ('SMS'), ('Push')) as c (channel)
on conflict do nothing;

create or replace function private.notify_invoice_party(p_invoice_id uuid, p_kind text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_invoice record;
  v_person uuid;
  v_sent integer := 0;
begin
  select i.id, i.org_id, i.project_id, i.direction, i.invoice_number, c.organization_id as account_id, o.name as org_name,
    p.name as project_name
  into v_invoice
  from app.invoices i
  join app.counterparties c on c.id = i.counterparty_id
  join app.organizations o on o.id = i.org_id
  join app.projects p on p.id = i.project_id
  where i.id = p_invoice_id and i.deleted_at is null;
  if v_invoice.id is null or v_invoice.direction <> 'Payable' or v_invoice.account_id is null then
    return 0;
  end if;
  for v_person in
    select distinct m.person_id from app.account_memberships m
    join app.account_membership_roles r on r.account_membership_id = m.id and r.deleted_at is null
    where m.org_id = v_invoice.account_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
      and r.account_role in ('Account Owner', 'Account Admin', 'Account Finance')
  loop
    if private.notify(v_invoice.org_id, v_person, p_kind, 'invoices', v_invoice.id, v_invoice.project_id,
         jsonb_build_object('title', v_invoice.invoice_number, 'actorName', v_invoice.org_name, 'orgName', v_invoice.org_name,
           'projectName', v_invoice.project_name, 'gatewayPath', '/money/invoices')) is not null then
      v_sent := v_sent + 1;
    end if;
  end loop;
  return v_sent;
end;
$$;

comment on function private.notify_invoice_party(uuid, text) is 'Notifies the Owner, Admin and Finance members of the account that billed a payable invoice of one of its steps (invoice.submitted, invoice.approved, invoice.scheduled, invoice.paid). Message arguments carry display values only: the invoice number, the org and project names and the Gateway path. Returns how many people were notified.';

create or replace function private.invoice_settled_by_approved(p_invoice_id uuid, p_also_payment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select t.total is not null and t.total > 0 and coalesce(a.applied, 0) >= t.total
  from (select private.invoice_total(p_invoice_id) as total) t
  cross join lateral (
    select sum(pa.amount_minor) as applied from app.payment_applications pa
    join app.payments pm on pm.id = pa.payment_id and pm.deleted_at is null
    where pa.invoice_id = p_invoice_id and pa.deleted_at is null
      and (pm.payment_state = 'Approved' or pm.id = p_also_payment_id)
  ) a;
$$;

comment on function private.invoice_settled_by_approved(uuid, uuid) is 'True when approved payments (counting the given payment as approved) settle the invoice''s known total. An unpriced invoice is never settled.';

create or replace function private.notify_invoice_step()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_application record;
begin
  if tg_table_name = 'invoices' then
    perform private.notify_invoice_party(new.id, 'invoice.submitted');
  elsif tg_table_name = 'invoice_state_transitions' then
    perform private.notify_invoice_party(new.invoice_id, 'invoice.approved');
  elsif tg_table_name = 'payment_applications' then
    if (select pm.payment_state from app.payments pm where pm.id = new.payment_id) = 'Approved'
       and private.invoice_settled_by_approved(new.invoice_id, null) then
      perform private.notify_invoice_party(new.invoice_id, 'invoice.paid');
    else
      perform private.notify_invoice_party(new.invoice_id, 'invoice.scheduled');
    end if;
  elsif tg_table_name = 'payment_state_transitions' then
    for v_application in
      select pa.invoice_id from app.payment_applications pa where pa.payment_id = new.payment_id and pa.deleted_at is null
    loop
      if private.invoice_settled_by_approved(v_application.invoice_id, new.payment_id) then
        perform private.notify_invoice_party(v_application.invoice_id, 'invoice.paid');
      else
        perform private.notify_invoice_party(v_application.invoice_id, 'invoice.scheduled');
      end if;
    end loop;
  end if;
  return null;
end;
$$;

comment on function private.notify_invoice_step() is 'Invoice status notifications to the billing account (finding A38-002): Submitted on a payable invoice, Approved on its approval, Scheduled when a payment is applied (or an approved payment leaves a balance) and Paid when approved payments settle it.';

create trigger t92_notify_invoice_submitted after insert on app.invoices
  for each row when (new.direction = 'Payable') execute function private.notify_invoice_step();
create trigger t92_notify_invoice_approved after insert on app.invoice_state_transitions
  for each row when (new.to_state = 'Approved') execute function private.notify_invoice_step();
create trigger t92_notify_invoice_payment after insert on app.payment_applications
  for each row execute function private.notify_invoice_step();
create trigger t92_notify_invoice_paid after insert on app.payment_state_transitions
  for each row when (new.to_state = 'Approved') execute function private.notify_invoice_step();

-- Privileges ------------------------------------------------------------------------------------------------------------

revoke all on function private.person_channel_enabled(uuid, text, app.notification_channel) from public, anon, authenticated;
revoke all on function private.party_org_ids(uuid) from public, anon, authenticated;
revoke all on function private.my_party_org_ids() from public, anon;
grant execute on function private.my_party_org_ids() to authenticated, service_role;
revoke all on function private.notify(uuid, uuid, text, text, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function private.notify_invoice_party(uuid, text) from public, anon, authenticated;
revoke all on function private.invoice_settled_by_approved(uuid, uuid) from public, anon, authenticated;
revoke all on function private.notify_invoice_step() from public, anon, authenticated;
revoke all on function app.claim_notification_deliveries(app.notification_channel, integer) from public, anon, authenticated;
grant execute on function app.claim_notification_deliveries(app.notification_channel, integer) to service_role;
