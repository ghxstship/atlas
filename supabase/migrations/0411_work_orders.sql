-- 0411_work_orders.sql
-- A08 Work (ADR 0022 range 0410 to 0419). Work orders with bids (Section 4.2 Work: "work orders
-- with bids"; Section 4.5.5 Work > Work orders). A work order is a scoped piece of work put out for
-- bids, awarded to one bidder and then carried out. Its own lifecycle (Section 3.12 pattern) has a
-- transition ledger; awarding goes only through app.award_work_order, which refuses an award by the
-- work order's creator (separation of duties) and an unpriced bid. Bid totals are never stored.
--
-- Rows follow their project (invariant 2): read with work.work_order.read, written with
-- work.work_order.write, awarded with work.work_order.award.

create type app.work_order_state as enum ('Draft', 'Open', 'Awarded', 'In Progress', 'Complete', 'Canceled');
comment on type app.work_order_state is 'Work order lifecycle: Draft while scoped, Open for bids, Awarded to one bid, In Progress, Complete, or Canceled (retained).';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('work_order', 'Draft', 'Open'),
  ('work_order', 'Draft', 'Canceled'),
  ('work_order', 'Open', 'Draft'),
  ('work_order', 'Open', 'Awarded'),
  ('work_order', 'Open', 'Canceled'),
  ('work_order', 'Awarded', 'In Progress'),
  ('work_order', 'Awarded', 'Canceled'),
  ('work_order', 'In Progress', 'Complete'),
  ('work_order', 'In Progress', 'Canceled')
on conflict do nothing;

insert into private.domain_event_types (code, subject, description) values
  ('work_order.created', 'work_orders', 'A work order was created.'),
  ('work_order.state_changed', 'work_orders', 'A work order moved to another state.'),
  ('work_order.awarded', 'work_orders', 'A work order was awarded to one of its bids.'),
  ('work_order_bid.submitted', 'work_order_bids', 'A bid was recorded on a work order.')
on conflict (code) do nothing;

-- Work orders ------------------------------------------------------------------------------------------

create table app.work_orders (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  scope_node_id uuid references app.scope_nodes (id),
  record_id uuid references app.records (id),
  work_order_number bigint not null default 0,
  title text not null,
  scope_of_work text,
  urid text references xpms.dim_category (cat_urid),
  zone_id uuid references app.zones (id),
  location_text text,
  scheduled_starts_at timestamptz,
  scheduled_ends_at timestamptz,
  estimated_hours numeric,
  bid_due_at timestamptz,
  awarded_bid_id uuid,
  work_order_state app.work_order_state not null default 'Draft',
  deleted_at timestamptz,
  constraint work_orders_title_length check (char_length(btrim(title)) between 1 and 200 and title = btrim(title)),
  constraint work_orders_window check (scheduled_ends_at is null or scheduled_starts_at is null or scheduled_ends_at >= scheduled_starts_at),
  constraint work_orders_hours_nonnegative check (estimated_hours is null or estimated_hours >= 0),
  constraint work_orders_location_length check (location_text is null or char_length(btrim(location_text)) between 1 and 300),
  constraint work_orders_awarded_has_bid check (work_order_state not in ('Awarded', 'In Progress', 'Complete') or awarded_bid_id is not null)
);

create unique index work_orders_project_number_key on app.work_orders (project_id, work_order_number);
create index work_orders_scope_node_id_idx on app.work_orders (scope_node_id);
create index work_orders_record_id_idx on app.work_orders (record_id);
create index work_orders_urid_idx on app.work_orders (urid);
create index work_orders_zone_id_idx on app.work_orders (zone_id);
create index work_orders_state_idx on app.work_orders (work_order_state);

call private.install_domain_table('app.work_orders', 'app.projects', 'project_id',
  array['app.scope_nodes', 'scope_node_id', 'app.records', 'record_id', 'app.zones', 'zone_id']);
call private.describe('app.work_orders', 'Work orders: scoped work put out for bids, awarded to one bid and carried out (Section 4.2 Work). Canceled work orders are retained.', array[
  'project_id', 'Project. Never changes.',
  'scope_node_id', 'Scope node of the same project the work sits under.',
  'record_id', 'Record of the same project the work order delivers, for example a Build or Task record.',
  'work_order_number', 'Sequence number within the project, issued on insert. The display key is {project_key}-WO-{number}, read through app.work_order_display_key.',
  'title', 'What the work is.',
  'scope_of_work', 'The scope bidders price, in sentence case.',
  'urid', 'URID category of the work (dimension 2).',
  'zone_id', 'Zone where the work happens.',
  'location_text', 'Where the work happens, in words, when no zone says it.',
  'scheduled_starts_at', 'Planned start.',
  'scheduled_ends_at', 'Planned finish; not before the start.',
  'estimated_hours', 'Estimated labor hours; NULL when unestimated.',
  'bid_due_at', 'When bids are due.',
  'awarded_bid_id', 'Bid the work order was awarded to. Set only by app.award_work_order.',
  'work_order_state', 'Lifecycle state. Changes only through app.transition_work_order and app.award_work_order.'
]);

create table app.work_order_state_transitions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  work_order_id uuid not null references app.work_orders (id),
  from_state app.work_order_state,
  to_state app.work_order_state not null,
  reason text not null,
  constraint work_order_state_transitions_reason_length check (char_length(btrim(reason)) between 1 and 500)
);

create index work_order_state_transitions_work_order_id_idx on app.work_order_state_transitions (work_order_id);

call private.install_domain_table('app.work_order_state_transitions', 'app.work_orders', 'work_order_id', '{}', true);
call private.describe('app.work_order_state_transitions', 'Append-only ledger of work order state changes, written only by the transition RPCs and work order creation.', array[
  'work_order_id', 'Work order that changed state.',
  'from_state', 'State before the change; NULL for the creation entry.',
  'to_state', 'State after the change.',
  'reason', 'Why the state changed.'
]);

-- Bids -----------------------------------------------------------------------------------------------

create table app.work_order_bids (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  work_order_id uuid not null references app.work_orders (id),
  bidder_organization_id uuid references app.organizations (id),
  bidder_person_id uuid references app.people (id),
  amount_minor bigint,
  currency_code char(3) not null references private.currencies (currency_code),
  estimated_hours numeric,
  note text,
  submitted_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  deleted_at timestamptz,
  constraint work_order_bids_one_bidder check (num_nonnulls(bidder_organization_id, bidder_person_id) = 1),
  constraint work_order_bids_amount_nonnegative check (amount_minor is null or amount_minor >= 0),
  constraint work_order_bids_hours_nonnegative check (estimated_hours is null or estimated_hours >= 0),
  constraint work_order_bids_note_length check (note is null or char_length(note) <= 2000)
);

create index work_order_bids_work_order_id_idx on app.work_order_bids (work_order_id);
create index work_order_bids_bidder_organization_id_idx on app.work_order_bids (bidder_organization_id);
create index work_order_bids_bidder_person_id_idx on app.work_order_bids (bidder_person_id);
create index work_order_bids_currency_code_idx on app.work_order_bids (currency_code);

call private.install_domain_table('app.work_order_bids', 'app.work_orders', 'work_order_id');
call private.describe('app.work_order_bids', 'Bids on a work order, one row per bidder submission. A NULL amount is a bid without a price (Unpriced), never zero; an unpriced bid cannot be awarded.', array[
  'work_order_id', 'Work order bid on.',
  'bidder_organization_id', 'Organization that bid, for a company.',
  'bidder_person_id', 'Person who bid, for an individual.',
  'amount_minor', 'Bid amount in minor units of currency_code; NULL is unpriced.',
  'currency_code', 'ISO 4217 currency of the amount.',
  'estimated_hours', 'Labor hours the bidder estimates; NULL when not given.',
  'note', 'Bidder''s qualifications and exclusions.',
  'submitted_at', 'When the bid was received.',
  'withdrawn_at', 'When the bidder withdrew the bid; a withdrawn bid cannot be awarded.'
]);

alter table app.work_orders add constraint work_orders_awarded_bid_fkey
  foreign key (awarded_bid_id) references app.work_order_bids (id);
create index work_orders_awarded_bid_id_idx on app.work_orders (awarded_bid_id);

-- Guards -----------------------------------------------------------------------------------------------

create or replace function private.guard_work_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_other uuid;
begin
  if tg_op = 'UPDATE' then
    if new.project_id <> old.project_id then
      perform private.refuse('work_order_project_immutable', 'A work order stays in its project.');
    end if;
    if new.work_order_number <> old.work_order_number then
      perform private.refuse('work_order_number_immutable', 'A work order keeps its number.');
    end if;
    if new.awarded_bid_id is distinct from old.awarded_bid_id and not private.in_trusted_operation('work_order_award') then
      perform private.refuse('work_order_award_rpc_only', 'A work order is awarded only through app.award_work_order.');
    end if;
    if new.deleted_at is not null and old.deleted_at is null and old.work_order_state <> 'Draft' then
      perform private.refuse('work_order_retained', 'Only a Draft work order can be deleted; cancel it instead.');
    end if;
  else
    new.work_order_number := private.next_sequence(new.org_id, 'work_order:' || new.project_id::text);
    if new.awarded_bid_id is not null then
      perform private.refuse('work_order_award_rpc_only', 'A work order is awarded only through app.award_work_order.');
    end if;
  end if;
  if new.scope_node_id is not null then
    select n.project_id into v_other from app.scope_nodes n where n.id = new.scope_node_id;
    if v_other is distinct from new.project_id then
      perform private.refuse('same_project', 'A work order''s scope node belongs to its project.');
    end if;
  end if;
  if new.record_id is not null then
    select r.project_id into v_other from app.records r where r.id = new.record_id;
    if v_other is distinct from new.project_id then
      perform private.refuse('same_project', 'A work order''s record belongs to its project.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_work_order() is 'Work orders: number issued on insert, project and number immutable, scope node and record in the same project, award only through app.award_work_order, only Draft work orders deleted.';
revoke all on function private.guard_work_order() from public, anon, authenticated;

create trigger t40_guard_work_order before insert or update on app.work_orders
  for each row execute function private.guard_work_order();
create trigger t41_work_order_state before insert or update on app.work_orders
  for each row execute function private.guard_lifecycle_state('work_order_state', 'work_order', 'Draft');
create trigger t80_log_work_order_state after insert on app.work_orders
  for each row execute function private.log_initial_state('app.work_order_state_transitions', 'work_order_id', 'work_order_state');
create trigger t90_emit_work_order_created after insert on app.work_orders
  for each row execute function private.emit_row_event('work_order.created', 'project_id', 'work_order_number', 'title', 'work_order_state');
create trigger t90_emit_work_order_state after insert on app.work_order_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('work_order.state_changed', 'work_orders', 'work_order_id', 'from_state', 'to_state', 'reason');

create or replace function private.guard_work_order_bid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state app.work_order_state := (select w.work_order_state from app.work_orders w where w.id = new.work_order_id);
begin
  if tg_op = 'UPDATE' then
    if new.work_order_id <> old.work_order_id then
      perform private.refuse('bid_work_order_immutable', 'A bid stays on its work order.');
    end if;
    if (select w.awarded_bid_id from app.work_orders w where w.id = new.work_order_id) = new.id then
      perform private.refuse('bid_awarded', 'An awarded bid never changes.');
    end if;
    if new.withdrawn_at is distinct from old.withdrawn_at and old.withdrawn_at is not null then
      perform private.refuse('bid_withdrawn', 'A withdrawn bid stays withdrawn; record a new bid instead.');
    end if;
    if new.submitted_at <> old.submitted_at then
      perform private.refuse('bid_submitted_immutable', 'A bid keeps the time it was received.');
    end if;
  else
    new.submitted_at := now();
  end if;
  if v_state not in ('Draft', 'Open') then
    perform private.refuse('bid_window_closed', 'Bids are recorded only while the work order is Draft or Open.');
  end if;
  return new;
end;
$$;

comment on function private.guard_work_order_bid() is 'Bids: recorded while the work order is Draft or Open, stamped with the time received, never moved, never changed once awarded, and withdrawn once.';
revoke all on function private.guard_work_order_bid() from public, anon, authenticated;

create trigger t40_guard_work_order_bid before insert or update on app.work_order_bids
  for each row execute function private.guard_work_order_bid();
create trigger t90_emit_work_order_bid after insert on app.work_order_bids
  for each row execute function private.emit_subject_event('work_order_bid.submitted', 'work_orders', 'work_order_id', 'amount_minor', 'currency_code');

-- RPCs -------------------------------------------------------------------------------------------------

create or replace function app.transition_work_order(
  p_work_order_id uuid,
  p_expected app.work_order_state,
  p_next app.work_order_state,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid := (select w.project_id from app.work_orders w where w.id = p_work_order_id);
begin
  perform private.require_person();
  if v_project is null or not exists (select 1 from private.project_ids_with('work.work_order.write') x where x = v_project) then
    raise exception using errcode = '42501', message = 'work.work_order.write is required on the work order';
  end if;
  if p_next = 'Awarded' then
    perform private.refuse('work_order_award_rpc_only', 'A work order is awarded only through app.award_work_order.');
  end if;
  return private.transition_lifecycle('work_order', 'app.work_orders', 'work_order_state', 'app.work_order_state_transitions',
    'work_order_id', p_work_order_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_work_order(uuid, app.work_order_state, app.work_order_state, text) is 'Moves a work order to another state with compare-and-set on the expected state. Awarded is reached only through app.award_work_order. Needs work.work_order.write on the project. Returns the ledger entry id.';

create or replace function app.award_work_order(p_work_order_id uuid, p_bid_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order app.work_orders;
  v_bid app.work_order_bids;
  v_entry uuid;
begin
  perform private.require_person();
  select * into v_order from app.work_orders w where w.id = p_work_order_id and w.deleted_at is null;
  if v_order.id is null or not exists (select 1 from private.project_ids_with('work.work_order.award') x where x = v_order.project_id) then
    raise exception using errcode = '42501', message = 'work.work_order.award is required on the work order';
  end if;
  if v_order.created_by = private.current_person_id() then
    perform private.refuse('sod_work_order_award', 'A work order is awarded by someone other than the person who created it.');
  end if;
  select * into v_bid from app.work_order_bids b where b.id = p_bid_id and b.deleted_at is null;
  if v_bid.id is null or v_bid.work_order_id <> p_work_order_id then
    perform private.refuse('work_order_award_bid', 'The awarded bid must be a bid on this work order.');
  end if;
  if v_bid.withdrawn_at is not null then
    perform private.refuse('work_order_award_withdrawn', 'A withdrawn bid cannot be awarded.');
  end if;
  if v_bid.amount_minor is null then
    perform private.refuse('work_order_award_unpriced', 'An unpriced bid cannot be awarded; record the bid''s price first.');
  end if;
  perform private.begin_trusted_operation('work_order_award');
  update app.work_orders set awarded_bid_id = p_bid_id where id = p_work_order_id and work_order_state = 'Open';
  perform private.end_trusted_operation('work_order_award');
  v_entry := private.transition_lifecycle('work_order', 'app.work_orders', 'work_order_state', 'app.work_order_state_transitions',
    'work_order_id', p_work_order_id, 'Open', 'Awarded', p_reason);
  perform private.emit_event(v_order.org_id, 'work_order.awarded', 'work_orders', p_work_order_id, v_order.project_id,
    jsonb_build_object('awarded_bid_id', p_bid_id, 'amount_minor', v_bid.amount_minor, 'currency_code', v_bid.currency_code));
  return v_entry;
end;
$$;

comment on function app.award_work_order(uuid, uuid, text) is 'Awards an Open work order to one of its priced, unwithdrawn bids and moves it to Awarded. Needs work.work_order.award on the project and refuses the work order''s creator (separation of duties). Returns the ledger entry id.';

create or replace function app.work_order_display_key(p_work_order app.work_orders)
returns text
language sql
stable
set search_path = ''
as $$
  select p.project_key || '-WO-' || p_work_order.work_order_number::text from app.projects p where p.id = p_work_order.project_id;
$$;

comment on function app.work_order_display_key(app.work_orders) is 'Computed field: the work order''s display key {project_key}-WO-{number}. Runs with the caller''s rights.';

-- Policies ---------------------------------------------------------------------------------------------

call private.install_policies('app.work_orders',
  $$project_id in (select private.project_ids_with('work.work_order.read'))
    or org_id in (select private.oversight_org_ids('work.work_order.read'))$$,
  $$project_id in (select private.project_ids_with('work.work_order.write'))$$);
call private.install_policies('app.work_order_state_transitions',
  $$work_order_id in (select w.id from app.work_orders w where w.project_id in (select private.project_ids_with('work.work_order.read')))$$);
call private.install_policies('app.work_order_bids',
  $$work_order_id in (select w.id from app.work_orders w where w.project_id in (select private.project_ids_with('work.work_order.read')))$$,
  $$work_order_id in (select w.id from app.work_orders w where w.project_id in (select private.project_ids_with('work.work_order.write')))$$);

-- Privileges -------------------------------------------------------------------------------------------

revoke all on function app.transition_work_order(uuid, app.work_order_state, app.work_order_state, text) from public, anon;
revoke all on function app.award_work_order(uuid, uuid, text) from public, anon;
revoke all on function app.work_order_display_key(app.work_orders) from public, anon;
grant execute on function app.transition_work_order(uuid, app.work_order_state, app.work_order_state, text) to authenticated, service_role;
grant execute on function app.award_work_order(uuid, uuid, text) to authenticated, service_role;
grant execute on function app.work_order_display_key(app.work_orders) to authenticated, service_role;
