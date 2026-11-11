-- 4.9 fix: app.budget_line_labor_totals is computed one line at a time. It was one GROUP BY over every readable budget
-- line, so the lateral read in app.budget_line_amounts (6556) aggregated the whole budget again for each of its lines:
-- a 200-line budget ran about 45,000 aggregates per read, three times per budget page (the amounts, and again inside
-- app.budget_line_forecasts and app.budget_forecast_totals). After journey 34's 200-line paste the page's read
-- passed the 8 s statement timeout on the CI stack (57014, PR #89) and the page showed the budgets load error.
--
-- Each line now aggregates only its own standing postings, and app.budget_line_amounts and app.budget_line_forecasts
-- read their per-line views behind OFFSET 0, so each line computes its own whatever the planner estimates (after a
-- large paste it estimates one line, and chose to recompute every line for each). The rows are the same: one per live line of a live budget the caller reads
-- with finance.budget.read, zero and not NULL when the line has no postings, and the amounts and forecasts read the
-- same (pgTAP compares them). On a fresh 60-line budget the aggregated rows went from 13,622 to 362 for the amounts and
-- from 17,983 to 547 for the forecast totals. Each view keeps its name, columns, owner (the labour totals read
-- private.labor_postings_standing as the owner, as before), description and grants. Definitions start from 6555
-- (labour totals), 6556 (amounts) and 6557 (forecasts).
create or replace view app.budget_line_labor_totals as
select bl.id as budget_line_id,
  b.id as budget_id,
  lt.labor_actual_minor,
  lt.labor_unpriced_minutes,
  lt.labor_other_currency_count
from app.budget_lines bl
join app.budgets b on b.id = bl.budget_id
cross join lateral (
  select coalesce(sum(s.amount_minor) filter (where s.currency_code = b.currency_code::text), 0::numeric) as labor_actual_minor,
    coalesce(sum(s.minutes) filter (where s.rate_minor is null), 0::bigint)::integer as labor_unpriced_minutes,
    count(s.posting_id) filter (where s.currency_code <> b.currency_code::text)::integer as labor_other_currency_count
  from private.labor_postings_standing s
  where s.budget_line_id = bl.id
) lt
where bl.deleted_at is null and b.deleted_at is null
  and b.project_id in (select private.project_ids_with('finance.budget.read'));

create or replace view app.budget_line_amounts with (security_invoker = true) as
select bl.id as budget_line_id, bl.budget_id, bl.line_type, bl.urid,
  private.gl_account_for_line(bl.urid, 'Expense', bl.element_id) as account_code,
  private.extended_minor(bl.quantity, bl.unit_price_minor) as extended_minor,
  (bl.unit_price_minor is null) as is_unpriced,
  coalesce((select sum(d.amount_minor) from app.contingency_draws d where d.to_budget_line_id = bl.id and d.deleted_at is null), 0) as drawn_in_minor,
  coalesce((select sum(d.amount_minor) from app.contingency_draws d where d.from_budget_line_id = bl.id and d.deleted_at is null), 0) as drawn_out_minor,
  coalesce(ex.amount_minor, 0) + coalesce(lt.labor_actual_minor, 0) as actual_minor,
  coalesce(ex.amount_minor, 0) as expense_actual_minor,
  coalesce(lt.labor_actual_minor, 0) as labor_actual_minor,
  coalesce(lt.labor_unpriced_minutes, 0) as labor_unpriced_minutes,
  coalesce(lt.labor_other_currency_count, 0) as labor_other_currency_count
from app.budget_lines bl
left join lateral (
  -- A credit (6541) takes its amount off Actual.
  select sum(case when e.credit_of_expense_id is null then e.amount_minor else -e.amount_minor end) as amount_minor
  from app.expenses e
  where e.budget_line_id = bl.id and e.deleted_at is null and e.expense_state in ('Approved', 'Paid')
) ex on true
left join lateral (
  -- OFFSET 0 keeps this a read of the one line (904090004), whatever the planner estimates.
  select t.* from app.budget_line_labor_totals t where t.budget_line_id = bl.id offset 0
) lt on true
where bl.deleted_at is null;

create or replace view app.budget_line_forecasts with (security_invoker = true) as
select f.budget_line_id, f.budget_id, f.project_id, f.currency_code,
  case when f.is_withheld then null else f.current_budget_minor end as current_budget_minor,
  case when f.is_withheld then null else f.actual_minor end as actual_minor,
  case when f.is_withheld then null else f.committed_minor end as committed_minor,
  case when f.is_withheld then null else f.remaining_commitment_minor end as remaining_commitment_minor,
  case when f.is_withheld then null else f.etc_minor end as etc_minor,
  f.etc_source,
  case when f.is_withheld then null else f.actual_minor + f.remaining_commitment_minor + f.etc_minor end as efc_minor,
  case when f.is_withheld then null else f.remaining_commitment_minor + f.etc_minor end as forward_exposure_minor,
  case when f.is_withheld then null
       else f.current_budget_minor - (f.actual_minor + f.remaining_commitment_minor + f.etc_minor) end as variance_at_completion_minor,
  f.is_withheld
from (
  select r.*,
    coalesce(r.entered_etc_minor,
      case when r.current_budget_minor is null or r.remaining_commitment_minor is null then null
           else greatest(r.current_budget_minor - r.actual_minor - r.remaining_commitment_minor, 0) end) as etc_minor,
    case when r.entered_etc_minor is not null then 'Entered' else 'Derived' end as etc_source
  from (
    select bl.id as budget_line_id, b.id as budget_id, b.project_id, b.currency_code,
      case when a.extended_minor is null then null
           else a.extended_minor + a.drawn_in_minor - a.drawn_out_minor + coalesce(co.approved_minor, 0) end::bigint
        as current_budget_minor,
      a.actual_minor::bigint as actual_minor,
      c.committed_minor,
      case when c.committed_minor is null then null else greatest(c.committed_minor - a.actual_minor, 0) end::bigint
        as remaining_commitment_minor,
      bl.etc_minor as entered_etc_minor,
      coalesce(c.is_committed_withheld, true)
        or b.project_id not in (select private.project_ids_with('finance.expense.read'))
        or b.project_id not in (select private.project_ids_with('finance.change_order.read')) as is_withheld
    from app.budget_lines bl
    join app.budgets b on b.id = bl.budget_id
    -- Each line reads its own amounts and commitments (904090004): OFFSET 0 keeps the planner from computing them for
    -- the whole budget again for every line when its estimates are low, as they are just after a large paste.
    join lateral (select a_1.* from app.budget_line_amounts a_1 where a_1.budget_line_id = bl.id offset 0) a on true
    left join lateral (select c_1.* from app.budget_line_commitments c_1 where c_1.budget_line_id = bl.id offset 0) c on true
    left join lateral (
      select sum(private.extended_minor(l.quantity, l.unit_price_minor)) as approved_minor
      from app.change_order_lines l
      join app.change_orders o on o.id = l.change_order_id
      where l.budget_line_id = bl.id and l.deleted_at is null and o.deleted_at is null and o.change_order_state = 'Approved'
    ) co on true
    where bl.deleted_at is null and b.deleted_at is null
  ) r
) f;
