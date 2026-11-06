-- 3008_rfq_quote_chase.sql
-- B11 Quote chasing (RRR-235, G-196, ADR 0150). Pending quotes are chased hourly, and suppliers who lost hear so, with
-- the seal intact.
--
--   * Settings (packages/schemas/settings/b11.yaml): procurement.quote_chase_enabled (default on),
--     procurement.quote_chase_interval_hours (default 48, 12 to 168) and procurement.quote_chase_limit (default 3, 1 to
--     10), read through private.rfq_chase_settings.
--   * app.rfq_supplier_notices: the append-only ledger, written before anything is sent, so a second run sends nothing.
--     It reads like a sealed response: a per-vendor view while Issued would show who has answered.
--   * app.rfq_chase_status: an owner-rights view with one row per RFQ. While Issued it holds only the settings and the
--     due date: with one invited vendor, a total that stops rising would tell a procurement.rfq.read holder the vendor
--     answered. The counts appear once the RFQ is Closed or Awarded, for holders of procurement.bid.read.
--   * private.vendor_reachable and app.rfq_vendor_reachability: whether a vendor has an account person to reach, which
--     is static and leaks nothing.
--   * private.send_rfq_supplier_notices runs hourly (pg_cron, minute 37). rfq.issued notifies nobody, so the first
--     reminder is the vendor's first contact and its copy stands alone. private.rfq_chase_started records when this
--     file ran: both notices consider only RFQs whose latest Issued or Awarded transition is later, so an RFQ already
--     open or decided at release gets no surprise email.
--   * api_external.rfq_requests and rfq_request_lines: where a chase email lands. Only Issued RFQs, because an invitation
--     exists while an RFQ is still a Proposed draft (rfq_no_invitations), and no prices, needs or other vendors.

-- 1. Settings ---------------------------------------------------------------------------------------------------------------------

select private.define_setting('procurement.quote_chase_enabled', 'Boolean', 'procurement.rfq.issue', array['organization'], false, p_default_boolean => true);
select private.define_setting('procurement.quote_chase_interval_hours', 'Integer', 'procurement.rfq.issue', array['organization'], false, p_default_integer => 48, p_min_integer => 12, p_max_integer => 168);
select private.define_setting('procurement.quote_chase_limit', 'Integer', 'procurement.rfq.issue', array['organization'], false, p_default_integer => 3, p_min_integer => 1, p_max_integer => 10);

create or replace function private.rfq_chase_settings(p_org_id uuid)
returns table (enabled boolean, interval_hours integer, reminder_limit integer)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce((select v.value_boolean from app.setting_values v
              where v.org_id = p_org_id and v.setting_key = 'procurement.quote_chase_enabled'
                and v.scope_kind = 'Organization' and v.scope_id = p_org_id and v.deleted_at is null limit 1), true),
    coalesce((select v.value_integer::integer from app.setting_values v
              where v.org_id = p_org_id and v.setting_key = 'procurement.quote_chase_interval_hours'
                and v.scope_kind = 'Organization' and v.scope_id = p_org_id and v.deleted_at is null limit 1), 48),
    coalesce((select v.value_integer::integer from app.setting_values v
              where v.org_id = p_org_id and v.setting_key = 'procurement.quote_chase_limit'
                and v.scope_kind = 'Organization' and v.scope_id = p_org_id and v.deleted_at is null limit 1), 3)
  where p_org_id in (select private.my_org_ids()) or private.current_person_id() is null;
$$;
comment on function private.rfq_chase_settings(uuid) is 'The org settings procurement.quote_chase_enabled (default true), procurement.quote_chase_interval_hours (default 48) and procurement.quote_chase_limit (default 3), B11. Answers for an org of the signed-in person, or for the sweep, which runs with no person; no row otherwise.';
revoke all on function private.rfq_chase_settings(uuid) from public, anon;
grant execute on function private.rfq_chase_settings(uuid) to authenticated, service_role;

-- 2. The ledger and its start -----------------------------------------------------------------------------------------------------

create table private.rfq_chase_started (
  only_row boolean primary key default true,
  started_at timestamptz not null default now(),
  constraint rfq_chase_started_only_row check (only_row)
);
comment on table private.rfq_chase_started is 'When quote chasing was released (B11): RFQs issued or awarded before it get no notice, so the first sweep does not email every open RFQ''s vendors.';
comment on column private.rfq_chase_started.only_row is 'Always true: the table holds one row.';
comment on column private.rfq_chase_started.started_at is 'When migration 3008 ran.';
alter table private.rfq_chase_started enable row level security;
revoke all on private.rfq_chase_started from public, anon, authenticated;
insert into private.rfq_chase_started default values;

create table app.rfq_supplier_notices (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  rfq_id uuid not null references app.rfqs (id),
  vendor_id uuid not null references app.vendors (id),
  notice_kind app.rfq_notice_kind not null,
  reminder_number smallint not null,
  sent_at timestamptz not null default now(),
  constraint rfq_supplier_notices_number_range check (reminder_number between 1 and 10)
);
create unique index rfq_supplier_notices_number_key on app.rfq_supplier_notices (rfq_id, vendor_id, notice_kind, reminder_number);
create index rfq_supplier_notices_vendor_id_idx on app.rfq_supplier_notices (vendor_id);

call private.install_domain_table('app.rfq_supplier_notices', 'app.rfqs', 'rfq_id', array['app.vendors', 'vendor_id'], true);
call private.install_policies('app.rfq_supplier_notices',
  $$rfq_id in (select r.id from app.rfqs r where r.rfq_state in ('Closed', 'Awarded')
     and r.project_id in (select private.project_ids_with('procurement.bid.read')))$$);
call private.describe('app.rfq_supplier_notices', 'Append-only ledger of notices to RFQ suppliers (B11, G-196), written before anything is sent, so a notice is never sent twice. Sealed like a response (0331): readable only once the RFQ is Closed or Awarded, by procurement.bid.read, because a per-vendor view while Issued would show who has answered.', array[
  'rfq_id', 'RFQ.',
  'vendor_id', 'Invited vendor.',
  'notice_kind', 'Quote Reminder or Not Awarded.',
  'reminder_number', 'Count of reminders to this vendor on this RFQ, 1 first; 1 for Not Awarded.',
  'sent_at', 'When it was sent.'
]);
call private.install_default_retention('app.rfq_supplier_notices');

-- 3. What a buyer may read ----------------------------------------------------------------------------------------------------------

create view app.rfq_chase_status as
select r.id as rfq_id, r.org_id, r.project_id, r.rfq_state, s.enabled as chase_enabled, s.interval_hours, s.reminder_limit, r.responses_due_at,
  case when v.unsealed then (select count(*) from app.rfq_supplier_notices n where n.rfq_id = r.id and n.notice_kind = 'Quote Reminder') end as reminders_sent,
  case when v.unsealed then (select max(n.sent_at) from app.rfq_supplier_notices n where n.rfq_id = r.id and n.notice_kind = 'Quote Reminder') end as last_reminded_at
from app.rfqs r
cross join lateral private.rfq_chase_settings(r.org_id) s
cross join lateral (select r.rfq_state in ('Closed', 'Awarded') and private.can_on_project(r.project_id, 'procurement.bid.read') as unsealed) v
where r.deleted_at is null and r.project_id in (select private.project_ids_with('procurement.rfq.read'));

call private.describe('app.rfq_chase_status', 'How an RFQ''s quotes are chased (B11, G-196), one row per live RFQ for procurement.rfq.read on the project. While it is Issued the row holds only the settings and the due date, so nothing reveals whether a vendor has answered. The counts appear once it is Closed or Awarded, for procurement.bid.read.', array[
  'rfq_id', 'RFQ.',
  'org_id', 'Org.',
  'project_id', 'Project.',
  'rfq_state', 'RFQ state.',
  'chase_enabled', 'The org''s setting procurement.quote_chase_enabled.',
  'interval_hours', 'Hours between reminders.',
  'reminder_limit', 'Most reminders per vendor.',
  'responses_due_at', 'Deadline for responses.',
  'reminders_sent', 'Reminders sent on this RFQ; NULL until it is Closed or Awarded and for readers without procurement.bid.read.',
  'last_reminded_at', 'When the last went out; NULL until it is Closed or Awarded and for readers without procurement.bid.read.'
]);
revoke all on app.rfq_chase_status from public, anon;
grant select on app.rfq_chase_status to authenticated, service_role;
revoke select on app.rfq_chase_status from xos_backup;

create or replace function private.vendor_reachable(p_rfq_id uuid, p_vendor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_on_project(r.project_id, 'procurement.rfq.read') and exists (
    select 1 from app.vendors v
    join app.counterparties c on c.id = v.counterparty_id
    cross join lateral private.party_recipient_ids(null, c.organization_id) x
    where v.id = p_vendor_id and v.org_id = r.org_id)
  from app.rfqs r where r.id = p_rfq_id;
$$;
comment on function private.vendor_reachable(uuid, uuid) is 'True when the vendor has an Owner or Admin person on its account for a chase to reach (private.party_recipient_ids, 1463), for procurement.rfq.read on the RFQ''s project. Static, and it says nothing of whether the vendor answered. Every counterparty has an organization, so that column alone says nothing.';
revoke all on function private.vendor_reachable(uuid, uuid) from public, anon;
grant execute on function private.vendor_reachable(uuid, uuid) to authenticated, service_role;

create or replace function app.rfq_vendor_reachability(p_rfq_id uuid)
returns table (vendor_id uuid, reachable boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select i.vendor_id, coalesce(private.vendor_reachable(p_rfq_id, i.vendor_id), false)
  from app.rfq_invitations i
  join app.rfqs r on r.id = i.rfq_id
  where i.rfq_id = p_rfq_id and i.deleted_at is null and private.can_on_project(r.project_id, 'procurement.rfq.read');
$$;
comment on function app.rfq_vendor_reachability(uuid) is 'Each invited vendor of an RFQ and whether a chase can reach it (private.vendor_reachable), for procurement.rfq.read on the project; no row otherwise. Atlas says to chase the others by phone.';
revoke all on function app.rfq_vendor_reachability(uuid) from public, anon;
grant execute on function app.rfq_vendor_reachability(uuid) to authenticated, service_role;

-- 4. The notices --------------------------------------------------------------------------------------------------------------------

create or replace function private.send_rfq_supplier_notice(
  p_rfq app.rfqs,
  p_vendor_id uuid,
  p_kind app.rfq_notice_kind,
  p_number smallint,
  p_args jsonb
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account uuid;
  v_recipients uuid[];
  v_recipient uuid;
  v_claimed boolean;
  v_sent integer := 0;
begin
  select c.organization_id into v_account from app.vendors v join app.counterparties c on c.id = v.counterparty_id where v.id = p_vendor_id;
  v_recipients := array(select x from private.party_recipient_ids(null, v_account) x);
  -- No person to reach: no row and no send. private.recipient_address reads only auth.users.
  if cardinality(v_recipients) = 0 then
    return 0;
  end if;
  insert into app.rfq_supplier_notices (rfq_id, vendor_id, notice_kind, reminder_number)
  values (p_rfq.id, p_vendor_id, p_kind, p_number)
  on conflict (rfq_id, vendor_id, notice_kind, reminder_number) do nothing
  returning true into v_claimed;
  if not coalesce(v_claimed, false) then
    return 0;
  end if;
  foreach v_recipient in array v_recipients loop
    perform private.notify(p_rfq.org_id, v_recipient,
      case p_kind when 'Quote Reminder' then 'rfq.quote_reminder' else 'rfq.not_awarded' end,
      'rfqs', p_rfq.id, p_rfq.project_id,
      -- A member's link opens Atlas; anyone else's opens Gateway.
      case when exists (select 1 from app.memberships m where m.org_id = p_rfq.org_id and m.person_id = v_recipient and m.deleted_at is null
                        and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()))
           then p_args - 'gatewayPath' else p_args end);
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end;
$$;
comment on function private.send_rfq_supplier_notice(app.rfqs, uuid, app.rfq_notice_kind, smallint, jsonb) is 'Claims one ledger row, then notifies the vendor''s Owner and Admin people through private.notify, so preferences apply. A vendor with no such person gets no row and no send, and a row already claimed sends nothing. Args carry the RFQ title, org and project names, the due date and the Gateway path, never a price, a winner or another vendor.';
revoke all on function private.send_rfq_supplier_notice(app.rfqs, uuid, app.rfq_notice_kind, smallint, jsonb) from public, anon, authenticated;

create or replace function private.send_rfq_supplier_notices(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_started timestamptz := (select s.started_at from private.rfq_chase_started s);
  v_row record;
  v_settings record;
  v_count integer;
  v_last timestamptz;
  v_anchor timestamptz;
  v_args jsonb;
  v_sent integer := 0;
begin
  for v_row in
    select r as rfq, i.vendor_id, o.name as org_name, p.name as project_name, p.time_zone,
      (select max(t.created_at) from app.rfq_state_transitions t where t.rfq_id = r.id and t.to_state = 'Issued') as issued_at
    from app.rfqs r
    join app.rfq_invitations i on i.rfq_id = r.id and i.deleted_at is null
    join app.organizations o on o.id = r.org_id
    join app.projects p on p.id = r.project_id
    where r.rfq_state = 'Issued' and r.deleted_at is null
      and (r.responses_due_at is null or r.responses_due_at > p_now)
      and not exists (select 1 from app.rfq_responses s where s.rfq_id = r.id and s.vendor_id = i.vendor_id and s.deleted_at is null)
  loop
    if v_row.issued_at is null or v_row.issued_at <= v_started then
      continue;
    end if;
    select * into v_settings from private.rfq_chase_settings((v_row.rfq).org_id);
    if not coalesce(v_settings.enabled, true) then
      continue;
    end if;
    select count(*), max(n.sent_at) into v_count, v_last from app.rfq_supplier_notices n
    where n.rfq_id = (v_row.rfq).id and n.vendor_id = v_row.vendor_id and n.notice_kind = 'Quote Reminder';
    if v_count >= coalesce(v_settings.reminder_limit, 3) then
      continue;
    end if;
    v_anchor := greatest(v_row.issued_at, v_last);
    if p_now >= v_anchor + make_interval(hours => coalesce(v_settings.interval_hours, 48))
       or ((v_row.rfq).responses_due_at is not null and p_now >= (v_row.rfq).responses_due_at - interval '24 hours'
           and (v_last is null or v_last < (v_row.rfq).responses_due_at - interval '24 hours')) then
      v_args := jsonb_build_object('title', (v_row.rfq).title, 'orgName', v_row.org_name, 'projectName', v_row.project_name,
        'dueDate', coalesce(to_char((v_row.rfq).responses_due_at at time zone v_row.time_zone, 'YYYY-MM-DD'), 'none'),
        'gatewayPath', '/work/quote-requests');
      v_sent := v_sent + private.send_rfq_supplier_notice(v_row.rfq, v_row.vendor_id, 'Quote Reminder', (v_count + 1)::smallint, v_args);
    end if;
  end loop;

  for v_row in
    select r as rfq, s.vendor_id, o.name as org_name, p.name as project_name
    from app.rfqs r
    join app.rfq_responses s on s.rfq_id = r.id and s.deleted_at is null
    join app.organizations o on o.id = r.org_id
    join app.projects p on p.id = r.project_id
    cross join lateral (select max(t.created_at) as awarded_at from app.rfq_state_transitions t where t.rfq_id = r.id and t.to_state = 'Awarded') a
    where r.rfq_state = 'Awarded' and r.deleted_at is null
      and a.awarded_at > v_started and a.awarded_at > p_now - interval '30 days'
      and exists (select 1 from app.purchase_orders po join app.rfq_responses w on w.id = po.rfq_response_id
                  where w.rfq_id = r.id and po.deleted_at is null and po.po_state in ('Approved', 'Sent', 'Closed'))
      and not exists (select 1 from app.purchase_orders po join app.rfq_responses w on w.id = po.rfq_response_id
                      where w.rfq_id = r.id and po.vendor_id = s.vendor_id and po.deleted_at is null and po.po_state <> 'Canceled')
  loop
    v_sent := v_sent + private.send_rfq_supplier_notice(v_row.rfq, v_row.vendor_id, 'Not Awarded', 1::smallint,
      jsonb_build_object('title', (v_row.rfq).title, 'orgName', v_row.org_name, 'projectName', v_row.project_name));
  end loop;
  return v_sent;
end;
$$;
comment on function private.send_rfq_supplier_notices(timestamptz) is 'The hourly chase (pg_cron xos_send_rfq_supplier_notices, minute 37; B11, G-196). Quote Reminder: an Issued RFQ, a live invitation, no live response from the vendor, chasing on, under the limit, not past due, and either the interval has passed since the later of the latest Issued transition and the last reminder, or it is within 24 hours of due with none in those 24 hours. Not Awarded: Awarded in the last 30 days, an order from its responses is Approved, Sent or Closed, and the vendor responded but holds no live order from it that is not Canceled. Only RFQs whose latest such transition is after private.rfq_chase_started. Returns how many notifications it sent.';
revoke all on function private.send_rfq_supplier_notices(timestamptz) from public, anon, authenticated;

-- Minute 37: minutes 23 and 53 already run the org lifecycle, the advance reminders and the approval reminders.
select cron.schedule('xos_send_rfq_supplier_notices', '37 * * * *', 'select private.send_rfq_supplier_notices()');

-- 5. Where a chase lands ------------------------------------------------------------------------------------------------------------

create view api_external.rfq_requests as
select r.id, r.project_id, p.name as project_name, p.time_zone, o.name as org_name, r.title, r.responses_due_at,
  case when exists (
    select 1 from app.memberships m
    where m.person_id = r.created_by and m.org_id = r.org_id and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()))
  then cp.full_name end as contact_name
from app.rfq_invitations i
join app.rfqs r on r.id = i.rfq_id and r.deleted_at is null and r.rfq_state = 'Issued'
join app.vendors v on v.id = i.vendor_id and v.deleted_at is null
join app.counterparties c on c.id = v.counterparty_id and c.deleted_at is null
join app.projects p on p.id = r.project_id
join app.organizations o on o.id = r.org_id
left join app.people cp on cp.id = r.created_by
where i.deleted_at is null
  and c.organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]));

call private.describe('api_external.rfq_requests', 'RFQs that ask the caller''s account for a quote (B11, G-196): Issued, with a live invitation, for the Owner and Admin of the invited vendor''s account. No prices, needs, other vendors or replies.', array[
  'id', 'RFQ.',
  'project_id', 'Project.',
  'project_name', 'Name of the project.',
  'time_zone', 'Time zone of the project.',
  'org_name', 'Org asking.',
  'title', 'What is being sourced.',
  'responses_due_at', 'Deadline for responses.',
  'contact_name', 'Org member who set up the RFQ; NULL once they leave the org.'
]);
revoke all on api_external.rfq_requests from public, anon;
grant select on api_external.rfq_requests to authenticated, service_role;

create view api_external.rfq_request_lines as
select l.id, l.rfq_id, l.line_number, l.description, l.quantity, l.unit_basis, l.acquisition_kind,
  lower(l.hire_period) as hire_from, upper(l.hire_period) as hire_to
from app.rfq_lines l
join app.rfqs r on r.id = l.rfq_id and r.deleted_at is null and r.rfq_state = 'Issued'
where l.deleted_at is null
  and exists (
    select 1 from app.rfq_invitations i
    join app.vendors v on v.id = i.vendor_id and v.deleted_at is null
    join app.counterparties c on c.id = v.counterparty_id and c.deleted_at is null
    where i.rfq_id = r.id and i.deleted_at is null
      and c.organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[])));

call private.describe('api_external.rfq_request_lines', 'What an RFQ asks the caller''s account for (B11, G-196), under the same filter as api_external.rfq_requests. No prices, needs or other vendors.', array[
  'id', 'Line.',
  'rfq_id', 'RFQ.',
  'line_number', 'Order of the line.',
  'description', 'What is asked for.',
  'quantity', 'Quantity asked for.',
  'unit_basis', 'Unit of the quantity.',
  'acquisition_kind', 'Purchase, or Rental for a hire.',
  'hire_from', 'When a hire starts; NULL for a purchase.',
  'hire_to', 'When a hire ends; NULL for a purchase.'
]);
revoke all on api_external.rfq_request_lines from public, anon;
grant select on api_external.rfq_request_lines to authenticated, service_role;

-- Needs and maintenance plans go to Trash (3001, 3004; ADR 0110); the other new tables are excluded with a rationale.
select private.sync_trash_tables();
