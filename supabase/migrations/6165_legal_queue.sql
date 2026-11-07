-- 6165_legal_queue.sql
-- One list of the legal and security work a one-person company must not miss because of a full inbox (RRR-248; ADR
-- 0167). GHXSTSHIP's mailboxes, appeals, DMCA actions, security reports and written promises all route to one person,
-- and nothing tracked their clocks (decision 40 of the review packet). This migration holds the data:
--   * private.legal_queue_rules: every clock, as numbers: when the first response is due, when the work is due, the
--     earliest it may be done (a DMCA restoration), an allowed extension, and how early alerts start. Each rule names
--     what it rests on: a statute, a published promise, an internal target, or a Customer's own clock.
--   * private.legal_clock_end and private.is_legal_business_day: clock math in the time zone of GHXSTSHIP's Miami
--     address, counting business days past weekends and US federal holidays. Holidays are computed, so the calendar
--     never runs out.
--   * app.legal_queue_items: one item per piece of work, with its received time and its due time computed from its
--     rule, never typed, except where the clock comes from the document itself (a subpoena's return date).
--   * private.legal_queue_events: the append-only log of what was done, by whom and when. It has no retention of its own:
--     it lives and goes with its item, so a closed item keeps its whole log and an open item never loses part of it.
--   * private.sync_legal_queue_feeds: the automatic feed, only from records the system already creates: open appeals,
--     open listing reports, open requests in a Customer's data subject register and moderation notices that could not be
--     delivered. The person's name, email and words never leave the register: the item holds the org, the kind of request
--     and the dates. One feed failing never stops another, and opens an item of its own so the failure reaches the owner.
--   * private.legal_alert_contacts and private.legal_outside_reviewers: the backup address for overdue alerts and a
--     named outside appeal reviewer. Both start empty, and an empty table claims nothing.
-- 6166 holds the console RPCs, 6167 the hourly sweep and its alerts, and 6168 the appeal rule.

-- Types ----------------------------------------------------------------------------------------------------------------

create type app.legal_queue_matter as enum (
  'Data Subject Request', 'Privacy Complaint', 'DMCA Notice', 'DMCA Counter-Notice', 'Repeat Infringer Review',
  'Abuse Report', 'Moderation Appeal', 'Security Report', 'Personal Data Breach', 'Accessibility Complaint',
  'Government Data Request', 'Other Promise', 'Undelivered Notice', 'Queue Failure'
);
comment on type app.legal_queue_matter is 'What a legal queue item is about (ADR 0167).';

create type app.legal_queue_state as enum ('Received', 'In Progress', 'Waiting', 'Completed', 'Refused', 'Withdrawn');
comment on type app.legal_queue_state is 'A legal queue item''s lifecycle (ADR 0167). Waiting says the next step is someone else''s; the clock keeps running. Completed, Refused and Withdrawn end it.';

create type app.legal_queue_basis as enum ('Statute', 'Published Promise', 'Internal Target', 'Customer Clock');
comment on type app.legal_queue_basis is 'What a clock rests on (ADR 0167): a statute or regulation, a promise in a published document, a target GHXSTSHIP sets for itself where the law says only "timely" or "expeditiously", or a clock that belongs to a Customer, which the queue only watches.';

create type app.legal_queue_event_kind as enum (
  'Received', 'First Response', 'Note', 'State Changed', 'Extended', 'Source Changed', 'Alert Sent', 'Re-Review', 'Person Told',
  'Hold Placed', 'Hold Released'
);
comment on type app.legal_queue_event_kind is 'One entry in a legal queue item''s log (ADR 0167).';

create type app.legal_queue_clock_unit as enum ('Hours', 'Days', 'Business Days', 'Months Or 30 Days');
comment on type app.legal_queue_clock_unit is 'How a clock counts (ADR 0167): hours from the instant received, or calendar days, business days, or the shorter of calendar months and 30 days each, ending at the end of the local day.';

-- Clock math -----------------------------------------------------------------------------------------------------------

create function private.legal_clock_time_zone()
returns text
language sql
immutable
set search_path = ''
as $$
  select 'America/New_York'::text;
$$;
comment on function private.legal_clock_time_zone() is 'The time zone legal clocks count in: GHXSTSHIP''s Miami address. These clocks are the company''s own, not a project''s.';
revoke all on function private.legal_clock_time_zone() from public, anon, authenticated;

create function private.nth_weekday_of_month(p_year integer, p_month integer, p_isodow integer, p_nth integer)
returns date
language sql
immutable
set search_path = ''
as $$
  select make_date(p_year, p_month, 1)
    + ((p_isodow - extract(isodow from make_date(p_year, p_month, 1))::integer + 7) % 7)
    + (p_nth - 1) * 7;
$$;
comment on function private.nth_weekday_of_month(integer, integer, integer, integer) is 'The nth given ISO weekday of a month.';
revoke all on function private.nth_weekday_of_month(integer, integer, integer, integer) from public, anon, authenticated;

create function private.observed_holiday(p_day date)
returns date
language sql
immutable
set search_path = ''
as $$
  select case extract(isodow from p_day)::integer when 6 then p_day - 1 when 7 then p_day + 1 else p_day end;
$$;
comment on function private.observed_holiday(date) is 'The day a fixed-date US federal holiday is observed: a Saturday moves to Friday and a Sunday to Monday (5 U.S.C. 6103).';
revoke all on function private.observed_holiday(date) from public, anon, authenticated;

create function private.is_legal_business_day(p_day date)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select extract(isodow from p_day)::integer < 6 and not exists (
    select 1
    -- The next year too: a New Year's Day on a Saturday is observed on 31 December.
    from generate_series(extract(year from p_day)::integer, extract(year from p_day)::integer + 1) y
    cross join lateral (values
      (private.observed_holiday(make_date(y, 1, 1))),
      (private.nth_weekday_of_month(y, 1, 1, 3)),
      (private.nth_weekday_of_month(y, 2, 1, 3)),
      (make_date(y, 5, 31) - (extract(isodow from make_date(y, 5, 31))::integer - 1)),
      (private.observed_holiday(make_date(y, 6, 19))),
      (private.observed_holiday(make_date(y, 7, 4))),
      (private.nth_weekday_of_month(y, 9, 1, 1)),
      (private.nth_weekday_of_month(y, 10, 1, 2)),
      (private.observed_holiday(make_date(y, 11, 11))),
      (private.nth_weekday_of_month(y, 11, 4, 4)),
      (private.observed_holiday(make_date(y, 12, 25)))
    ) as h (holiday)
    where h.holiday = p_day
  );
$$;
comment on function private.is_legal_business_day(date) is 'Whether a day counts toward a business-day clock: not a weekend and not a US federal holiday as observed. Computed, so it needs no yearly seed.';
revoke all on function private.is_legal_business_day(date) from public, anon, authenticated;

create function private.legal_clock_end(p_from timestamptz, p_amount integer, p_unit app.legal_queue_clock_unit)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v_zone text := private.legal_clock_time_zone();
  v_day date := (p_from at time zone v_zone)::date;
  v_left integer := p_amount;
begin
  if p_unit = 'Hours' then
    return p_from + make_interval(hours => p_amount);
  end if;
  if p_unit = 'Days' then
    v_day := v_day + p_amount;
  elsif p_unit = 'Months Or 30 Days' then
    -- Privacy Policy 7: where a law counts in months, the shorter of a month and 30 days. February makes the month the
    -- shorter, and a 31-day month the 30 days.
    v_day := least((v_day + make_interval(months => p_amount))::date, v_day + p_amount * 30);
  else
    -- The day received is day zero; the count starts with the next business day.
    while v_left > 0 loop
      v_day := v_day + 1;
      if private.is_legal_business_day(v_day) then
        v_left := v_left - 1;
      end if;
    end loop;
  end if;
  -- The last second of that local day, so a daylight saving change moves nothing.
  return ((v_day + 1)::timestamp at time zone v_zone) - interval '1 second';
end;
$$;
comment on function private.legal_clock_end(timestamptz, integer, app.legal_queue_clock_unit) is 'When a clock ends: p_amount hours after p_from, or the end of the local day p_amount calendar days, business days, or months (each no longer than 30 days) after it (private.legal_clock_time_zone).';
revoke all on function private.legal_clock_end(timestamptz, integer, app.legal_queue_clock_unit) from public, anon, authenticated;

create function private.legal_local_instant(p_local timestamp)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  -- The offset comes from the entered day itself, so a date across a daylight saving change keeps the time typed. Postgres
  -- reads the hour the autumn change repeats as the later one; the earlier is taken, so a clock never ends late because of it.
  select least(p_local at time zone private.legal_clock_time_zone(),
    ((p_local - interval '1 hour') at time zone private.legal_clock_time_zone()) + interval '1 hour');
$$;
comment on function private.legal_local_instant(timestamp) is 'A date and time an operator typed, read as local time in the zone legal clocks count in (private.legal_clock_time_zone). Every clock on the queue shows in that zone, so the form asks for it and needs nothing from the browser.';
revoke all on function private.legal_local_instant(timestamp) from public, anon, authenticated;

-- The rules ------------------------------------------------------------------------------------------------------------

create table private.legal_queue_rules (
  code text primary key,
  matter app.legal_queue_matter not null,
  basis app.legal_queue_basis not null,
  first_amount integer,
  first_unit app.legal_queue_clock_unit,
  due_amount integer,
  due_unit app.legal_queue_clock_unit,
  earliest_amount integer,
  earliest_unit app.legal_queue_clock_unit,
  extension_amount integer,
  extension_unit app.legal_queue_clock_unit,
  due_from_document boolean not null default false,
  hand_entered boolean not null default true,
  customer_clock boolean not null default false,
  operator_closes boolean not null default false,
  re_review_required boolean not null default false,
  holds_org_data boolean not null default false,
  alert_leads interval[] not null,
  sort_order smallint not null,
  constraint legal_queue_rules_code check (code ~ '^[a-z][a-z_]*$'),
  constraint legal_queue_rules_first check ((first_amount is null) = (first_unit is null)),
  constraint legal_queue_rules_due check ((due_amount is null) = (due_unit is null)),
  constraint legal_queue_rules_due_source check (due_from_document = (due_amount is null)),
  constraint legal_queue_rules_earliest check ((earliest_amount is null) = (earliest_unit is null)),
  constraint legal_queue_rules_extension check ((extension_amount is null) = (extension_unit is null))
);

comment on table private.legal_queue_rules is 'The clock of each kind of legal queue item (ADR 0167). Numbers live here, and labels and sources in the console catalog under legalQueue.rules.';
comment on column private.legal_queue_rules.code is 'Rule code, the key of its label and source in the console catalog.';
comment on column private.legal_queue_rules.matter is 'What items under this rule are about.';
comment on column private.legal_queue_rules.basis is 'What the clock rests on.';
comment on column private.legal_queue_rules.first_amount is 'How long until a first response is due; null when the rule has none.';
comment on column private.legal_queue_rules.first_unit is 'How first_amount counts.';
comment on column private.legal_queue_rules.due_amount is 'How long until the work is due; null when the date comes from the document.';
comment on column private.legal_queue_rules.due_unit is 'How due_amount counts.';
comment on column private.legal_queue_rules.earliest_amount is 'How long until the work may be done at all; a DMCA restoration may not come sooner.';
comment on column private.legal_queue_rules.earliest_unit is 'How earliest_amount counts.';
comment on column private.legal_queue_rules.extension_amount is 'How much one extension adds to the due time; null when the rule allows none.';
comment on column private.legal_queue_rules.extension_unit is 'How extension_amount counts.';
comment on column private.legal_queue_rules.due_from_document is 'The operator enters the due time from the document itself, such as a subpoena''s return date.';
comment on column private.legal_queue_rules.hand_entered is 'Offered when adding an item by hand; false for rules the system feeds.';
comment on column private.legal_queue_rules.customer_clock is 'The clock is a Customer''s own: the item is watched, not worked, and alerts once when overdue.';
comment on column private.legal_queue_rules.operator_closes is 'A fed item an operator moves by hand, because nothing else can finish it, such as a notice that could not be delivered.';
comment on column private.legal_queue_rules.re_review_required is 'Closing needs a fresh, documented re-review and a record of how the person was told: an appeal that arrived by email (ADR 0167).';
comment on column private.legal_queue_rules.holds_org_data is 'The item names a Customer org and places a legal hold on it while open, so its deletion waits: a return of data the export omits (Terms 11.2, DPA 10.2).';
comment on column private.legal_queue_rules.alert_leads is 'How long before each clock ends an alert goes out.';
comment on column private.legal_queue_rules.sort_order is 'Order in the add form.';

alter table private.legal_queue_rules enable row level security;
revoke all on private.legal_queue_rules from public, anon, authenticated;
grant select on private.legal_queue_rules to service_role;

-- Sources are in the console catalog. Five numbers are worth saying why here:
--   * dsar_privacy runs for the shorter of a month and 30 days, as Privacy Policy 7 says, and extends by 59 days, not 60, so
--     the whole never passes the three months GDPR Article 12(3) allows.
--   * dmca_counter_notice ends its earliest day at the 10th business day, so a restoration always falls after it, as 17
--     U.S.C. 512(g)(2)(C) requires.
--   * dmca_notice, abuse_report, moderation_appeal and abuse_appeal are targets: the law says "expeditiously" or "timely" and
--     gives no number, and no published document states one.
--   * intimate_image_report runs the Take It Down Act's 48 hours as our own target. Whether XOS is a covered platform is
--     undecided, so the basis says target and not statute, and the catalog's source line says why.
--   * listing_report, moderation_appeal, undelivered_notice and queue_feed_failure start with a lead longer than the clock.
--     Nothing else tells the owner these arrived, because no mailbox receives them, so the first sweep alerts at once.
insert into private.legal_queue_rules (code, matter, basis, first_amount, first_unit, due_amount, due_unit, earliest_amount,
  earliest_unit, extension_amount, extension_unit, due_from_document, hand_entered, customer_clock, operator_closes, re_review_required, alert_leads, sort_order) values
  ('dsar_privacy', 'Data Subject Request', 'Published Promise', 10, 'Business Days', 1, 'Months Or 30 Days', null, null, 59, 'Days', false, true, false, false, false, '{7 days,3 days,1 day}', 10),
  ('dsar_brazil', 'Data Subject Request', 'Statute', 1, 'Business Days', 15, 'Days', null, null, null, null, false, true, false, false, false, '{5 days,2 days,1 day}', 20),
  ('dsar_appeal', 'Data Subject Request', 'Published Promise', null, null, 45, 'Days', null, null, null, null, false, true, false, false, true, '{14 days,7 days,3 days,1 day}', 30),
  ('account_deletion_email', 'Data Subject Request', 'Published Promise', null, null, 30, 'Days', null, null, null, null, false, true, false, false, false, '{7 days,3 days,1 day}', 40),
  ('privacy_complaint', 'Privacy Complaint', 'Published Promise', 30, 'Days', 60, 'Days', null, null, null, null, false, true, false, false, false, '{7 days,3 days,1 day}', 50),
  ('dmca_notice', 'DMCA Notice', 'Internal Target', null, null, 2, 'Business Days', null, null, null, null, false, true, false, false, false, '{1 day,4 hours}', 60),
  ('dmca_counter_notice', 'DMCA Counter-Notice', 'Statute', 1, 'Business Days', 14, 'Business Days', 10, 'Business Days', null, null, false, true, false, false, false, '{5 days,2 days,1 day}', 70),
  ('repeat_infringer_review', 'Repeat Infringer Review', 'Internal Target', null, null, 5, 'Business Days', null, null, null, null, false, false, false, false, false, '{2 days,1 day}', 80),
  ('abuse_report', 'Abuse Report', 'Internal Target', 2, 'Business Days', 5, 'Business Days', null, null, null, null, false, true, false, false, false, '{2 days,1 day}', 90),
  ('intimate_image_report', 'Abuse Report', 'Internal Target', null, null, 48, 'Hours', null, null, null, null, false, true, false, false, false, '{24 hours,12 hours,4 hours}', 100),
  ('child_safety_report', 'Abuse Report', 'Internal Target', null, null, 24, 'Hours', null, null, null, null, false, true, false, false, false, '{12 hours,4 hours}', 110),
  ('abuse_appeal', 'Moderation Appeal', 'Internal Target', null, null, 30, 'Days', null, null, null, null, false, true, false, false, true, '{7 days,3 days,1 day}', 115),
  ('listing_report', 'Abuse Report', 'Internal Target', null, null, 5, 'Business Days', null, null, null, null, false, false, false, false, false, '{14 days,2 days,1 day}', 120),
  ('moderation_appeal', 'Moderation Appeal', 'Internal Target', null, null, 30, 'Days', null, null, null, null, false, false, false, false, false, '{31 days,7 days,3 days,1 day}', 130),
  ('security_report', 'Security Report', 'Published Promise', 3, 'Business Days', 10, 'Business Days', null, null, null, null, false, true, false, false, false, '{3 days,1 day}', 140),
  ('personal_data_breach', 'Personal Data Breach', 'Statute', 48, 'Hours', 72, 'Hours', null, null, null, null, false, true, false, false, false, '{24 hours,12 hours,4 hours}', 150),
  ('accessibility_report', 'Accessibility Complaint', 'Published Promise', null, null, 5, 'Business Days', null, null, null, null, false, true, false, false, false, '{2 days,1 day}', 160),
  ('accessibility_review', 'Accessibility Complaint', 'Published Promise', null, null, 10, 'Business Days', null, null, null, null, false, true, false, false, true, '{3 days,1 day}', 170),
  ('government_request', 'Government Data Request', 'Published Promise', 2, 'Business Days', null, null, null, null, null, null, true, true, false, false, false, '{7 days,3 days,1 day}', 180),
  ('omitted_data_return', 'Other Promise', 'Published Promise', null, null, 30, 'Days', null, null, null, null, false, true, false, false, false, '{7 days,3 days,1 day}', 190),
  ('customer_privacy_help', 'Other Promise', 'Internal Target', null, null, 14, 'Days', null, null, null, null, false, true, false, false, false, '{5 days,2 days,1 day}', 200),
  ('other_promise', 'Other Promise', 'Published Promise', null, null, null, null, null, null, null, null, true, true, false, false, false, '{7 days,3 days,1 day}', 210),
  ('dsar_customer_register', 'Data Subject Request', 'Customer Clock', null, null, 30, 'Days', null, null, null, null, false, false, true, false, false, '{}', 220),
  ('undelivered_notice', 'Undelivered Notice', 'Internal Target', null, null, 2, 'Business Days', null, null, null, null, false, false, false, true, false, '{14 days,1 day}', 230),
  ('queue_feed_failure', 'Queue Failure', 'Internal Target', null, null, 1, 'Business Days', null, null, null, null, false, false, false, false, false, '{14 days}', 240);
-- A request for what the export omits holds the org's deletion until the return is done (Terms 11.2 and 11.4, DPA 10.2).
update private.legal_queue_rules set holds_org_data = true where code = 'omitted_data_return';

-- The items ------------------------------------------------------------------------------------------------------------

create table private.legal_outside_reviewers (
  id uuid primary key default private.uuid_v7(),
  reviewer_name text not null,
  organization_name text,
  email text not null,
  reason text not null,
  appointed_by uuid not null references app.people (id),
  appointed_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_by uuid references app.people (id),
  end_reason text,
  constraint legal_outside_reviewers_name_length check (char_length(btrim(reviewer_name)) between 1 and 200),
  constraint legal_outside_reviewers_org_length check (organization_name is null or char_length(btrim(organization_name)) between 1 and 200),
  constraint legal_outside_reviewers_email check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 320),
  constraint legal_outside_reviewers_reason_length check (char_length(btrim(reason)) between 1 and 500),
  constraint legal_outside_reviewers_ended check ((ended_at is null) = (ended_by is null) and (ended_at is null) = (end_reason is null)),
  constraint legal_outside_reviewers_end_reason_length check (end_reason is null or char_length(btrim(end_reason)) between 1 and 500)
);
create unique index legal_outside_reviewers_one_live on private.legal_outside_reviewers ((true)) where ended_at is null;
create index legal_outside_reviewers_appointed_by_idx on private.legal_outside_reviewers (appointed_by);
create index legal_outside_reviewers_ended_by_idx on private.legal_outside_reviewers (ended_by);

comment on table private.legal_outside_reviewers is 'A named person outside GHXSTSHIP who re-reviews moderation appeals (ADR 0167). Empty until one is appointed; at most one at a time. While one is appointed every appeal goes to them. An ended appointment is kept 7 years, like an operator grant, and for as long as a decision names it; then the sweep deletes it.';
comment on column private.legal_outside_reviewers.id is 'Appointment id, UUID v7.';
comment on column private.legal_outside_reviewers.reviewer_name is 'The reviewer''s name, told to the person whose appeal they review.';
comment on column private.legal_outside_reviewers.organization_name is 'Their firm or body, when there is one.';
comment on column private.legal_outside_reviewers.email is 'Where appeal alerts reach them, lowercased.';
comment on column private.legal_outside_reviewers.reason is 'Why they were appointed, in the operator''s words.';
comment on column private.legal_outside_reviewers.appointed_by is 'Operator who appointed them.';
comment on column private.legal_outside_reviewers.appointed_at is 'When the appointment began.';
comment on column private.legal_outside_reviewers.ended_at is 'When it ended; appeals then return to an operator''s re-review.';
comment on column private.legal_outside_reviewers.ended_by is 'Operator who ended it.';
comment on column private.legal_outside_reviewers.end_reason is 'Why it ended.';

alter table private.legal_outside_reviewers enable row level security;
revoke all on private.legal_outside_reviewers from public, anon, authenticated;
grant select on private.legal_outside_reviewers to service_role;

create sequence private.legal_queue_reference_seq;
comment on sequence private.legal_queue_reference_seq is 'The numbers in legal queue references. Numbers are never reused.';

create table app.legal_queue_items (
  id uuid primary key default private.uuid_v7(),
  reference text not null,
  rule_code text not null references private.legal_queue_rules (code),
  title text not null,
  details text,
  requester_contact text,
  tenant_org_id uuid references app.organizations (id) on delete set null,
  subject_person_id uuid references app.people (id),
  related_item_id uuid references app.legal_queue_items (id) on delete set null,
  source_table text,
  source_id uuid,
  received_at timestamptz not null,
  first_response_due_at timestamptz,
  first_response_at timestamptz,
  earliest_action_at timestamptz,
  due_at timestamptz not null,
  extended_at timestamptz,
  extension_reason text,
  item_state app.legal_queue_state not null default 'Received',
  court_action_filed boolean not null default false,
  re_review_same_person boolean,
  outside_reviewer_id uuid references private.legal_outside_reviewers (id),
  legal_hold_id uuid references app.legal_holds (id) on delete set null,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references app.people (id),
  updated_at timestamptz not null default now(),
  constraint legal_queue_items_reference_unique unique (reference),
  constraint legal_queue_items_reference_format check (reference ~ '^LQ-[0-9]{4}-[0-9]{5,}$'),
  constraint legal_queue_items_title_length check (char_length(btrim(title)) between 1 and 200),
  constraint legal_queue_items_details_length check (details is null or char_length(details) <= 4000),
  constraint legal_queue_items_contact_length check (requester_contact is null or char_length(requester_contact) <= 320),
  constraint legal_queue_items_source check ((source_table is null) = (source_id is null)),
  constraint legal_queue_items_due_after_received check (due_at > received_at),
  constraint legal_queue_items_extension check ((extended_at is null) = (extension_reason is null)),
  constraint legal_queue_items_extension_length check (extension_reason is null or char_length(btrim(extension_reason)) between 1 and 1000),
  constraint legal_queue_items_closed check ((closed_at is not null) = (item_state in ('Completed', 'Refused', 'Withdrawn')))
);

create unique index legal_queue_items_one_per_source on app.legal_queue_items (source_table, source_id) where source_id is not null;
create index legal_queue_items_open_idx on app.legal_queue_items (due_at) where closed_at is null;
create index legal_queue_items_closed_idx on app.legal_queue_items (closed_at) where closed_at is not null;
create index legal_queue_items_rule_idx on app.legal_queue_items (rule_code);
create index legal_queue_items_tenant_org_idx on app.legal_queue_items (tenant_org_id);
create index legal_queue_items_subject_idx on app.legal_queue_items (subject_person_id, rule_code);
create index legal_queue_items_related_idx on app.legal_queue_items (related_item_id);
create index legal_queue_items_created_by_idx on app.legal_queue_items (created_by);
create index legal_queue_items_outside_reviewer_idx on app.legal_queue_items (outside_reviewer_id);
create index legal_queue_items_legal_hold_idx on app.legal_queue_items (legal_hold_id);

call private.describe('app.legal_queue_items', 'One piece of legal or security work with its clock (ADR 0167): a data subject request, a DMCA notice or counter-notice, an abuse report or appeal, a security report, an accessibility complaint, a government data request or another written promise. Added by hand in the operator console, or fed from a record the system already creates. Read and written only through the console RPCs, which need legal.queue and a second factor. Never deleted by an operator: a mistake is Withdrawn with a reason.', array[
  'id', 'Item id, UUID v7.',
  'reference', 'What alerts and notes call the item, for example LQ-2026-00001. Carries no personal data.',
  'rule_code', 'Clock rule (private.legal_queue_rules).',
  'title', 'A short description. For a fed item a code: the kind of request, or Marketplace listing, which the console words from its catalog. It reads a listing''s own title from its source, so deleting the org leaves no tenant data here.',
  'details', 'What the matter asks, with no more personal data than the work needs.',
  'requester_contact', 'Who to answer, for an item added by hand. Fed items never hold one; an undelivered notice reads its address live from the outbox.',
  'tenant_org_id', 'Tenant a fed item concerns, or the org a return of omitted data is for. Not org_id: this is the platform''s record, not the tenant''s, so deleting the org clears this link and keeps the evidence the clock was met.',
  'subject_person_id', 'Account a DMCA notice or repeat infringer review is about, which the repeat infringer count reads.',
  'related_item_id', 'The DMCA notice a counter-notice answers.',
  'source_table', 'Table of the record that fed the item; null for an item added by hand. For a moderation notice that reached no one it is the notice''s kind instead, listing.moderated or listing_report.decided, because the record may also have an item of its own.',
  'source_id', 'Record that fed the item: for listing.moderated the decision, for listing_report.decided the report.',
  'received_at', 'When the matter arrived, entered from the message itself; the clock starts here, not at entry.',
  'first_response_due_at', 'When the first response is due, computed from the rule.',
  'first_response_at', 'When the first response was recorded.',
  'earliest_action_at', 'Before this the work may not be done: a DMCA restoration cannot come sooner than the statute allows.',
  'due_at', 'When the work is due, computed from the rule, or entered from the document when the rule says so.',
  'extended_at', 'When the one extension the rule allows was taken.',
  'extension_reason', 'Why it was extended.',
  'item_state', 'Lifecycle state, changed only through app.console_transition_legal_queue_item or the feed.',
  'court_action_filed', 'On a DMCA counter-notice: the notifier told the designated agent of a court action, so the material stays down.',
  're_review_same_person', 'On an appeal that arrived by email: whether the person who made the first decision did the re-review, which the person is told. Null until it is closed.',
  'outside_reviewer_id', 'On an appeal that arrived by email: the outside reviewer who decided it, when one is appointed.',
  'legal_hold_id', 'On a return of omitted data: the legal hold the item placed on the Customer org, which holds its deletion and is released when the item closes. Cleared if the org is later purged.',
  'closed_at', 'When the item reached Completed, Refused or Withdrawn.',
  'created_at', 'When the row was written. Set by the database.',
  'created_by', 'Operator who added the item; null for the feed.',
  'updated_at', 'When the row last changed. Set by the writing function.'
]);

alter table app.legal_queue_items enable row level security;
revoke all on app.legal_queue_items from public, anon, authenticated;
grant all on app.legal_queue_items to service_role;
-- No table privilege for authenticated: the console RPCs are the only way in, because they also need legal.queue and a
-- second factor. The policy is the floor should a grant ever appear.
create policy legal_queue_items_read on app.legal_queue_items for select to authenticated
  using ((select private.is_platform_staff()));

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.legal_queue_items', 'Age', 'closed_at', interval '5 years', 'Delete',
   'Kept 5 years after an item closes, with its log, as evidence a clock was met, past the 3-year US copyright limit and the 5-year Florida limit on written contracts. An open item never expires.');

-- In private, not app: it goes only with its item, so it needs no age of its own. A log entry that aged out by itself could
-- leave an open item with part of its evidence gone.
create table private.legal_queue_events (
  id uuid primary key default private.uuid_v7(),
  legal_queue_item_id uuid not null references app.legal_queue_items (id) on delete cascade,
  event_kind app.legal_queue_event_kind not null,
  from_state app.legal_queue_state,
  to_state app.legal_queue_state,
  note text,
  alert_clock text,
  alert_clock_at timestamptz,
  alert_overdue boolean,
  actor_person_id uuid references app.people (id),
  -- The clock's time, not the transaction's, so entries written together keep their order in the log.
  created_at timestamptz not null default clock_timestamp(),
  constraint legal_queue_events_note_length check (note is null or char_length(note) <= 4000),
  constraint legal_queue_events_alert check ((alert_clock is null) = (alert_clock_at is null) and (alert_clock is null) = (alert_overdue is null)),
  constraint legal_queue_events_alert_clock check (alert_clock in ('First Response', 'Due'))
);

create index legal_queue_events_item_idx on private.legal_queue_events (legal_queue_item_id, created_at);
create index legal_queue_events_actor_idx on private.legal_queue_events (actor_person_id);

comment on table private.legal_queue_events is 'The append-only log of a legal queue item (ADR 0167): when it arrived, who answered, every state change with its reason, each extension, each re-review and each alert sent. Evidence that a clock was met. It goes only with its item, 5 years after the item closes (app.legal_queue_items).';
comment on column private.legal_queue_events.id is 'Event id, UUID v7.';
comment on column private.legal_queue_events.legal_queue_item_id is 'Item.';
comment on column private.legal_queue_events.event_kind is 'What happened.';
comment on column private.legal_queue_events.from_state is 'State before a change.';
comment on column private.legal_queue_events.to_state is 'State after a change.';
comment on column private.legal_queue_events.note is 'What was done, or the reason, in the operator''s words.';
comment on column private.legal_queue_events.alert_clock is 'For an alert: the clock it was about, First Response or Due. The console words it from its catalog.';
comment on column private.legal_queue_events.alert_clock_at is 'For an alert: when that clock ends.';
comment on column private.legal_queue_events.alert_overdue is 'For an alert: whether that clock had already ended.';
comment on column private.legal_queue_events.actor_person_id is 'Operator who did it; null for the feed and the sweep.';
comment on column private.legal_queue_events.created_at is 'When it happened. Set by the database.';

alter table private.legal_queue_events enable row level security;
revoke all on private.legal_queue_events from public, anon, authenticated;
grant select on private.legal_queue_events to service_role;
create trigger t95_append_only before update or delete on private.legal_queue_events
  for each row execute function private.refuse_ledger_change();

-- The lifecycle: every open state may close; closed is closed. It keeps its own rule table, as subscriptions do
-- (0560), because private.transition_lifecycle (0300) needs an org on every row, and an item has none.
create table private.legal_queue_transition_rules (
  from_state app.legal_queue_state not null,
  to_state app.legal_queue_state not null,
  primary key (from_state, to_state)
);
comment on table private.legal_queue_transition_rules is 'The moves a legal queue item may make (ADR 0167). app.console_transition_legal_queue_item refuses any other, with legal_queue_item_transition_not_allowed.';
comment on column private.legal_queue_transition_rules.from_state is 'State the item is in.';
comment on column private.legal_queue_transition_rules.to_state is 'State it may move to.';
alter table private.legal_queue_transition_rules enable row level security;
revoke all on private.legal_queue_transition_rules from public, anon, authenticated;
grant select on private.legal_queue_transition_rules to service_role;

insert into private.legal_queue_transition_rules (from_state, to_state) values
  ('Received', 'In Progress'),
  ('Received', 'Waiting'),
  ('Received', 'Completed'),
  ('Received', 'Refused'),
  ('Received', 'Withdrawn'),
  ('In Progress', 'Waiting'),
  ('In Progress', 'Completed'),
  ('In Progress', 'Refused'),
  ('In Progress', 'Withdrawn'),
  ('Waiting', 'In Progress'),
  ('Waiting', 'Completed'),
  ('Waiting', 'Refused'),
  ('Waiting', 'Withdrawn');

-- Backup contact and outside reviewer ----------------------------------------------------------------------------------

create table private.legal_alert_contacts (
  id uuid primary key default private.uuid_v7(),
  contact_name text not null,
  email text not null,
  added_by uuid not null references app.people (id),
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references app.people (id),
  constraint legal_alert_contacts_name_length check (char_length(btrim(contact_name)) between 1 and 200),
  constraint legal_alert_contacts_email check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 320),
  constraint legal_alert_contacts_removed check ((removed_at is null) = (removed_by is null))
);
create unique index legal_alert_contacts_one_live on private.legal_alert_contacts (email) where removed_at is null;
create index legal_alert_contacts_added_by_idx on private.legal_alert_contacts (added_by);
create index legal_alert_contacts_removed_by_idx on private.legal_alert_contacts (removed_by);

comment on table private.legal_alert_contacts is 'Backup addresses that also receive overdue legal queue alerts (ADR 0167), so one full inbox cannot hide a missed clock. Their emails name references and dates, never the matter. A removed address is kept a year, then the sweep deletes it.';
comment on column private.legal_alert_contacts.id is 'Contact id, UUID v7.';
comment on column private.legal_alert_contacts.contact_name is 'Who this is.';
comment on column private.legal_alert_contacts.email is 'Address, lowercased.';
comment on column private.legal_alert_contacts.added_by is 'Operator who added it.';
comment on column private.legal_alert_contacts.added_at is 'When it was added.';
comment on column private.legal_alert_contacts.removed_at is 'When it was removed; the address then gets no alert.';
comment on column private.legal_alert_contacts.removed_by is 'Operator who removed it.';

alter table private.legal_alert_contacts enable row level security;
revoke all on private.legal_alert_contacts from public, anon, authenticated;
grant select on private.legal_alert_contacts to service_role;

-- Opening, closing and the feeds ---------------------------------------------------------------------------------------

create function private.open_legal_queue_item(
  p_rule_code text,
  p_title text,
  p_received_at timestamptz,
  p_details text default null,
  p_requester_contact text default null,
  p_org_id uuid default null,
  p_subject_person_id uuid default null,
  p_related_item_id uuid default null,
  p_source_table text default null,
  p_source_id uuid default null,
  p_due_at timestamptz default null,
  p_actor uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rule private.legal_queue_rules;
  v_id uuid;
begin
  select * into v_rule from private.legal_queue_rules r where r.code = p_rule_code;
  if v_rule.code is null then
    perform private.refuse('legal_queue_rule', 'Choose what this item is.');
  end if;
  insert into app.legal_queue_items (reference, rule_code, title, details, requester_contact, tenant_org_id,
    subject_person_id, related_item_id, source_table, source_id, received_at, first_response_due_at, earliest_action_at,
    due_at, created_by)
  values (
    format('LQ-%s-%s', extract(year from p_received_at at time zone private.legal_clock_time_zone())::integer,
      lpad(nextval('private.legal_queue_reference_seq')::text, 5, '0')),
    v_rule.code, left(btrim(p_title), 200), nullif(btrim(p_details), ''), nullif(btrim(p_requester_contact), ''),
    p_org_id, p_subject_person_id, p_related_item_id, p_source_table, p_source_id, p_received_at,
    case when v_rule.first_amount is not null then private.legal_clock_end(p_received_at, v_rule.first_amount, v_rule.first_unit) end,
    case when v_rule.earliest_amount is not null then private.legal_clock_end(p_received_at, v_rule.earliest_amount, v_rule.earliest_unit) end,
    case when v_rule.due_from_document then p_due_at else private.legal_clock_end(p_received_at, v_rule.due_amount, v_rule.due_unit) end,
    p_actor)
  -- A console read and the hourly sweep can race to the same record; the second one simply finds it done.
  on conflict (source_table, source_id) where source_id is not null do nothing
  returning id into v_id;
  if v_id is null then
    return null;
  end if;
  insert into private.legal_queue_events (legal_queue_item_id, event_kind, to_state, actor_person_id)
  values (v_id, 'Received', 'Received', p_actor);
  return v_id;
end;
$$;
comment on function private.open_legal_queue_item(text, text, timestamptz, text, text, uuid, uuid, uuid, text, uuid, timestamptz, uuid) is 'Opens a legal queue item: the reference, the first response, earliest and due times computed from the rule (or the due time from the document where the rule says so), and the first log entry. Answers null when a fed record already has its item. Callers authorize first.';
revoke all on function private.open_legal_queue_item(text, text, timestamptz, text, text, uuid, uuid, uuid, text, uuid, timestamptz, uuid) from public, anon, authenticated;

create function private.follow_legal_queue_source(p_item_id uuid, p_state app.legal_queue_state)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.legal_queue_state;
begin
  select i.item_state into v_old from app.legal_queue_items i where i.id = p_item_id for update;
  if v_old is null or v_old = p_state then
    return;
  end if;
  update app.legal_queue_items
  set item_state = p_state,
    closed_at = case when p_state in ('Completed', 'Refused', 'Withdrawn') then now() end,
    updated_at = now()
  where id = p_item_id;
  insert into private.legal_queue_events (legal_queue_item_id, event_kind, from_state, to_state)
  values (p_item_id, 'Source Changed', v_old, p_state);
end;
$$;
comment on function private.follow_legal_queue_source(uuid, app.legal_queue_state) is 'Moves a fed item to the state its source record reached and logs it. A fed item''s state follows its source, and no operator moves it.';
revoke all on function private.follow_legal_queue_source(uuid, app.legal_queue_state) from public, anon, authenticated;

create table private.legal_queue_health (
  id boolean primary key default true,
  last_sweep_at timestamptz,
  feeds_checked_at timestamptz,
  feeds_failing boolean not null default false,
  alert_path_failed_at timestamptz,
  failing_paths text[] not null default '{}',
  constraint legal_queue_health_one check (id)
);
comment on table private.legal_queue_health is 'One row: when the queue''s own machinery last worked (ADR 0167). The queue page and the outside heartbeat (api_public.legal_queue_heartbeat) read it, because a stopped sweep cannot report itself.';
comment on column private.legal_queue_health.id is 'Always true, so there is one row.';
comment on column private.legal_queue_health.last_sweep_at is 'When the hourly sweep last finished.';
comment on column private.legal_queue_health.feeds_checked_at is 'When the feeds last ran.';
comment on column private.legal_queue_health.feeds_failing is 'Whether a feed failed the last time they ran.';
comment on column private.legal_queue_health.alert_path_failed_at is 'When a path last failed inside the sweep, for the banner on the queue page.';
comment on column private.legal_queue_health.failing_paths is 'What failed in the last sweep: operator, backup, reviewer, on_call or purge. Empty when all of it worked; the outside heartbeat reads this.';
alter table private.legal_queue_health enable row level security;
revoke all on private.legal_queue_health from public, anon, authenticated;
grant select on private.legal_queue_health to service_role;
insert into private.legal_queue_health (id) values (true);

create function private.sync_legal_queue_feed(p_feed text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_new integer := 0;
begin
  if p_feed = 'moderation_appeals' then
    -- Open appeals of moderation decisions.
    for v_row in
      select a.id, a.org_id, a.filed_at
      from app.moderation_appeals a
      where a.appeal_state = 'Open' and a.deleted_at is null
        and not exists (select 1 from app.legal_queue_items i
                        where i.source_table = 'app.moderation_appeals' and i.source_id = a.id)
    loop
      if private.open_legal_queue_item('moderation_appeal', 'Marketplace listing', v_row.filed_at, p_org_id => v_row.org_id,
           p_source_table => 'app.moderation_appeals', p_source_id => v_row.id) is not null then
        v_new := v_new + 1;
      end if;
    end loop;

  elsif p_feed = 'listing_reports' then
    -- Open reports of marketplace listings, the abuse reports the platform itself decides.
    for v_row in
      select r.id, o.org_id, r.reported_at
      from app.listing_reports r
      join app.opportunities o on o.id = r.opportunity_id
      where r.deleted_at is null
        and not exists (select 1 from app.moderation_actions m where m.opportunity_id = r.opportunity_id and m.decided_at >= r.reported_at)
        and not exists (select 1 from app.legal_queue_items i
                        where i.source_table = 'app.listing_reports' and i.source_id = r.id)
    loop
      if private.open_legal_queue_item('listing_report', 'Marketplace listing', v_row.reported_at, p_org_id => v_row.org_id,
           p_source_table => 'app.listing_reports', p_source_id => v_row.id) is not null then
        v_new := v_new + 1;
      end if;
    end loop;

  elsif p_feed = 'dsar_requests' then
    -- Open requests in a Customer's register. The title is the kind of request; who asked and what they said stay there.
    -- A request already closed never opens an item, so the Completed Erasure rows an account deletion writes stay out.
    for v_row in
      select d.id, d.org_id, d.received_at, d.request_type
      from app.dsar_requests d
      where d.deleted_at is null and d.dsar_state not in ('Completed', 'Refused', 'Withdrawn')
        and not exists (select 1 from app.legal_queue_items i
                        where i.source_table = 'app.dsar_requests' and i.source_id = d.id)
    loop
      if private.open_legal_queue_item('dsar_customer_register', v_row.request_type::text, v_row.received_at,
           p_org_id => v_row.org_id, p_source_table => 'app.dsar_requests', p_source_id => v_row.id) is not null then
        v_new := v_new + 1;
      end if;
    end loop;

  elsif p_feed = 'moderation_notices' then
    -- The outcome of a moderation decision is told by email when the notification queue cannot reach the person. The
    -- review is stamped told only once the provider took the email (6168). An email that failed for good, or a person
    -- with no address left, opens an item with its own clock, so a person never goes untold in silence.
    update private.moderation_appeal_reviews r set told_at = e.sent_at
    from private.platform_emails e
    where r.notice_email_id = e.id and r.told_at is null and e.send_state = 'Sent';
    for v_row in
      select e.id, e.created_at, e.org_id
      from private.platform_emails e
      where e.template = 'moderation_notice' and e.send_state = 'Failed'
        and not exists (select 1 from app.legal_queue_items i
                        where i.source_table = 'private.platform_emails' and i.source_id = e.id)
    loop
      if private.open_legal_queue_item('undelivered_notice', 'Moderation notice', v_row.created_at, p_org_id => v_row.org_id,
           p_source_table => 'private.platform_emails', p_source_id => v_row.id) is not null then
        v_new := v_new + 1;
      end if;
    end loop;
    for v_row in
      select r.moderation_appeal_id, r.created_at, r.org_id
      from private.moderation_appeal_reviews r
      where r.told_by is null
        and not exists (select 1 from app.legal_queue_items i
                        where i.source_table = 'private.moderation_appeal_reviews' and i.source_id = r.moderation_appeal_id)
    loop
      if private.open_legal_queue_item('undelivered_notice', 'Moderation notice', v_row.created_at, p_org_id => v_row.org_id,
           p_source_table => 'private.moderation_appeal_reviews', p_source_id => v_row.moderation_appeal_id) is not null then
        v_new := v_new + 1;
      end if;
    end loop;

  elsif p_feed = 'sources' then
    -- Open fed items follow their sources.
    for v_row in
      select i.id, i.source_table, i.source_id, i.due_at
      from app.legal_queue_items i where i.source_id is not null and i.closed_at is null
    loop
      if v_row.source_table = 'app.moderation_appeals' then
        perform private.follow_legal_queue_source(v_row.id, x.next_state)
        from (select case when a.id is null or a.deleted_at is not null then 'Withdrawn'
                          when a.appeal_state = 'Open' then 'In Progress' else 'Completed' end::app.legal_queue_state as next_state
              from (select v_row.source_id as id) k
              left join app.moderation_appeals a on a.id = k.id) x
        where x.next_state <> 'In Progress';
      elsif v_row.source_table = 'app.listing_reports' then
        perform private.follow_legal_queue_source(v_row.id,
          case when r.id is null or r.deleted_at is not null then 'Withdrawn' else 'Completed' end::app.legal_queue_state)
        from (select v_row.source_id as id) k
        left join app.listing_reports r on r.id = k.id
        where r.id is null or r.deleted_at is not null or exists (
          select 1 from app.moderation_actions m where m.opportunity_id = r.opportunity_id and m.decided_at >= r.reported_at);
      elsif v_row.source_table = 'app.dsar_requests' then
        perform private.follow_legal_queue_source(v_row.id, x.next_state)
        from (select case when d.id is null or d.deleted_at is not null then 'Withdrawn'
                          when d.dsar_state::text in ('Completed', 'Refused', 'Withdrawn') then d.dsar_state::text
                          when d.dsar_state = 'Received' then 'Received'
                          else 'In Progress' end::app.legal_queue_state as next_state
              from (select v_row.source_id as id) k
              left join app.dsar_requests d on d.id = k.id) x;
        -- An extended request's clock moves with the register's.
        update app.legal_queue_items i set due_at = c.due_at, updated_at = now()
        from app.dsar_request_clock c
        where i.id = v_row.id and c.dsar_request_id = v_row.source_id and c.due_at > i.due_at + interval '1 day' and i.closed_at is null;
        if found then
          insert into private.legal_queue_events (legal_queue_item_id, event_kind)
          values (v_row.id, 'Extended');
        end if;
      elsif v_row.source_table in ('private.platform_emails', 'private.moderation_appeal_reviews', 'listing.moderated', 'listing_report.decided') then
        -- The person deleted their account or the org was purged: the notice went with them, and there is nobody left to tell.
        if not (case v_row.source_table
             when 'private.platform_emails' then exists (select 1 from private.platform_emails e where e.id = v_row.source_id)
             when 'private.moderation_appeal_reviews' then exists (select 1 from private.moderation_appeal_reviews r where r.moderation_appeal_id = v_row.source_id)
             when 'listing.moderated' then exists (select 1 from app.moderation_actions m where m.id = v_row.source_id)
             else exists (select 1 from app.listing_reports r where r.id = v_row.source_id)
           end) then
          perform private.follow_legal_queue_source(v_row.id, 'Withdrawn');
        end if;
      end if;
    end loop;
  end if;
  return v_new;
end;
$$;
comment on function private.sync_legal_queue_feed(text) is 'One feed of the legal queue (ADR 0167), run by private.sync_legal_queue_feeds: opens an item for each record of that feed that has none, or, for sources, moves open fed items to where their records have got to. Returns how many items it opened.';
revoke all on function private.sync_legal_queue_feed(text) from public, anon, authenticated;

create function private.sync_legal_queue_feeds()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_feed text;
  v_new integer := 0;
  v_all_ok boolean := true;
  v_item uuid;
begin
  foreach v_feed in array array['moderation_appeals', 'listing_reports', 'dsar_requests', 'moderation_notices', 'sources'] loop
    begin
      v_new := v_new + private.sync_legal_queue_feed(v_feed);
      -- The feed works again, so a failure item it opened closes by itself.
      for v_item in
        select i.id from app.legal_queue_items i
        where i.rule_code = 'queue_feed_failure' and i.title = v_feed and i.closed_at is null
      loop
        perform private.follow_legal_queue_source(v_item, 'Completed');
      end loop;
    exception when others then
      -- This feed's work rolls back and the rest go on. Its failure becomes an item, so it reaches the owner by the same
      -- alert paths, and the outside heartbeat sees feeds_failing even if opening that item fails too.
      v_all_ok := false;
      begin
        if not exists (select 1 from app.legal_queue_items i
                       where i.rule_code = 'queue_feed_failure' and i.title = v_feed and i.closed_at is null) then
          perform private.open_legal_queue_item('queue_feed_failure', v_feed, now(), p_details => left(sqlerrm, 1000),
            p_source_table => 'private.sync_legal_queue_feeds', p_source_id => private.uuid_v7());
        end if;
      exception when others then
        null;
      end;
    end;
  end loop;
  -- With a where clause, though there is one row: PostgREST's sessions load safeupdate, which refuses an update with none.
  update private.legal_queue_health
  set feeds_checked_at = now(), feeds_failing = not v_all_ok
  where id;
  return v_new;
end;
$$;
comment on function private.sync_legal_queue_feeds() is 'The automatic feed of the legal queue (ADR 0167), only from records the system already creates: moderation appeals, listing reports, requests in a Customer''s data subject register and undelivered moderation notices, and open fed items following their records. Idempotent and safe to race. It never raises: one feed failing leaves the others running and opens a queue_feed_failure item that closes when the feed works again. Runs in the hourly sweep and whenever the console reads the queue. Returns how many items it opened.';
revoke all on function private.sync_legal_queue_feeds() from public, anon, authenticated;

-- People who are no longer part of it ---------------------------------------------------------------------------------

create function private.purge_legal_queue_people()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_contacts integer;
  v_reviewers integer;
  v_emails integer;
begin
  delete from private.legal_alert_contacts c where c.removed_at < now() - interval '1 year';
  get diagnostics v_contacts = row_count;
  delete from private.legal_outside_reviewers o
  where o.ended_at < now() - interval '7 years'
    and not exists (select 1 from private.moderation_appeal_reviews r where r.outside_reviewer_id = o.id)
    and not exists (select 1 from app.legal_queue_items i where i.outside_reviewer_id = o.id);
  get diagnostics v_reviewers = row_count;
  -- The outbox keeps an address for each email. An alert's row is only proof it left. A moderation notice's row is proof the
  -- person was told, so it stays through the six months they may appeal, and a month more. One that failed keeps the words
  -- the operator needs, for only as long as its item is open. A row still waiting is never deleted here.
  delete from private.platform_emails e
  where (e.template = 'legal_clock_alert' and e.send_state in ('Sent', 'Failed')
         and coalesce(e.sent_at, e.created_at) < now() - interval '90 days')
     or (e.template = 'moderation_notice' and e.send_state = 'Sent' and e.sent_at < now() - interval '7 months')
     or (e.template = 'moderation_notice' and e.send_state = 'Failed' and exists (
           select 1 from app.legal_queue_items i
           where i.source_table = 'private.platform_emails' and i.source_id = e.id and i.closed_at is not null));
  get diagnostics v_emails = row_count;
  return v_contacts + v_reviewers + v_emails;
end;
$$;
comment on function private.purge_legal_queue_people() is 'Deletes what the queue keeps about people once its period ends (ADR 0167): backup contacts a year after removal; outside reviewers 7 years after their appointment ended once no decision names them; outbox rows of legal clock alerts 90 days after they ended; moderation notices 7 months after they were sent, or a failed one once its item closes. private.retention_policies governs app tables only, so the hourly sweep calls this. Returns the rows deleted.';
revoke all on function private.purge_legal_queue_people() from public, anon, authenticated;
