-- 3016_duplicate_warnings.sql
-- B12 (RRR-236, gap G-224; ADR 0151 item 6). Look-alike warnings on expenses and purchase orders before they are paid.
-- Exact checks already exist (invoice numbers 0321 and 1120, duplicate receipts 1220, import dedupe 0530); nothing
-- warned on a second expense for the same thing, or on an order placed twice. These warnings never block.
--   * Two counterparties are alike when they are the same row, or two rows of one org whose organizations' names are at
--     least 0.85 similar (pg_trgm), the import rule (0530 private.fuzzy_candidates). The function never returns names.
--   * An expense candidate is another live charge of the org in the same currency, not a credit and not Rejected or
--     Canceled, with an alike vendor (or, with no vendor on either, the same submitter), an amount within 1% and a date
--     within 7 days. Only Proposed and Approved subjects are checked: before payment.
--   * A purchase order candidate is another live order of the org in the same currency, not Canceled, from an alike
--     vendor, with both totals known (lines plus approved change orders) and within 1%, created within 30 days.
--   * Candidates are only rows the caller can read: the app.expenses read policy (0321), and orders on projects with
--     procurement.po.read.

create index expenses_dup_probe_idx on app.expenses (org_id, currency_code, incurred_on)
  where deleted_at is null and credit_of_expense_id is null;

create or replace function private.counterparties_alike(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_a is not null and p_b is not null and (p_a = p_b or exists (
    select 1
    from app.counterparties a
    join app.organizations oa on oa.id = a.organization_id
    join app.counterparties b on b.id = p_b and b.org_id = a.org_id
    join app.organizations ob on ob.id = b.organization_id
    where a.id = p_a and extensions.similarity(lower(oa.name), lower(ob.name)) >= 0.85));
$$;

comment on function private.counterparties_alike(uuid, uuid) is 'True when two counterparties are the same, or belong to one org and their organizations'' names are at least 0.85 similar (pg_trgm, the 0530 import rule). Returns no names.';
revoke all on function private.counterparties_alike(uuid, uuid) from public, anon;
grant execute on function private.counterparties_alike(uuid, uuid) to authenticated, service_role;

-- The expenses a caller can read, as the app.expenses read policy reads them.
create or replace function private.readable_expense_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id from app.expenses e
  where e.deleted_at is null
    and (e.budget_line_id in (select private.budget_line_ids_with('finance.expense.read'))
      or e.submitter_person_id = private.current_person_id());
$$;

comment on function private.readable_expense_ids() is 'Live expenses the signed-in person can read under the app.expenses read policy (0321): on a budget line with finance.expense.read, or submitted by them.';
revoke all on function private.readable_expense_ids() from public, anon, authenticated;

create or replace function app.expense_duplicate_candidates(p_expense_ids uuid[])
returns table (expense_id uuid, candidate_id uuid, same_vendor boolean, amount_delta_minor bigint, day_gap integer)
language sql
stable
security definer
set search_path = ''
as $$
  with readable as (
    select e.* from app.expenses e where e.id in (select private.readable_expense_ids())
  )
  select s.id, c.id, (s.counterparty_id is not null and c.counterparty_id = s.counterparty_id),
    abs(s.amount_minor - c.amount_minor)::bigint, abs(s.incurred_on - c.incurred_on)::integer
  from readable s
  join readable c on c.org_id = s.org_id and c.currency_code = s.currency_code and c.id <> s.id
  where s.id = any (p_expense_ids[1:500])
    and s.credit_of_expense_id is null and s.expense_state in ('Proposed', 'Approved')
    and c.credit_of_expense_id is null and c.expense_state not in ('Rejected', 'Canceled')
    and ((s.counterparty_id is not null and c.counterparty_id is not null
          and private.counterparties_alike(s.counterparty_id, c.counterparty_id))
      or (s.counterparty_id is null and c.counterparty_id is null and s.submitter_person_id = c.submitter_person_id))
    and abs(s.amount_minor - c.amount_minor) * 100 <= greatest(s.amount_minor, c.amount_minor)
    and abs(s.incurred_on - c.incurred_on) <= 7
  order by s.id, (s.amount_minor = c.amount_minor) desc, abs(s.incurred_on - c.incurred_on), c.id;
$$;

comment on function app.expense_duplicate_candidates(uuid[]) is 'Look-alike expenses of up to 500 Proposed or Approved charges (G-224): other live charges of the org in the same currency, not credits and not Rejected or Canceled, from an alike vendor (private.counterparties_alike) or, with no vendor on either, the same submitter, within 1% of the amount and 7 days of the date. Only rows the caller can read under the app.expenses read policy. Exact amounts first, then the nearest dates. A warning: nothing is refused.';
revoke all on function app.expense_duplicate_candidates(uuid[]) from public, anon;
grant execute on function app.expense_duplicate_candidates(uuid[]) to authenticated, service_role;

create or replace function app.find_expense_duplicates(
  p_budget_line_id uuid,
  p_counterparty_id uuid,
  p_amount_minor bigint,
  p_incurred_on date,
  p_exclude_expense_id uuid default null
)
returns table (candidate_id uuid, same_vendor boolean, amount_delta_minor bigint, day_gap integer)
language sql
stable
security definer
set search_path = ''
as $$
  with draft as (
    select bl.org_id, b.currency_code, private.current_person_id() as submitter
    from app.budget_lines bl join app.budgets b on b.id = bl.budget_id
    where bl.id = p_budget_line_id and bl.deleted_at is null and p_amount_minor > 0 and p_incurred_on is not null
  )
  select c.id, (p_counterparty_id is not null and c.counterparty_id = p_counterparty_id),
    abs(p_amount_minor - c.amount_minor)::bigint, abs(p_incurred_on - c.incurred_on)::integer
  from draft d
  join app.expenses c on c.org_id = d.org_id and c.currency_code = d.currency_code
  where c.id in (select private.readable_expense_ids())
    and c.id is distinct from p_exclude_expense_id
    and c.credit_of_expense_id is null and c.expense_state not in ('Rejected', 'Canceled')
    and ((p_counterparty_id is not null and c.counterparty_id is not null
          and private.counterparties_alike(p_counterparty_id, c.counterparty_id))
      or (p_counterparty_id is null and c.counterparty_id is null and c.submitter_person_id = d.submitter))
    and abs(p_amount_minor - c.amount_minor) * 100 <= greatest(p_amount_minor, c.amount_minor)
    and abs(p_incurred_on - c.incurred_on) <= 7
  order by (c.amount_minor = p_amount_minor) desc, abs(p_incurred_on - c.incurred_on), c.id;
$$;

comment on function app.find_expense_duplicates(uuid, uuid, bigint, date, uuid) is 'The expense look-alike rule (app.expense_duplicate_candidates) for an expense not yet saved: the budget line gives the org and currency and the caller is the submitter. p_exclude_expense_id leaves out the expense being edited. Only rows the caller can read. A warning: nothing is refused.';
revoke all on function app.find_expense_duplicates(uuid, uuid, bigint, date, uuid) from public, anon;
grant execute on function app.find_expense_duplicates(uuid, uuid, bigint, date, uuid) to authenticated, service_role;

create or replace function app.purchase_order_duplicate_candidates(p_purchase_order_ids uuid[])
returns table (purchase_order_id uuid, candidate_id uuid, same_vendor boolean, total_delta_minor bigint, day_gap integer)
language sql
stable
security definer
set search_path = ''
as $$
  with readable as (
    select po.id, po.org_id, po.currency_code, po.po_state, po.created_at, v.counterparty_id,
      private.purchase_order_total(po.id)
        + coalesce((select sum(c.amount_delta_minor) from app.po_change_orders c
                    where c.purchase_order_id = po.id and c.deleted_at is null and c.po_change_order_state = 'Approved'), 0)
        as total_minor
    from app.purchase_orders po
    join app.vendors v on v.id = po.vendor_id
    where po.deleted_at is null and po.po_state <> 'Canceled'
      and po.project_id in (select private.project_ids_with('procurement.po.read'))
      and po.org_id in (select s.org_id from app.purchase_orders s where s.id = any (p_purchase_order_ids[1:500]))
  )
  select s.id, c.id, (c.counterparty_id = s.counterparty_id), abs(s.total_minor - c.total_minor)::bigint,
    abs(extract(epoch from s.created_at - c.created_at) / 86400)::integer
  from readable s
  join readable c on c.org_id = s.org_id and c.currency_code = s.currency_code and c.id <> s.id
  where s.id = any (p_purchase_order_ids[1:500]) and s.po_state in ('Proposed', 'Approved', 'Sent')
    and private.counterparties_alike(s.counterparty_id, c.counterparty_id)
    and s.total_minor is not null and c.total_minor is not null
    and abs(s.total_minor - c.total_minor) * 100 <= greatest(s.total_minor, c.total_minor)
    and c.created_at between s.created_at - interval '30 days' and s.created_at + interval '30 days'
  order by s.id, (s.total_minor = c.total_minor) desc, abs(extract(epoch from s.created_at - c.created_at)), c.id;
$$;

comment on function app.purchase_order_duplicate_candidates(uuid[]) is 'Look-alike orders of up to 500 Proposed, Approved or Sent purchase orders (G-224): other live orders of the org in the same currency, not Canceled, from an alike vendor (private.counterparties_alike), with both totals known (lines plus approved change orders) and within 1%, created within 30 days. Only orders on projects where the caller holds procurement.po.read. A warning: nothing is refused.';
revoke all on function app.purchase_order_duplicate_candidates(uuid[]) from public, anon;
grant execute on function app.purchase_order_duplicate_candidates(uuid[]) to authenticated, service_role;
