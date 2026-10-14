-- 0560_billing.sql
-- A18 Platform Services. Billing (Section 7.3 Billing, Section 16, Section 14.7):
--   * stripe_events: idempotent ingestion of Stripe webhook events (one row per Stripe event id)
--   * stripe_subscription_links: the Stripe customer and subscription behind an org's subscription
--   * app.sync_subscription_from_stripe: the one path from a Stripe subscription to app.subscriptions,
--     through the A02 transition engine; the Stripe server module resolves the plan from the price
--     lookup key in packages/schemas/plans.yaml before calling it, so no price id lives here
--   * dunning (Section 16): reminders to billing owners on days 0, 3, 7 and 14 of a failed payment, and
--     read-only on day 21, run daily by pg_cron
-- Stripe calls themselves live in the server module; this range never calls Stripe.

-- Stripe events ------------------------------------------------------------------------------------------

create table app.stripe_events (
  id uuid primary key default private.uuid_v7(),
  org_id uuid references app.organizations (id),
  stripe_event_id text not null,
  event_type text not null,
  livemode boolean not null,
  stripe_created_at timestamptz not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_error text,
  attempts smallint not null default 0,
  constraint stripe_events_id_format check (stripe_event_id ~ '^evt_[A-Za-z0-9]+$'),
  constraint stripe_events_type_format check (event_type ~ '^[a-z_]+(\.[a-z_]+)+$'),
  constraint stripe_events_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint stripe_events_error_length check (processing_error is null or char_length(processing_error) <= 2000)
);

create unique index stripe_events_stripe_event_id_key on app.stripe_events (stripe_event_id);
create index stripe_events_unprocessed_idx on app.stripe_events (received_at) where processed_at is null;

call private.install_domain_table('app.stripe_events');
call private.describe('app.stripe_events', 'Stripe webhook events, stored once per Stripe event id so a redelivered event is never applied twice (idempotent ingestion). The payload is the provider payload (ADR 0002).', array[
  'org_id', 'Org the event concerns, resolved from the Stripe customer or subscription metadata when the event is stored; null for events of no org. It never changes afterwards.',
  'stripe_event_id', 'Stripe event id (evt_...), unique.',
  'event_type', 'Stripe event type, such as customer.subscription.updated.',
  'livemode', 'True for live mode events; test mode events never touch live orgs.',
  'stripe_created_at', 'When Stripe created the event.',
  'payload', 'Event payload as Stripe sent it, after signature verification.',
  'received_at', 'When the webhook arrived. Set by the database.',
  'processed_at', 'When the event was applied.',
  'processing_error', 'Why applying the event failed; it is retried.',
  'attempts', 'Apply attempts so far.'
]);

create trigger t40_stamp_received_at before insert on app.stripe_events
  for each row execute function private.stamp_received_now('received_at');

call private.install_policies('app.stripe_events',
  $$org_id in (select private.orgs_with_capability('org.billing.read'))$$);

create or replace function app.record_stripe_event(
  p_stripe_event_id text,
  p_event_type text,
  p_livemode boolean,
  p_stripe_created_at timestamptz,
  p_payload jsonb,
  p_org_id uuid default null
)
returns table (stripe_event_row_id uuid, is_new boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into app.stripe_events (org_id, stripe_event_id, event_type, livemode, stripe_created_at, payload)
  values (p_org_id, p_stripe_event_id, p_event_type, p_livemode, p_stripe_created_at, p_payload)
  on conflict (stripe_event_id) do nothing
  returning id into v_id;
  if v_id is not null then
    return query select v_id, true;
  else
    return query select e.id, false from app.stripe_events e where e.stripe_event_id = p_stripe_event_id;
  end if;
end;
$$;

comment on function app.record_stripe_event(text, text, boolean, timestamptz, jsonb, uuid) is 'Stripe webhook API (service role, after the server module verified the Stripe signature and resolved the org from the customer or subscription metadata): stores an event once with its org. A redelivery returns the existing row with is_new false, so the caller applies each event exactly once.';

create or replace function app.finish_stripe_event(p_stripe_event_row_id uuid, p_error text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update app.stripe_events
  set attempts = attempts + 1,
    processed_at = case when p_error is null then now() end,
    processing_error = left(p_error, 2000)
  where id = p_stripe_event_row_id;
  if not found then
    perform private.refuse('stripe_event_unknown', 'No such Stripe event.');
  end if;
end;
$$;

comment on function app.finish_stripe_event(uuid, text) is 'Stripe webhook API (service role): records the outcome of applying an event; a failure keeps it for retry.';

-- Stripe subscription links --------------------------------------------------------------------------------------

create type app.billing_interval as enum ('Monthly', 'Annual');
comment on type app.billing_interval is 'Billing term of a paid subscription (Section 16).';

create table app.stripe_subscription_links (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  subscription_id uuid not null references app.subscriptions (id),
  stripe_customer_id text not null,
  stripe_subscription_id text not null,
  billing_interval app.billing_interval not null,
  livemode boolean not null,
  current_period_end timestamptz,
  constraint stripe_subscription_links_customer_format check (stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  constraint stripe_subscription_links_subscription_format check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$')
);

create unique index stripe_subscription_links_stripe_subscription_key on app.stripe_subscription_links (stripe_subscription_id);
create index stripe_subscription_links_subscription_idx on app.stripe_subscription_links (subscription_id);
create index stripe_subscription_links_customer_idx on app.stripe_subscription_links (stripe_customer_id);

call private.install_domain_table('app.stripe_subscription_links', 'app.subscriptions', 'subscription_id');
call private.describe('app.stripe_subscription_links', 'The Stripe customer and subscription behind an org''s subscription. Plan and state live on app.subscriptions; this row holds only Stripe''s identifiers, the term and the period end Stripe reports.', array[
  'subscription_id', 'XOS subscription the Stripe subscription pays for.',
  'stripe_customer_id', 'Stripe customer (cus_...).',
  'stripe_subscription_id', 'Stripe subscription (sub_...), unique.',
  'billing_interval', 'Monthly or Annual.',
  'livemode', 'True for live mode.',
  'current_period_end', 'End of the period Stripe has billed, as Stripe reports it.'
]);

call private.install_policies('app.stripe_subscription_links',
  $$org_id in (select private.orgs_with_capability('org.billing.read'))$$);

create or replace function private.stripe_status_state(p_status text)
returns app.subscription_state
language sql
immutable
set search_path = ''
as $$
  select case p_status
    when 'active' then 'active'
    when 'trialing' then 'active'
    when 'past_due' then 'past_due'
    when 'unpaid' then 'past_due'
    when 'canceled' then 'canceled'
    when 'incomplete_expired' then 'canceled'
  end::app.subscription_state;
$$;

comment on function private.stripe_status_state(text) is 'Subscription state for a Stripe subscription status. Stripe trials count as active; incomplete and paused statuses change nothing (null). Read-only comes only from XOS dunning on day 21.';

create or replace function app.sync_subscription_from_stripe(
  p_org_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_plan_code text,
  p_billing_interval app.billing_interval,
  p_stripe_status text,
  p_current_period_end timestamptz,
  p_livemode boolean
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
  if v_sub.plan_code <> p_plan_code then
    update app.subscriptions set plan_code = p_plan_code where id = v_sub.id;
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

comment on function app.sync_subscription_from_stripe(uuid, text, text, text, app.billing_interval, text, timestamptz, boolean) is 'Billing API (service role): applies a Stripe subscription to the org''s subscription. Sets the plan the server module resolved from the price lookup key, moves the state through the transition engine (active, past_due or canceled), links the Stripe ids, and on cancellation returns the org to the Access plan without deleting data (Section 14.7). Serialized per org.';

-- Dunning (Section 16) -----------------------------------------------------------------------------------------------

insert into private.notification_templates (kind, channel, category_code, email_template_code)
select 'billing.payment_failed', c.channel, 'account', case when c.channel = 'Email' then 'notification' end
from (values ('In App'::app.notification_channel), ('Email'), ('SMS'), ('Push')) as c (channel)
union all
select 'billing.read_only', c.channel, 'account', case when c.channel = 'Email' then 'notification' end
from (values ('In App'::app.notification_channel), ('Email'), ('SMS'), ('Push')) as c (channel);

create or replace function private.past_due_since(p_subscription_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select max(t.created_at) from app.subscription_state_transitions t
  where t.subscription_id = p_subscription_id and t.to_state = 'past_due';
$$;

comment on function private.past_due_since(uuid) is 'When a subscription last became past due, read from the transition ledger.';

create or replace function private.run_dunning(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sub record;
  v_days integer;
  v_person uuid;
  v_actions integer := 0;
begin
  for v_sub in
    select s.id, s.org_id, s.subscription_state, private.past_due_since(s.id) as since
    from app.subscriptions s
    where s.subscription_state = 'past_due' and s.deleted_at is null
  loop
    v_days := floor(extract(epoch from (p_now - v_sub.since)) / 86400)::integer;
    if v_days >= 21 then
      perform private.transition_subscription(v_sub.id, 'past_due', 'read_only', 'Payment still failed on day 21 of dunning.');
      for v_person in
        select distinct m.person_id from app.memberships m
        where m.org_id = v_sub.org_id and m.deleted_at is null and m.valid_from <= p_now and (m.valid_to is null or m.valid_to > p_now)
          and private.person_capability_reach(m.person_id, v_sub.org_id, 'org.billing.read', false) = 'organization'
      loop
        perform private.notify(v_sub.org_id, v_person, 'billing.read_only', 'app.subscriptions', v_sub.id, null, '{}'::jsonb);
      end loop;
      v_actions := v_actions + 1;
    elsif v_days in (0, 3, 7, 14) then
      for v_person in
        select distinct m.person_id from app.memberships m
        where m.org_id = v_sub.org_id and m.deleted_at is null and m.valid_from <= p_now and (m.valid_to is null or m.valid_to > p_now)
          and private.person_capability_reach(m.person_id, v_sub.org_id, 'org.billing.read', false) = 'organization'
          and not exists (
            select 1 from app.notifications n
            where n.recipient_person_id = m.person_id and n.kind = 'billing.payment_failed' and n.subject_id = v_sub.id
              and n.message_args ->> 'days' = v_days::text)
      loop
        perform private.notify(v_sub.org_id, v_person, 'billing.payment_failed', 'app.subscriptions', v_sub.id, null,
          jsonb_build_object('days', v_days));
        v_actions := v_actions + 1;
      end loop;
    end if;
  end loop;
  return v_actions;
end;
$$;

comment on function private.run_dunning(timestamptz) is 'Daily dunning (Section 16): notifies the org''s billing owners on days 0, 3, 7 and 14 after a payment failed (once per day mark), and makes the org read-only on day 21 with a notice to every billing owner. Data is never deleted for non-payment.';

select cron.schedule('xos_daily_dunning', '5 14 * * *', 'select private.run_dunning()');

-- Retention ---------------------------------------------------------------------------------------------------------

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.stripe_events', 'Age', 'received_at', interval '7 years', 'Delete', 'Billing evidence kept 7 years.'),
  ('app.stripe_subscription_links', 'Soft Deleted', 'deleted_at', interval '7 years', 'Delete', 'Billing records kept 7 years.');

-- Privileges --------------------------------------------------------------------------------------------------------

revoke all on function app.record_stripe_event(text, text, boolean, timestamptz, jsonb, uuid) from public, anon, authenticated;
grant execute on function app.record_stripe_event(text, text, boolean, timestamptz, jsonb, uuid) to service_role;
revoke all on function app.finish_stripe_event(uuid, text) from public, anon, authenticated;
grant execute on function app.finish_stripe_event(uuid, text) to service_role;
revoke all on function private.stripe_status_state(text) from public, anon, authenticated;
revoke all on function app.sync_subscription_from_stripe(uuid, text, text, text, app.billing_interval, text, timestamptz, boolean) from public, anon, authenticated;
grant execute on function app.sync_subscription_from_stripe(uuid, text, text, text, app.billing_interval, text, timestamptz, boolean) to service_role;
revoke all on function private.past_due_since(uuid) from public, anon, authenticated;
revoke all on function private.run_dunning(timestamptz) from public, anon, authenticated;
