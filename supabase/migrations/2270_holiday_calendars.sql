-- 2270_holiday_calendars.sql
--
-- A134 (RRR-196), Section 4.5.6 Payroll and Time Off (trace S4.5.6-26), ADR 0112. Settings, Payroll and Time Off edits
-- earning codes, time off policies and holiday calendars (org.payroll.write, 0203). This adds the calendars:
--   * app.holiday_calendars: an org's named calendars, each optionally for one ISO 3166-2 subdivision (US-CA). A
--     calendar applies to the org, at most one per subdivision plus one with none, or to the venues it is assigned to
--     (app.holiday_calendar_venues, one calendar per venue).
--   * app.holidays: the dated holidays of a calendar, one per day, with the hours a holiday pays (0 observes it unpaid).
--   * Which calendar governs work on a project: its venue's calendar; else the org's calendar for the subdivision whose
--     wage-hour law governs the work (private.labor_subdivision, 1384); else the org's calendar with no subdivision.
--     Time off names no place, so a request counts its days on the org's calendar with no subdivision.
--   * app.time_off_day_count, a computed field of app.time_off_requests: the days a request spans less the holidays on
--     that calendar. Every day counts otherwise; productions work weekends (ADR 0112).
--   * app.earning_codes.is_holiday: the code holiday pay is paid under (2271). A code is never both overtime and
--     holiday, and app.calculate_payroll_run's regular code is never a holiday code.
--   * Retired calendars and removed holidays go to Trash (ADR 0110); venue assignments, which have no title, do not.
-- Time off policies were written under org.time_attendance.write since 0341; the API (catalog/capabilities.ts) and the
-- capability's own description put them under org.payroll.write, the capability of the settings page that edits them,
-- so the write policy now asks for that.

-- 1. Earning codes that pay holidays ----------------------------------------------------------------------------------------

alter table app.earning_codes add column is_holiday boolean not null default false,
  add constraint earning_codes_kind check (not (is_overtime and is_holiday));

comment on column app.earning_codes.is_holiday is 'True when holiday pay is paid under the code (app.calculate_payroll_run, 2271). Never true with is_overtime.';

-- 2. Calendars and holidays ---------------------------------------------------------------------------------------------------

create table app.holiday_calendars (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  subdivision_code text,
  applies_to_org boolean not null default false,
  deleted_at timestamptz,
  constraint holiday_calendars_name_length check (char_length(btrim(name)) between 1 and 100),
  constraint holiday_calendars_subdivision_code_format check (subdivision_code is null or subdivision_code ~ '^[A-Z]{2}-[A-Z0-9]{1,3}$')
);

create unique index holiday_calendars_org_name_key on app.holiday_calendars (org_id, lower(name)) where deleted_at is null;
create unique index holiday_calendars_org_applies_key on app.holiday_calendars (org_id, coalesce(subdivision_code, ''))
  where applies_to_org and deleted_at is null;

call private.install_domain_table('app.holiday_calendars');
call private.describe('app.holiday_calendars', 'Holiday calendars of an org (Section 4.5.6). A calendar applies to the org (at most one per subdivision and one with none) or to the venues assigned to it; time off day counts and holiday pay read the calendar that governs the work (ADR 0112).', array[
  'name', 'Calendar name, such as United States or California.',
  'subdivision_code', 'ISO 3166-2 subdivision the calendar is for, such as US-CA; NULL when it is for no one subdivision. An org calendar for a subdivision governs work under that subdivision''s wage-hour law.',
  'applies_to_org', 'True when the calendar applies across the org: the one with no subdivision everywhere, one with a subdivision to work there. Venue assignments take precedence.'
]);

create table app.holiday_calendar_venues (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  holiday_calendar_id uuid not null references app.holiday_calendars (id),
  venue_id uuid not null references app.venues (id),
  deleted_at timestamptz
);

create index holiday_calendar_venues_calendar_idx on app.holiday_calendar_venues (holiday_calendar_id);
create unique index holiday_calendar_venues_venue_key on app.holiday_calendar_venues (venue_id) where deleted_at is null;

call private.install_domain_table('app.holiday_calendar_venues', 'app.holiday_calendars', 'holiday_calendar_id', array['app.venues', 'venue_id']);
call private.describe('app.holiday_calendar_venues', 'Venues a holiday calendar is assigned to. A venue has at most one calendar, which governs work on its projects ahead of the org''s calendars.', array[
  'holiday_calendar_id', 'Calendar assigned.',
  'venue_id', 'Venue the calendar governs.'
]);

create table app.holidays (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  holiday_calendar_id uuid not null references app.holiday_calendars (id),
  observed_on date not null,
  name text not null,
  paid_hours numeric not null default 8,
  deleted_at timestamptz,
  constraint holidays_name_length check (char_length(btrim(name)) between 1 and 100),
  constraint holidays_paid_hours_range check (paid_hours >= 0 and paid_hours <= 24)
);

create unique index holidays_calendar_day_key on app.holidays (holiday_calendar_id, observed_on) where deleted_at is null;

call private.install_domain_table('app.holidays', 'app.holiday_calendars', 'holiday_calendar_id');
call private.describe('app.holidays', 'Dated holidays of a holiday calendar, one per day. A time off request does not count a holiday on its calendar as a day off, and a payroll run pays the paid hours of each holiday on the calendar of the work under the org''s holiday earning code.', array[
  'holiday_calendar_id', 'Calendar the holiday is on.',
  'observed_on', 'Day the holiday is observed.',
  'name', 'Holiday name, such as Independence Day.',
  'paid_hours', 'Hours of holiday pay for the day; 0 observes it unpaid.'
]);

call private.install_policies('app.holiday_calendars',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.payroll.write'))$$);
call private.install_policies('app.holiday_calendar_venues',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.payroll.write'))$$);
call private.install_policies('app.holidays',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.payroll.write'))$$);

call private.install_audit_trail('app.holiday_calendars');
call private.install_audit_trail('app.holiday_calendar_venues');
call private.install_audit_trail('app.holidays');

-- Holidays decide holiday pay, so their calendars are kept as payroll records are (Section 14.3).
insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.holiday_calendars', 'Soft Deleted', 'deleted_at', interval '7 years', 'Delete', 'Soft-deleted business records kept 7 years (US records default; payroll per Section 14.3).'),
  ('app.holiday_calendar_venues', 'Soft Deleted', 'deleted_at', interval '7 years', 'Delete', 'Soft-deleted business records kept 7 years (US records default; payroll per Section 14.3).'),
  ('app.holidays', 'Soft Deleted', 'deleted_at', interval '7 years', 'Delete', 'Soft-deleted business records kept 7 years (US records default; payroll per Section 14.3).')
on conflict (table_name) do nothing;

-- Time off policies are edited where earning codes are: Settings, Payroll and Time Off (org.payroll.write).
call private.install_policies('app.time_off_policies',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.payroll.write'))$$);

-- 3. The calendar of the work ---------------------------------------------------------------------------------------------------

create or replace function private.org_holiday_calendar_id(p_org_id uuid, p_subdivision text default null)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id from app.holiday_calendars c
  where c.org_id = p_org_id and c.applies_to_org and c.deleted_at is null
    and (c.subdivision_code is null or c.subdivision_code = p_subdivision)
  order by c.subdivision_code is null, c.id
  limit 1;
$$;

comment on function private.org_holiday_calendar_id(uuid, text) is 'The org''s holiday calendar for a subdivision: the org calendar for that subdivision, else the org calendar with none. NULL when the org has neither. With no subdivision, the org calendar with none.';
revoke all on function private.org_holiday_calendar_id(uuid, text) from public, anon, authenticated;

create or replace function private.project_holiday_calendar_id(p_project_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select a.holiday_calendar_id from app.projects p
     join app.holiday_calendar_venues a on a.venue_id = p.venue_id and a.deleted_at is null
     join app.holiday_calendars c on c.id = a.holiday_calendar_id and c.deleted_at is null
     where p.id = p_project_id),
    (select private.org_holiday_calendar_id(p.org_id, private.labor_subdivision(p.id)) from app.projects p where p.id = p_project_id));
$$;

comment on function private.project_holiday_calendar_id(uuid) is 'The holiday calendar that governs work on a project: its venue''s calendar, else the org calendar for the subdivision whose wage-hour law governs the work (private.labor_subdivision), else the org calendar with no subdivision. NULL when none applies.';
revoke all on function private.project_holiday_calendar_id(uuid) from public, anon, authenticated;

-- 4. Time off day counts -------------------------------------------------------------------------------------------------------
-- A computed field (PostgREST reads it as a column of time_off_requests). It runs with the caller's rights: whoever reads
-- the request is a member of its org and so reads the org's calendars.

create or replace function app.time_off_day_count(p_request app.time_off_requests)
returns integer
language sql
stable
set search_path = ''
as $$
  select (p_request.ends_on - p_request.starts_on + 1) - (
    select count(*)::integer from app.holidays h
    join app.holiday_calendars c on c.id = h.holiday_calendar_id
    where c.org_id = p_request.org_id and c.applies_to_org and c.subdivision_code is null and c.deleted_at is null
      and h.deleted_at is null and h.observed_on between p_request.starts_on and p_request.ends_on);
$$;

comment on function app.time_off_day_count(app.time_off_requests) is 'Computed field: the days a time off request takes, every day from its first to its last less the holidays on the org''s holiday calendar with no subdivision (time off names no place). Runs with the caller''s rights.';
revoke all on function app.time_off_day_count(app.time_off_requests) from public, anon;
grant execute on function app.time_off_day_count(app.time_off_requests) to authenticated, service_role;

-- 5. Trash ---------------------------------------------------------------------------------------------------------------------
-- ADR 0110: a retired calendar or a removed holiday is a mistake an editor can undo, and the tables' update policies let
-- those who removed it restore it, so both go to Trash, titled by name. A venue assignment has no title column and stays
-- out; it is assigned again.

select private.sync_trash_tables();
