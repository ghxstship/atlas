-- 6557_budget_forecasts.sql
-- B13 (RRR-237, gap G-205; Section 4.2 Finance, Section 7.4 Analytics, S7.4-07, ADR 0152). Estimate to complete,
-- estimated final cost and forward exposure per budget line, derived over Actual (6556) and P4's Committed (2810) and
-- never stored, so they move with every expense, approval and purchase order. Only the optional entered ETC is stored
-- (app.budget_lines.etc_minor, 6550).
--
--   * current budget = extended + contingency drawn in - drawn out + the approved change order lines on the line;
--   * remaining commitment = greatest(committed - actual, 0). Expenses carry no purchase order link, so spend on a line
--     is taken to consume its commitments first (ADR 0152);
--   * ETC = the entered etc_minor, else greatest(current budget - actual - remaining commitment, 0);
--   * EFC = actual + remaining commitment + ETC; forward exposure = remaining commitment + ETC; variance at completion
--     = current budget - EFC.
-- NULL-aware: an unpriced line without an entered ETC has a NULL EFC; an entered ETC makes EFC known even on an unpriced
-- line (not an unknown commitment), while variance at completion stays NULL. With no entered ETC, EFC = max(current budget, committed, actual),
-- which agrees with the canon Playbook FORECAST rule max(budget, committed). A reader who cannot read the project's
-- purchase orders, expenses or change orders sees every forecast figure blank (P4's silence rule), never a partial
-- number: the views run as the reader, so a missing capability would otherwise shrink the sum. The totals add the
-- approved change order lines with no budget line, as both current budget and ETC, so total EFC reconciles with
-- app.budget_revised_totals (0480). Forecasts do not replace the gate 3 baseline the final cost report compares against.

create view app.budget_line_forecasts with (security_invoker = true) as
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
    join app.budget_line_amounts a on a.budget_line_id = bl.id
    left join app.budget_line_commitments c on c.budget_line_id = bl.id
    left join lateral (
      select sum(private.extended_minor(l.quantity, l.unit_price_minor)) as approved_minor
      from app.change_order_lines l
      join app.change_orders o on o.id = l.change_order_id
      where l.budget_line_id = bl.id and l.deleted_at is null and o.deleted_at is null and o.change_order_state = 'Approved'
    ) co on true
    where bl.deleted_at is null and b.deleted_at is null
  ) r
) f;

call private.describe('app.budget_line_forecasts', 'Forecast of every live line of a live budget (G-205, ADR 0152), derived and never stored: current budget, Actual (6556), Committed (2810), remaining commitment, estimate to complete, estimated final cost, forward exposure and variance at completion. NULL-aware; every forecast figure is NULL for a reader who cannot read the project''s purchase orders, expenses or change orders.', array[
  'budget_line_id', 'Budget line.',
  'budget_id', 'Budget of the line.',
  'project_id', 'Project of the budget.',
  'currency_code', 'Currency of the budget and of every amount on the row.',
  'current_budget_minor', 'Extended amount plus contingency drawn in, less drawn out, plus approved change order lines on the line; NULL when the line is unpriced.',
  'actual_minor', 'Actual: approved and paid expenses plus approved crew time (app.budget_line_amounts).',
  'committed_minor', 'Committed by approved purchase orders (app.budget_line_commitments); NULL when withheld.',
  'remaining_commitment_minor', 'Committed less actual, never below zero: spend is taken to consume commitments first. NULL when Committed is.',
  'etc_minor', 'Estimate to complete: the entered value, else current budget less actual less remaining commitment, never below zero; NULL when no value is entered and current budget or remaining commitment is unknown.',
  'etc_source', 'Entered when a person entered the ETC, Derived otherwise.',
  'efc_minor', 'Estimated final cost: actual plus remaining commitment plus ETC; NULL when any is.',
  'forward_exposure_minor', 'Spend still to come: remaining commitment plus ETC.',
  'variance_at_completion_minor', 'Current budget less estimated final cost; NULL when either is.',
  'is_withheld', 'True when the reader cannot read the project''s purchase orders, expenses or change orders: every forecast figure is then NULL, never a partial number.'
]);

create view app.budget_forecast_totals with (security_invoker = true) as
select b.id as budget_id, b.project_id, b.currency_code,
  case when w.is_withheld or bool_or(f.current_budget_minor is null and f.budget_line_id is not null) then null
       else coalesce(sum(f.current_budget_minor), 0) + u.unallocated_minor end::bigint as current_budget_minor,
  case when w.is_withheld then null else coalesce(sum(f.actual_minor), 0) end::bigint as actual_minor,
  case when w.is_withheld or bool_or(f.committed_minor is null and f.budget_line_id is not null) then null
       else coalesce(sum(f.committed_minor), 0) end::bigint as committed_minor,
  case when w.is_withheld or bool_or(f.remaining_commitment_minor is null and f.budget_line_id is not null) then null
       else coalesce(sum(f.remaining_commitment_minor), 0) end::bigint as remaining_commitment_minor,
  case when w.is_withheld or bool_or(f.etc_minor is null and f.budget_line_id is not null) then null
       else coalesce(sum(f.etc_minor), 0) + u.unallocated_minor end::bigint as etc_minor,
  case when w.is_withheld or bool_or(f.efc_minor is null and f.budget_line_id is not null) then null
       else coalesce(sum(f.efc_minor), 0) + u.unallocated_minor end::bigint as efc_minor,
  case when w.is_withheld or bool_or(f.forward_exposure_minor is null and f.budget_line_id is not null) then null
       else coalesce(sum(f.forward_exposure_minor), 0) + u.unallocated_minor end::bigint as forward_exposure_minor,
  case when w.is_withheld or bool_or(f.current_budget_minor is null and f.budget_line_id is not null)
         or bool_or(f.efc_minor is null and f.budget_line_id is not null)
       then null else coalesce(sum(f.current_budget_minor), 0) - coalesce(sum(f.efc_minor), 0) end::bigint
    as variance_at_completion_minor,
  u.unallocated_minor::bigint as unallocated_change_minor,
  w.is_withheld
from app.budgets b
left join app.budget_line_forecasts f on f.budget_id = b.id
cross join lateral (
  -- Asked of the reader's capabilities, not of the lines, so a budget with no lines is withheld as well.
  select b.project_id not in (select private.project_ids_with('procurement.po.read'))
    or b.project_id not in (select private.project_ids_with('finance.expense.read'))
    or b.project_id not in (select private.project_ids_with('finance.change_order.read')) as is_withheld
) w
cross join lateral (
  select coalesce(sum(private.extended_minor(l.quantity, l.unit_price_minor)), 0) as unallocated_minor
  from app.change_order_lines l
  join app.change_orders o on o.id = l.change_order_id
  where o.budget_id = b.id and l.budget_line_id is null and l.deleted_at is null and o.deleted_at is null
    and o.change_order_state = 'Approved'
) u
where b.deleted_at is null
group by b.id, b.project_id, b.currency_code, u.unallocated_minor, w.is_withheld;

call private.describe('app.budget_forecast_totals', 'Forecast totals of a live budget (G-205): NULL-aware sums of app.budget_line_forecasts, plus the approved change order lines that name no budget line, counted as both current budget and ETC so the total EFC reconciles with app.budget_revised_totals (0480). Withheld when the reader cannot read the project''s purchase orders, expenses or change orders.', array[
  'budget_id', 'Budget.',
  'project_id', 'Project of the budget.',
  'currency_code', 'Currency of the budget.',
  'current_budget_minor', 'Sum of the lines'' current budgets plus approved changes not on a line; NULL while any line is unpriced.',
  'actual_minor', 'Sum of the lines'' Actual.',
  'committed_minor', 'Sum of the lines'' Committed; NULL when withheld or unknown.',
  'remaining_commitment_minor', 'Sum of the remaining commitments; NULL when withheld or unknown.',
  'etc_minor', 'Sum of the ETCs plus approved changes not on a line; NULL when any is unknown or withheld.',
  'efc_minor', 'Sum of the EFCs plus approved changes not on a line; NULL when any is unknown or withheld.',
  'forward_exposure_minor', 'Sum of the forward exposures plus approved changes not on a line; NULL when any is unknown or withheld.',
  'variance_at_completion_minor', 'Current budget less EFC over the lines; NULL when either is unknown or withheld.',
  'unallocated_change_minor', 'Approved change order lines with no budget line: Approved changes not on a line.',
  'is_withheld', 'True when the reader cannot read the project''s purchase orders, expenses or change orders: every forecast figure is then NULL, even with no lines.'
]);

revoke all on app.budget_line_forecasts, app.budget_forecast_totals from public, anon;
grant select on app.budget_line_forecasts, app.budget_forecast_totals to authenticated, service_role;
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles r where r.rolname = 'xos_backup') then
    revoke select on app.budget_line_forecasts, app.budget_forecast_totals from xos_backup;
  end if;
end;
$$;
