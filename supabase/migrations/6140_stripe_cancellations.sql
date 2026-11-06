-- 6140_stripe_cancellations.sql
-- Legal billing issue 1 (RRR-248, audit finding M1, ADR 0161). Canceling or deleting an organization in XOS changed only the
-- database, so Stripe kept charging. XOS now owns the stop: every way an org ends queues the cancel of its Stripe
-- subscriptions in the same transaction, and the org cannot finish deletion until Stripe has accepted it.
--   * private.stripe_cancellations: one row per cancel XOS must get accepted, Queued until Stripe accepts it. It keeps no
--     org_id, like app.deletion_certificates, so the record outlives the tenant purge. Its id gives the idempotency key.
--   * Triggers on app.org_cancellations and app.org_deletion_requests queue the row, so the Danger zone, the REST API and
--     anything added later all stop Stripe the same way. Nothing calls Stripe from here.
--   * Only the service role moves a cancel out of Queued: the org-lifecycle worker (app.claim_stripe_cancellations, then
--     app.finish_stripe_cancellation) with retries that back off and never give up, or the signed webhook
--     (app.reconcile_stripe_subscription, app.note_stripe_subscription_terms). Atlas also calls Stripe at once for the
--     person waiting, but cannot record the outcome, so an Owner cannot mark a cancel accepted through the REST API.
--   * app.reconcile_stripe_subscription runs before the subscription sync. A subscription Stripe says is live on a purged
--     org, on an org being canceled or deleted, or after an accepted cancel, never creates a subscription again: it is
--     queued for cancel and raises a billing alert.
--   * private.billing_alerts: what the platform owner must look at. The worker emails each one and logs it for Sentry, and
--     the console lists the open ones. It also survives the purge.
--   * app.request_plan_end: ending a paid plan from Billing and Plan, online and with no second factor, as easy as buying.
--     It sets cancel_at_period_end, and the plan runs to the end of the period paid for.
-- Refunds follow Terms 5.10: no refund for unused time unless the law requires it. Nothing here refunds; a charge that
-- lands after a cancel raises an alert for the owner to refund by hand.

-- The states ---------------------------------------------------------------------------------------------------------

create type app.stripe_cancel_mode as enum ('Immediately', 'At Period End');
comment on type app.stripe_cancel_mode is 'How a Stripe subscription is stopped: at once with no proration, when the org is canceled or deleted; or at the end of the period paid for, when the Owner ends a paid plan.';

create type app.stripe_cancel_source as enum ('Organization Canceled', 'Organization Deleted', 'Plan Ended', 'Stripe Portal', 'Reconciliation');
comment on type app.stripe_cancel_source is 'Why XOS asked Stripe to stop: the org was canceled, the org is being deleted, the Owner ended the plan in Billing and Plan, the Owner did so in the Stripe portal (recorded from the webhook), or reconciliation found a subscription Stripe still calls live, or that ended in Stripe without XOS asking.';

create type app.stripe_cancellation_state as enum ('Queued', 'Accepted', 'Withdrawn');
comment on type app.stripe_cancellation_state is 'Where a Stripe cancel stands: Queued until Stripe accepts it, Accepted once it did, Withdrawn when the customer undid a cancel at period end in the Stripe portal.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('stripe_cancellation', 'Queued', 'Accepted'),
  ('stripe_cancellation', 'Queued', 'Withdrawn'),
  ('stripe_cancellation', 'Accepted', 'Queued'),
  ('stripe_cancellation', 'Accepted', 'Withdrawn');

-- What the link knows ------------------------------------------------------------------------------------------------

alter table app.stripe_subscription_links
  add column stripe_ended_at timestamptz,
  add column cancel_at timestamptz,
  add column terms_event_at timestamptz,
  add column recurring_amount_minor bigint,
  add column currency_code text,
  add constraint stripe_subscription_links_amount_nonnegative check (recurring_amount_minor is null or recurring_amount_minor >= 0),
  add constraint stripe_subscription_links_currency_format check (currency_code is null or currency_code ~ '^[A-Z]{3}$');

comment on column app.stripe_subscription_links.stripe_ended_at is 'When Stripe reported the subscription ended. Null while it can still charge.';
comment on column app.stripe_subscription_links.cancel_at is 'When Stripe will end the subscription because a cancel at period end was accepted. Null while it renews.';
comment on column app.stripe_subscription_links.terms_event_at is 'Created time of the Stripe event that last set cancel_at and the recurring amount. Stripe does not order its events, so an older one changes nothing.';
comment on column app.stripe_subscription_links.recurring_amount_minor is 'What Stripe charges each period, before tax, in minor units of currency_code. Renewal notices quote it.';
comment on column app.stripe_subscription_links.currency_code is 'Currency of recurring_amount_minor, as an upper-case ISO 4217 code.';

-- The cancels --------------------------------------------------------------------------------------------------------

create table private.stripe_cancellations (
  id uuid primary key default private.uuid_v7(),
  subject_org_id uuid not null,
  org_name text,
  stripe_subscription_id text not null,
  stripe_customer_id text,
  livemode boolean not null,
  cancel_mode app.stripe_cancel_mode not null,
  source app.stripe_cancel_source not null,
  cancellation_state app.stripe_cancellation_state not null default 'Queued',
  requested_by uuid references app.people (id) on delete set null,
  requested_at timestamptz not null default now(),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  last_error text,
  accepted_at timestamptz,
  accepted_via text,
  stripe_status text,
  delay_notified_at timestamptz,
  confirmation_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stripe_cancellations_subscription_format check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  constraint stripe_cancellations_lock_pair check ((locked_by is null) = (locked_at is null)),
  constraint stripe_cancellations_accepted_pair check ((cancellation_state = 'Queued') = (accepted_at is null) or cancellation_state = 'Withdrawn'),
  constraint stripe_cancellations_accepted_via check (accepted_via is null or accepted_via in ('Worker', 'Webhook')),
  constraint stripe_cancellations_text_lengths check (
    (org_name is null or char_length(org_name) <= 300)
    and (last_error is null or char_length(last_error) <= 2000)
    and (locked_by is null or char_length(locked_by) <= 200)
    and (stripe_status is null or char_length(stripe_status) <= 100))
);

create unique index stripe_cancellations_open_key on private.stripe_cancellations (stripe_subscription_id, cancel_mode)
  where cancellation_state = 'Queued';
create index stripe_cancellations_due_idx on private.stripe_cancellations (next_attempt_at) where cancellation_state = 'Queued';
create index stripe_cancellations_org_idx on private.stripe_cancellations (subject_org_id);
create index stripe_cancellations_subscription_idx on private.stripe_cancellations (stripe_subscription_id);
create index stripe_cancellations_requested_by_idx on private.stripe_cancellations (requested_by);

call private.describe('private.stripe_cancellations', 'Every cancel of a Stripe subscription XOS must get accepted (ADR 0161). Written by the triggers on org cancellation and deletion, by app.request_plan_end and by reconciliation; moved only by the service role. subject_org_id has no foreign key, so the record outlives the org it names, as app.deletion_certificates does.', array[
  'id', 'Cancel id. The idempotency key of each attempt is built from it.',
  'subject_org_id', 'Id the org had or has. No foreign key: the tenant purge leaves this record.',
  'org_name', 'Name of the org when the cancel was queued.',
  'stripe_subscription_id', 'Stripe subscription (sub_...) to stop.',
  'stripe_customer_id', 'Stripe customer (cus_...), when known.',
  'livemode', 'True for a live mode subscription.',
  'cancel_mode', 'Immediately or At Period End.',
  'source', 'Why XOS asked Stripe to stop.',
  'cancellation_state', 'Queued, Accepted or Withdrawn. private.guard_stripe_cancellation_state allows only the moves in private.lifecycle_transition_rules.',
  'requested_by', 'Person who asked, or null for a platform process or a person since deleted.',
  'requested_at', 'When XOS took the request.',
  'attempts', 'Calls the worker has claimed so far.',
  'next_attempt_at', 'When the worker may try next.',
  'locked_by', 'Worker holding the row during a call.',
  'locked_at', 'When the worker claimed it; a claim older than 10 minutes can be taken again.',
  'last_error', 'Error of the latest failed attempt.',
  'accepted_at', 'When Stripe accepted the cancel.',
  'accepted_via', 'Worker (the API call) or Webhook (a signed Stripe event).',
  'stripe_status', 'What Stripe reported: its subscription status, missing for an id it no longer has, or test_mode for a test subscription closed under a live key.',
  'delay_notified_at', 'When the billing owners and the platform owner were told Stripe had not accepted it yet. Sent once.',
  'confirmation_notified_at', 'When the billing owners were sent the confirmation. Sent once.',
  'created_at', 'When the row was inserted.',
  'updated_at', 'When the row last changed.'
]);

revoke all on private.stripe_cancellations from public, anon, authenticated;

create or replace function private.guard_stripe_cancellation_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  if new.cancellation_state is distinct from old.cancellation_state and not exists (
    select 1 from private.lifecycle_transition_rules r
    where r.lifecycle = 'stripe_cancellation' and r.from_state = old.cancellation_state::text and r.to_state = new.cancellation_state::text
  ) then
    perform private.refuse('stripe_cancellation_transition_not_allowed',
      format('A Stripe cancellation cannot move from %s to %s.', old.cancellation_state, new.cancellation_state));
  end if;
  return new;
end;
$$;

comment on function private.guard_stripe_cancellation_state() is 'Refuses a move of a Stripe cancel that private.lifecycle_transition_rules does not list (stripe_cancellation_transition_not_allowed), and stamps updated_at.';
revoke all on function private.guard_stripe_cancellation_state() from public, anon, authenticated;

create trigger t10_guard_state before update on private.stripe_cancellations
  for each row execute function private.guard_stripe_cancellation_state();

create table private.stripe_cancellation_attempts (
  id uuid primary key default private.uuid_v7(),
  cancellation_id uuid not null references private.stripe_cancellations (id) on delete cascade,
  attempted_at timestamptz not null default now(),
  via text not null,
  accepted boolean not null,
  stripe_status text,
  error text,
  constraint stripe_cancellation_attempts_via check (via in ('Worker', 'Webhook')),
  constraint stripe_cancellation_attempts_lengths check (
    (stripe_status is null or char_length(stripe_status) <= 100) and (error is null or char_length(error) <= 2000))
);

create index stripe_cancellation_attempts_cancellation_idx on private.stripe_cancellation_attempts (cancellation_id, attempted_at);

call private.describe('private.stripe_cancellation_attempts', 'What happened each time XOS tried to stop a Stripe subscription, kept with the cancel as evidence: the worker''s calls and the signed webhook events that settled it.', array[
  'id', 'Attempt id.',
  'cancellation_id', 'The cancel it belongs to.',
  'attempted_at', 'When the attempt finished.',
  'via', 'Worker or Webhook.',
  'accepted', 'True when Stripe accepted the cancel.',
  'stripe_status', 'What Stripe reported.',
  'error', 'Why the attempt failed.'
]);

revoke all on private.stripe_cancellation_attempts from public, anon, authenticated;

-- Billing alerts -----------------------------------------------------------------------------------------------------

create table private.billing_alerts (
  id uuid primary key default private.uuid_v7(),
  alert_kind text not null,
  dedupe_key text not null,
  subject_org_id uuid,
  stripe_subscription_id text,
  detail text not null,
  raised_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  occurrences integer not null default 1,
  sent_at timestamptz,
  resolved_at timestamptz,
  constraint billing_alerts_kind check (alert_kind in ('cancel_delayed', 'active_on_deleted_org', 'active_after_cancel', 'charged_after_cancel', 'deletion_blocked')),
  constraint billing_alerts_detail_length check (char_length(detail) between 1 and 2000)
);

create unique index billing_alerts_open_key on private.billing_alerts (dedupe_key) where resolved_at is null;
create index billing_alerts_unsent_idx on private.billing_alerts (raised_at) where sent_at is null and resolved_at is null;

call private.describe('private.billing_alerts', 'What the platform owner must look at about Stripe billing (ADR 0161): a cancel Stripe has not accepted, a subscription Stripe calls live on a deleted or canceled org, a charge after a cancel, a deletion waiting on Stripe. Open alerts are unique by dedupe_key, and a repeat counts up. Survives the tenant purge.', array[
  'id', 'Alert id.',
  'alert_kind', 'cancel_delayed, active_on_deleted_org, active_after_cancel, charged_after_cancel or deletion_blocked.',
  'dedupe_key', 'What makes it the same alert: its kind and its subscription, org or invoice.',
  'subject_org_id', 'Id the org had or has. No foreign key.',
  'stripe_subscription_id', 'Stripe subscription it concerns, when one does.',
  'detail', 'What happened, in plain words, for the owner.',
  'raised_at', 'When it was first raised.',
  'last_seen_at', 'When it was last raised again.',
  'occurrences', 'How many times it has been raised.',
  'sent_at', 'When the worker emailed it to the platform owner.',
  'resolved_at', 'When the cause cleared, or the owner closed it.'
]);

revoke all on private.billing_alerts from public, anon, authenticated;

-- Helpers ------------------------------------------------------------------------------------------------------------

create or replace function private.raise_billing_alert(p_kind text, p_dedupe_key text, p_org_id uuid, p_subscription text, p_detail text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into private.billing_alerts (alert_kind, dedupe_key, subject_org_id, stripe_subscription_id, detail)
  values (p_kind, p_dedupe_key, p_org_id, p_subscription, left(p_detail, 2000))
  on conflict (dedupe_key) where resolved_at is null
  do update set last_seen_at = now(), occurrences = private.billing_alerts.occurrences + 1, detail = excluded.detail
  returning id into v_id;
  return v_id;
end;
$$;

comment on function private.raise_billing_alert(text, text, uuid, text, text) is 'Raises a billing alert for the platform owner, or counts up the open one with the same key.';
revoke all on function private.raise_billing_alert(text, text, uuid, text, text) from public, anon, authenticated;

create or replace function private.notify_billing_contacts(p_org_id uuid, p_kind text, p_subject_table text, p_subject_id uuid, p_args jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid;
begin
  -- Billing owners as private.run_dunning (0560) chooses them. Nobody to tell once the org is gone.
  for v_person in
    select distinct m.person_id from app.memberships m
    where m.org_id = p_org_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
      and private.person_capability_reach(m.person_id, p_org_id, 'org.billing.read', false) = 'organization'
  loop
    perform private.notify(p_org_id, v_person, p_kind, p_subject_table, p_subject_id, null, coalesce(p_args, '{}'::jsonb));
  end loop;
end;
$$;

comment on function private.notify_billing_contacts(uuid, text, text, uuid, jsonb) is 'Notifies every billing owner of the org about a billing record, such as a Stripe cancel.';
revoke all on function private.notify_billing_contacts(uuid, text, text, uuid, jsonb) from public, anon, authenticated;

create or replace function private.billing_amount_text(p_minor bigint, p_currency text)
returns text
language sql
immutable
set search_path = ''
as $$
  select to_char(p_minor / 100.0, 'FM999,999,990.00') || ' ' || p_currency;
$$;

comment on function private.billing_amount_text(bigint, text) is 'An amount as a billing notice quotes it, such as 1,490.00 USD. Notices carry it already worded, so every language shows the amount Stripe charges and its currency code.';
revoke all on function private.billing_amount_text(bigint, text) from public, anon, authenticated;

create or replace function private.stripe_plan_label(p_subscription text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select initcap(s.plan_code) from app.stripe_subscription_links l
  join app.subscriptions s on s.id = l.subscription_id
  where l.stripe_subscription_id = p_subscription;
$$;

comment on function private.stripe_plan_label(text) is 'The plan a Stripe subscription pays for, as a notice names it: the plan code capitalized, which is its name in every language.';
revoke all on function private.stripe_plan_label(text) from public, anon, authenticated;

create or replace function private.queue_stripe_cancellation(
  p_org_id uuid,
  p_subscription text,
  p_customer text,
  p_livemode boolean,
  p_mode app.stripe_cancel_mode,
  p_source app.stripe_cancel_source,
  p_person uuid
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
  -- One live cancel per subscription and mode: one still queued, or one Stripe accepted.
  select c.id into v_id from private.stripe_cancellations c
  where c.stripe_subscription_id = p_subscription and c.cancel_mode = p_mode and c.cancellation_state in ('Queued', 'Accepted')
  order by c.created_at desc limit 1;
  if v_id is not null then
    return v_id;
  end if;
  insert into private.stripe_cancellations (subject_org_id, org_name, stripe_subscription_id, stripe_customer_id, livemode, cancel_mode, source, requested_by)
  values (p_org_id, (select o.name from app.organizations o where o.id = p_org_id), p_subscription, p_customer, p_livemode, p_mode, p_source, p_person)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function private.queue_stripe_cancellation(uuid, text, text, boolean, app.stripe_cancel_mode, app.stripe_cancel_source, uuid) is 'Queues a cancel of a Stripe subscription once: returns the cancel already queued or accepted for that subscription and mode, or a new one.';
revoke all on function private.queue_stripe_cancellation(uuid, text, text, boolean, app.stripe_cancel_mode, app.stripe_cancel_source, uuid) from public, anon, authenticated;

create or replace function private.queue_org_stripe_cancellations(p_org_id uuid, p_source app.stripe_cancel_source, p_person uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_link app.stripe_subscription_links;
  v_count integer := 0;
begin
  for v_link in
    select l.* from app.stripe_subscription_links l
    where l.org_id = p_org_id and l.stripe_ended_at is null and l.deleted_at is null
  loop
    perform private.queue_stripe_cancellation(p_org_id, v_link.stripe_subscription_id, v_link.stripe_customer_id, v_link.livemode, 'Immediately', p_source, p_person);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function private.queue_org_stripe_cancellations(uuid, app.stripe_cancel_source, uuid) is 'Queues the immediate cancel of every Stripe subscription of the org that Stripe has not reported ended. Returns how many it covered.';
revoke all on function private.queue_org_stripe_cancellations(uuid, app.stripe_cancel_source, uuid) from public, anon, authenticated;

create or replace function private.org_stripe_cancel_open(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.stripe_cancellations c
    where c.subject_org_id = p_org_id and c.cancel_mode = 'Immediately' and c.cancellation_state = 'Queued'
  ) or exists (
    select 1 from app.stripe_subscription_links l
    where l.org_id = p_org_id and l.stripe_ended_at is null and l.deleted_at is null
      and not exists (select 1 from private.stripe_cancellations c
                      where c.stripe_subscription_id = l.stripe_subscription_id and c.cancel_mode = 'Immediately' and c.cancellation_state = 'Accepted'));
$$;

comment on function private.org_stripe_cancel_open(uuid) is 'True while the org has a Stripe subscription that can still charge: Stripe has not reported it ended, and no immediate cancel of it has been accepted. Such an org cannot finish deletion.';
revoke all on function private.org_stripe_cancel_open(uuid) from public, anon, authenticated;

create or replace function private.mark_stripe_cancellation_delayed(p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row private.stripe_cancellations;
begin
  update private.stripe_cancellations c set delay_notified_at = now()
  where c.id = p_id and c.cancellation_state = 'Queued' and c.delay_notified_at is null
  returning c.* into v_row;
  if v_row.id is null then
    return;
  end if;
  perform private.raise_billing_alert('cancel_delayed', 'cancel_delayed:' || v_row.stripe_subscription_id, v_row.subject_org_id, v_row.stripe_subscription_id,
    format('Stripe has not accepted the cancel of %s for %s, asked for at %s. Last error: %s. The worker keeps retrying.',
      v_row.stripe_subscription_id, coalesce(v_row.org_name, v_row.subject_org_id::text), v_row.requested_at, coalesce(v_row.last_error, 'none yet')));
  perform private.notify_billing_contacts(v_row.subject_org_id, 'billing.cancellation_delayed', 'private.stripe_cancellations', v_row.id, '{}'::jsonb);
end;
$$;

comment on function private.mark_stripe_cancellation_delayed(uuid) is 'Once for each cancel Stripe has not accepted: tells the billing owners the truth (billing.cancellation_delayed) and raises a cancel_delayed alert for the platform owner.';
revoke all on function private.mark_stripe_cancellation_delayed(uuid) from public, anon, authenticated;

create or replace function private.accept_stripe_cancellation(p_id uuid, p_status text, p_via text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row private.stripe_cancellations;
  v_link app.stripe_subscription_links;
begin
  update private.stripe_cancellations c
  set cancellation_state = 'Accepted', accepted_at = now(), accepted_via = p_via, stripe_status = left(p_status, 100),
      last_error = null, locked_by = null, locked_at = null
  where c.id = p_id and c.cancellation_state = 'Queued'
  returning c.* into v_row;
  if v_row.id is null then
    return;
  end if;
  insert into private.stripe_cancellation_attempts (cancellation_id, via, accepted, stripe_status)
  values (v_row.id, p_via, true, left(p_status, 100));
  update private.billing_alerts a set resolved_at = now()
  where a.resolved_at is null and a.stripe_subscription_id = v_row.stripe_subscription_id
    and a.alert_kind in ('cancel_delayed', 'active_on_deleted_org', 'active_after_cancel');
  if not private.org_stripe_cancel_open(v_row.subject_org_id) then
    update private.billing_alerts a set resolved_at = now()
    where a.resolved_at is null and a.subject_org_id = v_row.subject_org_id and a.alert_kind = 'deletion_blocked';
  end if;
  if v_row.confirmation_notified_at is not null then
    return;
  end if;
  update private.stripe_cancellations c set confirmation_notified_at = now() where c.id = v_row.id;
  if v_row.cancel_mode = 'Immediately' then
    perform private.notify_billing_contacts(v_row.subject_org_id, 'billing.cancellation_confirmed', 'private.stripe_cancellations', v_row.id, '{}'::jsonb);
  else
    select l.* into v_link from app.stripe_subscription_links l where l.stripe_subscription_id = v_row.stripe_subscription_id;
    perform private.notify_billing_contacts(v_row.subject_org_id, 'billing.plan_ending', 'private.stripe_cancellations', v_row.id, jsonb_build_object(
      'plan', coalesce(private.stripe_plan_label(v_row.stripe_subscription_id), ''),
      'endsOn', private.org_day_mark(v_row.subject_org_id, private.org_date(v_row.subject_org_id, coalesce(v_link.cancel_at, v_link.current_period_end, now())))));
  end if;
end;
$$;

comment on function private.accept_stripe_cancellation(uuid, text, text) is 'Records that Stripe accepted a queued cancel: the attempt, the alerts it clears, and once, the confirmation to the billing owners (billing.cancellation_confirmed for an immediate cancel, billing.plan_ending for one at period end). Does nothing for a cancel that is not queued.';
revoke all on function private.accept_stripe_cancellation(uuid, text, text) from public, anon, authenticated;

-- Every way an org ends queues the cancel ----------------------------------------------------------------------------

create or replace function private.queue_stripe_cancel_on_org_end()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.queue_org_stripe_cancellations(new.org_id,
    case tg_table_name when 'org_deletion_requests' then 'Organization Deleted' else 'Organization Canceled' end::app.stripe_cancel_source,
    private.current_person_id());
  return null;
end;
$$;

comment on function private.queue_stripe_cancel_on_org_end() is 'Queues the immediate cancel of the org''s Stripe subscriptions in the transaction that cancels the org or asks to delete it, whichever path did it.';
revoke all on function private.queue_stripe_cancel_on_org_end() from public, anon, authenticated;

create trigger t92_queue_stripe_cancel after insert on app.org_cancellations
  for each row execute function private.queue_stripe_cancel_on_org_end();
create trigger t92_queue_stripe_cancel after insert on app.org_deletion_requests
  for each row execute function private.queue_stripe_cancel_on_org_end();

comment on function app.cancel_organization(uuid, text, text) is 'Cancels an org (Section 14.7): the Owner (org.organization.delete) types the org name and a reason. The subscription is canceled in the database, and a trigger queues the immediate cancel of its Stripe subscriptions in the same transaction (private.stripe_cancellations, 6140, ADR 0161), the org becomes read-only for 30 days with the full export available, and its data is due for deletion at day 90. A paused org can be canceled, which ends its pause as Canceled (6051); an org read-only for another reason is refused. Refuses a partner that still has client orgs. Returns the cancellation id.';

comment on function app.request_org_deletion(uuid, text, text) is 'Asks to delete an org (Section 14.7): the Owner (org.organization.delete) with step-up (private.require_step_up) types the org name and a reason. The subscription is canceled in the database, and a trigger queues the immediate cancel of its Stripe subscriptions in the same transaction (private.stripe_cancellations, 6140, ADR 0161). The org becomes read-only, every Owner is told, and the org is deleted after a recovery window of the rest of the day and 7 whole days on the org''s calendar, once Stripe has accepted that cancel. Refuses a partner with client orgs and an org under a legal hold. Returns the request id.';

-- The deletion gate --------------------------------------------------------------------------------------------------

-- Redefined from 1351 (its only definition). No certificate means no storage clearing and no purge, so this is the one
-- place an org starts to be deleted.
create or replace function private.write_deletion_certificate(p_org_id uuid, p_basis text, p_requested_at timestamptz, p_due_at timestamptz, p_requester uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org app.organizations;
  v_owner uuid;
  v_id uuid;
begin
  -- A subscription the triggers could not see, such as one created after the org ended, is queued here too.
  perform private.queue_org_stripe_cancellations(p_org_id,
    case p_basis when 'deletion_request' then 'Organization Deleted' else 'Organization Canceled' end::app.stripe_cancel_source, p_requester);
  if private.org_stripe_cancel_open(p_org_id) then
    perform private.raise_billing_alert('deletion_blocked', 'deletion_blocked:' || p_org_id::text, p_org_id, null,
      format('Org %s is due for deletion, but Stripe has not accepted the cancel of its subscription. The deletion waits until it does.', p_org_id));
    return null;
  end if;
  select * into v_org from app.organizations o where o.id = p_org_id;
  select coalesce(
    (select p_requester where p_requester in (select private.org_owner_ids(p_org_id))),
    (select m.person_id from app.memberships m
     join app.membership_roles mr on mr.membership_id = m.id and mr.deleted_at is null
     where m.org_id = p_org_id and mr.role_id = private.system_role_id('owner') and m.deleted_at is null
     order by (m.valid_to is null) desc, m.valid_from limit 1),
    p_requester) into v_owner;
  insert into app.deletion_certificates (deleted_org_id, org_name, org_slug, basis, requested_at, due_at,
    owner_person_id, owner_name, owner_email, locale, time_zone)
  select v_org.id, v_org.name, v_org.slug, p_basis, p_requested_at, p_due_at, v_owner, p.full_name, lower(u.email),
    private.person_language(v_owner, p_org_id), private.org_time_zone(p_org_id)
  from (select 1) one
  left join app.people p on p.id = v_owner
  left join auth.users u on u.id = p.user_id
  on conflict (deleted_org_id) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

comment on function private.write_deletion_certificate(uuid, text, timestamptz, timestamptz, uuid) is 'Writes the certificate of an org due for deletion, once, with the former Owner it goes to (the Owner who canceled or asked, while still an Owner, else the longest-standing Owner), their name, address and language. Writes nothing, and raises a deletion_blocked alert, while the org has a Stripe subscription whose cancel Stripe has not accepted (6140, ADR 0161).';
revoke all on function private.write_deletion_certificate(uuid, text, timestamptz, timestamptz, uuid) from public, anon, authenticated;

-- A certificate written before a subscription appeared (a Checkout paid during the window) still stops at the purge.
create or replace function private.guard_purge_on_open_stripe_cancel()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.purged_at is not null and old.purged_at is null and exists (
    select 1 from private.stripe_cancellations c
    where c.subject_org_id = new.deleted_org_id and c.cancel_mode = 'Immediately' and c.cancellation_state = 'Queued'
  ) then
    perform private.refuse('purge_stripe_cancel_open', 'Stripe has not accepted the cancel of this org''s subscription, so its deletion waits.');
  end if;
  return new;
end;
$$;

comment on function private.guard_purge_on_open_stripe_cancel() is 'Refuses to finish an org''s purge while a queued immediate cancel of its Stripe subscription stands, which rolls the purge back; the next run tries again.';
revoke all on function private.guard_purge_on_open_stripe_cancel() from public, anon, authenticated;

create trigger t30_guard_stripe_cancel before update of purged_at on app.deletion_certificates
  for each row execute function private.guard_purge_on_open_stripe_cancel();

-- Atlas: ending a plan, and where a cancel stands ----------------------------------------------------------------------

create or replace function app.request_plan_end(p_org_id uuid, p_livemode boolean)
returns table (cancellation_id uuid, stripe_subscription_id text, cancellation_state app.stripe_cancellation_state)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_link app.stripe_subscription_links;
  v_id uuid;
begin
  if not private.has_capability(p_org_id, 'org.billing.manage') then
    raise exception using errcode = '42501', message = 'org.billing.manage is required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('billing:' || p_org_id::text, 0));
  select l.* into v_link from app.stripe_subscription_links l
  join app.subscriptions s on s.id = l.subscription_id and s.subscription_state <> 'canceled' and s.deleted_at is null
  where l.org_id = p_org_id and l.livemode = coalesce(p_livemode, false) and l.stripe_ended_at is null and l.deleted_at is null
  order by l.created_at desc limit 1;
  if v_link.id is null then
    perform private.refuse('billing_no_subscription', 'This organization has no paid plan to end.');
  end if;
  v_id := private.queue_stripe_cancellation(p_org_id, v_link.stripe_subscription_id, v_link.stripe_customer_id, v_link.livemode, 'At Period End', 'Plan Ended', v_person);
  return query
    select c.id, c.stripe_subscription_id, c.cancellation_state from private.stripe_cancellations c where c.id = v_id;
end;
$$;

comment on function app.request_plan_end(uuid, boolean) is 'Billing and Plan: the Owner (org.billing.manage, 42501 otherwise) ends the org''s paid plan at the end of the period paid for. Online with no second factor, so stopping a charge is no harder than starting one, and a person whose org is overdue or paused can still do it. Queues the cancel for the worker and returns it; asking again returns the same one. Atlas also calls Stripe at once. Refuses billing_no_subscription without a paid plan.';
revoke all on function app.request_plan_end(uuid, boolean) from public, anon;
grant execute on function app.request_plan_end(uuid, boolean) to authenticated;

create or replace function app.stripe_cancellation_status(p_org_id uuid)
returns table (
  cancellation_id uuid,
  stripe_subscription_id text,
  cancel_mode app.stripe_cancel_mode,
  cancellation_state app.stripe_cancellation_state,
  source app.stripe_cancel_source,
  requested_at timestamptz,
  accepted_at timestamptz,
  ends_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (private.has_capability(p_org_id, 'org.billing.read') or private.has_capability(p_org_id, 'org.organization.delete')) then
    raise exception using errcode = '42501', message = 'org.billing.read is required';
  end if;
  return query
    select c.id, c.stripe_subscription_id, c.cancel_mode, c.cancellation_state, c.source, c.requested_at, c.accepted_at,
      l.cancel_at
    from private.stripe_cancellations c
    left join app.stripe_subscription_links l on l.stripe_subscription_id = c.stripe_subscription_id
    where c.subject_org_id = p_org_id and c.cancellation_state in ('Queued', 'Accepted')
      and case
        when c.cancellation_state = 'Queued' then true
        when c.cancel_mode = 'At Period End' then l.stripe_ended_at is null
        else private.org_read_only_reason(p_org_id) in ('canceled', 'deletion')
      end
    order by c.requested_at desc;
end;
$$;

comment on function app.stripe_cancellation_status(uuid) is 'Where the org''s Stripe cancels stand, for Billing and Plan and the Danger zone (org.billing.read or org.organization.delete, 42501 otherwise): newest first: every cancel still queued, a plan ending at period end until it ends, and an immediate cancel Stripe accepted while the org is canceled or waiting to be deleted, so an org that came back and bought a plan again reads as paying. Only the service role moves a cancel, so these rows are what Stripe has actually said.';
revoke all on function app.stripe_cancellation_status(uuid) from public, anon;
grant execute on function app.stripe_cancellation_status(uuid) to authenticated, service_role;

-- The worker -----------------------------------------------------------------------------------------------------------

create or replace function app.claim_stripe_cancellations(p_worker text, p_livemode boolean, p_limit integer default 20)
returns table (
  cancellation_id uuid,
  stripe_subscription_id text,
  cancel_mode app.stripe_cancel_mode,
  attempt integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  -- A test subscription never charges real money, and a live key cannot reach it, so it never holds up a live deletion.
  if p_livemode then
    perform private.accept_stripe_cancellation(c.id, 'test_mode', 'Worker')
    from private.stripe_cancellations c
    where c.cancellation_state = 'Queued' and not c.livemode;
  end if;
  return query
    with due as (
      select c.id from private.stripe_cancellations c
      where c.cancellation_state = 'Queued' and c.livemode = p_livemode and c.next_attempt_at <= now()
        and (c.locked_at is null or c.locked_at < now() - interval '10 minutes')
      order by c.next_attempt_at
      limit greatest(1, least(coalesce(p_limit, 20), 100))
      for update skip locked
    )
    update private.stripe_cancellations c
    set locked_by = left(p_worker, 200), locked_at = now(), attempts = c.attempts + 1
    from due
    where c.id = due.id
    returning c.id, c.stripe_subscription_id, c.cancel_mode, c.attempts;
end;
$$;

comment on function app.claim_stripe_cancellations(text, boolean, integer) is 'Worker API (service role): claims the queued cancels of that Stripe mode that are due. A claim older than 10 minutes can be taken again, so a worker that died mid-call only delays a cancel. A live key also closes queued test mode cancels as test_mode.';
revoke all on function app.claim_stripe_cancellations(text, boolean, integer) from public, anon, authenticated;
grant execute on function app.claim_stripe_cancellations(text, boolean, integer) to service_role;

create or replace function app.finish_stripe_cancellation(p_id uuid, p_accepted boolean, p_stripe_status text default null, p_error text default null)
returns app.stripe_cancellation_state
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row private.stripe_cancellations;
begin
  select * into v_row from private.stripe_cancellations c where c.id = p_id for update;
  if v_row.id is null then
    perform private.refuse('stripe_cancellation_unknown', 'No such Stripe cancel.');
  end if;
  if p_accepted then
    perform private.accept_stripe_cancellation(p_id, coalesce(p_stripe_status, 'accepted'), 'Worker');
  elsif v_row.cancellation_state = 'Queued' then
    insert into private.stripe_cancellation_attempts (cancellation_id, via, accepted, stripe_status, error)
    values (p_id, 'Worker', false, left(p_stripe_status, 100), left(p_error, 2000));
    update private.stripe_cancellations c
    set locked_by = null, locked_at = null, last_error = left(p_error, 2000),
        -- 5 minutes doubling to 6 hours, and it never gives up.
        next_attempt_at = now() + least(interval '6 hours', interval '5 minutes' * power(2, least(greatest(v_row.attempts, 1) - 1, 10)))
    where c.id = p_id;
    perform private.mark_stripe_cancellation_delayed(p_id);
  end if;
  return (select c.cancellation_state from private.stripe_cancellations c where c.id = p_id);
end;
$$;

comment on function app.finish_stripe_cancellation(uuid, boolean, text, text) is 'Worker API (service role): records what Stripe answered. Accepted moves the cancel on and confirms it. A failure keeps it Queued, waits 5 minutes doubling up to 6 hours, and the first one tells the billing owners and raises a cancel_delayed alert. Returns the state.';
revoke all on function app.finish_stripe_cancellation(uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function app.finish_stripe_cancellation(uuid, boolean, text, text) to service_role;

create or replace function app.stripe_checkouts_to_close(p_livemode boolean)
returns table (stripe_checkout_session_id text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.stripe_checkout_session_id from app.billing_checkouts c
  where c.checkout_state = 'Open' and c.livemode = p_livemode and c.expires_at > now() and c.deleted_at is null
    and private.org_read_only_reason(c.org_id) in ('canceled', 'deletion')
  order by c.created_at
  limit 100;
$$;

comment on function app.stripe_checkouts_to_close(boolean) is 'Worker API (service role): Checkout sessions still open on an org being canceled or deleted, which the worker expires so nobody pays for a plan on an org that is ending.';
revoke all on function app.stripe_checkouts_to_close(boolean) from public, anon, authenticated;
grant execute on function app.stripe_checkouts_to_close(boolean) to service_role;

create or replace function app.billing_alerts_to_send(p_limit integer default 50)
returns table (alert_id uuid, alert_kind text, subject_org_id uuid, stripe_subscription_id text, detail text, raised_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.alert_kind, a.subject_org_id, a.stripe_subscription_id, a.detail, a.raised_at
  from private.billing_alerts a
  where a.sent_at is null and a.resolved_at is null
  order by a.raised_at
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

comment on function app.billing_alerts_to_send(integer) is 'Worker API (service role): open billing alerts the platform owner has not been emailed about, oldest first.';
revoke all on function app.billing_alerts_to_send(integer) from public, anon, authenticated;
grant execute on function app.billing_alerts_to_send(integer) to service_role;

create or replace function app.mark_billing_alert_sent(p_alert_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update private.billing_alerts set sent_at = now() where id = p_alert_id and sent_at is null;
$$;

comment on function app.mark_billing_alert_sent(uuid) is 'Worker API (service role): records that a billing alert reached the platform owner.';
revoke all on function app.mark_billing_alert_sent(uuid) from public, anon, authenticated;
grant execute on function app.mark_billing_alert_sent(uuid) to service_role;

-- A cancel Stripe has not accepted is reported even if the worker is not running.
create or replace function private.run_stripe_cancellation_watch(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  for v_id in
    select c.id from private.stripe_cancellations c
    where c.cancellation_state = 'Queued' and c.delay_notified_at is null and c.requested_at <= p_now - interval '15 minutes'
    for update skip locked
  loop
    perform private.mark_stripe_cancellation_delayed(v_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function private.run_stripe_cancellation_watch(timestamptz) is 'Every 15 minutes: a cancel still queued 15 minutes after it was asked for tells the billing owners and raises an alert, even when the worker is not scheduled or has never failed. Returns how many.';
revoke all on function private.run_stripe_cancellation_watch(timestamptz) from public, anon, authenticated;

select cron.schedule('xos_stripe_cancellation_watch', '*/15 * * * *', 'select private.run_stripe_cancellation_watch()');

-- The webhook ----------------------------------------------------------------------------------------------------------

-- Redefined from 0560 (its only definition): an event can name an org the purge already deleted, and must still be
-- stored, or Stripe retries it for days and nobody learns the subscription is live.
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
  v_org uuid := (select o.id from app.organizations o where o.id = p_org_id);
begin
  insert into app.stripe_events (org_id, stripe_event_id, event_type, livemode, stripe_created_at, payload)
  values (v_org, p_stripe_event_id, p_event_type, p_livemode, p_stripe_created_at, p_payload)
  on conflict (stripe_event_id) do nothing
  returning id into v_id;
  if v_id is not null then
    return query select v_id, true;
  else
    return query select e.id, false from app.stripe_events e where e.stripe_event_id = p_stripe_event_id;
  end if;
end;
$$;

comment on function app.record_stripe_event(text, text, boolean, timestamptz, jsonb, uuid) is 'Stripe webhook API (service role, after the server module verified the Stripe signature and resolved the org from the customer or subscription metadata): stores an event once with its org, or with no org when the org named no longer exists. A redelivery returns the existing row with is_new false, so the caller applies each event exactly once.';
revoke all on function app.record_stripe_event(text, text, boolean, timestamptz, jsonb, uuid) from public, anon, authenticated;
grant execute on function app.record_stripe_event(text, text, boolean, timestamptz, jsonb, uuid) to service_role;

create or replace function app.reconcile_stripe_subscription(
  p_org_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_stripe_status text,
  p_livemode boolean,
  p_event_created_at timestamptz
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event timestamptz := coalesce(p_event_created_at, now());
  v_ended boolean := p_stripe_status in ('canceled', 'incomplete_expired');
  v_exists boolean;
  v_reason text;
  v_row private.stripe_cancellations;
  v_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('billing:' || p_org_id::text, 0));
  v_exists := exists (select 1 from app.organizations o where o.id = p_org_id and o.deleted_at is null);
  v_reason := case when v_exists then private.org_read_only_reason(p_org_id) end;

  if v_ended then
    update app.stripe_subscription_links l set stripe_ended_at = coalesce(l.stripe_ended_at, v_event), cancel_at = null
    where l.stripe_subscription_id = p_stripe_subscription_id;
    -- Ended in Stripe with nothing asked of XOS, such as in the Dashboard or after failed retries: still confirmed.
    if v_exists and not exists (select 1 from private.stripe_cancellations c where c.stripe_subscription_id = p_stripe_subscription_id) then
      v_id := private.queue_stripe_cancellation(p_org_id, p_stripe_subscription_id, p_stripe_customer_id, coalesce(p_livemode, false), 'Immediately', 'Reconciliation', null);
    end if;
    perform private.accept_stripe_cancellation(c.id, p_stripe_status, 'Webhook')
    from private.stripe_cancellations c
    where c.stripe_subscription_id = p_stripe_subscription_id and c.cancellation_state = 'Queued';
    update private.billing_alerts a set resolved_at = now()
    where a.resolved_at is null and a.stripe_subscription_id = p_stripe_subscription_id
      and a.alert_kind in ('cancel_delayed', 'active_on_deleted_org', 'active_after_cancel');
    return case when v_exists and v_reason is distinct from 'canceled' and v_reason is distinct from 'deletion' then 'proceed' else 'ended' end;
  end if;

  select c.* into v_row from private.stripe_cancellations c
  where c.stripe_subscription_id = p_stripe_subscription_id and c.cancel_mode = 'Immediately' and c.cancellation_state in ('Queued', 'Accepted')
  order by c.created_at desc limit 1;

  -- An org that is live and a subscription XOS never asked to stop: the ordinary sync.
  if v_exists and v_reason is distinct from 'canceled' and v_reason is distinct from 'deletion' and v_row.id is null then
    return 'proceed';
  end if;

  -- Stripe does not order its events: one from before the accepted cancel says nothing new.
  if v_row.id is not null and v_row.cancellation_state = 'Accepted' and v_event <= v_row.accepted_at + interval '10 minutes' then
    return 'stale';
  end if;

  if v_row.id is not null and v_row.cancellation_state = 'Accepted' then
    update private.stripe_cancellations c
    set cancellation_state = 'Queued', accepted_at = null, accepted_via = null, stripe_status = left(p_stripe_status, 100),
        next_attempt_at = now(), delay_notified_at = null
    where c.id = v_row.id;
  elsif v_row.id is null then
    perform private.queue_stripe_cancellation(p_org_id, p_stripe_subscription_id, p_stripe_customer_id, coalesce(p_livemode, false), 'Immediately', 'Reconciliation', null);
  end if;
  if not v_exists then
    perform private.raise_billing_alert('active_on_deleted_org', 'active_on_deleted_org:' || p_stripe_subscription_id, p_org_id, p_stripe_subscription_id,
      format('Stripe says %s is %s, but org %s has been deleted. Its cancel is queued. Check that the customer was not charged.', p_stripe_subscription_id, p_stripe_status, p_org_id));
  elsif v_row.id is null or v_row.cancellation_state = 'Accepted' then
    perform private.raise_billing_alert('active_after_cancel', 'active_after_cancel:' || p_stripe_subscription_id, p_org_id, p_stripe_subscription_id,
      format('Stripe says %s is %s after org %s was canceled or its cancel accepted. The cancel is queued again. Check that the customer was not charged.', p_stripe_subscription_id, p_stripe_status, p_org_id));
  end if;
  return 'queued';
end;
$$;

comment on function app.reconcile_stripe_subscription(uuid, text, text, text, boolean, timestamptz) is 'Stripe webhook API (service role), before the subscription sync. A subscription that ended settles its cancels and returns proceed for a live org, so the sync moves it to Access, or ended for one that is ending or gone. A live subscription returns proceed for a live org XOS never asked to stop. On a purged org, an org being canceled or deleted, or a subscription whose immediate cancel was accepted more than 10 minutes before the event, it queues the cancel, raises an alert and returns queued, so no subscription is created again. An event from before that acceptance returns stale.';
revoke all on function app.reconcile_stripe_subscription(uuid, text, text, text, boolean, timestamptz) from public, anon, authenticated;
grant execute on function app.reconcile_stripe_subscription(uuid, text, text, text, boolean, timestamptz) to service_role;

create or replace function app.note_stripe_subscription_terms(
  p_stripe_subscription_id text,
  p_cancel_at timestamptz,
  p_amount_minor bigint,
  p_currency_code text,
  p_event_created_at timestamptz
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event timestamptz := coalesce(p_event_created_at, now());
  v_link app.stripe_subscription_links;
  v_was timestamptz;
  v_id uuid;
begin
  select l.* into v_link from app.stripe_subscription_links l where l.stripe_subscription_id = p_stripe_subscription_id for update;
  if v_link.id is null or (v_link.terms_event_at is not null and v_event < v_link.terms_event_at) then
    return false;
  end if;
  v_was := v_link.cancel_at;
  update app.stripe_subscription_links
  set cancel_at = p_cancel_at, terms_event_at = v_event,
      recurring_amount_minor = coalesce(p_amount_minor, recurring_amount_minor),
      currency_code = coalesce(upper(p_currency_code), currency_code)
  where id = v_link.id;
  if p_cancel_at is not null then
    -- Set in the Stripe portal, or the answer to Atlas's own request: either way Stripe has accepted it.
    v_id := private.queue_stripe_cancellation(v_link.org_id, p_stripe_subscription_id, v_link.stripe_customer_id, v_link.livemode, 'At Period End', 'Stripe Portal', null);
    perform private.accept_stripe_cancellation(v_id, 'cancel_at_period_end', 'Webhook');
  elsif v_was is not null then
    -- The customer renewed in the portal. A cancel asked for after this event still stands.
    update private.stripe_cancellations c set cancellation_state = 'Withdrawn', locked_by = null, locked_at = null
    where c.stripe_subscription_id = p_stripe_subscription_id and c.cancel_mode = 'At Period End'
      and c.cancellation_state in ('Queued', 'Accepted') and c.requested_at <= v_event;
  end if;
  return true;
end;
$$;

comment on function app.note_stripe_subscription_terms(text, timestamptz, bigint, text, timestamptz) is 'Stripe webhook API (service role), after the sync: records when Stripe will end the subscription and what it charges each period. An older event changes nothing. A cancel at period end, from Atlas or the portal, is accepted and confirmed; clearing it withdraws the cancel, so the plan renews again. Returns whether the event applied.';
revoke all on function app.note_stripe_subscription_terms(text, timestamptz, bigint, text, timestamptz) from public, anon, authenticated;
grant execute on function app.note_stripe_subscription_terms(text, timestamptz, bigint, text, timestamptz) to service_role;

create or replace function app.note_stripe_charge(
  p_stripe_subscription_id text,
  p_stripe_invoice_id text,
  p_amount_minor bigint,
  p_currency_code text,
  p_billing_reason text,
  p_paid_at timestamptz
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row private.stripe_cancellations;
begin
  if coalesce(p_amount_minor, 0) <= 0 then
    return false;
  end if;
  select c.* into v_row from private.stripe_cancellations c
  where c.stripe_subscription_id = p_stripe_subscription_id and c.cancellation_state in ('Queued', 'Accepted')
    and c.requested_at < p_paid_at
    and (c.cancel_mode = 'Immediately' or (coalesce(p_billing_reason, '') = 'subscription_cycle' and c.accepted_at < p_paid_at))
  order by c.cancel_mode, c.created_at desc limit 1;
  if v_row.id is null then
    return false;
  end if;
  perform private.raise_billing_alert('charged_after_cancel', 'charged_after_cancel:' || p_stripe_invoice_id, v_row.subject_org_id, p_stripe_subscription_id,
    format('Stripe charged %s on invoice %s for %s after its cancel was asked for at %s. Refund it in Stripe and tell the Owner (Terms 11.4).',
      private.billing_amount_text(p_amount_minor, upper(p_currency_code)), p_stripe_invoice_id, p_stripe_subscription_id, v_row.requested_at));
  return true;
end;
$$;

comment on function app.note_stripe_charge(text, text, bigint, text, text, timestamptz) is 'Stripe webhook API (service role): a paid invoice on a subscription XOS was asked to stop raises a charged_after_cancel alert, so the owner refunds it. An immediate cancel counts any charge after the request; a cancel at period end counts only a renewal after Stripe accepted it. Returns whether it raised one.';
revoke all on function app.note_stripe_charge(text, text, bigint, text, text, timestamptz) from public, anon, authenticated;
grant execute on function app.note_stripe_charge(text, text, bigint, text, text, timestamptz) to service_role;

-- What is already out there --------------------------------------------------------------------------------------------

-- A subscription already ended by the sync is ended; one on an org already canceled or deleting gets its cancel queued now.
update app.stripe_subscription_links l set stripe_ended_at = l.updated_at
from app.subscriptions s
where s.id = l.subscription_id and s.subscription_state = 'canceled'
  and not exists (select 1 from app.org_cancellations c where c.org_id = l.org_id and c.reactivated_at is null and c.deleted_at is null)
  and not exists (select 1 from app.org_deletion_requests r where r.org_id = l.org_id and r.recovered_at is null and r.deleted_at is null);

select private.queue_org_stripe_cancellations(o.org_id, 'Reconciliation', null)
from (
  select c.org_id from app.org_cancellations c where c.reactivated_at is null and c.deleted_at is null
  union
  select r.org_id from app.org_deletion_requests r where r.recovered_at is null and r.deleted_at is null
) o;
