-- 3020_budget_client_pricing.sql
-- B13 (RRR-237, gap G-188 phase 1; Section 4.2 Finance, Section 3.7, ADR 0152). Client pricing on budget lines: what a
-- line is sold for beside what it costs, so a quote can be built from the budget without a second spreadsheet.
--
--   * app.budgets.default_markup_bp: the budget's default markup in basis points (2500 is 25 percent).
--   * app.budget_lines gains markup_bp (the line's own markup), client_unit_price_minor (an override of the client unit
--     price), excluded_from_quote (internal lines such as contingency, never on a quote) and etc_minor (an entered
--     estimate to complete, read by 3027's forecasts).
--   * app.budget_line_prices derives each line's client price, client amount and margin, NULL-aware (invariant 11,
--     S3.7-02): an override wins, else the cost price marked up by the line's markup, else by the budget's; a line
--     with no cost price or no markup at either level has no client price. Nothing is ever defaulted to zero.
--   * app.budget_price_totals sums them per budget over the lines that go on a quote.
-- The existing row policies (finance.budget.write) cover the new columns, and the 0990 audit trail and 2811's realtime
-- publication carry them without change. Prices are derived in views and never stored (S3.15-02); only the override
-- and the entered ETC are inputs.

-- 1. Columns ----------------------------------------------------------------------------------------------------------

alter table app.budgets add column default_markup_bp integer;
alter table app.budgets add constraint budgets_default_markup_range
  check (default_markup_bp is null or default_markup_bp between 0 and 100000);
comment on column app.budgets.default_markup_bp is 'Default markup of the budget''s lines in basis points (2500 is 25 percent), 0 to 100000. A line''s own markup wins; NULL means no default, so a line without its own markup has no client price.';

alter table app.budget_lines add column markup_bp integer;
alter table app.budget_lines add column client_unit_price_minor bigint;
alter table app.budget_lines add column excluded_from_quote boolean not null default false;
alter table app.budget_lines add column etc_minor bigint;
alter table app.budget_lines add constraint budget_lines_markup_range
  check (markup_bp is null or markup_bp between 0 and 100000);
alter table app.budget_lines add constraint budget_lines_client_price_nonnegative
  check (client_unit_price_minor is null or client_unit_price_minor >= 0);
alter table app.budget_lines add constraint budget_lines_etc_nonnegative
  check (etc_minor is null or etc_minor >= 0);
comment on column app.budget_lines.markup_bp is 'The line''s own markup in basis points, 0 to 100000. NULL uses the budget''s default markup (app.budgets.default_markup_bp).';
comment on column app.budget_lines.client_unit_price_minor is 'Override of the client unit price in minor units of the budget currency. NULL derives it from the cost price and the markup (app.budget_line_prices); clearing it returns to the markup.';
comment on column app.budget_lines.excluded_from_quote is 'True for an internal line, such as contingency, that never appears on a quote, a client total, an external view or a quote PDF.';
comment on column app.budget_lines.etc_minor is 'Entered estimate to complete in minor units of the budget currency. NULL derives it (app.budget_line_forecasts, 3027).';

-- 2. The derivation ---------------------------------------------------------------------------------------------------

create or replace function private.client_unit_price_minor(p_unit_price_minor bigint, p_markup_bp integer)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select round(p_unit_price_minor::numeric * (10000 + p_markup_bp) / 10000)::bigint;
$$;
comment on function private.client_unit_price_minor(bigint, integer) is 'A cost unit price marked up by basis points, rounded half away from zero as private.extended_minor rounds (numeric round). NULL when either argument is NULL: an unpriced line or a missing markup never gives a client price.';
revoke all on function private.client_unit_price_minor(bigint, integer) from public, anon;
grant execute on function private.client_unit_price_minor(bigint, integer) to authenticated, service_role;

create view app.budget_line_prices with (security_invoker = true) as
select bl.id as budget_line_id, bl.budget_id, b.project_id, b.currency_code,
  coalesce(bl.markup_bp, b.default_markup_bp) as effective_markup_bp,
  case when bl.markup_bp is not null then 'Line' when b.default_markup_bp is not null then 'Budget' end as markup_source,
  p.client_unit_price_minor,
  case when bl.client_unit_price_minor is not null then 'Override'
       when p.client_unit_price_minor is not null then 'Markup' end as client_price_source,
  private.extended_minor(bl.quantity, p.client_unit_price_minor) as client_extended_minor,
  private.extended_minor(bl.quantity, bl.unit_price_minor) as cost_extended_minor,
  private.extended_minor(bl.quantity, p.client_unit_price_minor) - private.extended_minor(bl.quantity, bl.unit_price_minor)
    as margin_minor,
  bl.excluded_from_quote
from app.budget_lines bl
join app.budgets b on b.id = bl.budget_id
cross join lateral (
  select coalesce(bl.client_unit_price_minor,
    private.client_unit_price_minor(bl.unit_price_minor, coalesce(bl.markup_bp, b.default_markup_bp))) as client_unit_price_minor
) p
where bl.deleted_at is null and b.deleted_at is null;

call private.describe('app.budget_line_prices', 'One row per live line of a live budget with its client price (G-188 phase 1, ADR 0152), derived and never stored. The client unit price is the line''s override, else the cost unit price marked up by the line''s markup, else by the budget''s default, rounded half away from zero. NULL-aware (S3.7-02): a line with no cost price and no override, or with no markup at either level, has no client price, and its client amount and margin are NULL, never zero.', array[
  'budget_line_id', 'Budget line.',
  'budget_id', 'Budget of the line.',
  'project_id', 'Project of the budget.',
  'currency_code', 'Currency of the budget and of every amount on the row.',
  'effective_markup_bp', 'Markup in force in basis points: the line''s own, else the budget''s default; NULL when neither is set.',
  'markup_source', 'Line when the line carries its own markup, Budget when the budget''s default applies, NULL when neither does.',
  'client_unit_price_minor', 'Client unit price in minor units: the override, else the marked-up cost price; NULL when unpriced.',
  'client_price_source', 'Override when the line''s client price is entered, Markup when it is derived, NULL when there is none.',
  'client_extended_minor', 'Quantity times the client unit price, rounded half away from zero; NULL when unpriced.',
  'cost_extended_minor', 'Quantity times the cost unit price (the line''s extended amount); NULL when unpriced.',
  'margin_minor', 'Client amount less cost amount; NULL when either is NULL.',
  'excluded_from_quote', 'True for an internal line that never appears on a quote or in a client total.'
]);

create view app.budget_price_totals with (security_invoker = true) as
select b.id as budget_id, b.project_id, b.currency_code,
  case when t.included_line_count = 0 or t.client_unpriced_count > 0 then null else t.client_priced_total_minor end
    as client_total_minor,
  t.client_unpriced_count,
  t.client_priced_total_minor,
  case when t.included_line_count = 0 or t.client_unpriced_count > 0 or t.cost_unpriced_count > 0 then null
       else t.client_priced_total_minor - t.cost_priced_total_minor end as margin_minor,
  t.included_line_count
from app.budgets b
cross join lateral (
  select count(*)::integer as included_line_count,
    count(*) filter (where p.client_unit_price_minor is null)::integer as client_unpriced_count,
    count(*) filter (where p.cost_extended_minor is null)::integer as cost_unpriced_count,
    coalesce(sum(p.client_extended_minor), 0)::bigint as client_priced_total_minor,
    coalesce(sum(p.cost_extended_minor), 0)::bigint as cost_priced_total_minor
  from app.budget_line_prices p
  where p.budget_id = b.id and not p.excluded_from_quote
) t
where b.deleted_at is null;

call private.describe('app.budget_price_totals', 'Client totals of a live budget over the lines that go on a quote (excluded_from_quote false), NULL-aware as app.budget_totals is: the client total is NULL while any included line has no client price or no line is included, with the unpriced count beside it.', array[
  'budget_id', 'Budget.',
  'project_id', 'Project of the budget.',
  'currency_code', 'Currency of the budget and of every amount on the row.',
  'client_total_minor', 'Sum of the client amounts of the included lines; NULL while any of them is unpriced or none is included.',
  'client_unpriced_count', 'Included lines without a client price.',
  'client_priced_total_minor', 'Sum of the client amounts of the included lines that have one; zero when none does.',
  'margin_minor', 'Client total less the cost total of the included lines; NULL whenever either total is unknown.',
  'included_line_count', 'Live lines not excluded from quotes.'
]);

-- 3. Privileges -------------------------------------------------------------------------------------------------------

revoke all on app.budget_line_prices, app.budget_price_totals from public, anon;
grant select on app.budget_line_prices, app.budget_price_totals to authenticated, service_role;
-- 1650 grants the backup login SELECT on every new relation; pg_dump never reads a view's rows.
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles r where r.rolname = 'xos_backup') then
    revoke select on app.budget_line_prices, app.budget_price_totals from xos_backup;
  end if;
end;
$$;
