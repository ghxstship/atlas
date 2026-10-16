-- 1030_approvals.sql
-- A33 Platform workflow (RRR-77). The approval workflow engine of Section 4.10 ("Workflow engine:
-- approval_policies, approval_steps, approval_instances, approval_decisions") and its wiring into the
-- spend documents of A15 (finance) and A16 (procurement).
--
--   * An approval policy is keyed by spend document type (app.spend_document_type, 0320 and 0360). It
--     applies to every document of its type, or only to documents above an amount in its currency. An
--     org has at most one Active policy per document type. Its ordered steps name the approvers: a
--     role, or one member. Steps are edited only while the policy is a Draft, so a policy in use never
--     changes under an approval in flight.
--   * An approval instance is one document going through its policy. It is requested through
--     app.request_approval, which reads the document's amount, currency and project from the
--     document itself, so nobody can request approval of a smaller amount than the document carries.
--     Each step is decided through app.decide_approval by an eligible approver, never the requester
--     (sod_approval_requester), and one person decides at most one step of an instance. The last
--     approving step approves the instance; any rejection rejects it.
--   * Wiring: every spend approval RPC (approve_purchase_order, decide_po_change_order,
--     approve_change_order, approve_invoice, approve_requisition, approve_expense,
--     approve_payroll_run) runs private.approve_under_spend_authority. This migration redefines that
--     one function with the same signature and body plus one gate: when an Active policy applies to
--     the document, the document is approved only once an Approved instance covers its current
--     amount in its currency. Orgs without policies behave exactly as before.
-- Refusals use SQLSTATE XR001 (private.refuse). Every function pins search_path to ''. Policy helpers
-- take column values as arguments and never re-read the table being scanned (ADR 0016 rule 14).

-- Enums -------------------------------------------------------------------------------------------------

create type app.approval_policy_state as enum ('Draft', 'Active', 'Retired');
comment on type app.approval_policy_state is 'Approval policy lifecycle: edited as a Draft, Active while it gates documents, Retired when it stops.';

create type app.approval_state as enum ('In Review', 'Approved', 'Rejected', 'Canceled');
comment on type app.approval_state is 'Approval instance lifecycle: In Review while steps are decided, then Approved, Rejected or Canceled.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('approval_policy', 'Draft', 'Active'),
  ('approval_policy', 'Draft', 'Retired'),
  ('approval_policy', 'Active', 'Retired'),
  ('approval', 'In Review', 'Approved'),
  ('approval', 'In Review', 'Rejected'),
  ('approval', 'In Review', 'Canceled'),
  ('approval', 'Approved', 'Canceled');

insert into private.domain_event_types (code, subject, description) values
  ('approval_policy.state_changed', 'approval_policies', 'An approval policy was activated or retired.'),
  ('approval.requested', 'approval_instances', 'A document was submitted for approval under a policy.'),
  ('approval.step_decided', 'approval_decisions', 'An approver decided one step of an approval.'),
  ('approval.approved', 'approval_instances', 'Every step of an approval was approved.'),
  ('approval.rejected', 'approval_instances', 'An approver rejected an approval.'),
  ('approval.canceled', 'approval_instances', 'An approval was withdrawn or superseded.')
on conflict (code) do nothing;

-- Policies ----------------------------------------------------------------------------------------------

create table app.approval_policies (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  description text,
  document_type app.spend_document_type not null,
  currency_code char(3) references private.currencies (currency_code),
  applies_above_minor bigint,
  policy_state app.approval_policy_state not null default 'Draft',
  deleted_at timestamptz,
  constraint approval_policies_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint approval_policies_description_length check (description is null or char_length(description) <= 2000),
  constraint approval_policies_threshold_pair check ((applies_above_minor is null) = (currency_code is null)),
  constraint approval_policies_threshold_nonnegative check (applies_above_minor is null or applies_above_minor >= 0),
  constraint approval_policies_document_type_supported check (document_type <> 'Contract')
);

create index approval_policies_currency_code_idx on app.approval_policies (currency_code);
create index approval_policies_lookup_idx on app.approval_policies (org_id, document_type) where deleted_at is null;
create unique index approval_policies_one_active on app.approval_policies (org_id, document_type)
  where policy_state = 'Active' and deleted_at is null;

call private.install_domain_table('app.approval_policies');
call private.describe('app.approval_policies', 'Approval policies (Section 4.10 workflow engine): ordered approval steps a spend document passes before its own approval RPC accepts it. Keyed by document type; one Active policy per type per org.', array[
  'name', 'Policy name.',
  'description', 'What the policy is for, shown to requesters and approvers.',
  'document_type', 'Spend document type the policy gates. Contract (settlement rounds) is not gated by policies.',
  'currency_code', 'ISO 4217 currency of applies_above_minor; NULL when the policy applies to every document.',
  'applies_above_minor', 'The policy applies to documents above this amount in currency_code (and to documents in any other currency); NULL for every document of the type.',
  'policy_state', 'Draft, Active or Retired. Changes only through app.transition_approval_policy.'
]);

call private.install_lifecycle('app.approval_policies', 'approval_policy_id', 'policy_state', 'approval_policy', 'Draft',
  $$approval_policy_id in (select p.id from app.approval_policies p where p.org_id in (select private.my_org_ids()))$$);

create trigger t90_emit_approval_policy_state after insert on app.approval_policy_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('approval_policy.state_changed', 'approval_policies', 'approval_policy_id', 'from_state', 'to_state');

create or replace function private.guard_approval_policy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.policy_state <> 'Draft'
     and (new.document_type is distinct from old.document_type
          or new.currency_code is distinct from old.currency_code
          or new.applies_above_minor is distinct from old.applies_above_minor) then
    perform private.refuse('approval_policy_not_draft',
      'Only a Draft policy changes its document type or threshold; create a new policy and retire this one.');
  end if;
  if tg_op = 'UPDATE' and old.deleted_at is null and new.deleted_at is not null and old.policy_state = 'Active' then
    perform private.refuse('approval_policy_active_delete', 'Retire an Active policy before deleting it.');
  end if;
  return new;
end;
$$;

comment on function private.guard_approval_policy() is 'An Active or Retired policy keeps its document type and threshold, and an Active policy is retired before it is deleted.';
revoke all on function private.guard_approval_policy() from public, anon, authenticated;

create trigger t40_guard_approval_policy before update on app.approval_policies
  for each row execute function private.guard_approval_policy();

call private.install_policies('app.approval_policies',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.approval_policies.write'))$$);

-- Steps -------------------------------------------------------------------------------------------------

create table app.approval_steps (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  approval_policy_id uuid not null references app.approval_policies (id),
  step_order smallint not null,
  name text not null,
  approver_role_id uuid references app.roles (id),
  approver_membership_id uuid references app.memberships (id),
  deleted_at timestamptz,
  constraint approval_steps_order_range check (step_order between 1 and 10),
  constraint approval_steps_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint approval_steps_one_approver check (num_nonnulls(approver_role_id, approver_membership_id) = 1)
);

create index approval_steps_policy_idx on app.approval_steps (approval_policy_id, step_order);
create index approval_steps_role_idx on app.approval_steps (approver_role_id);
create index approval_steps_membership_idx on app.approval_steps (approver_membership_id);
create unique index approval_steps_order_key on app.approval_steps (approval_policy_id, step_order) where deleted_at is null;

call private.install_domain_table('app.approval_steps', 'app.approval_policies', 'approval_policy_id',
  array['app.roles', 'approver_role_id', 'app.memberships', 'approver_membership_id']);
call private.describe('app.approval_steps', 'Ordered steps of an approval policy. Each names its approvers: everyone holding a role, or one member. Edited only while the policy is a Draft.', array[
  'approval_policy_id', 'Policy the step belongs to.',
  'step_order', 'Position of the step, 1 first; steps are decided in order.',
  'name', 'Step name, such as Department head or Finance.',
  'approver_role_id', 'Role whose holders may decide the step; NULL when one member decides it.',
  'approver_membership_id', 'The one member who decides the step; NULL when a role decides it.'
]);

create or replace function private.approval_policy_state_of(p_policy_id uuid)
returns app.approval_policy_state
language sql
stable
security definer
set search_path = ''
as $$
  select p.policy_state from app.approval_policies p where p.id = p_policy_id;
$$;

comment on function private.approval_policy_state_of(uuid) is 'State of an approval policy, for the step guard (takes the policy id as a value).';
revoke all on function private.approval_policy_state_of(uuid) from public, anon, authenticated;

create or replace function private.guard_approval_step()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.approval_policy_state_of(new.approval_policy_id) is distinct from 'Draft'
     or (tg_op = 'UPDATE' and private.approval_policy_state_of(old.approval_policy_id) is distinct from 'Draft') then
    perform private.refuse('approval_step_policy_not_draft',
      'Steps change only while the policy is a Draft, so approvals in flight keep the steps they started with.');
  end if;
  return new;
end;
$$;

comment on function private.guard_approval_step() is 'Steps are added, edited and removed only while their policy is a Draft.';
revoke all on function private.guard_approval_step() from public, anon, authenticated;

create trigger t40_guard_approval_step before insert or update on app.approval_steps
  for each row execute function private.guard_approval_step();

call private.install_policies('app.approval_steps',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.approval_policies.write'))$$);

-- Approver eligibility ------------------------------------------------------------------------------------

create or replace function private.is_step_approver(p_org_id uuid, p_role_id uuid, p_membership_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_membership_id is not null then exists (
      select 1 from app.memberships m
      where m.id = p_membership_id and m.org_id = p_org_id and m.person_id = private.current_person_id()
        and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()))
    when p_role_id is not null then exists (
      select 1 from app.membership_roles mr
      join app.memberships m on m.id = mr.membership_id
      where mr.role_id = p_role_id and mr.deleted_at is null and m.org_id = p_org_id
        and m.person_id = private.current_person_id()
        and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()))
    else false
  end;
$$;

comment on function private.is_step_approver(uuid, uuid, uuid) is 'True when the signed-in person may decide a step naming this role or membership in the org: they hold the role through an active membership, or they are the member.';
revoke all on function private.is_step_approver(uuid, uuid, uuid) from public, anon;
grant execute on function private.is_step_approver(uuid, uuid, uuid) to authenticated, service_role;

create or replace function private.is_policy_approver(p_policy_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.approval_steps s
    where s.approval_policy_id = p_policy_id and s.deleted_at is null
      and private.is_step_approver(s.org_id, s.approver_role_id, s.approver_membership_id));
$$;

comment on function private.is_policy_approver(uuid) is 'True when the signed-in person is an approver of any step of the policy.';
revoke all on function private.is_policy_approver(uuid) from public, anon;
grant execute on function private.is_policy_approver(uuid) to authenticated, service_role;

create or replace function private.step_approver_person_ids(p_policy_id uuid, p_step_order smallint)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct m.person_id
  from app.approval_steps s
  join app.memberships m on m.org_id = s.org_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  where s.approval_policy_id = p_policy_id and s.step_order = p_step_order and s.deleted_at is null
    and (m.id = s.approver_membership_id
         or exists (select 1 from app.membership_roles mr
                    where mr.membership_id = m.id and mr.role_id = s.approver_role_id and mr.deleted_at is null));
$$;

comment on function private.step_approver_person_ids(uuid, smallint) is 'People who may decide one step of a policy now, for notifications.';
revoke all on function private.step_approver_person_ids(uuid, smallint) from public, anon, authenticated;

-- Instances ---------------------------------------------------------------------------------------------

create table app.approval_instances (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  approval_policy_id uuid not null references app.approval_policies (id),
  document_type app.spend_document_type not null,
  document_id uuid not null,
  subject_table text not null,
  subject_reference text,
  project_id uuid references app.projects (id),
  amount_minor bigint not null,
  currency_code char(3) not null references private.currencies (currency_code),
  requested_by uuid not null references app.people (id),
  approval_state app.approval_state not null default 'In Review',
  current_step smallint not null default 1,
  decided_at timestamptz,
  deleted_at timestamptz,
  constraint approval_instances_subject_table check (subject_table in
    ('purchase_orders', 'po_change_orders', 'change_orders', 'invoices', 'requisitions', 'expenses', 'payroll_runs')),
  constraint approval_instances_reference_length check (subject_reference is null or char_length(subject_reference) <= 300),
  constraint approval_instances_amount_nonnegative check (amount_minor >= 0),
  constraint approval_instances_step_range check (current_step between 1 and 10),
  constraint approval_instances_decided check ((decided_at is null) = (approval_state = 'In Review'))
);

create index approval_instances_policy_idx on app.approval_instances (approval_policy_id);
create index approval_instances_document_idx on app.approval_instances (document_id, document_type);
create index approval_instances_project_idx on app.approval_instances (project_id);
create index approval_instances_currency_code_idx on app.approval_instances (currency_code);
create index approval_instances_requested_by_idx on app.approval_instances (requested_by);
create unique index approval_instances_one_live on app.approval_instances (document_type, document_id)
  where approval_state in ('In Review', 'Approved') and deleted_at is null;

call private.install_domain_table('app.approval_instances', 'app.approval_policies', 'approval_policy_id',
  array['app.projects', 'project_id']);
call private.describe('app.approval_instances', 'A spend document going through its approval policy. Created only by app.request_approval, which reads the amount, currency and project from the document; decided step by step through app.decide_approval.', array[
  'approval_policy_id', 'Policy the document goes through.',
  'document_type', 'Spend document type.',
  'document_id', 'Id of the document in subject_table.',
  'subject_table', 'Table of the document: purchase_orders, po_change_orders, change_orders, invoices, requisitions, expenses or payroll_runs.',
  'subject_reference', 'The document''s own number or name when requested, for display.',
  'project_id', 'Project of the document; NULL for org-level documents such as payroll runs.',
  'amount_minor', 'Amount submitted for approval, in minor units; the approval covers the document only while its amount stays at or below it.',
  'currency_code', 'ISO 4217 currency of the amount.',
  'requested_by', 'Person who requested the approval; never an approver of it (sod_approval_requester).',
  'approval_state', 'In Review, Approved, Rejected or Canceled. Changes only through the approval RPCs.',
  'current_step', 'Step order waiting for a decision while In Review; the last step decided afterwards.',
  'decided_at', 'When the approval was approved, rejected or canceled; NULL while In Review.'
]);

create or replace function private.can_read_approval(p_org_id uuid, p_policy_id uuid, p_requested_by uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_org_id in (select private.my_org_ids())
    and (p_requested_by = private.current_person_id()
         or p_org_id in (select private.orgs_with_capability('org.approval_policies.write'))
         or private.is_policy_approver(p_policy_id));
$$;

comment on function private.can_read_approval(uuid, uuid, uuid) is 'Read rule of approval instances, from column values: the requester, the policy''s approvers and policy administrators (org.approval_policies.write) of the org.';
revoke all on function private.can_read_approval(uuid, uuid, uuid) from public, anon;
grant execute on function private.can_read_approval(uuid, uuid, uuid) to authenticated, service_role;

call private.install_policies('app.approval_instances',
  $$private.can_read_approval(org_id, approval_policy_id, requested_by)$$);

create or replace function private.readable_approval_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select i.id from app.approval_instances i
  where i.deleted_at is null and private.can_read_approval(i.org_id, i.approval_policy_id, i.requested_by);
$$;

comment on function private.readable_approval_ids() is 'Approval instances the signed-in person may read; used by the policies of the decision and state ledgers, never by app.approval_instances itself.';
revoke all on function private.readable_approval_ids() from public, anon;
grant execute on function private.readable_approval_ids() to authenticated, service_role;

call private.install_lifecycle('app.approval_instances', 'approval_instance_id', 'approval_state', 'approval', 'In Review',
  $$approval_instance_id in (select private.readable_approval_ids())$$);


create trigger t90_emit_approval_approved after insert on app.approval_state_transitions
  for each row when (new.to_state = 'Approved')
  execute function private.emit_subject_event('approval.approved', 'approval_instances', 'approval_instance_id', 'from_state', 'to_state');
create trigger t90_emit_approval_rejected after insert on app.approval_state_transitions
  for each row when (new.to_state = 'Rejected')
  execute function private.emit_subject_event('approval.rejected', 'approval_instances', 'approval_instance_id', 'from_state', 'to_state');
create trigger t90_emit_approval_canceled after insert on app.approval_state_transitions
  for each row when (new.to_state = 'Canceled')
  execute function private.emit_subject_event('approval.canceled', 'approval_instances', 'approval_instance_id', 'from_state', 'to_state', 'reason');
create trigger t90_emit_approval_requested after insert on app.approval_instances
  for each row execute function private.emit_subject_event('approval.requested', 'approval_instances', 'id',
    'document_type', 'document_id', 'amount_minor', 'currency_code');

-- Decisions ---------------------------------------------------------------------------------------------

create table app.approval_decisions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  approval_instance_id uuid not null references app.approval_instances (id),
  step_order smallint not null,
  approver_id uuid not null references app.people (id),
  approved boolean not null,
  comment text,
  decided_at timestamptz not null default now(),
  constraint approval_decisions_step_range check (step_order between 1 and 10),
  constraint approval_decisions_comment_length check (comment is null or char_length(comment) <= 2000),
  constraint approval_decisions_rejection_reason check (approved or (comment is not null and char_length(btrim(comment)) > 0))
);

create index approval_decisions_instance_idx on app.approval_decisions (approval_instance_id, step_order);
create index approval_decisions_approver_idx on app.approval_decisions (approver_id);
create unique index approval_decisions_one_per_step on app.approval_decisions (approval_instance_id, step_order);
create unique index approval_decisions_one_per_approver on app.approval_decisions (approval_instance_id, approver_id);

call private.install_domain_table('app.approval_decisions', 'app.approval_instances', 'approval_instance_id', '{}', true);
call private.describe('app.approval_decisions', 'Append-only decisions on approval steps, written only by app.decide_approval: one per step, one step per approver, never by the requester.', array[
  'approval_instance_id', 'Approval decided.',
  'step_order', 'Step decided.',
  'approver_id', 'Person who decided, from the session.',
  'approved', 'True when the step was approved; false rejects the approval.',
  'comment', 'Why; required when rejecting.',
  'decided_at', 'When it was decided.'
]);

call private.install_policies('app.approval_decisions',
  $$approval_instance_id in (select private.readable_approval_ids())$$);

create trigger t90_emit_approval_step_decided after insert on app.approval_decisions
  for each row execute function private.emit_subject_event('approval.step_decided', 'approval_decisions', 'id',
    'approval_instance_id', 'step_order', 'approved');

-- Spend documents -----------------------------------------------------------------------------------------

create or replace function private.spend_document_facts(p_document_type app.spend_document_type, p_document_id uuid)
returns table (
  org_id uuid,
  project_id uuid,
  subject_table text,
  subject_reference text,
  amount_minor bigint,
  currency_code char(3),
  write_capability text,
  approve_capability text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  case p_document_type
    when 'Purchase Order' then
      return query
        select po.org_id, po.project_id, 'purchase_orders'::text, po.po_number::text,
               private.purchase_order_total(po.id), po.currency_code, 'procurement.po.write'::text, 'finance.po.approve'::text
        from app.purchase_orders po where po.id = p_document_id and po.deleted_at is null;
      if not found then
        return query
          select c.org_id, po.project_id, 'po_change_orders'::text, po.po_number::text || ': ' || left(c.description, 200),
                 abs(c.amount_delta_minor), po.currency_code, 'procurement.po.write'::text, 'finance.po.approve'::text
          from app.po_change_orders c join app.purchase_orders po on po.id = c.purchase_order_id
          where c.id = p_document_id and c.deleted_at is null;
      end if;
    when 'Change Order' then
      return query
        select c.org_id, c.project_id, 'change_orders'::text, c.change_order_number::text || ': ' || c.title,
               greatest(private.change_order_total(c.id), 0), b.currency_code, 'finance.change_order.write'::text, 'finance.change_order.approve'::text
        from app.change_orders c join app.budgets b on b.id = c.budget_id
        where c.id = p_document_id and c.deleted_at is null;
    when 'Invoice Approval' then
      return query
        select i.org_id, i.project_id, 'invoices'::text, i.invoice_number::text,
               private.invoice_total(i.id), i.currency_code, 'finance.invoice.write'::text, 'finance.invoice.approve'::text
        from app.invoices i where i.id = p_document_id and i.deleted_at is null and i.direction = 'Payable';
    when 'Requisition' then
      return query
        select r.org_id, r.project_id, 'requisitions'::text, r.role_code,
               private.requisition_amount(r.headcount, r.units_per_head, r.rate_minor), r.currency_code,
               'people.requisition.write'::text, 'people.requisition.approve'::text
        from app.requisitions r where r.id = p_document_id and r.deleted_at is null;
    when 'Expense' then
      return query
        select e.org_id, b.project_id, 'expenses'::text, left(e.description, 200),
               e.amount_minor, e.currency_code, 'finance.expense.write'::text, 'finance.expense.approve'::text
        from app.expenses e
        join app.budget_lines bl on bl.id = e.budget_line_id
        join app.budgets b on b.id = bl.budget_id
        where e.id = p_document_id and e.deleted_at is null;
    when 'Payroll Run' then
      return query
        select r.org_id, null::uuid, 'payroll_runs'::text, null::text,
               (select coalesce(sum(private.extended_minor(l.hours, l.rate_minor)), 0)::bigint
                from app.payroll_lines l where l.payroll_run_id = r.id and l.deleted_at is null),
               r.currency_code, 'crew.pay_period.manage'::text, 'crew.pay_period.manage'::text
        from app.payroll_runs r where r.id = p_document_id and r.deleted_at is null;
    else
      return;
  end case;
end;
$$;

comment on function private.spend_document_facts(app.spend_document_type, uuid) is 'Org, project, table, display reference, amount (as its approval RPC computes it, NULL while unpriced), currency, and the capabilities that prepare and approve a spend document. No row for an unknown document or a Contract.';
revoke all on function private.spend_document_facts(app.spend_document_type, uuid) from public, anon, authenticated;

create or replace function private.applicable_approval_policy(
  p_org_id uuid,
  p_document_type app.spend_document_type,
  p_amount_minor bigint,
  p_currency_code char(3)
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id from app.approval_policies p
  where p.org_id = p_org_id and p.document_type = p_document_type
    and p.policy_state = 'Active' and p.deleted_at is null
    and (p.applies_above_minor is null
         or p.currency_code is distinct from p_currency_code
         or p_amount_minor is null
         or p_amount_minor > p.applies_above_minor)
  limit 1;
$$;

comment on function private.applicable_approval_policy(uuid, app.spend_document_type, bigint, char) is 'The Active policy that applies to a document of this type, amount and currency, or NULL. A policy with a threshold applies above it in its currency and to every document in another currency, because amounts in different currencies are never compared.';
revoke all on function private.applicable_approval_policy(uuid, app.spend_document_type, bigint, char) from public, anon, authenticated;

create or replace function private.approval_requester_may_cancel(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select v.value_boolean from app.setting_values v
    where v.org_id = p_org_id and v.setting_key = 'approvals.requester_may_cancel'
      and v.scope_kind = 'Organization' and v.scope_id = p_org_id and v.deleted_at is null
    limit 1), true);
$$;

comment on function private.approval_requester_may_cancel(uuid) is 'The org setting approvals.requester_may_cancel (default true): whether a requester may withdraw their own approval.';
revoke all on function private.approval_requester_may_cancel(uuid) from public, anon, authenticated;

-- Settings (packages/schemas/settings/a33.yaml) ---------------------------------------------------------

select private.define_setting('approvals.requester_may_cancel', 'Boolean', 'org.approval_policies.write', array['organization'], false, p_default_boolean => true);

-- RPCs --------------------------------------------------------------------------------------------------

create or replace function app.transition_approval_policy(
  p_approval_policy_id uuid,
  p_expected app.approval_policy_state,
  p_next app.approval_policy_state,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_policy app.approval_policies;
begin
  perform private.require_person();
  select * into v_policy from app.approval_policies p where p.id = p_approval_policy_id and p.deleted_at is null for update;
  if v_policy.id is null or not private.has_capability(v_policy.org_id, 'org.approval_policies.write') then
    raise exception using errcode = '42501', message = 'org.approval_policies.write is required';
  end if;
  if p_next = 'Active' then
    if not exists (select 1 from app.approval_steps s where s.approval_policy_id = v_policy.id and s.deleted_at is null) then
      perform private.refuse('approval_policy_no_steps', 'A policy needs at least one step before it is activated.');
    end if;
    if exists (select 1 from app.approval_policies p
               where p.org_id = v_policy.org_id and p.document_type = v_policy.document_type
                 and p.policy_state = 'Active' and p.deleted_at is null and p.id <> v_policy.id) then
      perform private.refuse('approval_policy_active_exists',
        format('Another %s policy is Active; retire it before activating this one.', v_policy.document_type));
    end if;
  end if;
  return private.transition_lifecycle('approval_policy', 'app.approval_policies', 'policy_state',
    'app.approval_policy_state_transitions', 'approval_policy_id', p_approval_policy_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_approval_policy(uuid, app.approval_policy_state, app.approval_policy_state, text) is 'Activates or retires an approval policy with compare-and-set (org.approval_policies.write). Activation needs at least one step and no other Active policy of the same document type.';
revoke all on function app.transition_approval_policy(uuid, app.approval_policy_state, app.approval_policy_state, text) from public, anon;
grant execute on function app.transition_approval_policy(uuid, app.approval_policy_state, app.approval_policy_state, text) to authenticated, service_role;

create or replace function private.notify_step_approvers(p_instance app.approval_instances)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid;
  v_title text := p_instance.document_type::text || coalesce(' ' || p_instance.subject_reference, '');
begin
  for v_person in
    select x from private.step_approver_person_ids(p_instance.approval_policy_id, p_instance.current_step) x
    where x <> p_instance.requested_by
      and not exists (select 1 from app.approval_decisions d
                      where d.approval_instance_id = p_instance.id and d.approver_id = x)
  loop
    perform private.notify(p_instance.org_id, v_person, 'approval.requested', 'approval_instances', p_instance.id,
      p_instance.project_id, jsonb_build_object('title', v_title,
        'actorName', (select p.full_name from app.people p where p.id = p_instance.requested_by)));
  end loop;
end;
$$;

comment on function private.notify_step_approvers(app.approval_instances) is 'Notifies everyone who may decide the instance''s current step (approval.requested), except the requester and people who already decided a step.';
revoke all on function private.notify_step_approvers(app.approval_instances) from public, anon, authenticated;

create or replace function app.request_approval(p_document_type app.spend_document_type, p_document_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_doc record;
  v_policy uuid;
  v_live app.approval_instances;
  v_instance app.approval_instances;
begin
  select * into v_doc from private.spend_document_facts(p_document_type, p_document_id);
  if v_doc.org_id is null
     or (v_doc.project_id is not null and not private.can_on_project(v_doc.project_id, v_doc.write_capability))
     or (v_doc.project_id is null and not private.has_capability(v_doc.org_id, v_doc.write_capability)) then
    raise exception using errcode = '42501', message = 'the document is not visible to you, or you cannot prepare it';
  end if;
  if v_doc.amount_minor is null then
    perform private.refuse('approval_unpriced', 'Price every line of the document before requesting approval.');
  end if;
  v_policy := private.applicable_approval_policy(v_doc.org_id, p_document_type, v_doc.amount_minor, v_doc.currency_code);
  if v_policy is null then
    perform private.refuse('approval_policy_none',
      format('No Active approval policy applies to this %s; approve it directly.', p_document_type));
  end if;
  if not exists (select 1 from app.approval_steps s where s.approval_policy_id = v_policy and s.deleted_at is null) then
    perform private.refuse('approval_policy_no_steps', 'The policy has no steps.');
  end if;

  select * into v_live from app.approval_instances i
  where i.document_type = p_document_type and i.document_id = p_document_id
    and i.approval_state in ('In Review', 'Approved') and i.deleted_at is null
  for update;
  if v_live.id is not null then
    if v_live.approval_state = 'In Review' then
      perform private.refuse('approval_in_review', 'This document is already in review.');
    end if;
    if v_live.currency_code = v_doc.currency_code and v_live.amount_minor >= v_doc.amount_minor then
      perform private.refuse('approval_already_approved', 'This document is already approved for its current amount.');
    end if;
    perform private.transition_lifecycle('approval', 'app.approval_instances', 'approval_state',
      'app.approval_state_transitions', 'approval_instance_id', v_live.id, 'Approved', 'Canceled',
      'Superseded: the document''s amount changed after approval.');
  end if;

  insert into app.approval_instances (approval_policy_id, document_type, document_id, subject_table, subject_reference,
    project_id, amount_minor, currency_code, requested_by, current_step)
  values (v_policy, p_document_type, p_document_id, v_doc.subject_table, v_doc.subject_reference,
    v_doc.project_id, v_doc.amount_minor, v_doc.currency_code, v_person,
    (select min(s.step_order) from app.approval_steps s where s.approval_policy_id = v_policy and s.deleted_at is null))
  returning * into v_instance;
  perform private.notify_step_approvers(v_instance);
  return v_instance.id;
end;
$$;

comment on function app.request_approval(app.spend_document_type, uuid) is 'Submits a spend document to the Active policy that applies to it, for its current amount and currency read from the document. The caller prepares the document (its write capability on the project, or crew.pay_period.manage for payroll runs). Refuses an unpriced document, a document no policy applies to and a document already in review; supersedes an approval whose amount the document has outgrown. Notifies the first step''s approvers. Returns the instance id.';
revoke all on function app.request_approval(app.spend_document_type, uuid) from public, anon;
grant execute on function app.request_approval(app.spend_document_type, uuid) to authenticated, service_role;

create or replace function private.guard_approval_instance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.approval_state is distinct from old.approval_state then
    new.decided_at := now();
  end if;
  if private.in_trusted_operation('approval_decision') or private.in_trusted_operation('approval_transition') then
    return new;
  end if;
  if new.current_step is distinct from old.current_step or new.decided_at is distinct from old.decided_at
     or new.amount_minor is distinct from old.amount_minor or new.currency_code is distinct from old.currency_code
     or new.document_id is distinct from old.document_id or new.document_type is distinct from old.document_type
     or new.requested_by is distinct from old.requested_by or new.approval_policy_id is distinct from old.approval_policy_id then
    perform private.refuse('approval_instance_rpc_only', 'An approval changes only through its RPCs.');
  end if;
  return new;
end;
$$;

comment on function private.guard_approval_instance() is 'Stamps decided_at whenever the approval leaves a state, and lets the step, amount, document, requester and decision time change only inside the approval RPCs.';
revoke all on function private.guard_approval_instance() from public, anon, authenticated;

create trigger t40_guard_approval_instance before update on app.approval_instances
  for each row execute function private.guard_approval_instance();

create or replace function app.decide_approval(p_approval_instance_id uuid, p_approved boolean, p_comment text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_instance app.approval_instances;
  v_step app.approval_steps;
  v_next smallint;
  v_decision uuid;
  v_title text;
  v_capability text;
begin
  select * into v_instance from app.approval_instances i
  where i.id = p_approval_instance_id and i.deleted_at is null for update;
  if v_instance.id is null or v_instance.org_id not in (select private.my_org_ids()) then
    raise exception using errcode = '42501', message = 'approval not found';
  end if;
  if v_instance.approval_state <> 'In Review' then
    perform private.refuse('approval_not_in_review', format('This approval is %s; only an approval in review is decided.', v_instance.approval_state));
  end if;
  perform private.assert_separation('sod_approval_requester', v_person, v_instance.requested_by);
  select * into v_step from app.approval_steps s
  where s.approval_policy_id = v_instance.approval_policy_id and s.step_order = v_instance.current_step and s.deleted_at is null;
  if v_step.id is null or not private.is_step_approver(v_instance.org_id, v_step.approver_role_id, v_step.approver_membership_id) then
    perform private.refuse('approval_not_step_approver', 'You are not an approver of the step this approval is waiting on.');
  end if;
  select f.approve_capability into v_capability from private.spend_document_facts(v_instance.document_type, v_instance.document_id) f;
  if v_capability is null
     or (v_instance.project_id is not null and not private.can_on_project(v_instance.project_id, v_capability))
     or (v_instance.project_id is null and not private.has_capability(v_instance.org_id, v_capability)) then
    perform private.refuse('approval_approver_capability',
      'Approving this document needs its approval capability; a step''s approver must also hold it.');
  end if;
  if exists (select 1 from app.approval_decisions d where d.approval_instance_id = v_instance.id and d.approver_id = v_person) then
    perform private.refuse('approval_one_step_per_approver', 'You already decided a step of this approval; the next step needs another approver.');
  end if;
  if not coalesce(p_approved, false) and (p_comment is null or char_length(btrim(p_comment)) = 0) then
    perform private.refuse('approval_rejection_reason', 'Say why when you reject an approval.');
  end if;

  insert into app.approval_decisions (approval_instance_id, step_order, approver_id, approved, comment)
  values (v_instance.id, v_instance.current_step, v_person, coalesce(p_approved, false), nullif(btrim(p_comment), ''))
  returning id into v_decision;

  v_title := v_instance.document_type::text || coalesce(' ' || v_instance.subject_reference, '');
  if not coalesce(p_approved, false) then
    perform private.transition_lifecycle('approval', 'app.approval_instances', 'approval_state',
      'app.approval_state_transitions', 'approval_instance_id', v_instance.id, 'In Review', 'Rejected', btrim(p_comment));
  else
    select min(s.step_order) into v_next from app.approval_steps s
    where s.approval_policy_id = v_instance.approval_policy_id and s.deleted_at is null and s.step_order > v_instance.current_step;
    if v_next is null then
      perform private.transition_lifecycle('approval', 'app.approval_instances', 'approval_state',
        'app.approval_state_transitions', 'approval_instance_id', v_instance.id, 'In Review', 'Approved',
        coalesce(nullif(btrim(p_comment), ''), 'Every step approved.'));
    else
      perform private.begin_trusted_operation('approval_decision');
      update app.approval_instances set current_step = v_next where id = v_instance.id returning * into v_instance;
      perform private.end_trusted_operation('approval_decision');
      perform private.notify_step_approvers(v_instance);
      return v_decision;
    end if;
  end if;
  perform private.notify(v_instance.org_id, v_instance.requested_by, 'approval.decided', 'approval_instances', v_instance.id,
    v_instance.project_id, jsonb_build_object('title', v_title, 'decision', case when p_approved then 'approved' else 'rejected' end,
      'actorName', (select p.full_name from app.people p where p.id = v_person)));
  return v_decision;
end;
$$;

comment on function app.decide_approval(uuid, boolean, text) is 'Decides the step an approval is waiting on: an eligible approver of that step who also holds the document''s approval capability (finance.po.approve and so on, on its project), never the requester (sod_approval_requester), one step per person, with a reason when rejecting. Approving the last step approves the instance; a rejection rejects it. Notifies the next step''s approvers, or the requester once decided. Returns the decision id.';
revoke all on function app.decide_approval(uuid, boolean, text) from public, anon;
grant execute on function app.decide_approval(uuid, boolean, text) to authenticated, service_role;

create or replace function app.cancel_approval(p_approval_instance_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_instance app.approval_instances;
  v_entry uuid;
begin
  select * into v_instance from app.approval_instances i
  where i.id = p_approval_instance_id and i.deleted_at is null for update;
  if v_instance.id is null or v_instance.org_id not in (select private.my_org_ids()) then
    raise exception using errcode = '42501', message = 'approval not found';
  end if;
  if not private.has_capability(v_instance.org_id, 'org.approval_policies.write') then
    if v_instance.requested_by <> v_person then
      raise exception using errcode = '42501', message = 'only the requester or a policy administrator cancels an approval';
    end if;
    if not private.approval_requester_may_cancel(v_instance.org_id) then
      perform private.refuse('approval_requester_cancel_off', 'Your organization lets only policy administrators withdraw approvals.');
    end if;
  end if;
  v_entry := private.transition_lifecycle('approval', 'app.approval_instances', 'approval_state',
    'app.approval_state_transitions', 'approval_instance_id', v_instance.id, v_instance.approval_state::text, 'Canceled', p_reason);
  return v_entry;
end;
$$;

comment on function app.cancel_approval(uuid, text) is 'Withdraws an approval in review, or an approved one before the document uses it: the requester (when approvals.requester_may_cancel allows) or a holder of org.approval_policies.write. Returns the ledger entry id.';
revoke all on function app.cancel_approval(uuid, text) from public, anon;
grant execute on function app.cancel_approval(uuid, text) to authenticated, service_role;

-- The spend authority gate (wires policies into every spend approval RPC) -----------------------------------

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
  v_policy uuid;
  v_needed integer;
  v_given integer;
begin
  if p_amount_minor is null then
    perform private.refuse('spend_unpriced', 'An unpriced amount cannot be approved; price it first.');
  end if;
  v_policy := private.applicable_approval_policy(p_org_id, p_document_type, p_amount_minor, p_currency_code);
  if v_policy is not null and not exists (
    select 1 from app.approval_instances i
    where i.document_type = p_document_type and i.document_id = p_document_id and i.deleted_at is null
      and i.approval_state = 'Approved' and i.currency_code = p_currency_code and i.amount_minor >= p_amount_minor
  ) then
    perform private.refuse('approval_policy_pending',
      format('This %s needs approval under the policy %s before it is approved; request approval first.',
        p_document_type, (select p.name from app.approval_policies p where p.id = v_policy)));
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

comment on function private.approve_under_spend_authority(uuid, app.spend_document_type, uuid, bigint, char, text, uuid) is 'Section 8.1, enforced inside every approval RPC: refuses an unpriced amount; refuses while an Active approval policy applies and no Approved approval covers the document''s amount in its currency (approval_policy_pending, A33); finds the widest limit that applies to the signed-in approver, refuses a missing limit or an amount above it, records the approval, and returns true once enough distinct approvers (two above the dual threshold) have approved.';
revoke all on function private.approve_under_spend_authority(uuid, app.spend_document_type, uuid, bigint, char, text, uuid) from public, anon, authenticated;

-- Retention -------------------------------------------------------------------------------------------------

call private.install_default_retention('app.approval_policies');
call private.install_default_retention('app.approval_policy_state_transitions');
call private.install_default_retention('app.approval_steps');
call private.install_default_retention('app.approval_instances');
call private.install_default_retention('app.approval_state_transitions');
call private.install_default_retention('app.approval_decisions');
