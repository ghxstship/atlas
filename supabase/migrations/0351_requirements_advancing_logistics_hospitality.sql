-- 0351_requirements_advancing_logistics_hospitality.sql
-- A03 Domain Data. Requirements and capability (one shape with a direction facet, so reconciliation
-- is a join, Section 7.4), reconciliations and their lines (Met, Gap, Unknown), Advancing (packets,
-- sections, party-bound recipients, submissions, promotions, riders and rider lines), Logistics
-- (shipments, lines, dock slots, gate queue, marshalling log) and Hospitality (fulfillments, lines,
-- BEOs and BEO lines).

-- Requirements and capabilities ------------------------------------------------------------------------------

create type app.capability_direction as enum ('Require', 'Provide');
comment on type app.capability_direction is 'Direction facet of a capability statement: what the production requires, or what a venue or vendor provides.';

create type app.reconciliation_result as enum ('Met', 'Gap', 'Unknown');
comment on type app.reconciliation_result is 'Result of reconciling a requirement against capabilities. An Unknown against a critical requirement is a gap at gate 3 (Section 3.7).';

create table app.capability_statements (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  direction app.capability_direction not null,
  urid text not null references xpms.dim_category (cat_urid),
  description text not null,
  quantity numeric,
  unit_basis text references xpms.dim_unit_alias (alias),
  is_critical boolean not null default false,
  assertion_domain text not null default 'capability',
  assertion_word text not null default 'UNKNOWN',
  venue_id uuid references app.venues (id),
  counterparty_id uuid references app.counterparties (id),
  deleted_at timestamptz,
  constraint capability_statements_assertion_fkey foreign key (assertion_domain, assertion_word) references xpms.dim_assertion_word (domain, word),
  constraint capability_statements_assertion_domain check (assertion_domain = 'capability'),
  constraint capability_statements_description_length check (char_length(btrim(description)) between 1 and 500),
  constraint capability_statements_quantity_nonnegative check (quantity is null or quantity >= 0),
  constraint capability_statements_critical_is_requirement check (direction = 'Require' or not is_critical),
  constraint capability_statements_provider check (direction = 'Require' or num_nonnulls(venue_id, counterparty_id) = 1)
);
create index capability_statements_project_idx on app.capability_statements (project_id, direction, urid);
create index capability_statements_urid_idx on app.capability_statements (urid);
create index capability_statements_unit_basis_idx on app.capability_statements (unit_basis);
create index capability_statements_assertion_idx on app.capability_statements (assertion_domain, assertion_word);
create index capability_statements_venue_id_idx on app.capability_statements (venue_id);
create index capability_statements_counterparty_id_idx on app.capability_statements (counterparty_id);
call private.install_project_table('app.capability_statements', 'projects.project.read', 'projects.scope.write',
  array['app.venues', 'venue_id', 'app.counterparties', 'counterparty_id']);
call private.describe('app.capability_statements', 'Requirements and capabilities in one shape (Section 7.4): a direction facet says whether the project requires the URID or a venue or vendor provides it, so reconciliation is a join. Capabilities carry a capability assertion word (Bible tab 22); silence is UNKNOWN.', array[
  'project_id', 'Project.', 'direction', 'Require or Provide.', 'urid', 'Category required or provided.', 'description', 'What is required or provided.',
  'quantity', 'Quantity, when countable.', 'unit_basis', 'Unit of the quantity.', 'is_critical', 'True for a critical requirement; an Unknown against it is a gate 3 gap.',
  'assertion_domain', 'Always capability: the assertion family of the word.', 'assertion_word', 'CERTIFIED, DOCUMENTED, CLAIMED, INFERRED or UNKNOWN.',
  'venue_id', 'Venue that provides a capability.', 'counterparty_id', 'Vendor or other counterparty that provides a capability.'
]);

create view app.project_requirements with (security_invoker = true) as
select s.* from app.capability_statements s where s.direction = 'Require' and s.deleted_at is null;
comment on view app.project_requirements is 'Requirements: capability statements with direction Require.';
create view app.project_capabilities with (security_invoker = true) as
select s.* from app.capability_statements s where s.direction = 'Provide' and s.deleted_at is null;
comment on view app.project_capabilities is 'Capabilities: capability statements with direction Provide.';
do $$
declare v_col record;
begin
  for v_col in select a.attname from pg_catalog.pg_attribute a where a.attrelid = 'app.capability_statements'::regclass and a.attnum > 0 and not a.attisdropped loop
    execute format('comment on column app.project_requirements.%I is %L', v_col.attname, col_description('app.capability_statements'::regclass,
      (select attnum from pg_catalog.pg_attribute where attrelid = 'app.capability_statements'::regclass and attname = v_col.attname)));
    execute format('comment on column app.project_capabilities.%I is %L', v_col.attname, col_description('app.capability_statements'::regclass,
      (select attnum from pg_catalog.pg_attribute where attrelid = 'app.capability_statements'::regclass and attname = v_col.attname)));
  end loop;
end $$;
revoke all on app.project_requirements, app.project_capabilities from public, anon;
grant select on app.project_requirements, app.project_capabilities to authenticated, service_role;

create table app.reconciliations (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  reconciled_at timestamptz not null default now(),
  note text,
  deleted_at timestamptz
);
create index reconciliations_project_id_idx on app.reconciliations (project_id);
call private.install_project_table('app.reconciliations', 'projects.project.read', 'advancing.reconciliation.write');
call private.describe('app.reconciliations', 'A reconciliation run of a project''s requirements against capabilities.', array[
  'project_id', 'Project.', 'reconciled_at', 'When the reconciliation was made.', 'note', 'Notes on the run.'
]);

create table app.reconciliation_lines (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  reconciliation_id uuid not null references app.reconciliations (id),
  requirement_id uuid not null references app.capability_statements (id),
  capability_id uuid references app.capability_statements (id),
  result app.reconciliation_result not null,
  deleted_at timestamptz,
  constraint reconciliation_lines_met_names_capability check (result <> 'Met' or capability_id is not null)
);
create index reconciliation_lines_reconciliation_id_idx on app.reconciliation_lines (reconciliation_id);
create index reconciliation_lines_requirement_id_idx on app.reconciliation_lines (requirement_id);
create index reconciliation_lines_capability_id_idx on app.reconciliation_lines (capability_id);
create unique index reconciliation_lines_requirement_key on app.reconciliation_lines (reconciliation_id, requirement_id) where deleted_at is null;
call private.install_child_table('app.reconciliation_lines', 'app.reconciliations', 'reconciliation_id', 'projects.project.read', 'advancing.reconciliation.write',
  array['app.capability_statements', 'requirement_id', 'app.capability_statements', 'capability_id']);
call private.describe('app.reconciliation_lines', 'One requirement''s result in a reconciliation: Met (names the capability), Gap or Unknown.', array[
  'reconciliation_id', 'Reconciliation.', 'requirement_id', 'Requirement reconciled (direction Require).', 'capability_id', 'Capability that meets it (direction Provide).', 'result', 'Met, Gap or Unknown.'
]);

create or replace function private.guard_reconciliation_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid := (select r.project_id from app.reconciliations r where r.id = new.reconciliation_id);
begin
  if not exists (select 1 from app.capability_statements s where s.id = new.requirement_id and s.direction = 'Require' and s.project_id = v_project) then
    perform private.refuse('reconciliation_requirement', 'A reconciliation line reconciles a requirement of the same project.');
  end if;
  if new.capability_id is not null and not exists (
    select 1 from app.capability_statements s where s.id = new.capability_id and s.direction = 'Provide' and s.project_id = v_project
      and s.urid = (select q.urid from app.capability_statements q where q.id = new.requirement_id)) then
    perform private.refuse('reconciliation_capability', 'A capability meeting a requirement provides the same URID in the same project.');
  end if;
  return new;
end;
$$;
comment on function private.guard_reconciliation_line() is 'Reconciliation lines join a requirement to a capability of the same project and URID.';
revoke all on function private.guard_reconciliation_line() from public, anon, authenticated;
create trigger t40_guard_reconciliation_line before insert or update on app.reconciliation_lines
  for each row execute function private.guard_reconciliation_line();

create view app.reconciliation_gaps with (security_invoker = true) as
select l.reconciliation_id, r.project_id, l.requirement_id, l.result, q.is_critical
from app.reconciliation_lines l
join app.reconciliations r on r.id = l.reconciliation_id
join app.capability_statements q on q.id = l.requirement_id
where l.deleted_at is null and (l.result = 'Gap' or (l.result = 'Unknown' and q.is_critical));
call private.describe('app.reconciliation_gaps', 'Gaps of each reconciliation: every Gap, and every Unknown against a critical requirement (Section 3.7), which G3.NO_CRITICAL_GAPS reads.', array[
  'reconciliation_id', 'Reconciliation.', 'project_id', 'Project.', 'requirement_id', 'Requirement with the gap.', 'result', 'Gap or Unknown.', 'is_critical', 'True for a critical requirement.'
]);
revoke all on app.reconciliation_gaps from public, anon;
grant select on app.reconciliation_gaps to authenticated, service_role;

-- Advancing ------------------------------------------------------------------------------------------------

create table app.advance_packets (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  title text not null,
  due_at timestamptz,
  sent_at timestamptz,
  deleted_at timestamptz,
  constraint advance_packets_title_length check (char_length(btrim(title)) between 1 and 200)
);
create index advance_packets_project_id_idx on app.advance_packets (project_id);
call private.install_project_table('app.advance_packets', 'advancing.packet.read', 'advancing.packet.write');
call private.describe('app.advance_packets', 'Advance packets sent to talent, vendors and venues to collect what the production needs to know.', array[
  'project_id', 'Project.', 'title', 'Packet title.', 'due_at', 'When answers are due.', 'sent_at', 'When the packet went out.'
]);

create table app.advance_sections (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  advance_packet_id uuid not null references app.advance_packets (id),
  position integer not null,
  title text not null,
  prompt text,
  deleted_at timestamptz,
  constraint advance_sections_position_positive check (position > 0)
);
create unique index advance_sections_position_key on app.advance_sections (advance_packet_id, position) where deleted_at is null;
call private.install_child_table('app.advance_sections', 'app.advance_packets', 'advance_packet_id', 'advancing.packet.read', 'advancing.packet.write');
call private.describe('app.advance_sections', 'Sections of an advance packet.', array[
  'advance_packet_id', 'Packet.', 'position', 'Order in the packet.', 'title', 'Section title.', 'prompt', 'What the recipient is asked.'
]);

create table app.advance_recipients (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  advance_packet_id uuid not null references app.advance_packets (id),
  person_id uuid references app.people (id),
  counterparty_id uuid references app.counterparties (id),
  deleted_at timestamptz,
  constraint advance_recipients_one_party check (num_nonnulls(person_id, counterparty_id) = 1)
);
create index advance_recipients_packet_idx on app.advance_recipients (advance_packet_id);
create index advance_recipients_person_id_idx on app.advance_recipients (person_id);
create index advance_recipients_counterparty_id_idx on app.advance_recipients (counterparty_id);
call private.install_child_table('app.advance_recipients', 'app.advance_packets', 'advance_packet_id', 'advancing.packet.read', 'advancing.packet.write',
  array['app.counterparties', 'counterparty_id']);
call private.describe('app.advance_recipients', 'Parties an advance packet goes to: a person or a counterparty, never a free-text address.', array[
  'advance_packet_id', 'Packet.', 'person_id', 'Recipient person.', 'counterparty_id', 'Recipient counterparty.'
]);

create table app.advance_submissions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  advance_section_id uuid not null references app.advance_sections (id),
  advance_recipient_id uuid not null references app.advance_recipients (id),
  body text not null,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint advance_submissions_review_pair check ((reviewed_at is null) = (reviewed_by is null))
);
create index advance_submissions_section_idx on app.advance_submissions (advance_section_id);
create index advance_submissions_recipient_idx on app.advance_submissions (advance_recipient_id);
create index advance_submissions_reviewed_by_idx on app.advance_submissions (reviewed_by);
call private.install_domain_table('app.advance_submissions', 'app.advance_sections', 'advance_section_id', array['app.advance_recipients', 'advance_recipient_id']);
call private.install_policies('app.advance_submissions',
  $$advance_section_id in (select s.id from app.advance_sections s join app.advance_packets p on p.id = s.advance_packet_id
    where p.project_id in (select private.project_ids_with('advancing.packet.read')))$$,
  $$advance_section_id in (select s.id from app.advance_sections s join app.advance_packets p on p.id = s.advance_packet_id
    where p.project_id in (select private.project_ids_with('advancing.submission.review')))$$);
call private.describe('app.advance_submissions', 'A recipient''s answer to an advance section (rich text), with its review.', array[
  'advance_section_id', 'Section answered.', 'advance_recipient_id', 'Recipient of the same packet who answered.', 'body', 'The answer as rich text.',
  'submitted_at', 'When it was submitted.', 'reviewed_at', 'When it was reviewed.', 'reviewed_by', 'Who reviewed it.'
]);

create table app.advance_promotions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  advance_submission_id uuid not null references app.advance_submissions (id),
  record_id uuid not null references app.records (id)
);
create index advance_promotions_submission_idx on app.advance_promotions (advance_submission_id);
create index advance_promotions_record_id_idx on app.advance_promotions (record_id);
call private.install_domain_table('app.advance_promotions', 'app.advance_submissions', 'advance_submission_id', array['app.records', 'record_id'], true);
call private.install_policies('app.advance_promotions',
  $$record_id in (select private.record_ids_with('work.record.read'))$$);
call private.describe('app.advance_promotions', 'Append-only links from an advance submission to the record it was promoted into.', array[
  'advance_submission_id', 'Submission promoted.', 'record_id', 'Record created from it.'
]);
grant insert on app.advance_promotions to authenticated;
create policy advance_promotions_insert on app.advance_promotions for insert to authenticated
  with check (record_id in (select private.record_ids_with('work.record.write')));

create table app.riders (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  counterparty_id uuid references app.counterparties (id),
  title text not null,
  deleted_at timestamptz
);
create index riders_project_id_idx on app.riders (project_id);
create index riders_counterparty_id_idx on app.riders (counterparty_id);
call private.install_project_table('app.riders', 'advancing.packet.read', 'advancing.rider.write', array['app.counterparties', 'counterparty_id']);
call private.describe('app.riders', 'Technical and hospitality riders received from talent or vendors.', array[
  'project_id', 'Project.', 'counterparty_id', 'Party whose rider it is.', 'title', 'Rider title.'
]);

create table app.rider_lines (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  rider_id uuid not null references app.riders (id),
  description text not null,
  element_id text references xpms.elements (element_id),
  quantity numeric,
  fulfilled_at timestamptz,
  deleted_at timestamptz
);
create index rider_lines_rider_id_idx on app.rider_lines (rider_id);
create index rider_lines_element_id_idx on app.rider_lines (element_id);
call private.install_child_table('app.rider_lines', 'app.riders', 'rider_id', 'advancing.packet.read', 'advancing.rider.write');
call private.describe('app.rider_lines', 'Asks of a rider and whether each was fulfilled.', array[
  'rider_id', 'Rider.', 'description', 'What is asked.', 'element_id', 'Catalog element that fulfills it, when one applies.', 'quantity', 'Quantity asked.', 'fulfilled_at', 'When fulfilled; NULL while open.'
]);

-- Logistics -----------------------------------------------------------------------------------------------

create type app.shipment_direction as enum ('Inbound', 'Outbound');
comment on type app.shipment_direction is 'Whether a shipment comes to the site or leaves it.';

create table app.shipments (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  direction app.shipment_direction not null,
  carrier_counterparty_id uuid references app.counterparties (id),
  freight_type_enum_id text references xpms.std_enumeration (record_id),
  tracking_identifier text,
  ships_at timestamptz,
  arrives_at timestamptz,
  deleted_at timestamptz,
  constraint shipments_window check (arrives_at is null or ships_at is null or arrives_at >= ships_at)
);
create index shipments_project_id_idx on app.shipments (project_id);
create index shipments_carrier_idx on app.shipments (carrier_counterparty_id);
create index shipments_freight_type_idx on app.shipments (freight_type_enum_id);
call private.install_project_table('app.shipments', 'logistics.shipment.read', 'logistics.shipment.write', array['app.counterparties', 'carrier_counterparty_id']);
call private.describe('app.shipments', 'Shipments to and from a project''s sites.', array[
  'project_id', 'Project.', 'direction', 'Inbound or Outbound.', 'carrier_counterparty_id', 'Carrier.', 'freight_type_enum_id', 'Freight type: a row of the canon Freight Type enumeration.',
  'tracking_identifier', 'Carrier tracking number.', 'ships_at', 'When it ships.', 'arrives_at', 'When it is due to arrive.'
]);

create or replace function private.guard_shipment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_enumeration(new.freight_type_enum_id, 'Freight Type');
  return new;
end;
$$;
comment on function private.guard_shipment() is 'Shipment freight types come from the canon Freight Type enumeration.';
revoke all on function private.guard_shipment() from public, anon, authenticated;
create trigger t40_guard_shipment before insert or update on app.shipments for each row execute function private.guard_shipment();

create table app.shipment_lines (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  shipment_id uuid not null references app.shipments (id),
  description text not null,
  element_id text references xpms.elements (element_id),
  quantity numeric not null default 1,
  deleted_at timestamptz,
  constraint shipment_lines_quantity_positive check (quantity > 0)
);
create index shipment_lines_shipment_id_idx on app.shipment_lines (shipment_id);
create index shipment_lines_element_id_idx on app.shipment_lines (element_id);
call private.install_child_table('app.shipment_lines', 'app.shipments', 'shipment_id', 'logistics.shipment.read', 'logistics.shipment.write');
call private.describe('app.shipment_lines', 'What a shipment carries.', array[
  'shipment_id', 'Shipment.', 'description', 'Item description.', 'element_id', 'Catalog element, when one applies.', 'quantity', 'Quantity.'
]);

create table app.dock_slots (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  zone_id uuid not null references app.zones (id),
  shipment_id uuid references app.shipments (id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  deleted_at timestamptz,
  constraint dock_slots_window check (ends_at > starts_at)
);
create index dock_slots_project_id_idx on app.dock_slots (project_id);
create index dock_slots_zone_id_idx on app.dock_slots (zone_id, starts_at);
create index dock_slots_shipment_id_idx on app.dock_slots (shipment_id);
call private.install_project_table('app.dock_slots', 'logistics.shipment.read', 'logistics.dock_slot.write', array['app.zones', 'zone_id', 'app.shipments', 'shipment_id']);
call private.describe('app.dock_slots', 'Booked windows at a loading dock zone. Slots at one dock never overlap.', array[
  'project_id', 'Project.', 'zone_id', 'Dock zone booked.', 'shipment_id', 'Shipment of the same project using the slot.', 'starts_at', 'Slot start.', 'ends_at', 'Slot end.'
]);

create or replace function private.guard_dock_slot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.ends_at <= new.starts_at then
    return new;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dock_slots:' || new.zone_id::text, 0));
  if new.deleted_at is null and exists (
    select 1 from app.dock_slots d where d.zone_id = new.zone_id and d.id <> new.id and d.deleted_at is null
      and tstzrange(d.starts_at, d.ends_at) && tstzrange(new.starts_at, new.ends_at)) then
    perform private.refuse('dock_slot_overlap', 'Slots at one dock never overlap.');
  end if;
  return new;
end;
$$;
comment on function private.guard_dock_slot() is 'Dock slots at one zone never overlap.';
revoke all on function private.guard_dock_slot() from public, anon, authenticated;
create trigger t40_guard_dock_slot before insert or update on app.dock_slots for each row execute function private.guard_dock_slot();
create trigger t39_dock_slot_project before insert or update on app.dock_slots
  for each row execute function private.assert_same_project('app.shipments', 'shipment_id');

create table app.gate_queue (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  shipment_id uuid references app.shipments (id),
  vehicle_identifier text not null,
  arrived_at timestamptz not null default now(),
  released_at timestamptz,
  released_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint gate_queue_release_pair check ((released_at is null) = (released_by is null))
);
create index gate_queue_project_id_idx on app.gate_queue (project_id, arrived_at);
create index gate_queue_shipment_id_idx on app.gate_queue (shipment_id);
create index gate_queue_released_by_idx on app.gate_queue (released_by);
call private.install_project_table('app.gate_queue', 'logistics.shipment.read', 'logistics.yard.write', array['app.shipments', 'shipment_id']);
call private.describe('app.gate_queue', 'Vehicles waiting at the site gate and when each was released. Release needs logistics.release.approve.', array[
  'project_id', 'Project.', 'shipment_id', 'Shipment the vehicle carries.', 'vehicle_identifier', 'Plate or trailer number.',
  'arrived_at', 'When the vehicle arrived.', 'released_at', 'When it was released into the site.', 'released_by', 'Who released it.'
]);

create or replace function private.guard_gate_release()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.released_at is not null and (tg_op = 'INSERT' or old.released_at is null) then
    if auth.uid() is not null and not private.can_on_project(new.project_id, 'logistics.release.approve') then
      raise exception using errcode = '42501', message = 'logistics.release.approve is required to release a vehicle';
    end if;
    new.released_at := now();
    new.released_by := private.current_person_id();
  elsif tg_op = 'UPDATE' and old.released_at is not null then
    new.released_at := old.released_at;
    new.released_by := old.released_by;
  end if;
  return new;
end;
$$;
comment on function private.guard_gate_release() is 'Releasing a vehicle needs logistics.release.approve and is stamped once with the database time and session person.';
revoke all on function private.guard_gate_release() from public, anon, authenticated;
create trigger t40_guard_gate_release before insert or update on app.gate_queue for each row execute function private.guard_gate_release();

create table app.marshalling_log (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  shipment_id uuid references app.shipments (id),
  zone_id uuid references app.zones (id),
  entry text not null,
  logged_at timestamptz not null default now(),
  constraint marshalling_log_entry_length check (char_length(btrim(entry)) between 1 and 1000)
);
create index marshalling_log_project_id_idx on app.marshalling_log (project_id, logged_at);
create index marshalling_log_shipment_id_idx on app.marshalling_log (shipment_id);
create index marshalling_log_zone_id_idx on app.marshalling_log (zone_id);
call private.install_domain_table('app.marshalling_log', 'app.projects', 'project_id', array['app.shipments', 'shipment_id', 'app.zones', 'zone_id'], true);
call private.install_policies('app.marshalling_log',
  $$project_id in (select private.project_ids_with('logistics.shipment.read'))$$,
  $$project_id in (select private.project_ids_with('logistics.yard.write'))$$);
revoke update on app.marshalling_log from authenticated;
drop policy marshalling_log_update on app.marshalling_log;
call private.describe('app.marshalling_log', 'Append-only marshalling yard log: staging, moves and releases as they happen.', array[
  'project_id', 'Project.', 'shipment_id', 'Shipment concerned.', 'zone_id', 'Yard zone concerned.', 'entry', 'What happened.', 'logged_at', 'When it happened.'
]);

-- Hospitality ---------------------------------------------------------------------------------------------

create type app.fulfillment_kind as enum ('Lodging', 'Catering', 'Travel', 'Amenity');
comment on type app.fulfillment_kind is 'Kinds of hospitality fulfillment (Section 7.4).';

create table app.fulfillments (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  fulfillment_kind app.fulfillment_kind not null,
  counterparty_id uuid references app.counterparties (id),
  title text not null,
  starts_at timestamptz,
  ends_at timestamptz,
  deleted_at timestamptz,
  constraint fulfillments_window check (ends_at is null or starts_at is null or ends_at >= starts_at)
);
create index fulfillments_project_id_idx on app.fulfillments (project_id);
create index fulfillments_counterparty_id_idx on app.fulfillments (counterparty_id);
call private.install_project_table('app.fulfillments', 'hospitality.fulfillment.read', 'hospitality.fulfillment.write', array['app.counterparties', 'counterparty_id']);
call private.describe('app.fulfillments', 'Lodging, catering, travel and amenity fulfillments of a project.', array[
  'project_id', 'Project.', 'fulfillment_kind', 'Lodging, Catering, Travel or Amenity.', 'counterparty_id', 'Supplier.', 'title', 'What is fulfilled.', 'starts_at', 'Start.', 'ends_at', 'End.'
]);

create table app.fulfillment_lines (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  fulfillment_id uuid not null references app.fulfillments (id),
  description text not null,
  person_id uuid references app.people (id),
  quantity numeric not null default 1,
  unit_price_minor bigint,
  currency_code char(3) references private.currencies (currency_code),
  deleted_at timestamptz,
  constraint fulfillment_lines_price_currency check (unit_price_minor is null or currency_code is not null)
);
create index fulfillment_lines_fulfillment_id_idx on app.fulfillment_lines (fulfillment_id);
create index fulfillment_lines_person_id_idx on app.fulfillment_lines (person_id);
create index fulfillment_lines_currency_code_idx on app.fulfillment_lines (currency_code);
call private.install_child_table('app.fulfillment_lines', 'app.fulfillments', 'fulfillment_id', 'hospitality.fulfillment.read', 'hospitality.fulfillment.write');
call private.describe('app.fulfillment_lines', 'Lines of a fulfillment, such as a room night for a guest. A NULL price is unpriced.', array[
  'fulfillment_id', 'Fulfillment.', 'description', 'What is provided.', 'person_id', 'Guest served, when the line is for one person.',
  'quantity', 'Quantity.', 'unit_price_minor', 'Unit price in minor units; NULL is unpriced.', 'currency_code', 'ISO 4217 currency.'
]);

create table app.beos (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  fulfillment_id uuid references app.fulfillments (id),
  event_at timestamptz not null,
  guest_count integer,
  approved_at timestamptz,
  approved_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint beos_guest_count_positive check (guest_count is null or guest_count > 0),
  constraint beos_approval_pair check ((approved_at is null) = (approved_by is null))
);
create index beos_project_id_idx on app.beos (project_id);
create index beos_fulfillment_id_idx on app.beos (fulfillment_id);
create index beos_approved_by_idx on app.beos (approved_by);
call private.install_project_table('app.beos', 'hospitality.fulfillment.read', 'hospitality.beo.write', array['app.fulfillments', 'fulfillment_id']);
call private.describe('app.beos', 'Banquet event orders. Approved by someone with hospitality.beo.approve other than their author.', array[
  'project_id', 'Project.', 'fulfillment_id', 'Catering fulfillment of the same project.', 'event_at', 'When the meal service happens.', 'guest_count', 'Guaranteed guests.',
  'approved_at', 'When the BEO was approved.', 'approved_by', 'Who approved it.'
]);

create or replace function private.guard_beo()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.approved_at is not null and (tg_op = 'INSERT' or old.approved_at is null) then
    if auth.uid() is not null then
      if not private.can_on_project(new.project_id, 'hospitality.beo.approve') then
        raise exception using errcode = '42501', message = 'hospitality.beo.approve is required';
      end if;
      perform private.assert_separation('sod_approval_requester', private.current_person_id(), case when tg_op = 'UPDATE' then old.created_by end);
    end if;
    new.approved_at := now();
    new.approved_by := private.current_person_id();
  elsif tg_op = 'UPDATE' and old.approved_at is not null then
    new.approved_at := old.approved_at;
    new.approved_by := old.approved_by;
  end if;
  return new;
end;
$$;
comment on function private.guard_beo() is 'BEO approval needs hospitality.beo.approve, is never by the author, and is stamped once.';
revoke all on function private.guard_beo() from public, anon, authenticated;
create trigger t40_guard_beo before insert or update on app.beos for each row execute function private.guard_beo();
create trigger t39_beo_project before insert or update on app.beos
  for each row execute function private.assert_same_project('app.fulfillments', 'fulfillment_id');

create table app.beo_lines (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  beo_id uuid not null references app.beos (id),
  description text not null,
  quantity numeric not null default 1,
  unit_price_minor bigint,
  currency_code char(3) references private.currencies (currency_code),
  deleted_at timestamptz,
  constraint beo_lines_price_currency check (unit_price_minor is null or currency_code is not null)
);
create index beo_lines_beo_id_idx on app.beo_lines (beo_id);
create index beo_lines_currency_code_idx on app.beo_lines (currency_code);
call private.install_child_table('app.beo_lines', 'app.beos', 'beo_id', 'hospitality.fulfillment.read', 'hospitality.beo.write');
call private.describe('app.beo_lines', 'Menu and service lines of a BEO. A NULL price is unpriced.', array[
  'beo_id', 'BEO.', 'description', 'Menu item or service.', 'quantity', 'Quantity.', 'unit_price_minor', 'Unit price in minor units; NULL is unpriced.', 'currency_code', 'ISO 4217 currency.'
]);
