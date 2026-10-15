-- 0991_settlements.sql
-- A15 Finance, late slot (ADR 0022: settlements reference A28's engagements, 0700). The settlement of an
-- engagement (Section 4.5.8 Artist tab Settlement, Section 20.2 journey 45): the org drafts the
-- settlement lines (guarantee, bonuses, splits, deductions, expenses, withholding), submits it to the
-- engaged party under spend authority, the party (or the representative acting for the artist) accepts or
-- disputes it, and the org marks it paid. Amounts are minor units; a blank amount is unpriced and a
-- settlement with an unpriced line can be neither submitted nor accepted (Section 3.7). The total is derived
-- (app.settlement_totals), never stored. The api_external projection belongs to A28's 1000s range.

create type app.settlement_state as enum ('Proposed', 'Submitted', 'Accepted', 'Disputed', 'Paid', 'Canceled');
comment on type app.settlement_state is 'Settlement states: drafted (Proposed), Submitted to the party, Accepted or Disputed by the party, Paid by the org, or Canceled before payment.';

create type app.settlement_line_kind as enum ('Guarantee', 'Bonus', 'Split', 'Expense', 'Deduction', 'Withholding');
comment on type app.settlement_line_kind is 'Settlement line kinds. Guarantee, Bonus, Split and Expense add to what the party is paid; Deduction and Withholding subtract.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('settlement', 'Proposed', 'Submitted'),
  ('settlement', 'Proposed', 'Canceled'),
  ('settlement', 'Submitted', 'Accepted'),
  ('settlement', 'Submitted', 'Disputed'),
  ('settlement', 'Submitted', 'Proposed'),
  ('settlement', 'Submitted', 'Canceled'),
  ('settlement', 'Disputed', 'Proposed'),
  ('settlement', 'Disputed', 'Canceled'),
  ('settlement', 'Accepted', 'Paid');

insert into private.domain_event_types (code, subject, description) values
  ('settlement.drafted', 'settlements', 'A settlement was drafted for an engagement.'),
  ('settlement.state_changed', 'settlements', 'A settlement moved to another settlement state.');

-- Settlements --------------------------------------------------------------------------------------------

create table app.settlements (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  engagement_id uuid not null references app.engagements (id),
  project_id uuid not null references app.projects (id),
  settlement_number bigint not null default 0,
  title text not null,
  currency_code char(3) not null references private.currencies (currency_code),
  settled_on date,
  settlement_state app.settlement_state not null default 'Proposed',
  deleted_at timestamptz,
  constraint settlements_title_length check (char_length(btrim(title)) between 1 and 200)
);

create index settlements_engagement_id_idx on app.settlements (engagement_id);
create index settlements_project_id_idx on app.settlements (project_id);
create index settlements_currency_code_idx on app.settlements (currency_code);
create unique index settlements_project_number_key on app.settlements (project_id, settlement_number);

call private.install_domain_table('app.settlements', 'app.engagements', 'engagement_id', array['app.projects', 'project_id']);
call private.describe('app.settlements', 'Settlements of engagements (Section 4.5.8). Lines are edited only while Proposed; the total is derived and NULL while any line is unpriced.', array[
  'engagement_id', 'Engagement settled.',
  'project_id', 'Project of the engagement; always the engagement''s project.',
  'settlement_number', 'Number from the project''s display key sequence, issued on insert.',
  'title', 'Settlement title, for example the show it settles.',
  'currency_code', 'ISO 4217 currency of every line.',
  'settled_on', 'Date of the show or period settled.',
  'settlement_state', 'Settlement state. Changes only through the settlement RPCs.'
]);

call private.install_lifecycle('app.settlements', 'settlement_id', 'settlement_state', 'settlement', 'Proposed',
  $$settlement_id in (select s.id from app.settlements s where s.project_id in (select private.project_ids_with('finance.invoice.read'))
      or s.engagement_id in (select private.my_engagement_ids('money')))$$);

create table app.settlement_lines (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  settlement_id uuid not null references app.settlements (id),
  line_number integer not null,
  line_kind app.settlement_line_kind not null,
  description text not null,
  amount_minor bigint,
  deleted_at timestamptz,
  constraint settlement_lines_number_positive check (line_number > 0),
  constraint settlement_lines_description_length check (char_length(btrim(description)) between 1 and 500),
  constraint settlement_lines_amount_nonnegative check (amount_minor is null or amount_minor >= 0)
);

create unique index settlement_lines_number_key on app.settlement_lines (settlement_id, line_number) where deleted_at is null;

call private.install_domain_table('app.settlement_lines', 'app.settlements', 'settlement_id');
call private.describe('app.settlement_lines', 'Lines of a settlement. The amount is unsigned; the kind decides whether it adds or subtracts. A NULL amount is unpriced.', array[
  'settlement_id', 'Settlement the line belongs to.',
  'line_number', 'Order of the line.',
  'line_kind', 'Guarantee, Bonus, Split, Expense, Deduction or Withholding.',
  'description', 'What the line settles.',
  'amount_minor', 'Amount in minor units of the settlement currency; NULL is unpriced.'
]);

create or replace function private.guard_settlement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
begin
  select e.project_id into v_project from app.engagements e where e.id = new.engagement_id;
  if tg_op = 'INSERT' then
    new.project_id := v_project;
    perform private.assert_production_open(new.project_id);
    new.settlement_number := private.next_sequence(new.org_id, 'project:' || new.project_id::text);
  elsif new.engagement_id <> old.engagement_id or new.project_id <> old.project_id
        or new.settlement_number <> old.settlement_number or new.currency_code <> old.currency_code then
    perform private.refuse('settlement_immutable', 'A settlement keeps its engagement, project, number and currency.');
  end if;
  return new;
end;
$$;

comment on function private.guard_settlement() is 'Settlements: project from the engagement, number from the project sequence, no new settlement on a closed production (invariant 10), engagement, number and currency fixed.';

create trigger t40_guard_settlement before insert or update on app.settlements
  for each row execute function private.guard_settlement();

create or replace function private.guard_settlement_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select s.settlement_state from app.settlements s where s.id = new.settlement_id) <> 'Proposed' then
    perform private.refuse('settlement_locked', 'Settlement lines change only while the settlement is Proposed.');
  end if;
  if tg_op = 'UPDATE' and new.settlement_id <> old.settlement_id then
    perform private.refuse('settlement_line_immutable', 'A line stays on its settlement.');
  end if;
  return new;
end;
$$;

comment on function private.guard_settlement_line() is 'Settlement lines: editable only while the settlement is Proposed.';

create trigger t40_guard_settlement_line before insert or update on app.settlement_lines
  for each row execute function private.guard_settlement_line();

create trigger t90_emit_settlement_drafted after insert on app.settlements
  for each row execute function private.emit_row_event('settlement.drafted', 'project_id', 'engagement_id', 'title', 'currency_code');
create trigger t90_emit_settlement_state after insert on app.settlement_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('settlement.state_changed', 'settlements', 'settlement_id', 'from_state', 'to_state', 'reason');

-- Totals ---------------------------------------------------------------------------------------------------

create or replace function private.settlement_total(p_settlement_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select case when count(*) = 0 or count(*) filter (where l.amount_minor is null) > 0 then null
              else sum(case when l.line_kind in ('Deduction', 'Withholding') then -l.amount_minor else l.amount_minor end)::bigint end
  from app.settlement_lines l where l.settlement_id = p_settlement_id and l.deleted_at is null;
$$;

comment on function private.settlement_total(uuid) is 'Net settlement in minor units: additions less deductions and withholding; NULL with no lines or any unpriced line.';
revoke all on function private.settlement_total(uuid) from public, anon, authenticated;

create view app.settlement_totals with (security_invoker = true) as
select s.id as settlement_id, s.project_id, s.engagement_id, s.currency_code,
  count(l.id) as line_count,
  count(l.id) filter (where l.amount_minor is null) as unpriced_count,
  case when count(l.id) = 0 or count(l.id) filter (where l.amount_minor is null) > 0 then null
       else sum(case when l.line_kind in ('Deduction', 'Withholding') then -l.amount_minor else l.amount_minor end)::bigint end as net_minor
from app.settlements s
left join app.settlement_lines l on l.settlement_id = s.id and l.deleted_at is null
where s.deleted_at is null
group by s.id, s.project_id, s.engagement_id, s.currency_code;

call private.describe('app.settlement_totals', 'Settlement totals, NULL-aware: the net is NULL while any line is unpriced, with the unpriced count beside it.', array[
  'settlement_id', 'Settlement.',
  'project_id', 'Project.',
  'engagement_id', 'Engagement.',
  'currency_code', 'Currency.',
  'line_count', 'Lines on the settlement.',
  'unpriced_count', 'Lines whose amount is NULL.',
  'net_minor', 'Additions less deductions and withholding; NULL while any line is unpriced.'
]);

revoke all on app.settlement_totals from public, anon;
grant select on app.settlement_totals to authenticated, service_role;

-- RPCs -------------------------------------------------------------------------------------------------------

create or replace function app.submit_settlement(p_settlement_id uuid, p_reason text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_settlement app.settlements;
  v_total bigint;
  v_round uuid;
begin
  perform private.require_person();
  select * into v_settlement from app.settlements s where s.id = p_settlement_id and s.deleted_at is null for update;
  if v_settlement.id is null or not private.can_on_project(v_settlement.project_id, 'finance.invoice.approve') then
    raise exception using errcode = '42501', message = 'finance.invoice.approve is required on the project';
  end if;
  perform private.assert_separation('sod_approval_requester', private.current_person_id(), v_settlement.created_by);
  v_total := private.settlement_total(p_settlement_id);
  if v_total is null then
    perform private.refuse('settlement_unpriced', 'Every settlement line needs an amount before the settlement is submitted.');
  end if;
  if v_settlement.settlement_state <> 'Proposed' then
    perform private.refuse('settlement_state_conflict', 'Only a Proposed settlement can be submitted.');
  end if;
  -- Each drafting round is its own approval document: the ledger entry that opened the round (creation or
  -- a rework to Proposed). A reworked settlement may change amount, so earlier approvals never carry over.
  select t.id into v_round from app.settlement_state_transitions t
  where t.settlement_id = p_settlement_id and t.to_state = 'Proposed'
  order by t.created_at desc, t.id desc limit 1;
  if not private.approve_under_spend_authority(v_settlement.org_id, 'Contract', v_round, greatest(v_total, 0),
      v_settlement.currency_code, null, null) then
    return false;
  end if;
  perform private.transition_lifecycle('settlement', 'app.settlements', 'settlement_state', 'app.settlement_state_transitions',
    'settlement_id', p_settlement_id, 'Proposed', 'Submitted', p_reason);
  return true;
end;
$$;

comment on function app.submit_settlement(uuid, text) is 'Submits a fully priced settlement to the engaged party: finance.invoice.approve on the project, never by the person who drafted it (sod_approval_requester), under Contract spend authority (two approvers above the dual threshold); each drafting round is approved afresh, keyed by the ledger entry that opened it. Returns true once fully approved and submitted.';

create or replace function app.respond_to_settlement(p_settlement_id uuid, p_accept boolean, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_settlement app.settlements;
begin
  perform private.require_person();
  select * into v_settlement from app.settlements s where s.id = p_settlement_id and s.deleted_at is null for update;
  if v_settlement.id is null or v_settlement.engagement_id not in (select private.my_engagement_ids('money')) then
    raise exception using errcode = '42501', message = 'the money area of this engagement is not open to the caller';
  end if;
  return private.transition_lifecycle('settlement', 'app.settlements', 'settlement_state', 'app.settlement_state_transitions',
    'settlement_id', p_settlement_id, 'Submitted', case when p_accept then 'Accepted' else 'Disputed' end, p_reason);
end;
$$;

comment on function app.respond_to_settlement(uuid, boolean, text) is 'The engaged party, or the representative acting for the artist, accepts or disputes a submitted settlement while the engagement''s money area is open to them (Section 8.7).';

create or replace function app.transition_settlement(p_settlement_id uuid, p_expected app.settlement_state, p_next app.settlement_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_settlement app.settlements;
  v_capability text := case when p_next = 'Paid' then 'finance.payment.write' else 'finance.invoice.write' end;
begin
  if p_next in ('Submitted', 'Accepted', 'Disputed') then
    perform private.refuse('settlement_use_rpc', 'Submit through app.submit_settlement; the party accepts or disputes through app.respond_to_settlement.');
  end if;
  perform private.require_person();
  select * into v_settlement from app.settlements s where s.id = p_settlement_id and s.deleted_at is null;
  if v_settlement.id is null or not private.can_on_project(v_settlement.project_id, v_capability) then
    raise exception using errcode = '42501', message = format('%s is required on the project', v_capability);
  end if;
  return private.transition_lifecycle('settlement', 'app.settlements', 'settlement_state', 'app.settlement_state_transitions',
    'settlement_id', p_settlement_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_settlement(uuid, app.settlement_state, app.settlement_state, text) is 'Reworks, cancels or marks paid a settlement with compare-and-set. Paid needs finance.payment.write; the rest finance.invoice.write.';

-- Policies, retention, audit and comments ------------------------------------------------------------------------

call private.install_policies('app.settlements',
  $$project_id in (select private.project_ids_with('finance.invoice.read'))
    or engagement_id in (select private.my_engagement_ids('money'))$$,
  $$project_id in (select private.project_ids_with('finance.invoice.write'))$$);
call private.install_policies('app.settlement_lines',
  $$exists (select 1 from app.settlements s where s.id = settlement_id
      and (s.project_id in (select private.project_ids_with('finance.invoice.read'))
           or s.engagement_id in (select private.my_engagement_ids('money'))))$$,
  $$exists (select 1 from app.settlements s where s.id = settlement_id
      and s.project_id in (select private.project_ids_with('finance.invoice.write')))$$);

call private.install_default_retention('app.settlements');
call private.install_default_retention('app.settlement_lines');
call private.install_default_retention('app.settlement_state_transitions');
call private.install_audit_trail('app.settlements');
call private.install_audit_trail('app.settlement_lines');
insert into private.comment_subjects (table_name) values ('app.settlements');

revoke all on function private.guard_settlement() from public, anon, authenticated;
revoke all on function private.guard_settlement_line() from public, anon, authenticated;
revoke all on function app.submit_settlement(uuid, text) from public, anon;
revoke all on function app.respond_to_settlement(uuid, boolean, text) from public, anon;
revoke all on function app.transition_settlement(uuid, app.settlement_state, app.settlement_state, text) from public, anon;
grant execute on function app.submit_settlement(uuid, text) to authenticated, service_role;
grant execute on function app.respond_to_settlement(uuid, boolean, text) to authenticated, service_role;
grant execute on function app.transition_settlement(uuid, app.settlement_state, app.settlement_state, text) to authenticated, service_role;
