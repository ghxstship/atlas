-- 0766_external_vendor.sql
-- A28 Engagements and Marketplace (RRR-30), Gateway group 6 for A27 (Section 4.4.4 Vendor: PO acknowledgment,
-- dock slots and deliveries, invoices with three-way match; onboarding: insurance certificates and
-- prequalification). Over A16's procurement and vendor tables as they exist:
--   * api_external.purchase_orders and api_external.po_lines: orders the org sent the caller's account, while its
--     engagement on the project has the money area open; budget coding never appears
--   * app.po_acknowledgments and app.acknowledge_purchase_order: the vendor acknowledges a sent order once
--   * api_external.deliveries, api_external.goods_receipts and api_external.receipt_lines: shipments the account
--     carries and what the org received against its orders
--   * api_external.vendor_insurance_certificates and api_external.vendor_prequalifications: the account's own
--     compliance on file with each org it is engaged by
-- Submittals have no source table yet.

-- Helper (column values in, ADR 0016 item 14) -----------------------------------------------------------------------

create or replace function private.counterparty_area_open(p_project_id uuid, p_counterparty_id uuid, p_area text, p_roles app.account_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.engagements e
    join app.counterparties c on c.id = e.counterparty_id
    where e.counterparty_id = p_counterparty_id and (p_project_id is null or e.project_id = p_project_id) and e.deleted_at is null
      and c.organization_id in (select private.my_account_ids(p_roles))
      and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, p_area));
$$;

comment on function private.counterparty_area_open(uuid, uuid, text, app.account_role[]) is 'Section 8.7: true when the signed-in person holds one of the account roles in the counterparty''s account and reaches the area of one of its engagements, on the project or, with a NULL project, on any project of the org. Takes column values.';

-- Purchase orders -----------------------------------------------------------------------------------------------------------

create table app.po_acknowledgments (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  purchase_order_id uuid not null references app.purchase_orders (id),
  acknowledged_by uuid references app.people (id),
  acknowledged_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index po_acknowledgments_order_key on app.po_acknowledgments (purchase_order_id) where deleted_at is null;
create index po_acknowledgments_acknowledged_by_idx on app.po_acknowledgments (acknowledged_by);

call private.install_domain_table('app.po_acknowledgments', 'app.purchase_orders', 'purchase_order_id', '{}', true);
call private.describe('app.po_acknowledgments', 'A vendor''s acknowledgment of a purchase order the org sent (Section 4.4.4 Vendor: PO acknowledgment), once per order, append-only.', array[
  'purchase_order_id', 'Purchase order acknowledged.',
  'acknowledged_by', 'Person of the vendor''s account who acknowledged, set from the session.',
  'acknowledged_at', 'When it was acknowledged, set by the database.'
]);

call private.install_policies('app.po_acknowledgments',
  $$purchase_order_id in (select po.id from app.purchase_orders po where po.project_id in (select private.project_ids_with('procurement.po.read')))$$);
revoke insert, update on app.po_acknowledgments from authenticated;

create or replace function app.acknowledge_purchase_order(p_purchase_order_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_po app.purchase_orders;
  v_counterparty uuid;
  v_id uuid;
begin
  perform private.require_person();
  select po.* into v_po from app.purchase_orders po where po.id = p_purchase_order_id and po.deleted_at is null;
  select v.counterparty_id into v_counterparty from app.vendors v where v.id = v_po.vendor_id;
  if v_po.id is null or not private.counterparty_area_open(v_po.project_id, v_counterparty, 'money',
       array['Account Owner', 'Account Admin', 'Account Finance']::app.account_role[]) then
    raise exception using errcode = '42501', message = 'only the vendor''s account acknowledges its purchase orders';
  end if;
  if v_po.po_state <> 'Sent' then
    perform private.refuse('po_not_sent', 'Only a purchase order the org has sent is acknowledged.');
  end if;
  if exists (select 1 from app.po_acknowledgments a where a.purchase_order_id = p_purchase_order_id and a.deleted_at is null) then
    perform private.refuse('po_already_acknowledged', 'This purchase order is already acknowledged.');
  end if;
  insert into app.po_acknowledgments (purchase_order_id, acknowledged_by, acknowledged_at)
  values (p_purchase_order_id, private.current_person_id(), now()) returning id into v_id;
  return v_id;
end;
$$;

comment on function app.acknowledge_purchase_order(uuid) is 'The vendor''s Account Owner, Admin or Finance member acknowledges a Sent purchase order of its engagement''s project, once. Returns the acknowledgment id.';

create view api_external.purchase_orders as
select po.id, po.org_id, o.name as org_name, po.project_id, p.name as project_name, c.organization_id as account_id, po.po_number,
  po.currency_code, po.po_state,
  (select case when count(l.id) = 0 or count(l.id) filter (where l.unit_price_minor is null) > 0 then null
               else sum(private.extended_minor(l.quantity, l.unit_price_minor))::bigint end
   from app.po_lines l where l.purchase_order_id = po.id and l.deleted_at is null) as total_minor,
  (select max(t.created_at) from app.purchase_order_state_transitions t where t.purchase_order_id = po.id and t.to_state = 'Sent') as sent_at,
  ak.acknowledged_at
from app.purchase_orders po
join app.vendors v on v.id = po.vendor_id
join app.counterparties c on c.id = v.counterparty_id
join app.organizations o on o.id = po.org_id
join app.projects p on p.id = po.project_id
left join app.po_acknowledgments ak on ak.purchase_order_id = po.id and ak.deleted_at is null
where po.deleted_at is null and po.po_state in ('Sent', 'Closed', 'Canceled')
  and exists (select 1 from app.purchase_order_state_transitions t where t.purchase_order_id = po.id and t.to_state = 'Sent')
  and private.counterparty_area_open(po.project_id, v.counterparty_id, 'money', array['Account Owner', 'Account Admin', 'Account Finance']::app.account_role[]);

call private.describe('api_external.purchase_orders', 'Purchase orders the org sent the caller''s account, for its Owner, Admin and Finance members while the account''s engagement on the project has the money area open (Section 8.7). Drafts never appear. Totals are NULL while any line is unpriced.', array[
  'id', 'Purchase order.', 'org_id', 'Org.', 'org_name', 'Org name.', 'project_id', 'Project.', 'project_name', 'Project name.',
  'account_id', 'The caller''s account.', 'po_number', 'Order number within the project.', 'currency_code', 'Currency.',
  'po_state', 'Sent, Closed or Canceled.', 'total_minor', 'Total in minor units; NULL while any line is unpriced.',
  'sent_at', 'When the org sent it.', 'acknowledged_at', 'When the account acknowledged it.']);

create view api_external.po_lines as
select l.id, l.purchase_order_id, l.line_number, l.description, l.element_id, l.quantity, l.unit_basis, l.unit_price_minor,
  private.extended_minor(l.quantity, l.unit_price_minor) as amount_minor
from app.po_lines l
where l.deleted_at is null and l.purchase_order_id in (select x.id from api_external.purchase_orders x);

call private.describe('api_external.po_lines', 'Lines of the caller''s purchase orders. Budget coding never appears.', array[
  'id', 'Line.', 'purchase_order_id', 'Purchase order.', 'line_number', 'Order.', 'description', 'What is ordered.',
  'element_id', 'Catalog element.', 'quantity', 'Quantity.', 'unit_basis', 'Unit.', 'unit_price_minor', 'Unit price; NULL is unpriced.',
  'amount_minor', 'Quantity times unit price; NULL when unpriced.']);

-- Deliveries and receipts ------------------------------------------------------------------------------------------------------

create view api_external.deliveries as
select s.id, s.project_id, p.name as project_name, s.direction, s.tracking_identifier, s.ships_at, s.arrives_at
from app.shipments s
join app.projects p on p.id = s.project_id
where s.deleted_at is null and s.carrier_counterparty_id is not null
  and private.counterparty_area_open(s.project_id, s.carrier_counterparty_id, 'operational',
    array['Account Owner', 'Account Admin', 'Account Member']::app.account_role[]);

call private.describe('api_external.deliveries', 'Shipments the caller''s account carries to and from a project where its engagement has the operational area open; dock slots for them read from api_external.dock_slots.', array[
  'id', 'Shipment.', 'project_id', 'Project.', 'project_name', 'Project name.', 'direction', 'Inbound or Outbound.',
  'tracking_identifier', 'Carrier tracking number.', 'ships_at', 'When it ships.', 'arrives_at', 'When it is due.']);

create view api_external.goods_receipts as
select g.id, g.purchase_order_id, g.received_at
from app.goods_receipts g
where g.deleted_at is null and g.purchase_order_id in (select x.id from api_external.purchase_orders x);

call private.describe('api_external.goods_receipts', 'What the org received against the caller''s purchase orders, for the three-way match. Receiving notes and who received never appear.', array[
  'id', 'Receipt.', 'purchase_order_id', 'Purchase order.', 'received_at', 'When received.']);

create view api_external.receipt_lines as
select r.id, r.goods_receipt_id, r.po_line_id, r.quantity_received
from app.receipt_lines r
join app.goods_receipts g on g.id = r.goods_receipt_id and g.deleted_at is null
where r.deleted_at is null and g.purchase_order_id in (select x.id from api_external.purchase_orders x);

call private.describe('api_external.receipt_lines', 'Quantities received per line of the caller''s purchase orders.', array[
  'id', 'Receipt line.', 'goods_receipt_id', 'Receipt.', 'po_line_id', 'Order line.', 'quantity_received', 'Quantity received.']);

-- Vendor compliance on file ----------------------------------------------------------------------------------------------------------

create view api_external.vendor_insurance_certificates as
select ic.id, ic.org_id, o.name as org_name, c.organization_id as account_id, ic.insurer, ic.policy_identifier, ic.coverage_type,
  ic.coverage_limit_minor, ic.currency_code, ic.valid_from, ic.valid_to, (current_date between ic.valid_from and ic.valid_to) as is_current
from app.insurance_certificates ic
join app.vendors v on v.id = ic.vendor_id and v.deleted_at is null
join app.counterparties c on c.id = v.counterparty_id
join app.organizations o on o.id = ic.org_id
where ic.deleted_at is null
  and private.counterparty_area_open(null, v.counterparty_id, 'documents', array['Account Owner', 'Account Admin', 'Account Finance']::app.account_role[]);

call private.describe('api_external.vendor_insurance_certificates', 'Certificates of insurance each org keeps on file for the caller''s account, while an engagement with that org has the documents area open.', array[
  'id', 'Certificate.', 'org_id', 'Org.', 'org_name', 'Org name.', 'account_id', 'The caller''s account.', 'insurer', 'Carrier.',
  'policy_identifier', 'Policy number.', 'coverage_type', 'Coverage.', 'coverage_limit_minor', 'Limit in minor units.',
  'currency_code', 'Currency.', 'valid_from', 'First day.', 'valid_to', 'Last day.', 'is_current', 'True today.']);

create view api_external.vendor_prequalifications as
select pq.id, pq.org_id, o.name as org_name, c.organization_id as account_id, pq.scope_note as scope, pq.decision, pq.decided_at, pq.valid_to,
  (pq.decision = 'Approved' and (pq.valid_to is null or pq.valid_to >= current_date)) as is_current
from app.prequalifications pq
join app.vendors v on v.id = pq.vendor_id and v.deleted_at is null
join app.counterparties c on c.id = v.counterparty_id
join app.organizations o on o.id = pq.org_id
where pq.deleted_at is null
  and private.counterparty_area_open(null, v.counterparty_id, 'documents', array['Account Owner', 'Account Admin', 'Account Finance']::app.account_role[]);

call private.describe('api_external.vendor_prequalifications', 'Prequalifications of the caller''s account with each org it is engaged by: scope, decision and validity. Who decided never appears.', array[
  'id', 'Prequalification.', 'org_id', 'Org.', 'org_name', 'Org name.', 'account_id', 'The caller''s account.', 'scope', 'What it covers.',
  'decision', 'Approved or Rejected; NULL while pending.', 'decided_at', 'When decided.', 'valid_to', 'Last day an approval holds.',
  'is_current', 'True while an approval holds.']);

-- Retention, audit and privileges -------------------------------------------------------------------------------------------------------

call private.install_default_retention('app.po_acknowledgments');

revoke all on function private.counterparty_area_open(uuid, uuid, text, app.account_role[]) from public, anon;
grant execute on function private.counterparty_area_open(uuid, uuid, text, app.account_role[]) to authenticated, service_role;
revoke all on function app.acknowledge_purchase_order(uuid) from public, anon;
grant execute on function app.acknowledge_purchase_order(uuid) to authenticated, service_role;

revoke all on api_external.purchase_orders, api_external.po_lines, api_external.deliveries, api_external.goods_receipts,
  api_external.receipt_lines, api_external.vendor_insurance_certificates, api_external.vendor_prequalifications from public, anon;
grant select on api_external.purchase_orders, api_external.po_lines, api_external.deliveries, api_external.goods_receipts,
  api_external.receipt_lines, api_external.vendor_insurance_certificates, api_external.vendor_prequalifications to authenticated, service_role;
