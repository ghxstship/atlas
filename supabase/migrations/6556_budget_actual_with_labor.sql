-- 6556_budget_actual_with_labor.sql
-- Starts from 6541's definition: a credit counts against Actual.
-- B13 (RRR-237, gap G-133; Section 4.2 Finance, S4.2-16, ADR 0152). A budget line's Actual is approved and paid
-- expenses plus approved crew time at the rate in force (6555).
--
--   * app.budget_line_amounts is recreated from its latest definition (1611) unchanged except that actual_minor adds
--     app.budget_line_labor_totals.labor_actual_minor, keeping the numeric type coalesce(sum(bigint), 0) gives it, and
--     that the expense part, the labour part, the unpriced labour minutes and the labour postings in another currency
--     are appended after it. app.budget_totals, app.budget_revised_totals (0480) and app.budget_line_facts (2810) read
--     the view and follow without being redefined; their comments say what Actual now holds.
--   * The labour totals join laterally, so the line filter reaches the grouped view and a budget read never aggregates
--     every line the reader can see.
--   * Nothing counts twice: payroll runs post to the journal (0362), and vendor or agency invoices are not in Actual; the
--     final cost report reads the posted ledger. ADR 0152 notes that an org recording an agency invoice as an expense
--     would count it twice.

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
  select t.* from app.budget_line_labor_totals t where t.budget_line_id = bl.id
) lt on true
where bl.deleted_at is null;

comment on view app.budget_line_amounts is 'Budget line amounts, derived: extended amount (NULL when unpriced, never zero), contingency moved in and out, the GL account (the item''s explicit default, else by class: decision D13 as owner decision 39 reads it) and Actual: approved and paid expenses plus approved crew time at the rate in force (6555).';
comment on column app.budget_line_amounts.actual_minor is 'Actual: approved and paid expenses posted to the line plus approved crew time at the rate in force (labor_actual_minor). Unpriced labour is left out and counted in labor_unpriced_minutes; vendor invoices are not in Actual.';
comment on column app.budget_line_amounts.expense_actual_minor is 'Approved and paid expenses posted to the line.';
comment on column app.budget_line_amounts.labor_actual_minor is 'Approved crew time on shifts that name the line, at the rate in force, in the budget''s currency (app.budget_line_labor_totals); zero for a reader without finance.budget.read and when none.';
comment on column app.budget_line_amounts.labor_unpriced_minutes is 'Approved minutes on the line with no rate in force: left out of Actual and counted here, never priced at zero.';
comment on column app.budget_line_amounts.labor_other_currency_count is 'Labour postings on the line in another currency than the budget''s: counted, never summed.';

comment on column app.budget_totals.actual_minor is 'Actual against the budget: approved and paid expenses plus approved crew time at the rate in force.';
comment on column app.budget_revised_totals.actual_minor is 'Actual against the budget: approved and paid expenses plus approved crew time at the rate in force.';
comment on column app.budget_line_facts.actual_minor is 'Actual on the line: approved and paid expenses plus approved crew time at the rate in force.';
