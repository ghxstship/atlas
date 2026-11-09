-- 6531_procurement_needs.sql
-- B11 Consolidation onto procurement needs (RRR-235, G-180, ADR 0104 amendment). A request is what one party asked for;
-- a need is what the event will actually get. Many requests consolidate onto one need, linking never changes the need's
-- quantity, and its status is computed from order lines and cannot be set (6532).
--
--   1. app.procurement_needs: what a project has to buy or hire, numbered {projectKey}-NEED-{n}, in Trash (ADR 0110).
--      A need with live requests or live order lines cannot be deleted (need_has_links).
--   2. app.procurement_need_requests: the allocations consolidated onto a need. No direct writes; Requested may be
--      linked as well as Approved, because app.decide_allocation holds stock and so a short allocation cannot be
--      approved until it is bought.
--   3. app.po_lines.procurement_need_id: the need an order line serves, set while the order is Proposed by normal writes
--      and later through app.set_po_line_need under trusted operation po_line_need_link, the one early return of
--      private.guard_po_line (from 0331, its only definition).
--   4. app.consolidate_allocations, app.unlink_need_request, app.set_po_line_need, app.add_procurement_needs and
--      app.add_po_lines.

-- 1. Needs -------------------------------------------------------------------------------------------------------------------

create table app.procurement_needs (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  need_number bigint not null default 0,
  description text not null,
  quantity numeric not null,
  unit_basis text references xpms.dim_unit_alias (alias),
  asset_class_id uuid references app.asset_classes (id),
  element_id text references xpms.elements (element_id),
  needed_during tstzrange,
  note text,
  deleted_at timestamptz,
  constraint procurement_needs_description_length check (char_length(btrim(description)) between 1 and 500),
  constraint procurement_needs_quantity_positive check (quantity > 0),
  constraint procurement_needs_one_catalog_target check (num_nonnulls(asset_class_id, element_id) <= 1),
  constraint procurement_needs_window_bounded check (
    needed_during is null or (not isempty(needed_during) and not lower_inf(needed_during) and not upper_inf(needed_during))),
  constraint procurement_needs_note_length check (note is null or char_length(btrim(note)) between 1 and 1000)
);

create unique index procurement_needs_project_number_key on app.procurement_needs (project_id, need_number);
create index procurement_needs_unit_basis_idx on app.procurement_needs (unit_basis);
create index procurement_needs_asset_class_id_idx on app.procurement_needs (asset_class_id);
create index procurement_needs_element_id_idx on app.procurement_needs (element_id);

call private.install_project_table('app.procurement_needs', 'procurement.po.read', 'procurement.po.write',
  array['app.asset_classes', 'asset_class_id']);
call private.describe('app.procurement_needs', 'What a project will actually get (B11, G-180, ADR 0104 amendment): the quantity is set here and linking requests never changes it. Its status is computed from order lines (app.procurement_need_status) and cannot be set. A deleted need goes to Trash; one with live requests or live order lines cannot be deleted.', array[
  'project_id', 'Project buying.',
  'need_number', 'Number from the project''s display key sequence, issued on insert.',
  'description', 'What is needed.',
  'quantity', 'How much the event will get, set by the buyer.',
  'unit_basis', 'Unit of the quantity.',
  'asset_class_id', 'Asset class the need is for; at most one of the class and the element, neither for a free-text need.',
  'element_id', 'Catalog element the need is for; at most one of the class and the element, neither for a free-text need.',
  'needed_during', 'When it is needed; NULL reads the span of its linked requests.',
  'note', 'What the buyer noted.'
]);
call private.install_default_retention('app.procurement_needs');
call private.install_audit_trail('app.procurement_needs');

create trigger t35_need_number before insert or update on app.procurement_needs
  for each row execute function private.number_from_project_sequence('need_number');

create or replace function app.procurement_need_display_key(p_row app.procurement_needs)
returns text language sql stable set search_path = ''
as $$ select p.project_key || '-NEED-' || p_row.need_number::text from app.projects p where p.id = p_row.project_id; $$;
comment on function app.procurement_need_display_key(app.procurement_needs) is 'Computed field: the need''s display key {project_key}-NEED-{need_number}. Runs with the caller''s rights.';

insert into private.field_history_subjects (table_name) values ('app.procurement_needs') on conflict do nothing;
insert into private.comment_subjects (table_name) values ('app.procurement_needs') on conflict do nothing;

-- 2. Requests linked to a need -----------------------------------------------------------------------------------------------

create table app.procurement_need_requests (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  procurement_need_id uuid not null references app.procurement_needs (id),
  advance_allocation_id uuid not null references app.advance_allocations (id),
  deleted_at timestamptz
);

create index procurement_need_requests_need_idx on app.procurement_need_requests (procurement_need_id);
create unique index procurement_need_requests_allocation_key on app.procurement_need_requests (advance_allocation_id) where deleted_at is null;

call private.install_domain_table('app.procurement_need_requests', 'app.procurement_needs', 'procurement_need_id',
  array['app.advance_allocations', 'advance_allocation_id']);
call private.install_policies('app.procurement_need_requests',
  $$procurement_need_id in (select n.id from app.procurement_needs n where n.project_id in (select private.project_ids_with('procurement.po.read')))$$);
revoke insert, update, delete on app.procurement_need_requests from authenticated;
call private.describe('app.procurement_need_requests', 'An allocation consolidated onto a need (B11, G-180): each allocation on at most one need, a pool or its Split children but never both. Written only by app.consolidate_allocations and app.unlink_need_request. Read by whoever reads purchase orders on the project; holder names come only through app.allocations_ready_to_consolidate.', array[
  'procurement_need_id', 'Need the request is consolidated onto.',
  'advance_allocation_id', 'Allocation consolidated, in the same project.'
]);
call private.install_default_retention('app.procurement_need_requests');
call private.install_audit_trail('app.procurement_need_requests');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('procurement_need_requests', 'Written only by app.consolidate_allocations and app.unlink_need_request; linking again is the undo, and a restored link could double a pool and its Split child.')
on conflict (table_name) do nothing;

create or replace function private.assert_allocation_linkable(p_allocation app.advance_allocations)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_allocation.asset_class_id is null then
    perform private.refuse('need_request_not_asset', 'Only a request for equipment consolidates onto a need.');
  end if;
  if p_allocation.allocation_state not in ('Requested', 'Approved') then
    perform private.refuse('need_request_state', 'A Declined or Withdrawn request does not consolidate onto a need.');
  end if;
  if exists (select 1 from app.procurement_need_requests l
             where l.advance_allocation_id = p_allocation.id and l.deleted_at is null) then
    perform private.refuse('need_request_linked', 'This request is already on a need. Unlink it first.');
  end if;
  -- Sums must not double: a pool's quantity already reads its Split children.
  if exists (select 1 from app.procurement_need_requests l
             join app.advance_allocations c on c.id = l.advance_allocation_id
             where l.deleted_at is null
               and (c.parent_allocation_id = p_allocation.id or c.id = p_allocation.parent_allocation_id)) then
    perform private.refuse('need_request_overlap', 'A pool or its split shares is already on a need. Link one or the other.');
  end if;
end;
$$;
comment on function private.assert_allocation_linkable(app.advance_allocations) is 'Refuses an allocation that cannot join a need, whichever need: not for equipment (need_request_not_asset), Declined or Withdrawn (need_request_state), already linked (need_request_linked), or a pool with a linked child or a child of a linked pool (need_request_overlap).';
revoke all on function private.assert_allocation_linkable(app.advance_allocations) from public, anon, authenticated;

create or replace function private.guard_procurement_need_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_need app.procurement_needs;
  v_allocation app.advance_allocations;
begin
  if tg_op = 'UPDATE' then
    if new.procurement_need_id <> old.procurement_need_id or new.advance_allocation_id <> old.advance_allocation_id then
      perform private.refuse('need_request_immutable', 'A link keeps its need and request; unlink it and link again.');
    end if;
    -- Trash excludes the table, so a link that left never comes back through an update.
    if old.deleted_at is not null and new.deleted_at is null then
      perform private.refuse('need_request_immutable', 'A link keeps its need and request; unlink it and link again.');
    end if;
    return new;
  end if;
  select n.* into v_need from app.procurement_needs n where n.id = new.procurement_need_id;
  -- One pool at a time: two links of a pool and its child in separate transactions wait here.
  select a.* into v_allocation from app.advance_allocations a where a.id = new.advance_allocation_id and a.deleted_at is null;
  if v_allocation.id is not null then
    perform 1 from app.advance_allocations a where a.id = coalesce(v_allocation.parent_allocation_id, v_allocation.id) for update;
  end if;
  if v_allocation.id is null or v_allocation.project_id <> v_need.project_id then
    perform private.refuse('need_request_project', 'A need takes requests of its own project.');
  end if;
  perform private.assert_allocation_linkable(v_allocation);
  if v_need.asset_class_id is distinct from v_allocation.asset_class_id and v_need.asset_class_id is not null then
    perform private.refuse('need_request_class', 'This need names another asset class.');
  end if;
  if v_need.element_id is not null and v_need.element_id is distinct from (
    select c.element_id from app.asset_classes c where c.id = v_allocation.asset_class_id) then
    perform private.refuse('need_request_class', 'This need names another asset class.');
  end if;
  return new;
end;
$$;
comment on function private.guard_procurement_need_request() is 'Links of requests to needs: same project (need_request_project), an allocation that can link (private.assert_allocation_linkable), and a need that names no other class or element (need_request_class). A link never moves or comes back (need_request_immutable).';
revoke all on function private.guard_procurement_need_request() from public, anon, authenticated;
create trigger t40_guard_procurement_need_request before insert or update on app.procurement_need_requests
  for each row execute function private.guard_procurement_need_request();

-- 3. Order lines name their need -------------------------------------------------------------------------------------------------

alter table app.po_lines add column procurement_need_id uuid references app.procurement_needs (id);
create index po_lines_procurement_need_id_idx on app.po_lines (procurement_need_id);
comment on column app.po_lines.procurement_need_id is 'Need this line serves, of the order''s project (B11, G-180). Set while the order is Proposed, or later with app.set_po_line_need; the need''s status reads it.';
call private.add_cross_org_references('app.po_lines', array['app.procurement_needs', 'procurement_need_id']);

-- From 0331, its only definition: one early return, for the need link on an order that left Proposed.
create or replace function private.guard_po_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order app.purchase_orders;
begin
  if tg_op = 'UPDATE' and private.in_trusted_operation('po_line_need_link') then
    return new;
  end if;
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
comment on function private.guard_po_line() is 'Purchase order lines: editable only while Proposed, drawing on a budget line of the same project. app.set_po_line_need alone changes a line later, and only its need (trusted operation po_line_need_link).';
revoke all on function private.guard_po_line() from public, anon, authenticated;

create or replace function private.guard_po_line_need()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_need app.procurement_needs;
begin
  if new.procurement_need_id is null then
    return new;
  end if;
  select n.* into v_need from app.procurement_needs n where n.id = new.procurement_need_id and n.deleted_at is null;
  if v_need.id is null or v_need.project_id is distinct from (
    select po.project_id from app.purchase_orders po where po.id = new.purchase_order_id) then
    perform private.refuse('need_line_project', 'An order line serves a live need of the order''s project.');
  end if;
  if new.unit_basis is not null and v_need.unit_basis is not null and new.unit_basis <> v_need.unit_basis then
    perform private.refuse('need_line_unit', 'This line counts in another unit than the need.');
  end if;
  return new;
end;
$$;
comment on function private.guard_po_line_need() is 'An order line''s need is live and of the order''s project (need_line_project), in the same unit when both name one (need_line_unit), so the need''s ordered quantity adds like with like.';
revoke all on function private.guard_po_line_need() from public, anon, authenticated;
create trigger t41_guard_po_line_need before insert or update of procurement_need_id, unit_basis on app.po_lines
  for each row execute function private.guard_po_line_need();

-- A need's links ------------------------------------------------------------------------------------------------------------

create or replace function private.guard_procurement_need()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.deleted_at is not null and old.deleted_at is null and (
    exists (select 1 from app.procurement_need_requests l where l.procurement_need_id = old.id and l.deleted_at is null)
    or exists (select 1 from app.po_lines l join app.purchase_orders po on po.id = l.purchase_order_id
               where l.procurement_need_id = old.id and l.deleted_at is null and po.deleted_at is null)) then
    perform private.refuse('need_has_links', 'This need has requests or order lines. Unlink them first.');
  end if;
  if new.asset_class_id is not null and exists (
    select 1 from app.procurement_need_requests l join app.advance_allocations a on a.id = l.advance_allocation_id
    where l.procurement_need_id = new.id and l.deleted_at is null and a.asset_class_id <> new.asset_class_id) then
    perform private.refuse('need_request_class', 'This need names another asset class.');
  end if;
  if new.element_id is not null and exists (
    select 1 from app.procurement_need_requests l
    join app.advance_allocations a on a.id = l.advance_allocation_id
    join app.asset_classes c on c.id = a.asset_class_id
    where l.procurement_need_id = new.id and l.deleted_at is null and c.element_id <> new.element_id) then
    perform private.refuse('need_request_class', 'This need names another asset class.');
  end if;
  return new;
end;
$$;
comment on function private.guard_procurement_need() is 'Needs: one with live requests or live order lines is not deleted (need_has_links), and its class or element stays that of its linked requests (need_request_class).';
revoke all on function private.guard_procurement_need() from public, anon, authenticated;
create trigger t40_guard_procurement_need before update on app.procurement_needs
  for each row execute function private.guard_procurement_need();

-- 4. RPCs ---------------------------------------------------------------------------------------------------------------------------

create or replace function app.consolidate_allocations(p_allocation_ids uuid[], p_need_id uuid default null)
returns uuid[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_projects integer;
  v_found integer;
  v_need app.procurement_needs;
  v_allocation app.advance_allocations;
  v_class record;
  v_id uuid;
  v_ids uuid[] := '{}';
begin
  perform private.require_person();
  select count(distinct a.project_id), min(a.project_id::text)::uuid, count(*) into v_projects, v_project, v_found
  from app.advance_allocations a where a.id = any(coalesce(p_allocation_ids, '{}')) and a.deleted_at is null;
  if p_need_id is not null then
    select n.project_id into v_project from app.procurement_needs n where n.id = p_need_id and n.deleted_at is null;
  end if;
  if v_project is null or not private.can_on_project(v_project, 'procurement.po.write')
     or not private.can_on_project(v_project, 'advancing.packet.read') then
    raise exception using errcode = '42501', message = 'procurement.po.write and advancing.packet.read are required on the project';
  end if;
  if v_projects > 1 or v_found <> (select count(distinct x) from unnest(coalesce(p_allocation_ids, '{}')) x) then
    perform private.refuse('need_request_project', 'A need takes requests of its own project.');
  end if;
  if v_found = 0 then
    perform private.refuse('need_request_quantity', 'Choose requests with a quantity to consolidate.');
  end if;
  if p_need_id is not null then
    select n.* into v_need from app.procurement_needs n where n.id = p_need_id for update;
  end if;
  -- In id order, so two consolidations of overlapping selections wait instead of deadlocking.
  for v_allocation in
    select a.* from app.advance_allocations a where a.id = any(p_allocation_ids) order by a.id for update
  loop
    if v_allocation.project_id <> v_project then
      perform private.refuse('need_request_project', 'A need takes requests of its own project.');
    end if;
    perform private.assert_allocation_linkable(v_allocation);
    if v_allocation.parent_allocation_id = any(p_allocation_ids) then
      perform private.refuse('need_request_overlap', 'A pool or its split shares is already on a need. Link one or the other.');
    end if;
  end loop;

  if p_need_id is not null then
    insert into app.procurement_need_requests (procurement_need_id, advance_allocation_id)
    select p_need_id, a.id from app.advance_allocations a where a.id = any(p_allocation_ids) order by a.id;
    return array[p_need_id];
  end if;

  for v_class in
    select a.asset_class_id, c.name, e.unit_basis::text as unit_basis,
      sum(a.quantity + coalesce((
        select sum(k.quantity) from app.advance_allocations k
        where k.parent_allocation_id = a.id and k.origin = 'Split' and k.deleted_at is null
          and k.allocation_state in ('Requested', 'Approved')), 0)) as quantity
    from app.advance_allocations a
    join app.asset_classes c on c.id = a.asset_class_id
    join xpms.elements e on e.element_id = c.element_id
    where a.id = any(p_allocation_ids)
    group by a.asset_class_id, c.name, e.unit_basis
    order by c.name
  loop
    if v_class.quantity <= 0 then
      perform private.refuse('need_request_quantity', 'Choose requests with a quantity to consolidate.');
    end if;
    insert into app.procurement_needs (project_id, description, quantity, unit_basis, asset_class_id)
    values (v_project, v_class.name, v_class.quantity,
      (select u.alias from xpms.dim_unit_alias u where u.alias = v_class.unit_basis), v_class.asset_class_id)
    returning id into v_id;
    insert into app.procurement_need_requests (procurement_need_id, advance_allocation_id)
    select v_id, a.id from app.advance_allocations a
    where a.id = any(p_allocation_ids) and a.asset_class_id = v_class.asset_class_id order by a.id;
    v_ids := v_ids || v_id;
  end loop;
  return v_ids;
end;
$$;
comment on function app.consolidate_allocations(uuid[], uuid) is 'Consolidates requests onto needs (B11, G-180): needs procurement.po.write and advancing.packet.read on the project (42501 otherwise), and every allocation in one project (need_request_project). With p_need_id it links them to that need and leaves its quantity alone. Without it, it adds one need per asset class, quantity the sum of the selection and their live Split children (need_request_quantity when that is 0) and description the class name. Returns the need ids. The refusals of private.assert_allocation_linkable and private.guard_procurement_need_request apply.';
revoke all on function app.consolidate_allocations(uuid[], uuid) from public, anon;
grant execute on function app.consolidate_allocations(uuid[], uuid) to authenticated, service_role;

create or replace function app.unlink_need_request(p_allocation_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_link app.procurement_need_requests;
  v_project uuid;
begin
  perform private.require_person();
  select l.* into v_link from app.procurement_need_requests l
  where l.advance_allocation_id = p_allocation_id and l.deleted_at is null for update;
  select n.project_id into v_project from app.procurement_needs n where n.id = v_link.procurement_need_id;
  if v_link.id is null or not private.can_on_project(v_project, 'procurement.po.write') then
    raise exception using errcode = '42501', message = 'procurement.po.write is required on the project';
  end if;
  update app.procurement_need_requests set deleted_at = now() where id = v_link.id;
end;
$$;
comment on function app.unlink_need_request(uuid) is 'Takes a request off its need (B11, G-180), for procurement.po.write on the project (42501 otherwise, or when it is on no need). The need''s quantity stays; the request is ready to consolidate again.';
revoke all on function app.unlink_need_request(uuid) from public, anon;
grant execute on function app.unlink_need_request(uuid) to authenticated, service_role;

create or replace function app.set_po_line_need(p_po_line_id uuid, p_need_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_line app.po_lines;
  v_order app.purchase_orders;
begin
  perform private.require_person();
  select l.* into v_line from app.po_lines l where l.id = p_po_line_id and l.deleted_at is null for update;
  select po.* into v_order from app.purchase_orders po where po.id = v_line.purchase_order_id and po.deleted_at is null;
  if v_line.id is null or v_order.id is null or not private.can_on_project(v_order.project_id, 'procurement.po.write') then
    raise exception using errcode = '42501', message = 'procurement.po.write is required on the project';
  end if;
  if v_order.po_state = 'Canceled' then
    perform private.refuse('need_line_order_state', 'A line of a Canceled order serves no need.');
  end if;
  perform private.begin_trusted_operation('po_line_need_link');
  update app.po_lines set procurement_need_id = p_need_id where id = v_line.id;
  perform private.end_trusted_operation('po_line_need_link');
end;
$$;
comment on function app.set_po_line_need(uuid, uuid) is 'Links an order line to a need of its project, or clears the link with NULL, on an order in any state but Canceled (need_line_order_state): the one change a line takes after its order leaves Proposed (B11, G-180). Needs procurement.po.write on the project (42501 otherwise).';
revoke all on function app.set_po_line_need(uuid, uuid) from public, anon;
grant execute on function app.set_po_line_need(uuid, uuid) to authenticated, service_role;

create or replace function app.add_procurement_needs(p_project_id uuid, p_lines jsonb)
returns uuid[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_line jsonb;
  v_id uuid;
  v_ids uuid[] := '{}';
  v_from timestamptz;
  v_to timestamptz;
begin
  perform private.require_person();
  if p_project_id is null or not private.can_on_project(p_project_id, 'procurement.po.write') then
    raise exception using errcode = '42501', message = 'procurement.po.write is required on the project';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    perform private.refuse('equipment_empty', 'Add at least one line.');
  end if;
  if jsonb_array_length(p_lines) > 200 then
    perform private.refuse('equipment_too_many', 'Add at most 200 lines at a time.');
  end if;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    if coalesce(btrim(v_line ->> 'description'), '') = '' or coalesce((v_line ->> 'quantity')::numeric, 0) <= 0 then
      perform private.refuse('equipment_line_invalid', 'Each line needs an item and a quantity above 0.');
    end if;
    v_from := (v_line ->> 'needed_from')::timestamptz;
    v_to := (v_line ->> 'needed_to')::timestamptz;
    if (v_from is null) <> (v_to is null) or v_to <= v_from then
      perform private.refuse('need_window_order', 'A need ends after it starts, and names both.');
    end if;
    insert into app.procurement_needs (project_id, description, quantity, unit_basis, asset_class_id, element_id, needed_during, note)
    values (p_project_id, btrim(v_line ->> 'description'), (v_line ->> 'quantity')::numeric, nullif(v_line ->> 'unit_basis', ''),
      nullif(v_line ->> 'asset_class_id', '')::uuid, nullif(v_line ->> 'element_id', ''),
      case when v_from is null then null else tstzrange(v_from, v_to, '[)') end, nullif(btrim(coalesce(v_line ->> 'note', '')), ''))
    returning id into v_id;
    v_ids := v_ids || v_id;
  end loop;
  return v_ids;
end;
$$;
comment on function app.add_procurement_needs(uuid, jsonb) is 'Adds up to 200 needs to a project in one transaction, so one bad line writes none (B11, G-107): procurement.po.write on the project (42501 otherwise), each with a description and a quantity above 0 (equipment_line_invalid). Returns the ids in order.';
revoke all on function app.add_procurement_needs(uuid, jsonb) from public, anon;
grant execute on function app.add_procurement_needs(uuid, jsonb) to authenticated, service_role;

create or replace function app.add_po_lines(p_purchase_order_id uuid, p_lines jsonb)
returns uuid[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order app.purchase_orders;
  v_line jsonb;
  v_number integer;
  v_id uuid;
  v_ids uuid[] := '{}';
begin
  perform private.require_person();
  select po.* into v_order from app.purchase_orders po where po.id = p_purchase_order_id and po.deleted_at is null for update;
  if v_order.id is null or not private.can_on_project(v_order.project_id, 'procurement.po.write') then
    raise exception using errcode = '42501', message = 'procurement.po.write is required on the project';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    perform private.refuse('equipment_empty', 'Add at least one line.');
  end if;
  if jsonb_array_length(p_lines) > 200 then
    perform private.refuse('equipment_too_many', 'Add at most 200 lines at a time.');
  end if;
  select coalesce(max(l.line_number), 0) into v_number from app.po_lines l where l.purchase_order_id = p_purchase_order_id and l.deleted_at is null;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    if coalesce(btrim(v_line ->> 'description'), '') = '' or coalesce((v_line ->> 'quantity')::numeric, 0) <= 0 then
      perform private.refuse('equipment_line_invalid', 'Each line needs an item and a quantity above 0.');
    end if;
    v_number := v_number + 1;
    insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_basis, element_id, unit_price_minor, procurement_need_id)
    values (p_purchase_order_id, v_number, btrim(v_line ->> 'description'), (v_line ->> 'quantity')::numeric, nullif(v_line ->> 'unit_basis', ''),
      nullif(v_line ->> 'element_id', ''), (v_line ->> 'unit_price_minor')::bigint, nullif(v_line ->> 'procurement_need_id', '')::uuid)
    returning id into v_id;
    v_ids := v_ids || v_id;
  end loop;
  return v_ids;
end;
$$;
comment on function app.add_po_lines(uuid, jsonb) is 'Adds up to 200 lines to a Proposed order in one transaction, numbered after its last line, so one bad line writes none (B11, G-107): procurement.po.write on the project (42501 otherwise), each with a description and a quantity above 0 (equipment_line_invalid), and private.guard_po_line refuses an order past Proposed (purchase_order_locked). Returns the ids in order.';
revoke all on function app.add_po_lines(uuid, jsonb) from public, anon;
grant execute on function app.add_po_lines(uuid, jsonb) to authenticated, service_role;
