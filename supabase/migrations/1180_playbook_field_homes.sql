-- 1180_playbook_field_homes.sql
-- A51 Playbook field targets (RRR-96), finding A47-001 (Section 18 gate 14: every `field` target of the Playbook
-- column map exists in the schema). Section 2.1 says every column of a Production Template sheet becomes a field of
-- its target entity. Most Playbook columns map to a column the domain schema already has, or to one reached through
-- a foreign key; the facts below had no home at all, and the Playbook holds values for them:
--   * logistics: a shipment's URID, description, origin, counts, dimensions, weight, trailer, seal, bill of lading
--     and sender; the gate queue's vehicle type and driver; the marshalling log entry's URID
--   * show: a cue's segment, description and space, and its department calls (app.cue_calls, one row per call kind
--     instead of five repeating columns); the schedule record a running order belongs to
--   * safety: an inspection's URID
--   * procurement and finance: a purchase order's delivery date, payment terms, tax and shipping; a change order's
--     schedule and client impact; a vendor's default GL account and cost center; a budget line's phase and tier
--   * projects and schedule: a project's anchor date and budget envelope; a record's parent, WBS code, description,
--     governing SOP and canon team; a shift's scheduled break; a space's description
-- Every new column is nullable, so existing rows and writers are unaffected. Tenant references are checked for the
-- same org (Section 7.5 invariant 1) and, where both sides have a project, for the same project.

-- Cross-org reference trigger: add pairs to a table's existing t30 trigger ----------------------------------------

create or replace procedure private.add_cross_org_references(p_table regclass, p_pairs text[])
language plpgsql
set search_path = ''
as $$
declare
  v_existing text[];
  v_all text[];
  v_args text;
begin
  select array_remove(string_to_array(encode(t.tgargs, 'escape'), '\000'), '')
  into v_existing
  from pg_catalog.pg_trigger t
  where t.tgrelid = p_table and t.tgname = 't30_refuse_cross_org_reference';
  v_all := coalesce(v_existing, '{}') || p_pairs;
  select string_agg(format('%L', a), ', ' order by o) into v_args from unnest(v_all) with ordinality as u(a, o);
  execute format('drop trigger if exists t30_refuse_cross_org_reference on %s', p_table);
  execute format(
    'create trigger t30_refuse_cross_org_reference before insert or update on %s for each row execute function private.refuse_cross_org_reference(%s)',
    p_table, v_args);
end;
$$;

comment on procedure private.add_cross_org_references(regclass, text[]) is 'Extends a tenant table''s cross-org reference trigger with more pairs of referenced table and referencing column, keeping the pairs it already checks.';
revoke all on procedure private.add_cross_org_references(regclass, text[]) from public, anon, authenticated;

-- Logistics -------------------------------------------------------------------------------------------------------

alter table app.shipments
  add column urid text references xpms.dim_category (cat_urid),
  add column description text,
  add column origin text,
  add column sender_counterparty_id uuid references app.counterparties (id),
  add column pallet_count integer,
  add column piece_count integer,
  add column length_ft numeric(8, 2),
  add column width_ft numeric(8, 2),
  add column height_ft numeric(8, 2),
  add column weight_lb numeric(10, 2),
  add column trailer_license text,
  add column seal_identifier text,
  add column bill_of_lading_identifier text,
  add constraint shipments_description_length check (description is null or char_length(btrim(description)) between 1 and 2000),
  add constraint shipments_origin_length check (origin is null or char_length(btrim(origin)) between 1 and 200),
  add constraint shipments_counts check (coalesce(pallet_count, 0) >= 0 and coalesce(piece_count, 0) >= 0),
  add constraint shipments_dimensions check (coalesce(length_ft, 1) > 0 and coalesce(width_ft, 1) > 0 and coalesce(height_ft, 1) > 0),
  add constraint shipments_weight check (weight_lb is null or weight_lb >= 0),
  add constraint shipments_identifier_lengths check (
    coalesce(char_length(trailer_license), 1) between 1 and 40
    and coalesce(char_length(seal_identifier), 1) between 1 and 60
    and coalesce(char_length(bill_of_lading_identifier), 1) between 1 and 60);
create index shipments_urid_idx on app.shipments (urid);
create index shipments_sender_idx on app.shipments (sender_counterparty_id);
call private.add_cross_org_references('app.shipments', array['app.counterparties', 'sender_counterparty_id']);

comment on column app.shipments.urid is 'URID category the shipment serves (dimension 2), for example 5000.52.01.';
comment on column app.shipments.description is 'What the shipment carries, in a sentence.';
comment on column app.shipments.origin is 'Where the freight ships from, as a locality (Orlando, FL).';
comment on column app.shipments.sender_counterparty_id is 'Vendor sending the freight; the carrier is carrier_counterparty_id.';
comment on column app.shipments.pallet_count is 'Number of pallets.';
comment on column app.shipments.piece_count is 'Number of pieces.';
comment on column app.shipments.length_ft is 'Length of the load in feet.';
comment on column app.shipments.width_ft is 'Width of the load in feet.';
comment on column app.shipments.height_ft is 'Height of the load in feet.';
comment on column app.shipments.weight_lb is 'Weight of the load in pounds.';
comment on column app.shipments.trailer_license is 'License plate of the trailer, issued by a motor vehicle authority.';
comment on column app.shipments.seal_identifier is 'Number of the seal applied to the trailer.';
comment on column app.shipments.bill_of_lading_identifier is 'Bill of lading number issued by the carrier.';

alter table app.gate_queue
  add column vehicle_type text,
  add column driver_name text,
  add constraint gate_queue_vehicle_type_length check (vehicle_type is null or char_length(btrim(vehicle_type)) between 1 and 100),
  add constraint gate_queue_driver_name_length check (driver_name is null or char_length(btrim(driver_name)) between 1 and 200);
comment on column app.gate_queue.vehicle_type is 'Kind of vehicle at the gate, for example 53ft Tractor-Trailer.';
comment on column app.gate_queue.driver_name is 'Driver of the vehicle, as given at check-in.';

alter table app.marshalling_log add column urid text references xpms.dim_category (cat_urid);
create index marshalling_log_urid_idx on app.marshalling_log (urid);
comment on column app.marshalling_log.urid is 'URID category the logged movement serves (dimension 2).';

-- Show ------------------------------------------------------------------------------------------------------------

alter table app.run_of_show add column record_id uuid references app.records (id);
create index run_of_show_record_id_idx on app.run_of_show (record_id);
call private.add_cross_org_references('app.run_of_show', array['app.records', 'record_id']);
create trigger t41_run_of_show_record_project before insert or update of record_id on app.run_of_show
  for each row execute function private.assert_same_project('app.records', 'record_id');
comment on column app.run_of_show.record_id is 'Schedule record (usually the Event) the running order belongs to, in the same project.';

alter table app.cues
  add column segment text,
  add column description text,
  add column space_id uuid references app.spaces (id),
  add constraint cues_segment_length check (segment is null or char_length(btrim(segment)) between 1 and 200),
  add constraint cues_description_length check (description is null or char_length(btrim(description)) between 1 and 2000);
create index cues_space_id_idx on app.cues (space_id);
call private.add_cross_org_references('app.cues', array['app.spaces', 'space_id']);
comment on column app.cues.segment is 'Show segment the cue belongs to, for example Act II · Official Opening & Remarks.';
comment on column app.cues.description is 'What happens on the cue.';
comment on column app.cues.space_id is 'Space the cue happens in.';

create type app.cue_call_kind as enum ('Audio', 'Lighting', 'Video', 'Special Effects', 'Stage');
comment on type app.cue_call_kind is 'Department a cue call is given to.';

create table app.cue_calls (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  cue_id uuid not null references app.cues (id),
  call_kind app.cue_call_kind not null,
  instruction text not null,
  deleted_at timestamptz,
  constraint cue_calls_instruction_length check (char_length(btrim(instruction)) between 1 and 2000)
);
create unique index cue_calls_kind_key on app.cue_calls (cue_id, call_kind) where deleted_at is null;
call private.install_child_table('app.cue_calls', 'app.cues', 'cue_id', 'show.run_of_show.read', 'show.run_of_show.write');
call private.describe('app.cue_calls', 'Department calls of a cue: what audio, lighting, video, special effects and stage do on it, one row per department.', array[
  'cue_id', 'Cue the call belongs to.',
  'call_kind', 'Department the call is given to.',
  'instruction', 'What the department does on the cue.'
]);
call private.install_default_retention('app.cue_calls');

-- Safety ----------------------------------------------------------------------------------------------------------

alter table app.inspections add column urid text references xpms.dim_category (cat_urid);
create index inspections_urid_idx on app.inspections (urid);
comment on column app.inspections.urid is 'URID category the inspection covers (dimension 2), for example 5000.06.01.';

-- Procurement and finance -----------------------------------------------------------------------------------------

alter table app.purchase_orders
  add column delivery_due_on date,
  add column payment_terms_days integer,
  add column tax_minor bigint,
  add column shipping_minor bigint,
  add constraint purchase_orders_payment_terms check (payment_terms_days is null or payment_terms_days between 0 and 365),
  add constraint purchase_orders_charges check (coalesce(tax_minor, 0) >= 0 and coalesce(shipping_minor, 0) >= 0);
comment on column app.purchase_orders.delivery_due_on is 'Date the order is due to be delivered.';
comment on column app.purchase_orders.payment_terms_days is 'Days after invoice the order is payable (Net 30 is 30).';
comment on column app.purchase_orders.tax_minor is 'Tax on the order in minor units of currency_code; NULL when not stated (never coerced to 0).';
comment on column app.purchase_orders.shipping_minor is 'Shipping charged on the order in minor units of currency_code; NULL when not stated.';

alter table app.change_orders
  add column schedule_impact_days integer,
  add column client_impact text,
  add constraint change_orders_client_impact_length check (client_impact is null or char_length(btrim(client_impact)) between 1 and 500);
comment on column app.change_orders.schedule_impact_days is 'Days the change moves the schedule; negative when it pulls it in, zero for none.';
comment on column app.change_orders.client_impact is 'Effect of the change on the client, as stated.';

alter table app.vendors
  add column default_account_code text references xpms.dim_gl_account (account_code),
  add column default_cost_center_id uuid references app.cost_centers (id);
create index vendors_default_account_idx on app.vendors (default_account_code);
create index vendors_default_cost_center_idx on app.vendors (default_cost_center_id);
call private.add_cross_org_references('app.vendors', array['app.cost_centers', 'default_cost_center_id']);
comment on column app.vendors.default_account_code is 'GL account the vendor''s costs post to unless a line says otherwise.';
comment on column app.vendors.default_cost_center_id is 'Cost center (dimension 1) the vendor''s costs post to unless a line says otherwise.';

alter table app.budget_lines
  add column phase_code text references xpms.dim_phase (phase_code),
  add column tier_code text references xpms.dim_tier (tier_code);
create index budget_lines_phase_code_idx on app.budget_lines (phase_code);
create index budget_lines_tier_code_idx on app.budget_lines (tier_code);
comment on column app.budget_lines.phase_code is 'Gated phase the line is spent in (Section 3.4).';
comment on column app.budget_lines.tier_code is 'Tier of experience the line serves (Section 3.5).';

-- Projects and schedule -------------------------------------------------------------------------------------------

alter table app.projects
  add column anchor_on date,
  add column budget_envelope_minor bigint,
  add constraint projects_budget_envelope check (budget_envelope_minor is null or budget_envelope_minor >= 0);
comment on column app.projects.anchor_on is 'Anchor date (usually the show day) that template day offsets count from.';
comment on column app.projects.budget_envelope_minor is 'Budget envelope approved for the project, in minor units of currency; NULL when none is set.';

alter table app.records
  add column parent_record_id uuid references app.records (id),
  add column wbs_code text,
  add column description text,
  add column sop_id uuid references app.sops (id),
  add column team_code text references xpms.dim_team (team_id),
  add constraint records_parent_not_self check (parent_record_id is distinct from id),
  add constraint records_wbs_code_format check (wbs_code is null or wbs_code ~ '^[0-9]+(\.[0-9]+)*$'),
  add constraint records_description_length check (description is null or char_length(btrim(description)) between 1 and 4000);
create index records_parent_record_id_idx on app.records (parent_record_id);
create index records_sop_id_idx on app.records (sop_id);
create index records_team_code_idx on app.records (team_code);
call private.add_cross_org_references('app.records', array['app.records', 'parent_record_id', 'app.sops', 'sop_id']);
create trigger t41_records_parent_project before insert or update of parent_record_id on app.records
  for each row execute function private.assert_same_project('app.records', 'parent_record_id');
comment on column app.records.parent_record_id is 'Summary record this record rolls up to, in the same project (work breakdown).';
comment on column app.records.wbs_code is 'Work breakdown structure code, dot separated (1.2.1).';
comment on column app.records.description is 'What the record involves, in sentence case.';
comment on column app.records.sop_id is 'Standard operating procedure that governs the work.';
comment on column app.records.team_code is 'Canon team (Bible teams) that does the work.';

alter table app.shifts
  add column scheduled_break_minutes integer,
  add constraint shifts_scheduled_break check (scheduled_break_minutes is null or scheduled_break_minutes between 0 and 1440);
comment on column app.shifts.scheduled_break_minutes is 'Meal break scheduled within the shift, in minutes.';

alter table app.spaces
  add column description text,
  add constraint spaces_description_length check (description is null or char_length(btrim(description)) between 1 and 2000);
comment on column app.spaces.description is 'What the space is used for.';
