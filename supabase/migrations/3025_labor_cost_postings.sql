-- 3025_labor_cost_postings.sql
-- B13 (RRR-237, gap G-133; Section 4.2 Finance and Crew, S4.2-16, ADR 0152). Approved crew hours cost to the budget:
-- a shift names the Labor budget line it works for, and approving a timesheet posts its time at the rate in force.
--
--   * app.shifts.budget_line_id: a live Labor line of a budget of the shift's own project (t42_guard_shift_budget_line,
--     beside private.guard_shift, which is not redefined). Writing it needs crew.shift.write, as the shift policy does.
--     A Labor line that live shifts name keeps its type and is not deleted (t41 on app.budget_lines).
--   * app.labor_budget_lines: the lines a shift planner may choose, without amounts.
--   * private.bulk_shifts_row (from 1451, its latest definition) accepts budget_line_id, and app.save_roster_shift
--     (from 2755, its latest definition) writes it in the shift editor's one transaction.
--   * app.labor_cost_postings: an append-only ledger, written only when a timesheet approval is inserted
--     (app.decide_timesheet, R12 2754, is not redefined). It stores what the approval fixed: the shift, role, work date,
--     minutes, segment, multiplier and the rate in force. The worker, team and project are read through the approval and
--     the timesheet, never copied. A voided approval (invariant 19, private.void_timesheet_approvals, R12 2751) or a
--     deleted timesheet drops out of every view at once, and a re-approval posts new rows. The amount is never stored.
--   * Rates (private.labor_rate_in_force, on the work date): a member's pay rate in force for the role (the pay rate
--     ledger, as app.calculate_payroll_run resolves it, A134 2271); an engaged individual's or an agency's Hourly
--     engagement at the precedence of app.engagement_resolved (1624): the agreed rate, else the org rate card line in
--     force, else the canon rate card. Day Rate, Flat Fee and Salary post minutes with no rate: unpriced, never zero.
--     The engagement's role may be NULL (1624), so rate cards match on the engagement's role, else the posted role.
--     Members' minutes are split into Regular, Overtime and Double Time by private.split_work_minutes (1384) within the
--     timesheet; external and agency workers bill their own overtime and post Regular. Payroll stays authoritative;
--     holiday pay (2270, 2271) is not posted. A missing rate never refuses an approval.
--   * Visibility: rate_minor is Restricted (data.restricted.read.payroll) and never selectable by signed-in callers, as
--     payroll lines (0362). Per-person rows need crew.timesheet.read; cost by team needs data.restricted.read.payroll;
--     the per-line aggregate is Internal and shows to finance.budget.read readers in Actual (3026), as the journal's
--     payroll aggregates do (0362). The table's rows and the team totals are crew.timesheet.read only, so a budget
--     reader never sees minutes beside a line's Actual.
--   * shift_budget_line_posted: a crew planner cannot move posted Actuals; a change of line on a shift with standing
--     posted time needs finance.budget.write on the project.
-- No table becomes Trash-eligible: the postings are an Age ledger.

-- 1. Enums -------------------------------------------------------------------------------------------------------------

create type app.labor_segment as enum ('Regular', 'Overtime', 'Double Time');
comment on type app.labor_segment is 'Part of worked time a labour posting covers: Regular, Overtime or Double Time (private.split_work_minutes).';
create type app.labor_team_kind as enum ('Own Team', 'Agency', 'Engaged');
comment on type app.labor_team_kind is 'Who worked the posted time: the org''s Own Team (members), an Agency (a roster entry of an engagement with a counterparty) or an Engaged individual.';
create type app.labor_rate_source as enum ('Pay Rate', 'Engagement Rate', 'Rate Card');
comment on type app.labor_rate_source is 'Where a posted rate came from: the member''s pay rate ledger, the engagement''s agreed rate, or a rate card (the org''s, else the canon''s).';

-- 2. Shifts name their Labor line --------------------------------------------------------------------------------------

alter table app.shifts add column budget_line_id uuid references app.budget_lines (id);
create index shifts_budget_line_id_idx on app.shifts (budget_line_id);
call private.add_cross_org_references('app.shifts', array['app.budget_lines', 'budget_line_id']);
comment on column app.shifts.budget_line_id is 'Labor budget line the shift''s approved time posts to (G-133): a live Labor line of a budget of the shift''s project. NULL leaves the time off the budget (the Labor report lists it).';

create or replace function private.guard_shift_budget_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line record;
begin
  -- Actual follows the live shift's line, so moving a line under posted time moves finance's numbers.
  if tg_op = 'UPDATE' and new.budget_line_id is distinct from old.budget_line_id
     and not private.can_on_project(new.project_id, 'finance.budget.write')
     and exists (select 1 from app.labor_cost_postings l
                 join app.timesheet_approvals a on a.id = l.timesheet_approval_id and a.voided_at is null
                 join app.timesheets t on t.id = a.timesheet_id and t.deleted_at is null
                 where l.shift_id = new.id) then
    perform private.refuse('shift_budget_line_posted', 'Approved time on this shift is already on the budget, so moving it needs finance.budget.write.');
  end if;
  if new.budget_line_id is null or (tg_op = 'UPDATE' and new.budget_line_id is not distinct from old.budget_line_id
                                    and new.project_id = old.project_id) then
    return new;
  end if;
  select bl.line_type, b.project_id into v_line
  from app.budget_lines bl join app.budgets b on b.id = bl.budget_id
  where bl.id = new.budget_line_id and bl.deleted_at is null and b.deleted_at is null;
  if v_line.project_id is null or v_line.project_id <> new.project_id then
    perform private.refuse('shift_budget_line_project', 'Choose a live line of a budget of this shift''s project.');
  end if;
  if v_line.line_type <> 'Labor' then
    perform private.refuse('shift_budget_line_labor', 'A shift posts its time to a Labor line.');
  end if;
  return new;
end;
$$;
comment on function private.guard_shift_budget_line() is 'Shifts: the budget line a shift posts to is a live Labor line (shift_budget_line_labor) of a live budget of the shift''s own project (shift_budget_line_project), and moving it off a shift with standing posted time needs finance.budget.write on the project (shift_budget_line_posted). Separate from private.guard_shift.';
revoke all on function private.guard_shift_budget_line() from public, anon, authenticated;
create trigger t42_guard_shift_budget_line before insert or update of budget_line_id, project_id on app.shifts
  for each row execute function private.guard_shift_budget_line();

create or replace function private.guard_budget_line_labor_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.line_type <> 'Labor' and old.line_type = 'Labor' or new.deleted_at is not null and old.deleted_at is null)
     and exists (select 1 from app.shifts s where s.budget_line_id = old.id and s.deleted_at is null) then
    perform private.refuse('budget_line_labor_linked', 'Shifts post their time to this Labor line; move them to another line first.');
  end if;
  return new;
end;
$$;
comment on function private.guard_budget_line_labor_link() is 'Budget lines: a Labor line that live shifts post to keeps its type and is not deleted (budget_line_labor_linked).';
revoke all on function private.guard_budget_line_labor_link() from public, anon, authenticated;
create trigger t41_guard_budget_line_labor_link before update of line_type, deleted_at on app.budget_lines
  for each row execute function private.guard_budget_line_labor_link();

create view app.labor_budget_lines as
select bl.id, b.id as budget_id, b.project_id, b.name as budget_name, bl.line_number, bl.description
from app.budget_lines bl
join app.budgets b on b.id = bl.budget_id
where bl.line_type = 'Labor' and bl.deleted_at is null and b.deleted_at is null
  and b.project_id in (select private.project_ids_with('crew.shift.write'));

call private.describe('app.labor_budget_lines', 'Labor budget lines a shift planner may post a shift''s time to: live Labor lines of live budgets of projects where the caller holds crew.shift.write, the app.expense_budget_lines pattern (1622). No amounts.', array[
  'id', 'Budget line.', 'budget_id', 'Budget.', 'project_id', 'Project of the budget.', 'budget_name', 'Budget name.',
  'line_number', 'Line number.', 'description', 'Line description.']);
revoke all on app.labor_budget_lines from public, anon;
grant select on app.labor_budget_lines to authenticated, service_role;

-- 3. Bulk Set budget line (from 1451, its latest definition) --------------------------------------------------------------

create or replace function private.bulk_shifts_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.shifts;
  v_new app.shifts;
  v_state app.shift_state;
  v_membership uuid;
  v_line uuid;
  v_keys jsonb := p_set;
begin
  perform private.bulk_check_fields(p_set, p_expect, 'shift_state,membership_id,budget_line_id');
  select * into v_old from app.shifts s where s.id = p_id and s.deleted_at is null for update;
  if v_old.id is null or v_old.project_id not in (select private.project_ids_with('crew.shift.read')) then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  if not private.can_on_project(v_old.project_id, 'crew.shift.write') then
    raise exception using errcode = '42501', message = 'crew.shift.write is required on this shift''s project.';
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);
  v_state := case when p_set ? 'shift_state' then (p_set ->> 'shift_state')::app.shift_state else v_old.shift_state end;
  v_membership := case when p_set ? 'membership_id' then (p_set ->> 'membership_id')::uuid else v_old.membership_id end;
  v_line := case when p_set ? 'budget_line_id' then (p_set ->> 'budget_line_id')::uuid else v_old.budget_line_id end;
  if v_state = v_old.shift_state and v_membership is not distinct from v_old.membership_id
     and v_line is not distinct from v_old.budget_line_id then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;
  if v_membership is distinct from v_old.membership_id then
    update app.shifts set membership_id = v_membership where id = p_id;
  end if;
  if v_line is distinct from v_old.budget_line_id then
    update app.shifts set budget_line_id = v_line where id = p_id;
  end if;
  select * into v_new from app.shifts s where s.id = p_id;
  if v_state <> v_new.shift_state then
    perform app.transition_shift(p_id, v_new.shift_state, v_state, coalesce(nullif(btrim(p_reason), ''), 'Changed in bulk.'));
  end if;
  select * into v_new from app.shifts s where s.id = p_id;
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true,
    'before', private.bulk_pick(to_jsonb(v_old), v_keys), 'after', private.bulk_pick(to_jsonb(v_new), v_keys));
end;
$$;

comment on function private.bulk_shifts_row(uuid, jsonb, jsonb, text) is 'One shift of a bulk change: publish, return to draft or cancel through app.transition_shift, assign or open the shift, and set the Labor budget line its time posts to (B13; t42_guard_shift_budget_line decides the line). Needs crew.shift.write on the project; a reassigned accepted shift returns to Published as a single reassignment does.';
revoke all on function private.bulk_shifts_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

-- 4. The shift editor writes the line (from 2755, its latest definition) -------------------------------------------------

drop function app.save_roster_shift(uuid, uuid, uuid, text, timestamptz, timestamptz, text, uuid, uuid, uuid, text);

create function app.save_roster_shift(
  p_shift_id uuid,
  p_org_id uuid,
  p_project_id uuid,
  p_role_code text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_time_zone text,
  p_membership_id uuid,
  p_engagement_id uuid,
  p_roster_entry_id uuid,
  p_reason text default null,
  p_budget_line_id uuid default null
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_id uuid := p_shift_id;
  v_held uuid;
begin
  if num_nonnulls(p_membership_id, p_engagement_id) > 1 or (p_roster_entry_id is not null and p_engagement_id is null) then
    -- Raised here rather than through private.refuse: the caller has no usage on schema private.
    raise exception using errcode = 'XR001', hint = 'roster_shift_worker',
      message = 'roster_shift_worker: A shift names one member, one agency or one person of an agency''s roster on its slot.';
  end if;
  if v_id is null then
    insert into app.shifts (org_id, project_id, role_code, starts_at, ends_at, time_zone, membership_id, engagement_id, budget_line_id)
    values (p_org_id, p_project_id, p_role_code, p_starts_at, p_ends_at, p_time_zone, p_membership_id, p_engagement_id, p_budget_line_id)
    returning id into v_id;
  else
    select s.roster_entry_id into v_held from app.shifts s where s.id = v_id and s.deleted_at is null for update;
    if not found then
      raise exception using errcode = '42501', message = 'the shift is not visible';
    end if;
    -- Off the roster first, so the shift is the agency's slot again before it takes a member or another agency.
    if v_held is not null and p_roster_entry_id is null then
      perform app.unassign_roster_shift(v_id, coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Reassigned in the shift editor.'));
      v_held := null;
    end if;
    -- A shift still held through the roster keeps its worker columns; another entry of the agency takes it below.
    update app.shifts s set
      role_code = p_role_code,
      starts_at = p_starts_at,
      ends_at = p_ends_at,
      time_zone = p_time_zone,
      membership_id = case when v_held is null then p_membership_id else s.membership_id end,
      engagement_id = case when v_held is null then p_engagement_id else s.engagement_id end,
      budget_line_id = p_budget_line_id
    where s.id = v_id;
  end if;
  if p_roster_entry_id is not null and v_held is distinct from p_roster_entry_id then
    perform app.assign_roster_shift(v_id, p_roster_entry_id);
  end if;
  return v_id;
end;
$$;

comment on function app.save_roster_shift(uuid, uuid, uuid, text, timestamptz, timestamptz, text, uuid, uuid, uuid, text, uuid) is 'Atlas''s shift editor (R12): creates a shift (p_shift_id null) or edits its times, role, worker and Labor budget line (B13, p_budget_line_id; NULL leaves it off the budget) in one transaction. The worker is a member (p_membership_id), an agency slot (p_engagement_id) or a person of that agency''s roster on its slot (p_engagement_id with p_roster_entry_id, placed through app.assign_roster_shift); anything else refuses roster_shift_worker. A shift taken off the roster goes through app.unassign_roster_shift with p_reason first. Runs as the caller, so the shift''s policies and guards decide the write, and any refusal leaves the shift as it was. Returns the shift id.';
revoke all on function app.save_roster_shift(uuid, uuid, uuid, text, timestamptz, timestamptz, text, uuid, uuid, uuid, text, uuid) from public, anon;
grant execute on function app.save_roster_shift(uuid, uuid, uuid, text, timestamptz, timestamptz, text, uuid, uuid, uuid, text, uuid) to authenticated, service_role;

-- 5. The postings ledger -----------------------------------------------------------------------------------------------

create table app.labor_cost_postings (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  timesheet_approval_id uuid not null references app.timesheet_approvals (id),
  shift_id uuid references app.shifts (id),
  role_code text references xpms.role (role_code),
  work_date date not null,
  minutes integer not null,
  segment app.labor_segment not null,
  multiplier numeric not null,
  rate_minor bigint,
  rate_source app.labor_rate_source,
  currency_code char(3) references private.currencies (currency_code),
  deleted_at timestamptz,
  constraint labor_cost_postings_minutes_positive check (minutes > 0),
  constraint labor_cost_postings_multiplier check (multiplier >= 1),
  constraint labor_cost_postings_rate_nonnegative check (rate_minor is null or rate_minor >= 0),
  constraint labor_cost_postings_rate_complete check ((rate_minor is null) = (rate_source is null)
    and (rate_minor is null) = (currency_code is null))
);

create index labor_cost_postings_approval_idx on app.labor_cost_postings (timesheet_approval_id);
create index labor_cost_postings_shift_id_idx on app.labor_cost_postings (shift_id);
create index labor_cost_postings_role_code_idx on app.labor_cost_postings (role_code);
create index labor_cost_postings_currency_code_idx on app.labor_cost_postings (currency_code);

call private.install_domain_table('app.labor_cost_postings', 'app.timesheet_approvals', 'timesheet_approval_id',
  array['app.shifts', 'shift_id'], true);
call private.describe('app.labor_cost_postings', 'Approved crew time costed at the rate in force (G-133, ADR 0152): one row per shift, role, work date and segment of a timesheet approval. Append-only, written only when the approval is inserted. The worker, team and project are read through the approval and its timesheet; a voided approval or a deleted timesheet drops out of every view. The amount is derived (minutes / 60 times multiplier times rate), never stored.', array[
  'timesheet_approval_id', 'Approval that posted the time. Views keep only approvals that stand (voided_at NULL) of live timesheets.',
  'shift_id', 'Shift the time was worked on, whose budget line it costs; NULL for time with no shift.',
  'role_code', 'Role the rate was resolved for at approval: the shift''s role, else the worker''s most recent pay rate role or roster or engagement role.',
  'work_date', 'Day worked, on the project''s calendar.',
  'minutes', 'Worked minutes of the segment: clock span less breaks.',
  'segment', 'Regular, Overtime or Double Time. External and agency time posts Regular: they bill their own overtime.',
  'multiplier', 'Multiplier of the segment (1 for Regular), from the project''s wage-hour rule.',
  'rate_minor', 'Hourly rate in force on the work date in minor units; NULL is unpriced, never zero. Restricted (data.restricted.read.payroll).',
  'rate_source', 'Where the rate came from: Pay Rate, Engagement Rate or Rate Card; NULL when unpriced.',
  'currency_code', 'Currency of the rate; never converted. NULL when unpriced.'
]);

call private.install_policies('app.labor_cost_postings',
  $$timesheet_approval_id in (select a.id from app.timesheet_approvals a join app.timesheets t on t.id = a.timesheet_id
    where t.project_id in (select private.project_ids_with('crew.timesheet.read')))$$);
-- The rate is never selectable directly, as payroll lines (0362); the views mask it.
revoke select, insert, update, delete on app.labor_cost_postings from authenticated;
grant select (id, org_id, timesheet_approval_id, shift_id, role_code, work_date, minutes, segment, multiplier, rate_source,
  currency_code, created_at, created_by, updated_at, updated_by, deleted_at) on app.labor_cost_postings to authenticated;
call private.install_default_retention('app.labor_cost_postings');

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.labor_cost_postings', 'rate_minor', 'Restricted', 'data.restricted.read.payroll');

-- 6. The rate in force -------------------------------------------------------------------------------------------------

create or replace function private.labor_rate_in_force(
  p_membership_id uuid,
  p_engagement_id uuid,
  p_roster_entry_id uuid,
  p_role_code text,
  p_work_date date
)
returns table (rate_minor bigint, currency_code text, rate_source app.labor_rate_source)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_card record;
  v_canon record;
begin
  if p_membership_id is not null then
    return query
    select pr.rate_minor, pr.currency_code::text, 'Pay Rate'::app.labor_rate_source
    from app.pay_rates pr
    where pr.membership_id = p_membership_id and pr.role_code = p_role_code and pr.effective_from <= p_work_date
      and pr.deleted_at is null
    order by pr.effective_from desc, pr.created_at desc
    limit 1;
    return;
  end if;
  select e.* into v_engagement from app.engagements e
  where e.id = coalesce(p_engagement_id, (select r.engagement_id from app.engagement_roster_entries r where r.id = p_roster_entry_id));
  -- Only hourly pay is priced per hour; Day Rate, Flat Fee and Salary post unpriced.
  if v_engagement.id is null or v_engagement.pay_basis is distinct from 'Hourly' then
    return;
  end if;
  if v_engagement.agreed_rate_minor is not null then
    return query select v_engagement.agreed_rate_minor, v_engagement.currency_code::text, 'Engagement Rate'::app.labor_rate_source;
    return;
  end if;
  select l.rate_minor, c.currency_code into v_card
  from app.rate_card_lines l join app.rate_cards c on c.id = l.rate_card_id
  where l.org_id = v_engagement.org_id and l.deleted_at is null and c.deleted_at is null
    and l.role_code = coalesce(v_engagement.role_code, p_role_code) and l.worker_classification = v_engagement.worker_classification
    and l.pay_basis = v_engagement.pay_basis and l.arrangement = v_engagement.arrangement
    and c.effective_from <= p_work_date and (c.effective_to is null or c.effective_to >= p_work_date)
  order by c.effective_from desc, c.created_at desc
  limit 1;
  if v_card.rate_minor is not null then
    return query select v_card.rate_minor, v_card.currency_code::text, 'Rate Card'::app.labor_rate_source;
    return;
  end if;
  select rc.standard_rate_minor, rc.currency_code into v_canon
  from xpms.rate_card rc
  where rc.role_code = coalesce(v_engagement.role_code, p_role_code) and rc.worker_classification = v_engagement.worker_classification
    and rc.pay_basis = v_engagement.pay_basis and rc.arrangement = v_engagement.arrangement
  limit 1;
  if v_canon.standard_rate_minor is not null then
    return query select v_canon.standard_rate_minor::bigint, v_canon.currency_code::text, 'Rate Card'::app.labor_rate_source;
  end if;
end;
$$;
comment on function private.labor_rate_in_force(uuid, uuid, uuid, text, date) is 'The hourly rate in force on a work date (ADR 0152): for a member, the latest pay rate for the role effective on or before the day; for an engaged individual (p_engagement_id) or an agency''s staff (p_roster_entry_id, through its Staff engagement) on an Hourly engagement, app.engagement_resolved''s precedence evaluated on the work date: the agreed rate, else the org rate card line in force that day (the latest card by effective_from, then created_at), else the canon rate card. No row (unpriced) for Day Rate, Flat Fee and Salary bases or when no rate is known.';
revoke all on function private.labor_rate_in_force(uuid, uuid, uuid, text, date) from public, anon, authenticated;

-- 7. Posting on approval -----------------------------------------------------------------------------------------------

create or replace function private.post_timesheet_labor(p_approval_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sheet app.timesheets;
  v_project app.projects;
  v_week_start integer;
  v_count integer := 0;
begin
  select t.* into v_sheet from app.timesheet_approvals a join app.timesheets t on t.id = a.timesheet_id
  where a.id = p_approval_id and a.voided_at is null and t.deleted_at is null;
  if v_sheet.id is null then
    return 0;
  end if;
  select p.* into v_project from app.projects p where p.id = v_sheet.project_id;

  if v_sheet.membership_id is not null then
    -- Members: 2271's work minutes and week rule, split within this timesheet. Payroll stays authoritative.
    v_week_start := case private.setting_text(v_sheet.org_id, 'payroll.week_start') when 'monday' then 1 else 0 end;
    create temporary table if not exists pg_temp.work_minutes (
      membership_id uuid, role_code text, project_id uuid, jurisdiction_id text, subdivision_code text,
      week date, work_date date, clock_in timestamptz, minutes integer
    ) on commit drop;
    truncate pg_temp.work_minutes;

    insert into pg_temp.work_minutes
    select v_sheet.membership_id,
      coalesce(sh.role_code, (select pr.role_code from app.pay_rates pr
                              where pr.membership_id = v_sheet.membership_id and pr.effective_from <= v_sheet.period_end
                                and pr.deleted_at is null
                              order by pr.effective_from desc, pr.created_at desc limit 1)),
      v_project.id,
      v_project.jurisdiction_id,
      private.labor_subdivision(v_project.id),
      (e.clock_in at time zone v_project.time_zone)::date
        - ((extract(dow from e.clock_in at time zone v_project.time_zone)::integer - v_week_start + 7) % 7),
      (e.clock_in at time zone v_project.time_zone)::date,
      e.clock_in,
      greatest(0, (extract(epoch from (e.clock_out - e.clock_in)) / 60)::integer - e.break_minutes)
    from app.time_entries e
    left join app.shifts sh on sh.id = e.shift_id
    where e.membership_id = v_sheet.membership_id and e.project_id = v_sheet.project_id and e.deleted_at is null
      and e.clock_out is not null
      and (e.clock_in at time zone v_project.time_zone)::date between v_sheet.period_start and v_sheet.period_end;

    with split as (
      select s.*, e.shift_id
      from private.split_work_minutes() s
      join app.time_entries e on e.membership_id = s.membership_id and e.project_id = s.project_id
        and e.clock_in = s.clock_in and e.deleted_at is null
    ), parts as (
      select x.shift_id, x.role_code, x.work_date, 'Regular'::app.labor_segment as segment, 1::numeric as multiplier,
        x.regular_minutes as minutes from split x
      union all
      select x.shift_id, x.role_code, x.work_date, 'Overtime', greatest(x.ot_multiplier, 1), x.ot_minutes from split x
      union all
      select x.shift_id, x.role_code, x.work_date, 'Double Time', greatest(x.dt_multiplier, 1), x.dt_minutes from split x
    ), grouped as (
      select p.shift_id, p.role_code, p.work_date, p.segment, p.multiplier, sum(p.minutes)::integer as minutes
      from parts p where p.minutes > 0
      group by p.shift_id, p.role_code, p.work_date, p.segment, p.multiplier
    )
    insert into app.labor_cost_postings (timesheet_approval_id, shift_id, role_code, work_date, minutes, segment, multiplier,
      rate_minor, rate_source, currency_code)
    select p_approval_id, g.shift_id, g.role_code, g.work_date, g.minutes, g.segment, g.multiplier,
      r.rate_minor, r.rate_source, r.currency_code
    from grouped g
    left join lateral private.labor_rate_in_force(v_sheet.membership_id, null, null, g.role_code, g.work_date) r on true
    where g.minutes > 0;
    get diagnostics v_count = row_count;
    truncate pg_temp.work_minutes;
  else
    -- Engaged individuals and agency staff bill their own overtime: their time posts Regular at multiplier 1.
    with entries as (
      select e.shift_id,
        coalesce(sh.role_code,
          (select r.role_code from app.engagement_roster_entries r where r.id = v_sheet.roster_entry_id),
          (select g.role_code from app.engagements g where g.id = v_sheet.engagement_id)) as role_code,
        (e.clock_in at time zone v_project.time_zone)::date as work_date,
        greatest(0, (extract(epoch from (e.clock_out - e.clock_in)) / 60)::integer - e.break_minutes) as minutes
      from app.time_entries e
      left join app.shifts sh on sh.id = e.shift_id
      where e.project_id = v_sheet.project_id and e.deleted_at is null and e.clock_out is not null
        and e.membership_id is null
        and e.engagement_id is not distinct from v_sheet.engagement_id
        and e.roster_entry_id is not distinct from v_sheet.roster_entry_id
        and (e.clock_in at time zone v_project.time_zone)::date between v_sheet.period_start and v_sheet.period_end
    ), grouped as (
      select x.shift_id, x.role_code, x.work_date, sum(x.minutes)::integer as minutes
      from entries x group by x.shift_id, x.role_code, x.work_date
    )
    insert into app.labor_cost_postings (timesheet_approval_id, shift_id, role_code, work_date, minutes, segment, multiplier,
      rate_minor, rate_source, currency_code)
    select p_approval_id, g.shift_id, g.role_code, g.work_date, g.minutes, 'Regular', 1, r.rate_minor, r.rate_source,
      r.currency_code
    from grouped g
    left join lateral private.labor_rate_in_force(null, v_sheet.engagement_id, v_sheet.roster_entry_id, g.role_code, g.work_date) r
      on true
    where g.minutes > 0;
    get diagnostics v_count = row_count;
  end if;
  return v_count;
end;
$$;
comment on function private.post_timesheet_labor(uuid) is 'Posts a standing timesheet approval''s time (G-133): the live, clocked-out time entries of the timesheet''s worker on its project whose clock-in falls inside its period on the project''s calendar, with minutes = clock span less breaks and the work date on the project''s calendar. A member''s minutes go through pg_temp.work_minutes (2271''s columns and payroll.week_start rule) and private.split_work_minutes into Regular, Overtime and Double Time within this timesheet; with no jurisdiction or wage-hour rule they post Regular. External and agency time posts Regular at 1. Rows group by shift, role, work date and segment, at private.labor_rate_in_force; a missing rate posts unpriced and never refuses the approval. Returns the rows posted.';
revoke all on function private.post_timesheet_labor(uuid) from public, anon, authenticated;

create or replace function private.post_timesheet_labor_on_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.post_timesheet_labor(new.id);
  return null;
end;
$$;
comment on function private.post_timesheet_labor_on_approval() is 'After a timesheet approval is inserted (app.decide_timesheet): posts its time to the labour ledger (private.post_timesheet_labor).';
revoke all on function private.post_timesheet_labor_on_approval() from public, anon, authenticated;
create trigger t60_post_timesheet_labor after insert on app.timesheet_approvals
  for each row execute function private.post_timesheet_labor_on_approval();

-- 8. Views -------------------------------------------------------------------------------------------------------------

-- The standing postings with their worker, team and budget line, read through the approval, the timesheet and the shift.
-- A view, so the labour views below inline it; signed-in callers never read it directly.
create view private.labor_postings_standing as
select l.id as posting_id, l.org_id, t.project_id, t.id as timesheet_id, l.shift_id, sh.budget_line_id,
  coalesce((select m.person_id from app.memberships m where m.id = t.membership_id),
           (select g.person_id from app.engagements g where g.id = t.engagement_id),
           (select r.person_id from private.roster_people r where r.roster_entry_id = t.roster_entry_id)) as person_id,
  case when t.membership_id is not null then 'Own Team'
       when (select g.counterparty_id from app.engagement_roster_entries r join app.engagements g on g.id = r.engagement_id
             where r.id = t.roster_entry_id) is not null then 'Agency'
       else 'Engaged' end::app.labor_team_kind as team_kind,
  (select g.counterparty_id from app.engagement_roster_entries r join app.engagements g on g.id = r.engagement_id
   where r.id = t.roster_entry_id) as team_counterparty_id,
  l.role_code, l.work_date, l.minutes, l.segment, l.multiplier, l.rate_minor, l.rate_source, l.currency_code::text as currency_code,
  round(l.minutes / 60.0 * l.multiplier * l.rate_minor)::bigint as amount_minor
from app.labor_cost_postings l
join app.timesheet_approvals a on a.id = l.timesheet_approval_id and a.voided_at is null
join app.timesheets t on t.id = a.timesheet_id and t.deleted_at is null
left join app.shifts sh on sh.id = l.shift_id and sh.deleted_at is null;

comment on view private.labor_postings_standing is 'Labour postings of standing approvals (voided_at NULL) of live timesheets, with the worker (as private.worker_person_id resolves it), the team (Own Team for a member, Agency with the counterparty for a roster entry whose engagement has one, otherwise Engaged), the live shift''s budget line and the derived amount, round(minutes / 60 times multiplier times rate) as payroll_line_amounts derives it (0362). Read only by the labour views, which filter and mask it.';
revoke all on private.labor_postings_standing from public, anon, authenticated;

create view app.budget_line_labor_totals as
select bl.id as budget_line_id, b.id as budget_id,
  coalesce(sum(s.amount_minor) filter (where s.currency_code = b.currency_code), 0) as labor_actual_minor,
  coalesce(sum(s.minutes) filter (where s.rate_minor is null), 0)::integer as labor_unpriced_minutes,
  count(s.posting_id) filter (where s.currency_code <> b.currency_code)::integer as labor_other_currency_count
from app.budget_lines bl
join app.budgets b on b.id = bl.budget_id
left join private.labor_postings_standing s on s.budget_line_id = bl.id
where bl.deleted_at is null and b.deleted_at is null
  and b.project_id in (select private.project_ids_with('finance.budget.read'))
group by bl.id, b.id;

call private.describe('app.budget_line_labor_totals', 'Approved crew time per budget line (G-133, ADR 0152), through the live shifts that name the line: the derived amounts of standing postings in the budget''s currency, unpriced minutes counted, and postings in another currency counted and never summed. An aggregate with no per-person rate, shown to finance.budget.read readers as the journal''s payroll aggregates are (0362). Hours are not shown beside cost here.', array[
  'budget_line_id', 'Budget line.',
  'budget_id', 'Budget of the line.',
  'labor_actual_minor', 'Sum of the derived amounts of standing postings in the budget''s currency, in minor units; zero when none.',
  'labor_unpriced_minutes', 'Minutes posted with no rate (unpriced, never zero).',
  'labor_other_currency_count', 'Postings in another currency than the budget''s: counted, never summed or converted.'
]);

create view app.labor_cost_posting_details as
select s.posting_id, s.org_id, s.project_id, s.timesheet_id, s.shift_id, s.budget_line_id, s.person_id,
  pe.full_name as person_name, s.team_kind, s.team_counterparty_id, o.name as team_name, s.role_code, s.work_date,
  s.minutes, s.segment, s.multiplier, s.currency_code, s.rate_source,
  case when private.has_capability(s.org_id, 'data.restricted.read.payroll') then s.rate_minor end as rate_minor,
  case when private.has_capability(s.org_id, 'data.restricted.read.payroll') then s.amount_minor end as amount_minor,
  (s.rate_minor is null) as is_unpriced,
  not private.has_capability(s.org_id, 'data.restricted.read.payroll') as is_masked
from private.labor_postings_standing s
left join app.people pe on pe.id = s.person_id
left join app.counterparties c on c.id = s.team_counterparty_id
left join app.organizations o on o.id = c.organization_id
where s.project_id in (select private.project_ids_with('crew.timesheet.read'));

call private.describe('app.labor_cost_posting_details', 'Per-posting rows of approved crew time with person, team, role, date, minutes and segment, for readers who hold crew.timesheet.read on the project. The rate and amount show only with data.restricted.read.payroll, as payroll_line_amounts (0362); is_masked says so.', array[
  'posting_id', 'Labour posting.', 'org_id', 'Org.', 'project_id', 'Project of the timesheet.', 'timesheet_id', 'Timesheet approved.',
  'shift_id', 'Shift worked; NULL for time with no shift.', 'budget_line_id', 'Budget line of the live shift; NULL when the time is on no line.',
  'person_id', 'Worker.', 'person_name', 'Worker''s name.', 'team_kind', 'Own Team, Agency or Engaged.',
  'team_counterparty_id', 'The agency, for Agency staff.', 'team_name', 'The agency''s name, for Agency staff.',
  'role_code', 'Role the rate was resolved for.', 'work_date', 'Day worked.', 'minutes', 'Minutes posted.',
  'segment', 'Regular, Overtime or Double Time.', 'multiplier', 'Segment multiplier.', 'currency_code', 'Currency of the rate.',
  'rate_source', 'Pay Rate, Engagement Rate or Rate Card.',
  'rate_minor', 'Hourly rate in minor units; NULL without data.restricted.read.payroll or when unpriced.',
  'amount_minor', 'Minutes / 60 times multiplier times rate, rounded; NULL without data.restricted.read.payroll or when unpriced.',
  'is_unpriced', 'True when the posting has no rate.', 'is_masked', 'True when the rate and amount are masked for the caller.']);

create view app.labor_posting_team_totals as
select s.org_id, s.project_id, s.team_kind, s.team_counterparty_id, o.name as team_name, s.currency_code,
  sum(s.minutes)::integer as minutes,
  coalesce(sum(s.minutes) filter (where s.rate_minor is null), 0)::integer as unpriced_minutes,
  case when private.has_capability(s.org_id, 'data.restricted.read.payroll') then sum(s.amount_minor) end as amount_minor,
  not private.has_capability(s.org_id, 'data.restricted.read.payroll') as is_masked
from private.labor_postings_standing s
left join app.counterparties c on c.id = s.team_counterparty_id
left join app.organizations o on o.id = c.organization_id
where s.project_id in (select private.project_ids_with('crew.timesheet.read'))
group by s.org_id, s.project_id, s.team_kind, s.team_counterparty_id, o.name, s.currency_code;

call private.describe('app.labor_posting_team_totals', 'Approved crew time per project, team and currency (S7.4-07): own team, each agency by name and engaged individuals side by side, for readers who hold crew.timesheet.read on the project: hours beside a line''s Actual would give a rate to a reader who holds only finance.budget.read. Cost by team shows only with data.restricted.read.payroll, as the Labor report masks payroll run amounts; amounts are never summed across currencies.', array[
  'org_id', 'Org.', 'project_id', 'Project.', 'team_kind', 'Own Team, Agency or Engaged.',
  'team_counterparty_id', 'The agency, for Agency rows.', 'team_name', 'The agency''s name.',
  'currency_code', 'Currency of the rates summed; NULL for the unpriced minutes.', 'minutes', 'Minutes posted.',
  'unpriced_minutes', 'Minutes posted with no rate.',
  'amount_minor', 'Sum of the derived amounts in minor units; NULL without data.restricted.read.payroll or when unpriced.',
  'is_masked', 'True when the amount is masked for the caller.']);

insert into private.view_column_sources (view_name, column_name, source_table, source_column) values
  ('app.labor_cost_posting_details', 'amount_minor', 'app.labor_cost_postings', 'rate_minor');

revoke all on app.budget_line_labor_totals, app.labor_cost_posting_details, app.labor_posting_team_totals from public, anon;
grant select on app.budget_line_labor_totals, app.labor_cost_posting_details, app.labor_posting_team_totals
  to authenticated, service_role;
-- 1650 grants the backup login SELECT on every new relation; pg_dump never reads a view's rows.
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles r where r.rolname = 'xos_backup') then
    revoke select on app.labor_budget_lines, app.budget_line_labor_totals, app.labor_cost_posting_details,
      app.labor_posting_team_totals, private.labor_postings_standing from xos_backup;
  end if;
end;
$$;
