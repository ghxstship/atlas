-- 904100201_checkout_offer.sql (4.10, block 02; written as 1641 on 2026-10-24, renumbered when it merged after 4.9).

-- Where Checkout is offered (ADR 0033 decision 59, RRR-130). Billing and Plan offered Choose and Add a card to orgs the
-- checkout checks of 1640 always refuse: a client org its partner bills, a sandbox, an org read-only for deletion or
-- cancellation. Their Owner heard of it only after a click.
--   * private.billing_checkout_refusal: the org and plan checks of private.assert_billing_checkout, as the rule that
--     refuses or null. private.assert_billing_checkout raises that rule, in the same order and words as in 1640.
--   * app.billing_account: also returns checkout_refusal, the rule that refuses every plan's Checkout for the org now,
--     so the page offers Checkout only where it opens and says why otherwise.
--   * app.record_billing_checkout: a session already recorded for another org, plan, term or mode is refused
--     (checkout_session_taken) instead of passing as a repeat that records nothing.

-- Checks ---------------------------------------------------------------------------------------------------------

create or replace function private.billing_checkout_refusal(p_org_id uuid, p_plan_code text, p_livemode boolean)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org app.organizations;
begin
  select * into v_org from app.organizations o where o.id = p_org_id and o.deleted_at is null;
  if v_org.id is null then
    return 'billing_org_unknown';
  end if;
  if private.is_sandbox_org(p_org_id) then
    return 'sandbox_not_billable';
  end if;
  if v_org.parent_org_id is not null then
    return 'billing_through_partner';
  end if;
  if private.org_read_only_reason(p_org_id) in ('deletion', 'canceled') then
    return 'org_read_only';
  end if;
  if p_plan_code is not null
     and not exists (select 1 from private.plan_list_prices l
                     where l.plan_code = p_plan_code and l.currency_code = 'USD' and l.monthly_minor > 0) then
    return 'plan_not_self_serve';
  end if;
  if private.paid_through_stripe(p_org_id, coalesce(p_livemode, false)) then
    return 'billing_already_subscribed';
  end if;
  if private.checkout_awaiting_subscription(p_org_id, coalesce(p_livemode, false)) then
    return 'checkout_completed';
  end if;
  return null;
end;
$$;

comment on function private.billing_checkout_refusal(uuid, text, boolean) is 'The rule that refuses a Checkout of the org in that mode, or null when it may open once the caller holds org.billing.manage and passed a second factor: billing_org_unknown, sandbox_not_billable, billing_through_partner, org_read_only (deletion or cancellation), plan_not_self_serve (only when a plan is named), billing_already_subscribed or checkout_completed, checked in that order.';
revoke all on function private.billing_checkout_refusal(uuid, text, boolean) from public, anon, authenticated;

create or replace function private.assert_billing_checkout(p_org_id uuid, p_plan_code text, p_livemode boolean)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rule text;
begin
  if not private.has_capability(p_org_id, 'org.billing.manage') then
    raise exception using errcode = '42501', message = 'org.billing.manage is required';
  end if;
  v_rule := private.billing_checkout_refusal(p_org_id, coalesce(p_plan_code, ''), p_livemode);
  if v_rule is not null then
    perform private.refuse(v_rule, case v_rule
      when 'billing_org_unknown' then 'The organization does not exist.'
      when 'sandbox_not_billable' then 'A sandbox is never billed.'
      when 'billing_through_partner' then 'Your partner bills this organization. Ask the partner to change its plan.'
      when 'org_read_only' then 'This organization is read-only. Recover or reactivate it in Settings, Danger zone, before choosing a plan.'
      when 'plan_not_self_serve' then format('The %s plan cannot be bought through Checkout.', p_plan_code)
      when 'billing_already_subscribed' then 'This organization already pays through Stripe. Change the plan or the payment method in the billing portal.'
      when 'checkout_completed' then 'A checkout for this organization just completed. The plan shown here updates in a moment.'
    end);
  end if;
  perform private.require_second_factor('change billing');
end;
$$;

comment on function private.assert_billing_checkout(uuid, text, boolean) is 'The checks before a Checkout for a plan opens or is recorded: the caller holds org.billing.manage (42501 otherwise); the org is live, not a sandbox, not billed by its partner and not read-only for deletion or cancellation; the plan is sold through Checkout (a USD list price above zero, so neither Access nor a quoted plan); the org does not already pay through Stripe in that mode, nor has a completed checkout whose subscription has not synced yet (checkout_completed); and, last, a second factor in the last 15 minutes (step_up_required). The org and plan checks are private.billing_checkout_refusal.';
revoke all on function private.assert_billing_checkout(uuid, text, boolean) from public, anon, authenticated;

-- Atlas: recording a checkout --------------------------------------------------------------------------------------

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
  if exists (select 1 from app.billing_checkouts c
             where c.stripe_checkout_session_id = p_stripe_checkout_session_id
               and (c.org_id <> p_org_id or c.plan_code <> p_plan_code
                    or c.billing_interval <> p_billing_interval or c.livemode <> p_livemode)) then
    perform private.refuse('checkout_session_taken', 'That Checkout session was recorded for another checkout.');
  end if;
  with closed as (
    update app.billing_checkouts c set checkout_state = 'Expired', finished_at = now()
    where c.org_id = p_org_id and c.checkout_state = 'Open' and c.livemode = p_livemode and c.deleted_at is null
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

comment on function app.record_billing_checkout(uuid, text, app.billing_interval, text, boolean, timestamptz) is 'Atlas, once Stripe opened a Checkout session for a plan: runs the checkout checks again, records the session as Open (once; a repeat for the same org, plan, term and mode changes nothing, and a session recorded for any other is refused with checkout_session_taken) and closes every other open session of the org in that mode as Expired, returning their ids so Atlas expires them in Stripe too. Serialized per org with the billing lock of app.sync_subscription_from_stripe.';

-- Atlas: the billing summary -------------------------------------------------------------------------------------

drop function app.billing_account(uuid, boolean);

create function app.billing_account(p_org_id uuid, p_livemode boolean)
returns table (paid_through_stripe boolean, has_stripe_customer boolean, awaiting_subscription boolean, billing_interval app.billing_interval, current_period_end timestamptz, checkout_refusal text)
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
      private.checkout_awaiting_subscription(p_org_id, p_livemode),
      l.billing_interval, l.current_period_end,
      private.billing_checkout_refusal(p_org_id, null, p_livemode)
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

comment on function app.billing_account(uuid, boolean) is 'Billing and Plan''s summary of the org''s Stripe billing in that mode, for a caller with org.billing.read: whether the current subscription pays through Stripe (then the customer portal changes it; otherwise Checkout does), whether the org has a Stripe customer at all, whether a completed checkout still waits for its subscription to sync (then Checkout waits too), the term and period end of the paid subscription, and the rule that refuses Checkout for every plan of the org now (private.billing_checkout_refusal; null when Checkout opens after step-up).';

-- Privileges --------------------------------------------------------------------------------------------------------

revoke all on function app.record_billing_checkout(uuid, text, app.billing_interval, text, boolean, timestamptz) from public, anon;
grant execute on function app.record_billing_checkout(uuid, text, app.billing_interval, text, boolean, timestamptz) to authenticated;
revoke all on function app.billing_account(uuid, boolean) from public, anon;
grant execute on function app.billing_account(uuid, boolean) to authenticated;
