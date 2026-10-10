-- 0331_procurement.sql
-- A03 Domain Data. Procurement (Section 7.4 Procurement, invariants 10 and 17, Sections 8.1 and 8.2):
-- RFQs with invitations, sealed responses and their lines, purchase orders and lines (the creator
-- cannot approve; spend authority applies), PO change orders, goods receipts and receipt lines,
-- three-way invoice matches (a receipt matches one invoice once; a mismatch is never approved without
-- a recorded resolution by someone else), catalog bindings with {URID}-{ORG}-{SEQ} item IDs, and
-- vendor products.

-- Enums and rules --------------------------------------------------------------------------------------

create type app.rfq_state as enum ('Proposed', 'Issued', 'Closed', 'Awarded', 'Canceled');
comment on type app.rfq_state is 'RFQ states: drafted, Issued to invited vendors, Closed to responses (responses unseal), Awarded, or Canceled.';

create type app.po_state as enum ('Proposed', 'Approved', 'Sent', 'Closed', 'Canceled');
comment on type app.po_state is 'Purchase order states: drafted (Proposed), Approved under spend authority, Sent to the vendor, Closed when fulfilled, or Canceled.';

create type app.po_change_order_state as enum ('Proposed', 'Approved', 'Rejected', 'Canceled');
comment on type app.po_change_order_state is 'Purchase order change order states.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('rfq', 'Proposed', 'Issued'),
  ('rfq', 'Proposed', 'Canceled'),
  ('rfq', 'Issued', 'Closed'),
  ('rfq', 'Issued', 'Canceled'),
  ('rfq', 'Closed', 'Awarded'),
  ('rfq', 'Closed', 'Canceled'),
  ('purchase_order', 'Proposed', 'Approved'),
  ('purchase_order', 'Proposed', 'Canceled'),
  ('purchase_order', 'Approved', 'Sent'),
  ('purchase_order', 'Approved', 'Canceled'),
  ('purchase_order', 'Sent', 'Closed'),
  ('purchase_order', 'Sent', 'Canceled'),
  ('po_change_order', 'Proposed', 'Approved'),
  ('po_change_order', 'Proposed', 'Rejected'),
  ('po_change_order', 'Proposed', 'Canceled');

insert into private.domain_event_types (code, subject, description) values
  ('rfq.issued', 'rfqs', 'An RFQ was issued to its invited vendors.'),
  ('rfq.awarded', 'rfqs', 'An RFQ was awarded.'),
  ('po.approved', 'purchase_orders', 'A purchase order was approved under spend authority.'),
  ('po.sent', 'purchase_orders', 'An approved purchase order was sent to the vendor.'),
  ('receipt.recorded', 'goods_receipts', 'Goods were received against a purchase order.'),
  ('invoice_match.recorded', 'invoice_matches', 'An invoice was matched to a purchase order and a goods receipt.');

-- RFQs ------------------------------------------------------------------------------------------------------

create table app.rfqs (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  rfq_number bigint not null default 0,
  title text not null,
  responses_due_at timestamptz,
  rfq_state app.rfq_state not null default 'Proposed',
  deleted_at timestamptz,
  constraint rfqs_title_length check (char_length(btrim(title)) between 1 and 200)
);

create unique index rfqs_project_number_key on app.rfqs (project_id, rfq_number);

call private.install_domain_table('app.rfqs', 'app.projects', 'project_id');
call private.describe('app.rfqs', 'Requests for quotation of a project. Responses stay sealed until the RFQ is Closed.', array[
  'project_id', 'Project buying.',
  'rfq_number', 'Number from the project''s display key sequence, issued on insert.',
  'title', 'What is being sourced.',
  'responses_due_at', 'Deadline for responses.',
  'rfq_state', 'RFQ state. Changes only through app.transition_rfq.'
]);

call private.install_lifecycle('app.rfqs', 'rfq_id', 'rfq_state', 'rfq', 'Proposed',
  $$rfq_id in (select r.id from app.rfqs r where r.project_id in (select private.project_ids_with('procurement.rfq.read')))$$);

create trigger t90_emit_rfq_issued after insert on app.rfq_state_transitions
  for each row when (new.to_state = 'Issued')
  execute function private.emit_subject_event('rfq.issued', 'rfqs', 'rfq_id', 'from_state', 'to_state');
create trigger t90_emit_rfq_awarded after insert on app.rfq_state_transitions
  for each row when (new.to_state = 'Awarded')
  execute function private.emit_subject_event('rfq.awarded', 'rfqs', 'rfq_id', 'from_state', 'to_state');

create or replace function private.number_from_project_sequence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_column text := tg_argv[0];
begin
  if tg_op = 'INSERT' then
    new := jsonb_populate_record(new, jsonb_build_object(v_column,
      private.next_sequence(new.org_id, 'project:' || new.project_id::text)));
  elsif (to_jsonb(new) ->> v_column) is distinct from (to_jsonb(old) ->> v_column) then
    perform private.refuse('display_number_immutable', format('%s never changes.', v_column));
  end if;
  return new;
end;
$$;

comment on function private.number_from_project_sequence() is 'Before insert or update trigger: issues the named number column from the project''s display key sequence and keeps it fixed. Argument: the number column.';
revoke all on function private.number_from_project_sequence() from public, anon, authenticated;

create trigger t35_rfq_number before insert or update on app.rfqs
  for each row execute function private.number_from_project_sequence('rfq_number');

create or replace function app.transition_rfq(p_rfq_id uuid, p_expected app.rfq_state, p_next app.rfq_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid := (select r.project_id from app.rfqs r where r.id = p_rfq_id and r.deleted_at is null);
  v_capability text := case p_next when 'Issued' then 'procurement.rfq.issue' when 'Closed' then 'procurement.bid.unseal'
                         when 'Awarded' then 'procurement.bid.award' else 'procurement.rfq.write' end;
begin
  perform private.require_person();
  if v_project is null or not private.can_on_project(v_project, v_capability) then
    raise exception using errcode = '42501', message = format('%s is required on the project', v_capability);
  end if;
  if p_next = 'Issued' and not exists (select 1 from app.rfq_invitations i where i.rfq_id = p_rfq_id and i.deleted_at is null) then
    perform private.refuse('rfq_no_invitations', 'Invite at least one vendor before issuing an RFQ.');
  end if;
  return private.transition_lifecycle('rfq', 'app.rfqs', 'rfq_state', 'app.rfq_state_transitions', 'rfq_id',
    p_rfq_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_rfq(uuid, app.rfq_state, app.rfq_state, text) is 'Moves an RFQ with compare-and-set: issuing needs procurement.rfq.issue and an invitation, closing (which unseals responses) procurement.bid.unseal, awarding procurement.bid.award, otherwise procurement.rfq.write.';

create table app.rfq_invitations (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  rfq_id uuid not null references app.rfqs (id),
  vendor_id uuid not null references app.vendors (id),
  deleted_at timestamptz
);

create index rfq_invitations_rfq_id_idx on app.rfq_invitations (rfq_id);
create index rfq_invitations_vendor_id_idx on app.rfq_invitations (vendor_id);
create unique index rfq_invitations_pair_key on app.rfq_invitations (rfq_id, vendor_id) where deleted_at is null;

call private.install_domain_table('app.rfq_invitations', 'app.rfqs', 'rfq_id', array['app.vendors', 'vendor_id']);
call private.describe('app.rfq_invitations', 'Vendors invited to respond to an RFQ. Only invited vendors may respond.', array[
  'rfq_id', 'RFQ.',
  'vendor_id', 'Invited vendor of the same org.'
]);

create table app.rfq_responses (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  rfq_id uuid not null references app.rfqs (id),
  vendor_id uuid not null references app.vendors (id),
  submitted_at timestamptz not null default now(),
  valid_until date,
  deleted_at timestamptz
);

create index rfq_responses_rfq_id_idx on app.rfq_responses (rfq_id);
create index rfq_responses_vendor_id_idx on app.rfq_responses (vendor_id);
create unique index rfq_responses_one_per_vendor on app.rfq_responses (rfq_id, vendor_id) where deleted_at is null;

call private.install_domain_table('app.rfq_responses', 'app.rfqs', 'rfq_id', array['app.vendors', 'vendor_id']);
call private.describe('app.rfq_responses', 'A vendor''s response to an RFQ, one per invited vendor, accepted only while the RFQ is Issued and readable only once it is Closed (sealed bids).', array[
  'rfq_id', 'RFQ responded to.',
  'vendor_id', 'Responding vendor; must have been invited.',
  'submitted_at', 'When the response was submitted.',
  'valid_until', 'Last day the quoted prices hold.'
]);

create table app.rfq_response_lines (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  rfq_response_id uuid not null references app.rfq_responses (id),
  description text not null,
  element_id text references xpms.elements (element_id),
  quantity numeric not null default 1,
  unit_price_minor bigint,
  currency_code char(3) not null references private.currencies (currency_code),
  deleted_at timestamptz,
  constraint rfq_response_lines_description_length check (char_length(btrim(description)) between 1 and 500),
  constraint rfq_response_lines_price_nonnegative check (unit_price_minor is null or unit_price_minor >= 0)
);

create index rfq_response_lines_response_idx on app.rfq_response_lines (rfq_response_id);
create index rfq_response_lines_element_id_idx on app.rfq_response_lines (element_id);
create index rfq_response_lines_currency_code_idx on app.rfq_response_lines (currency_code);

call private.install_domain_table('app.rfq_response_lines', 'app.rfq_responses', 'rfq_response_id');
call private.describe('app.rfq_response_lines', 'Quoted lines of an RFQ response. A NULL price is a line the vendor did not quote.', array[
  'rfq_response_id', 'Response the line belongs to.',
  'description', 'What is quoted.',
  'element_id', 'Catalog element quoted, when one applies.',
  'quantity', 'Quantity quoted.',
  'unit_price_minor', 'Quoted unit price in minor units; NULL when not quoted.',
  'currency_code', 'ISO 4217 currency of the quote.'
]);

create or replace function private.guard_rfq_response()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if (select r.rfq_state from app.rfqs r where r.id = new.rfq_id) <> 'Issued' then
      perform private.refuse('rfq_not_open', 'Responses are accepted only while the RFQ is Issued.');
    end if;
    if not exists (select 1 from app.rfq_invitations i where i.rfq_id = new.rfq_id and i.vendor_id = new.vendor_id and i.deleted_at is null) then
      perform private.refuse('rfq_not_invited', 'Only an invited vendor responds to an RFQ.');
    end if;
    new.submitted_at := now();
  elsif new.rfq_id <> old.rfq_id or new.vendor_id <> old.vendor_id or new.submitted_at <> old.submitted_at then
    perform private.refuse('rfq_response_immutable', 'A response keeps its RFQ, vendor and submission time.');
  end if;
  return new;
end;
$$;

comment on function private.guard_rfq_response() is 'RFQ responses: only from invited vendors while the RFQ is Issued, stamped with the database time.';

create trigger t40_guard_rfq_response before insert or update on app.rfq_responses
  for each row execute function private.guard_rfq_response();

-- Purchase orders --------------------------------------------------------------------------------------------------

create table app.purchase_orders (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  po_number bigint not null default 0,
  vendor_id uuid not null references app.vendors (id),
  rfq_response_id uuid references app.rfq_responses (id),
  currency_code char(3) not null references private.currencies (currency_code),
  po_state app.po_state not null default 'Proposed',
  deleted_at timestamptz
);

create unique index purchase_orders_project_number_key on app.purchase_orders (project_id, po_number);
create index purchase_orders_vendor_id_idx on app.purchase_orders (vendor_id);
create index purchase_orders_rfq_response_id_idx on app.purchase_orders (rfq_response_id);
create index purchase_orders_currency_code_idx on app.purchase_orders (currency_code);

call private.install_domain_table('app.purchase_orders', 'app.projects', 'project_id',
  array['app.vendors', 'vendor_id', 'app.rfq_responses', 'rfq_response_id']);
call private.describe('app.purchase_orders', 'Purchase orders of a project. The creator cannot approve (sod_po_creator), approval runs spend authority, and a closed production refuses new ones (invariant 10). Totals are derived (app.purchase_order_totals).', array[
  'project_id', 'Project buying.',
  'po_number', 'Number from the project''s display key sequence, issued on insert.',
  'vendor_id', 'Vendor supplying; never a Blocked or Canceled vendor.',
  'rfq_response_id', 'Awarded RFQ response the order comes from, when there is one.',
  'currency_code', 'ISO 4217 currency of the order.',
  'po_state', 'Purchase order state. Changes only through the purchase order RPCs.'
]);

call private.install_lifecycle('app.purchase_orders', 'purchase_order_id', 'po_state', 'purchase_order', 'Proposed',
  $$purchase_order_id in (select po.id from app.purchase_orders po where po.project_id in (select private.project_ids_with('procurement.po.read')))$$);

create trigger t35_po_number before insert or update on app.purchase_orders
  for each row execute function private.number_from_project_sequence('po_number');
create trigger t90_emit_po_approved after insert on app.purchase_order_state_transitions
  for each row when (new.to_state = 'Approved')
  execute function private.emit_subject_event('po.approved', 'purchase_orders', 'purchase_order_id', 'from_state', 'to_state');
create trigger t90_emit_po_sent after insert on app.purchase_order_state_transitions
  for each row when (new.to_state = 'Sent')
  execute function private.emit_subject_event('po.sent', 'purchase_orders', 'purchase_order_id', 'from_state', 'to_state');

create table app.po_lines (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  purchase_order_id uuid not null references app.purchase_orders (id),
  line_number integer not null,
  description text not null,
  budget_line_id uuid references app.budget_lines (id),
  element_id text references xpms.elements (element_id),
  quantity numeric not null,
  unit_basis text references xpms.dim_unit_alias (alias),
  unit_price_minor bigint,
  deleted_at timestamptz,
  constraint po_lines_line_number_positive check (line_number > 0),
  constraint po_lines_description_length check (char_length(btrim(description)) between 1 and 500),
  constraint po_lines_quantity_positive check (quantity > 0),
  constraint po_lines_price_nonnegative check (unit_price_minor is null or unit_price_minor >= 0)
);

create unique index po_lines_order_number_key on app.po_lines (purchase_order_id, line_number) where deleted_at is null;
create index po_lines_budget_line_id_idx on app.po_lines (budget_line_id);
create index po_lines_element_id_idx on app.po_lines (element_id);
create index po_lines_unit_basis_idx on app.po_lines (unit_basis);

call private.install_domain_table('app.po_lines', 'app.purchase_orders', 'purchase_order_id', array['app.budget_lines', 'budget_line_id']);
call private.describe('app.po_lines', 'Lines of a purchase order. A NULL price is unpriced and blocks approval. Lines change only while the order is Proposed.', array[
  'purchase_order_id', 'Purchase order the line belongs to.',
  'line_number', 'Order of the line within the purchase order.',
  'description', 'What is ordered.',
  'budget_line_id', 'Budget line of the same project the commitment draws on.',
  'element_id', 'Catalog element ordered, when one applies.',
  'quantity', 'Quantity ordered.',
  'unit_basis', 'Unit of the quantity.',
  'unit_price_minor', 'Unit price in minor units of the order currency; NULL is unpriced.'
]);

create or replace function private.guard_purchase_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.assert_production_open(new.project_id);
    if (select v.vendor_state from app.vendors v where v.id = new.vendor_id) in ('Blocked', 'Canceled') then
      perform private.refuse('vendor_blocked', 'A Blocked or Canceled vendor takes no new purchase orders.');
    end if;
  elsif new.vendor_id <> old.vendor_id or new.project_id <> old.project_id or new.currency_code <> old.currency_code then
    perform private.refuse('purchase_order_immutable', 'A purchase order keeps its project, vendor and currency.');
  end if;
  return new;
end;
$$;

comment on function private.guard_purchase_order() is 'Purchase orders: no new order on a closed production (invariant 10) or to a Blocked or Canceled vendor; project, vendor and currency fixed.';

create trigger t40_guard_purchase_order before insert or update on app.purchase_orders
  for each row execute function private.guard_purchase_order();

create or replace function private.guard_po_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order app.purchase_orders;
begin
  select * into v_order from app.purchase_orders po where po.id = new.purchase_order_id;
  if v_order.po_state <> 'Proposed' then
    perform private.refuse('purchase_order_locked', 'Purchase order lines change only while the order is Proposed; use a PO change order.');
  end if;
  if tg_op = 'UPDATE' and new.purchase_order_id <> old.purchase_order_id then
    perform private.refuse('po_line_immutable', 'A line stays on its purchase order.');
  end if;
  if new.budget_line_id is not null and (
    select b.project_id from app.budgets b join app.budget_lines bl on bl.budget_id = b.id where bl.id = new.budget_line_id
  ) <> v_order.project_id then
    perform private.refuse('po_line_budget', 'A purchase order line draws on a budget line of the order''s project.');
  end if;
  return new;
end;
$$;

comment on function private.guard_po_line() is 'Purchase order lines: editable only while Proposed, drawing on a budget line of the same project.';

create trigger t40_guard_po_line before insert or update on app.po_lines
  for each row execute function private.guard_po_line();

create or replace function private.purchase_order_total(p_purchase_order_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select case when count(*) = 0 or count(*) filter (where l.unit_price_minor is null) > 0 then null
              else sum(private.extended_minor(l.quantity, l.unit_price_minor))::bigint end
  from app.po_lines l where l.purchase_order_id = p_purchase_order_id and l.deleted_at is null;
$$;

comment on function private.purchase_order_total(uuid) is 'Total of a purchase order''s lines in minor units; NULL when it has no lines or any line is unpriced.';
revoke all on function private.purchase_order_total(uuid) from public, anon, authenticated;

create or replace function app.approve_purchase_order(p_purchase_order_id uuid, p_reason text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_order app.purchase_orders;
  v_total bigint;
begin
  select * into v_order from app.purchase_orders po where po.id = p_purchase_order_id and po.deleted_at is null for update;
  if v_order.id is null or not private.can_on_project(v_order.project_id, 'finance.po.approve') then
    raise exception using errcode = '42501', message = 'finance.po.approve is required on the project';
  end if;
  perform private.assert_separation('sod_po_creator', v_person, v_order.created_by);
  if v_order.po_state <> 'Proposed' then
    perform private.refuse('purchase_order_state_conflict', 'Only a Proposed purchase order can be approved.');
  end if;
  v_total := private.purchase_order_total(p_purchase_order_id);
  if v_total is null then
    perform private.refuse('purchase_order_unpriced', 'Every line of a purchase order needs a price before it is approved.');
  end if;
  if not private.approve_under_spend_authority(v_order.org_id, 'Purchase Order', v_order.id, v_total, v_order.currency_code, null, null) then
    return false;
  end if;
  perform private.transition_lifecycle('purchase_order', 'app.purchase_orders', 'po_state', 'app.purchase_order_state_transitions',
    'purchase_order_id', p_purchase_order_id, 'Proposed', 'Approved', p_reason);
  return true;
end;
$$;

comment on function app.approve_purchase_order(uuid, text) is 'Approves a fully priced purchase order: finance.po.approve on the project, never by its creator (sod_po_creator), under spend authority (two approvers above the dual threshold). Emits po.approved. Returns true once fully approved.';

create or replace function app.transition_purchase_order(p_purchase_order_id uuid, p_expected app.po_state, p_next app.po_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid := (select po.project_id from app.purchase_orders po where po.id = p_purchase_order_id and po.deleted_at is null);
  v_capability text := case when p_next = 'Sent' then 'procurement.po.send' else 'procurement.po.write' end;
begin
  if p_next = 'Approved' then
    perform private.refuse('purchase_order_use_rpc', 'Approve a purchase order through app.approve_purchase_order.');
  end if;
  perform private.require_person();
  if v_project is null or not private.can_on_project(v_project, v_capability) then
    raise exception using errcode = '42501', message = format('%s is required on the project', v_capability);
  end if;
  return private.transition_lifecycle('purchase_order', 'app.purchase_orders', 'po_state', 'app.purchase_order_state_transitions',
    'purchase_order_id', p_purchase_order_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_purchase_order(uuid, app.po_state, app.po_state, text) is 'Sends (procurement.po.send), closes or cancels (procurement.po.write) a purchase order with compare-and-set.';

-- PO change orders -----------------------------------------------------------------------------------------------------

create table app.po_change_orders (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  purchase_order_id uuid not null references app.purchase_orders (id),
  description text not null,
  amount_delta_minor bigint,
  po_change_order_state app.po_change_order_state not null default 'Proposed',
  deleted_at timestamptz,
  constraint po_change_orders_description_length check (char_length(btrim(description)) between 1 and 500)
);

create index po_change_orders_purchase_order_id_idx on app.po_change_orders (purchase_order_id);

call private.install_domain_table('app.po_change_orders', 'app.purchase_orders', 'purchase_order_id');
call private.describe('app.po_change_orders', 'Changes to an approved purchase order. The delta is NULL while unpriced and cannot be approved until priced; the requester cannot approve.', array[
  'purchase_order_id', 'Purchase order changed.',
  'description', 'What changes.',
  'amount_delta_minor', 'Change in the order total in minor units, negative for a reduction; NULL while unpriced.',
  'po_change_order_state', 'State. Changes only through app.decide_po_change_order.'
]);

call private.install_lifecycle('app.po_change_orders', 'po_change_order_id', 'po_change_order_state', 'po_change_order', 'Proposed',
  $$po_change_order_id in (select c.id from app.po_change_orders c join app.purchase_orders po on po.id = c.purchase_order_id
    where po.project_id in (select private.project_ids_with('procurement.po.read')))$$);

create or replace function private.guard_po_change_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order app.purchase_orders;
begin
  select * into v_order from app.purchase_orders po where po.id = new.purchase_order_id;
  if tg_op = 'INSERT' then
    perform private.assert_production_open(v_order.project_id);
    if v_order.po_state not in ('Approved', 'Sent') then
      perform private.refuse('po_change_order_target', 'Change orders apply to approved or sent purchase orders.');
    end if;
  elsif new.purchase_order_id <> old.purchase_order_id
     or (old.po_change_order_state <> 'Proposed' and new.amount_delta_minor is distinct from old.amount_delta_minor) then
    perform private.refuse('po_change_order_locked', 'A decided PO change order never changes.');
  end if;
  return new;
end;
$$;

comment on function private.guard_po_change_order() is 'PO change orders: only on approved or sent orders of an open production (invariant 10), frozen once decided.';

create trigger t40_guard_po_change_order before insert or update on app.po_change_orders
  for each row execute function private.guard_po_change_order();

create or replace function app.decide_po_change_order(p_po_change_order_id uuid, p_decision app.approval_decision, p_reason text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_change app.po_change_orders;
  v_order app.purchase_orders;
begin
  select * into v_change from app.po_change_orders c where c.id = p_po_change_order_id and c.deleted_at is null for update;
  select * into v_order from app.purchase_orders po where po.id = v_change.purchase_order_id;
  if v_change.id is null or not private.can_on_project(v_order.project_id, 'finance.po.approve') then
    raise exception using errcode = '42501', message = 'finance.po.approve is required on the project';
  end if;
  perform private.assert_separation('sod_po_creator', v_person, v_change.created_by);
  if p_decision = 'Approved' then
    if v_change.amount_delta_minor is null then
      perform private.refuse('po_change_order_unpriced', 'An unpriced PO change order cannot be approved.');
    end if;
    if not private.approve_under_spend_authority(v_change.org_id, 'Purchase Order', v_change.id, abs(v_change.amount_delta_minor),
        v_order.currency_code, null, null) then
      return false;
    end if;
  end if;
  perform private.transition_lifecycle('po_change_order', 'app.po_change_orders', 'po_change_order_state',
    'app.po_change_order_state_transitions', 'po_change_order_id', p_po_change_order_id, 'Proposed', p_decision::text, p_reason);
  return true;
end;
$$;

comment on function app.decide_po_change_order(uuid, app.approval_decision, text) is 'Approves or rejects a PO change order: finance.po.approve, never by its requester, priced and within spend authority to approve. Returns true once decided.';

-- Goods receipts --------------------------------------------------------------------------------------------------------

create table app.goods_receipts (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  purchase_order_id uuid not null references app.purchase_orders (id),
  received_at timestamptz not null default now(),
  received_by uuid references app.people (id),
  note text,
  deleted_at timestamptz
);

create index goods_receipts_purchase_order_id_idx on app.goods_receipts (purchase_order_id);
create index goods_receipts_received_by_idx on app.goods_receipts (received_by);

call private.install_domain_table('app.goods_receipts', 'app.purchase_orders', 'purchase_order_id');
call private.describe('app.goods_receipts', 'Goods received against an approved or sent purchase order.', array[
  'purchase_order_id', 'Purchase order received against.',
  'received_at', 'When the goods arrived.',
  'received_by', 'Person who received the goods, from the session.',
  'note', 'Condition or exceptions noted at receipt.'
]);

create table app.receipt_lines (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  goods_receipt_id uuid not null references app.goods_receipts (id),
  po_line_id uuid not null references app.po_lines (id),
  quantity_received numeric not null,
  deleted_at timestamptz,
  constraint receipt_lines_quantity_positive check (quantity_received > 0)
);

create index receipt_lines_goods_receipt_id_idx on app.receipt_lines (goods_receipt_id);
create index receipt_lines_po_line_id_idx on app.receipt_lines (po_line_id);

call private.install_domain_table('app.receipt_lines', 'app.goods_receipts', 'goods_receipt_id', array['app.po_lines', 'po_line_id']);
call private.describe('app.receipt_lines', 'Quantities received per purchase order line. Cumulative receipts never exceed the quantity ordered.', array[
  'goods_receipt_id', 'Receipt the line belongs to.',
  'po_line_id', 'Purchase order line received, on the receipt''s order.',
  'quantity_received', 'Quantity received.'
]);

create or replace function private.guard_goods_receipt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if (select po.po_state from app.purchase_orders po where po.id = new.purchase_order_id) not in ('Approved', 'Sent') then
      perform private.refuse('receipt_order_state', 'Goods are received only against an approved or sent purchase order.');
    end if;
    new.received_by := coalesce(private.current_person_id(), new.received_by);
  elsif new.purchase_order_id <> old.purchase_order_id or new.received_by is distinct from old.received_by then
    perform private.refuse('receipt_immutable', 'A receipt keeps its purchase order and receiver.');
  end if;
  return new;
end;
$$;

comment on function private.guard_goods_receipt() is 'Goods receipts: only against approved or sent orders; receiver from the session.';

create trigger t40_guard_goods_receipt before insert or update on app.goods_receipts
  for each row execute function private.guard_goods_receipt();
create trigger t90_emit_receipt after insert on app.goods_receipts
  for each row execute function private.emit_subject_event('receipt.recorded', 'goods_receipts', 'id', 'purchase_order_id', 'received_at');

create or replace function private.guard_receipt_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line app.po_lines;
  v_received numeric;
begin
  select * into v_line from app.po_lines l where l.id = new.po_line_id for update;
  if v_line.purchase_order_id <> (select r.purchase_order_id from app.goods_receipts r where r.id = new.goods_receipt_id) then
    perform private.refuse('receipt_line_order', 'A receipt line receives a line of the receipt''s purchase order.');
  end if;
  if tg_op = 'UPDATE' and (new.goods_receipt_id <> old.goods_receipt_id or new.po_line_id <> old.po_line_id) then
    perform private.refuse('receipt_line_immutable', 'A receipt line keeps its receipt and order line.');
  end if;
  select coalesce(sum(rl.quantity_received), 0) into v_received from app.receipt_lines rl
  where rl.po_line_id = new.po_line_id and rl.deleted_at is null and rl.id <> new.id;
  if new.deleted_at is null and v_received + new.quantity_received > v_line.quantity then
    perform private.refuse('receipt_exceeds_order', 'Receipts never exceed the quantity ordered.');
  end if;
  return new;
end;
$$;

comment on function private.guard_receipt_line() is 'Receipt lines receive lines of the same order and never beyond the quantity ordered.';

create trigger t40_guard_receipt_line before insert or update on app.receipt_lines
  for each row execute function private.guard_receipt_line();

-- Three-way match (invariant 17) ----------------------------------------------------------------------------------------

create table app.invoice_matches (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  invoice_id uuid not null references app.invoices (id),
  purchase_order_id uuid not null references app.purchase_orders (id),
  goods_receipt_id uuid not null references app.goods_receipts (id),
  resolution_note text,
  resolved_by uuid references app.people (id),
  resolved_at timestamptz,
  deleted_at timestamptz,
  constraint invoice_matches_resolution_complete check (
    (resolution_note is null) = (resolved_by is null) and (resolved_by is null) = (resolved_at is null))
);

create index invoice_matches_invoice_id_idx on app.invoice_matches (invoice_id);
create index invoice_matches_purchase_order_id_idx on app.invoice_matches (purchase_order_id);
create unique index invoice_matches_receipt_once on app.invoice_matches (goods_receipt_id) where deleted_at is null;
create index invoice_matches_resolved_by_idx on app.invoice_matches (resolved_by);

call private.install_domain_table('app.invoice_matches', 'app.invoices', 'invoice_id',
  array['app.purchase_orders', 'purchase_order_id', 'app.goods_receipts', 'goods_receipt_id']);
call private.describe('app.invoice_matches', 'Three-way matches of a payable invoice to a purchase order and a goods receipt (invariant 17). A receipt matches one invoice once; the variance is derived in app.invoice_match_results, and a payable invoice with an unresolved mismatch is never approved.', array[
  'invoice_id', 'Payable invoice matched.',
  'purchase_order_id', 'Purchase order the invoice bills.',
  'goods_receipt_id', 'Receipt of that order the invoice bills. A receipt is matched once.',
  'resolution_note', 'Why a mismatch is accepted, recorded by someone other than the matcher.',
  'resolved_by', 'Person who accepted the mismatch.',
  'resolved_at', 'When the mismatch was accepted.'
]);

create or replace function private.guard_invoice_match()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice app.invoices;
  v_order app.purchase_orders;
begin
  if tg_op = 'INSERT' then
    select * into v_invoice from app.invoices i where i.id = new.invoice_id;
    select * into v_order from app.purchase_orders po where po.id = new.purchase_order_id;
    if v_invoice.direction <> 'Payable' then
      perform private.refuse('invoice_match_direction', 'Only payable invoices are matched to purchase orders.');
    end if;
    if (select r.purchase_order_id from app.goods_receipts r where r.id = new.goods_receipt_id) <> new.purchase_order_id then
      perform private.refuse('invoice_match_receipt_order', 'The receipt belongs to the matched purchase order.');
    end if;
    if v_order.project_id <> v_invoice.project_id then
      perform private.refuse('invoice_match_project', 'The invoice and purchase order belong to the same project.');
    end if;
    new.resolution_note := null;
    new.resolved_by := null;
    new.resolved_at := null;
    return new;
  end if;
  if new.invoice_id <> old.invoice_id or new.purchase_order_id <> old.purchase_order_id or new.goods_receipt_id <> old.goods_receipt_id then
    perform private.refuse('invoice_match_immutable', 'A match keeps its invoice, order and receipt.');
  end if;
  if new.resolution_note is distinct from old.resolution_note then
    if old.resolution_note is not null then
      perform private.refuse('invoice_match_resolved', 'A mismatch resolution is final.');
    end if;
    perform private.assert_separation('sod_approval_requester', private.current_person_id(), old.created_by);
    new.resolved_by := private.current_person_id();
    new.resolved_at := now();
  end if;
  return new;
end;
$$;

comment on function private.guard_invoice_match() is 'Invoice matches: payable invoice, receipt of the matched order, same project; a mismatch is accepted only by someone other than the matcher, once.';

create trigger t40_guard_invoice_match before insert or update on app.invoice_matches
  for each row execute function private.guard_invoice_match();
create trigger t90_emit_invoice_match after insert on app.invoice_matches
  for each row execute function private.emit_subject_event('invoice_match.recorded', 'invoice_matches', 'id', 'invoice_id', 'purchase_order_id', 'goods_receipt_id');

create or replace function private.invoice_match_variance(p_match_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select private.invoice_total(m.invoice_id) - (
    select sum(private.extended_minor(rl.quantity_received, pl.unit_price_minor))::bigint
    from app.receipt_lines rl join app.po_lines pl on pl.id = rl.po_line_id
    where rl.goods_receipt_id = m.goods_receipt_id and rl.deleted_at is null)
  from app.invoice_matches m where m.id = p_match_id;
$$;

comment on function private.invoice_match_variance(uuid) is 'Invoice total minus the value received on the matched receipt at purchase order prices; NULL when either side is unpriced.';
revoke all on function private.invoice_match_variance(uuid) from public, anon, authenticated;

create or replace function private.invoice_match_is_clean(p_match_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.invoice_match_variance(m.id) = 0, false)
    and i.counterparty_id = (select v.counterparty_id from app.vendors v where v.id = po.vendor_id)
    and i.currency_code = po.currency_code
  from app.invoice_matches m
  join app.invoices i on i.id = m.invoice_id
  join app.purchase_orders po on po.id = m.purchase_order_id
  where m.id = p_match_id;
$$;

comment on function private.invoice_match_is_clean(uuid) is 'True when a match agrees on amount, vendor and currency. An unpriced side is never clean.';
revoke all on function private.invoice_match_is_clean(uuid) from public, anon, authenticated;

create view app.invoice_match_results with (security_invoker = true) as
select m.id as invoice_match_id, m.invoice_id, m.purchase_order_id, m.goods_receipt_id,
  private.invoice_match_variance(m.id) as variance_minor,
  private.invoice_match_is_clean(m.id) as is_matched,
  m.resolved_at is not null as is_resolved
from app.invoice_matches m
where m.deleted_at is null;

call private.describe('app.invoice_match_results', 'Three-way match results, derived: variance between the invoice and the value received at order prices, whether vendor, currency and amount agree, and whether a mismatch was accepted.', array[
  'invoice_match_id', 'Match.',
  'invoice_id', 'Invoice.',
  'purchase_order_id', 'Purchase order.',
  'goods_receipt_id', 'Receipt.',
  'variance_minor', 'Invoice total minus value received in minor units; NULL when either side is unpriced.',
  'is_matched', 'True when amount, vendor and currency agree.',
  'is_resolved', 'True when a mismatch was accepted with a resolution.'
]);
revoke all on app.invoice_match_results from public, anon;
grant select on app.invoice_match_results to authenticated, service_role;

-- Payable invoice approval now refuses unresolved mismatches (invariant 17) ---------------------------------------------------

create or replace function app.approve_invoice(p_invoice_id uuid, p_reason text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_invoice app.invoices;
  v_total bigint;
begin
  select * into v_invoice from app.invoices i where i.id = p_invoice_id and i.deleted_at is null for update;
  if v_invoice.id is null or not private.can_on_project(v_invoice.project_id, 'finance.invoice.approve') then
    raise exception using errcode = '42501', message = 'finance.invoice.approve is required on the project';
  end if;
  if v_invoice.direction <> 'Payable' then
    perform private.refuse('invoice_direction', 'Only a payable invoice is approved for payment.');
  end if;
  perform private.assert_separation('sod_approval_requester', private.require_person(), v_invoice.created_by);
  v_total := private.invoice_total(p_invoice_id);
  if v_total is null then
    perform private.refuse('invoice_unpriced', 'Every line of an invoice needs a price before it is approved.');
  end if;
  if exists (select 1 from app.invoice_matches m where m.invoice_id = p_invoice_id and m.deleted_at is null
             and not private.invoice_match_is_clean(m.id) and m.resolved_at is null) then
    perform private.refuse('invoice_match_mismatch', 'The invoice does not match its purchase order and receipt; resolve the mismatch before approving.');
  end if;
  if v_invoice.invoice_state not in ('Proposed', 'Disputed') then
    perform private.refuse('invoice_state_conflict', 'Only a Proposed or Disputed payable invoice can be approved.');
  end if;
  if not private.approve_under_spend_authority(v_invoice.org_id, 'Invoice Approval', v_invoice.id, v_total, v_invoice.currency_code, null, null) then
    return false;
  end if;
  perform private.transition_lifecycle('invoice', 'app.invoices', 'invoice_state', 'app.invoice_state_transitions',
    'invoice_id', p_invoice_id, v_invoice.invoice_state::text, 'Approved', p_reason);
  return true;
end;
$$;

comment on function app.approve_invoice(uuid, text) is 'Approves a fully priced payable invoice for payment: finance.invoice.approve on the project, never by its recorder, never with an unresolved three-way mismatch (invariant 17), under spend authority. Approval is always an explicit act; a clean match never approves by itself. Returns true once fully approved.';

-- Catalog bindings and vendor products ---------------------------------------------------------------------------------------------

create table app.catalog_bindings (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  item_id text not null default '',
  element_id text not null references xpms.elements (element_id),
  name text not null,
  unit_basis text references xpms.dim_unit_alias (alias),
  default_unit_price_minor bigint,
  currency_code char(3) references private.currencies (currency_code),
  deleted_at timestamptz,
  constraint catalog_bindings_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint catalog_bindings_price_currency check (default_unit_price_minor is null or currency_code is not null)
);

create unique index catalog_bindings_item_id_key on app.catalog_bindings (org_id, item_id);
create index catalog_bindings_element_id_idx on app.catalog_bindings (element_id);
create index catalog_bindings_unit_basis_idx on app.catalog_bindings (unit_basis);
create index catalog_bindings_currency_code_idx on app.catalog_bindings (currency_code);

call private.install_domain_table('app.catalog_bindings');
call private.describe('app.catalog_bindings', 'Tenant catalog items bound to canon elements (Section 7.4). Each item gets an item ID {URID}-{ORG}-{SEQ} issued by next_sequence on insert.', array[
  'item_id', 'Item ID {URID}-{ORG}-{SEQ}: the element''s URID, the org code and a sequence per org and URID. Issued by the database, never changed.',
  'element_id', 'Canon element the item is an instance of.',
  'name', 'Name the org uses for the item.',
  'unit_basis', 'Unit the item is bought in.',
  'default_unit_price_minor', 'Default price in minor units; NULL is unpriced.',
  'currency_code', 'ISO 4217 currency of the default price.'
]);

create or replace function private.issue_item_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_urid text := (select e.urid from xpms.elements e where e.element_id = new.element_id);
  v_org_code text := (select upper(left(regexp_replace(o.slug, '[^a-z0-9]', '', 'g'), 6)) from app.organizations o where o.id = new.org_id);
  v_seq bigint;
begin
  if tg_op = 'INSERT' then
    v_seq := private.next_sequence(new.org_id, 'item:' || v_urid);
    new.item_id := v_urid || '-' || v_org_code || '-' || lpad(v_seq::text, 3, '0');
  elsif new.item_id <> old.item_id or new.element_id <> old.element_id then
    perform private.refuse('item_id_immutable', 'A catalog item keeps its item ID and element.');
  end if;
  return new;
end;
$$;

comment on function private.issue_item_id() is 'Issues {URID}-{ORG}-{SEQ} item IDs (Section 3.6) from next_sequence and keeps them fixed.';
revoke all on function private.issue_item_id() from public, anon, authenticated;

create trigger t35_issue_item_id before insert or update on app.catalog_bindings
  for each row execute function private.issue_item_id();

create table app.vendor_products (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  vendor_id uuid not null references app.vendors (id),
  catalog_binding_id uuid references app.catalog_bindings (id),
  element_id text references xpms.elements (element_id),
  vendor_sku text not null,
  unit_price_minor bigint,
  currency_code char(3) references private.currencies (currency_code),
  lead_time_days integer,
  deleted_at timestamptz,
  constraint vendor_products_price_currency check (unit_price_minor is null or currency_code is not null),
  constraint vendor_products_lead_time check (lead_time_days is null or lead_time_days >= 0)
);

create index vendor_products_vendor_id_idx on app.vendor_products (vendor_id);
create index vendor_products_catalog_binding_id_idx on app.vendor_products (catalog_binding_id);
create index vendor_products_element_id_idx on app.vendor_products (element_id);
create index vendor_products_currency_code_idx on app.vendor_products (currency_code);
create unique index vendor_products_vendor_sku_key on app.vendor_products (vendor_id, vendor_sku) where deleted_at is null;

call private.install_domain_table('app.vendor_products', 'app.vendors', 'vendor_id', array['app.catalog_bindings', 'catalog_binding_id']);
call private.describe('app.vendor_products', 'What a vendor sells, bound to a catalog item or canon element, with the vendor''s SKU and price.', array[
  'vendor_id', 'Vendor selling.',
  'catalog_binding_id', 'Catalog item of the same org the product fulfills.',
  'element_id', 'Canon element the product is, when bound directly.',
  'vendor_sku', 'The vendor''s product identifier (recorded, never minted).',
  'unit_price_minor', 'Vendor price in minor units; NULL is unpriced.',
  'currency_code', 'ISO 4217 currency of the price.',
  'lead_time_days', 'Days from order to delivery.'
]);

-- Totals -------------------------------------------------------------------------------------------------------------------------

create view app.purchase_order_totals with (security_invoker = true) as
select po.id as purchase_order_id, po.project_id, po.currency_code,
  count(l.id) filter (where l.unit_price_minor is null) as unpriced_count,
  case when count(l.id) = 0 or count(l.id) filter (where l.unit_price_minor is null) > 0 then null
       else sum(private.extended_minor(l.quantity, l.unit_price_minor))::bigint end as lines_total_minor,
  (select sum(c.amount_delta_minor) from app.po_change_orders c
   where c.purchase_order_id = po.id and c.po_change_order_state = 'Approved' and c.deleted_at is null)::bigint as approved_changes_minor
from app.purchase_orders po
left join app.po_lines l on l.purchase_order_id = po.id and l.deleted_at is null
where po.deleted_at is null
group by po.id, po.project_id, po.currency_code;

call private.describe('app.purchase_order_totals', 'Purchase order totals, NULL-aware, with approved change order deltas beside them.', array[
  'purchase_order_id', 'Purchase order.',
  'project_id', 'Project.',
  'currency_code', 'Currency.',
  'unpriced_count', 'Lines whose unit price is NULL.',
  'lines_total_minor', 'Sum of the lines; NULL while any line is unpriced.',
  'approved_changes_minor', 'Sum of approved change order deltas; NULL when there are none.'
]);
revoke all on app.purchase_order_totals from public, anon;
grant select on app.purchase_order_totals to authenticated, service_role;

-- Policies -------------------------------------------------------------------------------------------------------------------------

call private.install_policies('app.rfqs',
  $$project_id in (select private.project_ids_with('procurement.rfq.read'))$$,
  $$project_id in (select private.project_ids_with('procurement.rfq.write'))$$);
call private.install_policies('app.rfq_invitations',
  $$rfq_id in (select r.id from app.rfqs r where r.project_id in (select private.project_ids_with('procurement.rfq.read')))$$,
  $$rfq_id in (select r.id from app.rfqs r where r.project_id in (select private.project_ids_with('procurement.rfq.write')))$$);
call private.install_policies('app.rfq_responses',
  $$rfq_id in (select r.id from app.rfqs r where r.rfq_state in ('Closed', 'Awarded')
     and r.project_id in (select private.project_ids_with('procurement.bid.read')))$$,
  $$rfq_id in (select r.id from app.rfqs r where r.project_id in (select private.project_ids_with('procurement.rfq.write')))$$);
call private.install_policies('app.rfq_response_lines',
  $$rfq_response_id in (select s.id from app.rfq_responses s join app.rfqs r on r.id = s.rfq_id
     where r.rfq_state in ('Closed', 'Awarded') and r.project_id in (select private.project_ids_with('procurement.bid.read')))$$,
  $$rfq_response_id in (select s.id from app.rfq_responses s join app.rfqs r on r.id = s.rfq_id
     where r.project_id in (select private.project_ids_with('procurement.rfq.write')))$$);

call private.install_policies('app.purchase_orders',
  $$project_id in (select private.project_ids_with('procurement.po.read'))$$,
  $$project_id in (select private.project_ids_with('procurement.po.write'))$$);
call private.install_policies('app.po_lines',
  $$purchase_order_id in (select po.id from app.purchase_orders po where po.project_id in (select private.project_ids_with('procurement.po.read')))$$,
  $$purchase_order_id in (select po.id from app.purchase_orders po where po.project_id in (select private.project_ids_with('procurement.po.write')))$$);
call private.install_policies('app.po_change_orders',
  $$purchase_order_id in (select po.id from app.purchase_orders po where po.project_id in (select private.project_ids_with('procurement.po.read')))$$,
  $$purchase_order_id in (select po.id from app.purchase_orders po where po.project_id in (select private.project_ids_with('procurement.po.write')))$$);
call private.install_policies('app.goods_receipts',
  $$purchase_order_id in (select po.id from app.purchase_orders po where po.project_id in (select private.project_ids_with('procurement.po.read')))$$,
  $$purchase_order_id in (select po.id from app.purchase_orders po where po.project_id in (select private.project_ids_with('procurement.receipt.write')))$$);
call private.install_policies('app.receipt_lines',
  $$goods_receipt_id in (select r.id from app.goods_receipts r join app.purchase_orders po on po.id = r.purchase_order_id
     where po.project_id in (select private.project_ids_with('procurement.po.read')))$$,
  $$goods_receipt_id in (select r.id from app.goods_receipts r join app.purchase_orders po on po.id = r.purchase_order_id
     where po.project_id in (select private.project_ids_with('procurement.receipt.write')))$$);
call private.install_policies('app.invoice_matches',
  $$invoice_id in (select i.id from app.invoices i where i.project_id in (select private.project_ids_with('finance.invoice.read')))$$,
  $$invoice_id in (select i.id from app.invoices i where i.project_id in (select private.project_ids_with('procurement.invoice_match.write')))$$);

call private.install_policies('app.catalog_bindings',
  $$org_id in (select private.orgs_with_capability('procurement.catalog.read'))$$,
  $$org_id in (select private.orgs_with_capability('procurement.catalog.write'))$$);
call private.install_policies('app.vendor_products',
  $$org_id in (select private.orgs_with_capability('procurement.catalog.read'))$$,
  $$org_id in (select private.orgs_with_capability('procurement.catalog.write'))$$);

-- Function privileges ----------------------------------------------------------------------------------------------------------------

revoke all on function private.guard_rfq_response() from public, anon, authenticated;
revoke all on function private.guard_purchase_order() from public, anon, authenticated;
revoke all on function private.guard_po_line() from public, anon, authenticated;
revoke all on function private.guard_po_change_order() from public, anon, authenticated;
revoke all on function private.guard_goods_receipt() from public, anon, authenticated;
revoke all on function private.guard_receipt_line() from public, anon, authenticated;
revoke all on function private.guard_invoice_match() from public, anon, authenticated;
revoke all on function app.transition_rfq(uuid, app.rfq_state, app.rfq_state, text) from public, anon;
revoke all on function app.approve_purchase_order(uuid, text) from public, anon;
revoke all on function app.transition_purchase_order(uuid, app.po_state, app.po_state, text) from public, anon;
revoke all on function app.decide_po_change_order(uuid, app.approval_decision, text) from public, anon;
grant execute on function app.transition_rfq(uuid, app.rfq_state, app.rfq_state, text) to authenticated, service_role;
grant execute on function app.approve_purchase_order(uuid, text) to authenticated, service_role;
grant execute on function app.transition_purchase_order(uuid, app.po_state, app.po_state, text) to authenticated, service_role;
grant execute on function app.decide_po_change_order(uuid, app.approval_decision, text) to authenticated, service_role;
