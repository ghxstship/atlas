-- 1350_org_trials.sql
-- A79 (RRR-124), finding A65-015, Section 14.7: "Trial: 14 days with Pro features, no card required. At the end of the
-- trial the org moves to the Access plan; no data is deleted."
--   * app.subscriptions.trial_ends_at: when a trialing subscription ends. A new org (app.create_organization) and an
--     external account that starts using Atlas (app.subscribe_external_account) start a 14-day Pro trial instead of
--     the Access plan. A client org a partner creates keeps the plan the partner sets.
--   * The org's calendar: the trial covers the rest of the day it starts and 14 whole days on the org's calendar
--     (locale.time_zone, private.org_today of 1305) and ends at the org's midnight (private.org_window_end). The
--     countdown is its last day minus the org's today: 14 when it starts and 0 on its last day.
--   * Conversion: a card is added only through Stripe Checkout. Its webhook calls app.sync_subscription_from_stripe,
--     which moves the trialing subscription to active on the plan bought (trialing to active is an allowed
--     transition). Checkout carries the rest of the trial as the Stripe trial end, so Stripe charges the card when
--     the trial would have ended and never before (@xos/platform createCheckoutSession, trialEnd).
--   * Expiry: private.run_org_lifecycle runs hourly. A trial past its end moves to the Access plan in place
--     (trialing to active, plan access, no extra seats), and each billing owner is told. Nothing calls Stripe, so a
--     trial never charges anyone.
--   * Notices: billing owners hear 3 days and 1 day before the last day (billing.trial_ending, once per mark) and when it
--     ends (billing.trial_ended). Atlas shows the countdown in the org banner.

-- Trial end ------------------------------------------------------------------------------------------------------

alter table app.subscriptions
  add column trial_ends_at timestamptz,
  add constraint subscriptions_trial_end check (subscription_state <> 'trialing' or trial_ends_at is not null);

comment on column app.subscriptions.trial_ends_at is 'When the trial of this subscription ends (Section 14.7): set while it is trialing and kept as history after it converts or moves to Access. Written only by private.start_trial.';

create index subscriptions_trial_due_idx on app.subscriptions (trial_ends_at) where subscription_state = 'trialing';

-- Windows of whole days on the org's calendar ----------------------------------------------------------------------
-- The trial, the recovery window of a deletion request and an ownership offer last whole days on the org's calendar
-- (its locale.time_zone setting, private.org_today in 1305), never UTC days: each ends at midnight where the org is,
-- after the rest of the day it starts on and its whole days, so it is never shorter than its length.

create or replace function private.zone_day_start(p_day date, p_time_zone text)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
begin
  return p_day::timestamp at time zone coalesce(nullif(btrim(p_time_zone), ''), 'UTC');
exception when invalid_parameter_value then
  return p_day::timestamp at time zone 'UTC';
end;
$$;

comment on function private.zone_day_start(date, text) is 'The instant a calendar day starts in an IANA time zone; UTC for a blank or unknown zone (A79, beside private.zone_date of 1305).';
revoke all on function private.zone_day_start(date, text) from public, anon, authenticated;

create or replace function private.org_date(p_org_id uuid, p_at timestamptz)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select private.zone_date(p_at, private.org_time_zone(p_org_id));
$$;

comment on function private.org_date(uuid, timestamptz) is 'The calendar date of an instant on the org''s calendar (private.org_time_zone); private.org_today is the same for now (A79).';
revoke all on function private.org_date(uuid, timestamptz) from public, anon, authenticated;

create or replace function private.org_window_end(p_org_id uuid, p_days integer, p_now timestamptz default now())
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select private.zone_day_start(private.org_date(p_org_id, p_now) + p_days + 1, private.org_time_zone(p_org_id));
$$;

comment on function private.org_window_end(uuid, integer, timestamptz) is 'The end of a window of p_days whole days that starts at p_now: midnight on the org''s calendar after the p_days-th day after the day p_now falls on. The window covers the rest of that day and p_days whole days, so it is never shorter than p_days days (A79).';
revoke all on function private.org_window_end(uuid, integer, timestamptz) from public, anon, authenticated;

create or replace function private.org_window_last_day(p_org_id uuid, p_ends_at timestamptz)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select private.org_date(p_org_id, p_ends_at - interval '1 microsecond');
$$;

comment on function private.org_window_last_day(uuid, timestamptz) is 'The last day on the org''s calendar inside a window ending at p_ends_at: the day before it ends when it ends at the org''s midnight (A79).';
revoke all on function private.org_window_last_day(uuid, timestamptz) from public, anon, authenticated;

create or replace function private.org_day_mark(p_org_id uuid, p_day date)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select (extract(epoch from private.zone_day_start(p_day, private.org_time_zone(p_org_id)) + interval '12 hours') * 1000)::bigint;
$$;

comment on function private.org_day_mark(uuid, date) is 'A day on the org''s calendar as the form a notification carries a date in: epoch milliseconds at the org''s noon that day. The recipient''s time zone formats it, and noon keeps the date for recipients up to 12 hours from the org (A79).';
revoke all on function private.org_day_mark(uuid, date) from public, anon, authenticated;

create or replace function private.trial_days()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 14;
$$;

comment on function private.trial_days() is 'Length of the trial a new org starts with: 14 whole days on the org''s calendar after the day it starts (Section 14.7, private.org_window_end).';
revoke all on function private.trial_days() from public, anon, authenticated;

create or replace function private.trial_days_left(p_org_id uuid, p_ends_at timestamptz, p_now timestamptz default now())
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(0, private.org_window_last_day(p_org_id, p_ends_at) - private.org_date(p_org_id, p_now));
$$;

comment on function private.trial_days_left(uuid, timestamptz, timestamptz) is 'Whole days left in a trial on the org''s calendar: its last day minus today, 14 on the day it starts and 0 on its last day (Section 14.7).';
revoke all on function private.trial_days_left(uuid, timestamptz, timestamptz) from public, anon, authenticated;

create or replace function private.trial_plan()
returns text
language sql
immutable
set search_path = ''
as $$
  select 'pro'::text;
$$;

comment on function private.trial_plan() is 'Plan whose features a trial gives: Pro (Section 14.7).';
revoke all on function private.trial_plan() from public, anon, authenticated;

create or replace function private.start_trial(p_org_id uuid, p_plan_code text, p_ends_at timestamptz, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_subscription uuid;
begin
  if not exists (select 1 from app.plans p where p.code = p_plan_code) then
    perform private.refuse('plan_unknown', format('%s is not a plan.', p_plan_code));
  end if;
  insert into app.subscriptions (org_id, plan_code, subscription_state, trial_ends_at)
  values (p_org_id, p_plan_code, 'trialing', p_ends_at)
  returning id into v_subscription;
  insert into app.subscription_state_transitions (subscription_id, from_state, to_state, reason)
  values (v_subscription, null, 'trialing', p_reason);
  return v_subscription;
end;
$$;

comment on function private.start_trial(uuid, text, timestamptz, text) is 'Starts a trialing subscription on a plan until a time and logs the creation entry. No card and no Stripe subscription exist yet, so nothing can be charged (Section 14.7).';
revoke all on function private.start_trial(uuid, text, timestamptz, text) from public, anon, authenticated;

-- New orgs start the trial ----------------------------------------------------------------------------------------

create or replace function app.create_organization(p_name text, p_slug text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_org uuid;
  v_membership uuid;
begin
  perform private.assert_org_slug_available(p_slug);
  insert into app.organizations (name, slug) values (btrim(p_name), p_slug) returning id into v_org;
  perform private.start_trial(v_org, private.trial_plan(), private.org_window_end(v_org, private.trial_days()),
    'Organization created: a 14-day Pro trial with no card.');

  perform private.begin_trusted_operation('membership_write');
  insert into app.memberships (org_id, person_id) values (v_org, v_person) returning id into v_membership;
  insert into app.membership_roles (membership_id, role_id, granted_by)
  values (v_membership, private.system_role_id('owner'), null);
  perform private.end_trusted_operation('membership_write');
  return v_org;
end;
$$;

comment on function app.create_organization(text, text) is 'Creates an organization with the signed-in person as its Owner, in one transaction. It starts a 14-day Pro trial with no card and moves to the Access plan when the trial ends unless a card is added (Section 14.7). Returns the org id.';

create or replace function app.subscribe_external_account(p_account_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
begin
  if p_account_id is null
     or p_account_id not in (select private.my_account_ids(array['Account Owner']::app.account_role[])) then
    raise exception using errcode = '42501', message = 'only the account''s Account Owner subscribes it';
  end if;
  perform 1 from app.organizations o where o.id = p_account_id and o.deleted_at is null for update;
  if exists (select 1 from app.subscriptions s where s.org_id = p_account_id and s.deleted_at is null) then
    perform private.refuse('account_already_subscribed', 'This company already uses Atlas; open it from the organization switcher.');
  end if;
  perform private.start_trial(p_account_id, private.trial_plan(), private.org_window_end(p_account_id, private.trial_days()),
    'External account started using Atlas: a 14-day Pro trial with no card.');

  perform private.begin_trusted_operation('membership_write');
  with m as (
    insert into app.memberships (org_id, person_id) values (p_account_id, v_person) returning id
  )
  insert into app.membership_roles (membership_id, role_id, granted_by)
  select m.id, private.system_role_id('owner'), null from m;
  perform private.end_trusted_operation('membership_write');
  return p_account_id;
end;
$$;

comment on function app.subscribe_external_account(uuid) is 'Journey 60: the Account Owner of an external account starts using Atlas with it. Starts a 14-day Pro trial with no card (Section 14.7) and makes the caller the Owner of the same organization row, so its profile, ratings, engagements and counterparty history carry over with no duplicate. Refuses account_already_subscribed (XR001) for an org that already subscribes; anyone but an Account Owner gets 42501.';

-- Notices ------------------------------------------------------------------------------------------------------------

insert into private.notification_templates (kind, channel, category_code, email_template_code)
select k.kind, c.channel, 'account', case when c.channel = 'Email' then 'notification' end
from (values ('billing.trial_ending'), ('billing.trial_ended')) as k (kind)
cross join (values ('In App'::app.notification_channel), ('Email'), ('SMS'), ('Push')) as c (channel);

create or replace function private.epoch_ms(p_at timestamptz)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select (extract(epoch from p_at) * 1000)::bigint;
$$;

comment on function private.epoch_ms(timestamptz) is 'A moment as Unix epoch milliseconds: the form notification message arguments carry dates in, which the email copy formats as ICU dates in the recipient''s language.';
revoke all on function private.epoch_ms(timestamptz) from public, anon, authenticated;

create or replace function private.billing_owner_ids(p_org_id uuid, p_now timestamptz default now())
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct m.person_id from app.memberships m
  where m.org_id = p_org_id and m.deleted_at is null and m.valid_from <= p_now and (m.valid_to is null or m.valid_to > p_now)
    and private.person_capability_reach(m.person_id, p_org_id, 'org.billing.read', false) = 'organization';
$$;

comment on function private.billing_owner_ids(uuid, timestamptz) is 'Active members who hold org.billing.read org-wide: the people billing and lifecycle notices go to.';
revoke all on function private.billing_owner_ids(uuid, timestamptz) from public, anon, authenticated;

-- Expiry ---------------------------------------------------------------------------------------------------------------

create or replace function private.expire_trial(p_subscription_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sub app.subscriptions;
  v_person uuid;
begin
  select * into v_sub from app.subscriptions s
  where s.id = p_subscription_id and s.subscription_state = 'trialing' and s.deleted_at is null for update;
  if v_sub.id is null then
    perform private.refuse('trial_not_running', 'The subscription is not in a trial.');
  end if;
  update app.subscriptions set plan_code = 'access', extra_seats = 0 where id = v_sub.id;
  perform private.transition_subscription(v_sub.id, 'trialing', 'active',
    format('The %s trial ended with no card; the org moved to the Access plan. No data was deleted.', v_sub.plan_code));
  for v_person in select private.billing_owner_ids(v_sub.org_id) loop
    perform private.notify(v_sub.org_id, v_person, 'billing.trial_ended', 'app.subscriptions', v_sub.id, null,
      jsonb_build_object('plan', v_sub.plan_code));
  end loop;
end;
$$;

comment on function private.expire_trial(uuid) is 'Ends a trial with no card (Section 14.7): the subscription stays, moves to the Access plan with no extra seats and becomes active, and every billing owner is told. Downgrades never delete data. Nothing calls Stripe.';
revoke all on function private.expire_trial(uuid) from public, anon, authenticated;

create or replace function private.run_trials(p_now timestamptz default now())
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
    select s.id, s.org_id, s.plan_code, s.trial_ends_at from app.subscriptions s
    where s.subscription_state = 'trialing' and s.deleted_at is null
    order by s.trial_ends_at
  loop
    if v_sub.trial_ends_at <= p_now then
      perform private.expire_trial(v_sub.id);
      v_actions := v_actions + 1;
      continue;
    end if;
    v_days := private.trial_days_left(v_sub.org_id, v_sub.trial_ends_at, p_now);
    if v_days in (3, 1) then
      for v_person in
        select b.person_id from private.billing_owner_ids(v_sub.org_id, p_now) as b (person_id)
        where not exists (
          select 1 from app.notifications n
          where n.recipient_person_id = b.person_id and n.kind = 'billing.trial_ending' and n.subject_id = v_sub.id
            and n.message_args ->> 'days' = v_days::text)
      loop
        perform private.notify(v_sub.org_id, v_person, 'billing.trial_ending', 'app.subscriptions', v_sub.id, null,
          jsonb_build_object('days', v_days, 'plan', v_sub.plan_code, 'ends_at', private.epoch_ms(v_sub.trial_ends_at)));
        v_actions := v_actions + 1;
      end loop;
    end if;
  end loop;
  return v_actions;
end;
$$;

comment on function private.run_trials(timestamptz) is 'Trial step of the lifecycle job: ends every trial past its end (private.expire_trial) and tells billing owners 3 days and 1 day before the trial''s last day on the org''s calendar, once per mark. Returns the actions taken.';
revoke all on function private.run_trials(timestamptz) from public, anon, authenticated;

create or replace function private.run_org_lifecycle(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  return private.run_trials(p_now);
end;
$$;

comment on function private.run_org_lifecycle(timestamptz) is 'Hourly org lifecycle job (Section 14.7): trials. Later A79 migrations add the steps of deletion, ownership transfers and white label. Returns the actions taken.';
revoke all on function private.run_org_lifecycle(timestamptz) from public, anon, authenticated;

select cron.schedule('xos_hourly_org_lifecycle', '23 * * * *', 'select private.run_org_lifecycle()');

-- Countdown --------------------------------------------------------------------------------------------------------

create or replace function app.org_trial(p_org_id uuid)
returns table (plan_code text, trial_ends_at timestamptz, days_left integer)
language sql
stable
security definer
set search_path = ''
as $$
  select s.plan_code, s.trial_ends_at, private.trial_days_left(s.org_id, s.trial_ends_at)
  from app.subscriptions s
  where s.org_id = p_org_id and s.subscription_state = 'trialing' and s.deleted_at is null
    and p_org_id in (select private.my_org_ids());
$$;

comment on function app.org_trial(uuid) is 'The org''s running trial for its members: the plan it gives, when it ends and whole days left on the org''s calendar (0 on its last day), or no row when the org is not in a trial (Section 14.7). Atlas shows the countdown from it.';
revoke all on function app.org_trial(uuid) from public, anon;
grant execute on function app.org_trial(uuid) to authenticated, service_role;
