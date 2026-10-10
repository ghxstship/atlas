-- 0311_record_extensions.sql
-- A03 Domain Data. The 1:1 kind extension tables of the record spine (Section 7.4), one per record
-- kind, keyed by record_id. Each carries a constant record_kind column and a composite foreign key
-- (record_id, record_kind) to app.records (id, record_kind), so an extension row can only attach to
-- a record of its own kind. Rows inherit the record's visibility (invariant 2).

create or replace procedure private.install_record_extension(p_table regclass, p_kind text, p_references text[] default '{}')
language plpgsql
set search_path = ''
as $$
declare
  v_name text := (select c.relname from pg_catalog.pg_class c where c.oid = p_table);
begin
  execute format('alter table %s add column record_kind text not null default %L', p_table, p_kind);
  execute format('alter table %s add constraint %I check (record_kind = %L)', p_table, v_name || '_kind_check', p_kind);
  execute format('alter table %s add constraint %I foreign key (record_id, record_kind) references app.records (id, record_kind)',
    p_table, v_name || '_record_kind_fkey');
  execute format('comment on column %s.record_id is %L', p_table, format('The %s record this row extends; primary key.', p_kind));
  execute format('comment on column %s.record_kind is %L', p_table,
    format('Always %s. With record_id it forms the foreign key that refuses a record of another kind.', p_kind));
  call private.install_domain_table(p_table, 'app.records', 'record_id', p_references);
  call private.install_policies(p_table,
    'record_id in (select private.record_ids_with(''work.record.read''))',
    'record_id in (select private.record_ids_with(''work.record.write''))');
end;
$$;

comment on procedure private.install_record_extension(regclass, text, text[]) is 'Makes a table the 1:1 extension of one record kind: constant kind column, composite foreign key to the record, tenant machinery and policies that follow the record.';
revoke all on procedure private.install_record_extension(regclass, text, text[]) from public, anon, authenticated;

-- Work ---------------------------------------------------------------------------------------------------

create table app.record_build (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  engineering_stamp_required boolean not null default false,
  stamped_at timestamptz,
  stamping_engineer text
);
call private.install_record_extension('app.record_build', 'Build');
call private.describe('app.record_build', 'Build record attributes: the installation act (gate 5).', array[
  'engineering_stamp_required', 'True when the build needs an engineer''s stamp before it may be used.',
  'stamped_at', 'When the engineer stamped the build.',
  'stamping_engineer', 'Name and license of the stamping engineer as written on the stamp.'
]);

create table app.record_rehearsal (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  run_number integer,
  stream_target text,
  constraint record_rehearsal_run_positive check (run_number is null or run_number > 0)
);
call private.install_record_extension('app.record_rehearsal', 'Rehearsal');
call private.describe('app.record_rehearsal', 'Rehearsal record attributes: a run-through.', array[
  'run_number', 'Ordinal of the run within the rehearsal series.',
  'stream_target', 'Destination tested by a Stream Test rehearsal.'
]);

create table app.record_shift (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  role_code text references xpms.role (role_code),
  headcount integer not null default 1,
  constraint record_shift_headcount_positive check (headcount > 0)
);
create index record_shift_role_code_idx on app.record_shift (role_code);
call private.install_record_extension('app.record_shift', 'Shift');
call private.describe('app.record_shift', 'Shift record attributes: the planned block of work for a role (crew shifts in app.shifts staff it).', array[
  'role_code', 'Canon role the shift staffs (Roles Library).',
  'headcount', 'People the shift needs.'
]);

create table app.record_strike (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  restoration_required boolean not null default false,
  signed_off_at timestamptz,
  signed_off_by uuid references app.people (id),
  constraint record_strike_signoff_pair check ((signed_off_at is null) = (signed_off_by is null))
);
create index record_strike_signed_off_by_idx on app.record_strike (signed_off_by);
call private.install_record_extension('app.record_strike', 'Strike');
call private.describe('app.record_strike', 'Strike record attributes: the load-out act.', array[
  'restoration_required', 'True when the space must be restored to its prior condition.',
  'signed_off_at', 'When the venue signed off the strike.',
  'signed_off_by', 'Person who recorded the sign-off.'
]);

create table app.record_task (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  progress_pct smallint,
  effort_hours numeric,
  constraint record_task_progress_range check (progress_pct is null or progress_pct between 0 and 100),
  constraint record_task_effort_nonnegative check (effort_hours is null or effort_hours >= 0)
);
call private.install_record_extension('app.record_task', 'Task');
call private.describe('app.record_task', 'Task record attributes.', array[
  'progress_pct', 'Reported progress, 0 to 100; NULL when unreported.',
  'effort_hours', 'Estimated effort in hours; NULL when unestimated.'
]);

create table app.record_training (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  delivered_by uuid references app.people (id),
  duration_minutes integer,
  constraint record_training_duration_positive check (duration_minutes is null or duration_minutes > 0)
);
create index record_training_delivered_by_idx on app.record_training (delivered_by);
call private.install_record_extension('app.record_training', 'Training');
call private.describe('app.record_training', 'Training record attributes: a session delivered.', array[
  'delivered_by', 'Person who delivers the session.',
  'duration_minutes', 'Length of the session in minutes.'
]);

-- Artifact ------------------------------------------------------------------------------------------------

create table app.record_document (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  storage_uri text,
  version_label text
);
call private.install_record_extension('app.record_document', 'Document');
call private.describe('app.record_document', 'Document record attributes: the artifact that exists when the record is done.', array[
  'storage_uri', 'Where the artifact is stored.',
  'version_label', 'Version of the artifact the record refers to.'
]);

create table app.record_supply (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  element_id text references xpms.elements (element_id),
  quantity numeric,
  unit_basis text references xpms.dim_unit_alias (alias),
  received_at timestamptz,
  constraint record_supply_quantity_nonnegative check (quantity is null or quantity >= 0)
);
create index record_supply_element_id_idx on app.record_supply (element_id);
create index record_supply_unit_basis_idx on app.record_supply (unit_basis);
call private.install_record_extension('app.record_supply', 'Supply');
call private.describe('app.record_supply', 'Supply record attributes: the item received.', array[
  'element_id', 'Catalog element supplied.',
  'quantity', 'Quantity supplied, in unit_basis.',
  'unit_basis', 'Unit of the quantity from the controlled unit list.',
  'received_at', 'When the supply was received.'
]);

-- Commitment ----------------------------------------------------------------------------------------------

create table app.record_booking (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  counterparty_id uuid references app.counterparties (id),
  confirmation_identifier text,
  quantity numeric,
  constraint record_booking_quantity_nonnegative check (quantity is null or quantity >= 0)
);
create index record_booking_counterparty_id_idx on app.record_booking (counterparty_id);
call private.install_record_extension('app.record_booking', 'Booking', array['app.counterparties', 'counterparty_id']);
call private.describe('app.record_booking', 'Booking record attributes: a reservation.', array[
  'counterparty_id', 'Counterparty holding the reservation.',
  'confirmation_identifier', 'Confirmation number issued by the counterparty.',
  'quantity', 'Quantity reserved, such as rooms or seats.'
]);

create table app.record_contract (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  counterparty_id uuid references app.counterparties (id),
  value_minor bigint,
  currency_code char(3) references private.currencies (currency_code),
  signed_at timestamptz,
  effective_from date,
  effective_to date,
  constraint record_contract_value_currency check (value_minor is null or currency_code is not null),
  constraint record_contract_effective check (effective_to is null or effective_from is null or effective_to >= effective_from)
);
create index record_contract_counterparty_id_idx on app.record_contract (counterparty_id);
create index record_contract_currency_code_idx on app.record_contract (currency_code);
call private.install_record_extension('app.record_contract', 'Contract', array['app.counterparties', 'counterparty_id']);
call private.describe('app.record_contract', 'Contract record attributes: an agreement. Progress is carried by the record state, not the title.', array[
  'counterparty_id', 'Counterparty to the agreement.',
  'value_minor', 'Contract value in minor units of currency_code; NULL is unpriced.',
  'currency_code', 'ISO 4217 currency of the value.',
  'signed_at', 'When the agreement was signed.',
  'effective_from', 'First day the agreement is in force.',
  'effective_to', 'Last day the agreement is in force.'
]);

create table app.record_payment (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  counterparty_id uuid references app.counterparties (id),
  direction app.money_direction not null,
  amount_minor bigint,
  currency_code char(3) references private.currencies (currency_code),
  constraint record_payment_amount_currency check (amount_minor is null or currency_code is not null)
);
create index record_payment_counterparty_id_idx on app.record_payment (counterparty_id);
create index record_payment_currency_code_idx on app.record_payment (currency_code);
call private.install_record_extension('app.record_payment', 'Payment', array['app.counterparties', 'counterparty_id']);
call private.describe('app.record_payment', 'Payment record attributes: a planned movement of money. Ledger postings live in finance.', array[
  'counterparty_id', 'Counterparty paid or paying.',
  'direction', 'Payable or Receivable.',
  'amount_minor', 'Amount in minor units of currency_code; NULL is unpriced.',
  'currency_code', 'ISO 4217 currency of the amount.'
]);

create table app.record_recruitment (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  role_code text references xpms.role (role_code),
  worker_classification text references xpms.worker_classification (code),
  headcount integer not null default 1,
  constraint record_recruitment_headcount_positive check (headcount > 0)
);
create index record_recruitment_role_code_idx on app.record_recruitment (role_code);
create index record_recruitment_worker_classification_idx on app.record_recruitment (worker_classification);
call private.install_record_extension('app.record_recruitment', 'Recruitment');
call private.describe('app.record_recruitment', 'Recruitment record attributes: filling a role.', array[
  'role_code', 'Canon role being filled.',
  'worker_classification', 'Worker classification of the people sought (decision D16).',
  'headcount', 'People to recruit.'
]);

-- Control ---------------------------------------------------------------------------------------------------

create table app.record_approval (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  subject_record_id uuid references app.records (id),
  requester_person_id uuid not null references app.people (id),
  approver_person_id uuid references app.people (id),
  decision app.approval_decision,
  decided_at timestamptz,
  constraint record_approval_decision_complete check (
    (decision is null) = (decided_at is null) and (decision is null) = (approver_person_id is null))
);
create index record_approval_subject_record_id_idx on app.record_approval (subject_record_id);
create index record_approval_requester_person_id_idx on app.record_approval (requester_person_id);
create index record_approval_approver_person_id_idx on app.record_approval (approver_person_id);
call private.install_record_extension('app.record_approval', 'Approval', array['app.records', 'subject_record_id']);
call private.describe('app.record_approval', 'Approval record attributes. Decided by an eligible approver, never the requester (invariant 18).', array[
  'subject_record_id', 'Record being approved, when the approval is about one.',
  'requester_person_id', 'Person who asked for the approval.',
  'approver_person_id', 'Person who decided, set from the session when the decision is recorded.',
  'decision', 'Approved or Rejected; NULL while undecided.',
  'decided_at', 'When the decision was recorded, set by the database.'
]);

create or replace function private.guard_record_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
  v_project uuid := (select r.project_id from app.records r where r.id = new.record_id);
begin
  if tg_op = 'UPDATE' and new.requester_person_id <> old.requester_person_id then
    perform private.refuse('approval_requester_immutable', 'The requester of an approval never changes.');
  end if;
  if tg_op = 'UPDATE' and old.decision is not null
     and (new.decision is distinct from old.decision or new.approver_person_id is distinct from old.approver_person_id) then
    perform private.refuse('approval_decided', 'A decided approval is final; raise a new approval instead.');
  end if;
  if new.decision is not null and (tg_op = 'INSERT' or old.decision is null) then
    if auth.uid() is not null then
      new.approver_person_id := v_me;
      if v_me = new.requester_person_id then
        perform private.refuse('sod_approval_requester', 'An approval is decided by an eligible approver, never the requester.');
      end if;
      if not private.can_on_project(v_project, 'work.record.write') then
        perform private.refuse('approval_not_eligible', 'Only a person who may write the project''s records decides its approvals.');
      end if;
    elsif new.approver_person_id = new.requester_person_id then
      perform private.refuse('sod_approval_requester', 'An approval is decided by an eligible approver, never the requester.');
    end if;
    new.decided_at := now();
  end if;
  return new;
end;
$$;

comment on function private.guard_record_approval() is 'Invariant 18 for Approval records: the decision is recorded by the session person, who must not be the requester and must be able to write the project''s records; a decision is final.';
revoke all on function private.guard_record_approval() from public, anon, authenticated;

create trigger t40_guard_record_approval before insert or update on app.record_approval
  for each row execute function private.guard_record_approval();

create table app.record_compliance (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  valid_from date,
  valid_to date,
  on_file_at timestamptz,
  constraint record_compliance_validity check (valid_to is null or valid_from is null or valid_to >= valid_from)
);
call private.install_record_extension('app.record_compliance', 'Compliance');
call private.describe('app.record_compliance', 'Compliance record attributes: a document that must be on file and current.', array[
  'valid_from', 'First day the document is valid.',
  'valid_to', 'Last day the document is valid; after it the document is stale.',
  'on_file_at', 'When the document was placed on file.'
]);

create table app.record_deadline (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  owed_to text
);
call private.install_record_extension('app.record_deadline', 'Deadline');
call private.describe('app.record_deadline', 'Deadline record attributes: an item owed. Who owes it comes from the subtype.', array[
  'owed_to', 'Party the item is owed to, as named in the obligation.'
]);

create table app.record_decision (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  options_considered text,
  decision_text text,
  decided_at timestamptz,
  decided_by uuid references app.people (id),
  constraint record_decision_decided_pair check ((decided_at is null) = (decided_by is null))
);
create index record_decision_decided_by_idx on app.record_decision (decided_by);
call private.install_record_extension('app.record_decision', 'Decision');
call private.describe('app.record_decision', 'Decision record attributes: a choice to be recorded.', array[
  'options_considered', 'The options weighed.',
  'decision_text', 'The choice made.',
  'decided_at', 'When the choice was made.',
  'decided_by', 'Person who made the choice.'
]);

create table app.record_inspection (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  result_enum_id text references xpms.std_enumeration (record_id),
  inspector_person_id uuid references app.people (id),
  inspected_at timestamptz
);
create index record_inspection_result_enum_id_idx on app.record_inspection (result_enum_id);
create index record_inspection_inspector_person_id_idx on app.record_inspection (inspector_person_id);
call private.install_record_extension('app.record_inspection', 'Inspection');
call private.describe('app.record_inspection', 'Inspection record attributes: a check that must be passed.', array[
  'result_enum_id', 'Inspection result: a row of the canon Inspection Result enumeration.',
  'inspector_person_id', 'Person who inspected.',
  'inspected_at', 'When the inspection took place.'
]);

create or replace function private.guard_record_inspection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_enumeration(new.result_enum_id, 'Inspection Result');
  return new;
end;
$$;

comment on function private.guard_record_inspection() is 'Inspection results come from the canon Inspection Result enumeration.';
revoke all on function private.guard_record_inspection() from public, anon, authenticated;

create trigger t40_guard_record_inspection before insert or update on app.record_inspection
  for each row execute function private.guard_record_inspection();

create table app.record_permit (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  permit_rule text references xpms.dim_permit_rule (rule),
  permit_identifier text,
  issued_at timestamptz,
  expires_at timestamptz,
  constraint record_permit_validity check (expires_at is null or issued_at is null or expires_at >= issued_at)
);
create index record_permit_permit_rule_idx on app.record_permit (permit_rule);
call private.install_record_extension('app.record_permit', 'Permit');
call private.describe('app.record_permit', 'Permit record attributes: an instrument issued by the authority.', array[
  'permit_rule', 'Canon permit rule that requires the permit (Bible tab 15).',
  'permit_identifier', 'Permit number issued by the authority (an identifier, recorded and never minted).',
  'issued_at', 'When the authority issued the permit.',
  'expires_at', 'When the permit expires.'
]);

-- Time ------------------------------------------------------------------------------------------------------

create table app.record_distribution (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  channel text,
  audience text,
  published_at timestamptz
);
call private.install_record_extension('app.record_distribution', 'Distribution');
call private.describe('app.record_distribution', 'Distribution record attributes: what is published or sent.', array[
  'channel', 'Channel the distribution goes out on.',
  'audience', 'Who receives it.',
  'published_at', 'When it went out.'
]);

create table app.record_event (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  venue_id uuid references app.venues (id),
  doors_at timestamptz,
  capacity integer,
  constraint record_event_capacity_positive check (capacity is null or capacity > 0)
);
create index record_event_venue_id_idx on app.record_event (venue_id);
call private.install_record_extension('app.record_event', 'Event', array['app.venues', 'venue_id']);
call private.describe('app.record_event', 'Event record attributes.', array[
  'venue_id', 'Venue the event takes place at.',
  'doors_at', 'When doors open.',
  'capacity', 'Audience capacity; NULL when not set.'
]);

create table app.record_goal (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  metric text,
  target_value numeric,
  measured_value numeric,
  unit_basis text references xpms.dim_unit_alias (alias)
);
create index record_goal_unit_basis_idx on app.record_goal (unit_basis);
call private.install_record_extension('app.record_goal', 'Goal');
call private.describe('app.record_goal', 'Goal record attributes: an outcome with its target and measurement (gate 1 objectives, gate 8 measurement).', array[
  'metric', 'What is measured.',
  'target_value', 'Target value of the metric.',
  'measured_value', 'Measured value; NULL is Unmeasured, never zero.',
  'unit_basis', 'Unit of the values, when the metric has one.'
]);

create table app.record_meeting (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  location_text text,
  conferencing_uri text
);
call private.install_record_extension('app.record_meeting', 'Meeting');
call private.describe('app.record_meeting', 'Meeting record attributes: a conversation.', array[
  'location_text', 'Where the meeting is held.',
  'conferencing_uri', 'Video conferencing link created through an integration.'
]);

create table app.record_milestone (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  achieved_at timestamptz
);
call private.install_record_extension('app.record_milestone', 'Milestone');
call private.describe('app.record_milestone', 'Milestone record attributes: a condition stated as already true.', array[
  'achieved_at', 'When the condition became true; NULL until then.'
]);

create table app.record_report (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  period_start date,
  period_end date,
  published_at timestamptz,
  constraint record_report_period check (period_end is null or period_start is null or period_end >= period_start)
);
call private.install_record_extension('app.record_report', 'Report');
call private.describe('app.record_report', 'Report record attributes: a publication.', array[
  'period_start', 'First day the report covers.',
  'period_end', 'Last day the report covers.',
  'published_at', 'When the report was published.'
]);

create table app.record_risk (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  likelihood smallint,
  impact smallint,
  score smallint generated always as (likelihood * impact) stored,
  mitigation text,
  constraint record_risk_likelihood_range check (likelihood is null or likelihood between 1 and 5),
  constraint record_risk_impact_range check (impact is null or impact between 1 and 5)
);
call private.install_record_extension('app.record_risk', 'Risk');
call private.describe('app.record_risk', 'Risk record attributes: an exposure.', array[
  'likelihood', 'Likelihood, 1 to 5.',
  'impact', 'Impact, 1 to 5.',
  'score', 'Likelihood times impact, generated; NULL when either is unrated.',
  'mitigation', 'How the exposure is reduced.'
]);

create table app.record_timeline (
  record_id uuid primary key,
  org_id uuid not null references app.organizations (id),
  baseline_locked_at timestamptz
);
call private.install_record_extension('app.record_timeline', 'Timeline');
call private.describe('app.record_timeline', 'Timeline record attributes: a window other records roll up into.', array[
  'baseline_locked_at', 'When the window was locked into the schedule baseline; NULL while it may move freely.'
]);
