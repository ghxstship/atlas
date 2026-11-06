-- 6141_renewal_consent.sql
-- Legal billing issue 1 (RRR-248, ADR 0161): what auto-renewal law needs around a paid plan. Built to the strictest reading
-- found, since ROSCA's reach to business buyers is disputed and small producers buy XOS: ROSCA (15 U.S.C. 8403), California's
-- Automatic Renewal Law as the design standard, and Wisconsin 134.49 and New York GOL 5-903 for annual business contracts.
--   * private.billing_renewal_consents: what the Owner saw and agreed to before Stripe Checkout: the exact statement, its
--     text version and language, the price, the term and the next charge date, plus initials on an annual plan. Written once,
--     never changed except to name its Checkout session and when it was confirmed. It keeps no org_id, so the proof outlives
--     the org.
--   * A live mode Checkout cannot be recorded without one (renewal_consent_required).
--   * After purchase, billing.purchase_confirmed repeats the same terms to the billing owners.
--   * private.run_billing_renewal_reminders: every annual plan gets billing.renewal_reminder 30 days before it renews, which
--     sits inside California's 15 to 45 days, New York's 15 to 30 and Wisconsin's 15 to 60. private.billing_renewal_reminders
--     keeps the proof it was sent.

create table private.billing_renewal_consents (
  id uuid primary key default private.uuid_v7(),
  subject_org_id uuid not null,
  org_name text,
  consented_by uuid references app.people (id) on delete set null,
  consented_by_email text,
  plan_code text not null,
  billing_interval app.billing_interval not null,
  amount_minor bigint not null,
  currency_code text not null,
  next_charge_on date not null,
  text_version text not null,
  locale text not null,
  statement text not null,
  initials text,
  livemode boolean not null,
  stripe_checkout_session_id text,
  confirmation_notified_at timestamptz,
  created_at timestamptz not null default now(),
  constraint billing_renewal_consents_amount_positive check (amount_minor > 0),
  constraint billing_renewal_consents_currency check (currency_code ~ '^[A-Z]{3}$'),
  constraint billing_renewal_consents_locale check (locale ~ '^[a-z]{2}-[A-Z]{2}$'),
  constraint billing_renewal_consents_version check (text_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  constraint billing_renewal_consents_annual_initials check (billing_interval <> 'Annual' or initials is not null),
  constraint billing_renewal_consents_lengths check (
    char_length(statement) between 1 and 2000
    and (initials is null or char_length(initials) between 1 and 12)
    and (org_name is null or char_length(org_name) <= 300)
    and (consented_by_email is null or char_length(consented_by_email) <= 320))
);

create index billing_renewal_consents_org_idx on private.billing_renewal_consents (subject_org_id, created_at);
create index billing_renewal_consents_consented_by_idx on private.billing_renewal_consents (consented_by);
create unique index billing_renewal_consents_session_key on private.billing_renewal_consents (stripe_checkout_session_id) where stripe_checkout_session_id is not null;

call private.describe('private.billing_renewal_consents', 'Proof that an Owner saw and accepted the renewal terms of a paid plan before paying (ADR 0161). Kept 7 years and past the org''s own deletion, since the evidence is needed for a later dispute. No foreign key to the org.', array[
  'id', 'Consent id.',
  'subject_org_id', 'Id the org had or has.',
  'org_name', 'Name of the org at consent.',
  'consented_by', 'Person who agreed, or null once their account is deleted.',
  'consented_by_email', 'Their sign-in address at consent, kept as evidence after the account goes.',
  'plan_code', 'Plan bought.',
  'billing_interval', 'Renewal term: Monthly or Annual.',
  'amount_minor', 'List price of each term in that currency before tax, in minor units.',
  'currency_code', 'Currency Checkout was told to charge, which the statement quoted.',
  'next_charge_on', 'The date the statement gave for the first charge.',
  'text_version', 'Version of the statement''s wording (RENEWAL_TERMS_VERSION in @xos/platform).',
  'locale', 'Language the statement was shown in.',
  'statement', 'The statement exactly as shown, with its price and dates filled in.',
  'initials', 'What the person typed to initial the terms. Required on an annual plan (Wisconsin 134.49).',
  'livemode', 'True for a live mode purchase.',
  'stripe_checkout_session_id', 'Checkout session the consent led to, set when Atlas records the session.',
  'confirmation_notified_at', 'When billing.purchase_confirmed went out for it.',
  'created_at', 'When the person agreed.'
]);

alter table private.billing_renewal_consents enable row level security;
revoke all on private.billing_renewal_consents from public, anon, authenticated;

create or replace function private.guard_billing_renewal_consent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if coalesce(current_setting('xos.billing_evidence_sweep', true), '') <> 'on' then
      perform private.refuse('renewal_consent_immutable', 'A renewal consent is evidence and cannot be deleted.');
    end if;
    return old;
  end if;
  if (to_jsonb(new) - 'stripe_checkout_session_id' - 'confirmation_notified_at' - 'consented_by')
     is distinct from (to_jsonb(old) - 'stripe_checkout_session_id' - 'confirmation_notified_at' - 'consented_by') then
    perform private.refuse('renewal_consent_immutable', 'A renewal consent is evidence and cannot be changed.');
  end if;
  return new;
end;
$$;

comment on function private.guard_billing_renewal_consent() is 'Keeps a renewal consent as it was written: only its Checkout session and confirmation time can be set, and a deleted account clears the person''s id. Only private.run_billing_evidence_retention deletes it, after 7 years.';
revoke all on function private.guard_billing_renewal_consent() from public, anon, authenticated;

create trigger t10_guard_consent before update or delete on private.billing_renewal_consents
  for each row execute function private.guard_billing_renewal_consent();

create table private.billing_renewal_reminders (
  id uuid primary key default private.uuid_v7(),
  subject_org_id uuid not null,
  stripe_subscription_id text not null,
  period_end timestamptz not null,
  amount_text text,
  sent_at timestamptz not null default now(),
  constraint billing_renewal_reminders_subscription_format check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$')
);

create unique index billing_renewal_reminders_key on private.billing_renewal_reminders (stripe_subscription_id, period_end);
create index billing_renewal_reminders_org_idx on private.billing_renewal_reminders (subject_org_id);

call private.describe('private.billing_renewal_reminders', 'Each reminder sent before an annual plan renews, once per subscription and period, kept as proof of notice past the org''s own deletion (ADR 0161).', array[
  'id', 'Reminder id.',
  'subject_org_id', 'Id the org had or has.',
  'stripe_subscription_id', 'Stripe subscription that renews.',
  'period_end', 'When the current term ends and the next charge falls.',
  'amount_text', 'The amount the reminder quoted.',
  'sent_at', 'When it was queued to the billing owners.'
]);

alter table private.billing_renewal_reminders enable row level security;
revoke all on private.billing_renewal_reminders from public, anon, authenticated;

-- Consent, before Stripe hears anything -------------------------------------------------------------------------------

create or replace function app.record_renewal_consent(
  p_org_id uuid,
  p_plan_code text,
  p_billing_interval app.billing_interval,
  p_amount_minor bigint,
  p_currency_code text,
  p_next_charge_on date,
  p_text_version text,
  p_locale text,
  p_statement text,
  p_initials text,
  p_livemode boolean
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_currency text := upper(coalesce(p_currency_code, ''));
  v_monthly bigint;
  v_id uuid;
begin
  if not private.has_capability(p_org_id, 'org.billing.manage') then
    raise exception using errcode = '42501', message = 'org.billing.manage is required';
  end if;
  if not exists (select 1 from private.plan_list_prices l where l.plan_code = p_plan_code and l.currency_code = 'USD' and l.monthly_minor > 0) then
    perform private.refuse('plan_not_self_serve', format('The %s plan cannot be bought through Checkout.', p_plan_code));
  end if;
  select l.monthly_minor into v_monthly from private.plan_list_prices l
  where l.plan_code = p_plan_code and l.currency_code = v_currency and l.monthly_minor > 0;
  -- An annual price is 10 times the monthly one (annual_multiplier in packages/schemas/plans.yaml).
  if v_monthly is null or p_amount_minor is distinct from (case p_billing_interval when 'Annual' then v_monthly * 10 else v_monthly end) then
    perform private.refuse('renewal_price_mismatch', 'The price shown is not the plan''s price. Reload the page and try again.');
  end if;
  if p_next_charge_on is null or p_next_charge_on < (now() at time zone 'UTC')::date - 1 or p_next_charge_on > (now() at time zone 'UTC')::date + 16 then
    perform private.refuse('renewal_date_range', 'The first charge is today or when the running trial ends.');
  end if;
  if p_billing_interval = 'Annual' and char_length(btrim(coalesce(p_initials, ''))) not between 1 and 12 then
    perform private.refuse('renewal_initials_required', 'Type your initials to agree to an annual renewal.');
  end if;
  if p_statement is null or char_length(p_statement) not between 1 and 2000 then
    perform private.refuse('renewal_statement_required', 'The renewal terms must be shown before you agree to them.');
  end if;
  if p_text_version is null or p_text_version !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    perform private.refuse('renewal_text_version', 'The renewal terms have no version.');
  end if;
  if p_locale is null or p_locale !~ '^[a-z]{2}-[A-Z]{2}$' then
    perform private.refuse('renewal_locale', 'The renewal terms were shown in an unknown language.');
  end if;
  insert into private.billing_renewal_consents (subject_org_id, org_name, consented_by, consented_by_email, plan_code, billing_interval,
    amount_minor, currency_code, next_charge_on, text_version, locale, statement, initials, livemode)
  select p_org_id, o.name, v_person, (select lower(u.email) from app.people p join auth.users u on u.id = p.user_id where p.id = v_person),
    p_plan_code, p_billing_interval, p_amount_minor, v_currency, p_next_charge_on, p_text_version, p_locale, p_statement, nullif(btrim(p_initials), ''), coalesce(p_livemode, false)
  from app.organizations o where o.id = p_org_id
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.record_renewal_consent(uuid, text, app.billing_interval, bigint, text, date, text, text, text, text, boolean) is 'Billing and Plan, once the Owner ticked the renewal terms and Atlas has run the checkout checks: records exactly what they agreed to (org.billing.manage, 42501 otherwise), in the currency Checkout will be told to charge. Refuses a price that is not the plan''s list price in that currency (renewal_price_mismatch), a first charge more than 16 days out (renewal_date_range), an annual plan with no initials (renewal_initials_required), and missing text. Returns the consent id.';
revoke all on function app.record_renewal_consent(uuid, text, app.billing_interval, bigint, text, date, text, text, text, text, boolean) from public, anon;
grant execute on function app.record_renewal_consent(uuid, text, app.billing_interval, bigint, text, date, text, text, text, text, boolean) to authenticated;

create or replace function private.tie_renewal_consent_to_checkout()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select c.id into v_id from private.billing_renewal_consents c
  where c.subject_org_id = new.org_id and c.plan_code = new.plan_code and c.billing_interval = new.billing_interval
    and c.livemode = new.livemode and c.stripe_checkout_session_id is null and c.created_at > now() - interval '2 hours'
  order by c.created_at desc limit 1
  for update;
  if v_id is not null then
    update private.billing_renewal_consents set stripe_checkout_session_id = new.stripe_checkout_session_id where id = v_id;
  elsif new.livemode then
    perform private.refuse('renewal_consent_required', 'Agree to the renewal terms before you pay.');
  end if;
  return new;
end;
$$;

comment on function private.tie_renewal_consent_to_checkout() is 'Before a Checkout session is recorded: ties it to the consent given for that org, plan and term in the last 2 hours. A live mode session without one is refused (renewal_consent_required), the database''s backstop behind Atlas.';
revoke all on function private.tie_renewal_consent_to_checkout() from public, anon, authenticated;

create trigger t30_tie_renewal_consent before insert on app.billing_checkouts
  for each row execute function private.tie_renewal_consent_to_checkout();

-- After purchase -------------------------------------------------------------------------------------------------------

create or replace function private.confirm_purchase_terms()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_consent private.billing_renewal_consents;
  v_period_end timestamptz;
  v_next date;
begin
  if new.checkout_state <> 'Completed' or old.checkout_state = 'Completed' then
    return null;
  end if;
  select c.* into v_consent from private.billing_renewal_consents c
  where c.stripe_checkout_session_id = new.stripe_checkout_session_id and c.confirmation_notified_at is null
  for update;
  if v_consent.id is null then
    return null;
  end if;
  update private.billing_renewal_consents set confirmation_notified_at = now() where id = v_consent.id;
  -- The next charge: what Stripe has said if its subscription has synced; else the first charge if it is still to come, as
  -- at the end of a carried trial; else a charge just made, so one term from now, counted in UTC as Stripe counts it.
  select l.current_period_end into v_period_end from app.stripe_subscription_links l
  where l.org_id = new.org_id and l.billing_interval = v_consent.billing_interval and l.livemode = v_consent.livemode
    and l.stripe_ended_at is null and l.deleted_at is null and l.created_at >= v_consent.created_at and l.current_period_end > now()
  order by l.created_at desc limit 1;
  v_next := case
    when v_period_end is not null then private.org_date(new.org_id, v_period_end)
    when v_consent.next_charge_on > private.org_date(new.org_id, v_consent.created_at) then v_consent.next_charge_on
    else private.org_date(new.org_id, ((now() at time zone 'UTC')
      + case v_consent.billing_interval when 'Annual' then interval '1 year' else interval '1 month' end) at time zone 'UTC')
  end;
  perform private.notify_billing_contacts(new.org_id, 'billing.purchase_confirmed', 'private.billing_renewal_consents', v_consent.id, jsonb_build_object(
    'plan', initcap(v_consent.plan_code),
    'term', v_consent.billing_interval,
    'price', private.billing_amount_text(v_consent.amount_minor, v_consent.currency_code),
    'nextChargeOn', private.org_day_mark(new.org_id, v_next)));
  return null;
end;
$$;

comment on function private.confirm_purchase_terms() is 'When Stripe reports a plan Checkout completed: sends the billing owners billing.purchase_confirmed with the terms the Owner agreed to and the next charge date, once. The next charge is the end of a carried trial, or one term after a charge made at purchase, never the day just charged.';
revoke all on function private.confirm_purchase_terms() from public, anon, authenticated;

create trigger t92_confirm_purchase after update of checkout_state on app.billing_checkouts
  for each row execute function private.confirm_purchase_terms();

-- Before an annual renewal ---------------------------------------------------------------------------------------------

create or replace function private.run_billing_renewal_reminders(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_due record;
  v_currency text;
  v_amount text;
  v_id uuid;
  v_count integer := 0;
begin
  for v_due in
    select l.id, l.org_id, l.stripe_subscription_id, l.current_period_end, l.recurring_amount_minor, l.currency_code, s.plan_code
    from app.stripe_subscription_links l
    join app.subscriptions s on s.id = l.subscription_id and s.subscription_state <> 'canceled' and s.deleted_at is null
    where l.billing_interval = 'Annual' and l.deleted_at is null and l.stripe_ended_at is null and l.cancel_at is null
      and l.current_period_end > p_now and l.current_period_end <= p_now + interval '30 days'
      -- The first term of a trial that just ended a purchase: the confirmation gave these terms days ago.
      and l.created_at <= p_now - interval '30 days'
      -- Asked to stop, or accepted before the webhook set cancel_at: this plan does not renew. A withdrawn cancel does not count.
      and not exists (select 1 from private.stripe_cancellations c
                      where c.stripe_subscription_id = l.stripe_subscription_id and c.cancellation_state in ('Queued', 'Accepted'))
      and not exists (select 1 from private.billing_renewal_reminders r
                      where r.stripe_subscription_id = l.stripe_subscription_id and r.period_end = l.current_period_end)
  loop
    -- What Stripe says it charges, or the plan's list price in the subscription's own currency.
    v_currency := coalesce(v_due.currency_code, 'USD');
    v_amount := case when v_due.recurring_amount_minor is not null
      then private.billing_amount_text(v_due.recurring_amount_minor, v_currency)
      else (select private.billing_amount_text(p.monthly_minor * 10, v_currency) from private.plan_list_prices p
            where p.plan_code = v_due.plan_code and p.currency_code = v_currency) end;
    insert into private.billing_renewal_reminders (subject_org_id, stripe_subscription_id, period_end, amount_text)
    values (v_due.org_id, v_due.stripe_subscription_id, v_due.current_period_end, v_amount)
    returning id into v_id;
    perform private.notify_billing_contacts(v_due.org_id, 'billing.renewal_reminder', 'private.billing_renewal_reminders', v_id, jsonb_build_object(
      'plan', initcap(v_due.plan_code),
      'price', coalesce(v_amount, ''),
      'renewsOn', private.org_day_mark(v_due.org_id, private.org_date(v_due.org_id, v_due.current_period_end))));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function private.run_billing_renewal_reminders(timestamptz) is 'Daily: reminds the billing owners of each annual plan 30 days before it renews (billing.renewal_reminder), once per subscription and term, with the amount, the date and how to cancel. Skips a plan already ending or whose cancel is queued or accepted, and the first term of a subscription less than 30 days old, whose purchase confirmation just gave the same terms. Returns how many.';
revoke all on function private.run_billing_renewal_reminders(timestamptz) from public, anon, authenticated;

select cron.schedule('xos_daily_billing_renewal_reminders', '20 14 * * *', 'select private.run_billing_renewal_reminders()');

-- Retention ----------------------------------------------------------------------------------------------------------

-- private.retention_policies covers app tables, so this evidence has its own sweep. Seven years matches the other billing
-- evidence (0560, 1640) and covers California's proof of consent, 3 years or 1 year after the contract ends.
create or replace function private.run_billing_evidence_retention(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cutoff timestamptz := p_now - interval '7 years';
  v_rows integer;
  v_total integer := 0;
begin
  delete from private.stripe_cancellations c where c.created_at < v_cutoff and c.cancellation_state <> 'Queued';
  get diagnostics v_rows = row_count;
  v_total := v_total + v_rows;
  delete from private.billing_alerts a where a.raised_at < v_cutoff and a.resolved_at is not null;
  get diagnostics v_rows = row_count;
  v_total := v_total + v_rows;
  perform set_config('xos.billing_evidence_sweep', 'on', true);
  delete from private.billing_renewal_consents c where c.created_at < v_cutoff;
  get diagnostics v_rows = row_count;
  v_total := v_total + v_rows;
  perform set_config('xos.billing_evidence_sweep', 'off', true);
  delete from private.billing_renewal_reminders r where r.sent_at < v_cutoff;
  get diagnostics v_rows = row_count;
  return v_total + v_rows;
end;
$$;

comment on function private.run_billing_evidence_retention(timestamptz) is 'Weekly: deletes billing evidence older than 7 years (Stripe cancels settled by then, resolved alerts, renewal consents and reminders). Returns the rows deleted.';
revoke all on function private.run_billing_evidence_retention(timestamptz) from public, anon, authenticated;

select cron.schedule('xos_weekly_billing_evidence_retention', '40 3 * * 0', 'select private.run_billing_evidence_retention()');
