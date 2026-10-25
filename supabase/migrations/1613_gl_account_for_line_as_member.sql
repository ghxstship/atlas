-- 1613_gl_account_for_line_as_member.sql
--
-- WP18 follow-up (range 1610 to 1619), RRR-133: a member reads the account a budget or change order line posts to.
-- 1611 made the views app.budget_line_amounts and app.change_order_line_facts (both security invoker) report a line's
-- account through private.gl_account_for_line, whose body called private.gl_account_for. A SQL function's body is
-- resolved as the role that calls it, and members have no usage on schema private, so every read of either view by a
-- member failed with "permission denied for schema private": the Budget tab and Finance, Budgets could not open a
-- budget for any role. The views name the function by reference, which needs no usage on its schema, as
-- private.extended_minor always has. The class lookup is now written out in the body (the query of
-- private.gl_account_for, 0320), so the body reads only xpms and app, which members may use. What it returns is
-- unchanged, and so are its comment and grants.

create or replace function private.gl_account_for_line(
  p_urid text,
  p_account_type text,
  p_element_id text default null,
  p_counterparty_id uuid default null
)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select case p_account_type when 'Revenue' then e.sales_account when 'Expense' then e.purchase_account end
       from xpms.elements e where e.element_id = p_element_id),
    (select a.account_code from xpms.dim_gl_account a
      where a.class_code = left(p_urid, 4) and a.account_type = p_account_type),
    (select t.default_account_code from app.counterparties c
       join xpms.dim_counterparty_type t on t.counterparty_type = c.counterparty_type
       join xpms.dim_gl_account a on a.account_code = t.default_account_code
      where c.id = p_counterparty_id and a.account_type = p_account_type));
$$;
