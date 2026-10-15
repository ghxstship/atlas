-- 0480_finance_reports.sql
-- A15 Finance and Reports (Section 3.11, Section 4.2 Finance and Reports, Section 7.4 Analytics,
-- Section 19.6 audit events). Builds on A03's finance schema (0320, 0321) without changing it:
--   * domain event types and triggers for the finance transitions A03 did not emit, so the activity
--     feed and webhooks see every lifecycle step
--   * derived, NULL-aware views the Finance pages and the built-in reports read: budget line facts
--     with their dimensions, change order line facts, and budget totals revised by approved change
--     orders (Section 20.2 journey 6: approving a priced change order updates the budget).
-- The audit trail on the finance tables needs A18's 0501 and lives in the late slot (0990).
-- Every view is security_invoker, so row level security of the underlying tables decides each row.
-- No totals are stored (Section 3.15).

-- Domain events (activity feed and webhooks) ----------------------------------------------------------------

insert into private.domain_event_types (code, subject, description) values
  ('budget.created', 'budgets', 'A budget was created for a project.'),
  ('cost_center.created', 'cost_centers', 'A cost center was added to the org.'),
  ('period.opened', 'accounting_periods', 'An accounting period was opened.'),
  ('journal.prepared', 'journal_entries', 'A journal entry was prepared for posting.'),
  ('journal.canceled', 'journal_entries', 'A prepared journal entry was canceled before posting.'),
  ('expense.state_changed', 'expenses', 'An expense moved to another expense state.'),
  ('change_order.requested', 'change_orders', 'A change order was requested against a budget.'),
  ('change_order.state_changed', 'change_orders', 'A change order moved to another change order state.'),
  ('invoice.recorded', 'invoices', 'An invoice was drafted or received.'),
  ('invoice.state_changed', 'invoices', 'An invoice moved to another invoice state.'),
  ('payment.recorded', 'payments', 'A payment was recorded.'),
  ('payment.state_changed', 'payments', 'A payment moved to another payment state.'),
  ('contingency.drawn', 'contingency_draws', 'Contingency was drawn onto another budget line.');

create trigger t90_emit_budget_created after insert on app.budgets
  for each row execute function private.emit_row_event('budget.created', 'project_id', 'name', 'currency_code', 'is_baseline');
create trigger t90_emit_cost_center_created after insert on app.cost_centers
  for each row execute function private.emit_row_event('cost_center.created', '-', 'code', 'name', 'kind');
create trigger t90_emit_period_opened after insert on app.accounting_periods
  for each row execute function private.emit_row_event('period.opened', '-', 'starts_on', 'ends_on');
create trigger t90_emit_journal_prepared after insert on app.journal_entries
  for each row execute function private.emit_row_event('journal.prepared', 'project_id', 'entry_date', 'memo', 'source_table');
create trigger t90_emit_change_order_requested after insert on app.change_orders
  for each row execute function private.emit_row_event('change_order.requested', 'project_id', 'change_order_number', 'title');
create trigger t90_emit_invoice_recorded after insert on app.invoices
  for each row execute function private.emit_row_event('invoice.recorded', 'project_id', 'direction', 'invoice_number', 'currency_code');
create trigger t90_emit_payment_recorded after insert on app.payments
  for each row execute function private.emit_row_event('payment.recorded', '-', 'direction', 'amount_minor', 'currency_code');
create trigger t90_emit_contingency_drawn after insert on app.contingency_draws
  for each row execute function private.emit_row_event('contingency.drawn', '-', 'from_budget_line_id', 'to_budget_line_id', 'amount_minor', 'reason');

-- Every transition A03 did not already emit as a named event: one generic state change event per lifecycle.
create trigger t91_emit_journal_canceled after insert on app.journal_state_transitions
  for each row when (new.to_state = 'Canceled')
  execute function private.emit_subject_event('journal.canceled', 'journal_entries', 'journal_entry_id', 'from_state', 'to_state', 'reason');
create trigger t91_emit_expense_state after insert on app.expense_state_transitions
  for each row when (new.from_state is not null and new.to_state not in ('Approved'))
  execute function private.emit_subject_event('expense.state_changed', 'expenses', 'expense_id', 'from_state', 'to_state', 'reason');
create trigger t91_emit_change_order_state after insert on app.change_order_state_transitions
  for each row when (new.from_state is not null and new.to_state not in ('Approved'))
  execute function private.emit_subject_event('change_order.state_changed', 'change_orders', 'change_order_id', 'from_state', 'to_state', 'reason');
create trigger t91_emit_invoice_state after insert on app.invoice_state_transitions
  for each row when (new.from_state is not null and new.to_state not in ('Issued', 'Approved', 'Canceled'))
  execute function private.emit_subject_event('invoice.state_changed', 'invoices', 'invoice_id', 'from_state', 'to_state', 'reason');
create trigger t91_emit_payment_state after insert on app.payment_state_transitions
  for each row when (new.from_state is not null and new.to_state not in ('Approved'))
  execute function private.emit_subject_event('payment.state_changed', 'payments', 'payment_id', 'from_state', 'to_state', 'reason');

-- Budget line facts (Section 7.4 Analytics: budget versus actual by account, cost center and URID) ----------

create view app.budget_line_facts with (security_invoker = true) as
select bl.id as budget_line_id, b.id as budget_id, b.project_id, b.is_baseline, b.currency_code,
  bl.line_number, bl.description, bl.line_type, bl.urid, left(bl.urid, 4) as dept_code,
  a.account_code, bl.cost_center_id, cc.code as cost_center_code, bl.grade_code, bl.element_id,
  a.extended_minor, a.is_unpriced, a.drawn_in_minor, a.drawn_out_minor, a.actual_minor
from app.budget_lines bl
join app.budgets b on b.id = bl.budget_id
join app.budget_line_amounts a on a.budget_line_id = bl.id
left join app.cost_centers cc on cc.id = bl.cost_center_id
where bl.deleted_at is null and b.deleted_at is null;

call private.describe('app.budget_line_facts', 'One row per live budget line with both GL dimensions, the derived account, the NULL-aware extended amount and approved spend. The grain the budget versus actual and final cost reports aggregate.', array[
  'budget_line_id', 'Budget line.',
  'budget_id', 'Budget.',
  'project_id', 'Project of the budget.',
  'is_baseline', 'True when the budget is the gate 3 baseline.',
  'currency_code', 'Currency of the budget.',
  'line_number', 'Order of the line within its budget.',
  'description', 'Line description.',
  'line_type', 'Cost, Labor, Fee or Contingency.',
  'urid', 'Dimension 2 discipline or category.',
  'dept_code', 'Department class of the URID.',
  'account_code', 'Expense account derived from the URID class (decision D13); NULL when the class has none.',
  'cost_center_id', 'Dimension 1 cost center.',
  'cost_center_code', 'Code of the cost center.',
  'grade_code', 'Price grade.',
  'element_id', 'Catalog element priced by the line.',
  'extended_minor', 'Quantity times unit price in minor units; NULL when unpriced.',
  'is_unpriced', 'True when the unit price is NULL.',
  'drawn_in_minor', 'Contingency drawn into the line.',
  'drawn_out_minor', 'Contingency drawn out of the line.',
  'actual_minor', 'Approved and paid expenses posted to the line.'
]);

-- Change order line facts ---------------------------------------------------------------------------------------

create view app.change_order_line_facts with (security_invoker = true) as
select l.id as change_order_line_id, c.id as change_order_id, c.project_id, c.budget_id, c.change_order_state,
  l.budget_line_id, l.urid, left(l.urid, 4) as dept_code, private.gl_account_for(l.urid, 'Expense') as account_code,
  bl.cost_center_id, private.extended_minor(l.quantity, l.unit_price_minor) as extended_minor,
  (l.unit_price_minor is null) as is_unpriced
from app.change_order_lines l
join app.change_orders c on c.id = l.change_order_id
left join app.budget_lines bl on bl.id = l.budget_line_id
where l.deleted_at is null and c.deleted_at is null;

call private.describe('app.change_order_line_facts', 'One row per live change order line with its dimensions and NULL-aware amount. A line that adjusts a budget line inherits that line''s cost center.', array[
  'change_order_line_id', 'Change order line.',
  'change_order_id', 'Change order.',
  'project_id', 'Project.',
  'budget_id', 'Budget the change order amends.',
  'change_order_state', 'State of the change order.',
  'budget_line_id', 'Budget line adjusted, when the change adjusts one.',
  'urid', 'Dimension 2 of the change.',
  'dept_code', 'Department class of the URID.',
  'account_code', 'Expense account derived from the URID class.',
  'cost_center_id', 'Cost center of the adjusted budget line.',
  'extended_minor', 'Quantity times unit price; NULL when unpriced.',
  'is_unpriced', 'True when the unit price is NULL.'
]);

-- Budget totals revised by approved change orders -------------------------------------------------------------

create view app.budget_revised_totals with (security_invoker = true) as
select t.budget_id, t.project_id, t.currency_code, t.line_count, t.unpriced_count, t.priced_total_minor, t.total_minor,
  t.actual_minor,
  coalesce(ch.approved_count, 0) as approved_change_count,
  coalesce(ch.approved_minor, 0)::bigint as approved_change_minor,
  case when t.total_minor is null then null else t.total_minor + coalesce(ch.approved_minor, 0) end::bigint as revised_total_minor
from app.budget_totals t
left join (
  select f.budget_id, count(distinct f.change_order_id) as approved_count, sum(f.extended_minor) as approved_minor
  from app.change_order_line_facts f
  where f.change_order_state = 'Approved'
  group by f.budget_id
) ch on ch.budget_id = t.budget_id;

call private.describe('app.budget_revised_totals', 'Budget totals with approved change orders applied. Only fully priced change orders can be approved, so the approved amount is never unpriced; the revised total is NULL while the budget itself has an unpriced line (Section 3.7).', array[
  'budget_id', 'Budget.',
  'project_id', 'Project.',
  'currency_code', 'Currency of the budget.',
  'line_count', 'Lines in the budget.',
  'unpriced_count', 'Lines whose unit price is NULL.',
  'priced_total_minor', 'Sum of the priced lines only.',
  'total_minor', 'Original total; NULL while any line is unpriced.',
  'actual_minor', 'Approved and paid expenses against the budget.',
  'approved_change_count', 'Approved change orders against the budget.',
  'approved_change_minor', 'Sum of approved change orders; zero when there are none.',
  'revised_total_minor', 'Original total plus approved change orders; NULL while the original total is NULL.'
]);

revoke all on app.budget_line_facts, app.change_order_line_facts, app.budget_revised_totals from public, anon;
grant select on app.budget_line_facts, app.change_order_line_facts, app.budget_revised_totals to authenticated, service_role;
