-- 0492_submittals_sponsor_assets.sql
-- A16 Procurement and Vendors (ADR 0022 range 0490 to 0499).
--   * Submittals (Section 4.4.4 Vendor, the source of Gateway's vendor submittals tab): what a vendor
--     submits for review on a project, optionally against a purchase order: shop drawings, product data,
--     samples, method statements. Reviewed by someone other than the submitter (sod_approval_requester);
--     a returned submittal is revised and resubmitted with its revision number raised.
--   * Sponsor assets (Section 4.4.4 Sponsor: asset approvals): brand assets a sponsor entitlement needs
--     (logo, artwork, copy, video), approved or returned by someone other than the uploader.
--   * Entitlement deliveries and the proof-of-performance view (gate 8 sponsor obligations): each
--     delivery of an entitlement with the quantity delivered, rolled up per entitlement against what is
--     owed. Photos and files ride on A18's attachments, keyed by subject table and id (late slot 0995).

-- Enums and rules -------------------------------------------------------------------------------------

create type app.submittal_kind as enum ('Shop Drawing', 'Product Data', 'Sample', 'Method Statement', 'Certificate', 'Other');
comment on type app.submittal_kind is 'What a submittal carries.';

create type app.review_state as enum ('Proposed', 'Submitted', 'Approved', 'Returned', 'Canceled');
comment on type app.review_state is 'Review lifecycle of submittals and sponsor assets: drafted, Submitted for review, Approved, Returned for revision (resubmitted from there), or Canceled.';

create type app.sponsor_asset_kind as enum ('Logo', 'Artwork', 'Copy', 'Video', 'Other');
comment on type app.sponsor_asset_kind is 'Kind of brand asset a sponsor supplies.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('submittal', 'Proposed', 'Submitted'),
  ('submittal', 'Proposed', 'Canceled'),
  ('submittal', 'Submitted', 'Approved'),
  ('submittal', 'Submitted', 'Returned'),
  ('submittal', 'Submitted', 'Canceled'),
  ('submittal', 'Returned', 'Submitted'),
  ('submittal', 'Returned', 'Canceled'),
  ('sponsor_asset', 'Proposed', 'Submitted'),
  ('sponsor_asset', 'Proposed', 'Canceled'),
  ('sponsor_asset', 'Submitted', 'Approved'),
  ('sponsor_asset', 'Submitted', 'Returned'),
  ('sponsor_asset', 'Submitted', 'Canceled'),
  ('sponsor_asset', 'Returned', 'Submitted'),
  ('sponsor_asset', 'Returned', 'Canceled');

insert into private.domain_event_types (code, subject, description) values
  ('submittal.state_changed', 'submittals', 'A submittal was submitted, approved, returned or canceled.'),
  ('sponsor_asset.state_changed', 'sponsor_assets', 'A sponsor asset was submitted, approved, returned or canceled.'),
  ('entitlement_delivery.recorded', 'entitlement_deliveries', 'A delivery of a sponsor entitlement was recorded.');

-- Submittals --------------------------------------------------------------------------------------------

create table app.submittals (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  submittal_number bigint not null default 0,
  vendor_id uuid not null references app.vendors (id),
  purchase_order_id uuid references app.purchase_orders (id),
  submittal_kind app.submittal_kind not null,
  title text not null,
  spec_reference text,
  due_on date,
  revision integer not null default 0,
  submittal_state app.review_state not null default 'Proposed',
  decided_by uuid references app.people (id),
  decided_at timestamptz,
  deleted_at timestamptz,
  constraint submittals_title_length check (char_length(btrim(title)) between 1 and 200),
  constraint submittals_spec_length check (spec_reference is null or char_length(btrim(spec_reference)) between 1 and 100),
  constraint submittals_revision_nonnegative check (revision >= 0),
  constraint submittals_decision_pair check ((decided_by is null) = (decided_at is null))
);

create unique index submittals_project_number_key on app.submittals (project_id, submittal_number);
create index submittals_vendor_id_idx on app.submittals (vendor_id);
create index submittals_purchase_order_id_idx on app.submittals (purchase_order_id);
create index submittals_decided_by_idx on app.submittals (decided_by);

call private.install_domain_table('app.submittals', 'app.projects', 'project_id',
  array['app.vendors', 'vendor_id', 'app.purchase_orders', 'purchase_order_id']);
call private.describe('app.submittals', 'What a vendor submits for review on a project (Section 4.4.4 Vendor): shop drawings, product data, samples, method statements and certificates. Reviewed by someone other than the submitter; files ride on attachments.', array[
  'project_id', 'Project the submittal belongs to.',
  'submittal_number', 'Number from the project''s display key sequence, issued on insert.',
  'vendor_id', 'Vendor submitting.',
  'purchase_order_id', 'Purchase order of the same project the submittal supports, when there is one.',
  'submittal_kind', 'What the submittal carries.',
  'title', 'What is submitted.',
  'spec_reference', 'Specification section or drawing reference the submittal answers.',
  'due_on', 'When the submittal is due for review.',
  'revision', 'Revision number: 0 for the first submission, raised on each resubmission after a return.',
  'submittal_state', 'Review state. Changes only through app.transition_submittal.',
  'decided_by', 'Person who last approved or returned the submittal.',
  'decided_at', 'When it was last approved or returned.'
]);

call private.install_lifecycle('app.submittals', 'submittal_id', 'submittal_state', 'submittal', 'Proposed',
  $$submittal_id in (select s.id from app.submittals s where s.project_id in (select private.project_ids_with('procurement.po.read')))$$);

create trigger t35_submittal_number before insert or update on app.submittals
  for each row execute function private.number_from_project_sequence('submittal_number');

create trigger t90_emit_submittal_state after insert on app.submittal_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('submittal.state_changed', 'submittals', 'submittal_id', 'from_state', 'to_state', 'reason');

create or replace function private.guard_review_subject()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation text := tg_argv[0];
  v_new jsonb := to_jsonb(new);
  v_old jsonb;
begin
  if tg_op = 'INSERT' then
    if v_new ->> 'decided_by' is not null or coalesce((v_new ->> 'revision')::integer, 0) <> 0 then
      perform private.refuse('review_decide_rpc', 'Reviews are decided through their transition RPC.');
    end if;
    return new;
  end if;
  v_old := to_jsonb(old);
  if (v_new -> 'decided_by' is distinct from v_old -> 'decided_by'
      or v_new -> 'decided_at' is distinct from v_old -> 'decided_at'
      or v_new -> 'revision' is distinct from v_old -> 'revision')
     and not private.in_trusted_operation(v_operation) then
    perform private.refuse('review_decide_rpc', 'Reviews are decided through their transition RPC.');
  end if;
  return new;
end;
$$;

comment on function private.guard_review_subject() is 'Submittals and sponsor assets: decision columns and the revision number change only inside their transition RPC (argument: the trusted operation).';

create trigger t40_guard_submittal before insert or update on app.submittals
  for each row execute function private.guard_review_subject('submittal_review');

create or replace function private.guard_submittal_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.purchase_order_id is not null and (
    select po.project_id from app.purchase_orders po where po.id = new.purchase_order_id
  ) is distinct from new.project_id then
    perform private.refuse('submittal_order_project', 'A submittal supports a purchase order of its own project.');
  end if;
  if tg_op = 'UPDATE' and (new.project_id <> old.project_id or new.vendor_id <> old.vendor_id) then
    perform private.refuse('submittal_immutable', 'A submittal keeps its project and vendor.');
  end if;
  return new;
end;
$$;

comment on function private.guard_submittal_order() is 'Submittals: a linked purchase order is of the same project; project and vendor never change.';

create trigger t41_guard_submittal_order before insert or update on app.submittals
  for each row execute function private.guard_submittal_order();

create or replace function app.transition_submittal(p_submittal_id uuid, p_expected app.review_state, p_next app.review_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_row app.submittals;
  v_entry uuid;
begin
  select * into v_row from app.submittals s where s.id = p_submittal_id and s.deleted_at is null for update;
  if v_row.id is null or not private.can_on_project(v_row.project_id, 'procurement.po.write') then
    raise exception using errcode = '42501', message = 'procurement.po.write is required on the project';
  end if;
  if p_next in ('Approved', 'Returned') then
    perform private.assert_separation('sod_approval_requester', v_person, v_row.created_by);
  end if;
  v_entry := private.transition_lifecycle('submittal', 'app.submittals', 'submittal_state', 'app.submittal_state_transitions',
    'submittal_id', p_submittal_id, p_expected::text, p_next::text, p_reason);
  perform private.begin_trusted_operation('submittal_review');
  if p_next in ('Approved', 'Returned') then
    update app.submittals set decided_by = v_person, decided_at = now() where id = p_submittal_id;
  elsif p_expected = 'Returned' and p_next = 'Submitted' then
    update app.submittals set revision = revision + 1 where id = p_submittal_id;
  end if;
  perform private.end_trusted_operation('submittal_review');
  return v_entry;
end;
$$;

comment on function app.transition_submittal(uuid, app.review_state, app.review_state, text) is 'Submits, approves, returns or cancels a submittal with compare-and-set: procurement.po.write on the project; approving or returning is never done by the person who created it (sod_approval_requester); resubmitting after a return raises the revision.';

-- Sponsor assets -------------------------------------------------------------------------------------------

create table app.sponsor_assets (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  sponsor_entitlement_id uuid not null references app.sponsor_entitlements (id),
  asset_kind app.sponsor_asset_kind not null,
  title text not null,
  usage_note text,
  due_on date,
  revision integer not null default 0,
  asset_state app.review_state not null default 'Proposed',
  decided_by uuid references app.people (id),
  decided_at timestamptz,
  deleted_at timestamptz,
  constraint sponsor_assets_title_length check (char_length(btrim(title)) between 1 and 200),
  constraint sponsor_assets_usage_length check (usage_note is null or char_length(btrim(usage_note)) between 1 and 1000),
  constraint sponsor_assets_revision_nonnegative check (revision >= 0),
  constraint sponsor_assets_decision_pair check ((decided_by is null) = (decided_at is null))
);

create index sponsor_assets_entitlement_idx on app.sponsor_assets (sponsor_entitlement_id);
create index sponsor_assets_decided_by_idx on app.sponsor_assets (decided_by);

call private.install_domain_table('app.sponsor_assets', 'app.sponsor_entitlements', 'sponsor_entitlement_id');
call private.describe('app.sponsor_assets', 'Brand assets a sponsor entitlement needs (Section 4.4.4 Sponsor: asset approvals): logo, artwork, copy or video, approved or returned by someone other than the uploader. Files ride on attachments.', array[
  'sponsor_entitlement_id', 'Entitlement the asset is for.',
  'asset_kind', 'Kind of asset.',
  'title', 'What the asset is.',
  'usage_note', 'Where and how the asset is used.',
  'due_on', 'When the asset is needed.',
  'revision', 'Revision number, raised on each resubmission after a return.',
  'asset_state', 'Review state. Changes only through app.transition_sponsor_asset.',
  'decided_by', 'Person who last approved or returned the asset.',
  'decided_at', 'When it was last approved or returned.'
]);

call private.install_lifecycle('app.sponsor_assets', 'sponsor_asset_id', 'asset_state', 'sponsor_asset', 'Proposed',
  $$sponsor_asset_id in (select a.id from app.sponsor_assets a join app.sponsor_entitlements s on s.id = a.sponsor_entitlement_id
    where s.project_id in (select private.project_ids_with('vendors.vendor.read')))$$);

create trigger t40_guard_sponsor_asset before insert or update on app.sponsor_assets
  for each row execute function private.guard_review_subject('sponsor_asset_review');

create trigger t90_emit_sponsor_asset_state after insert on app.sponsor_asset_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('sponsor_asset.state_changed', 'sponsor_assets', 'sponsor_asset_id', 'from_state', 'to_state', 'reason');

create or replace function app.transition_sponsor_asset(p_sponsor_asset_id uuid, p_expected app.review_state, p_next app.review_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_row app.sponsor_assets;
  v_project uuid;
  v_entry uuid;
begin
  select * into v_row from app.sponsor_assets a where a.id = p_sponsor_asset_id and a.deleted_at is null for update;
  v_project := (select s.project_id from app.sponsor_entitlements s where s.id = v_row.sponsor_entitlement_id);
  if v_row.id is null or not private.can_on_project(v_project, 'vendors.entitlement.write') then
    raise exception using errcode = '42501', message = 'vendors.entitlement.write is required on the project';
  end if;
  if p_next in ('Approved', 'Returned') then
    perform private.assert_separation('sod_approval_requester', v_person, v_row.created_by);
  end if;
  v_entry := private.transition_lifecycle('sponsor_asset', 'app.sponsor_assets', 'asset_state', 'app.sponsor_asset_state_transitions',
    'sponsor_asset_id', p_sponsor_asset_id, p_expected::text, p_next::text, p_reason);
  perform private.begin_trusted_operation('sponsor_asset_review');
  if p_next in ('Approved', 'Returned') then
    update app.sponsor_assets set decided_by = v_person, decided_at = now() where id = p_sponsor_asset_id;
  elsif p_expected = 'Returned' and p_next = 'Submitted' then
    update app.sponsor_assets set revision = revision + 1 where id = p_sponsor_asset_id;
  end if;
  perform private.end_trusted_operation('sponsor_asset_review');
  return v_entry;
end;
$$;

comment on function app.transition_sponsor_asset(uuid, app.review_state, app.review_state, text) is 'Submits, approves, returns or cancels a sponsor asset with compare-and-set: vendors.entitlement.write on the project; approving or returning is never done by the uploader (sod_approval_requester).';

-- Entitlement deliveries and proof of performance ----------------------------------------------------------

create table app.entitlement_deliveries (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  sponsor_entitlement_id uuid not null references app.sponsor_entitlements (id),
  delivered_on date not null,
  quantity_delivered numeric,
  note text,
  recorded_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint entitlement_deliveries_quantity_nonnegative check (quantity_delivered is null or quantity_delivered >= 0),
  constraint entitlement_deliveries_note_length check (note is null or char_length(btrim(note)) between 1 and 1000)
);

create index entitlement_deliveries_entitlement_idx on app.entitlement_deliveries (sponsor_entitlement_id, delivered_on);
create index entitlement_deliveries_recorded_by_idx on app.entitlement_deliveries (recorded_by);

call private.install_domain_table('app.entitlement_deliveries', 'app.sponsor_entitlements', 'sponsor_entitlement_id');
call private.describe('app.entitlement_deliveries', 'Each delivery of a sponsor entitlement (gate 8 sponsor obligations), with the quantity delivered and who recorded it. Photos ride on attachments.', array[
  'sponsor_entitlement_id', 'Entitlement delivered.',
  'delivered_on', 'Day of the delivery.',
  'quantity_delivered', 'How many were delivered, when the entitlement is countable; NULL when not counted.',
  'note', 'What was delivered and where.',
  'recorded_by', 'Person who recorded the delivery, from the session.'
]);

create or replace function private.stamp_entitlement_delivery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.recorded_by := coalesce(private.current_person_id(), new.recorded_by);
  elsif new.sponsor_entitlement_id <> old.sponsor_entitlement_id or new.recorded_by is distinct from old.recorded_by then
    perform private.refuse('entitlement_delivery_immutable', 'A delivery keeps its entitlement and recorder.');
  end if;
  return new;
end;
$$;

comment on function private.stamp_entitlement_delivery() is 'Entitlement deliveries: the recorder comes from the session; entitlement and recorder never change.';

create trigger t40_stamp_entitlement_delivery before insert or update on app.entitlement_deliveries
  for each row execute function private.stamp_entitlement_delivery();
create trigger t90_emit_entitlement_delivery after insert on app.entitlement_deliveries
  for each row execute function private.emit_subject_event('entitlement_delivery.recorded', 'entitlement_deliveries', 'id', 'sponsor_entitlement_id', 'delivered_on', 'quantity_delivered');

create view app.sponsor_proof_of_performance with (security_invoker = true) as
select s.id as sponsor_entitlement_id, s.project_id, s.counterparty_id, s.description, s.quantity as quantity_owed,
  s.due_on, s.fulfilled_at,
  count(d.id) as delivery_count,
  case when count(d.id) = 0 then null
       when count(d.id) filter (where d.quantity_delivered is null) > 0 then null
       else sum(d.quantity_delivered) end as quantity_delivered,
  max(d.delivered_on) as last_delivered_on,
  case when s.quantity is null then s.fulfilled_at is not null
       else coalesce(sum(d.quantity_delivered) filter (where d.quantity_delivered is not null), 0) >= s.quantity end as is_met
from app.sponsor_entitlements s
left join app.entitlement_deliveries d on d.sponsor_entitlement_id = s.id and d.deleted_at is null
where s.deleted_at is null
group by s.id, s.project_id, s.counterparty_id, s.description, s.quantity, s.due_on, s.fulfilled_at;

call private.describe('app.sponsor_proof_of_performance', 'Proof of performance per sponsor entitlement (gate 8): what is owed against what was delivered, NULL-aware. A countable entitlement is met when the counted deliveries reach the quantity owed; an uncountable one when it is marked fulfilled.', array[
  'sponsor_entitlement_id', 'Entitlement.',
  'project_id', 'Project.',
  'counterparty_id', 'Sponsor.',
  'description', 'The entitlement.',
  'quantity_owed', 'How many are owed; NULL when not countable.',
  'due_on', 'When owed.',
  'fulfilled_at', 'When it was marked delivered.',
  'delivery_count', 'Deliveries recorded.',
  'quantity_delivered', 'Sum delivered; NULL when there are no deliveries or any delivery was not counted.',
  'last_delivered_on', 'Most recent delivery.',
  'is_met', 'True when the entitlement is delivered in full.'
]);
revoke all on app.sponsor_proof_of_performance from public, anon;
grant select on app.sponsor_proof_of_performance to authenticated, service_role;

-- Policies and privileges -----------------------------------------------------------------------------------

call private.install_policies('app.submittals',
  $$project_id in (select private.project_ids_with('procurement.po.read'))$$,
  $$project_id in (select private.project_ids_with('procurement.po.write'))$$);
call private.install_policies('app.sponsor_assets',
  $$sponsor_entitlement_id in (select s.id from app.sponsor_entitlements s where s.project_id in (select private.project_ids_with('vendors.vendor.read')))$$,
  $$sponsor_entitlement_id in (select s.id from app.sponsor_entitlements s where s.project_id in (select private.project_ids_with('vendors.entitlement.write')))$$);
call private.install_policies('app.entitlement_deliveries',
  $$sponsor_entitlement_id in (select s.id from app.sponsor_entitlements s where s.project_id in (select private.project_ids_with('vendors.vendor.read')))$$,
  $$sponsor_entitlement_id in (select s.id from app.sponsor_entitlements s where s.project_id in (select private.project_ids_with('vendors.entitlement.write')))$$);

revoke all on function private.guard_review_subject() from public, anon, authenticated;
revoke all on function private.guard_submittal_order() from public, anon, authenticated;
revoke all on function private.stamp_entitlement_delivery() from public, anon, authenticated;
revoke all on function app.transition_submittal(uuid, app.review_state, app.review_state, text) from public, anon;
revoke all on function app.transition_sponsor_asset(uuid, app.review_state, app.review_state, text) from public, anon;
grant execute on function app.transition_submittal(uuid, app.review_state, app.review_state, text) to authenticated, service_role;
grant execute on function app.transition_sponsor_asset(uuid, app.review_state, app.review_state, text) to authenticated, service_role;
