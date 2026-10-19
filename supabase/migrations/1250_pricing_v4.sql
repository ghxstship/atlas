-- 1250_pricing_v4.sql
-- A58 Pricing v4 (owner, 2026-10-19; ADR 0034). Seat-based plans:
--   * private.plan_extra_seat_prices: the per-seat price of each plan that sells extra seats, mirrored
--     from packages/schemas/plans.yaml by the generated plan seed (1251)
--   * private.plan_addons: one-time add-ons (Aurora request packs) and the limit each raises, per plan,
--     mirrored the same way
--   * app.subscriptions.extra_seats: seats bought above the plan's allowance (the Stripe quantity of the
--     plan's extra-seat price), set only by app.sync_subscription_from_stripe
--   * app.subscriptions.seats_grandfathered: subscriptions that existed before seat limits keep
--     unlimited seats until their plan changes or they end (ADR 0034, grandfathering)
--   * app.addon_purchases: paid one-time add-ons, written once per Stripe Checkout session by
--     app.record_addon_purchase_from_stripe
--   * private.org_plan_limits: seats are the plan allowance plus extra seats (null when grandfathered),
--     and a limit an add-on raises adds this month's purchases
--   * seat refusals name the fix: seat_limit_reached (buy extra seats or upgrade) where the plan sells
--     extra seats, seat_limit_upgrade (upgrade) where it does not
-- Stripe calls live in @xos/platform; this migration never calls Stripe.

-- Extra seat prices ----------------------------------------------------------------------------------

create table private.plan_extra_seat_prices (
  plan_code text not null references app.plans (code),
  currency_code char(3) not null references private.currencies (currency_code),
  monthly_minor bigint,
  annual_minor bigint,
  primary key (plan_code, currency_code),
  constraint plan_extra_seat_prices_positive check (
    (monthly_minor is null or monthly_minor > 0) and (annual_minor is null or annual_minor > 0))
);

create index plan_extra_seat_prices_currency_code_idx on private.plan_extra_seat_prices (currency_code);

comment on table private.plan_extra_seat_prices is 'Price of one seat above the plan''s seat allowance, per currency, mirrored from packages/schemas/plans.yaml by the generated plan seed. A plan with rows here sells extra seats; one without rows does not (ADR 0034). Null is unpriced, never zero.';
comment on column private.plan_extra_seat_prices.plan_code is 'Plan that sells the extra seat.';
comment on column private.plan_extra_seat_prices.currency_code is 'Price book currency.';
comment on column private.plan_extra_seat_prices.monthly_minor is 'Price per seat per month in minor units.';
comment on column private.plan_extra_seat_prices.annual_minor is 'Price per seat per year in minor units.';

alter table private.plan_extra_seat_prices enable row level security;
revoke all on private.plan_extra_seat_prices from public, anon, authenticated;
grant select on private.plan_extra_seat_prices to service_role;

-- Add-ons ---------------------------------------------------------------------------------------------------

create table private.plan_addons (
  addon_code text not null,
  plan_code text not null references app.plans (code),
  limit_code app.plan_limit_code not null,
  amount integer not null,
  primary key (addon_code, plan_code),
  constraint plan_addons_code_format check (addon_code ~ '^[a-z][a-z0-9_]*$'),
  constraint plan_addons_amount_positive check (amount > 0)
);

create index plan_addons_plan_code_idx on private.plan_addons (plan_code);

comment on table private.plan_addons is 'One-time add-ons a plan may buy and how much of which limit each adds for the calendar month it is bought in, mirrored from packages/schemas/plans.yaml by the generated plan seed (ADR 0034).';
comment on column private.plan_addons.addon_code is 'Add-on code from plans.yaml, for example aurora_requests_1000.';
comment on column private.plan_addons.plan_code is 'Plan that may buy the add-on.';
comment on column private.plan_addons.limit_code is 'Limit the add-on raises.';
comment on column private.plan_addons.amount is 'Amount one unit adds to the limit for its month.';

alter table private.plan_addons enable row level security;
revoke all on private.plan_addons from public, anon, authenticated;
grant select on private.plan_addons to service_role;

-- Subscriptions: extra seats and grandfathering -------------------------------------------------------------

alter table app.subscriptions
  add column extra_seats integer not null default 0,
  add column seats_grandfathered boolean not null default false,
  add constraint subscriptions_extra_seats_range check (extra_seats between 0 and 10000);

comment on column app.subscriptions.extra_seats is 'Seats bought above the plan''s seat allowance: the quantity of the plan''s extra-seat price on the Stripe subscription. Set only by app.sync_subscription_from_stripe (ADR 0034).';
comment on column app.subscriptions.seats_grandfathered is 'True for a paid subscription that existed before plans had seat limits (pricing v4): it keeps unlimited seats until its plan changes or it ends (ADR 0034).';

-- Every paid subscription live when seat limits arrive keeps unlimited seats (ADR 0034).
update app.subscriptions s set seats_grandfathered = true
where s.subscription_state <> 'canceled' and s.deleted_at is null and s.plan_code <> 'access';

create or replace function private.end_seat_grandfathering()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.plan_code is distinct from old.plan_code or new.subscription_state = 'canceled' then
    new.seats_grandfathered := false;
  end if;
  return new;
end;
$$;

comment on function private.end_seat_grandfathering() is 'Before update trigger on app.subscriptions: a grandfathered subscription takes the seat limits of pricing v4 once its plan changes or it ends (ADR 0034).';
revoke all on function private.end_seat_grandfathering() from public, anon, authenticated;

create trigger t30_end_seat_grandfathering before update on app.subscriptions
  for each row when (old.seats_grandfathered) execute function private.end_seat_grandfathering();

-- Add-on purchases -----------------------------------------------------------------------------------------

create table app.addon_purchases (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  addon_code text not null,
  quantity integer not null,
  applies_month date not null,
  stripe_checkout_session_id text not null,
  currency_code char(3) not null references private.currencies (currency_code),
  amount_total_minor bigint not null,
  livemode boolean not null,
  paid_at timestamptz not null,
  constraint addon_purchases_code_format check (addon_code ~ '^[a-z][a-z0-9_]*$'),
  constraint addon_purchases_quantity_range check (quantity between 1 and 100),
  constraint addon_purchases_month_start check (applies_month = date_trunc('month', applies_month)::date),
  constraint addon_purchases_session_format check (stripe_checkout_session_id ~ '^cs_(test|live)_[A-Za-z0-9]+$'),
  constraint addon_purchases_amount_nonnegative check (amount_total_minor >= 0)
);

create unique index addon_purchases_session_key on app.addon_purchases (stripe_checkout_session_id);
create index addon_purchases_currency_code_idx on app.addon_purchases (currency_code);
create index addon_purchases_month_idx on app.addon_purchases (org_id, applies_month);

call private.install_domain_table('app.addon_purchases', null, null, '{}', true);
call private.describe('app.addon_purchases', 'One-time add-ons an org paid for through Stripe Checkout, such as an Aurora request pack (ADR 0034). Each raises its limit for the UTC calendar month it was paid in. Written once per Checkout session by app.record_addon_purchase_from_stripe; append-only.', array[
  'addon_code', 'Add-on code from packages/schemas/plans.yaml.',
  'quantity', 'Units bought.',
  'applies_month', 'First day of the UTC calendar month the purchase raises the limit for.',
  'stripe_checkout_session_id', 'Stripe Checkout session (cs_...) that was paid, unique.',
  'currency_code', 'Currency the org paid in.',
  'amount_total_minor', 'Amount paid in minor units, after discounts and before tax, as Stripe reports it.',
  'livemode', 'True for live mode payments.',
  'paid_at', 'When Stripe completed the payment.'
]);

call private.install_policies('app.addon_purchases',
  $$org_id in (select private.orgs_with_capability('org.billing.read'))$$);

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.addon_purchases', 'Age', 'paid_at', interval '7 years', 'Delete', 'Billing evidence kept 7 years.');

create or replace function app.record_addon_purchase_from_stripe(
  p_org_id uuid,
  p_addon_code text,
  p_quantity integer,
  p_stripe_checkout_session_id text,
  p_currency_code text,
  p_amount_total_minor bigint,
  p_livemode boolean,
  p_paid_at timestamptz
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from app.organizations o where o.id = p_org_id and o.deleted_at is null) then
    perform private.refuse('billing_org_unknown', 'The Stripe payment names no live org.');
  end if;
  if not exists (select 1 from private.plan_addons a where a.addon_code = p_addon_code) then
    perform private.refuse('addon_unknown', format('%s is not an add-on.', p_addon_code));
  end if;
  insert into app.addon_purchases (org_id, addon_code, quantity, applies_month, stripe_checkout_session_id,
    currency_code, amount_total_minor, livemode, paid_at)
  values (p_org_id, p_addon_code, p_quantity,
    (date_trunc('month', p_paid_at at time zone 'UTC'))::date,
    p_stripe_checkout_session_id, upper(p_currency_code), p_amount_total_minor, p_livemode, p_paid_at)
  on conflict (stripe_checkout_session_id) do nothing
  returning id into v_id;
  if v_id is null then
    select p.id into v_id from app.addon_purchases p where p.stripe_checkout_session_id = p_stripe_checkout_session_id;
    if (select p.org_id from app.addon_purchases p where p.id = v_id) <> p_org_id then
      perform private.refuse('billing_org_mismatch', 'The Stripe payment belongs to another org.');
    end if;
  end if;
  return v_id;
end;
$$;

comment on function app.record_addon_purchase_from_stripe(uuid, text, integer, text, text, bigint, boolean, timestamptz) is 'Billing API (service role, after the server module verified the Stripe signature): records a paid one-time add-on once per Checkout session, for the UTC month it was paid in. A redelivery returns the existing purchase. A purchase is honored whatever plan the org is on when it lands; the limit rises only on plans that list the add-on.';

-- Effective limits ------------------------------------------------------------------------------------------

create or replace view private.org_plan_limits as
select o.id as org_id, p.plan_code, pl.limit_code,
  case
    when pl.limit_value is null then null
    when pl.limit_code = 'seats' and p.seats_grandfathered then null
    when pl.limit_code = 'seats' then pl.limit_value + p.extra_seats
    else pl.limit_value + coalesce((
      select sum(a.amount::bigint * ap.quantity)
      from app.addon_purchases ap
      join private.plan_addons a on a.addon_code = ap.addon_code and a.plan_code = p.plan_code
      where ap.org_id = o.id and ap.deleted_at is null and a.limit_code = pl.limit_code
        and ap.applies_month = (date_trunc('month', now() at time zone 'UTC'))::date
    ), 0)
  end::bigint as limit_value
from app.organizations o
cross join lateral (
  select coalesce(s.plan_code, 'access') as plan_code,
    coalesce(s.extra_seats, 0) as extra_seats,
    coalesce(s.seats_grandfathered, false) as seats_grandfathered
  from (select 1) as one
  left join app.subscriptions s
    on s.org_id = o.id and s.subscription_state <> 'canceled' and s.deleted_at is null
) p
join private.plan_limits pl on pl.plan_code = p.plan_code;

comment on view private.org_plan_limits is 'Each org''s effective plan limits. An org without a current subscription is held to the Access plan. Seats are the plan allowance plus the extra seats bought, or unlimited for a grandfathered subscription; a limit an add-on raises adds this UTC month''s purchases (ADR 0034). Downgrades never delete data.';
comment on column private.org_plan_limits.limit_value is 'Maximum count in force, or null for unlimited.';

-- Seat refusals ---------------------------------------------------------------------------------------------

create or replace function private.assert_within_plan_limit(p_org_id uuid, p_limit app.plan_limit_code, p_prospective bigint)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit bigint := private.plan_limit(p_org_id, p_limit);
  v_plan text;
begin
  if v_limit is null or p_prospective <= v_limit then
    return;
  end if;
  if p_limit = 'seats' then
    select distinct l.plan_code into v_plan from private.org_plan_limits l where l.org_id = p_org_id;
    if exists (select 1 from private.plan_extra_seat_prices x where x.plan_code = v_plan) then
      perform private.refuse('seat_limit_reached',
        format('All %s seats are in use. Buy extra seats in Billing and Plan, or upgrade the plan.', v_limit));
    end if;
    perform private.refuse('seat_limit_upgrade',
      format('All %s seats are in use, and the %s plan sells no extra seats. Upgrade the plan to add seats.', v_limit, v_plan));
  end if;
  perform private.refuse('plan_limit_exceeded',
    format('The plan allows %s %s; this change needs %s.', v_limit, p_limit, p_prospective));
end;
$$;

comment on function private.assert_within_plan_limit(uuid, app.plan_limit_code, bigint) is 'Refuses when a prospective count exceeds the org''s plan limit. Seats refuse with seat_limit_reached (buy extra seats or upgrade) when the plan sells extra seats, and seat_limit_upgrade otherwise; every other limit refuses with plan_limit_exceeded (ADR 0034).';

create or replace function app.seat_usage(p_org_id uuid)
returns table (seats_used bigint, seat_limit bigint, plan_seats bigint, extra_seats integer, sells_extra_seats boolean, grandfathered boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_plan text;
begin
  if not private.is_member(p_org_id) then
    raise exception using errcode = '42501', message = 'Seat usage needs an active membership in the org';
  end if;
  select distinct l.plan_code into v_plan from private.org_plan_limits l where l.org_id = p_org_id;
  return query
    select (select c.seats from private.membership_band_counts(p_org_id) c),
      private.plan_limit(p_org_id, 'seats'),
      (select pl.limit_value from private.plan_limits pl where pl.plan_code = v_plan and pl.limit_code = 'seats'),
      coalesce((select s.extra_seats from app.subscriptions s
        where s.org_id = p_org_id and s.subscription_state <> 'canceled' and s.deleted_at is null), 0),
      exists (select 1 from private.plan_extra_seat_prices x where x.plan_code = v_plan),
      coalesce((select s.seats_grandfathered from app.subscriptions s
        where s.org_id = p_org_id and s.subscription_state <> 'canceled' and s.deleted_at is null), false);
end;
$$;

comment on function app.seat_usage(uuid) is 'Seats in use, the seat limit in force (null when unlimited), the plan''s own allowance, extra seats bought, whether the plan sells extra seats, and whether the subscription is grandfathered (ADR 0034). Members only.';

-- Stripe subscription sync with extra seats ------------------------------------------------------------------

drop function app.sync_subscription_from_stripe(uuid, text, text, text, app.billing_interval, text, timestamptz, boolean);

create function app.sync_subscription_from_stripe(
  p_org_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_plan_code text,
  p_billing_interval app.billing_interval,
  p_stripe_status text,
  p_current_period_end timestamptz,
  p_livemode boolean,
  p_extra_seats integer default 0
)
returns app.subscription_state
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sub app.subscriptions;
  v_link app.stripe_subscription_links;
  v_target app.subscription_state := private.stripe_status_state(p_stripe_status);
begin
  if not exists (select 1 from app.organizations o where o.id = p_org_id and o.deleted_at is null) then
    perform private.refuse('billing_org_unknown', 'The Stripe subscription names no live org.');
  end if;
  if not exists (select 1 from app.plans p where p.code = p_plan_code) then
    perform private.refuse('plan_unknown', format('%s is not a plan.', p_plan_code));
  end if;
  if coalesce(p_extra_seats, 0) < 0 or coalesce(p_extra_seats, 0) > 10000 then
    perform private.refuse('extra_seats_range', 'Extra seats run from 0 to 10,000.');
  end if;
  if coalesce(p_extra_seats, 0) > 0
     and not exists (select 1 from private.plan_extra_seat_prices x where x.plan_code = p_plan_code) then
    perform private.refuse('extra_seats_not_sold', format('The %s plan sells no extra seats.', p_plan_code));
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('billing:' || p_org_id::text, 0));
  select * into v_link from app.stripe_subscription_links l where l.stripe_subscription_id = p_stripe_subscription_id and l.deleted_at is null;
  if v_link.id is not null and v_link.org_id <> p_org_id then
    perform private.refuse('billing_org_mismatch', 'The Stripe subscription belongs to another org.');
  end if;
  select * into v_sub from app.subscriptions s
  where s.org_id = p_org_id and s.subscription_state <> 'canceled' and s.deleted_at is null for update;
  if v_target is null then
    return v_sub.subscription_state;
  end if;
  if v_target = 'canceled' then
    if v_sub.id is not null and (v_link.id is null or v_link.subscription_id = v_sub.id) then
      perform private.transition_subscription(v_sub.id, v_sub.subscription_state, 'canceled', 'Stripe subscription ended.');
      perform private.create_subscription(p_org_id, 'access');
    end if;
    update app.stripe_subscription_links set current_period_end = p_current_period_end where id = v_link.id;
    return 'canceled';
  end if;
  if v_sub.id is null then
    perform private.create_subscription(p_org_id, p_plan_code);
    select * into v_sub from app.subscriptions s where s.org_id = p_org_id and s.subscription_state <> 'canceled' and s.deleted_at is null;
  end if;
  if v_sub.plan_code <> p_plan_code or v_sub.extra_seats <> coalesce(p_extra_seats, 0) then
    update app.subscriptions set plan_code = p_plan_code, extra_seats = coalesce(p_extra_seats, 0) where id = v_sub.id;
  end if;
  if v_sub.subscription_state <> v_target then
    perform private.transition_subscription(v_sub.id, v_sub.subscription_state, v_target,
      format('Stripe subscription is %s.', p_stripe_status));
  end if;
  if v_link.id is null then
    insert into app.stripe_subscription_links (subscription_id, stripe_customer_id, stripe_subscription_id, billing_interval, livemode, current_period_end)
    values (v_sub.id, p_stripe_customer_id, p_stripe_subscription_id, p_billing_interval, p_livemode, p_current_period_end);
  else
    update app.stripe_subscription_links
    set subscription_id = v_sub.id, billing_interval = p_billing_interval, current_period_end = p_current_period_end
    where id = v_link.id;
  end if;
  return v_target;
end;
$$;

comment on function app.sync_subscription_from_stripe(uuid, text, text, text, app.billing_interval, text, timestamptz, boolean, integer) is 'Billing API (service role): applies a Stripe subscription to the org''s subscription. Sets the plan the server module resolved from the price lookup key and the extra seats from the quantity of the plan''s extra-seat price (ADR 0034), moves the state through the transition engine (active, past_due or canceled), links the Stripe ids, and on cancellation returns the org to the Access plan without deleting data (Section 14.7). Serialized per org.';

-- Privileges ------------------------------------------------------------------------------------------------

revoke all on function app.record_addon_purchase_from_stripe(uuid, text, integer, text, text, bigint, boolean, timestamptz) from public, anon, authenticated;
grant execute on function app.record_addon_purchase_from_stripe(uuid, text, integer, text, text, bigint, boolean, timestamptz) to service_role;
revoke all on function app.sync_subscription_from_stripe(uuid, text, text, text, app.billing_interval, text, timestamptz, boolean, integer) from public, anon, authenticated;
grant execute on function app.sync_subscription_from_stripe(uuid, text, text, text, app.billing_interval, text, timestamptz, boolean, integer) to service_role;
revoke all on function app.seat_usage(uuid) from public, anon;
grant execute on function app.seat_usage(uuid) to authenticated, service_role;
