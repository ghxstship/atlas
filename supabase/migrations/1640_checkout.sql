-- 1640_checkout.sql
-- Checkout (owner decision 21 of 2026-10-23, RRR-130; ADR 0035 gaps): XOS launches on the trial and the Access plan,
-- and billing opens once Checkout is built. Atlas starts Stripe Checkout to move an org from a trial or Access to a
-- paid plan and opens the Stripe customer portal for an org that pays; the stripe-webhook Edge Function keeps
-- app.subscriptions in step through app.sync_subscription_from_stripe (0560, 1250). Stripe calls live in Atlas and
-- @xos/platform; this migration never calls Stripe.
--   * app.billing_checkouts: each Checkout session Atlas opens for a plan. Starting another expires the org's open
--     ones first, so two browser tabs never pay for two subscriptions. The webhook marks a session Completed or
--     Expired as Stripe reports it.
--   * app.begin_billing_checkout: the checks before Atlas calls Stripe (org.billing.manage; a live org that is neither
--     a sandbox, nor billed by its partner, nor read-only; a self-serve plan; no paid Stripe subscription yet; then a
--     second factor in the last 15 minutes) and what Checkout needs: the org's Stripe customer, the trial end to carry
--     over and the sessions still open.
--   * app.record_billing_checkout: records the session Stripe opened, after the same checks, and closes the org's
--     other open sessions, naming them so Atlas expires them in Stripe too.
--   * app.finish_billing_checkout_from_stripe: the webhook's record that a session completed or expired (service role).
--   * app.billing_portal_customer: the Stripe customer whose portal the Owner opens, after the same step-up.
--   * app.billing_account: whether the org pays through Stripe, for Billing and Plan.

-- Checkout sessions -------------------------------------------------------------------------------------------------

create type app.billing_checkout_state as enum ('Open', 'Completed', 'Expired');
comment on type app.billing_checkout_state is 'State of a Stripe Checkout session Atlas opened: Open until Stripe completes or expires it, or until a newer checkout of the same org closes it (Expired).';

create table app.billing_checkouts (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  plan_code text not null references app.plans (code),
  billing_interval app.billing_interval not null,
  stripe_checkout_session_id text not null,
  livemode boolean not null,
  checkout_state app.billing_checkout_state not null default 'Open',
  expires_at timestamptz not null,
  finished_at timestamptz,
  constraint billing_checkouts_session_format check (stripe_checkout_session_id ~ '^cs_(test|live)_[A-Za-z0-9]+$'),
  constraint billing_checkouts_session_mode check ((stripe_checkout_session_id like 'cs_live_%') = livemode),
  constraint billing_checkouts_finished check ((checkout_state = 'Open') = (finished_at is null))
);

create unique index billing_checkouts_session_key on app.billing_checkouts (stripe_checkout_session_id);
create index billing_checkouts_open_idx on app.billing_checkouts (org_id, expires_at) where checkout_state = 'Open';
create index billing_checkouts_plan_code_idx on app.billing_checkouts (plan_code);

call private.install_domain_table('app.billing_checkouts');
call private.describe('app.billing_checkouts', 'Stripe Checkout sessions Atlas opened to move an org onto a paid plan (owner decision 21 of 2026-10-23). A newer checkout of the same org expires the open ones first, so an org never pays for two subscriptions. The plan itself changes only when the webhook syncs the paid Stripe subscription (app.sync_subscription_from_stripe).', array[
  'plan_code', 'Plan the checkout sells.',
  'billing_interval', 'Monthly or Annual.',
  'stripe_checkout_session_id', 'Stripe Checkout session (cs_...), unique.',
  'livemode', 'True for a live mode session; test mode sessions never touch live billing.',
  'checkout_state', 'Open, Completed or Expired, as Stripe reports it; Expired also when a newer checkout of the org closed it.',
  'expires_at', 'When Stripe expires the session if nobody completes it.',
  'finished_at', 'When the session completed or expired; null while it is open.'
]);

call private.install_policies('app.billing_checkouts',
  $$org_id in (select private.orgs_with_capability('org.billing.read'))$$);
call private.install_audit_trail('app.billing_checkouts');

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.billing_checkouts', 'Age', 'created_at', interval '7 years', 'Delete', 'Billing evidence kept 7 years.');

-- Checks ---------------------------------------------------------------------------------------------------------

create or replace function private.paid_through_stripe(p_org_id uuid, p_livemode boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.subscriptions s
    join app.stripe_subscription_links l on l.subscription_id = s.id and l.deleted_at is null
    where s.org_id = p_org_id and s.subscription_state <> 'canceled' and s.deleted_at is null
      and l.livemode = p_livemode);
$$;

comment on function private.paid_through_stripe(uuid, boolean) is 'True when the org''s current subscription is linked to a Stripe subscription of that mode: it pays through Stripe, so its plan, card and cancellation change in the customer portal, never through a second Checkout.';
revoke all on function private.paid_through_stripe(uuid, boolean) from public, anon, authenticated;

create or replace function private.stripe_customer_of(p_org_id uuid, p_livemode boolean)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select l.stripe_customer_id from app.stripe_subscription_links l
  where l.org_id = p_org_id and l.livemode = p_livemode and l.deleted_at is null
  order by l.created_at desc
  limit 1;
$$;

comment on function private.stripe_customer_of(uuid, boolean) is 'The Stripe customer of the org''s latest Stripe subscription in that mode, current or ended, or null when it never paid through Stripe. Checkout reuses it, so invoices and cards stay on one customer.';
revoke all on function private.stripe_customer_of(uuid, boolean) from public, anon, authenticated;

create or replace function private.assert_billing_checkout(p_org_id uuid, p_plan_code text, p_livemode boolean)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org app.organizations;
begin
  if not private.has_capability(p_org_id, 'org.billing.manage') then
    raise exception using errcode = '42501', message = 'org.billing.manage is required';
  end if;
  select * into v_org from app.organizations o where o.id = p_org_id and o.deleted_at is null;
  if v_org.id is null then
    perform private.refuse('billing_org_unknown', 'The organization does not exist.');
  end if;
  if private.is_sandbox_org(p_org_id) then
    perform private.refuse('sandbox_not_billable', 'A sandbox is never billed.');
  end if;
  if v_org.parent_org_id is not null then
    perform private.refuse('billing_through_partner', 'Your partner bills this organization. Ask the partner to change its plan.');
  end if;
  if private.org_read_only_reason(p_org_id) in ('deletion', 'canceled') then
    perform private.refuse('org_read_only', 'This organization is read-only. Recover or reactivate it in Settings, Danger zone, before choosing a plan.');
  end if;
  if not exists (select 1 from private.plan_list_prices l
                 where l.plan_code = p_plan_code and l.currency_code = 'USD' and l.monthly_minor > 0) then
    perform private.refuse('plan_not_self_serve', format('The %s plan cannot be bought through Checkout.', p_plan_code));
  end if;
  if private.paid_through_stripe(p_org_id, coalesce(p_livemode, false)) then
    perform private.refuse('billing_already_subscribed', 'This organization already pays through Stripe. Change the plan or the payment method in the billing portal.');
  end if;
  perform private.require_second_factor('change billing');
end;
$$;

comment on function private.assert_billing_checkout(uuid, text, boolean) is 'The checks before a Checkout for a plan opens or is recorded: the caller holds org.billing.manage (42501 otherwise); the org is live, not a sandbox, not billed by its partner and not read-only for deletion or cancellation; the plan is sold through Checkout (a USD list price above zero, so neither Access nor a quoted plan); the org does not already pay through Stripe in that mode; and, last, a second factor in the last 15 minutes (step_up_required).';
revoke all on function private.assert_billing_checkout(uuid, text, boolean) from public, anon, authenticated;

-- Atlas: opening and recording a checkout -------------------------------------------------------------------------

create or replace function app.begin_billing_checkout(
  p_org_id uuid,
  p_plan_code text,
  p_livemode boolean
)
returns table (stripe_customer_id text, trial_ends_at timestamptz, open_session_ids text[])
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_billing_checkout(p_org_id, p_plan_code, p_livemode);
  return query
    select private.stripe_customer_of(p_org_id, p_livemode),
      (select s.trial_ends_at from app.subscriptions s
       where s.org_id = p_org_id and s.subscription_state = 'trialing' and s.deleted_at is null),
      coalesce((select array_agg(c.stripe_checkout_session_id order by c.created_at)
        from app.billing_checkouts c
        where c.org_id = p_org_id and c.checkout_state = 'Open' and c.livemode = p_livemode
          and c.expires_at > now() and c.deleted_at is null), '{}'::text[]);
end;
$$;

comment on function app.begin_billing_checkout(uuid, text, boolean) is 'Atlas, before it opens Stripe Checkout for a plan (owner decision 21 of 2026-10-23): runs the checkout checks (private.assert_billing_checkout, step-up last) and returns the org''s Stripe customer in that mode (null before its first payment), the end of its running trial (null without one), which Checkout carries over so the card is charged only when the trial would have ended, and the org''s open Checkout sessions, which Atlas expires before opening another.';

create or replace function app.record_billing_checkout(
  p_org_id uuid,
  p_plan_code text,
  p_billing_interval app.billing_interval,
  p_stripe_checkout_session_id text,
  p_livemode boolean,
  p_expires_at timestamptz
)
returns text[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_closed text[];
begin
  perform private.assert_billing_checkout(p_org_id, p_plan_code, p_livemode);
  if p_billing_interval is null then
    perform private.refuse('billing_interval_required', 'Choose monthly or annual billing.');
  end if;
  if p_stripe_checkout_session_id is null or p_stripe_checkout_session_id !~ '^cs_(test|live)_[A-Za-z0-9]+$'
     or (p_stripe_checkout_session_id like 'cs_live_%') <> p_livemode then
    perform private.refuse('checkout_session_invalid', 'That is not a Stripe Checkout session of this mode.');
  end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '25 hours' then
    perform private.refuse('checkout_expiry_range', 'A Checkout session expires within a day.');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('billing:' || p_org_id::text, 0));
  with closed as (
    update app.billing_checkouts c set checkout_state = 'Expired', finished_at = now()
    where c.org_id = p_org_id and c.checkout_state = 'Open' and c.deleted_at is null
      and c.stripe_checkout_session_id <> p_stripe_checkout_session_id
    returning c.stripe_checkout_session_id, c.created_at
  )
  select coalesce(array_agg(closed.stripe_checkout_session_id order by closed.created_at), '{}'::text[])
  into v_closed from closed;
  insert into app.billing_checkouts (org_id, plan_code, billing_interval, stripe_checkout_session_id, livemode, expires_at)
  values (p_org_id, p_plan_code, p_billing_interval, p_stripe_checkout_session_id, p_livemode, p_expires_at)
  on conflict (stripe_checkout_session_id) do nothing;
  return v_closed;
end;
$$;

comment on function app.record_billing_checkout(uuid, text, app.billing_interval, text, boolean, timestamptz) is 'Atlas, once Stripe opened a Checkout session for a plan: runs the checkout checks again, records the session as Open (once; a repeat changes nothing) and closes every other open session of the org as Expired, returning their ids so Atlas expires them in Stripe too. Serialized per org with the billing lock of app.sync_subscription_from_stripe.';

-- Webhook: a session completed or expired -----------------------------------------------------------------------

create or replace function app.finish_billing_checkout_from_stripe(
  p_stripe_checkout_session_id text,
  p_checkout_state app.billing_checkout_state
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_checkout_state is distinct from 'Completed' and p_checkout_state is distinct from 'Expired' then
    perform private.refuse('checkout_state_invalid', 'A Checkout session finishes Completed or Expired.');
  end if;
  update app.billing_checkouts c
  set checkout_state = p_checkout_state, finished_at = coalesce(c.finished_at, now())
  where c.stripe_checkout_session_id = p_stripe_checkout_session_id and c.deleted_at is null
    and c.checkout_state <> 'Completed'
    and (p_checkout_state = 'Completed' or c.checkout_state = 'Open');
  return exists (select 1 from app.billing_checkouts c
                 where c.stripe_checkout_session_id = p_stripe_checkout_session_id and c.deleted_at is null);
end;
$$;

comment on function app.finish_billing_checkout_from_stripe(text, app.billing_checkout_state) is 'Stripe webhook API (service role, after the server module verified the Stripe signature): records that a Checkout session Atlas opened completed or expired. Completed is final and wins over a newer checkout having closed the session; Expired applies only to an open session. Returns whether Atlas opened the session at all. The subscription itself syncs through app.sync_subscription_from_stripe.';

-- Atlas: the customer portal and the billing summary -------------------------------------------------------------

create or replace function app.billing_portal_customer(p_org_id uuid, p_livemode boolean)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_customer text;
begin
  if not private.has_capability(p_org_id, 'org.billing.manage') then
    raise exception using errcode = '42501', message = 'org.billing.manage is required';
  end if;
  v_customer := private.stripe_customer_of(p_org_id, p_livemode);
  if v_customer is null then
    perform private.refuse('billing_no_customer', 'This organization has not paid through Stripe yet. Choose a plan first.');
  end if;
  perform private.require_second_factor('change billing');
  return v_customer;
end;
$$;

comment on function app.billing_portal_customer(uuid, boolean) is 'Atlas, before it opens the Stripe customer portal (plan, payment method, invoices and cancellation): the org''s Stripe customer in that mode, for a caller with org.billing.manage (42501 otherwise) who passed a second factor in the last 15 minutes (step_up_required). Refuses billing_no_customer for an org that never paid through Stripe.';

create or replace function app.billing_account(p_org_id uuid, p_livemode boolean)
returns table (paid_through_stripe boolean, has_stripe_customer boolean, billing_interval app.billing_interval, current_period_end timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_capability(p_org_id, 'org.billing.read') then
    raise exception using errcode = '42501', message = 'org.billing.read is required';
  end if;
  return query
    select private.paid_through_stripe(p_org_id, p_livemode),
      private.stripe_customer_of(p_org_id, p_livemode) is not null,
      l.billing_interval, l.current_period_end
    from (select 1) as one
    left join lateral (
      select sl.billing_interval, sl.current_period_end from app.stripe_subscription_links sl
      join app.subscriptions s on s.id = sl.subscription_id
      where sl.org_id = p_org_id and sl.livemode = p_livemode and sl.deleted_at is null
        and s.subscription_state <> 'canceled' and s.deleted_at is null
      order by sl.created_at desc
      limit 1
    ) l on true;
end;
$$;

comment on function app.billing_account(uuid, boolean) is 'Billing and Plan''s summary of the org''s Stripe billing in that mode, for a caller with org.billing.read: whether the current subscription pays through Stripe (then the customer portal changes it; otherwise Checkout does), whether the org has a Stripe customer at all, and the term and period end of the paid subscription.';

-- Privileges --------------------------------------------------------------------------------------------------------

revoke all on function app.begin_billing_checkout(uuid, text, boolean) from public, anon;
grant execute on function app.begin_billing_checkout(uuid, text, boolean) to authenticated;
revoke all on function app.record_billing_checkout(uuid, text, app.billing_interval, text, boolean, timestamptz) from public, anon;
grant execute on function app.record_billing_checkout(uuid, text, app.billing_interval, text, boolean, timestamptz) to authenticated;
revoke all on function app.finish_billing_checkout_from_stripe(text, app.billing_checkout_state) from public, anon, authenticated;
grant execute on function app.finish_billing_checkout_from_stripe(text, app.billing_checkout_state) to service_role;
revoke all on function app.billing_portal_customer(uuid, boolean) from public, anon;
grant execute on function app.billing_portal_customer(uuid, boolean) to authenticated;
revoke all on function app.billing_account(uuid, boolean) from public, anon;
grant execute on function app.billing_account(uuid, boolean) to authenticated;
