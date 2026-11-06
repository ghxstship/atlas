-- 3003_sub_hire_rfqs.sql
-- B11 One-click sub-hire RFQ drafts (RRR-235, G-97). An RFQ had a title and a due date and no way to say what it asks
-- for, so it gains request lines; a shortage against own stock then drafts one in a click, and the order made from the
-- response is an R7a rental line (createPurchaseOrderFromResponse copies the facts from the line).
--
--   * app.rfq_lines: what an RFQ asks for, editable while it is Proposed, in the hire shape of app.po_lines.
--   * app.rfq_response_lines.rfq_line_id: the request line a quoted line answers. app.record_rfq_response (from 0493)
--     takes it per line and defaults the element from it, so an order line can count against the class's capacity.
--   * app.asset_shortages: per project and class, what its open allocations want beyond what can supply them. Evaluated
--     per allocation, because capacity counts a rental only when its hire period contains the window: a hull alone
--     would drop a rental that already covers one allocation, and invite a double hire. Past events drop out.
--   * app.create_sub_hire_rfq: the draft, replayable by event id. A new draft refuses while the need already has an
--     RFQ in Proposed or Issued (sub_hire_rfq_open).

-- 1. Request lines -------------------------------------------------------------------------------------------------------------

create table app.rfq_lines (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  rfq_id uuid not null references app.rfqs (id),
  line_number integer not null default 0,
  description text not null,
  element_id text references xpms.elements (element_id),
  quantity numeric not null,
  unit_basis text references xpms.dim_unit_alias (alias),
  acquisition_kind app.acquisition_kind not null default 'Purchase',
  hire_period tstzrange,
  procurement_need_id uuid references app.procurement_needs (id),
  deleted_at timestamptz,
  constraint rfq_lines_line_number_nonnegative check (line_number >= 0),
  constraint rfq_lines_description_length check (char_length(btrim(description)) between 1 and 500),
  constraint rfq_lines_quantity_positive check (quantity > 0),
  constraint rfq_lines_hire_period_kind check ((acquisition_kind = 'Rental') = (hire_period is not null)),
  constraint rfq_lines_hire_period_bounded check (hire_period is null or (not isempty(hire_period) and not lower_inf(hire_period) and not upper_inf(hire_period)))
);

create unique index rfq_lines_rfq_number_key on app.rfq_lines (rfq_id, line_number) where deleted_at is null;
create index rfq_lines_element_id_idx on app.rfq_lines (element_id);
create index rfq_lines_unit_basis_idx on app.rfq_lines (unit_basis);
create index rfq_lines_procurement_need_id_idx on app.rfq_lines (procurement_need_id);

call private.install_domain_table('app.rfq_lines', 'app.rfqs', 'rfq_id', array['app.procurement_needs', 'procurement_need_id']);
call private.install_policies('app.rfq_lines',
  $$rfq_id in (select r.id from app.rfqs r where r.project_id in (select private.project_ids_with('procurement.rfq.read')))$$,
  $$rfq_id in (select r.id from app.rfqs r where r.project_id in (select private.project_ids_with('procurement.rfq.write')))$$);
call private.describe('app.rfq_lines', 'What an RFQ asks for (B11, G-97). Lines change only while the RFQ is Proposed. Readable with the RFQ: no prices, and nothing of a sealed response.', array[
  'rfq_id', 'RFQ the line belongs to.',
  'line_number', 'Order of the line within the RFQ, numbered on insert when left at 0.',
  'description', 'What is asked for.',
  'element_id', 'Catalog element asked for, when one applies.',
  'quantity', 'Quantity asked for.',
  'unit_basis', 'Unit of the quantity.',
  'acquisition_kind', 'Purchase, or Rental for a hire.',
  'hire_period', 'Rental lines only: when the hire starts and ends (both bounds set).',
  'procurement_need_id', 'Need of the same project the line sources.'
]);
call private.install_default_retention('app.rfq_lines');
call private.install_audit_trail('app.rfq_lines');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('rfq_lines', 'Part of an RFQ that is still being drafted; a line is typed again, and a restored line on an issued RFQ would change what vendors were asked.')
on conflict (table_name) do nothing;

create or replace function private.guard_rfq_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rfq app.rfqs;
begin
  select r.* into v_rfq from app.rfqs r where r.id = new.rfq_id for update;
  if v_rfq.rfq_state <> 'Proposed' then
    perform private.refuse('rfq_line_locked', 'An RFQ''s lines change only while it is Proposed.');
  end if;
  if tg_op = 'UPDATE' and new.rfq_id <> old.rfq_id then
    perform private.refuse('rfq_line_locked', 'An RFQ''s lines change only while it is Proposed.');
  end if;
  if new.procurement_need_id is not null and not exists (
    select 1 from app.procurement_needs n where n.id = new.procurement_need_id and n.project_id = v_rfq.project_id and n.deleted_at is null) then
    perform private.refuse('rfq_line_need', 'An RFQ line sources a live need of the RFQ''s project.');
  end if;
  if tg_op = 'INSERT' and new.line_number = 0 then
    new.line_number := coalesce((select max(l.line_number) from app.rfq_lines l where l.rfq_id = new.rfq_id and l.deleted_at is null), 0) + 1;
  end if;
  return new;
end;
$$;
comment on function private.guard_rfq_line() is 'RFQ lines: editable only while the RFQ is Proposed (rfq_line_locked), sourcing a live need of its project (rfq_line_need), numbered on insert when left at 0 under the RFQ''s row lock.';
revoke all on function private.guard_rfq_line() from public, anon, authenticated;
create trigger t40_guard_rfq_line before insert or update on app.rfq_lines
  for each row execute function private.guard_rfq_line();

-- 2. Quoted lines name the line they answer --------------------------------------------------------------------------------------

alter table app.rfq_response_lines add column rfq_line_id uuid references app.rfq_lines (id);
create index rfq_response_lines_rfq_line_id_idx on app.rfq_response_lines (rfq_line_id);
comment on column app.rfq_response_lines.rfq_line_id is 'Request line of the same RFQ this quoted line answers, when it answers one (B11, G-97). The order line made from it copies the line''s acquisition kind, hire period and need.';
call private.add_cross_org_references('app.rfq_response_lines', array['app.rfq_lines', 'rfq_line_id']);

create or replace function private.guard_rfq_response_line_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.rfq_line_id is not null and not exists (
    select 1 from app.rfq_lines l join app.rfq_responses s on s.rfq_id = l.rfq_id
    where l.id = new.rfq_line_id and s.id = new.rfq_response_id and l.deleted_at is null) then
    perform private.refuse('rfq_response_line_line', 'A quoted line answers a line of the same RFQ.');
  end if;
  return new;
end;
$$;
comment on function private.guard_rfq_response_line_line() is 'A quoted line answers a live request line of the same RFQ (rfq_response_line_line).';
revoke all on function private.guard_rfq_response_line_line() from public, anon, authenticated;
create trigger t40_guard_rfq_response_line_line before insert or update of rfq_line_id on app.rfq_response_lines
  for each row execute function private.guard_rfq_response_line_line();

-- From 0493, its only definition: each line may name the request line it answers.
create or replace function app.record_rfq_response(
  p_rfq_id uuid,
  p_vendor_id uuid,
  p_valid_until date,
  p_currency_code text,
  p_lines jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_response uuid;
  v_line jsonb;
  v_rfq_line app.rfq_lines;
begin
  perform private.require_person();
  select r.project_id into v_project from app.rfqs r where r.id = p_rfq_id and r.deleted_at is null;
  if v_project is null or not private.can_on_project(v_project, 'procurement.rfq.write') then
    raise exception using errcode = '42501', message = 'procurement.rfq.write is required on the project';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    perform private.refuse('rfq_response_lines_required', 'A response quotes at least one line.');
  end if;

  insert into app.rfq_responses (rfq_id, vendor_id, valid_until)
  values (p_rfq_id, p_vendor_id, p_valid_until)
  returning id into v_response;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    select l.* into v_rfq_line from app.rfq_lines l where l.id = nullif(v_line ->> 'rfq_line_id', '')::uuid;
    insert into app.rfq_response_lines (rfq_response_id, description, element_id, quantity, unit_price_minor, currency_code, rfq_line_id)
    values (
      v_response,
      v_line ->> 'description',
      coalesce(nullif(v_line ->> 'element_id', ''), v_rfq_line.element_id),
      coalesce((v_line ->> 'quantity')::numeric, v_rfq_line.quantity, 1),
      (v_line ->> 'unit_price_minor')::bigint,
      upper(p_currency_code),
      nullif(v_line ->> 'rfq_line_id', '')::uuid
    );
  end loop;
  return v_response;
end;
$$;

comment on function app.record_rfq_response(uuid, uuid, date, text, jsonb) is 'Records a sealed RFQ response and its quoted lines for a vendor (procurement.rfq.write on the project); the response stays unreadable until the RFQ is Closed. A line may name the request line it answers (rfq_line_id), which defaults its element and quantity.';
revoke all on function app.record_rfq_response(uuid, uuid, date, text, jsonb) from public, anon;
grant execute on function app.record_rfq_response(uuid, uuid, date, text, jsonb) to authenticated, service_role;

-- 3. Shortages ---------------------------------------------------------------------------------------------------------------------

create or replace function private.asset_demand_peak(p_asset_class_id uuid, p_project_id uuid, p_window tstzrange)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  with demand as (
    select h.quantity, h.needed_during * p_window as overlap
    from private.live_asset_reservations(p_asset_class_id) h
    where h.needed_during && p_window
    union all
    -- What this project asked for and holds nothing against yet: Requested whole, Approved less its holds.
    select greatest(a.quantity - coalesce((
        select sum(r.quantity) from app.asset_reservations r
        where r.advance_allocation_id = a.id and r.released_at is null and r.deleted_at is null), 0), 0),
      a.needed_during * p_window
    from app.advance_allocations a
    where a.asset_class_id = p_asset_class_id and a.project_id = p_project_id and a.deleted_at is null
      and a.allocation_state in ('Requested', 'Approved') and a.needed_during && p_window
  ),
  points as (
    select lower(p_window) as at
    union
    select lower(d.overlap) from demand d
  )
  select coalesce(max(t.wanted), 0) from (
    select (select coalesce(sum(d.quantity), 0) from demand d where d.overlap @> p.at) as wanted from points p
  ) t;
$$;
comment on function private.asset_demand_peak(uuid, uuid, tstzrange) is 'The most of an asset class wanted at once over a window, by a boundary sweep (as private.asset_reservation_peak): every live hold of the class across the org, plus this project''s unreserved remainder (Requested whole, Approved less its holds).';
revoke all on function private.asset_demand_peak(uuid, uuid, tstzrange) from public, anon, authenticated;

create or replace function private.project_asset_shortage(p_project_id uuid, p_asset_class_id uuid)
returns table (short_quantity numeric, window_from timestamptz, window_to timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with each_allocation as (
    select a.needed_during, private.asset_demand_peak(p_asset_class_id, p_project_id, a.needed_during)
        - (k.serviceable_units + k.lot_quantity + k.on_order_quantity) as short
    from app.advance_allocations a
    cross join lateral private.asset_class_capacity(p_asset_class_id, a.needed_during) k
    where a.asset_class_id = p_asset_class_id and a.project_id = p_project_id and a.deleted_at is null
      and a.allocation_state in ('Requested', 'Approved') and upper(a.needed_during) > now()
  )
  select max(e.short), min(lower(e.needed_during)), max(upper(e.needed_during))
  from each_allocation e where e.short > 0;
$$;
comment on function private.project_asset_shortage(uuid, uuid) is 'How short a project is of an asset class (B11, G-97): over its open allocations that have not ended, the largest peak wanted over one allocation''s window less what the class can supply for that same window, and the span of the allocations that are short. A row with NULLs when none is. Capacity counts a rental only when its hire period contains the window, and counts Proposed orders, so the shortage clears once a draft order exists.';
revoke all on function private.project_asset_shortage(uuid, uuid) from public, anon, authenticated;

create or replace function private.open_need_of_class(p_project_id uuid, p_asset_class_id uuid, p_window tstzrange)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select n.id from app.procurement_needs n
  where n.project_id = p_project_id and n.asset_class_id = p_asset_class_id and n.deleted_at is null
    and private.need_window(n.id) && p_window
  order by n.need_number
  limit 1;
$$;
comment on function private.open_need_of_class(uuid, uuid, tstzrange) is 'The first live need of a project for an asset class whose window overlaps the given one.';
revoke all on function private.open_need_of_class(uuid, uuid, tstzrange) from public, anon, authenticated;

create or replace function private.open_rfq_of_need(p_need_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.id from app.rfq_lines l join app.rfqs r on r.id = l.rfq_id
  where l.procurement_need_id = p_need_id and l.deleted_at is null and r.deleted_at is null and r.rfq_state in ('Proposed', 'Issued')
  order by r.rfq_number desc
  limit 1;
$$;
comment on function private.open_rfq_of_need(uuid) is 'The latest live RFQ in Proposed or Issued that sources a need.';
revoke all on function private.open_rfq_of_need(uuid) from public, anon, authenticated;

create or replace function app.asset_shortages(p_org_id uuid, p_project_id uuid default null)
returns table (
  project_id uuid,
  project_key text,
  asset_class_id uuid,
  class_name text,
  element_id text,
  unit_basis text,
  short_quantity numeric,
  window_from timestamptz,
  window_to timestamptz,
  open_need_id uuid,
  open_rfq_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  with pairs as (
    select distinct a.project_id, a.asset_class_id
    from app.advance_allocations a
    where a.org_id = p_org_id and a.asset_class_id is not null and a.deleted_at is null
      and a.allocation_state in ('Requested', 'Approved') and upper(a.needed_during) > now()
      and (p_project_id is null or a.project_id = p_project_id)
      and (a.project_id in (select private.project_ids_with('advancing.packet.read'))
        or a.project_id in (select private.project_ids_with('procurement.po.read')))
  ),
  short as (
    select x.project_id, x.asset_class_id, s.short_quantity, s.window_from, s.window_to,
      private.open_need_of_class(x.project_id, x.asset_class_id, tstzrange(s.window_from, s.window_to, '[)')) as need_id
    from pairs x
    cross join lateral private.project_asset_shortage(x.project_id, x.asset_class_id) s
    where s.short_quantity > 0
  )
  select s.project_id, p.project_key, s.asset_class_id, c.name, c.element_id, e.unit_basis::text, s.short_quantity, s.window_from, s.window_to,
    case when private.can_on_project(s.project_id, 'procurement.po.read') then s.need_id end,
    case when private.can_on_project(s.project_id, 'procurement.rfq.read') then private.open_rfq_of_need(s.need_id) end
  from short s
  join app.projects p on p.id = s.project_id
  join app.asset_classes c on c.id = s.asset_class_id
  join xpms.elements e on e.element_id = c.element_id
  order by p.project_key, c.name;
$$;
comment on function app.asset_shortages(uuid, uuid) is 'Short against own stock (B11, G-97): one row per project and asset class with open allocations wanting more than can supply them (private.project_asset_shortage), in the unit of the class element. Needs advancing.packet.read or procurement.po.read on the project; other projects are omitted. The open need answers procurement.po.read holders and its open RFQ procurement.rfq.read holders. No prices or names. Computed, never stored.';
revoke all on function app.asset_shortages(uuid, uuid) from public, anon;
grant execute on function app.asset_shortages(uuid, uuid) to authenticated, service_role;

-- 4. The draft -------------------------------------------------------------------------------------------------------------------------

create or replace function app.create_sub_hire_rfq(p_event_id uuid, p_project_id uuid, p_asset_class_ids uuid[], p_title text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_existing app.rfqs;
  v_class record;
  v_short record;
  v_window tstzrange;
  v_need uuid;
  v_seen integer := 0;
begin
  perform private.require_person();
  if p_project_id is null or not private.can_on_project(p_project_id, 'procurement.rfq.write')
     or not private.can_on_project(p_project_id, 'procurement.po.write') then
    raise exception using errcode = '42501', message = 'procurement.rfq.write and procurement.po.write are required on the project';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sub_hire_rfq:' || p_event_id::text, 0));
  select r.* into v_existing from app.rfqs r where r.id = p_event_id;
  if v_existing.id is not null then
    if v_existing.project_id <> p_project_id then
      perform private.refuse('rfq_event_reused', 'This request was already used on another project.');
    end if;
    return v_existing.id;
  end if;
  insert into app.rfqs (id, project_id, title) values (p_event_id, p_project_id, p_title);
  for v_class in
    select c.id, c.name, c.element_id, e.unit_basis::text as unit_basis
    from app.asset_classes c
    join app.projects p on p.id = p_project_id and p.org_id = c.org_id
    join xpms.elements e on e.element_id = c.element_id
    where c.id = any(p_asset_class_ids) and c.deleted_at is null
    order by c.name
  loop
    v_seen := v_seen + 1;
    select * into v_short from private.project_asset_shortage(p_project_id, v_class.id);
    if coalesce(v_short.short_quantity, 0) <= 0 then
      perform private.refuse('sub_hire_not_short', 'Own stock now covers this item.');
    end if;
    v_window := tstzrange(v_short.window_from, v_short.window_to, '[)');
    v_need := private.open_need_of_class(p_project_id, v_class.id, v_window);
    if v_need is null then
      insert into app.procurement_needs (project_id, description, quantity, unit_basis, asset_class_id, needed_during)
      values (p_project_id, v_class.name, v_short.short_quantity,
        (select u.alias from xpms.dim_unit_alias u where u.alias = v_class.unit_basis), v_class.id, v_window)
      returning id into v_need;
    elsif private.open_rfq_of_need(v_need) is not null then
      perform private.refuse('sub_hire_rfq_open', 'This need already has an RFQ open.');
    end if;
    insert into app.rfq_lines (rfq_id, description, element_id, quantity, unit_basis, acquisition_kind, hire_period, procurement_need_id)
    values (p_event_id, v_class.name, v_class.element_id, v_short.short_quantity,
      (select u.alias from xpms.dim_unit_alias u where u.alias = v_class.unit_basis), 'Rental', v_window, v_need);
  end loop;
  if v_seen = 0 or v_seen <> (select count(distinct x) from unnest(p_asset_class_ids) x) then
    perform private.refuse('sub_hire_not_short', 'Own stock now covers this item.');
  end if;
  return p_event_id;
end;
$$;
comment on function app.create_sub_hire_rfq(uuid, uuid, uuid[], text) is 'Drafts a sub-hire RFQ from shortages (B11, G-97): procurement.rfq.write and procurement.po.write on the project (42501 otherwise). The event id is the RFQ id, so a replay returns it and writes nothing (rfq_event_reused on another project). Each class is recomputed: not short refuses sub_hire_not_short, and a need that already has an RFQ in Proposed or Issued refuses sub_hire_rfq_open. It reuses a live need of the class whose window overlaps, else adds one of the short quantity, and writes one Rental line per class. The RFQ stays Proposed with no invitations, so rfq_no_invitations still guards issue.';
revoke all on function app.create_sub_hire_rfq(uuid, uuid, uuid[], text) from public, anon;
grant execute on function app.create_sub_hire_rfq(uuid, uuid, uuid[], text) to authenticated, service_role;
