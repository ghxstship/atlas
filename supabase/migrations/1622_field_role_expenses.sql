-- 1622_field_role_expenses.sql
--
-- Notification and access decisions (ADR 0022, 1620-1629), RRR-125; owner decision 38 of 2026-10-23 (ADR 0033). The
-- Field role records expenses, so field crews file them from Compass with A92's receipt capture (1490, ADR 0048).
-- Approval still goes through the budget owner: Field holds no finance.expense.approve, and app.approve_expense refuses
-- the submitter whoever they are (sod_expense_submitter, 0321).
--   * The Field system role holds finance.expense.write at assigned reach: on the projects its holder is assigned to,
--     never org-wide. Org copies of roles are not touched (as 1110 left them): an org that shaped its own role chose
--     its grants. packages/schemas/capabilities.yaml still renders 0203 unchanged and notes this grant beside the code.
--   * app.expense_budget_lines lists the budget lines a person may post an expense to, without amounts. Compass's line
--     picker read app.budget_lines, whose rows need finance.budget.read, which Field does not hold and should not: a
--     budget line carries its quantity and unit price. The view reads the lines of projects where the person holds
--     finance.expense.write, and only the columns the picker shows.
--   * A receipt photo was readable by anyone holding finance.expense.write on its project. Until now only roles that
--     also read every expense held it; a field crew member now holds it, so write alone reads only the receipts of
--     expenses the person submitted. finance.expense.read still reads every receipt on the project.
--   * app.transition_expense let anyone holding finance.expense.write cancel or resubmit someone else's expense. A
--     person other than the submitter now needs finance.expense.approve on the project, the budget owner's side; for
--     Owner, Admin and Manager, who hold both, nothing changes.

-- 1. The Field role records expenses on its projects --------------------------------------------------------------------

insert into app.role_capabilities (role_id, capability_code, reach)
select r.id, 'finance.expense.write', 'assigned'::app.capability_reach
from app.roles r
where r.org_id is null and r.code = 'field'
  and not exists (
    select 1 from app.role_capabilities rc
    where rc.role_id = r.id and rc.capability_code = 'finance.expense.write' and rc.deleted_at is null);

-- 2. The lines a person may post to, without amounts --------------------------------------------------------------------
-- Security definer view (owner reads) with its own row filter, like app.engagement_resolved (ADR 0016 item 14).

create view app.expense_budget_lines as
select bl.id, bl.org_id, b.id as budget_id, b.project_id, b.name as budget_name, b.currency_code, b.is_baseline,
  bl.line_number, bl.description, bl.urid
from app.budget_lines bl
join app.budgets b on b.id = bl.budget_id
where bl.deleted_at is null and b.deleted_at is null
  and b.project_id in (select private.project_ids_with('finance.expense.write'));

call private.describe('app.expense_budget_lines', 'The budget lines a person may post an expense to (finance.expense.write on the project, 1622), as the expense line picker shows them: no quantities, prices or totals, so a field crew member who files expenses never reads the budget (finance.budget.read).', array[
  'id', 'Budget line.',
  'org_id', 'Org.',
  'budget_id', 'Budget the line belongs to.',
  'project_id', 'Project of the budget.',
  'budget_name', 'Budget name.',
  'currency_code', 'Currency of the budget; an expense on the line is in it.',
  'is_baseline', 'True for the project''s baseline budget.',
  'line_number', 'Line number within the budget.',
  'description', 'Line description.',
  'urid', 'Canon item the line budgets.'
]);

revoke all on app.expense_budget_lines from public, anon;
grant select on app.expense_budget_lines to authenticated, service_role;

-- 3. A receipt photo reads with its expense (from 1490) --------------------------------------------------------------

create or replace function private.field_media_allowed(p_object_name text, p_write boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.field_media_subject(p_object_name) s
    where case
      when s.kind = 'kiosk-punches' then
        private.has_capability(s.org_id, 'org.time_attendance.write')
        or (not p_write and s.project_id in (select private.project_ids_with('crew.time_entry.read')))
      when s.kind = 'expense-receipts' then
        case when p_write then s.project_id in (select private.project_ids_with('finance.expense.write'))
             else s.project_id in (select private.project_ids_with('finance.expense.read'))
               or exists (
                 select 1 from app.expense_receipts r join app.expenses e on e.id = r.expense_id
                 where r.media_uri = p_object_name and r.deleted_at is null and e.deleted_at is null
                   and e.submitter_person_id = private.current_person_id()) end
      else s.project_id in (select private.project_ids_with(
        case when s.kind = 'incidents' then case when p_write then 'safety.incident.write' else 'safety.incident.read' end
             else case when p_write then 'safety.inspection.write' else 'safety.inspection.read' end end))
    end);
$$;

comment on function private.field_media_allowed(text, boolean) is 'True when the signed-in person may write (upload) or read a field-media object: the incident or inspection capability on the subject''s project; for kiosk punch photos (1328), org.time_attendance.write to write or read and crew.time_entry.read on the project to read; for expense receipts (1490), finance.expense.write on the project to write, and finance.expense.read there or having submitted the expense the photo belongs to, to read (1622). Access never crosses orgs or projects.';
revoke all on function private.field_media_allowed(text, boolean) from public, anon;
grant execute on function private.field_media_allowed(text, boolean) to authenticated, service_role;

-- 4. Someone else's expense moves on the budget owner's side (from 0321) ------------------------------------------------

create or replace function app.transition_expense(p_expense_id uuid, p_expected app.expense_state, p_next app.expense_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_expense app.expenses;
  v_project uuid;
begin
  if p_next in ('Approved', 'Rejected') then
    perform private.refuse('expense_use_approval_rpc', 'Approve or reject an expense through app.approve_expense or app.reject_expense.');
  end if;
  select * into v_expense from app.expenses e where e.id = p_expense_id and e.deleted_at is null;
  select b.project_id into v_project from app.budgets b join app.budget_lines bl on bl.budget_id = b.id where bl.id = v_expense.budget_line_id;
  if v_expense.id is null
     or (p_next = 'Paid' and not private.has_capability(v_expense.org_id, 'finance.payment.write'))
     or (p_next <> 'Paid' and v_expense.submitter_person_id is distinct from v_person
         and not private.can_on_project(v_project, 'finance.expense.approve')) then
    raise exception using errcode = '42501', message = 'the person may not make this expense transition';
  end if;
  return private.transition_lifecycle('expense', 'app.expenses', 'expense_state', 'app.expense_state_transitions',
    'expense_id', p_expense_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_expense(uuid, app.expense_state, app.expense_state, text) is 'Cancels or resubmits an expense (its submitter, or someone with finance.expense.approve on the project, 1622) or marks it Paid (finance.payment.write). Approval and rejection go through their own RPCs.';
revoke all on function app.transition_expense(uuid, app.expense_state, app.expense_state, text) from public, anon;
grant execute on function app.transition_expense(uuid, app.expense_state, app.expense_state, text) to authenticated, service_role;
