-- 0320_finance_core.sql
-- A03 Domain Data. Finance core (Section 3.11, Section 7.4 Finance, Section 8.1, Section 8.2):
-- cost centers (dimension 1), accounting periods with their lifecycle (invariant 13), budgets and
-- budget lines with a NULL-able unit price, grade, line type including Fee and Contingency and an
-- XYZ tag with its basis, the journal and its lines, the Universal Posting Line as a view of posted
-- lines, spend authority rows and the spend approval ledger, and the separation of duties helpers.
--
-- GL accounts are never stored on a budget line or expense (decision D13): a URID posts to its
-- class's one account of the requested type, resolved by private.gl_account_for. Fee and Contingency
-- are line types, not accounts (Section 3.11).

-- Enums ------------------------------------------------------------------------------------------------

create type app.budget_line_type as enum ('Cost', 'Labor', 'Fee', 'Contingency');
comment on type app.budget_line_type is 'Budget line types (Section 3.11): Fee and Contingency are line types, not accounts.';

create type app.cost_center_kind as enum ('Standing', 'Overhead', 'Event');
comment on type app.cost_center_kind is 'Cost center kinds (Bible tab 30): standing operations, corporate overhead, one per event scope.';

create type app.accounting_period_state as enum ('Open', 'In Period', 'Closing', 'Closed', 'Audited', 'Archived');
comment on type app.accounting_period_state is 'Financial period lifecycle (Section 3.12, lifecycle 7; Section 7.4). Closed, Audited and Archived periods refuse postings (invariant 13).';

create type app.journal_state as enum ('Proposed', 'Posted', 'Canceled');
comment on type app.journal_state is 'Journal entry states: prepared (Proposed), Posted to the ledger, or Canceled before posting.';

create type app.spend_document_type as enum (
  'Purchase Order', 'Change Order', 'Expense', 'Invoice Approval', 'Contract', 'Payroll Run'
);
comment on type app.spend_document_type is 'Document types spend authority limits apply to (Section 8.1).';

-- Lifecycle rules ----------------------------------------------------------------------------------------

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('accounting_period', 'Open', 'In Period'),
  ('accounting_period', 'In Period', 'Closing'),
  ('accounting_period', 'Closing', 'In Period'),
  ('accounting_period', 'Closing', 'Closed'),
  ('accounting_period', 'Closed', 'Audited'),
  ('accounting_period', 'Audited', 'Archived'),
  ('journal', 'Proposed', 'Posted'),
  ('journal', 'Proposed', 'Canceled');

insert into private.domain_event_types (code, subject, description) values
  ('period.state_changed', 'accounting_periods', 'An accounting period moved to another period state.'),
  ('journal.posted', 'journal_entries', 'A journal entry was posted to the ledger.');

-- Separation of duties rules (Section 8.2) -------------------------------------------------------------

create table private.separation_of_duties_rules (
  code text primary key,
  enforced_on text not null,
  description text not null,
  constraint separation_of_duties_rules_code_format check (code ~ '^sod_[a-z_]+$')
);

comment on table private.separation_of_duties_rules is 'The default separation of duties rules (Section 8.2). Each is a database check whose refusal names the rule code. An org may tighten them but never remove them.';
comment on column private.separation_of_duties_rules.code is 'Rule code, the prefix of the refusal message and its hint.';
comment on column private.separation_of_duties_rules.enforced_on is 'Documents the rule is enforced on.';
comment on column private.separation_of_duties_rules.description is 'The rule in a sentence.';

alter table private.separation_of_duties_rules enable row level security;
revoke all on private.separation_of_duties_rules from public, anon, authenticated;
grant select on private.separation_of_duties_rules to service_role;

insert into private.separation_of_duties_rules (code, enforced_on, description) values
  ('sod_po_creator', 'Purchase orders', 'The creator of a purchase order cannot approve it.'),
  ('sod_vendor_payment', 'Vendors, payments', 'A person who creates a vendor or edits its bank details cannot approve payment to it.'),
  ('sod_expense_submitter', 'Expenses', 'The submitter of an expense cannot approve it.'),
  ('sod_timesheet_submitter', 'Timesheets', 'The submitter of a timesheet cannot approve it.'),
  ('sod_time_off_requester', 'Time off', 'The requester of time off cannot approve it.'),
  ('sod_journal_preparer', 'Journal entries', 'The preparer of a journal entry cannot post it.'),
  ('sod_self_grant', 'Memberships, grants', 'A person cannot grant themselves a role or capability.'),
  ('sod_change_order_requester', 'Change orders', 'The requester of a change order cannot price and approve it alone.'),
  ('sod_approval_requester', 'Approvals', 'An approval is decided by an eligible approver, never the requester.'),
  ('sod_swap_requester', 'Shift swaps', 'A crew member cannot approve their own swap.');

create view app.separation_of_duties_rules as
select r.code, r.enforced_on, r.description from private.separation_of_duties_rules r;

comment on view app.separation_of_duties_rules is 'The separation of duties rules the database enforces, with the rule codes refusals name.';
comment on column app.separation_of_duties_rules.code is 'Rule code.';
comment on column app.separation_of_duties_rules.enforced_on is 'Documents the rule covers.';
comment on column app.separation_of_duties_rules.description is 'The rule.';

revoke all on app.separation_of_duties_rules from public, anon;
grant select on app.separation_of_duties_rules to authenticated, service_role;

-- GL resolution (decision D13) -------------------------------------------------------------------------------

create or replace function private.gl_account_for(p_urid text, p_account_type text)
returns text
language sql
stable
set search_path = ''
as $$
  select a.account_code from xpms.dim_gl_account a
  where a.class_code = left(p_urid, 4) and a.account_type = p_account_type;
$$;

comment on function private.gl_account_for(text, text) is 'Decision D13: the account a URID or role code posts to is its class''s one account of the requested type (Expense or Revenue). NULL when the class has no account of that type.';
revoke all on function private.gl_account_for(text, text) from public, anon;
grant execute on function private.gl_account_for(text, text) to authenticated, service_role;

create or replace function private.assert_urid(p_urid text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_urid is not null
     and not exists (select 1 from xpms.dim_category c where c.cat_urid = p_urid)
     and not exists (select 1 from xpms.dim_discipline d where d.disc_code = p_urid) then
    perform private.refuse('urid_unknown', format('%s is not a canon discipline or category.', p_urid));
  end if;
end;
$$;

comment on function private.assert_urid(text) is 'Refuses a dimension 2 value that is neither a canon discipline (DDDD.DD) nor a canon category (DDDD.DD.DD).';
revoke all on function private.assert_urid(text) from public, anon, authenticated;

-- Cost centers ---------------------------------------------------------------------------------------------------

create table app.cost_centers (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  code text not null,
  name text not null,
  kind app.cost_center_kind not null,
  scope_node_id uuid references app.scope_nodes (id),
  template_id text references xpms.dim_cost_center_template (cost_center_id),
  deleted_at timestamptz,
  constraint cost_centers_code_format check (code ~ '^CC-[A-Z0-9-]{1,32}$'),
  constraint cost_centers_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint cost_centers_event_scope check ((kind = 'Event') = (scope_node_id is not null))
);

create unique index cost_centers_org_code_key on app.cost_centers (org_id, code) where deleted_at is null;
create index cost_centers_scope_node_id_idx on app.cost_centers (scope_node_id);
create index cost_centers_template_id_idx on app.cost_centers (template_id);

call private.install_domain_table('app.cost_centers', null, null, array['app.scope_nodes', 'scope_node_id']);
call private.describe('app.cost_centers', 'Cost centers, GL dimension 1 (Section 3.11, Bible tab 30): CC-VENUE, CC-CORP and one per event scope. Listed in code order.', array[
  'code', 'Cost center code, for example CC-VENUE or CC-E01, unique within the org.',
  'name', 'Cost center name.',
  'kind', 'Standing, Overhead or Event.',
  'scope_node_id', 'Event scope node of an Event cost center; NULL for the other kinds.',
  'template_id', 'Canon cost center template the cost center was created from.'
]);

-- Accounting periods ---------------------------------------------------------------------------------------------

create table app.accounting_periods (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  starts_on date not null,
  ends_on date not null,
  period_state app.accounting_period_state not null default 'Open',
  constraint accounting_periods_dates check (ends_on >= starts_on)
);

create index accounting_periods_org_dates_idx on app.accounting_periods (org_id, starts_on);

call private.install_domain_table('app.accounting_periods');
call private.describe('app.accounting_periods', 'Financial periods of an org (Section 7.4). Periods never overlap. A Closed, Audited or Archived period refuses postings, and an Open period reaches Audited only through Closed (invariant 13).', array[
  'starts_on', 'First day of the period.',
  'ends_on', 'Last day of the period.',
  'period_state', 'Period lifecycle state. Changes only through app.transition_accounting_period.'
]);

create table app.accounting_period_state_transitions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  accounting_period_id uuid not null references app.accounting_periods (id),
  from_state app.accounting_period_state,
  to_state app.accounting_period_state not null,
  reason text not null,
  constraint accounting_period_state_transitions_reason_length check (char_length(btrim(reason)) between 1 and 500)
);

create index accounting_period_state_transitions_period_idx on app.accounting_period_state_transitions (accounting_period_id);

call private.install_domain_table('app.accounting_period_state_transitions', 'app.accounting_periods', 'accounting_period_id', '{}', true);
call private.describe('app.accounting_period_state_transitions', 'Append-only ledger of accounting period state changes, written only by app.transition_accounting_period and period creation.', array[
  'accounting_period_id', 'Period that changed state.',
  'from_state', 'State before the change; NULL for the creation entry.',
  'to_state', 'State after the change.',
  'reason', 'Why the state changed.'
]);

create or replace function private.guard_accounting_period()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.starts_on <> old.starts_on or new.ends_on <> old.ends_on) and old.period_state <> 'Open' then
    perform private.refuse('period_dates_locked', 'A period''s dates change only while it is Open.');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('accounting_periods:' || new.org_id::text, 0));
  if new.deleted_at is null and exists (
    select 1 from app.accounting_periods p
    where p.org_id = new.org_id and p.id <> new.id and p.deleted_at is null
      and daterange(p.starts_on, p.ends_on, '[]') && daterange(new.starts_on, new.ends_on, '[]')
  ) then
    perform private.refuse('period_overlap', 'Accounting periods of an org never overlap.');
  end if;
  return new;
end;
$$;

comment on function private.guard_accounting_period() is 'Accounting periods never overlap within an org, and their dates change only while Open.';

create trigger t40_guard_accounting_period before insert or update on app.accounting_periods
  for each row execute function private.guard_accounting_period();
create trigger t41_period_state before insert or update on app.accounting_periods
  for each row execute function private.guard_lifecycle_state('period_state', 'accounting_period', 'Open');
create trigger t80_log_period_state after insert on app.accounting_periods
  for each row execute function private.log_initial_state('app.accounting_period_state_transitions', 'accounting_period_id', 'period_state');
create trigger t90_emit_period_state after insert on app.accounting_period_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('period.state_changed', 'accounting_periods', 'accounting_period_id', 'from_state', 'to_state', 'reason');

create or replace function private.postable_period(p_org_id uuid, p_on date)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_period app.accounting_periods;
begin
  select * into v_period from app.accounting_periods p
  where p.org_id = p_org_id and p.deleted_at is null and p_on between p.starts_on and p.ends_on;
  if v_period.id is null then
    perform private.refuse('period_missing', format('No accounting period covers %s; open one before posting.', p_on));
  end if;
  if v_period.period_state in ('Closed', 'Audited', 'Archived') then
    perform private.refuse('period_closed', format('The period covering %s is %s and refuses postings.', p_on, v_period.period_state));
  end if;
  return v_period.id;
end;
$$;

comment on function private.postable_period(uuid, date) is 'Invariant 13: the period that accepts a posting dated p_on, or a refusal when none covers the date or it is Closed, Audited or Archived.';
revoke all on function private.postable_period(uuid, date) from public, anon, authenticated;

-- Budgets ------------------------------------------------------------------------------------------------------

create table app.budgets (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  name text not null,
  currency_code char(3) not null references private.currencies (currency_code),
  is_baseline boolean not null default false,
  deleted_at timestamptz,
  constraint budgets_name_length check (char_length(btrim(name)) between 1 and 200)
);

create index budgets_project_id_idx on app.budgets (project_id);
create index budgets_currency_code_idx on app.budgets (currency_code);
create unique index budgets_one_baseline on app.budgets (project_id) where is_baseline and deleted_at is null;

call private.install_domain_table('app.budgets', 'app.projects', 'project_id');
call private.describe('app.budgets', 'Budgets of a project. Totals are derived (app.budget_totals), never stored. One budget per project may be the gate 3 baseline.', array[
  'project_id', 'Project the budget belongs to.',
  'name', 'Budget name.',
  'currency_code', 'ISO 4217 currency every line and expense of the budget is in.',
  'is_baseline', 'True for the gate 3 baseline the final cost report compares against.'
]);

create table app.budget_lines (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  budget_id uuid not null references app.budgets (id),
  line_number integer not null,
  description text not null,
  line_type app.budget_line_type not null default 'Cost',
  urid text not null,
  cost_center_id uuid references app.cost_centers (id),
  grade_code text references xpms.grade (code),
  element_id text references xpms.elements (element_id),
  quantity numeric not null default 1,
  unit_basis text references xpms.dim_unit_alias (alias),
  unit_price_minor bigint,
  xyz xpms.xyz_tag not null,
  xyz_basis app.xyz_basis not null,
  deleted_at timestamptz,
  constraint budget_lines_line_number_positive check (line_number > 0),
  constraint budget_lines_description_length check (char_length(btrim(description)) between 1 and 500),
  constraint budget_lines_quantity_nonnegative check (quantity >= 0),
  constraint budget_lines_unit_price_nonnegative check (unit_price_minor is null or unit_price_minor >= 0)
);

create unique index budget_lines_budget_number_key on app.budget_lines (budget_id, line_number) where deleted_at is null;
create index budget_lines_urid_idx on app.budget_lines (urid);
create index budget_lines_cost_center_id_idx on app.budget_lines (cost_center_id);
create index budget_lines_grade_code_idx on app.budget_lines (grade_code);
create index budget_lines_element_id_idx on app.budget_lines (element_id);
create index budget_lines_unit_basis_idx on app.budget_lines (unit_basis);

call private.install_domain_table('app.budget_lines', 'app.budgets', 'budget_id', array['app.cost_centers', 'cost_center_id']);
call private.describe('app.budget_lines', 'Budget lines (Section 7.4). The unit price is NULL when unpriced and never defaulted to zero; the extended amount is derived. The GL account is derived from the URID''s class (decision D13).', array[
  'budget_id', 'Budget the line belongs to.',
  'line_number', 'Order of the line within the budget.',
  'description', 'Sentence-case line description.',
  'line_type', 'Cost, Labor, Fee or Contingency.',
  'urid', 'Dimension 2: canon discipline or category the line spends on; its class decides the GL account.',
  'cost_center_id', 'Dimension 1: cost center the line posts to.',
  'grade_code', 'Price grade: base, elevated or premium (decision D11).',
  'element_id', 'Catalog element priced by the line, when one applies.',
  'quantity', 'Quantity, in unit_basis.',
  'unit_basis', 'Unit of the quantity from the controlled unit list.',
  'unit_price_minor', 'Unit price in minor units of the budget currency; NULL is unpriced and renders as Unpriced.',
  'xyz', 'XYZ schema-family tag of the line.',
  'xyz_basis', 'Basis of the XYZ tag: Category (equals the URID category''s tag) or Declared.'
]);

create or replace function private.guard_budget_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_category_xyz text;
begin
  perform private.assert_urid(new.urid);
  if new.xyz_basis = 'Category' then
    select c.xyz into v_category_xyz from xpms.dim_category c where c.cat_urid = new.urid;
    if v_category_xyz is null or v_category_xyz <> new.xyz then
      perform private.refuse('budget_line_xyz_basis',
        format('An XYZ tag with basis Category equals the category''s tag (%s); declare it instead to differ.', coalesce(v_category_xyz, 'none')));
    end if;
  end if;
  if tg_op = 'UPDATE' and new.budget_id <> old.budget_id then
    perform private.refuse('budget_line_budget_immutable', 'A budget line stays in its budget.');
  end if;
  return new;
end;
$$;

comment on function private.guard_budget_line() is 'Budget lines: canon URID, XYZ basis honored, line stays in its budget.';

create trigger t40_guard_budget_line before insert or update on app.budget_lines
  for each row execute function private.guard_budget_line();

-- Spend authority (Section 8.1) ------------------------------------------------------------------------------------

create table app.spend_authorities (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  role_id uuid references app.roles (id),
  membership_id uuid references app.memberships (id),
  document_type app.spend_document_type not null,
  account_code text references xpms.dim_gl_account (account_code),
  cost_center_id uuid references app.cost_centers (id),
  currency_code char(3) not null references private.currencies (currency_code),
  limit_minor bigint not null,
  dual_approval_above_minor bigint,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  deleted_at timestamptz,
  constraint spend_authorities_one_holder check (num_nonnulls(role_id, membership_id) = 1),
  constraint spend_authorities_limit_nonnegative check (limit_minor >= 0),
  constraint spend_authorities_dual_threshold check (dual_approval_above_minor is null or dual_approval_above_minor >= 0),
  constraint spend_authorities_valid_period check (valid_to is null or valid_to >= valid_from)
);

create index spend_authorities_role_id_idx on app.spend_authorities (role_id);
create index spend_authorities_membership_id_idx on app.spend_authorities (membership_id);
create index spend_authorities_account_code_idx on app.spend_authorities (account_code);
create index spend_authorities_cost_center_id_idx on app.spend_authorities (cost_center_id);
create index spend_authorities_currency_code_idx on app.spend_authorities (currency_code);
create index spend_authorities_lookup_idx on app.spend_authorities (org_id, document_type);

call private.install_domain_table('app.spend_authorities', null, null,
  array['app.roles', 'role_id', 'app.memberships', 'membership_id', 'app.cost_centers', 'cost_center_id']);
call private.describe('app.spend_authorities', 'Spend authority limits (Section 8.1) by role or person, document type, GL account or cost center scope, and amount. An approval above every limit that applies is refused; above the dual approval threshold it needs two approvers. No applicable row is an absent claim and refuses (Section 3.7).', array[
  'role_id', 'Role whose holders the limit applies to; NULL when it applies to one person.',
  'membership_id', 'Membership of the one person the limit applies to; NULL when it applies to a role.',
  'document_type', 'Document type the limit applies to.',
  'account_code', 'GL account the limit is scoped to; NULL for every account.',
  'cost_center_id', 'Cost center the limit is scoped to; NULL for every cost center.',
  'currency_code', 'ISO 4217 currency of the amounts (the org currency).',
  'limit_minor', 'Largest amount the holder may approve, in minor units.',
  'dual_approval_above_minor', 'Amount above which two distinct approvers are needed; NULL for never.',
  'valid_from', 'When the limit starts.',
  'valid_to', 'When the limit ends; NULL while open-ended.'
]);

create table app.spend_approvals (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  document_type app.spend_document_type not null,
  document_id uuid not null,
  approver_person_id uuid not null references app.people (id),
  amount_minor bigint not null,
  currency_code char(3) not null references private.currencies (currency_code),
  spend_authority_id uuid not null references app.spend_authorities (id)
);

create index spend_approvals_document_idx on app.spend_approvals (document_id, document_type);
create index spend_approvals_approver_person_id_idx on app.spend_approvals (approver_person_id);
create index spend_approvals_currency_code_idx on app.spend_approvals (currency_code);
create index spend_approvals_spend_authority_id_idx on app.spend_approvals (spend_authority_id);
create unique index spend_approvals_once_per_approver on app.spend_approvals (document_type, document_id, approver_person_id);

call private.install_domain_table('app.spend_approvals', null, null, array['app.spend_authorities', 'spend_authority_id'], true);
call private.describe('app.spend_approvals', 'Append-only ledger of approvals given under spend authority, written only by approval RPCs. A document above its dual threshold is approved once two distinct approvers have rows here.', array[
  'document_type', 'Type of the approved document.',
  'document_id', 'Id of the approved document.',
  'approver_person_id', 'Person who approved.',
  'amount_minor', 'Amount approved, in minor units.',
  'currency_code', 'ISO 4217 currency of the amount.',
  'spend_authority_id', 'Limit row that authorized the approval.'
]);

create or replace function private.approve_under_spend_authority(
  p_org_id uuid,
  p_document_type app.spend_document_type,
  p_document_id uuid,
  p_amount_minor bigint,
  p_currency_code char(3),
  p_account_code text,
  p_cost_center_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_authority app.spend_authorities;
  v_needed integer;
  v_given integer;
begin
  if p_amount_minor is null then
    perform private.refuse('spend_unpriced', 'An unpriced amount cannot be approved; price it first.');
  end if;
  select sa.* into v_authority
  from app.spend_authorities sa
  where sa.org_id = p_org_id and sa.document_type = p_document_type and sa.currency_code = p_currency_code
    and sa.deleted_at is null and sa.valid_from <= now() and (sa.valid_to is null or sa.valid_to > now())
    and (sa.account_code is null or sa.account_code = p_account_code)
    and (sa.cost_center_id is null or sa.cost_center_id = p_cost_center_id)
    and (
      sa.membership_id in (select private.my_membership_ids())
      or sa.role_id in (
        select mr.role_id from app.membership_roles mr
        where mr.deleted_at is null and mr.membership_id in (select private.my_membership_ids()))
    )
  order by sa.limit_minor desc
  limit 1;
  if v_authority.id is null then
    perform private.refuse('spend_authority_missing',
      format('No spend authority lets this person approve a %s in %s.', p_document_type, p_currency_code));
  end if;
  if p_amount_minor > v_authority.limit_minor then
    perform private.refuse('spend_authority_exceeded',
      format('This %s exceeds the approver''s limit; route it to the next approver in the policy.', p_document_type));
  end if;
  if exists (select 1 from app.spend_approvals a
             where a.document_type = p_document_type and a.document_id = p_document_id and a.approver_person_id = v_person) then
    perform private.refuse('spend_approval_duplicate', 'A person approves a document once; a second approval needs a different approver.');
  end if;
  insert into app.spend_approvals (org_id, document_type, document_id, approver_person_id, amount_minor, currency_code, spend_authority_id)
  values (p_org_id, p_document_type, p_document_id, v_person, p_amount_minor, p_currency_code, v_authority.id);
  v_needed := case when v_authority.dual_approval_above_minor is not null
                    and p_amount_minor > v_authority.dual_approval_above_minor then 2 else 1 end;
  select count(distinct a.approver_person_id) into v_given from app.spend_approvals a
  where a.document_type = p_document_type and a.document_id = p_document_id;
  return v_given >= v_needed;
end;
$$;

comment on function private.approve_under_spend_authority(uuid, app.spend_document_type, uuid, bigint, char, text, uuid) is 'Section 8.1, enforced inside every approval RPC: finds the widest limit that applies to the signed-in approver, refuses an unpriced amount, a missing limit or an amount above it, records the approval, and returns true once enough distinct approvers (two above the dual threshold) have approved.';
revoke all on function private.approve_under_spend_authority(uuid, app.spend_document_type, uuid, bigint, char, text, uuid) from public, anon, authenticated;

create or replace function private.assert_separation(p_rule text, p_actor uuid, p_other uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_actor is not null and p_actor = p_other then
    perform private.refuse(p_rule, (select r.description from private.separation_of_duties_rules r where r.code = p_rule));
  end if;
end;
$$;

comment on function private.assert_separation(text, uuid, uuid) is 'Section 8.2: refuses with the named rule and its sentence when the acting person is the person the rule separates them from.';
revoke all on function private.assert_separation(text, uuid, uuid) from public, anon, authenticated;

-- Journal ------------------------------------------------------------------------------------------------------------

create table app.journal_entries (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  accounting_period_id uuid not null references app.accounting_periods (id),
  project_id uuid references app.projects (id),
  entry_date date not null,
  memo text not null,
  journal_state app.journal_state not null default 'Proposed',
  prepared_by uuid references app.people (id),
  posted_by uuid references app.people (id),
  posted_at timestamptz,
  source_table text,
  source_id uuid,
  constraint journal_entries_memo_length check (char_length(btrim(memo)) between 1 and 500),
  constraint journal_entries_posted_pair check ((journal_state = 'Posted') = (posted_at is not null)),
  constraint journal_entries_source_pair check ((source_table is null) = (source_id is null))
);

create index journal_entries_accounting_period_id_idx on app.journal_entries (accounting_period_id);
create index journal_entries_project_id_idx on app.journal_entries (project_id);
create index journal_entries_prepared_by_idx on app.journal_entries (prepared_by);
create index journal_entries_posted_by_idx on app.journal_entries (posted_by);
create index journal_entries_source_id_idx on app.journal_entries (source_id);

call private.install_domain_table('app.journal_entries', 'app.accounting_periods', 'accounting_period_id', array['app.projects', 'project_id']);
call private.describe('app.journal_entries', 'Journal entries. Prepared, then posted by someone other than the preparer (Section 8.2); posting into a Closed, Audited or Archived period is refused (invariant 13). Entries generated by approved documents are prepared by the platform.', array[
  'accounting_period_id', 'Period the entry posts to; its dates cover entry_date.',
  'project_id', 'Project the entry belongs to, when it does.',
  'entry_date', 'Date the cost or revenue is recognized.',
  'memo', 'What the entry records.',
  'journal_state', 'Proposed, Posted or Canceled. Changes only through app.post_journal_entry and app.cancel_journal_entry.',
  'prepared_by', 'Person who prepared the entry, set from the session; NULL when the platform generated it from an approved document.',
  'posted_by', 'Person who posted the entry; never the preparer.',
  'posted_at', 'When the entry was posted.',
  'source_table', 'Table of the document that generated the entry, such as expenses.',
  'source_id', 'Id of the document that generated the entry.'
]);

create table app.journal_state_transitions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  journal_entry_id uuid not null references app.journal_entries (id),
  from_state app.journal_state,
  to_state app.journal_state not null,
  reason text not null,
  constraint journal_state_transitions_reason_length check (char_length(btrim(reason)) between 1 and 500)
);

create index journal_state_transitions_entry_idx on app.journal_state_transitions (journal_entry_id);

call private.install_domain_table('app.journal_state_transitions', 'app.journal_entries', 'journal_entry_id', '{}', true);
call private.describe('app.journal_state_transitions', 'Append-only ledger of journal entry state changes.', array[
  'journal_entry_id', 'Entry that changed state.',
  'from_state', 'State before the change; NULL for the creation entry.',
  'to_state', 'State after the change.',
  'reason', 'Why the state changed.'
]);

create table app.journal_lines (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  journal_entry_id uuid not null references app.journal_entries (id),
  line_number integer not null,
  account_code text not null references xpms.dim_gl_account (account_code),
  cost_center_id uuid references app.cost_centers (id),
  urid text,
  counterparty_id uuid references app.counterparties (id),
  element_id text references xpms.elements (element_id),
  description text not null,
  quantity numeric,
  unit_basis text references xpms.dim_unit_alias (alias),
  debit_minor bigint not null default 0,
  credit_minor bigint not null default 0,
  currency_code char(3) not null references private.currencies (currency_code),
  constraint journal_lines_line_number_positive check (line_number > 0),
  constraint journal_lines_one_side check (
    debit_minor >= 0 and credit_minor >= 0 and (debit_minor = 0) <> (credit_minor = 0)),
  constraint journal_lines_description_length check (char_length(btrim(description)) between 1 and 500)
);

create unique index journal_lines_entry_number_key on app.journal_lines (journal_entry_id, line_number);
create index journal_lines_account_code_idx on app.journal_lines (account_code);
create index journal_lines_cost_center_id_idx on app.journal_lines (cost_center_id);
create index journal_lines_urid_idx on app.journal_lines (urid);
create index journal_lines_counterparty_id_idx on app.journal_lines (counterparty_id);
create index journal_lines_element_id_idx on app.journal_lines (element_id);
create index journal_lines_unit_basis_idx on app.journal_lines (unit_basis);
create index journal_lines_currency_code_idx on app.journal_lines (currency_code);

call private.install_domain_table('app.journal_lines', 'app.journal_entries', 'journal_entry_id',
  array['app.cost_centers', 'cost_center_id', 'app.counterparties', 'counterparty_id']);
call private.describe('app.journal_lines', 'Lines of a journal entry: one account, dimension 1 and 2, and either a debit or a credit. Immutable once the entry is posted. Posted lines are the Universal Posting Line (app.posting_lines).', array[
  'journal_entry_id', 'Entry the line belongs to.',
  'line_number', 'Order of the line within the entry.',
  'account_code', 'GL account from the fixed chart (Bible tab 29).',
  'cost_center_id', 'Dimension 1 cost center.',
  'urid', 'Dimension 2: canon discipline or category.',
  'counterparty_id', 'Vendor or client the line concerns; NULL for revenue without one.',
  'element_id', 'Catalog element, when one applies.',
  'description', 'Sentence-case line description.',
  'quantity', 'Quantity, when the line counts something.',
  'unit_basis', 'Unit of the quantity from the controlled unit list.',
  'debit_minor', 'Debit amount in minor units; zero on a credit line.',
  'credit_minor', 'Credit amount in minor units; zero on a debit line.',
  'currency_code', 'ISO 4217 currency of the line.'
]);

create or replace function private.guard_journal_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.prepared_by := case when private.in_trusted_operation('system_journal') then null else private.current_person_id() end;
    new.posted_by := null;
    new.posted_at := null;
  elsif old.journal_state <> 'Proposed' and not private.in_trusted_operation('journal_transition') then
    perform private.refuse('journal_posted_immutable', 'A posted or canceled journal entry never changes; post a reversing entry.');
  elsif new.prepared_by is distinct from old.prepared_by then
    perform private.refuse('journal_preparer_immutable', 'The preparer of a journal entry never changes.');
  end if;
  if tg_op = 'UPDATE' then
    if new.journal_state = 'Posted' and old.journal_state = 'Proposed' then
      new.posted_by := private.current_person_id();
      new.posted_at := now();
    else
      new.posted_by := old.posted_by;
      new.posted_at := old.posted_at;
    end if;
  end if;
  if not exists (select 1 from app.accounting_periods p
                 where p.id = new.accounting_period_id and new.entry_date between p.starts_on and p.ends_on) then
    perform private.refuse('journal_period_dates', 'The entry date falls inside the entry''s accounting period.');
  end if;
  if new.journal_state = 'Proposed' or (tg_op = 'UPDATE' and new.journal_state = 'Posted' and old.journal_state = 'Proposed') then
    perform private.postable_period(new.org_id, new.entry_date);
  end if;
  return new;
end;
$$;

comment on function private.guard_journal_entry() is 'Journal entries: preparer from the session, frozen once posted or canceled, entry date inside its period, and no preparing or posting into a Closed, Audited or Archived period (invariant 13).';

create trigger t40_guard_journal_entry before insert or update on app.journal_entries
  for each row execute function private.guard_journal_entry();
create trigger t41_journal_state before insert or update on app.journal_entries
  for each row execute function private.guard_lifecycle_state('journal_state', 'journal', 'Proposed');
create trigger t80_log_journal_state after insert on app.journal_entries
  for each row execute function private.log_initial_state('app.journal_state_transitions', 'journal_entry_id', 'journal_state');
create trigger t90_emit_journal_posted after insert on app.journal_state_transitions
  for each row when (new.to_state = 'Posted')
  execute function private.emit_subject_event('journal.posted', 'journal_entries', 'journal_entry_id', 'from_state', 'to_state');

create or replace function private.guard_journal_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row app.journal_lines := case when tg_op = 'DELETE' then old else new end;
  v_entry app.journal_entries;
begin
  select * into v_entry from app.journal_entries e where e.id = v_row.journal_entry_id;
  if v_entry.journal_state <> 'Proposed' then
    perform private.refuse('journal_posted_immutable', 'A posted or canceled journal entry never changes; post a reversing entry.');
  end if;
  perform private.postable_period(v_entry.org_id, v_entry.entry_date);
  if tg_op <> 'DELETE' then
    perform private.assert_urid(new.urid);
    if tg_op = 'UPDATE' and new.journal_entry_id <> old.journal_entry_id then
      perform private.refuse('journal_line_entry_immutable', 'A journal line stays on its entry.');
    end if;
  end if;
  return v_row;
end;
$$;

comment on function private.guard_journal_line() is 'Journal lines change only while their entry is Proposed and its period accepts postings (invariant 13); dimension 2 is a canon URID.';

create trigger t40_guard_journal_line before insert or update or delete on app.journal_lines
  for each row execute function private.guard_journal_line();

-- Journal and period RPCs -----------------------------------------------------------------------------------------------

create or replace function app.post_journal_entry(p_journal_entry_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_entry app.journal_entries;
  v_debits bigint;
  v_credits bigint;
  v_currencies integer;
begin
  select * into v_entry from app.journal_entries e where e.id = p_journal_entry_id and e.deleted_at is null for update;
  if v_entry.id is null or not private.has_capability(v_entry.org_id, 'finance.journal.post') then
    raise exception using errcode = '42501', message = 'finance.journal.post is required';
  end if;
  perform private.assert_separation('sod_journal_preparer', private.require_person(), v_entry.prepared_by);
  select coalesce(sum(l.debit_minor), 0), coalesce(sum(l.credit_minor), 0), count(distinct l.currency_code)
  into v_debits, v_credits, v_currencies
  from app.journal_lines l where l.journal_entry_id = p_journal_entry_id and l.deleted_at is null;
  if v_debits = 0 or v_debits <> v_credits or v_currencies <> 1 then
    perform private.refuse('journal_unbalanced', 'A journal entry posts only when its debits equal its credits in one currency.');
  end if;
  return private.post_journal(p_journal_entry_id, p_reason);
end;
$$;

comment on function app.post_journal_entry(uuid, text) is 'Posts a prepared, balanced journal entry. Needs finance.journal.post; the preparer cannot post (sod_journal_preparer); refused into a closed period (invariant 13). Returns the ledger entry id.';

create or replace function private.post_journal(p_journal_entry_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return private.transition_lifecycle('journal', 'app.journal_entries', 'journal_state', 'app.journal_state_transitions',
    'journal_entry_id', p_journal_entry_id, 'Proposed', 'Posted', p_reason);
end;
$$;

comment on function private.post_journal(uuid, text) is 'Moves a Proposed journal entry to Posted; the entry guard stamps the poster. Callers authorize and balance-check first.';
revoke all on function private.post_journal(uuid, text) from public, anon, authenticated;

create or replace function app.cancel_journal_entry(p_journal_entry_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select e.org_id from app.journal_entries e where e.id = p_journal_entry_id);
begin
  perform private.require_person();
  if v_org is null or not private.has_capability(v_org, 'finance.journal.write') then
    raise exception using errcode = '42501', message = 'finance.journal.write is required';
  end if;
  return private.transition_lifecycle('journal', 'app.journal_entries', 'journal_state', 'app.journal_state_transitions',
    'journal_entry_id', p_journal_entry_id, 'Proposed', 'Canceled', p_reason);
end;
$$;

comment on function app.cancel_journal_entry(uuid, text) is 'Cancels a prepared journal entry before it posts. Needs finance.journal.write.';

create or replace function app.transition_accounting_period(
  p_accounting_period_id uuid,
  p_expected app.accounting_period_state,
  p_next app.accounting_period_state,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select p.org_id from app.accounting_periods p where p.id = p_accounting_period_id);
  v_capability text := case when p_next in ('Closed', 'Audited', 'Archived') then 'finance.period.close' else 'finance.period.manage' end;
begin
  perform private.require_person();
  if v_org is null or not private.has_capability(v_org, v_capability) then
    raise exception using errcode = '42501', message = format('%s is required', v_capability);
  end if;
  if p_next = 'Closed' and exists (
    select 1 from app.journal_entries e
    where e.accounting_period_id = p_accounting_period_id and e.journal_state = 'Proposed' and e.deleted_at is null
  ) then
    perform private.refuse('period_unposted_entries', 'Post or cancel every prepared journal entry before closing the period.');
  end if;
  return private.transition_lifecycle('accounting_period', 'app.accounting_periods', 'period_state',
    'app.accounting_period_state_transitions', 'accounting_period_id', p_accounting_period_id,
    p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_accounting_period(uuid, app.accounting_period_state, app.accounting_period_state, text) is 'Moves an accounting period along Open, In Period, Closing, Closed, Audited, Archived with compare-and-set (invariant 13: Audited only through Closed). Closing, auditing and archiving need finance.period.close; the rest finance.period.manage. Closing refuses while prepared entries remain.';

-- Posting lines (Universal Posting Line, Bible tab 36) -----------------------------------------------------------------

create view app.posting_lines with (security_invoker = true) as
select l.id as posting_line_id, e.org_id, e.project_id, e.entry_date as date, l.account_code, cc.code as cost_center_id,
  l.urid, l.counterparty_id as vendor_id, l.element_id as item_id, l.description, l.quantity, l.unit_basis,
  l.debit_minor - l.credit_minor as amount_minor, a.tax_type, l.currency_code as currency,
  coalesce(e.source_id, e.id) as external_ref, 'Complete'::text as line_state
from app.journal_lines l
join app.journal_entries e on e.id = l.journal_entry_id
join xpms.dim_gl_account a on a.account_code = l.account_code
left join app.cost_centers cc on cc.id = l.cost_center_id
where e.journal_state = 'Posted' and l.deleted_at is null and e.deleted_at is null;

call private.describe('app.posting_lines', 'The Universal Posting Line (Section 3.11, Bible tab 36): every posted journal line in the one export shape projected to Xero, QuickBooks Online, NetSuite and Ramp. Derived, never stored.', array[
  'posting_line_id', 'Journal line the posting line is.',
  'org_id', 'Org of the posting.',
  'project_id', 'Project of the entry, when it has one.',
  'date', 'ISO 8601 date the cost or revenue is recognized.',
  'account_code', 'GL account from the fixed chart.',
  'cost_center_id', 'Dimension 1 cost center code.',
  'urid', 'Dimension 2 discipline or category.',
  'vendor_id', 'Counterparty of the line, or NULL for revenue.',
  'item_id', 'Catalog element, when one applies.',
  'description', 'Sentence-case line description.',
  'quantity', 'Quantity.',
  'unit_basis', 'Unit from the controlled unit list.',
  'amount_minor', 'Signed amount in minor units: debits positive, credits negative.',
  'tax_type', 'Tax type of the account.',
  'currency', 'ISO 4217 currency.',
  'external_ref', 'Id of the source document, or of the entry when prepared by hand.',
  'line_state', 'Shared state vocabulary value: posted lines are Complete.'
]);

-- Policies ------------------------------------------------------------------------------------------------------------------

call private.install_policies('app.cost_centers',
  $$org_id in (select private.orgs_with_capability('finance.budget.read'))
    or org_id in (select private.orgs_with_capability('finance.cost_center.write'))$$,
  $$org_id in (select private.orgs_with_capability('finance.cost_center.write'))$$);

call private.install_policies('app.accounting_periods',
  $$org_id in (select private.orgs_with_capability('finance.journal.read'))$$,
  $$org_id in (select private.orgs_with_capability('finance.period.manage'))$$);
call private.install_policies('app.accounting_period_state_transitions',
  $$org_id in (select private.orgs_with_capability('finance.journal.read'))$$);

call private.install_policies('app.budgets',
  $$project_id in (select private.project_ids_with('finance.budget.read'))
    or org_id in (select private.oversight_org_ids('finance.budget.read'))$$,
  $$project_id in (select private.project_ids_with('finance.budget.write'))$$);

call private.install_policies('app.budget_lines',
  $$budget_id in (select b.id from app.budgets b where b.project_id in (select private.project_ids_with('finance.budget.read')))$$,
  $$budget_id in (select b.id from app.budgets b where b.project_id in (select private.project_ids_with('finance.budget.write')))$$);

call private.install_policies('app.spend_authorities',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.spend_authority.write'))$$);
call private.install_policies('app.spend_approvals',
  $$org_id in (select private.orgs_with_capability('finance.budget.read'))
    or approver_person_id = (select private.current_person_id())$$);

call private.install_policies('app.journal_entries',
  $$org_id in (select private.orgs_with_capability('finance.journal.read'))$$,
  $$org_id in (select private.orgs_with_capability('finance.journal.write'))$$);
call private.install_policies('app.journal_state_transitions',
  $$org_id in (select private.orgs_with_capability('finance.journal.read'))$$);
call private.install_policies('app.journal_lines',
  $$org_id in (select private.orgs_with_capability('finance.journal.read'))$$,
  $$org_id in (select private.orgs_with_capability('finance.journal.write'))$$);

revoke all on app.posting_lines from public, anon;
grant select on app.posting_lines to authenticated, service_role;

-- Spend authority rows: a person cannot raise their own limit (Section 8.2 sod_self_grant).
create or replace function private.guard_spend_authority()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and (
    new.membership_id in (select private.my_membership_ids())
    or new.role_id in (select mr.role_id from app.membership_roles mr
                       where mr.deleted_at is null and mr.membership_id in (select private.my_membership_ids()))
  ) then
    perform private.assert_separation('sod_self_grant', private.current_person_id(), private.current_person_id());
  end if;
  return new;
end;
$$;

comment on function private.guard_spend_authority() is 'A person cannot set a spend authority limit that applies to themselves, directly or through a role they hold (sod_self_grant).';

create trigger t40_guard_spend_authority before insert or update on app.spend_authorities
  for each row execute function private.guard_spend_authority();

-- Function privileges ---------------------------------------------------------------------------------------------------------

revoke all on function private.guard_accounting_period() from public, anon, authenticated;
revoke all on function private.guard_budget_line() from public, anon, authenticated;
revoke all on function private.guard_journal_entry() from public, anon, authenticated;
revoke all on function private.guard_journal_line() from public, anon, authenticated;
revoke all on function private.guard_spend_authority() from public, anon, authenticated;
revoke all on function app.post_journal_entry(uuid, text) from public, anon;
revoke all on function app.cancel_journal_entry(uuid, text) from public, anon;
revoke all on function app.transition_accounting_period(uuid, app.accounting_period_state, app.accounting_period_state, text) from public, anon;

grant execute on function app.post_journal_entry(uuid, text) to authenticated, service_role;
grant execute on function app.cancel_journal_entry(uuid, text) to authenticated, service_role;
grant execute on function app.transition_accounting_period(uuid, app.accounting_period_state, app.accounting_period_state, text) to authenticated, service_role;
