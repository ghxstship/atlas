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
--   * Candidates are only rows the caller can read: the app.expenses read policy (0321, private.expense_readable), and
--     orders on projects with procurement.po.read.
--   * Candidates are probed through a date window on a partial index first and amounts tested next. The name similarity
--     test comes last, in a nested subquery the planner cannot flatten (offset 0), since it is the costly one.

create index expenses_dup_probe_idx on app.expenses (org_id, currency_code, incurred_on)
  where deleted_at is null and credit_of_expense_id is null;
create index purchase_orders_dup_probe_idx on app.purchase_orders (org_id, currency_code, created_at)
  where deleted_at is null;

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

comment on function private.counterparties_alike(uuid, uuid) is 'True when two counterparties are the same, or belong to one org and their organizations'' names are at least 0.85 similar (pg_trgm, the 0530 import rule). Returns no names. Read only inside definer functions.';
revoke all on function private.counterparties_alike(uuid, uuid) from public, anon, authenticated;

create or replace function app.expense_duplicate_candidates(p_expense_ids uuid[])
returns table (expense_id uuid, candidate_id uuid, same_vendor boolean, amount_delta_minor bigint, day_gap integer)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, c.id, (s.counterparty_id is not null and c.counterparty_id = s.counterparty_id),
    abs(s.amount_minor - c.amount_minor)::bigint, abs(s.incurred_on - c.incurred_on)::integer
  from (
    select e.* from app.expenses e
    where e.id = any (p_expense_ids[1:500]) and e.deleted_at is null and e.credit_of_expense_id is null
      and e.expense_state in ('Proposed', 'Approved') and private.expense_readable(e.id)
  ) s
  cross join lateral (
    select w.* from (
      select x.id, x.counterparty_id, x.submitter_person_id, x.amount_minor, x.incurred_on
      from app.expenses x
      where x.org_id = s.org_id and x.currency_code = s.currency_code and x.deleted_at is null and x.credit_of_expense_id is null
        and x.incurred_on between s.incurred_on - 7 and s.incurred_on + 7
        and x.id <> s.id and x.expense_state not in ('Rejected', 'Canceled')
        and abs(s.amount_minor - x.amount_minor) * 100 <= greatest(s.amount_minor, x.amount_minor)
      offset 0
    ) w
    where ((s.counterparty_id is null and w.counterparty_id is null and s.submitter_person_id = w.submitter_person_id)
        or (s.counterparty_id is not null and w.counterparty_id is not null
            and private.counterparties_alike(s.counterparty_id, w.counterparty_id)))
      and private.expense_readable(w.id)
  ) c
  order by s.id, (s.amount_minor = c.amount_minor) desc, abs(s.incurred_on - c.incurred_on), c.id;
$$;

comment on function app.expense_duplicate_candidates(uuid[]) is 'Look-alike expenses of up to 500 Proposed or Approved charges the caller can read (G-224): other live charges of the org in the same currency, not credits and not Rejected or Canceled, from an alike vendor (private.counterparties_alike) or, with no vendor on either, the same submitter, within 1% of the amount and 7 days of the date. Only rows the caller can read under the app.expenses read policy. Exact amounts first, then the nearest dates. A warning: nothing is refused.';
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
  cross join lateral (
    select w.* from (
      select x.id, x.counterparty_id, x.submitter_person_id, x.amount_minor, x.incurred_on
      from app.expenses x
      where x.org_id = d.org_id and x.currency_code = d.currency_code and x.deleted_at is null and x.credit_of_expense_id is null
        and x.incurred_on between p_incurred_on - 7 and p_incurred_on + 7
        and x.id is distinct from p_exclude_expense_id and x.expense_state not in ('Rejected', 'Canceled')
        and abs(p_amount_minor - x.amount_minor) * 100 <= greatest(p_amount_minor, x.amount_minor)
      offset 0
    ) w
    where ((p_counterparty_id is null and w.counterparty_id is null and w.submitter_person_id = d.submitter)
        or (p_counterparty_id is not null and w.counterparty_id is not null
            and private.counterparties_alike(p_counterparty_id, w.counterparty_id)))
      and private.expense_readable(w.id)
  ) c
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
  select s.id, c.id, (c.counterparty_id = s.counterparty_id), abs(s.total_minor - c.total_minor)::bigint,
    abs(extract(epoch from s.created_at - c.created_at) / 86400)::integer
  from (
    select po.id, po.org_id, po.currency_code, po.created_at, v.counterparty_id,
      private.purchase_order_total(po.id)
        + coalesce((select sum(co.amount_delta_minor) from app.po_change_orders co
                    where co.purchase_order_id = po.id and co.deleted_at is null and co.po_change_order_state = 'Approved'), 0)
        as total_minor
    from app.purchase_orders po
    join app.vendors v on v.id = po.vendor_id
    where po.id = any (p_purchase_order_ids[1:500]) and po.deleted_at is null and po.po_state in ('Proposed', 'Approved', 'Sent')
      and po.project_id in (select private.project_ids_with('procurement.po.read'))
    offset 0
  ) s
  cross join lateral (
    select w.* from (
      select t.* from (
        select x.id, x.created_at, v.counterparty_id,
          private.purchase_order_total(x.id)
            + coalesce((select sum(co.amount_delta_minor) from app.po_change_orders co
                        where co.purchase_order_id = x.id and co.deleted_at is null and co.po_change_order_state = 'Approved'), 0)
            as total_minor
        from app.purchase_orders x
        join app.vendors v on v.id = x.vendor_id
        where x.org_id = s.org_id and x.currency_code = s.currency_code and x.deleted_at is null
          and x.created_at between s.created_at - interval '30 days' and s.created_at + interval '30 days'
          and x.id <> s.id and x.po_state <> 'Canceled'
          and x.project_id in (select private.project_ids_with('procurement.po.read'))
        offset 0
      ) t
      where t.total_minor is not null and s.total_minor is not null
        and abs(s.total_minor - t.total_minor) * 100 <= greatest(s.total_minor, t.total_minor)
      offset 0
    ) w
    where private.counterparties_alike(s.counterparty_id, w.counterparty_id)
  ) c
  order by s.id, (s.total_minor = c.total_minor) desc, abs(extract(epoch from s.created_at - c.created_at)), c.id;
$$;

comment on function app.purchase_order_duplicate_candidates(uuid[]) is 'Look-alike orders of up to 500 Proposed, Approved or Sent purchase orders (G-224): other live orders of the org in the same currency, not Canceled, from an alike vendor (private.counterparties_alike), with both totals known (lines plus approved change orders) and within 1%, created within 30 days. Only orders on projects where the caller holds procurement.po.read. A warning: nothing is refused.';
revoke all on function app.purchase_order_duplicate_candidates(uuid[]) from public, anon;
grant execute on function app.purchase_order_duplicate_candidates(uuid[]) to authenticated, service_role;
