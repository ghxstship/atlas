-- 3017_engagement_cost_attribution.sql
-- B12 (RRR-236, gap G-186; ADR 0151 item 5). The cost pieces of an act already name its engagement (settlements,
-- engagement invoices, travel, per diems) or its people (rooms, catering, roster entries), but an agency fee or a
-- backline rental is a plain expense or purchase order line naming no engagement. Both now take one.
--   * app.expenses.engagement_id and app.po_lines.engagement_id name a live, non-Canceled engagement of the project
--     the expense's budget or the order belongs to (expense_engagement_project, po_line_engagement_project).
--   * A credit follows its original and names no engagement of its own (expense_credit_engagement); a reimbursed
--     expense keeps its engagement (expense_reimbursed_locked, with 3010's checks).
--   * Lines lock once an order leaves Proposed (private.guard_po_line, 0331). Recreated from its only definition, it
--     now also lets an Approved or Sent order's line change its engagement and nothing else, so backline already
--     ordered can be attributed.
--   * private.cost_engagement_for_person attributes an item that names only a person: the engagement of their live
--     roster entry accepted by both sides on the project, else their own live engagement there (as R1's
--     app.project_people orders them: Active first, then the latest start, then id), else none: internal crew are not
--     acts.

alter table app.expenses add column engagement_id uuid references app.engagements (id);
create index expenses_engagement_id_idx on app.expenses (engagement_id);
comment on column app.expenses.engagement_id is 'Engagement the cost is for, such as an agency fee or an act''s backline: a live, non-Canceled engagement of the budget''s project. NULL on a credit, which follows its original.';

alter table app.po_lines add column engagement_id uuid references app.engagements (id);
create index po_lines_engagement_id_idx on app.po_lines (engagement_id);
comment on column app.po_lines.engagement_id is 'Engagement the line is bought for, such as an act''s backline: a live, non-Canceled engagement of the order''s project. Can still be set while the order is Approved or Sent.';

-- install_tenant_guards replaces t30 with only the references listed, so each call restates the earlier ones.
call private.install_tenant_guards('app.expenses', 'app.budget_lines', 'budget_line_id',
  array['app.counterparties', 'counterparty_id', 'app.expenses', 'credit_of_expense_id',
        'app.expense_reimbursements', 'reimbursement_id', 'app.engagements', 'engagement_id']);
call private.install_tenant_guards('app.po_lines', 'app.purchase_orders', 'purchase_order_id',
  array['app.budget_lines', 'budget_line_id', 'app.engagements', 'engagement_id']);

-- Expenses ----------------------------------------------------------------------------------------------------------------

create or replace function private.guard_expense_engagement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.credit_of_expense_id is not null and new.engagement_id is not null then
    perform private.refuse('expense_credit_engagement', 'A credit follows the expense it credits and names no engagement of its own.');
  end if;
  if tg_op = 'UPDATE' and new.engagement_id is distinct from old.engagement_id and old.reimbursement_id is not null
     and not private.in_trusted_operation('expense_reimbursement') then
    perform private.refuse('expense_reimbursed_locked', 'A reimbursed expense keeps what it was for and stays out of Trash; void the reimbursement first.');
  end if;
  if new.engagement_id is not null and (tg_op = 'INSERT' or new.engagement_id is distinct from old.engagement_id)
     and not exists (
       select 1 from app.engagements e
       join app.budgets b on b.project_id = e.project_id
       join app.budget_lines bl on bl.budget_id = b.id
       where e.id = new.engagement_id and bl.id = new.budget_line_id
         and e.deleted_at is null and e.engagement_state <> 'Canceled') then
    perform private.refuse('expense_engagement_project', 'An expense is for a live engagement of its budget''s project.');
  end if;
  return new;
end;
$$;

comment on function private.guard_expense_engagement() is 'An expense''s engagement (3017) is live, not Canceled and on its budget''s project (expense_engagement_project); a credit names none (expense_credit_engagement); a reimbursed expense keeps it (expense_reimbursed_locked).';
revoke all on function private.guard_expense_engagement() from public, anon, authenticated;

create trigger t41_guard_expense_engagement before insert or update of engagement_id, credit_of_expense_id on app.expenses
  for each row execute function private.guard_expense_engagement();

-- Purchase order lines (from 0331) -----------------------------------------------------------------------------------------

create or replace function private.guard_po_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order app.purchase_orders;
begin
  select * into v_order from app.purchase_orders po where po.id = new.purchase_order_id;
  -- An Approved or Sent order's line may change its engagement and nothing else (3017).
  if v_order.po_state <> 'Proposed' and not (
       tg_op = 'UPDATE' and v_order.po_state in ('Approved', 'Sent')
       and (to_jsonb(new) - 'engagement_id' - 'updated_at' - 'updated_by')
         = (to_jsonb(old) - 'engagement_id' - 'updated_at' - 'updated_by')) then
    perform private.refuse('purchase_order_locked', 'Purchase order lines change only while the order is Proposed; use a PO change order.');
  end if;
  if tg_op = 'UPDATE' and new.purchase_order_id <> old.purchase_order_id then
    perform private.refuse('po_line_immutable', 'A line stays on its purchase order.');
  end if;
  if new.budget_line_id is not null and (
    select b.project_id from app.budgets b join app.budget_lines bl on bl.budget_id = b.id where bl.id = new.budget_line_id
  ) <> v_order.project_id then
    perform private.refuse('po_line_budget', 'A purchase order line draws on a budget line of the order''s project.');
  end if;
  return new;
end;
$$;

comment on function private.guard_po_line() is 'Purchase order lines: editable only while Proposed, except that an Approved or Sent order''s line may change its engagement alone (3017), drawing on a budget line of the same project.';
revoke all on function private.guard_po_line() from public, anon, authenticated;

create or replace function private.guard_po_line_engagement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.engagement_id is not null and (tg_op = 'INSERT' or new.engagement_id is distinct from old.engagement_id)
     and not exists (
       select 1 from app.engagements e
       join app.purchase_orders po on po.project_id = e.project_id
       where e.id = new.engagement_id and po.id = new.purchase_order_id
         and e.deleted_at is null and e.engagement_state <> 'Canceled') then
    perform private.refuse('po_line_engagement_project', 'A purchase order line is for a live engagement of the order''s project.');
  end if;
  return new;
end;
$$;

comment on function private.guard_po_line_engagement() is 'A purchase order line''s engagement (3017) is live, not Canceled and on the order''s project (po_line_engagement_project).';
revoke all on function private.guard_po_line_engagement() from public, anon, authenticated;

create trigger t41_guard_po_line_engagement before insert or update of engagement_id on app.po_lines
  for each row execute function private.guard_po_line_engagement();

-- Attribution by person ----------------------------------------------------------------------------------------------------

create or replace function private.cost_engagement_for_person(p_project_id uuid, p_person_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select r.engagement_id
     from private.roster_people rp
     join app.engagement_roster_entries r on r.id = rp.roster_entry_id
     join app.engagements e on e.id = r.engagement_id
     where rp.person_id = p_person_id and e.project_id = p_project_id
       and r.deleted_at is null and e.deleted_at is null
       and r.entry_state = 'Accepted' and r.person_response = 'Accepted'
     order by (e.engagement_state = 'Active') desc, e.start_date desc, e.id desc
     limit 1),
    (select e.id
     from app.engagements e
     where e.project_id = p_project_id and e.person_id = p_person_id
       and e.deleted_at is null and e.engagement_state <> 'Canceled'
     order by (e.engagement_state = 'Active') desc, e.start_date desc, e.id desc
     limit 1));
$$;

comment on function private.cost_engagement_for_person(uuid, uuid) is 'The engagement a cost naming only a person is attributed to on a project (3017): the engagement of their live roster entry accepted by the reviewer and by them (the 2692 rule), else their own live engagement that is not Canceled, each ordered Active first, then the latest start, then id; NULL otherwise, since internal crew are not acts. NULL for a NULL person.';
revoke all on function private.cost_engagement_for_person(uuid, uuid) from public, anon, authenticated;
