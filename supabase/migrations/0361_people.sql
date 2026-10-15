-- 0361_people.sql
-- A03 Domain Data (RRR-71). Section 7.4 People, for the People module (Section 4.2: parties, roles,
-- requisitions, agreements) and the Opportunities module that publishes requisitions. Offers live in the
-- A28 range (one app.offers with versioned terms and counter-offers); hires flow requisition, opportunity,
-- application, offer:
--   * role_assignments: a person filling a canon workforce role (xpms.dim_role, the 61 roles with
--     staffing ratios) on a project, with the basis the headcount was planned on
--   * requisitions: a request to staff a canon role (xpms.role, the same code engagements and
--     opportunities carry) on a project, approved under spend authority (document type Requisition)
--   * agreements: offer letters, contractor agreements, MSAs and NDAs signed by token and access code
--     (invariant 8). A signed agreement is never revoked or unsigned: Signed moves only to Superseded,
--     and its terms, signature and row never change again (journey 9).
-- Every table has a lifecycle through private.install_lifecycle, policies through
-- private.install_policies, and policy expressions that call only set-returning helpers keyed on the
-- session (ADR 0016 crash rule). Links to opportunities, applications and engagements are added from the
-- A28 range (0700 to 0799), which runs after this one.

-- Enums and lifecycle rules ------------------------------------------------------------------------------

create type app.staffing_basis as enum ('Ratio', 'Fixed', 'Declared');
comment on type app.staffing_basis is 'Basis a role assignment''s headcount was planned on: the canon staffing ratio (guests per person), a fixed count per tier, or declared by the planner.';

create type app.role_assignment_state as enum ('Proposed', 'Active', 'Complete', 'Canceled');
comment on type app.role_assignment_state is 'Role assignment lifecycle in the shared state vocabulary: planned (Proposed), working (Active), finished (Complete) or Canceled.';

create type app.requisition_state as enum ('Proposed', 'Approved', 'Rejected', 'Filled', 'Canceled');
comment on type app.requisition_state is 'Requisition lifecycle: requested (Proposed), Approved under spend authority, Rejected, Filled once its positions are hired, or Canceled. Approved and Rejected change only through app.approve_requisition and app.reject_requisition.';

create type app.agreement_kind as enum ('Offer Letter', 'Contractor Agreement', 'Master Services Agreement', 'Non-Disclosure Agreement');
comment on type app.agreement_kind is 'Kinds of agreement the People module prepares for signature (Section 7.4: contractor MSA, offer letter).';

create type app.agreement_state as enum ('Proposed', 'Sent', 'Signed', 'Superseded', 'Expired', 'Canceled');
comment on type app.agreement_state is 'Agreement lifecycle: drafted (Proposed), Sent for signature, Signed by the signer, later Superseded, or Expired or Canceled before signature. A Signed agreement is never revoked or unsigned: it moves only to Superseded.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('role_assignment', 'Proposed', 'Active'),
  ('role_assignment', 'Proposed', 'Canceled'),
  ('role_assignment', 'Active', 'Complete'),
  ('role_assignment', 'Active', 'Canceled'),
  ('requisition', 'Proposed', 'Approved'),
  ('requisition', 'Proposed', 'Rejected'),
  ('requisition', 'Proposed', 'Canceled'),
  ('requisition', 'Rejected', 'Proposed'),
  ('requisition', 'Approved', 'Filled'),
  ('requisition', 'Approved', 'Canceled'),
  ('agreement', 'Proposed', 'Sent'),
  ('agreement', 'Proposed', 'Canceled'),
  ('agreement', 'Sent', 'Proposed'),
  ('agreement', 'Sent', 'Signed'),
  ('agreement', 'Sent', 'Expired'),
  ('agreement', 'Sent', 'Canceled'),
  ('agreement', 'Signed', 'Superseded');

insert into private.domain_event_types (code, subject, description) values
  ('requisition.approved', 'requisitions', 'A staffing requisition was approved under spend authority.'),
  ('agreement.sent', 'agreements', 'An agreement was sent for signature.'),
  ('agreement.signed', 'agreements', 'An agreement was signed. It can no longer be revoked or unsigned.');

-- Amounts --------------------------------------------------------------------------------------------------

create or replace function private.requisition_amount(p_headcount integer, p_units_per_head numeric, p_rate_minor bigint)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select round(p_headcount * p_units_per_head * p_rate_minor)::bigint;
$$;

comment on function private.requisition_amount(integer, numeric, bigint) is 'Estimated spend of a requisition in minor units: headcount times pay basis units per head times the rate, rounded half away from zero. NULL when the units or the rate are unknown (Section 3.7). Takes column values, never re-reads the table (ADR 0016 crash rule).';
revoke all on function private.requisition_amount(integer, numeric, bigint) from public, anon;
grant execute on function private.requisition_amount(integer, numeric, bigint) to authenticated, service_role;

-- Requisitions ------------------------------------------------------------------------------------------------

create table app.requisitions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  scope_node_id uuid references app.scope_nodes (id),
  budget_line_id uuid references app.budget_lines (id),
  role_type app.external_role_type,
  role_code text not null references xpms.role (role_code),
  worker_classification text references xpms.worker_classification (code),
  pay_basis text references xpms.pay_basis (label),
  arrangement text references xpms.arrangement (label),
  headcount integer not null default 1,
  units_per_head numeric,
  rate_minor bigint,
  currency_code char(3) not null references private.currencies (currency_code),
  starts_on date,
  ends_on date,
  justification text not null,
  requested_by uuid references app.people (id),
  requisition_state app.requisition_state not null default 'Proposed',
  deleted_at timestamptz,
  constraint requisitions_headcount_positive check (headcount > 0),
  constraint requisitions_units_positive check (units_per_head is null or units_per_head > 0),
  constraint requisitions_rate_nonnegative check (rate_minor is null or rate_minor >= 0),
  constraint requisitions_pay_pair check ((pay_basis is null) = (arrangement is null)),
  constraint requisitions_rate_needs_basis check (rate_minor is null or pay_basis is not null),
  constraint requisitions_pay_needs_classification check (pay_basis is null or worker_classification is not null),
  constraint requisitions_dates check (ends_on is null or starts_on is null or ends_on >= starts_on),
  constraint requisitions_justification_length check (char_length(btrim(justification)) between 1 and 2000),
  constraint requisitions_rate_card_fkey foreign key (role_code, worker_classification, pay_basis, arrangement)
    references xpms.rate_card (role_code, worker_classification, pay_basis, arrangement)
);

create index requisitions_project_id_idx on app.requisitions (project_id);
create index requisitions_scope_node_id_idx on app.requisitions (scope_node_id);
create index requisitions_budget_line_id_idx on app.requisitions (budget_line_id);
create index requisitions_role_code_idx on app.requisitions (role_code, worker_classification, pay_basis, arrangement);
create index requisitions_worker_classification_idx on app.requisitions (worker_classification);
create index requisitions_pay_basis_idx on app.requisitions (pay_basis);
create index requisitions_arrangement_idx on app.requisitions (arrangement);
create index requisitions_currency_code_idx on app.requisitions (currency_code);
create index requisitions_requested_by_idx on app.requisitions (requested_by);
create index requisitions_state_idx on app.requisitions (requisition_state);

call private.install_domain_table('app.requisitions', 'app.projects', 'project_id',
  array['app.scope_nodes', 'scope_node_id', 'app.budget_lines', 'budget_line_id']);
call private.describe('app.requisitions', 'Staffing requisitions (Section 7.4 People, playbook Staffing Requisition): a request to staff a canon role on a project. Approval runs spend authority for document type Requisition on the estimated spend and is never by the requester. An Approved requisition is what an opportunity publishes (Section 4.2 Opportunities).', array[
  'project_id', 'Project to staff.',
  'scope_node_id', 'Scope node of the project the people work, when narrower than the project.',
  'budget_line_id', 'Budget line the labor spends against; its cost center scopes spend authority and its currency equals the requisition''s.',
  'role_type', 'External role type an opportunity published from the requisition seeks; NULL when it is filled internally.',
  'role_code', 'Canon role to staff (Roles Library, decision D12); the same code engagements and opportunities carry. Its class decides the GL account.',
  'worker_classification', 'Canon worker classification sought, when decided (decision D16).',
  'pay_basis', 'Canon pay basis the rate is per; with the classification, role and arrangement a canon rate card combination.',
  'arrangement', 'Canon arrangement; NULL exactly when the pay basis is NULL.',
  'headcount', 'Number of people to staff.',
  'units_per_head', 'Pay basis units each person works, for example hours or days; NULL while unknown, which leaves the estimate unpriced.',
  'rate_minor', 'Budgeted rate per pay basis unit in minor units; NULL is unpriced and is never approved.',
  'currency_code', 'ISO 4217 currency of the rate.',
  'starts_on', 'First day of the work.',
  'ends_on', 'Last day of the work.',
  'justification', 'Why the staff are needed.',
  'requested_by', 'Person who requested, set from the session; they cannot approve it (sod_approval_requester).',
  'requisition_state', 'Requisition state. Changes only through the requisition RPCs.'
]);

call private.install_lifecycle('app.requisitions', 'requisition_id', 'requisition_state', 'requisition', 'Proposed',
  $$requisition_id in (select r.id from app.requisitions r where r.project_id in (select private.project_ids_with('people.requisition.read')))$$);

create trigger t90_emit_requisition_approved after insert on app.requisition_state_transitions
  for each row when (new.to_state = 'Approved')
  execute function private.emit_subject_event('requisition.approved', 'requisitions', 'requisition_id', 'from_state', 'to_state');

create or replace function private.guard_requisition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_budget app.budgets;
begin
  if tg_op = 'INSERT' then
    new.requested_by := case when auth.uid() is not null then private.current_person_id() else new.requested_by end;
    perform private.assert_production_open(new.project_id);
  else
    if new.project_id <> old.project_id then
      perform private.refuse('requisition_project_immutable', 'A requisition stays on its project.');
    end if;
    if new.requested_by is distinct from old.requested_by then
      perform private.refuse('requisition_requester_immutable', 'The requester of a requisition never changes.');
    end if;
    if old.requisition_state <> 'Proposed' and (
        new.role_code <> old.role_code or new.worker_classification is distinct from old.worker_classification
        or new.pay_basis is distinct from old.pay_basis or new.arrangement is distinct from old.arrangement
        or new.headcount <> old.headcount or new.units_per_head is distinct from old.units_per_head
        or new.rate_minor is distinct from old.rate_minor or new.currency_code <> old.currency_code
        or new.budget_line_id is distinct from old.budget_line_id or new.role_type is distinct from old.role_type) then
      perform private.refuse('requisition_locked', 'A requisition''s role, terms and headcount change only while it is Proposed.');
    end if;
  end if;
  if new.scope_node_id is not null and not exists (
    select 1 from app.scope_nodes n where n.id = new.scope_node_id and n.project_id = new.project_id) then
    perform private.refuse('requisition_scope_project', 'A requisition''s scope node belongs to its project.');
  end if;
  if new.budget_line_id is not null then
    select b.* into v_budget from app.budgets b join app.budget_lines bl on bl.budget_id = b.id where bl.id = new.budget_line_id;
    if v_budget.project_id <> new.project_id then
      perform private.refuse('requisition_budget_project', 'A requisition spends against a budget line of its own project.');
    end if;
    if v_budget.currency_code <> new.currency_code then
      perform private.refuse('requisition_currency', format('The requisition is in %s but its budget is in %s.', new.currency_code, v_budget.currency_code));
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_requisition() is 'Requisitions: requester from the session, no new requisition on a closed production (invariant 10), project and requester fixed, terms locked once past Proposed, scope node and budget line from the same project, budget currency.';

create trigger t40_guard_requisition before insert or update on app.requisitions
  for each row execute function private.guard_requisition();

-- Role assignments --------------------------------------------------------------------------------------------

create table app.role_assignments (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  scope_node_id uuid references app.scope_nodes (id),
  role_code text not null references xpms.dim_role (role_code),
  person_id uuid not null references app.people (id),
  requisition_id uuid references app.requisitions (id),
  staffing_basis app.staffing_basis not null default 'Declared',
  starts_on date,
  ends_on date,
  assignment_state app.role_assignment_state not null default 'Proposed',
  deleted_at timestamptz,
  constraint role_assignments_dates check (ends_on is null or starts_on is null or ends_on >= starts_on)
);

create index role_assignments_project_id_idx on app.role_assignments (project_id, role_code);
create index role_assignments_scope_node_id_idx on app.role_assignments (scope_node_id);
create index role_assignments_role_code_idx on app.role_assignments (role_code);
create index role_assignments_person_id_idx on app.role_assignments (person_id);
create index role_assignments_requisition_id_idx on app.role_assignments (requisition_id);
create unique index role_assignments_one_per_person on app.role_assignments (project_id, role_code, person_id)
  where deleted_at is null and assignment_state in ('Proposed', 'Active');

call private.install_domain_table('app.role_assignments', 'app.projects', 'project_id',
  array['app.scope_nodes', 'scope_node_id', 'app.requisitions', 'requisition_id']);
call private.describe('app.role_assignments', 'People assigned to canon workforce roles on a project (Section 7.4 People, playbook Personnel Roster and Roles Library). The role is one of the 61 canon workforce roles; its staffing ratio and ratio basis are read from canon (xpms.dim_role), never copied. A person holds a role on a project once while it is Proposed or Active.', array[
  'project_id', 'Project the role is worked on.',
  'scope_node_id', 'Scope node of the project, when narrower than the project.',
  'role_code', 'Canon workforce role (xpms.dim_role).',
  'person_id', 'Person assigned, an active member of the org when assigned. External people work through engagements (A28).',
  'requisition_id', 'Requisition the assignment fills, when it came from one.',
  'staffing_basis', 'Ratio when planned from the canon staffing ratio (the role has one), Fixed when the canon basis is a fixed count per tier, Declared otherwise.',
  'starts_on', 'First day in the role.',
  'ends_on', 'Last day in the role.',
  'assignment_state', 'Assignment state. Changes only through app.transition_role_assignment.'
]);

call private.install_lifecycle('app.role_assignments', 'role_assignment_id', 'assignment_state', 'role_assignment', 'Proposed',
  $$role_assignment_id in (select a.id from app.role_assignments a
    where a.project_id in (select private.project_ids_with('people.directory.read')) or a.person_id = (select private.current_person_id()))$$);

create or replace function private.guard_role_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role xpms.dim_role;
begin
  if tg_op = 'UPDATE' and (new.project_id <> old.project_id or new.person_id <> old.person_id or new.role_code <> old.role_code) then
    perform private.refuse('role_assignment_immutable', 'A role assignment keeps its project, person and role; end it and assign again.');
  end if;
  select r.* into v_role from xpms.dim_role r where r.role_code = new.role_code;
  if new.staffing_basis = 'Ratio' and v_role.staffing_ratio is null then
    perform private.refuse('role_assignment_basis', 'The canon role has no staffing ratio; plan it as Fixed or Declared.');
  end if;
  if new.staffing_basis = 'Fixed' and v_role.ratio_basis is distinct from 'fixed per tier' then
    perform private.refuse('role_assignment_basis', 'The canon role is not staffed as a fixed count per tier; plan it by Ratio or Declared.');
  end if;
  if new.scope_node_id is not null and not exists (
    select 1 from app.scope_nodes n where n.id = new.scope_node_id and n.project_id = new.project_id) then
    perform private.refuse('role_assignment_scope_project', 'A role assignment''s scope node belongs to its project.');
  end if;
  if new.requisition_id is not null and not exists (
    select 1 from app.requisitions r where r.id = new.requisition_id and r.project_id = new.project_id
      and r.requisition_state in ('Approved', 'Filled')) then
    perform private.refuse('role_assignment_requisition', 'A role assignment fills an Approved or Filled requisition of its own project.');
  end if;
  if tg_op = 'INSERT' and not exists (
      select 1 from app.memberships m
      where m.person_id = new.person_id and m.org_id = new.org_id and m.deleted_at is null
        and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
    perform private.refuse('role_assignment_person', 'Assign an active member of the org; external people work through engagements.');
  end if;
  return new;
end;
$$;

comment on function private.guard_role_assignment() is 'Role assignments: project, person and role fixed; the staffing basis agrees with canon; scope node and requisition from the same project; the person is an active member of the org.';

create trigger t40_guard_role_assignment before insert or update on app.role_assignments
  for each row execute function private.guard_role_assignment();

-- Agreements ----------------------------------------------------------------------------------------------------------

create table app.agreements (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid references app.projects (id),
  offer_id uuid,
  person_id uuid references app.people (id),
  counterparty_id uuid references app.counterparties (id),
  agreement_kind app.agreement_kind not null,
  title text not null,
  body text not null,
  token_hash bytea,
  access_code_hash text,
  token_expires_at timestamptz,
  failed_attempts smallint not null default 0,
  signed_at timestamptz,
  signed_name text,
  signed_body_sha256 text,
  agreement_state app.agreement_state not null default 'Proposed',
  deleted_at timestamptz,
  constraint agreements_party check (person_id is not null or counterparty_id is not null),
  constraint agreements_title_length check (char_length(btrim(title)) between 1 and 200),
  constraint agreements_body_length check (char_length(btrim(body)) between 1 and 200000),
  constraint agreements_token_set check ((token_hash is null) = (access_code_hash is null) and (token_hash is null) = (token_expires_at is null)),
  constraint agreements_token_hash_length check (token_hash is null or octet_length(token_hash) = 32),
  constraint agreements_failed_attempts_range check (failed_attempts between 0 and 5),
  constraint agreements_signature_set check ((signed_at is null) = (signed_name is null) and (signed_at is null) = (signed_body_sha256 is null)),
  constraint agreements_signed_name_length check (signed_name is null or char_length(btrim(signed_name)) between 1 and 200),
  constraint agreements_signed_body_format check (signed_body_sha256 is null or signed_body_sha256 ~ '^[0-9a-f]{64}$')
);

create index agreements_project_id_idx on app.agreements (project_id);
create index agreements_offer_id_idx on app.agreements (offer_id);
create index agreements_person_id_idx on app.agreements (person_id);
create index agreements_counterparty_id_idx on app.agreements (counterparty_id);
create unique index agreements_token_hash_key on app.agreements (token_hash) where token_hash is not null;

call private.install_domain_table('app.agreements', null, null,
  array['app.projects', 'project_id', 'app.counterparties', 'counterparty_id']);
call private.describe('app.agreements', 'Agreements prepared for signature (Section 7.4 People): offer letters, contractor agreements, MSAs and NDAs. Sent with a signing token and an access code shown once and stored hashed (invariant 8); signed by the signer through the token or while signed in. A Signed agreement is never revoked or unsigned: its terms, signature and row never change and it moves only to Superseded (journey 9).', array[
  'project_id', 'Project the agreement covers, whose org it takes; NULL for an org-wide agreement such as an MSA, which names its org.',
  'offer_id', 'Offer the agreement documents, for an offer letter. The foreign key to app.offers is added from the A28 range, which owns offers.',
  'person_id', 'Person who signs, or the person an organization supplies.',
  'counterparty_id', 'External organization party to the agreement.',
  'agreement_kind', 'Offer Letter, Contractor Agreement, Master Services Agreement or Non-Disclosure Agreement.',
  'title', 'Title, Title Case.',
  'body', 'Full text the signer reads and signs. Changes only while Proposed.',
  'token_hash', 'SHA-256 of the signing token; the token is shown once when sent. Never selectable by signed-in callers.',
  'access_code_hash', 'bcrypt hash of the access code that goes with the token. Never selectable by signed-in callers.',
  'token_expires_at', 'When the signing token stops working.',
  'failed_attempts', 'Wrong access codes entered with the token; the token locks at 5.',
  'signed_at', 'When the agreement was signed.',
  'signed_name', 'Name the signer typed as their signature.',
  'signed_body_sha256', 'SHA-256 of the exact text signed, lowercase hex.',
  'agreement_state', 'Agreement state. Changes only through the agreement RPCs.'
]);

call private.install_lifecycle('app.agreements', 'agreement_id', 'agreement_state', 'agreement', 'Proposed',
  $$agreement_id in (select a.id from app.agreements a
    where (a.project_id is null and a.org_id in (select private.orgs_with_capability('people.agreement.write')))
      or a.project_id in (select private.project_ids_with('people.agreement.write'))
      or a.person_id = (select private.current_person_id()))$$);

create trigger t90_emit_agreement_sent after insert on app.agreement_state_transitions
  for each row when (new.to_state = 'Sent')
  execute function private.emit_subject_event('agreement.sent', 'agreements', 'agreement_id', 'from_state', 'to_state');
create trigger t90_emit_agreement_signed after insert on app.agreement_state_transitions
  for each row when (new.to_state = 'Signed')
  execute function private.emit_subject_event('agreement.signed', 'agreements', 'agreement_id', 'from_state', 'to_state');

create or replace function private.guard_agreement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_signing boolean := private.in_trusted_operation('agreement_signing');
begin
  if tg_op = 'INSERT' then
    new.token_hash := null;
    new.access_code_hash := null;
    new.token_expires_at := null;
    new.failed_attempts := 0;
    new.signed_at := null;
    new.signed_name := null;
    new.signed_body_sha256 := null;
  else
    if old.agreement_state in ('Signed', 'Superseded') and (
        new.deleted_at is distinct from old.deleted_at or new.body <> old.body or new.title <> old.title
        or new.signed_at is distinct from old.signed_at or new.signed_name is distinct from old.signed_name
        or new.signed_body_sha256 is distinct from old.signed_body_sha256) then
      perform private.refuse('agreement_signed_permanent', 'A signed agreement is never revoked, unsigned or edited; supersede it with a new agreement.');
    end if;
    if new.project_id is distinct from old.project_id or new.offer_id is distinct from old.offer_id
       or new.person_id is distinct from old.person_id or new.counterparty_id is distinct from old.counterparty_id
       or new.agreement_kind <> old.agreement_kind then
      perform private.refuse('agreement_immutable', 'An agreement keeps its kind, project, offer and parties.');
    end if;
    if old.agreement_state <> 'Proposed' and (new.body <> old.body or new.title <> old.title) then
      perform private.refuse('agreement_locked', 'An agreement''s text changes only while it is Proposed; recall it first.');
    end if;
    if not v_signing and (
        new.token_hash is distinct from old.token_hash or new.access_code_hash is distinct from old.access_code_hash
        or new.token_expires_at is distinct from old.token_expires_at or new.failed_attempts <> old.failed_attempts
        or new.signed_at is distinct from old.signed_at or new.signed_name is distinct from old.signed_name
        or new.signed_body_sha256 is distinct from old.signed_body_sha256) then
      perform private.refuse('agreement_signing_rpc_only', 'Signing tokens and signatures change only through the agreement RPCs.');
    end if;
  end if;
  if new.agreement_state in ('Signed', 'Superseded') and new.signed_at is null then
    perform private.refuse('agreement_signature_missing', 'An agreement is Signed only with a recorded signature.');
  end if;
  return new;
end;
$$;

comment on function private.guard_agreement() is 'Agreements: signing columns start empty and change only inside the agreement RPCs; kind, project, offer and parties fixed; text editable only while Proposed; a Signed or Superseded agreement is never edited, unsigned or deleted (journey 9).';

create trigger t40_guard_agreement before insert or update on app.agreements
  for each row execute function private.guard_agreement();

create or replace function private.derive_agreement_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.project_id is not null then
    new.org_id := (select p.org_id from app.projects p where p.id = new.project_id);
  end if;
  return new;
end;
$$;

comment on function private.derive_agreement_org() is 'An agreement covering a project takes the project''s org; an org-wide agreement names its org.';
revoke all on function private.derive_agreement_org() from public, anon, authenticated;

create trigger t10_derive_org_id before insert on app.agreements
  for each row execute function private.derive_agreement_org();

-- Requisition RPCs ------------------------------------------------------------------------------------------------------

create or replace function app.approve_requisition(p_requisition_id uuid, p_reason text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_req app.requisitions;
  v_amount bigint;
  v_account text;
  v_cost_center uuid;
begin
  select * into v_req from app.requisitions r where r.id = p_requisition_id and r.deleted_at is null for update;
  if v_req.id is null or not private.can_on_project(v_req.project_id, 'people.requisition.approve') then
    raise exception using errcode = '42501', message = 'people.requisition.approve is required on the project';
  end if;
  perform private.assert_separation('sod_approval_requester', v_person, v_req.requested_by);
  if v_req.requisition_state <> 'Proposed' then
    perform private.refuse('requisition_state_conflict', 'Only a Proposed requisition can be approved.');
  end if;
  v_amount := private.requisition_amount(v_req.headcount, v_req.units_per_head, v_req.rate_minor);
  if v_amount is null then
    perform private.refuse('requisition_unpriced', 'A requisition needs a rate and the units per head before it is approved.');
  end if;
  v_account := private.gl_account_for(v_req.role_code, 'Expense');
  select bl.cost_center_id into v_cost_center from app.budget_lines bl where bl.id = v_req.budget_line_id;
  if not private.approve_under_spend_authority(v_req.org_id, 'Requisition', v_req.id, v_amount, v_req.currency_code,
       v_account, v_cost_center) then
    return false;
  end if;
  perform private.transition_lifecycle('requisition', 'app.requisitions', 'requisition_state', 'app.requisition_state_transitions',
    'requisition_id', p_requisition_id, 'Proposed', 'Approved', p_reason);
  return true;
end;
$$;

comment on function app.approve_requisition(uuid, text) is 'Approves a Proposed requisition: people.requisition.approve on the project, never by the requester (sod_approval_requester), refused while unpriced, under spend authority for Requisition on headcount times units times rate, scoped by the role class''s expense account and the budget line''s cost center. Two approvers above the dual threshold. Returns true once fully approved (emits requisition.approved).';

create or replace function app.reject_requisition(p_requisition_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_req app.requisitions;
begin
  select * into v_req from app.requisitions r where r.id = p_requisition_id and r.deleted_at is null;
  if v_req.id is null or not private.can_on_project(v_req.project_id, 'people.requisition.approve') then
    raise exception using errcode = '42501', message = 'people.requisition.approve is required on the project';
  end if;
  perform private.assert_separation('sod_approval_requester', private.require_person(), v_req.requested_by);
  return private.transition_lifecycle('requisition', 'app.requisitions', 'requisition_state', 'app.requisition_state_transitions',
    'requisition_id', p_requisition_id, 'Proposed', 'Rejected', p_reason);
end;
$$;

comment on function app.reject_requisition(uuid, text) is 'Rejects a Proposed requisition; the same eligibility and separation of duties as approval.';

create or replace function app.transition_requisition(p_requisition_id uuid, p_expected app.requisition_state, p_next app.requisition_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_req app.requisitions;
begin
  if p_next in ('Approved', 'Rejected') then
    perform private.refuse('requisition_use_approval_rpc', 'Approve or reject a requisition through app.approve_requisition or app.reject_requisition.');
  end if;
  select * into v_req from app.requisitions r where r.id = p_requisition_id and r.deleted_at is null for update;
  if v_req.id is null or not (private.can_on_project(v_req.project_id, 'people.requisition.write')
      or (v_req.requested_by = v_person and p_next in ('Proposed', 'Canceled'))) then
    raise exception using errcode = '42501', message = 'people.requisition.write is required on the project';
  end if;
  return private.transition_lifecycle('requisition', 'app.requisitions', 'requisition_state', 'app.requisition_state_transitions',
    'requisition_id', p_requisition_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_requisition(uuid, app.requisition_state, app.requisition_state, text) is 'Resubmits, fills or cancels a requisition with compare-and-set. Needs people.requisition.write on the project; the requester may resubmit or cancel their own. Filled closes it once its positions are hired.';

create or replace function private.assert_requisition_approved(p_requisition_id uuid, p_project_id uuid, p_role_code text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_req app.requisitions;
begin
  select * into v_req from app.requisitions r where r.id = p_requisition_id and r.deleted_at is null;
  if v_req.id is null or v_req.requisition_state <> 'Approved' then
    perform private.refuse('requisition_not_approved', 'Publish only from an Approved requisition; approve it under spend authority first.');
  end if;
  if v_req.project_id <> p_project_id or (p_role_code is not null and v_req.role_code <> p_role_code) then
    perform private.refuse('requisition_mismatch', 'The requisition is for another project or role.');
  end if;
end;
$$;

comment on function private.assert_requisition_approved(uuid, uuid, text) is 'For the Opportunities module (A28): refuses unless the requisition is Approved and is for the given project and, when given, role. Call it inside the publish RPC to enforce spend authority before publishing (ADR 0019). Takes values, never a row of the caller''s scanned table (ADR 0016 crash rule).';
revoke all on function private.assert_requisition_approved(uuid, uuid, text) from public, anon, authenticated;

-- Role assignment RPC -------------------------------------------------------------------------------------------------------

create or replace function app.transition_role_assignment(p_role_assignment_id uuid, p_expected app.role_assignment_state, p_next app.role_assignment_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid := (select a.project_id from app.role_assignments a where a.id = p_role_assignment_id and a.deleted_at is null);
begin
  perform private.require_person();
  if v_project is null or not private.can_on_project(v_project, 'people.role.write') then
    raise exception using errcode = '42501', message = 'people.role.write is required on the project';
  end if;
  return private.transition_lifecycle('role_assignment', 'app.role_assignments', 'assignment_state', 'app.role_assignment_state_transitions',
    'role_assignment_id', p_role_assignment_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_role_assignment(uuid, app.role_assignment_state, app.role_assignment_state, text) is 'Starts, completes or cancels a role assignment with compare-and-set. Needs people.role.write on the project.';

-- Agreement RPCs ------------------------------------------------------------------------------------------------------------

create or replace function private.can_write_agreement(p_org_id uuid, p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_project_id is null then private.has_capability(p_org_id, 'people.agreement.write')
              else private.can_on_project(p_project_id, 'people.agreement.write') end;
$$;

comment on function private.can_write_agreement(uuid, uuid) is 'True when the signed-in person may prepare an agreement: people.agreement.write on its project, or org-wide for an agreement without one. Takes column values (ADR 0016 crash rule).';
revoke all on function private.can_write_agreement(uuid, uuid) from public, anon;
grant execute on function private.can_write_agreement(uuid, uuid) to authenticated, service_role;

create or replace function app.send_agreement(p_agreement_id uuid, p_reason text, p_valid_for interval default interval '14 days')
returns table (signing_token text, access_code text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_agreement app.agreements;
  v_token text := 'xagr_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_code text := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 100000000)::text, 8, '0');
begin
  perform private.require_person();
  select * into v_agreement from app.agreements a where a.id = p_agreement_id and a.deleted_at is null for update;
  if v_agreement.id is null or not private.can_write_agreement(v_agreement.org_id, v_agreement.project_id) then
    raise exception using errcode = '42501', message = 'people.agreement.write is required';
  end if;
  if p_valid_for is null or p_valid_for <= interval '0' or p_valid_for > interval '90 days' then
    perform private.refuse('agreement_token_validity', 'A signing token is valid for more than zero and at most 90 days.');
  end if;
  perform private.transition_lifecycle('agreement', 'app.agreements', 'agreement_state', 'app.agreement_state_transitions',
    'agreement_id', p_agreement_id, 'Proposed', 'Sent', p_reason);
  perform private.begin_trusted_operation('agreement_signing');
  update app.agreements set token_hash = extensions.digest(v_token, 'sha256'),
    access_code_hash = extensions.crypt(v_code, extensions.gen_salt('bf')),
    token_expires_at = now() + p_valid_for, failed_attempts = 0
  where id = p_agreement_id;
  perform private.end_trusted_operation('agreement_signing');
  return query select v_token, v_code;
end;
$$;

comment on function app.send_agreement(uuid, text, interval) is 'Sends a Proposed agreement for signature: needs people.agreement.write, issues a signing token and an 8 digit access code, returned once and stored only as hashes (invariant 8), valid for up to 90 days (14 by default). The platform delivers them to the signer through separate channels.';

create or replace function app.transition_agreement(p_agreement_id uuid, p_expected app.agreement_state, p_next app.agreement_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_agreement app.agreements;
  v_entry uuid;
begin
  if p_next = 'Signed' then
    perform private.refuse('agreement_signed_by_signer', 'Only the signer signs, through the signing token or while signed in.');
  end if;
  if p_next = 'Sent' then
    perform private.refuse('agreement_use_send_rpc', 'Send an agreement through app.send_agreement, which issues its signing token.');
  end if;
  perform private.require_person();
  select * into v_agreement from app.agreements a where a.id = p_agreement_id and a.deleted_at is null for update;
  if v_agreement.id is null or not private.can_write_agreement(v_agreement.org_id, v_agreement.project_id) then
    raise exception using errcode = '42501', message = 'people.agreement.write is required';
  end if;
  v_entry := private.transition_lifecycle('agreement', 'app.agreements', 'agreement_state', 'app.agreement_state_transitions',
    'agreement_id', p_agreement_id, p_expected::text, p_next::text, p_reason);
  if p_expected = 'Sent' then
    perform private.begin_trusted_operation('agreement_signing');
    update app.agreements set token_hash = null, access_code_hash = null, token_expires_at = null where id = p_agreement_id;
    perform private.end_trusted_operation('agreement_signing');
  end if;
  return v_entry;
end;
$$;

comment on function app.transition_agreement(uuid, app.agreement_state, app.agreement_state, text) is 'Recalls, expires, cancels or supersedes an agreement with compare-and-set; leaving Sent voids the signing token. Needs people.agreement.write. A Signed agreement only moves to Superseded: it is never revoked or unsigned.';

create or replace function private.sign_agreement(p_agreement_id uuid, p_signed_name text, p_body_sha256 text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_agreement app.agreements;
begin
  select * into v_agreement from app.agreements a where a.id = p_agreement_id for update;
  if v_agreement.agreement_state <> 'Sent' or v_agreement.deleted_at is not null
     or p_signed_name is null or char_length(btrim(p_signed_name)) not between 1 and 200
     or p_body_sha256 is distinct from encode(extensions.digest(v_agreement.body, 'sha256'), 'hex') then
    return false;
  end if;
  perform private.begin_trusted_operation('agreement_signing');
  update app.agreements set signed_name = btrim(p_signed_name), signed_body_sha256 = p_body_sha256,
    signed_at = now(), token_hash = null, access_code_hash = null, token_expires_at = null
  where id = p_agreement_id;
  perform private.transition_lifecycle('agreement', 'app.agreements', 'agreement_state', 'app.agreement_state_transitions',
    'agreement_id', p_agreement_id, 'Sent', 'Signed', 'Signed by the signer.');
  perform private.end_trusted_operation('agreement_signing');
  return true;
end;
$$;

comment on function private.sign_agreement(uuid, text, text) is 'Records a signature on a Sent agreement when the signer''s typed name is present and the hash matches the current text, then moves it to Signed and voids the token. Callers authenticate the signer first.';
revoke all on function private.sign_agreement(uuid, text, text) from public, anon, authenticated;

create or replace function private.agreement_by_token(p_token text, p_access_code text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_agreement app.agreements;
begin
  select * into v_agreement from app.agreements a
  where a.token_hash = extensions.digest(coalesce(p_token, ''), 'sha256') for update;
  if v_agreement.id is null or v_agreement.deleted_at is not null or v_agreement.agreement_state <> 'Sent'
     or v_agreement.token_expires_at <= now() or v_agreement.failed_attempts >= 5 then
    return null;
  end if;
  if v_agreement.access_code_hash <> extensions.crypt(coalesce(p_access_code, ''), v_agreement.access_code_hash) then
    perform private.begin_trusted_operation('agreement_signing');
    update app.agreements set failed_attempts = least(failed_attempts + 1, 5) where id = v_agreement.id;
    perform private.end_trusted_operation('agreement_signing');
    return null;
  end if;
  return v_agreement.id;
end;
$$;

comment on function private.agreement_by_token(text, text) is 'Resolves a live signing token and its access code to the agreement, or NULL. A wrong access code counts a failed attempt and the token locks at 5 (invariant 8). Never raises, so the count persists.';
revoke all on function private.agreement_by_token(text, text) from public, anon, authenticated;

create or replace function api_public.read_agreement(p_token text, p_access_code text)
returns table (organization_name text, agreement_kind text, title text, body text, body_sha256 text, token_expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid := private.agreement_by_token(p_token, p_access_code);
begin
  return query
  select o.name, a.agreement_kind::text, a.title, a.body, encode(extensions.digest(a.body, 'sha256'), 'hex'), a.token_expires_at
  from app.agreements a join app.organizations o on o.id = a.org_id
  where a.id = v_id;
end;
$$;

comment on function api_public.read_agreement(text, text) is 'Named token RPC (invariants 7 and 8): with a live signing token and its access code, returns only what the signing page renders: the org name, kind, title, full text and its hash, and the token expiry. Nothing otherwise; a wrong access code counts toward the lock at 5.';

create or replace function api_public.sign_agreement(p_token text, p_access_code text, p_signed_name text, p_body_sha256 text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid := private.agreement_by_token(p_token, p_access_code);
begin
  if v_id is null then
    return false;
  end if;
  return private.sign_agreement(v_id, p_signed_name, p_body_sha256);
end;
$$;

comment on function api_public.sign_agreement(text, text, text, text) is 'Named token RPC (invariant 8): signs a Sent agreement with its live signing token and access code, the signer''s typed name and the SHA-256 of the text they read (from api_public.read_agreement). Returns true when signed, false otherwise; emits agreement.signed. A signed agreement is never unsigned.';

create or replace function app.sign_agreement(p_agreement_id uuid, p_signed_name text, p_body_sha256 text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_signer uuid := (select a.person_id from app.agreements a where a.id = p_agreement_id);
begin
  if v_signer is null or v_signer <> v_person then
    raise exception using errcode = '42501', message = 'only the person named on the agreement signs it';
  end if;
  return private.sign_agreement(p_agreement_id, p_signed_name, p_body_sha256);
end;
$$;

comment on function app.sign_agreement(uuid, text, text) is 'Signs a Sent agreement as the signed-in person it names, with their typed name and the SHA-256 of the text they read. Returns true when signed.';

-- Masked views ----------------------------------------------------------------------------------------------------------------

create view app.requisition_amounts with (security_invoker = true) as
select r.id as requisition_id, r.org_id, r.project_id, r.headcount,
  private.requisition_amount(r.headcount, r.units_per_head, r.rate_minor) as estimated_minor, r.currency_code
from app.requisitions r
where r.deleted_at is null;

call private.describe('app.requisition_amounts', 'Derived figures of each requisition the caller may read: estimated spend, NULL while unpriced and never zero.', array[
  'requisition_id', 'Requisition.', 'org_id', 'Org.', 'project_id', 'Project.', 'headcount', 'Positions requested.',
  'estimated_minor', 'Headcount times units per head times rate, in minor units; NULL when any is unknown.',
  'currency_code', 'Currency.'
]);

revoke all on app.requisition_amounts from public, anon;
grant select on app.requisition_amounts to authenticated, service_role;

-- Policies ----------------------------------------------------------------------------------------------------------------

call private.install_policies('app.requisitions',
  $$project_id in (select private.project_ids_with('people.requisition.read'))$$,
  $$project_id in (select private.project_ids_with('people.requisition.write'))$$);

call private.install_policies('app.role_assignments',
  $$project_id in (select private.project_ids_with('people.directory.read')) or person_id = (select private.current_person_id())$$,
  $$project_id in (select private.project_ids_with('people.role.write'))$$);

call private.install_policies('app.agreements',
  $$(project_id is null and org_id in (select private.orgs_with_capability('people.agreement.write')))
    or project_id in (select private.project_ids_with('people.agreement.write'))
    or person_id = (select private.current_person_id())$$,
  $$(project_id is null and org_id in (select private.orgs_with_capability('people.agreement.write')))
    or project_id in (select private.project_ids_with('people.agreement.write'))$$);

-- Restricted and secret columns are never selectable directly.
revoke select on app.agreements from authenticated;
grant select (id, org_id, project_id, offer_id, person_id, counterparty_id, agreement_kind, title, body, token_expires_at,
  failed_attempts, signed_at, signed_name, signed_body_sha256, agreement_state,
  created_at, created_by, updated_at, updated_by, deleted_at) on app.agreements to authenticated;

-- Function privileges ---------------------------------------------------------------------------------------------------------

revoke all on function private.guard_requisition() from public, anon, authenticated;
revoke all on function private.guard_role_assignment() from public, anon, authenticated;
revoke all on function private.guard_agreement() from public, anon, authenticated;
revoke all on function app.approve_requisition(uuid, text) from public, anon;
revoke all on function app.reject_requisition(uuid, text) from public, anon;
revoke all on function app.transition_requisition(uuid, app.requisition_state, app.requisition_state, text) from public, anon;
revoke all on function app.transition_role_assignment(uuid, app.role_assignment_state, app.role_assignment_state, text) from public, anon;
revoke all on function app.send_agreement(uuid, text, interval) from public, anon;
revoke all on function app.transition_agreement(uuid, app.agreement_state, app.agreement_state, text) from public, anon;
revoke all on function app.sign_agreement(uuid, text, text) from public, anon;
revoke all on function api_public.read_agreement(text, text) from public;
revoke all on function api_public.sign_agreement(text, text, text, text) from public;

grant execute on function app.approve_requisition(uuid, text) to authenticated, service_role;
grant execute on function app.reject_requisition(uuid, text) to authenticated, service_role;
grant execute on function app.transition_requisition(uuid, app.requisition_state, app.requisition_state, text) to authenticated, service_role;
grant execute on function app.transition_role_assignment(uuid, app.role_assignment_state, app.role_assignment_state, text) to authenticated, service_role;
grant execute on function app.send_agreement(uuid, text, interval) to authenticated, service_role;
grant execute on function app.transition_agreement(uuid, app.agreement_state, app.agreement_state, text) to authenticated, service_role;
grant execute on function app.sign_agreement(uuid, text, text) to authenticated, service_role;
grant execute on function api_public.read_agreement(text, text) to anon, authenticated, service_role;
grant execute on function api_public.sign_agreement(text, text, text, text) to anon, authenticated, service_role;
