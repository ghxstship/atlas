-- 0413_work_order_budget_sync.sql
-- A08 (ADR 0022 range 0410 to 0419).
--   * Work orders carry a budget in a currency (the v1 API contract's budget_minor and currency).
--     NULL budget is unbudgeted, never zero. The currency defaults to the project's currency.
--   * Compass replays cue calls offline through app.apply_sync_mutation: app.call_cue joins the
--     sync allowlist (0364).

alter table app.work_orders add column budget_minor bigint;
alter table app.work_orders add column currency_code char(3) references private.currencies (currency_code);
create index work_orders_currency_code_idx on app.work_orders (currency_code);

update app.work_orders w set currency_code = p.currency
from app.projects p where p.id = w.project_id and w.currency_code is null;

alter table app.work_orders alter column currency_code set not null;
alter table app.work_orders add constraint work_orders_budget_nonnegative check (budget_minor is null or budget_minor >= 0);

comment on column app.work_orders.budget_minor is 'Budget for the work in minor units of currency_code; NULL is unbudgeted, never zero.';
comment on column app.work_orders.currency_code is 'ISO 4217 currency of the budget; the project''s currency when the caller gives none.';

create or replace function private.default_work_order_currency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.currency_code is null then
    new.currency_code := (select p.currency from app.projects p where p.id = new.project_id);
  end if;
  return new;
end;
$$;

comment on function private.default_work_order_currency() is 'Before insert trigger: a work order without a currency takes its project''s currency.';
revoke all on function private.default_work_order_currency() from public, anon, authenticated;

create trigger t35_default_work_order_currency before insert on app.work_orders
  for each row execute function private.default_work_order_currency();

insert into private.sync_rpcs (rpc, description) values
  ('app.call_cue', 'A stage manager calls the next cue of a live running order.')
on conflict (rpc) do nothing;
