-- 3012_expense_reimbursements.sql
-- B12 (RRR-236, gap G-228; decision 76, decision 20, ADR 0029 item 3, ADR 0151 item 2). A reimbursable expense is
-- Recorded while Proposed, Owed once approved and Paid once a reimbursement is recorded for it. XOS records the payment
-- with its date and remittance reference and moves no money.
--   * app.record_expense_reimbursement records one reimbursement for Approved reimbursable charges of one payee in one
--     currency, at their net (each amount less its approved and paid credits), and moves them to Paid. It needs
--     finance.payment.write and refuses the payee themselves (sod_reimbursement_payee). Recording is one step, like a
--     per diem payment (3014): unlike an invoice payment (1123, sod_vendor_payment) no second person approves it, a
--     deliberate choice under decision 20 that ADR 0151 item 2 records for the owner to confirm.
--   * app.void_expense_reimbursement voids it with a reason and returns its expenses to Approved, the only use of the
--     new Paid to Approved rule. Leaving Paid through app.transition_expense is refused (expense_paid_final), and a
--     reimbursable charge reaches Paid only with a reimbursement (expense_reimbursement_use_rpc). A credit still moves
--     to Paid through app.transition_expense when the refund is received.
--   * expense.approved is emitted only when an expense is approved from Proposed, so a void that returns an expense to
--     Approved emits nothing (the 0321 trigger, recreated with that condition).
--   * app.submit_expense_receipt (1490) gains p_is_reimbursable, trailing and defaulting to false, and keeps one
--     signature: app.apply_sync_mutation binds arguments by name (0364), so a queued call from an older Compass build
--     without the argument still replays.
--   * app.reimbursement_balances and app.owed_reimbursable_expenses read every reimbursable expense of the org for a
--     finance.payment.read holder, as definer functions, so the figures are complete rather than partial sums under the
--     expense read policy.

-- 1. Lifecycle ---------------------------------------------------------------------------------------------------------

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('expense', 'Paid', 'Approved')
on conflict do nothing;

insert into private.separation_of_duties_rules (code, enforced_on, description) values
  ('sod_reimbursement_payee', 'Expense reimbursements, per diem payments', 'A person cannot record a reimbursement or a per diem payment to themselves.')
on conflict (code) do nothing;

drop trigger t90_emit_expense_approved on app.expense_state_transitions;
create trigger t90_emit_expense_approved after insert on app.expense_state_transitions
  for each row when (new.to_state = 'Approved' and new.from_state = 'Proposed')
  execute function private.emit_subject_event('expense.approved', 'expenses', 'expense_id', 'from_state', 'to_state');

-- 2. Moving an expense (from 1622) -------------------------------------------------------------------------------------

create or replace function app.transition_expense(p_expense_id uuid, p_expected app.expense_state, p_next app.expense_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_expense app.expenses;
  v_project uuid;
begin
  if p_expected = 'Paid' then
    perform private.refuse('expense_paid_final', 'A paid expense stays paid; void its reimbursement to reopen it.');
  end if;
  if p_next in ('Approved', 'Rejected') then
    perform private.refuse('expense_use_approval_rpc', 'Approve or reject an expense through app.approve_expense or app.reject_expense.');
  end if;
  select * into v_expense from app.expenses e where e.id = p_expense_id and e.deleted_at is null;
  select b.project_id into v_project from app.budgets b join app.budget_lines bl on bl.budget_id = b.id where bl.id = v_expense.budget_line_id;
  if v_expense.id is null
     or (p_next = 'Paid' and not private.has_capability(v_expense.org_id, 'finance.payment.write'))
     or (p_next <> 'Paid' and v_expense.submitter_person_id is distinct from v_person
         and not private.can_on_project(v_project, 'finance.expense.approve')) then
    raise exception using errcode = '42501', message = 'the person may not make this expense transition';
  end if;
  if p_next = 'Paid' and v_expense.is_reimbursable then
    perform private.refuse('expense_reimbursement_use_rpc', 'A reimbursable expense is paid by recording its reimbursement.');
  end if;
  return private.transition_lifecycle('expense', 'app.expenses', 'expense_state', 'app.expense_state_transitions',
    'expense_id', p_expense_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_expense(uuid, app.expense_state, app.expense_state, text) is 'Cancels or resubmits an expense (its submitter, or someone with finance.expense.approve on the project, 1622) or marks it Paid (finance.payment.write): for a credit, the refund was received. A reimbursable charge is paid only by recording its reimbursement (expense_reimbursement_use_rpc), and a Paid expense never leaves Paid here (expense_paid_final): voiding its reimbursement reopens it (3012). Approval and rejection go through their own RPCs.';
revoke all on function app.transition_expense(uuid, app.expense_state, app.expense_state, text) from public, anon;
grant execute on function app.transition_expense(uuid, app.expense_state, app.expense_state, text) to authenticated, service_role;

-- 3. Filing from Compass (from 1490) -------------------------------------------------------------------------------------
-- Dropped and created, not replaced: a second signature would make the RPC unreplayable (private.sync_call, 0364). The
-- private.sync_rpcs row names the RPC, not a signature, and stays.

drop function app.submit_expense_receipt(uuid, uuid, text, bigint, text, date, text, text, timestamptz, uuid);

create function app.submit_expense_receipt(
  p_id uuid,
  p_budget_line_id uuid,
  p_description text,
  p_amount_minor bigint,
  p_currency_code text,
  p_incurred_on date,
  p_media_uri text,
  p_capture_source text default 'Camera',
  p_captured_at timestamptz default null,
  p_ai_suggestion_id uuid default null,
  p_is_reimbursable boolean default false
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_uuid constant text := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  v_line record;
  v_existing app.expenses;
  v_suggestion app.ai_suggestions;
  v_uri text := btrim(coalesce(p_media_uri, ''));
begin
  if p_id is null then
    perform private.refuse('expense_receipt_id_required', 'An expense filed from a device carries its own id.');
  end if;
  select bl.id, bl.org_id, b.project_id into v_line
  from app.budget_lines bl join app.budgets b on b.id = bl.budget_id
  where bl.id = p_budget_line_id and bl.deleted_at is null and b.deleted_at is null;
  if v_line.id is null or not private.can_on_project(v_line.project_id, 'finance.expense.write') then
    raise exception using errcode = '42501', message = 'finance.expense.write is required on the budget line''s project';
  end if;

  -- A replay of the same filing returns the expense it made; another person's or another line's id is refused.
  select * into v_existing from app.expenses e where e.id = p_id;
  if v_existing.id is not null then
    if v_existing.submitter_person_id is distinct from v_person or v_existing.budget_line_id <> p_budget_line_id then
      perform private.refuse('expense_receipt_id_taken', 'Another expense already uses this id.');
    end if;
    return v_existing.id;
  end if;

  if v_uri !~ ('^' || v_uuid || '/expense-receipts/' || v_uuid || '/[^/]+$')
     or split_part(v_uri, '/', 1)::uuid <> v_line.org_id or split_part(v_uri, '/', 3)::uuid <> v_line.project_id then
    perform private.refuse('expense_receipt_path',
      'The receipt photo is stored under the budget line''s org and project: <org_id>/expense-receipts/<project_id>/<file name>.');
  end if;

  if p_ai_suggestion_id is not null then
    select * into v_suggestion from app.ai_suggestions s where s.id = p_ai_suggestion_id and s.deleted_at is null;
    if v_suggestion.id is null or not private.ai_request_is_mine(v_suggestion.request_id)
       or v_suggestion.operation_id <> 'expenses.create' or v_suggestion.org_id <> v_line.org_id then
      perform private.refuse('expense_receipt_suggestion', 'The receipt names an AI suggestion that is not your receipt extraction.');
    end if;
  end if;

  insert into app.expenses (id, budget_line_id, description, incurred_on, amount_minor, currency_code, is_reimbursable)
  values (p_id, p_budget_line_id, btrim(coalesce(p_description, '')), p_incurred_on, p_amount_minor,
    upper(btrim(coalesce(p_currency_code, ''))), coalesce(p_is_reimbursable, false));
  insert into app.expense_receipts (expense_id, media_uri, capture_source, captured_at, ai_suggestion_id)
  values (p_id, v_uri, coalesce(p_capture_source, 'Camera'), p_captured_at, p_ai_suggestion_id);

  -- The person confirmed the fields Aurora proposed (Section 4.7: a person confirms before anything is written), so a
  -- suggestion still waiting is confirmed and applied with this expense; an expired or decided one stays as it is.
  if v_suggestion.id is not null and v_suggestion.suggestion_state = 'Proposed' and v_suggestion.expires_at > now() then
    perform app.transition_ai_suggestion(v_suggestion.id, 'Proposed', 'Confirmed', 'Checked against the receipt in Compass.');
    perform app.transition_ai_suggestion(v_suggestion.id, 'Confirmed', 'Applied',
      'Written by expenses.create from Compass with the receipt.', p_id);
  end if;
  return p_id;
end;
$$;

comment on function app.submit_expense_receipt(uuid, uuid, text, bigint, text, date, text, text, timestamptz, uuid, boolean) is 'Files an expense against one budget line with its receipt photo (already stored in field-media under the line''s org and project) for a person with finance.expense.write on the project, from Compass online or offline. Idempotent on the device-minted expense id. When p_ai_suggestion_id names the caller''s Aurora receipt extraction, a Proposed suggestion is confirmed and applied with the expense. p_is_reimbursable (3012) files it as paid out of the person''s pocket; omitted, as an older Compass build sends it, it is false. One signature, so app.apply_sync_mutation replays it by name.';
revoke all on function app.submit_expense_receipt(uuid, uuid, text, bigint, text, date, text, text, timestamptz, uuid, boolean) from public, anon;
grant execute on function app.submit_expense_receipt(uuid, uuid, text, bigint, text, date, text, text, timestamptz, uuid, boolean) to authenticated, service_role;

insert into private.sync_rpcs (rpc, description) values
  ('app.submit_expense_receipt', 'A person files an expense with its receipt photo from Compass, online or offline.')
on conflict do nothing;

-- 4. Recording and voiding a reimbursement -------------------------------------------------------------------------------

create or replace function private.expense_credited_minor(p_expense_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(c.amount_minor), 0)::bigint
  from app.expenses c
  where c.credit_of_expense_id = p_expense_id and c.deleted_at is null and c.expense_state in ('Approved', 'Paid');
$$;

comment on function private.expense_credited_minor(uuid) is 'Approved and paid credits against an expense, in minor units; zero when none. Unfiltered: read only inside definer functions.';
revoke all on function private.expense_credited_minor(uuid) from public, anon, authenticated;

create or replace function app.record_expense_reimbursement(
  p_payee_person_id uuid,
  p_expense_ids uuid[],
  p_paid_on date,
  p_reference text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_ids uuid[] := array(select distinct u from unnest(coalesce(p_expense_ids, '{}'::uuid[])) u where u is not null);
  v_orgs uuid[];
  v_org uuid;
  v_currency text;
  v_total bigint;
  v_id uuid;
begin
  if cardinality(v_ids) not between 1 and 200 then
    perform private.refuse('expense_reimbursement_batch', 'A reimbursement settles 1 to 200 expenses.');
  end if;
  select array_agg(distinct e.org_id) into v_orgs from app.expenses e where e.id = any (v_ids);
  v_org := v_orgs[1];
  if v_org is null or cardinality(v_orgs) <> 1 or not private.has_capability(v_org, 'finance.payment.write') then
    raise exception using errcode = '42501', message = 'finance.payment.write is required in the org of every expense';
  end if;
  perform private.assert_separation('sod_reimbursement_payee', v_person, p_payee_person_id);
  if p_paid_on is null then
    perform private.refuse('expense_reimbursement_date', 'Give the date the money moved.');
  end if;
  perform 1 from app.expenses e where e.id = any (v_ids) order by e.id for update;
  if exists (
      select 1 from unnest(v_ids) u
      left join app.expenses e on e.id = u
      where e.id is null or e.deleted_at is not null or e.credit_of_expense_id is not null or not e.is_reimbursable
         or e.expense_state <> 'Approved' or e.submitter_person_id is distinct from p_payee_person_id
         or e.amount_minor - private.expense_credited_minor(e.id) <= 0) then
    perform private.refuse('expense_reimbursement_expense', 'Reimburse live, approved, reimbursable expenses the payee filed and is still owed.');
  end if;
  if (select count(distinct e.currency_code) from app.expenses e where e.id = any (v_ids)) <> 1 then
    perform private.refuse('expense_reimbursement_currency', 'A reimbursement settles expenses in one currency.');
  end if;
  if exists (select 1 from app.expenses c
             where c.credit_of_expense_id = any (v_ids) and c.deleted_at is null and c.expense_state = 'Proposed') then
    perform private.refuse('expense_reimbursement_pending_credit', 'A credit waits for approval on one of these expenses; decide it first.');
  end if;

  select min(e.currency_code), sum(e.amount_minor - private.expense_credited_minor(e.id))::bigint
  into v_currency, v_total
  from app.expenses e where e.id = any (v_ids);
  insert into app.expense_reimbursements (org_id, payee_person_id, currency_code, paid_minor, paid_on, reference_identifier)
  values (v_org, p_payee_person_id, v_currency, v_total, p_paid_on, nullif(btrim(coalesce(p_reference, '')), ''))
  returning id into v_id;

  perform private.begin_trusted_operation('expense_reimbursement');
  update app.expenses e set reimbursement_id = v_id where e.id = any (v_ids);
  perform private.transition_lifecycle('expense', 'app.expenses', 'expense_state', 'app.expense_state_transitions',
    'expense_id', u, 'Approved', 'Paid', format('Reimbursed on %s.', p_paid_on))
  from unnest(v_ids) u;
  perform private.end_trusted_operation('expense_reimbursement');

  perform private.write_audit_event(v_org, 'finance.expense_reimbursed', 'app.expense_reimbursements', v_id,
    jsonb_build_object('payee_person_id', p_payee_person_id, 'expense_ids', to_jsonb(v_ids), 'paid_minor', v_total,
      'currency_code', v_currency, 'paid_on', p_paid_on));
  return v_id;
end;
$$;

comment on function app.record_expense_reimbursement(uuid, uuid[], date, text) is 'Records that 1 to 200 Approved reimbursable charges of one payee in one currency were reimbursed on p_paid_on, with an optional remittance reference: one app.expense_reimbursements row at their net (each amount less approved and paid credits), the expenses linked and moved to Paid. Needs finance.payment.write in their org (42501), refuses the payee (sod_reimbursement_payee), a missing date, other payees'' or unapproved expenses, mixed currencies and expenses with a Proposed credit pending. Writes the finance.expense_reimbursed audit event. XOS records the payment and moves no money (decision 20).';
revoke all on function app.record_expense_reimbursement(uuid, uuid[], date, text) from public, anon;
grant execute on function app.record_expense_reimbursement(uuid, uuid[], date, text) to authenticated, service_role;

create or replace function app.void_expense_reimbursement(p_reimbursement_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_reimbursement app.expense_reimbursements;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_ids uuid[];
begin
  select * into v_reimbursement from app.expense_reimbursements r
  where r.id = p_reimbursement_id and r.deleted_at is null for update;
  if v_reimbursement.id is null or not private.has_capability(v_reimbursement.org_id, 'finance.payment.write') then
    raise exception using errcode = '42501', message = 'finance.payment.write is required';
  end if;
  perform private.assert_separation('sod_reimbursement_payee', v_person, v_reimbursement.payee_person_id);
  if char_length(v_reason) not between 1 and 500 then
    perform private.refuse('expense_reimbursement_void_reason', 'Say why the reimbursement is voided, in up to 500 characters.');
  end if;
  if v_reimbursement.voided_at is not null then
    perform private.refuse('expense_reimbursement_voided', 'This reimbursement is already voided.');
  end if;
  update app.expense_reimbursements r set voided_at = now(), voided_by = v_person, void_reason = v_reason
  where r.id = v_reimbursement.id;

  select array_agg(e.id order by e.id) into v_ids from app.expenses e where e.reimbursement_id = v_reimbursement.id;
  perform private.begin_trusted_operation('expense_reimbursement');
  perform private.transition_lifecycle('expense', 'app.expenses', 'expense_state', 'app.expense_state_transitions',
    'expense_id', u, 'Paid', 'Approved', left('Reimbursement voided: ' || v_reason, 500))
  from unnest(coalesce(v_ids, '{}'::uuid[])) u;
  update app.expenses e set reimbursement_id = null where e.reimbursement_id = v_reimbursement.id;
  perform private.end_trusted_operation('expense_reimbursement');

  perform private.write_audit_event(v_reimbursement.org_id, 'finance.expense_reimbursement_voided', 'app.expense_reimbursements',
    v_reimbursement.id, jsonb_build_object('expense_ids', to_jsonb(coalesce(v_ids, '{}'::uuid[])), 'void_reason', v_reason));
  return v_reimbursement.id;
end;
$$;

comment on function app.void_expense_reimbursement(uuid, text) is 'Voids a reimbursement recorded in error, with a reason of 1 to 500 characters: stamps voided_at, voided_by and void_reason, returns its expenses to Approved (Owed again) and clears their link. Needs finance.payment.write (42501), refuses the payee (sod_reimbursement_payee) and a second void (expense_reimbursement_voided). Writes the finance.expense_reimbursement_voided audit event.';
revoke all on function app.void_expense_reimbursement(uuid, text) from public, anon;
grant execute on function app.void_expense_reimbursement(uuid, text) to authenticated, service_role;

-- 5. Balances --------------------------------------------------------------------------------------------------------------

create or replace function app.reimbursement_balances(p_org_id uuid, p_project_id uuid default null)
returns table (
  payee_person_id uuid,
  payee_name text,
  currency_code text,
  recorded_count integer,
  recorded_minor bigint,
  owed_count integer,
  owed_minor bigint,
  paid_minor bigint,
  last_paid_on date
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_org_id is null or not private.has_capability(p_org_id, 'finance.payment.read') then
    raise exception using errcode = '42501', message = 'finance.payment.read is required';
  end if;
  return query
  with x as (
    select e.submitter_person_id as payee, e.currency_code::text as currency, e.expense_state, e.reimbursement_id,
      e.amount_minor - private.expense_credited_minor(e.id) as net
    from app.expenses e
    join app.budget_lines bl on bl.id = e.budget_line_id
    join app.budgets b on b.id = bl.budget_id
    where e.org_id = p_org_id and e.deleted_at is null and e.is_reimbursable and e.credit_of_expense_id is null
      and (p_project_id is null or b.project_id = p_project_id)
  )
  select x.payee, p.full_name, x.currency,
    (count(*) filter (where x.expense_state = 'Proposed'))::integer,
    coalesce(sum(x.net) filter (where x.expense_state = 'Proposed'), 0)::bigint,
    (count(*) filter (where x.expense_state = 'Approved'))::integer,
    coalesce(sum(x.net) filter (where x.expense_state = 'Approved'), 0)::bigint,
    coalesce(sum(x.net) filter (where x.expense_state = 'Paid' and r.id is not null), 0)::bigint,
    max(r.paid_on)
  from x
  join app.people p on p.id = x.payee
  left join app.expense_reimbursements r on r.id = x.reimbursement_id and r.deleted_at is null and r.voided_at is null
  where x.expense_state in ('Proposed', 'Approved', 'Paid')
  group by x.payee, p.full_name, x.currency
  order by 7 desc, 2 nulls last, 1;
end;
$$;

comment on function app.reimbursement_balances(uuid, uuid) is 'Reimbursable charges per payee and currency in an org, optionally one project, net of approved credits: Recorded (Proposed), Owed (Approved) and Paid (settled by a live, unvoided reimbursement), with the last paid date. Ordered by what is owed, most first, then by name. Needs finance.payment.read in the org (42501), and then reads every expense, so no figure is a partial sum.';
revoke all on function app.reimbursement_balances(uuid, uuid) from public, anon;
grant execute on function app.reimbursement_balances(uuid, uuid) to authenticated, service_role;

create or replace function app.owed_reimbursable_expenses(p_org_id uuid, p_payee_person_id uuid)
returns table (
  expense_id uuid,
  project_key text,
  description text,
  incurred_on date,
  currency_code text,
  net_minor bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_org_id is null or not private.has_capability(p_org_id, 'finance.payment.read') then
    raise exception using errcode = '42501', message = 'finance.payment.read is required';
  end if;
  return query
  select e.id, pr.project_key::text, e.description, e.incurred_on, e.currency_code::text,
    (e.amount_minor - private.expense_credited_minor(e.id))::bigint
  from app.expenses e
  join app.budget_lines bl on bl.id = e.budget_line_id
  join app.budgets b on b.id = bl.budget_id
  join app.projects pr on pr.id = b.project_id
  where e.org_id = p_org_id and e.submitter_person_id = p_payee_person_id and e.deleted_at is null
    and e.is_reimbursable and e.credit_of_expense_id is null and e.expense_state = 'Approved'
  order by e.incurred_on, e.id;
end;
$$;

comment on function app.owed_reimbursable_expenses(uuid, uuid) is 'The Approved reimbursable charges a payee is owed in an org, each at its net (amount less approved credits): exactly the expenses app.reimbursement_balances counts as Owed, for the Record reimbursement sheet. Needs finance.payment.read in the org (42501).';
revoke all on function app.owed_reimbursable_expenses(uuid, uuid) from public, anon;
grant execute on function app.owed_reimbursable_expenses(uuid, uuid) to authenticated, service_role;
