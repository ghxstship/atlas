-- 1385_osha_recordkeeping.sql
-- A82 compliance flows (RRR-127), finding A65-014 (Section 14.5: OSHA Forms 300, 300A and 301). Incidents (0353) record
-- what happened on a project, not the recordkeeping 29 CFR Part 1904 asks for, so nothing could fill the forms. This
-- migration adds the fields of the official forms, and only those (OSHA Forms 300, 300A and 301, Rev. 04/2004, OMB
-- 1218-0176, from https://www.osha.gov/sites/default/files/OSHA-RK-Forms-Package.pdf; ADR 0041 maps each column):
--   * app.osha_establishments: the establishment of the 300 header and the 300A "Establishment information" block;
--   * app.osha_cases: one recordable case, the Form 300 row (columns A to M) and the Form 301 report (items 1 to 18 and
--     "Completed by"), optionally linked to the incident it came from. A privacy concern case (1904.29(b)(6)) prints
--     "privacy case" in place of the name. Days away and days of restriction stop counting at 180 together;
--   * app.osha_annual_summaries: the 300A employment information and certification of a year;
--   * app.osha_summary: the 300A totals (columns G to M), with no names, for anyone who reads incidents;
--   * app.osha_employment_estimate: hours worked and average employees from approved time entries and payroll runs, which
--     the 300A worksheet asks for when the figures are not at hand.
-- Cases carry health information: only holders of data.restricted.read.medical read them, and those who may also sign off
-- incidents (safety.incident.close) write them. Every change is in the audit trail.

-- Establishments -------------------------------------------------------------------------------------------------------

create table app.osha_establishments (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  street_address text,
  locality text,
  region_code text,
  postal_code text,
  naics_code text,
  industry_description text,
  deleted_at timestamptz,
  constraint osha_establishments_name check (char_length(btrim(name)) between 1 and 200),
  constraint osha_establishments_street check (street_address is null or char_length(btrim(street_address)) between 1 and 200),
  constraint osha_establishments_locality check (locality is null or char_length(btrim(locality)) between 1 and 100),
  constraint osha_establishments_region check (region_code is null or region_code ~ '^[A-Z]{2}$'),
  constraint osha_establishments_postal check (postal_code is null or postal_code ~ '^[0-9]{5}(-[0-9]{4})?$'),
  constraint osha_establishments_naics check (naics_code is null or naics_code ~ '^[0-9]{2,6}$'),
  constraint osha_establishments_industry check (industry_description is null or char_length(btrim(industry_description)) between 1 and 200)
);

create unique index osha_establishments_org_name_key on app.osha_establishments (org_id, lower(name)) where deleted_at is null;

call private.install_domain_table('app.osha_establishments');
call private.describe('app.osha_establishments', 'Establishments whose OSHA injury and illness records an org keeps (29 CFR 1904.30): the Form 300 header and the Form 300A establishment information.', array[
  'name', 'Establishment name (Form 300 header, Form 300A "Your establishment name").',
  'street_address', 'Street (Form 300A).',
  'locality', 'City (Forms 300 and 300A).',
  'region_code', 'State, two letters (Forms 300 and 300A).',
  'postal_code', 'ZIP code (Form 300A).',
  'naics_code', 'North American Industrial Classification (NAICS), if known (Form 300A).',
  'industry_description', 'Industry description (Form 300A).'
]);
call private.install_policies('app.osha_establishments',
  $$org_id in (select private.orgs_with_capability('safety.incident.read'))$$,
  $$org_id in (select private.orgs_with_capability('safety.incident.close'))$$);
call private.install_audit_trail('app.osha_establishments');

-- Cases --------------------------------------------------------------------------------------------------------------

create table app.osha_cases (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  establishment_id uuid not null references app.osha_establishments (id),
  incident_id uuid references app.incidents (id),
  log_year smallint not null,
  case_number text not null default '',
  person_id uuid references app.people (id),
  employee_name text,
  privacy_case boolean not null default false,
  job_title text not null,
  injury_date date not null,
  event_location text not null,
  description text not null,
  outcome text not null,
  days_away smallint not null default 0,
  days_restricted smallint not null default 0,
  case_type text not null,
  employee_street text,
  employee_locality text,
  employee_region text,
  employee_postal_code text,
  date_of_birth date,
  date_hired date,
  employee_sex text,
  health_care_professional text,
  treatment_facility text,
  facility_street text,
  facility_locality text,
  facility_region text,
  facility_postal_code text,
  emergency_room boolean,
  hospitalized_overnight boolean,
  work_began_at time,
  event_time time,
  event_time_unknown boolean not null default false,
  activity_before text,
  what_happened text,
  injury_detail text,
  harmful_object text,
  died_on date,
  completed_by uuid references app.people (id),
  completed_title text,
  completed_phone text,
  completed_on date,
  deleted_at timestamptz,
  constraint osha_cases_employee check (person_id is not null or employee_name is not null),
  constraint osha_cases_employee_name check (employee_name is null or char_length(btrim(employee_name)) between 1 and 200),
  constraint osha_cases_case_number check (char_length(case_number) <= 20),
  constraint osha_cases_year check (log_year between 2000 and 2200),
  constraint osha_cases_job_title check (char_length(btrim(job_title)) between 1 and 100),
  constraint osha_cases_event_location check (char_length(btrim(event_location)) between 1 and 200),
  constraint osha_cases_description check (char_length(btrim(description)) between 1 and 500),
  constraint osha_cases_outcome check (outcome in ('Death', 'Days away from work', 'Job transfer or restriction', 'Other recordable case')),
  constraint osha_cases_case_type check (case_type in ('Injury', 'Skin disorder', 'Respiratory condition', 'Poisoning', 'Hearing loss', 'All other illnesses')),
  constraint osha_cases_days check (days_away between 0 and 180 and days_restricted between 0 and 180 and days_away + days_restricted <= 180),
  constraint osha_cases_days_outcome check ((outcome <> 'Job transfer or restriction' or days_away = 0)
    and (outcome <> 'Other recordable case' or (days_away = 0 and days_restricted = 0))),
  constraint osha_cases_death check (died_on is null or outcome = 'Death'),
  constraint osha_cases_sex check (employee_sex is null or employee_sex in ('Male', 'Female')),
  constraint osha_cases_regions check ((employee_region is null or employee_region ~ '^[A-Z]{2}$') and (facility_region is null or facility_region ~ '^[A-Z]{2}$')),
  constraint osha_cases_postal check ((employee_postal_code is null or employee_postal_code ~ '^[0-9]{5}(-[0-9]{4})?$')
    and (facility_postal_code is null or facility_postal_code ~ '^[0-9]{5}(-[0-9]{4})?$')),
  constraint osha_cases_text_lengths check (
    coalesce(char_length(employee_street), 0) <= 200 and coalesce(char_length(employee_locality), 0) <= 100
    and coalesce(char_length(health_care_professional), 0) <= 200 and coalesce(char_length(treatment_facility), 0) <= 200
    and coalesce(char_length(facility_street), 0) <= 200 and coalesce(char_length(facility_locality), 0) <= 100
    and coalesce(char_length(activity_before), 0) <= 2000 and coalesce(char_length(what_happened), 0) <= 2000
    and coalesce(char_length(injury_detail), 0) <= 2000 and coalesce(char_length(harmful_object), 0) <= 500
    and coalesce(char_length(completed_title), 0) <= 100 and coalesce(char_length(completed_phone), 0) <= 30),
  constraint osha_cases_event_time check (not (event_time_unknown and event_time is not null))
);

create unique index osha_cases_number_key on app.osha_cases (establishment_id, log_year, case_number) where deleted_at is null;
create index osha_cases_establishment_year_idx on app.osha_cases (establishment_id, log_year);
create index osha_cases_incident_idx on app.osha_cases (incident_id);
create index osha_cases_person_idx on app.osha_cases (person_id);
create index osha_cases_completed_by_idx on app.osha_cases (completed_by);

call private.install_domain_table('app.osha_cases', 'app.osha_establishments', 'establishment_id', array['app.incidents', 'incident_id']);
call private.describe('app.osha_cases', 'Recordable work-related injuries and illnesses (29 CFR Part 1904): each row is a Form 300 log entry and its Form 301 incident report. Health information: read with data.restricted.read.medical.', array[
  'establishment_id', 'Establishment whose log the case is on.',
  'incident_id', 'Incident the case came from, when there is one.',
  'log_year', 'Year of the log; the year of the injury or illness date. Set by the database.',
  'case_number', 'Case no. (Form 300 column A, Form 301 item 10). Numbered per establishment and year by the database when left empty.',
  'person_id', 'The employee, when they are a person in XOS.',
  'employee_name', 'Employee''s full name when they are not a person in XOS (Form 300 column B, Form 301 item 1).',
  'privacy_case', 'A privacy concern case (29 CFR 1904.29(b)(6) to (9)): the log prints "privacy case" in place of the name.',
  'job_title', 'Job title (Form 300 column C).',
  'injury_date', 'Date of injury or onset of illness (Form 300 column D, Form 301 item 11).',
  'event_location', 'Where the event occurred (Form 300 column E).',
  'description', 'Injury or illness, parts of body affected, and object or substance that directly injured or made the person ill (Form 300 column F).',
  'outcome', 'Most serious outcome: Death, Days away from work, Job transfer or restriction, or Other recordable case (Form 300 columns G to J).',
  'days_away', 'Days away from work (Form 300 column K). Counting stops at 180 together with days_restricted.',
  'days_restricted', 'Days on job transfer or restriction (Form 300 column L).',
  'case_type', 'Injury, Skin disorder, Respiratory condition, Poisoning, Hearing loss or All other illnesses (Form 300 column M).',
  'employee_street', 'Employee''s street (Form 301 item 2).',
  'employee_locality', 'Employee''s city (Form 301 item 2).',
  'employee_region', 'Employee''s state, two letters (Form 301 item 2).',
  'employee_postal_code', 'Employee''s ZIP code (Form 301 item 2).',
  'date_of_birth', 'Date of birth (Form 301 item 3).',
  'date_hired', 'Date hired (Form 301 item 4).',
  'employee_sex', 'Male or Female, as Form 301 item 5 asks.',
  'health_care_professional', 'Name of physician or other health care professional (Form 301 item 6).',
  'treatment_facility', 'Facility where treatment was given away from the worksite (Form 301 item 7).',
  'facility_street', 'Facility street (Form 301 item 7).',
  'facility_locality', 'Facility city (Form 301 item 7).',
  'facility_region', 'Facility state, two letters (Form 301 item 7).',
  'facility_postal_code', 'Facility ZIP code (Form 301 item 7).',
  'emergency_room', 'Was the employee treated in an emergency room (Form 301 item 8).',
  'hospitalized_overnight', 'Was the employee hospitalized overnight as an in-patient (Form 301 item 9).',
  'work_began_at', 'Time the employee began work (Form 301 item 12).',
  'event_time', 'Time of event (Form 301 item 13).',
  'event_time_unknown', 'The time of the event cannot be determined (Form 301 item 13).',
  'activity_before', 'What the employee was doing just before the incident occurred, with no personally identifiable information (Form 301 item 14).',
  'what_happened', 'How the injury occurred (Form 301 item 15).',
  'injury_detail', 'The injury or illness: part of the body affected and how (Form 301 item 16).',
  'harmful_object', 'Object or substance that directly harmed the employee (Form 301 item 17).',
  'died_on', 'Date of death, if the employee died (Form 301 item 18).',
  'completed_by', 'Person who completed the Form 301.',
  'completed_title', 'Title of the person who completed the Form 301.',
  'completed_phone', 'Phone of the person who completed the Form 301.',
  'completed_on', 'Date the Form 301 was completed.'
]);
call private.install_policies('app.osha_cases',
  $$org_id in (select private.orgs_with_capability('data.restricted.read.medical'))$$,
  $$org_id in (select private.orgs_with_capability('data.restricted.read.medical'))
    and org_id in (select private.orgs_with_capability('safety.incident.close'))$$);
call private.install_audit_trail('app.osha_cases');

create or replace function private.guard_osha_case()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.log_year := extract(year from new.injury_date)::smallint;
  if new.person_id is not null and not exists (
    select 1 from app.memberships m where m.person_id = new.person_id and m.org_id = new.org_id) then
    perform private.refuse('osha_case_person', 'The employee on a case is a member of the org; name anyone else in employee_name.');
  end if;
  if tg_op = 'INSERT' or new.establishment_id <> old.establishment_id or new.log_year <> old.log_year then
    if btrim(new.case_number) = '' or (tg_op = 'UPDATE' and new.case_number = old.case_number) then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('osha_cases:' || new.establishment_id::text || ':' || new.log_year::text, 0));
      new.case_number := lpad((coalesce((select max(c.case_number::integer) from app.osha_cases c
        where c.establishment_id = new.establishment_id and c.log_year = new.log_year and c.case_number ~ '^[0-9]{1,9}$'
          and c.id <> new.id), 0) + 1)::text, 3, '0');
    end if;
  end if;
  new.case_number := btrim(new.case_number);
  return new;
end;
$$;

comment on function private.guard_osha_case() is 'OSHA cases: the log year is the year of the injury date; the case number is the next on the establishment''s log for that year when left empty; the employee, when a person, is a member of the org.';
revoke all on function private.guard_osha_case() from public, anon, authenticated;

create trigger t40_guard_osha_case before insert or update on app.osha_cases
  for each row execute function private.guard_osha_case();

-- Annual summaries -------------------------------------------------------------------------------------------------------

create table app.osha_annual_summaries (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  establishment_id uuid not null references app.osha_establishments (id),
  log_year smallint not null,
  annual_average_employees integer,
  total_hours_worked bigint,
  certified_by uuid references app.people (id),
  certifier_title text,
  certifier_phone text,
  certified_on date,
  deleted_at timestamptz,
  constraint osha_annual_summaries_year check (log_year between 2000 and 2200),
  constraint osha_annual_summaries_figures check ((annual_average_employees is null or annual_average_employees >= 0)
    and (total_hours_worked is null or total_hours_worked >= 0)),
  constraint osha_annual_summaries_certifier check (coalesce(char_length(certifier_title), 0) <= 100 and coalesce(char_length(certifier_phone), 0) <= 30)
);

create unique index osha_annual_summaries_key on app.osha_annual_summaries (establishment_id, log_year) where deleted_at is null;
create index osha_annual_summaries_certified_by_idx on app.osha_annual_summaries (certified_by);

call private.install_domain_table('app.osha_annual_summaries', 'app.osha_establishments', 'establishment_id');
call private.describe('app.osha_annual_summaries', 'The Form 300A of an establishment and year: employment information and the company executive''s certification. The case totals come from app.osha_summary.', array[
  'establishment_id', 'Establishment summarized.',
  'log_year', 'Year summarized.',
  'annual_average_employees', 'Annual average number of employees (Form 300A).',
  'total_hours_worked', 'Total hours worked by all employees last year (Form 300A).',
  'certified_by', 'Company executive who certified the summary (Form 300A "Sign here").',
  'certifier_title', 'Title of the company executive (Form 300A).',
  'certifier_phone', 'Phone (Form 300A).',
  'certified_on', 'Date of the certification (Form 300A).'
]);
call private.install_policies('app.osha_annual_summaries',
  $$org_id in (select private.orgs_with_capability('safety.incident.read'))$$,
  $$org_id in (select private.orgs_with_capability('safety.incident.close'))$$);
call private.install_audit_trail('app.osha_annual_summaries');

-- Classification -----------------------------------------------------------------------------------------------------------

insert into private.column_classifications (table_name, column_name, classification, read_capability)
select 'app.osha_cases', c, 'Confidential', null
from unnest(array['person_id', 'employee_name', 'privacy_case', 'job_title', 'injury_date', 'event_location', 'description',
  'outcome', 'days_away', 'days_restricted', 'case_type', 'employee_street', 'employee_locality', 'employee_region',
  'employee_postal_code', 'date_of_birth', 'date_hired', 'employee_sex', 'health_care_professional', 'treatment_facility',
  'facility_street', 'facility_locality', 'facility_region', 'facility_postal_code', 'emergency_room', 'hospitalized_overnight',
  'work_began_at', 'event_time', 'event_time_unknown', 'activity_before', 'what_happened', 'injury_detail', 'harmful_object',
  'died_on']) as c
on conflict do nothing;

-- The 300A totals ------------------------------------------------------------------------------------------------------------

create or replace function app.osha_summary(p_establishment_id uuid, p_year integer)
returns table (
  deaths integer,
  days_away_cases integer,
  restricted_cases integer,
  other_cases integer,
  days_away integer,
  days_restricted integer,
  injuries integer,
  skin_disorders integer,
  respiratory_conditions integer,
  poisonings integer,
  hearing_loss integer,
  other_illnesses integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_org uuid := (select e.org_id from app.osha_establishments e where e.id = p_establishment_id and e.deleted_at is null);
begin
  if v_org is null or not private.has_capability(v_org, 'safety.incident.read') then
    raise exception using errcode = '42501', message = 'safety.incident.read is required';
  end if;
  return query
  select
    count(*) filter (where c.outcome = 'Death')::integer,
    count(*) filter (where c.outcome = 'Days away from work')::integer,
    count(*) filter (where c.outcome = 'Job transfer or restriction')::integer,
    count(*) filter (where c.outcome = 'Other recordable case')::integer,
    coalesce(sum(c.days_away), 0)::integer,
    coalesce(sum(c.days_restricted), 0)::integer,
    count(*) filter (where c.case_type = 'Injury')::integer,
    count(*) filter (where c.case_type = 'Skin disorder')::integer,
    count(*) filter (where c.case_type = 'Respiratory condition')::integer,
    count(*) filter (where c.case_type = 'Poisoning')::integer,
    count(*) filter (where c.case_type = 'Hearing loss')::integer,
    count(*) filter (where c.case_type = 'All other illnesses')::integer
  from app.osha_cases c
  where c.establishment_id = p_establishment_id and c.log_year = p_year and c.deleted_at is null;
end;
$$;

comment on function app.osha_summary(uuid, integer) is 'The Form 300A totals of an establishment''s log for a year: cases by outcome (columns G to J), days away and of restriction (K, L) and cases by type (M). No names, so anyone who reads incidents (safety.incident.read) may read it, as employees may read the posted summary.';
revoke all on function app.osha_summary(uuid, integer) from public, anon;
grant execute on function app.osha_summary(uuid, integer) to authenticated, service_role;

create or replace function app.osha_employment_estimate(p_org_id uuid, p_year integer)
returns table (total_hours_worked bigint, annual_average_employees integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not private.has_capability(p_org_id, 'safety.incident.close') then
    raise exception using errcode = '42501', message = 'safety.incident.close is required';
  end if;
  return query
  select
    (select ceil(coalesce(sum(greatest(0, extract(epoch from (e.clock_out - e.clock_in)) / 60 - e.break_minutes)), 0) / 60.0)::bigint
     from app.time_entries e
     where e.org_id = p_org_id and e.deleted_at is null and e.clock_out is not null
       and e.clock_in >= make_date(p_year, 1, 1)::timestamptz and e.clock_in < make_date(p_year + 1, 1, 1)::timestamptz),
    (select ceil(coalesce(avg(k.paid), 0))::integer from (
       select count(distinct l.membership_id) as paid
       from app.pay_periods pp
       left join app.payroll_runs r on r.pay_period_id = pp.id and r.deleted_at is null
       left join app.payroll_lines l on l.payroll_run_id = r.id and l.deleted_at is null
       where pp.org_id = p_org_id and pp.deleted_at is null
         and pp.ends_on >= make_date(p_year, 1, 1) and pp.ends_on < make_date(p_year + 1, 1, 1)
       group by pp.id) k);
end;
$$;

comment on function app.osha_employment_estimate(uuid, integer) is 'The Form 300A worksheet figures from XOS data for a year: total hours worked from time entries (breaks removed, rounded up) and the average number of people paid per pay period (rounded up). A starting point for the summary, which the org confirms. Needs safety.incident.close.';
revoke all on function app.osha_employment_estimate(uuid, integer) from public, anon;
grant execute on function app.osha_employment_estimate(uuid, integer) to authenticated, service_role;
