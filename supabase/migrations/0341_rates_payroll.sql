-- 0341_rates_payroll.sql
-- A03 Domain Data. Rates and payroll (Section 7.4 Rates and payroll, invariants 14, 15 and 18,
-- Sections 8.1 to 8.3, ADR 0012 decisions D12 to D14): org rate cards whose lines reference canon
-- roles, classifications, pay bases, arrangements and overtime rules (never repeating titles or
-- multipliers), the pay rate ledger, union local rates and wage determinations, pay periods (a posted
-- period cannot reopen), payroll runs (Draft cannot jump to Accepted), payroll lines and exports,
-- earning codes, per diems, time off policies and requests. Pay rates are Restricted and masked.

-- Enums and rules ---------------------------------------------------------------------------------------

create type app.pay_period_state as enum ('Open', 'Closed', 'Posted');
comment on type app.pay_period_state is 'Pay period lifecycle. A Posted period never reopens (invariant 14).';

create type app.payroll_run_state as enum ('Draft', 'Calculated', 'Approved', 'Exported', 'Accepted', 'Canceled');
comment on type app.payroll_run_state is 'Payroll run lifecycle. A Draft run reaches Accepted only through Calculated, Approved and Exported (invariant 15).';

create type app.time_off_state as enum ('Proposed', 'Approved', 'Rejected', 'Canceled');
comment on type app.time_off_state is 'Time off request states.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('pay_period', 'Open', 'Closed'),
  ('pay_period', 'Closed', 'Open'),
  ('pay_period', 'Closed', 'Posted'),
  ('payroll_run', 'Draft', 'Calculated'),
  ('payroll_run', 'Draft', 'Canceled'),
  ('payroll_run', 'Calculated', 'Draft'),
  ('payroll_run', 'Calculated', 'Approved'),
  ('payroll_run', 'Calculated', 'Canceled'),
  ('payroll_run', 'Approved', 'Exported'),
  ('payroll_run', 'Approved', 'Canceled'),
  ('payroll_run', 'Exported', 'Accepted'),
  ('payroll_run', 'Exported', 'Approved'),
  ('time_off', 'Proposed', 'Approved'),
  ('time_off', 'Proposed', 'Rejected'),
  ('time_off', 'Proposed', 'Canceled'),
  ('time_off', 'Approved', 'Canceled');

insert into private.domain_event_types (code, subject, description) values
  ('pay_period.posted', 'pay_periods', 'A pay period was posted and can no longer reopen.'),
  ('payroll_run.state_changed', 'payroll_runs', 'A payroll run moved to another payroll run state.'),
  ('time_off.decided', 'time_off_requests', 'A time off request was approved or rejected.');

-- Rate cards (D12, D14) ------------------------------------------------------------------------------------

create table app.rate_cards (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  currency_code char(3) not null references private.currencies (currency_code),
  effective_from date not null,
  effective_to date,
  deleted_at timestamptz,
  constraint rate_cards_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint rate_cards_effective check (effective_to is null or effective_to >= effective_from)
);

create index rate_cards_currency_code_idx on app.rate_cards (currency_code);

call private.install_domain_table('app.rate_cards');
call private.describe('app.rate_cards', 'An org''s labor rate cards over time (Section 7.4).', array[
  'name', 'Rate card name.',
  'currency_code', 'ISO 4217 currency of every rate on the card.',
  'effective_from', 'First day the card applies.',
  'effective_to', 'Last day the card applies; NULL while current.'
]);

create table app.rate_card_lines (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  rate_card_id uuid not null references app.rate_cards (id),
  role_code text not null references xpms.role (role_code),
  worker_classification text not null references xpms.worker_classification (code),
  pay_basis text not null,
  arrangement text not null,
  canon_rate_card_id text references xpms.rate_card (rate_card_id),
  overtime_rule_id text not null references xpms.overtime_rule (rule_id),
  rate_minor bigint,
  deleted_at timestamptz,
  constraint rate_card_lines_pay_basis_fkey foreign key (pay_basis, worker_classification)
    references xpms.pay_basis_classification (pay_basis, worker_classification),
  constraint rate_card_lines_arrangement_fkey foreign key (arrangement, worker_classification)
    references xpms.arrangement_classification (arrangement, worker_classification),
  constraint rate_card_lines_rate_nonnegative check (rate_minor is null or rate_minor >= 0)
);

create index rate_card_lines_rate_card_id_idx on app.rate_card_lines (rate_card_id);
create index rate_card_lines_role_code_idx on app.rate_card_lines (role_code);
create index rate_card_lines_worker_classification_idx on app.rate_card_lines (worker_classification);
create index rate_card_lines_pay_basis_idx on app.rate_card_lines (pay_basis, worker_classification);
create index rate_card_lines_arrangement_idx on app.rate_card_lines (arrangement, worker_classification);
create index rate_card_lines_canon_rate_card_id_idx on app.rate_card_lines (canon_rate_card_id);
create index rate_card_lines_overtime_rule_id_idx on app.rate_card_lines (overtime_rule_id);
create unique index rate_card_lines_combination_key on app.rate_card_lines (rate_card_id, role_code, worker_classification, pay_basis, arrangement)
  where deleted_at is null;

call private.install_domain_table('app.rate_card_lines', 'app.rate_cards', 'rate_card_id');
call private.describe('app.rate_card_lines', 'Rates on a rate card. A line names a canon role, classification, pay basis and arrangement (a permitted combination, decision D16) and a canon overtime rule (decision D14); job titles and multipliers are joined, never repeated (decision D12). The rate is Restricted.', array[
  'rate_card_id', 'Rate card the line belongs to.',
  'role_code', 'Canon role priced (Roles Library).',
  'worker_classification', 'Worker classification priced.',
  'pay_basis', 'Pay basis; with the classification a permitted pair.',
  'arrangement', 'Arrangement; with the classification a permitted pair.',
  'canon_rate_card_id', 'Canon rate card the line was adopted from, when it was.',
  'overtime_rule_id', 'Canon overtime rule whose multipliers apply.',
  'rate_minor', 'Rate in minor units of the card currency per pay basis unit; NULL is unpriced. Restricted (data.restricted.read.payroll).'
]);

create table app.pay_rates (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  membership_id uuid not null references app.memberships (id),
  role_code text not null references xpms.role (role_code),
  rate_minor bigint not null,
  currency_code char(3) not null references private.currencies (currency_code),
  effective_from date not null,
  constraint pay_rates_rate_nonnegative check (rate_minor >= 0)
);

create index pay_rates_membership_id_idx on app.pay_rates (membership_id, role_code, effective_from);
create index pay_rates_role_code_idx on app.pay_rates (role_code);
create index pay_rates_currency_code_idx on app.pay_rates (currency_code);

call private.install_domain_table('app.pay_rates', 'app.memberships', 'membership_id', '{}', true);
call private.describe('app.pay_rates', 'Append-only pay rate ledger: a person''s rate in a role from a date. The rate in force on a day is the latest entry effective on or before it. The rate is Restricted.', array[
  'membership_id', 'Membership of the person paid.',
  'role_code', 'Canon role the rate is for.',
  'rate_minor', 'Rate in minor units per hour. Restricted (data.restricted.read.payroll).',
  'currency_code', 'ISO 4217 currency of the rate.',
  'effective_from', 'First day the rate applies.'
]);

create table app.union_local_rates (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  union_local text not null,
  role_code text not null references xpms.role (role_code),
  rate_minor bigint not null,
  fringe_minor bigint,
  currency_code char(3) not null references private.currencies (currency_code),
  effective_from date not null,
  effective_to date,
  deleted_at timestamptz,
  constraint union_local_rates_rate_nonnegative check (rate_minor >= 0 and (fringe_minor is null or fringe_minor >= 0)),
  constraint union_local_rates_effective check (effective_to is null or effective_to >= effective_from)
);

create index union_local_rates_role_code_idx on app.union_local_rates (role_code);
create index union_local_rates_currency_code_idx on app.union_local_rates (currency_code);

call private.install_domain_table('app.union_local_rates');
call private.describe('app.union_local_rates', 'Rates a union local sets for a role over time.', array[
  'union_local', 'Union local as named in its agreement.',
  'role_code', 'Canon role the rate is for.',
  'rate_minor', 'Base hourly rate in minor units.',
  'fringe_minor', 'Hourly fringe in minor units; NULL when the agreement states none.',
  'currency_code', 'ISO 4217 currency.',
  'effective_from', 'First day the rate applies.',
  'effective_to', 'Last day the rate applies; NULL while current.'
]);

create table app.wage_determinations (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  jurisdiction_id text not null references xpms.jurisdiction (jurisdiction_id),
  role_code text not null references xpms.role (role_code),
  minimum_rate_minor bigint not null,
  currency_code char(3) not null references private.currencies (currency_code),
  effective_from date not null,
  effective_to date,
  source text not null,
  deleted_at timestamptz,
  constraint wage_determinations_rate_nonnegative check (minimum_rate_minor >= 0),
  constraint wage_determinations_effective check (effective_to is null or effective_to >= effective_from)
);

create index wage_determinations_jurisdiction_id_idx on app.wage_determinations (jurisdiction_id);
create index wage_determinations_role_code_idx on app.wage_determinations (role_code);
create index wage_determinations_currency_code_idx on app.wage_determinations (currency_code);

call private.install_domain_table('app.wage_determinations');
call private.describe('app.wage_determinations', 'Prevailing wage minimums a jurisdiction imposes on a role over time.', array[
  'jurisdiction_id', 'Jurisdiction imposing the minimum.',
  'role_code', 'Canon role covered.',
  'minimum_rate_minor', 'Minimum hourly rate in minor units.',
  'currency_code', 'ISO 4217 currency.',
  'effective_from', 'First day it applies.',
  'effective_to', 'Last day it applies; NULL while current.',
  'source', 'Determination number or law.'
]);

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.rate_card_lines', 'rate_minor', 'Restricted', 'data.restricted.read.payroll'),
  ('app.pay_rates', 'rate_minor', 'Restricted', 'data.restricted.read.payroll'),
  ('app.payroll_lines', 'rate_minor', 'Restricted', 'data.restricted.read.payroll');

-- Earning codes, pay periods, payroll runs ----------------------------------------------------------------------

create table app.earning_codes (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  code text not null,
  name text not null,
  is_overtime boolean not null default false,
  deleted_at timestamptz,
  constraint earning_codes_code_format check (code ~ '^[A-Z0-9_]{2,20}$'),
  constraint earning_codes_name_length check (char_length(btrim(name)) between 1 and 100)
);

create unique index earning_codes_org_code_key on app.earning_codes (org_id, code) where deleted_at is null;

call private.install_domain_table('app.earning_codes');
call private.describe('app.earning_codes', 'Earning codes payroll lines are paid under, mapped by the payroll integration. Listed in code order.', array[
  'code', 'Earning code, for example REG or OT.',
  'name', 'Earning code name.',
  'is_overtime', 'True when the code pays an overtime multiplier.'
]);

create table app.pay_periods (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  starts_on date not null,
  ends_on date not null,
  pay_period_state app.pay_period_state not null default 'Open',
  deleted_at timestamptz,
  constraint pay_periods_dates check (ends_on >= starts_on)
);

create index pay_periods_org_dates_idx on app.pay_periods (org_id, starts_on);

call private.install_domain_table('app.pay_periods');
call private.describe('app.pay_periods', 'Pay periods of an org. Periods never overlap, and a Posted period never reopens (invariant 14).', array[
  'starts_on', 'First day of the pay period.',
  'ends_on', 'Last day of the pay period.',
  'pay_period_state', 'Open, Closed or Posted. Changes only through app.transition_pay_period.'
]);

call private.install_lifecycle('app.pay_periods', 'pay_period_id', 'pay_period_state', 'pay_period', 'Open',
  $$org_id in (select private.orgs_with_capability('crew.pay_period.manage')) or org_id in (select private.orgs_with_capability('crew.payroll.export'))$$);

create trigger t90_emit_pay_period_posted after insert on app.pay_period_state_transitions
  for each row when (new.to_state = 'Posted')
  execute function private.emit_subject_event('pay_period.posted', 'pay_periods', 'pay_period_id', 'from_state', 'to_state');

create or replace function private.guard_pay_period()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.starts_on <> old.starts_on or new.ends_on <> old.ends_on) and old.pay_period_state <> 'Open' then
    perform private.refuse('pay_period_dates_locked', 'A pay period''s dates change only while it is Open.');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pay_periods:' || new.org_id::text, 0));
  if new.deleted_at is null and exists (
    select 1 from app.pay_periods p where p.org_id = new.org_id and p.id <> new.id and p.deleted_at is null
      and daterange(p.starts_on, p.ends_on, '[]') && daterange(new.starts_on, new.ends_on, '[]')) then
    perform private.refuse('pay_period_overlap', 'Pay periods of an org never overlap.');
  end if;
  return new;
end;
$$;

comment on function private.guard_pay_period() is 'Pay periods never overlap and keep their dates once Closed.';

create trigger t40_guard_pay_period before insert or update on app.pay_periods
  for each row execute function private.guard_pay_period();

create table app.payroll_runs (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  pay_period_id uuid not null references app.pay_periods (id),
  currency_code char(3) not null references private.currencies (currency_code),
  payroll_run_state app.payroll_run_state not null default 'Draft',
  deleted_at timestamptz
);

create index payroll_runs_pay_period_id_idx on app.payroll_runs (pay_period_id);
create index payroll_runs_currency_code_idx on app.payroll_runs (currency_code);

call private.install_domain_table('app.payroll_runs', 'app.pay_periods', 'pay_period_id');
call private.describe('app.payroll_runs', 'Payroll runs of a pay period. A Draft run reaches Accepted only through Calculated, Approved and Exported (invariant 15); approval runs spend authority and is never by the run''s creator.', array[
  'pay_period_id', 'Pay period paid.',
  'currency_code', 'ISO 4217 currency of the run.',
  'payroll_run_state', 'Payroll run state. Changes only through app.transition_payroll_run and app.approve_payroll_run.'
]);

call private.install_lifecycle('app.payroll_runs', 'payroll_run_id', 'payroll_run_state', 'payroll_run', 'Draft',
  $$org_id in (select private.orgs_with_capability('crew.pay_period.manage')) or org_id in (select private.orgs_with_capability('crew.payroll.export'))$$);

create trigger t90_emit_payroll_run_state after insert on app.payroll_run_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('payroll_run.state_changed', 'payroll_runs', 'payroll_run_id', 'from_state', 'to_state', 'reason');

create table app.payroll_lines (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  payroll_run_id uuid not null references app.payroll_runs (id),
  membership_id uuid not null references app.memberships (id),
  earning_code_id uuid not null references app.earning_codes (id),
  hours numeric not null,
  rate_minor bigint not null,
  deleted_at timestamptz,
  constraint payroll_lines_hours_nonnegative check (hours >= 0),
  constraint payroll_lines_rate_nonnegative check (rate_minor >= 0)
);

create index payroll_lines_payroll_run_id_idx on app.payroll_lines (payroll_run_id);
create index payroll_lines_membership_id_idx on app.payroll_lines (membership_id);
create index payroll_lines_earning_code_id_idx on app.payroll_lines (earning_code_id);

call private.install_domain_table('app.payroll_lines', 'app.payroll_runs', 'payroll_run_id',
  array['app.memberships', 'membership_id', 'app.earning_codes', 'earning_code_id']);
call private.describe('app.payroll_lines', 'Lines of a payroll run: hours paid under an earning code at the rate the run calculated. Amounts are derived. Lines change only while the run is Draft or Calculated. The rate is Restricted.', array[
  'payroll_run_id', 'Run the line belongs to.',
  'membership_id', 'Membership of the person paid.',
  'earning_code_id', 'Earning code paid.',
  'hours', 'Hours paid.',
  'rate_minor', 'Rate paid in minor units per hour, as calculated for the run. Restricted (data.restricted.read.payroll).'
]);

create table app.payroll_exports (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  payroll_run_id uuid not null references app.payroll_runs (id),
  provider text not null,
  file_uri text not null,
  checksum_sha256 text not null,
  constraint payroll_exports_checksum_format check (checksum_sha256 ~ '^[0-9a-f]{64}$')
);

create index payroll_exports_payroll_run_id_idx on app.payroll_exports (payroll_run_id);

call private.install_domain_table('app.payroll_exports', 'app.payroll_runs', 'payroll_run_id', '{}', true);
call private.describe('app.payroll_exports', 'Append-only record of each export of an approved payroll run to a provider.', array[
  'payroll_run_id', 'Run exported.',
  'provider', 'Payroll provider the file went to.',
  'file_uri', 'Where the export file is stored.',
  'checksum_sha256', 'SHA-256 of the export file, lowercase hex.'
]);

create or replace function private.guard_payroll_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row app.payroll_lines := case when tg_op = 'DELETE' then old else new end;
begin
  if (select r.payroll_run_state from app.payroll_runs r where r.id = v_row.payroll_run_id) not in ('Draft', 'Calculated') then
    perform private.refuse('payroll_run_locked', 'Payroll lines change only while the run is Draft or Calculated.');
  end if;
  if (select p.pay_period_state from app.pay_periods p join app.payroll_runs r on r.pay_period_id = p.id where r.id = v_row.payroll_run_id) = 'Posted' then
    perform private.refuse('pay_period_posted', 'A posted pay period accepts no payroll changes.');
  end if;
  return v_row;
end;
$$;

comment on function private.guard_payroll_line() is 'Payroll lines change only while the run is Draft or Calculated and its pay period is not Posted.';

create trigger t40_guard_payroll_line before insert or update or delete on app.payroll_lines
  for each row execute function private.guard_payroll_line();

create or replace function private.guard_payroll_run()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and (select p.pay_period_state from app.pay_periods p where p.id = new.pay_period_id) = 'Posted' then
    perform private.refuse('pay_period_posted', 'A posted pay period takes no new payroll runs.');
  end if;
  if tg_op = 'UPDATE' and (new.pay_period_id <> old.pay_period_id or new.currency_code <> old.currency_code) then
    perform private.refuse('payroll_run_immutable', 'A payroll run keeps its pay period and currency.');
  end if;
  return new;
end;
$$;

comment on function private.guard_payroll_run() is 'Payroll runs: none added to a posted pay period; pay period and currency fixed.';

create trigger t40_guard_payroll_run before insert or update on app.payroll_runs
  for each row execute function private.guard_payroll_run();

create or replace function app.transition_pay_period(p_pay_period_id uuid, p_expected app.pay_period_state, p_next app.pay_period_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select p.org_id from app.pay_periods p where p.id = p_pay_period_id);
begin
  perform private.require_person();
  if v_org is null or not private.has_capability(v_org, 'crew.pay_period.manage') then
    raise exception using errcode = '42501', message = 'crew.pay_period.manage is required';
  end if;
  if p_next = 'Posted' and exists (select 1 from app.payroll_runs r where r.pay_period_id = p_pay_period_id
      and r.deleted_at is null and r.payroll_run_state not in ('Accepted', 'Canceled')) then
    perform private.refuse('pay_period_runs_open', 'Every payroll run of the period is Accepted or Canceled before it posts.');
  end if;
  return private.transition_lifecycle('pay_period', 'app.pay_periods', 'pay_period_state', 'app.pay_period_state_transitions',
    'pay_period_id', p_pay_period_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_pay_period(uuid, app.pay_period_state, app.pay_period_state, text) is 'Closes, reopens or posts a pay period with compare-and-set. Needs crew.pay_period.manage; posting needs every run Accepted or Canceled, and a Posted period never reopens (invariant 14).';

create or replace function app.transition_payroll_run(p_payroll_run_id uuid, p_expected app.payroll_run_state, p_next app.payroll_run_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select r.org_id from app.payroll_runs r where r.id = p_payroll_run_id);
  v_capability text := case when p_next in ('Exported', 'Accepted') then 'crew.payroll.export' else 'crew.pay_period.manage' end;
begin
  if p_next = 'Approved' and p_expected = 'Calculated' then
    perform private.refuse('payroll_run_use_rpc', 'Approve a payroll run through app.approve_payroll_run.');
  end if;
  perform private.require_person();
  if v_org is null or not private.has_capability(v_org, v_capability) then
    raise exception using errcode = '42501', message = format('%s is required', v_capability);
  end if;
  return private.transition_lifecycle('payroll_run', 'app.payroll_runs', 'payroll_run_state', 'app.payroll_run_state_transitions',
    'payroll_run_id', p_payroll_run_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_payroll_run(uuid, app.payroll_run_state, app.payroll_run_state, text) is 'Moves a payroll run with compare-and-set (invariant 15: no jump from Draft to Accepted). Export and acceptance need crew.payroll.export; the rest crew.pay_period.manage. Approval goes through app.approve_payroll_run.';

create or replace function app.approve_payroll_run(p_payroll_run_id uuid, p_reason text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_run app.payroll_runs;
  v_total bigint;
begin
  select * into v_run from app.payroll_runs r where r.id = p_payroll_run_id and r.deleted_at is null for update;
  if v_run.id is null or not private.has_capability(v_run.org_id, 'crew.pay_period.manage') then
    raise exception using errcode = '42501', message = 'crew.pay_period.manage is required';
  end if;
  perform private.assert_separation('sod_approval_requester', v_person, v_run.created_by);
  if v_run.payroll_run_state <> 'Calculated' then
    perform private.refuse('payroll_run_not_calculated', 'Only a Calculated payroll run can be approved.');
  end if;
  select coalesce(sum(private.extended_minor(l.hours, l.rate_minor)), 0)::bigint into v_total
  from app.payroll_lines l where l.payroll_run_id = p_payroll_run_id and l.deleted_at is null;
  if not private.approve_under_spend_authority(v_run.org_id, 'Payroll Run', v_run.id, v_total, v_run.currency_code, null, null) then
    return false;
  end if;
  perform private.transition_lifecycle('payroll_run', 'app.payroll_runs', 'payroll_run_state', 'app.payroll_run_state_transitions',
    'payroll_run_id', p_payroll_run_id, 'Calculated', 'Approved', p_reason);
  return true;
end;
$$;

comment on function app.approve_payroll_run(uuid, text) is 'Approves a Calculated payroll run: crew.pay_period.manage, never by the run''s creator, under spend authority for Payroll Run. Returns true once fully approved.';

-- Per diems and time off ------------------------------------------------------------------------------------------

create table app.per_diems (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  membership_id uuid not null references app.memberships (id),
  day date not null,
  amount_minor bigint not null,
  currency_code char(3) not null references private.currencies (currency_code),
  deleted_at timestamptz,
  constraint per_diems_amount_nonnegative check (amount_minor >= 0)
);

create index per_diems_project_id_idx on app.per_diems (project_id);
create index per_diems_membership_id_idx on app.per_diems (membership_id);
create index per_diems_currency_code_idx on app.per_diems (currency_code);
create unique index per_diems_one_per_day on app.per_diems (project_id, membership_id, day) where deleted_at is null;

call private.install_domain_table('app.per_diems', 'app.projects', 'project_id', array['app.memberships', 'membership_id']);
call private.describe('app.per_diems', 'Per diem allowances paid to a person for a day on a project, at most one per person, project and day.', array[
  'project_id', 'Project worked.',
  'membership_id', 'Membership of the person paid.',
  'day', 'Day the allowance covers.',
  'amount_minor', 'Allowance in minor units.',
  'currency_code', 'ISO 4217 currency.'
]);

create or replace function private.guard_per_diem()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.assert_production_open(new.project_id);
  end if;
  return new;
end;
$$;

comment on function private.guard_per_diem() is 'No new per diem on a closed production (invariant 10 applies to time and spend).';

create trigger t40_guard_per_diem before insert on app.per_diems
  for each row execute function private.guard_per_diem();

create table app.time_off_policies (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  accrual_hours_per_period numeric,
  deleted_at timestamptz,
  constraint time_off_policies_name_length check (char_length(btrim(name)) between 1 and 100),
  constraint time_off_policies_accrual_nonnegative check (accrual_hours_per_period is null or accrual_hours_per_period >= 0)
);

create unique index time_off_policies_org_name_key on app.time_off_policies (org_id, lower(name)) where deleted_at is null;

call private.install_domain_table('app.time_off_policies');
call private.describe('app.time_off_policies', 'Time off policies of an org.', array[
  'name', 'Policy name, such as Paid Time Off.',
  'accrual_hours_per_period', 'Hours accrued per pay period; NULL when the policy does not accrue.'
]);

create table app.time_off_requests (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  time_off_policy_id uuid not null references app.time_off_policies (id),
  membership_id uuid not null references app.memberships (id),
  starts_on date not null,
  ends_on date not null,
  hours numeric not null,
  time_off_state app.time_off_state not null default 'Proposed',
  deleted_at timestamptz,
  constraint time_off_requests_dates check (ends_on >= starts_on),
  constraint time_off_requests_hours_positive check (hours > 0)
);

create index time_off_requests_policy_idx on app.time_off_requests (time_off_policy_id);
create index time_off_requests_membership_id_idx on app.time_off_requests (membership_id, starts_on);

call private.install_domain_table('app.time_off_requests', 'app.time_off_policies', 'time_off_policy_id', array['app.memberships', 'membership_id']);
call private.describe('app.time_off_requests', 'Requests for time off under a policy. The requester cannot approve their own request (sod_time_off_requester).', array[
  'time_off_policy_id', 'Policy the time off is taken under.',
  'membership_id', 'Membership of the person requesting.',
  'starts_on', 'First day off.',
  'ends_on', 'Last day off.',
  'hours', 'Hours requested.',
  'time_off_state', 'Request state. Changes only through app.decide_time_off and app.cancel_time_off.'
]);

call private.install_lifecycle('app.time_off_requests', 'time_off_request_id', 'time_off_state', 'time_off', 'Proposed',
  $$time_off_request_id in (select r.id from app.time_off_requests r where r.membership_id in (select private.my_membership_ids())
    or r.org_id in (select private.orgs_with_capability('crew.time_off.approve')))$$);

create trigger t90_emit_time_off_decided after insert on app.time_off_state_transitions
  for each row when (new.to_state in ('Approved', 'Rejected') and new.from_state = 'Proposed')
  execute function private.emit_subject_event('time_off.decided', 'time_off_requests', 'time_off_request_id', 'from_state', 'to_state');

create or replace function app.decide_time_off(p_time_off_request_id uuid, p_decision app.approval_decision, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_request app.time_off_requests;
begin
  select * into v_request from app.time_off_requests r where r.id = p_time_off_request_id and r.deleted_at is null for update;
  if v_request.id is null or not private.has_capability(v_request.org_id, 'crew.time_off.approve') then
    raise exception using errcode = '42501', message = 'crew.time_off.approve is required';
  end if;
  perform private.assert_separation('sod_time_off_requester', v_person,
    (select m.person_id from app.memberships m where m.id = v_request.membership_id));
  perform private.assert_separation('sod_time_off_requester', v_person, v_request.created_by);
  return private.transition_lifecycle('time_off', 'app.time_off_requests', 'time_off_state', 'app.time_off_state_transitions',
    'time_off_request_id', p_time_off_request_id, 'Proposed', p_decision::text, p_reason);
end;
$$;

comment on function app.decide_time_off(uuid, app.approval_decision, text) is 'Approves or rejects time off: crew.time_off.approve, never by the requester (sod_time_off_requester, invariant 18).';

create or replace function app.cancel_time_off(p_time_off_request_id uuid, p_expected app.time_off_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_request app.time_off_requests;
begin
  perform private.require_person();
  select * into v_request from app.time_off_requests r where r.id = p_time_off_request_id;
  if v_request.id is null or not (v_request.membership_id in (select private.my_membership_ids())
                                  or private.has_capability(v_request.org_id, 'crew.time_off.approve')) then
    raise exception using errcode = '42501', message = 'only the requester or a time off approver cancels';
  end if;
  return private.transition_lifecycle('time_off', 'app.time_off_requests', 'time_off_state', 'app.time_off_state_transitions',
    'time_off_request_id', p_time_off_request_id, p_expected::text, 'Canceled', p_reason);
end;
$$;

comment on function app.cancel_time_off(uuid, app.time_off_state, text) is 'Cancels a proposed or approved time off request; the requester or a time off approver may.';

-- Masked views (Section 8.3) ---------------------------------------------------------------------------------------

create view app.rate_card_lines_masked as
select l.id, l.org_id, l.rate_card_id, l.role_code, l.worker_classification, l.pay_basis, l.arrangement,
  l.canon_rate_card_id, l.overtime_rule_id,
  case when private.has_capability(l.org_id, 'data.restricted.read.payroll') then l.rate_minor end as rate_minor,
  not private.has_capability(l.org_id, 'data.restricted.read.payroll') as is_masked
from app.rate_card_lines l
where l.deleted_at is null and l.org_id in (select private.orgs_with_capability('crew.rate_card.read'));

call private.describe('app.rate_card_lines_masked', 'Rate card lines with the Restricted rate masked (NULL, is_masked true) unless the caller holds data.restricted.read.payroll.', array[
  'id', 'Rate card line.', 'org_id', 'Org.', 'rate_card_id', 'Rate card.', 'role_code', 'Canon role.',
  'worker_classification', 'Classification.', 'pay_basis', 'Pay basis.', 'arrangement', 'Arrangement.',
  'canon_rate_card_id', 'Canon rate card adopted from.', 'overtime_rule_id', 'Canon overtime rule.',
  'rate_minor', 'Rate in minor units, or NULL when masked or unpriced.', 'is_masked', 'True when the rate is withheld from the caller.'
]);

create view app.pay_rates_masked as
select p.id, p.org_id, p.membership_id, p.role_code, p.currency_code, p.effective_from,
  case when private.has_capability(p.org_id, 'data.restricted.read.payroll') or p.membership_id in (select private.my_membership_ids())
       then p.rate_minor end as rate_minor,
  not (private.has_capability(p.org_id, 'data.restricted.read.payroll') or p.membership_id in (select private.my_membership_ids())) as is_masked
from app.pay_rates p
where p.deleted_at is null
  and (p.org_id in (select private.orgs_with_capability('crew.rate_card.read')) or p.membership_id in (select private.my_membership_ids()));

call private.describe('app.pay_rates_masked', 'Pay rate ledger with the Restricted rate masked unless the caller holds data.restricted.read.payroll or the rate is their own.', array[
  'id', 'Pay rate entry.', 'org_id', 'Org.', 'membership_id', 'Membership paid.', 'role_code', 'Canon role.',
  'currency_code', 'Currency.', 'effective_from', 'First day the rate applies.',
  'rate_minor', 'Rate in minor units, or NULL when masked.', 'is_masked', 'True when the rate is withheld from the caller.'
]);

create view app.payroll_line_amounts as
select l.id, l.org_id, l.payroll_run_id, l.membership_id, l.earning_code_id, l.hours,
  case when private.has_capability(l.org_id, 'data.restricted.read.payroll') then l.rate_minor end as rate_minor,
  case when private.has_capability(l.org_id, 'data.restricted.read.payroll') then private.extended_minor(l.hours, l.rate_minor) end as amount_minor,
  not private.has_capability(l.org_id, 'data.restricted.read.payroll') as is_masked
from app.payroll_lines l
where l.deleted_at is null
  and (l.org_id in (select private.orgs_with_capability('crew.pay_period.manage')) or l.org_id in (select private.orgs_with_capability('crew.payroll.export')));

call private.describe('app.payroll_line_amounts', 'Payroll lines with derived amounts; rate and amount are masked unless the caller holds data.restricted.read.payroll.', array[
  'id', 'Payroll line.', 'org_id', 'Org.', 'payroll_run_id', 'Run.', 'membership_id', 'Membership paid.',
  'earning_code_id', 'Earning code.', 'hours', 'Hours paid.', 'rate_minor', 'Rate, or NULL when masked.',
  'amount_minor', 'Hours times rate in minor units, or NULL when masked.', 'is_masked', 'True when rate and amount are withheld.'
]);

revoke all on app.rate_card_lines_masked, app.pay_rates_masked, app.payroll_line_amounts from public, anon;
grant select on app.rate_card_lines_masked, app.pay_rates_masked, app.payroll_line_amounts to authenticated, service_role;

-- Policies ------------------------------------------------------------------------------------------------------------

call private.install_policies('app.rate_cards',
  $$org_id in (select private.orgs_with_capability('crew.rate_card.read'))$$,
  $$org_id in (select private.orgs_with_capability('crew.rate_card.write'))$$);
call private.install_policies('app.rate_card_lines',
  $$org_id in (select private.orgs_with_capability('crew.rate_card.read'))$$,
  $$org_id in (select private.orgs_with_capability('crew.rate_card.write'))$$);
call private.install_policies('app.pay_rates',
  $$org_id in (select private.orgs_with_capability('crew.rate_card.read')) or membership_id in (select private.my_membership_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.payroll.write'))$$);
call private.install_policies('app.union_local_rates',
  $$org_id in (select private.orgs_with_capability('crew.rate_card.read'))$$,
  $$org_id in (select private.orgs_with_capability('crew.rate_card.write'))$$);
call private.install_policies('app.wage_determinations',
  $$org_id in (select private.orgs_with_capability('crew.rate_card.read'))$$,
  $$org_id in (select private.orgs_with_capability('crew.rate_card.write'))$$);
call private.install_policies('app.earning_codes',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.payroll.write'))$$);
call private.install_policies('app.pay_periods',
  $$org_id in (select private.orgs_with_capability('crew.pay_period.manage')) or org_id in (select private.orgs_with_capability('crew.payroll.export'))$$,
  $$org_id in (select private.orgs_with_capability('crew.pay_period.manage'))$$);
call private.install_policies('app.payroll_runs',
  $$org_id in (select private.orgs_with_capability('crew.pay_period.manage')) or org_id in (select private.orgs_with_capability('crew.payroll.export'))$$,
  $$org_id in (select private.orgs_with_capability('crew.pay_period.manage'))$$);
call private.install_policies('app.payroll_lines',
  $$org_id in (select private.orgs_with_capability('crew.pay_period.manage')) or org_id in (select private.orgs_with_capability('crew.payroll.export'))$$,
  $$org_id in (select private.orgs_with_capability('crew.pay_period.manage'))$$);
call private.install_policies('app.payroll_exports',
  $$org_id in (select private.orgs_with_capability('crew.pay_period.manage')) or org_id in (select private.orgs_with_capability('crew.payroll.export'))$$,
  $$org_id in (select private.orgs_with_capability('crew.payroll.export'))$$);
call private.install_policies('app.per_diems',
  $$project_id in (select private.project_ids_with('crew.time_entry.read')) or membership_id in (select private.my_membership_ids())$$,
  $$project_id in (select private.project_ids_with('crew.time_entry.write'))$$);
call private.install_policies('app.time_off_policies',
  $$org_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.time_attendance.write'))$$);
call private.install_policies('app.time_off_requests',
  $$membership_id in (select private.my_membership_ids()) or org_id in (select private.orgs_with_capability('crew.time_off.approve'))$$,
  $$(membership_id in (select private.my_membership_ids()) and private.capability_reach(org_id, 'crew.time_off.request') is not null)
    or org_id in (select private.orgs_with_capability('crew.time_off.approve'))$$);

-- Restricted rates are never selectable directly; callers read the masked views.
revoke select on app.rate_card_lines from authenticated;
grant select (id, org_id, rate_card_id, role_code, worker_classification, pay_basis, arrangement, canon_rate_card_id, overtime_rule_id,
  created_at, created_by, updated_at, updated_by, deleted_at) on app.rate_card_lines to authenticated;
revoke select on app.pay_rates from authenticated;
grant select (id, org_id, membership_id, role_code, currency_code, effective_from, created_at, created_by, updated_at, updated_by, deleted_at)
  on app.pay_rates to authenticated;
revoke select on app.payroll_lines from authenticated;
grant select (id, org_id, payroll_run_id, membership_id, earning_code_id, hours, created_at, created_by, updated_at, updated_by, deleted_at)
  on app.payroll_lines to authenticated;

-- Function privileges ------------------------------------------------------------------------------------------------------

revoke all on function private.guard_pay_period() from public, anon, authenticated;
revoke all on function private.guard_payroll_line() from public, anon, authenticated;
revoke all on function private.guard_payroll_run() from public, anon, authenticated;
revoke all on function private.guard_per_diem() from public, anon, authenticated;
revoke all on function app.transition_pay_period(uuid, app.pay_period_state, app.pay_period_state, text) from public, anon;
revoke all on function app.transition_payroll_run(uuid, app.payroll_run_state, app.payroll_run_state, text) from public, anon;
revoke all on function app.approve_payroll_run(uuid, text) from public, anon;
revoke all on function app.decide_time_off(uuid, app.approval_decision, text) from public, anon;
revoke all on function app.cancel_time_off(uuid, app.time_off_state, text) from public, anon;
grant execute on function app.transition_pay_period(uuid, app.pay_period_state, app.pay_period_state, text) to authenticated, service_role;
grant execute on function app.transition_payroll_run(uuid, app.payroll_run_state, app.payroll_run_state, text) to authenticated, service_role;
grant execute on function app.approve_payroll_run(uuid, text) to authenticated, service_role;
grant execute on function app.decide_time_off(uuid, app.approval_decision, text) to authenticated, service_role;
grant execute on function app.cancel_time_off(uuid, app.time_off_state, text) to authenticated, service_role;
