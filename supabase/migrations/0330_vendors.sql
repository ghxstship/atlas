-- 0330_vendors.sql
-- A03 Domain Data. Vendors (Section 7.4 Vendors, Section 8.2, Section 8.3): the vendor facet of a
-- counterparty with its lifecycle, vendor classes and assignments, bank accounts with Restricted
-- columns masked unless the caller holds data.restricted.read.banking, the bank detail edit log that
-- feeds sod_vendor_payment, prequalifications, insurance certificates, scorecards and sponsor
-- entitlements. Also the column classification registry for the Restricted columns this range adds.

-- Column classification registry (Section 8.3) ------------------------------------------------------

create type app.data_classification as enum ('Public', 'Internal', 'Confidential', 'Restricted');
comment on type app.data_classification is 'Column classifications (Section 8.3), least to most sensitive.';

create table private.column_classifications (
  table_name text not null,
  column_name text not null,
  classification app.data_classification not null,
  read_capability text references app.capabilities (code),
  primary key (table_name, column_name),
  constraint column_classifications_restricted_capability check ((classification = 'Restricted') = (read_capability is not null))
);

create index column_classifications_read_capability_idx on private.column_classifications (read_capability);

comment on table private.column_classifications is 'Classification of columns above Internal (Section 8.3). Restricted columns name the capability that unmasks them; views mask them for everyone else and say so.';
comment on column private.column_classifications.table_name is 'Schema-qualified table, for example app.vendor_bank_accounts.';
comment on column private.column_classifications.column_name is 'Column.';
comment on column private.column_classifications.classification is 'Public, Internal, Confidential or Restricted.';
comment on column private.column_classifications.read_capability is 'Capability that unmasks a Restricted column, for example data.restricted.read.banking.';

alter table private.column_classifications enable row level security;
revoke all on private.column_classifications from public, anon, authenticated;
grant select on private.column_classifications to service_role;

create view app.column_classifications as
select c.table_name, c.column_name, c.classification, c.read_capability from private.column_classifications c;

call private.describe('app.column_classifications', 'Columns classified above Internal and the capability that unmasks each Restricted one (Section 8.3).', array[
  'table_name', 'Table.',
  'column_name', 'Column.',
  'classification', 'Classification.',
  'read_capability', 'Capability that unmasks a Restricted column.'
]);
revoke all on app.column_classifications from public, anon;
grant select on app.column_classifications to authenticated, service_role;

-- Enums and rules ---------------------------------------------------------------------------------------

create type app.vendor_state as enum ('Prospect', 'Onboarded', 'Active', 'Blocked', 'Canceled');
comment on type app.vendor_state is 'Vendor lifecycle in the shared vocabulary with the Vendor family extensions Prospect and Onboarded (Bible tab 37). A Blocked or Canceled vendor takes no new purchase orders.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('vendor', 'Prospect', 'Onboarded'),
  ('vendor', 'Prospect', 'Canceled'),
  ('vendor', 'Onboarded', 'Active'),
  ('vendor', 'Onboarded', 'Blocked'),
  ('vendor', 'Onboarded', 'Canceled'),
  ('vendor', 'Active', 'Blocked'),
  ('vendor', 'Active', 'Canceled'),
  ('vendor', 'Blocked', 'Active'),
  ('vendor', 'Blocked', 'Canceled');

insert into private.domain_event_types (code, subject, description) values
  ('vendor.state_changed', 'vendors', 'A vendor moved to another vendor state.'),
  ('vendor.prequalified', 'prequalifications', 'A vendor prequalification was decided.');

-- Vendors ------------------------------------------------------------------------------------------------

create table app.vendors (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  counterparty_id uuid not null references app.counterparties (id),
  vendor_state app.vendor_state not null default 'Prospect',
  payment_terms_days integer,
  default_currency_code char(3) references private.currencies (currency_code),
  deleted_at timestamptz,
  constraint vendors_terms_nonnegative check (payment_terms_days is null or payment_terms_days >= 0)
);

create unique index vendors_counterparty_key on app.vendors (counterparty_id) where deleted_at is null;
create index vendors_default_currency_code_idx on app.vendors (default_currency_code);

call private.install_domain_table('app.vendors', 'app.counterparties', 'counterparty_id');
call private.describe('app.vendors', 'The vendor facet of a counterparty (Section 7.4: a party with a vendor facet), one per counterparty. The person who creates a vendor cannot approve payment to it (sod_vendor_payment).', array[
  'counterparty_id', 'Counterparty the vendor facet belongs to.',
  'vendor_state', 'Vendor lifecycle state. Changes only through app.transition_vendor.',
  'payment_terms_days', 'Days after invoice the vendor is paid.',
  'default_currency_code', 'ISO 4217 currency the vendor bills in by default.'
]);

call private.install_lifecycle('app.vendors', 'vendor_id', 'vendor_state', 'vendor', 'Prospect',
  $$org_id in (select private.orgs_with_capability('vendors.vendor.read'))$$);

create trigger t90_emit_vendor_state after insert on app.vendor_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('vendor.state_changed', 'vendors', 'vendor_id', 'from_state', 'to_state', 'reason');

create or replace function app.transition_vendor(p_vendor_id uuid, p_expected app.vendor_state, p_next app.vendor_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select v.org_id from app.vendors v where v.id = p_vendor_id);
begin
  perform private.require_person();
  if v_org is null or not private.has_capability(v_org, 'vendors.vendor.write') then
    raise exception using errcode = '42501', message = 'vendors.vendor.write is required';
  end if;
  return private.transition_lifecycle('vendor', 'app.vendors', 'vendor_state', 'app.vendor_state_transitions',
    'vendor_id', p_vendor_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_vendor(uuid, app.vendor_state, app.vendor_state, text) is 'Moves a vendor along Prospect, Onboarded, Active, Blocked, Canceled with compare-and-set. Needs vendors.vendor.write.';

-- Vendor classes ------------------------------------------------------------------------------------------

create table app.vendor_classes (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  std_vendor_class_id text references xpms.std_vendor_class (record_id),
  description text,
  deleted_at timestamptz,
  constraint vendor_classes_name_length check (char_length(btrim(name)) between 1 and 100)
);

create unique index vendor_classes_org_name_key on app.vendor_classes (org_id, lower(name)) where deleted_at is null;
create index vendor_classes_std_vendor_class_id_idx on app.vendor_classes (std_vendor_class_id);

call private.install_domain_table('app.vendor_classes');
call private.describe('app.vendor_classes', 'Vendor classes an org sorts its vendors into, optionally adopted from the Standard Library class.', array[
  'name', 'Class name, unique within the org ignoring case.',
  'std_vendor_class_id', 'Standard Library vendor class the org adopted.',
  'description', 'What the class covers.'
]);

create table app.vendor_class_assignments (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  vendor_id uuid not null references app.vendors (id),
  vendor_class_id uuid not null references app.vendor_classes (id),
  deleted_at timestamptz
);

create index vendor_class_assignments_vendor_id_idx on app.vendor_class_assignments (vendor_id);
create index vendor_class_assignments_vendor_class_id_idx on app.vendor_class_assignments (vendor_class_id);
create unique index vendor_class_assignments_pair_key on app.vendor_class_assignments (vendor_id, vendor_class_id) where deleted_at is null;

call private.install_domain_table('app.vendor_class_assignments', 'app.vendors', 'vendor_id', array['app.vendor_classes', 'vendor_class_id']);
call private.describe('app.vendor_class_assignments', 'Which classes a vendor belongs to; a vendor may hold several.', array[
  'vendor_id', 'Vendor.',
  'vendor_class_id', 'Class of the same org.'
]);

-- Bank accounts (Restricted, Section 8.3) ---------------------------------------------------------------------

create table app.vendor_bank_accounts (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  vendor_id uuid not null references app.vendors (id),
  bank_name text not null,
  account_holder text not null,
  account_last4 text not null,
  account_number text not null,
  routing_number text,
  deleted_at timestamptz,
  constraint vendor_bank_accounts_last4_format check (account_last4 ~ '^[0-9A-Z]{4}$'),
  constraint vendor_bank_accounts_last4_matches check (right(regexp_replace(upper(account_number), '[^0-9A-Z]', '', 'g'), 4) = account_last4)
);

create index vendor_bank_accounts_vendor_id_idx on app.vendor_bank_accounts (vendor_id);

call private.install_domain_table('app.vendor_bank_accounts', 'app.vendors', 'vendor_id');
call private.describe('app.vendor_bank_accounts', 'Bank accounts a vendor is paid into. Account and routing numbers are Restricted: authenticated callers cannot select them and read them through app.vendor_bank_accounts_masked. Every editor is logged for sod_vendor_payment.', array[
  'vendor_id', 'Vendor paid into the account.',
  'bank_name', 'Bank name.',
  'account_holder', 'Name on the account.',
  'account_last4', 'Last four characters of the account number, shown to everyone who reads vendors.',
  'account_number', 'Full account number. Restricted (data.restricted.read.banking).',
  'routing_number', 'Routing or sort code. Restricted (data.restricted.read.banking).'
]);

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.vendor_bank_accounts', 'account_number', 'Restricted', 'data.restricted.read.banking'),
  ('app.vendor_bank_accounts', 'routing_number', 'Restricted', 'data.restricted.read.banking');

create table app.vendor_bank_detail_changes (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  vendor_id uuid not null references app.vendors (id),
  vendor_bank_account_id uuid not null references app.vendor_bank_accounts (id),
  changed_by uuid references app.people (id)
);

create index vendor_bank_detail_changes_vendor_id_idx on app.vendor_bank_detail_changes (vendor_id, changed_by);
create index vendor_bank_detail_changes_account_idx on app.vendor_bank_detail_changes (vendor_bank_account_id);
create index vendor_bank_detail_changes_changed_by_idx on app.vendor_bank_detail_changes (changed_by);

call private.install_domain_table('app.vendor_bank_detail_changes', 'app.vendors', 'vendor_id', array['app.vendor_bank_accounts', 'vendor_bank_account_id'], true);
call private.describe('app.vendor_bank_detail_changes', 'Append-only log of every person who created or edited a vendor''s bank details. Anyone listed here cannot approve payment to the vendor (sod_vendor_payment).', array[
  'vendor_id', 'Vendor whose bank details changed.',
  'vendor_bank_account_id', 'Bank account that changed.',
  'changed_by', 'Person who made the change, from the session.'
]);

create or replace function private.log_bank_detail_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.vendor_id <> old.vendor_id then
    perform private.refuse('bank_account_vendor_immutable', 'A bank account stays with its vendor.');
  end if;
  insert into app.vendor_bank_detail_changes (vendor_id, vendor_bank_account_id, changed_by)
  values (new.vendor_id, new.id, private.current_person_id());
  return null;
end;
$$;

comment on function private.log_bank_detail_change() is 'After insert or update on vendor bank accounts: logs the editor for sod_vendor_payment.';

create trigger t85_log_bank_detail_change after insert or update on app.vendor_bank_accounts
  for each row execute function private.log_bank_detail_change();

create view app.vendor_bank_accounts_masked as
select b.id, b.org_id, b.vendor_id, b.bank_name, b.account_holder, b.account_last4,
  case when private.has_capability(b.org_id, 'data.restricted.read.banking') then b.account_number end as account_number,
  case when private.has_capability(b.org_id, 'data.restricted.read.banking') then b.routing_number end as routing_number,
  not private.has_capability(b.org_id, 'data.restricted.read.banking') as is_masked
from app.vendor_bank_accounts b
where b.deleted_at is null
  and b.org_id in (select private.orgs_with_capability('vendors.vendor.read'));

call private.describe('app.vendor_bank_accounts_masked', 'Vendor bank accounts with the Restricted numbers masked (NULL with is_masked true) unless the caller holds data.restricted.read.banking (Section 8.3). Rows are limited to orgs where the caller reads vendors.', array[
  'id', 'Bank account.',
  'org_id', 'Org.',
  'vendor_id', 'Vendor.',
  'bank_name', 'Bank name.',
  'account_holder', 'Name on the account.',
  'account_last4', 'Last four characters of the account number.',
  'account_number', 'Full account number, or NULL when masked.',
  'routing_number', 'Routing number, or NULL when masked.',
  'is_masked', 'True when the Restricted numbers are withheld from the caller.'
]);
revoke all on app.vendor_bank_accounts_masked from public, anon;
grant select on app.vendor_bank_accounts_masked to authenticated, service_role;

-- Payment separation now covers vendor creators and bank detail editors ------------------------------------------

create or replace function private.assert_payment_separation(p_approver uuid, p_counterparty_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from app.counterparties c where c.id = p_counterparty_id and c.created_by = p_approver)
     or exists (select 1 from app.vendors v where v.counterparty_id = p_counterparty_id and v.created_by = p_approver)
     or exists (select 1 from app.vendor_bank_detail_changes ch join app.vendors v on v.id = ch.vendor_id
                where v.counterparty_id = p_counterparty_id and ch.changed_by = p_approver) then
    perform private.assert_separation('sod_vendor_payment', p_approver, p_approver);
  end if;
end;
$$;

comment on function private.assert_payment_separation(uuid, uuid) is 'Section 8.2 sod_vendor_payment: whoever created the counterparty or its vendor facet, or ever created or edited its bank details, cannot approve payment to it.';

-- Prequalifications -------------------------------------------------------------------------------------------------

create table app.prequalifications (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  vendor_id uuid not null references app.vendors (id),
  scope_note text not null,
  decision app.approval_decision,
  decided_by uuid references app.people (id),
  decided_at timestamptz,
  valid_to date,
  deleted_at timestamptz,
  constraint prequalifications_scope_length check (char_length(btrim(scope_note)) between 1 and 1000),
  constraint prequalifications_decision_complete check ((decision is null) = (decided_at is null) and (decision is null) = (decided_by is null))
);

create index prequalifications_vendor_id_idx on app.prequalifications (vendor_id);
create index prequalifications_decided_by_idx on app.prequalifications (decided_by);

call private.install_domain_table('app.prequalifications', 'app.vendors', 'vendor_id');
call private.describe('app.prequalifications', 'Vendor prequalifications. Decided through app.decide_prequalification by someone holding vendors.prequalification.approve who did not request it.', array[
  'vendor_id', 'Vendor being prequalified.',
  'scope_note', 'What the vendor is being prequalified for.',
  'decision', 'Approved or Rejected; NULL while pending.',
  'decided_by', 'Person who decided.',
  'decided_at', 'When it was decided.',
  'valid_to', 'Last day an approval holds.'
]);

create or replace function private.guard_prequalification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.decision is not null and not private.in_trusted_operation('prequalification_decision') then
      perform private.refuse('prequalification_decide_rpc', 'A prequalification is decided through app.decide_prequalification.');
    end if;
  elsif (new.decision is distinct from old.decision or new.decided_by is distinct from old.decided_by
         or new.decided_at is distinct from old.decided_at) and not private.in_trusted_operation('prequalification_decision') then
    perform private.refuse('prequalification_decide_rpc', 'A prequalification is decided through app.decide_prequalification.');
  end if;
  return new;
end;
$$;

comment on function private.guard_prequalification() is 'Prequalification decisions are written only by app.decide_prequalification.';

create trigger t40_guard_prequalification before insert or update on app.prequalifications
  for each row execute function private.guard_prequalification();
create trigger t90_emit_prequalified after update on app.prequalifications
  for each row when (old.decision is null and new.decision is not null)
  execute function private.emit_subject_event('vendor.prequalified', 'prequalifications', 'id', 'vendor_id', 'decision');

create or replace function app.decide_prequalification(p_prequalification_id uuid, p_decision app.approval_decision, p_valid_to date default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_row app.prequalifications;
begin
  select * into v_row from app.prequalifications q where q.id = p_prequalification_id and q.deleted_at is null for update;
  if v_row.id is null or not private.has_capability(v_row.org_id, 'vendors.prequalification.approve') then
    raise exception using errcode = '42501', message = 'vendors.prequalification.approve is required';
  end if;
  perform private.assert_separation('sod_approval_requester', v_person, v_row.created_by);
  if v_row.decision is not null then
    perform private.refuse('prequalification_decided', 'A decided prequalification is final; request a new one.');
  end if;
  perform private.begin_trusted_operation('prequalification_decision');
  update app.prequalifications set decision = p_decision, decided_by = v_person, decided_at = now(), valid_to = p_valid_to
  where id = p_prequalification_id;
  perform private.end_trusted_operation('prequalification_decision');
end;
$$;

comment on function app.decide_prequalification(uuid, app.approval_decision, date) is 'Decides a prequalification: vendors.prequalification.approve, never by its requester (sod_approval_requester), final once decided.';

-- Insurance certificates ---------------------------------------------------------------------------------------------

create table app.insurance_certificates (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  vendor_id uuid not null references app.vendors (id),
  insurer text not null,
  policy_identifier text not null,
  coverage_type text not null,
  coverage_limit_minor bigint,
  currency_code char(3) references private.currencies (currency_code),
  valid_from date not null,
  valid_to date not null,
  document_uri text,
  deleted_at timestamptz,
  constraint insurance_certificates_validity check (valid_to >= valid_from),
  constraint insurance_certificates_limit_currency check (coverage_limit_minor is null or currency_code is not null),
  constraint insurance_certificates_limit_nonnegative check (coverage_limit_minor is null or coverage_limit_minor >= 0)
);

create index insurance_certificates_vendor_id_idx on app.insurance_certificates (vendor_id, valid_to);
create index insurance_certificates_currency_code_idx on app.insurance_certificates (currency_code);

call private.install_domain_table('app.insurance_certificates', 'app.vendors', 'vendor_id');
call private.describe('app.insurance_certificates', 'Certificates of insurance (COIs) a vendor keeps on file. Whether one is current is derived from its validity window at read time.', array[
  'vendor_id', 'Insured vendor.',
  'insurer', 'Insurance carrier.',
  'policy_identifier', 'Policy number issued by the carrier.',
  'coverage_type', 'Coverage, for example General Liability.',
  'coverage_limit_minor', 'Per-occurrence limit in minor units; NULL when the certificate states none.',
  'currency_code', 'ISO 4217 currency of the limit.',
  'valid_from', 'First day of coverage.',
  'valid_to', 'Last day of coverage.',
  'document_uri', 'Where the certificate document is stored.'
]);

-- Scorecards -------------------------------------------------------------------------------------------------------------

create table app.vendor_scorecards (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  vendor_id uuid not null references app.vendors (id),
  project_id uuid references app.projects (id),
  period_end date not null,
  quality_score smallint,
  delivery_score smallint,
  safety_score smallint,
  note text,
  deleted_at timestamptz,
  constraint vendor_scorecards_quality_range check (quality_score is null or quality_score between 1 and 5),
  constraint vendor_scorecards_delivery_range check (delivery_score is null or delivery_score between 1 and 5),
  constraint vendor_scorecards_safety_range check (safety_score is null or safety_score between 1 and 5)
);

create index vendor_scorecards_vendor_id_idx on app.vendor_scorecards (vendor_id, period_end);
create index vendor_scorecards_project_id_idx on app.vendor_scorecards (project_id);

call private.install_domain_table('app.vendor_scorecards', 'app.vendors', 'vendor_id', array['app.projects', 'project_id']);
call private.describe('app.vendor_scorecards', 'Vendor performance scores per period, optionally for one project. An unscored dimension stays NULL.', array[
  'vendor_id', 'Vendor scored.',
  'project_id', 'Project the score is for, when it is for one.',
  'period_end', 'Last day of the period scored.',
  'quality_score', 'Quality, 1 to 5.',
  'delivery_score', 'On-time delivery, 1 to 5.',
  'safety_score', 'Safety, 1 to 5.',
  'note', 'Comments behind the scores.'
]);

-- Sponsor entitlements ------------------------------------------------------------------------------------------------------

create table app.sponsor_entitlements (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  counterparty_id uuid not null references app.counterparties (id),
  description text not null,
  quantity numeric,
  due_on date,
  fulfilled_at timestamptz,
  deleted_at timestamptz,
  constraint sponsor_entitlements_description_length check (char_length(btrim(description)) between 1 and 500),
  constraint sponsor_entitlements_quantity_nonnegative check (quantity is null or quantity >= 0)
);

create index sponsor_entitlements_project_id_idx on app.sponsor_entitlements (project_id);
create index sponsor_entitlements_counterparty_id_idx on app.sponsor_entitlements (counterparty_id);

call private.install_domain_table('app.sponsor_entitlements', 'app.projects', 'project_id', array['app.counterparties', 'counterparty_id']);
call private.describe('app.sponsor_entitlements', 'What a sponsor is entitled to on a project and whether it was delivered (gate 8 sponsor obligations).', array[
  'project_id', 'Project the entitlement is delivered on.',
  'counterparty_id', 'Sponsor counterparty.',
  'description', 'The entitlement, for example naming rights on the main stage.',
  'quantity', 'How many, when countable.',
  'due_on', 'When the entitlement is owed.',
  'fulfilled_at', 'When it was delivered; NULL while owed.'
]);

-- Policies --------------------------------------------------------------------------------------------------------------------

call private.install_policies('app.vendors',
  $$org_id in (select private.orgs_with_capability('vendors.vendor.read'))$$,
  $$org_id in (select private.orgs_with_capability('vendors.vendor.write'))$$);
call private.install_policies('app.vendor_classes',
  $$org_id in (select private.orgs_with_capability('vendors.vendor.read'))$$,
  $$org_id in (select private.orgs_with_capability('vendors.class.write'))$$);
call private.install_policies('app.vendor_class_assignments',
  $$org_id in (select private.orgs_with_capability('vendors.vendor.read'))$$,
  $$org_id in (select private.orgs_with_capability('vendors.class.write'))$$);
call private.install_policies('app.vendor_bank_accounts',
  $$org_id in (select private.orgs_with_capability('vendors.vendor.read'))$$,
  $$org_id in (select private.orgs_with_capability('vendors.bank_details.write'))$$);
call private.install_policies('app.vendor_bank_detail_changes',
  $$org_id in (select private.orgs_with_capability('vendors.vendor.read'))$$);
call private.install_policies('app.prequalifications',
  $$org_id in (select private.orgs_with_capability('vendors.vendor.read'))$$,
  $$org_id in (select private.orgs_with_capability('vendors.vendor.write'))$$);
call private.install_policies('app.insurance_certificates',
  $$org_id in (select private.orgs_with_capability('vendors.vendor.read'))$$,
  $$org_id in (select private.orgs_with_capability('vendors.coi.write'))$$);
call private.install_policies('app.vendor_scorecards',
  $$org_id in (select private.orgs_with_capability('vendors.vendor.read'))$$,
  $$org_id in (select private.orgs_with_capability('vendors.scorecard.write'))$$);
call private.install_policies('app.sponsor_entitlements',
  $$project_id in (select private.project_ids_with('vendors.vendor.read'))$$,
  $$project_id in (select private.project_ids_with('vendors.entitlement.write'))$$);

-- Restricted columns are never selectable by authenticated; they read the masked view.
revoke select on app.vendor_bank_accounts from authenticated;
grant select (id, org_id, vendor_id, bank_name, account_holder, account_last4, created_at, created_by, updated_at, updated_by, deleted_at)
  on app.vendor_bank_accounts to authenticated;

-- Function privileges -------------------------------------------------------------------------------------------------------------

revoke all on function private.log_bank_detail_change() from public, anon, authenticated;
revoke all on function private.guard_prequalification() from public, anon, authenticated;
revoke all on function app.transition_vendor(uuid, app.vendor_state, app.vendor_state, text) from public, anon;
revoke all on function app.decide_prequalification(uuid, app.approval_decision, date) from public, anon;
grant execute on function app.transition_vendor(uuid, app.vendor_state, app.vendor_state, text) to authenticated, service_role;
grant execute on function app.decide_prequalification(uuid, app.approval_decision, date) to authenticated, service_role;
