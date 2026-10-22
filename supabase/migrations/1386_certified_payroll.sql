-- 1386_certified_payroll.sql
-- A82 compliance flows (RRR-127), finding A65-014 (Section 14.5: certified payroll in WH-347 format). The fields come from
-- Form WH-347 (Rev. January 2025, OMB 1235-0008, https://www.dol.gov/agencies/whd/forms/wh347) and its instructions; ADR
-- 0041 maps each column to its source. This migration adds what the form needs and XOS did not hold, and the export:
--   * app.certified_payroll_projects: the header of a covered project: contract number, wage determination numbers,
--     prime contractor or subcontractor, the legal business name and address, and the project location;
--   * app.registered_apprentices: a worker paid as a registered apprentice (column 2, RA) and the program the Statement of
--     Compliance names (OA or SAA registration, labor classification, progression level);
--   * app.certified_payroll_submissions: each weekly payroll issued for a project, numbered from 1 (Certified Payroll No.),
--     with the final-submission mark;
--   * app.certified_payroll: the rows of one project's week: worker entry number, name, a worker identifying number (never
--     a social security number), J or RA, labor classification, straight and overtime hours of each day, the rates, gross
--     pay on the project and for all work. Hours come from time entries on approved timesheets; overtime is split by
--     private.split_work_minutes (1384) over all of the worker's projects in the week, as the Contract Work Hours and
--     Safety Standards Act counts hours over 40 on and off the site. Pay rates are Restricted, so the export needs the
--     restricted export capability and step-up authentication and is written to the audit log.
-- Fringe benefit credits and payments in lieu (6B, 6C), deductions (8) and net pay (9) come from the payroll provider:
-- XOS holds none of them, so the export leaves those columns empty and says so.

-- Project header -----------------------------------------------------------------------------------------------------------

create table app.certified_payroll_projects (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  contract_number text not null,
  wage_determinations text not null,
  contractor_role text not null default 'Prime contractor',
  business_name text not null,
  business_address text not null,
  project_location text not null,
  deleted_at timestamptz,
  constraint certified_payroll_projects_contract check (char_length(btrim(contract_number)) between 1 and 100),
  constraint certified_payroll_projects_wd check (char_length(btrim(wage_determinations)) between 1 and 500),
  constraint certified_payroll_projects_role check (contractor_role in ('Prime contractor', 'Subcontractor')),
  constraint certified_payroll_projects_business check (char_length(btrim(business_name)) between 1 and 200 and char_length(btrim(business_address)) between 1 and 300),
  constraint certified_payroll_projects_location check (char_length(btrim(project_location)) between 1 and 300)
);

create unique index certified_payroll_projects_project_key on app.certified_payroll_projects (project_id) where deleted_at is null;

call private.install_domain_table('app.certified_payroll_projects', 'app.projects', 'project_id');
call private.describe('app.certified_payroll_projects', 'The WH-347 header of a project covered by the Davis-Bacon and Related Acts.', array[
  'project_id', 'Project covered.',
  'contract_number', 'Project No. or Contract No.',
  'wage_determinations', 'Wage Determination No.: every wage determination and revision number that applies, as written on the form.',
  'contractor_role', 'Prime contractor or Subcontractor, as the form''s check boxes ask.',
  'business_name', 'Prime contractor''s or subcontractor''s legal business name.',
  'business_address', 'Prime contractor''s or subcontractor''s business address.',
  'project_location', 'Project location: the full address, or at least the county and state.'
]);
call private.install_policies('app.certified_payroll_projects',
  $$org_id in (select private.orgs_with_capability('crew.payroll.export'))$$,
  $$org_id in (select private.orgs_with_capability('crew.payroll.export'))$$);
call private.install_audit_trail('app.certified_payroll_projects');

-- Registered apprentices -----------------------------------------------------------------------------------------------------

create table app.registered_apprentices (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  membership_id uuid not null references app.memberships (id),
  program_name text not null,
  registered_with text not null,
  labor_classification text not null,
  progression_level text,
  valid_from date not null,
  valid_to date,
  deleted_at timestamptz,
  constraint registered_apprentices_program check (char_length(btrim(program_name)) between 1 and 200),
  constraint registered_apprentices_registry check (registered_with in ('OA', 'SAA')),
  constraint registered_apprentices_classification check (char_length(btrim(labor_classification)) between 1 and 200),
  constraint registered_apprentices_level check (progression_level is null or char_length(btrim(progression_level)) between 1 and 50),
  constraint registered_apprentices_dates check (valid_to is null or valid_to >= valid_from)
);

create index registered_apprentices_membership_idx on app.registered_apprentices (membership_id, valid_from);

call private.install_domain_table('app.registered_apprentices', 'app.memberships', 'membership_id');
call private.describe('app.registered_apprentices', 'Workers paid as registered apprentices (WH-347 column 2, RA) and their programs (Statement of Compliance, page 2).', array[
  'membership_id', 'Membership of the apprentice.',
  'program_name', 'Apprenticeship program name.',
  'registered_with', 'OA (Office of Apprenticeship) or SAA (State Apprenticeship Agency).',
  'labor_classification', 'Registered name of the labor classification.',
  'progression_level', 'Apprentice''s progression level, printed with RA.',
  'valid_from', 'First day of the registration.',
  'valid_to', 'Last day of the registration, when it ended.'
]);
call private.install_policies('app.registered_apprentices',
  $$org_id in (select private.orgs_with_capability('crew.payroll.export'))$$,
  $$org_id in (select private.orgs_with_capability('crew.payroll.export'))$$);
call private.install_audit_trail('app.registered_apprentices');

-- Submissions ----------------------------------------------------------------------------------------------------------------

create table app.certified_payroll_submissions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  week_ending date not null,
  payroll_number integer not null,
  final_submission boolean not null default false,
  issued_by uuid references app.people (id),
  issued_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint certified_payroll_submissions_number check (payroll_number >= 1)
);

create unique index certified_payroll_submissions_week_key on app.certified_payroll_submissions (project_id, week_ending) where deleted_at is null;
create unique index certified_payroll_submissions_number_key on app.certified_payroll_submissions (project_id, payroll_number) where deleted_at is null;
create index certified_payroll_submissions_issued_by_idx on app.certified_payroll_submissions (issued_by);

call private.install_domain_table('app.certified_payroll_submissions', 'app.projects', 'project_id');
call private.describe('app.certified_payroll_submissions', 'Each weekly certified payroll issued for a project. Written only by app.certified_payroll, which numbers them.', array[
  'project_id', 'Project.',
  'week_ending', 'Week Ending Date.',
  'payroll_number', 'Certified Payroll No.: 1 for the first week issued for the project, then in sequence.',
  'final_submission', 'Submission of final DBRA certified payroll form: the contractor''s last week on the project.',
  'issued_by', 'Person who issued it last.',
  'issued_at', 'When it was issued last.'
]);
call private.install_policies('app.certified_payroll_submissions',
  $$org_id in (select private.orgs_with_capability('crew.payroll.export'))$$);

-- The export -------------------------------------------------------------------------------------------------------------------

create or replace function app.certified_payroll(p_project_id uuid, p_week_ending date, p_final boolean default false)
returns table (
  payroll_number integer,
  entry_number integer,
  last_name text,
  first_name text,
  middle_initial text,
  identifying_number text,
  apprentice text,
  labor_classification text,
  straight_minutes integer[],
  overtime_minutes integer[],
  total_minutes integer,
  currency_code text,
  straight_rate_minor bigint,
  overtime_rate_minor bigint,
  gross_project_minor bigint,
  gross_all_work_minor bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_person uuid := private.require_person();
  v_project app.projects;
  v_start date := p_week_ending - 6;
  v_number integer;
begin
  select * into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_project.id is null or not private.has_capability(v_project.org_id, 'crew.payroll.export') then
    raise exception using errcode = '42501', message = 'crew.payroll.export is required';
  end if;
  if not private.has_capability(v_project.org_id, 'data.restricted.read.payroll')
     or not private.has_capability(v_project.org_id, 'data.export.restricted') then
    perform private.refuse('export_restricted', 'A certified payroll carries Restricted pay rates and needs the restricted export capability.');
  end if;
  if private.session_aal() <> 'aal2' then
    perform private.refuse('step_up_required', 'Exporting Restricted columns needs step-up authentication.');
  end if;
  if not exists (select 1 from app.certified_payroll_projects c where c.project_id = p_project_id and c.deleted_at is null) then
    perform private.refuse('certified_payroll_header_missing', 'Enter the project''s contract and wage determination numbers before issuing a certified payroll.');
  end if;
  if p_week_ending is null then
    perform private.refuse('certified_payroll_week', 'Choose the week ending date.');
  end if;

  -- The submission: a week keeps its number when issued again.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('certified_payroll:' || p_project_id::text, 0));
  select s.payroll_number into v_number from app.certified_payroll_submissions s
  where s.project_id = p_project_id and s.week_ending = p_week_ending and s.deleted_at is null;
  if v_number is null then
    select coalesce(max(s.payroll_number), 0) + 1 into v_number from app.certified_payroll_submissions s
    where s.project_id = p_project_id and s.deleted_at is null;
    insert into app.certified_payroll_submissions (project_id, week_ending, payroll_number, final_submission, issued_by)
    values (p_project_id, p_week_ending, v_number, coalesce(p_final, false), v_person);
  else
    update app.certified_payroll_submissions s set final_submission = s.final_submission or coalesce(p_final, false),
      issued_by = v_person, issued_at = now()
    where s.project_id = p_project_id and s.week_ending = p_week_ending and s.deleted_at is null;
  end if;

  -- All of the week's approved work of everyone who worked on the project, on any of the org's projects.
  create temporary table if not exists pg_temp.work_minutes (
    membership_id uuid, role_code text, project_id uuid, jurisdiction_id text, subdivision_code text,
    week date, work_date date, clock_in timestamptz, minutes integer
  ) on commit drop;
  truncate pg_temp.work_minutes;

  insert into pg_temp.work_minutes
  select e.membership_id,
    coalesce(sh.role_code, (select pr.role_code from app.pay_rates pr
                            where pr.membership_id = e.membership_id and pr.effective_from <= p_week_ending and pr.deleted_at is null
                            order by pr.effective_from desc, pr.created_at desc limit 1)),
    p.id, p.jurisdiction_id, private.labor_subdivision(p.id), v_start,
    (e.clock_in at time zone p.time_zone)::date, e.clock_in,
    greatest(0, (extract(epoch from (e.clock_out - e.clock_in)) / 60)::integer - e.break_minutes)
  from app.time_entries e
  join app.projects p on p.id = e.project_id
  left join app.shifts sh on sh.id = e.shift_id
  where e.org_id = v_project.org_id and e.deleted_at is null and e.clock_out is not null and e.membership_id is not null
    and (e.clock_in at time zone p.time_zone)::date between v_start and p_week_ending
    and e.membership_id in (
      select e2.membership_id from app.time_entries e2 join app.projects p2 on p2.id = e2.project_id
      where e2.project_id = p_project_id and e2.deleted_at is null and e2.clock_out is not null
        and (e2.clock_in at time zone p2.time_zone)::date between v_start and p_week_ending)
    and exists (
      select 1 from app.timesheets t join app.timesheet_approvals a on a.timesheet_id = t.id and a.voided_at is null
      where t.membership_id = e.membership_id and t.project_id = e.project_id and t.deleted_at is null
        and t.timesheet_state = 'Approved' and e.clock_in >= t.period_start::timestamptz and e.clock_in < (t.period_end + 1)::timestamptz);

  return query
  with split as (
    select s.*, (select pr.rate_minor from app.pay_rates pr
                 where pr.membership_id = s.membership_id and pr.role_code = s.role_code and pr.effective_from <= p_week_ending
                   and pr.deleted_at is null and pr.currency_code = v_project.currency
                 order by pr.effective_from desc, pr.created_at desc limit 1) as rate_minor
    from private.split_work_minutes() s
  ), earned as (
    select s.*, round(coalesce(s.rate_minor, 0) * (s.regular_minutes + s.ot_minutes * s.ot_multiplier + s.dt_minutes * s.dt_multiplier) / 60.0)::bigint as gross
    from split s
  ), all_work as (
    select e.membership_id, sum(e.gross)::bigint as gross from earned e group by 1
  ), project_rows as (
    select e.membership_id, e.role_code,
      array(select coalesce(sum(x.regular_minutes), 0)::integer from generate_series(0, 6) d
            left join earned x on x.membership_id = e.membership_id and x.role_code = e.role_code and x.project_id = p_project_id
              and x.work_date = v_start + d group by d order by d) as st,
      array(select coalesce(sum(x.ot_minutes + x.dt_minutes), 0)::integer from generate_series(0, 6) d
            left join earned x on x.membership_id = e.membership_id and x.role_code = e.role_code and x.project_id = p_project_id
              and x.work_date = v_start + d group by d order by d) as ot,
      sum(e.minutes)::integer as total, max(e.rate_minor) as rate, max(e.ot_multiplier) as ot_multiplier, sum(e.gross)::bigint as gross
    from earned e where e.project_id = p_project_id
    group by e.membership_id, e.role_code
  ), named as (
    select r.*, pe.full_name,
      coalesce(nullif(btrim(pe.family_name), ''), (regexp_match(btrim(pe.full_name), '(\S+)$'))[1]) as last_name,
      coalesce(nullif(btrim(pe.given_name), ''), (regexp_match(btrim(pe.full_name), '^(\S+)'))[1]) as first_name,
      case when pe.given_name is null and array_length(regexp_split_to_array(btrim(pe.full_name), '\s+'), 1) >= 3
           then left((regexp_split_to_array(btrim(pe.full_name), '\s+'))[2], 1) end as middle_initial,
      upper(left(replace(r.membership_id::text, '-', ''), 8)) as identifying_number,
      (select 'RA' || coalesce(' ' || ra.progression_level, '') from app.registered_apprentices ra
       where ra.membership_id = r.membership_id and ra.deleted_at is null and ra.valid_from <= p_week_ending
         and (ra.valid_to is null or ra.valid_to >= v_start) order by ra.valid_from desc limit 1) as apprentice,
      (select xr.job_title::text from xpms.role xr where xr.role_code = r.role_code) as classification
    from project_rows r
    join app.memberships m on m.id = r.membership_id
    join app.people pe on pe.id = m.person_id
  )
  select v_number,
    dense_rank() over (order by n.last_name, n.first_name, n.membership_id)::integer,
    n.last_name, n.first_name, n.middle_initial, n.identifying_number, coalesce(n.apprentice, 'J'),
    coalesce(n.classification, n.role_code), n.st, n.ot, n.total, v_project.currency::text,
    n.rate, round(n.rate * n.ot_multiplier)::bigint, n.gross, w.gross
  from named n join all_work w on w.membership_id = n.membership_id
  order by 2, 8;

  perform private.write_audit_event(v_project.org_id, 'crew.certified_payroll_exported', 'app.certified_payroll_submissions', null,
    jsonb_build_object('project_id', p_project_id, 'week_ending', p_week_ending, 'payroll_number', v_number, 'classification', 'Restricted'));
end;
$$;

comment on function app.certified_payroll(uuid, date, boolean) is 'The WH-347 rows of a project for the week ending on the given date: per worker and labor classification, straight and overtime hours of each day (overtime split over all of the worker''s approved work that week), rates and gross pay on the project and for all work. Numbers the week''s Certified Payroll No. (kept when issued again) and records the final-submission mark. A Restricted export: needs crew.payroll.export, data.restricted.read.payroll, data.export.restricted and step-up authentication, and is written to the audit log.';
revoke all on function app.certified_payroll(uuid, date, boolean) from public, anon;
grant execute on function app.certified_payroll(uuid, date, boolean) to authenticated, service_role;

-- Retention ----------------------------------------------------------------------------------------------------------------------
-- 29 CFR 5.5(a)(3)(i) keeps payroll records for three years after the work is completed; kept seven years once soft deleted.

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.certified_payroll_projects', 'Soft Deleted', 'deleted_at', interval '7 years', 'Delete', 'Davis-Bacon payroll records are kept at least three years after the work (29 CFR 5.5(a)(3)(i)).'),
  ('app.registered_apprentices', 'Soft Deleted', 'deleted_at', interval '7 years', 'Delete', 'Davis-Bacon payroll records are kept at least three years after the work (29 CFR 5.5(a)(3)(i)).'),
  ('app.certified_payroll_submissions', 'Soft Deleted', 'deleted_at', interval '7 years', 'Delete', 'Davis-Bacon payroll records are kept at least three years after the work (29 CFR 5.5(a)(3)(i)).')
on conflict (table_name) do nothing;
