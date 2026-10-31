-- 3014_per_diem_payments.sql
-- B12 (RRR-236, the per diems of gap G-184; decision 20, ADR 0151 item 3). app.per_diems (0341, with the columns 0981
-- and 2692 added) recorded allowances, and nothing said they were paid. A per diem now carries its payment: the date the
-- money moved and the remittance reference, recorded by a person holding finance.payment.write who is not the worker.
--   * paid_on and paid_reference are written only by app.record_per_diem_payments and app.clear_per_diem_payment, under
--     private.in_trusted_operation('per_diem_payment'), so the crew.time_entry.write write policy (2692) cannot mark a
--     per diem paid (per_diem_payment_rpc).
--   * Once paid, a per diem keeps its amount, currency, day, worker and allocation and stays out of Trash
--     (per_diem_paid_locked) until its payment is cleared.
--   * The worker is the person of the membership, of the engagement, or of the roster entry through
--     private.roster_people (2633); app.payments_due (3015) and app.engagement_cost_items (3018) read the same resolver.
--   * app.can_record_payments says whether the signed-in person records payments in an org, for showing controls only
--     (the app.can_add_per_diems pattern, 2603).
-- api_external.per_diems is unchanged.

alter table app.per_diems
  add column paid_on date,
  add column paid_reference text,
  add constraint per_diems_paid_reference check (paid_reference is null or paid_on is not null),
  add constraint per_diems_paid_reference_length check (paid_reference is null or char_length(btrim(paid_reference)) between 1 and 200);

create index per_diems_project_paid_on_idx on app.per_diems (project_id, paid_on);

comment on column app.per_diems.paid_on is 'Date the allowance was paid to the worker; NULL while unpaid. Written only by app.record_per_diem_payments and cleared only by app.clear_per_diem_payment (3014).';
comment on column app.per_diems.paid_reference is 'Remittance reference of the payment, such as a bank or card reference; only with paid_on.';

-- The worker ---------------------------------------------------------------------------------------------------------------

create or replace function private.per_diem_person(p_per_diem_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(m.person_id, e.person_id, rp.person_id)
  from app.per_diems d
  left join app.memberships m on m.id = d.membership_id
  left join app.engagements e on e.id = d.engagement_id
  left join private.roster_people rp on rp.roster_entry_id = d.roster_entry_id
  where d.id = p_per_diem_id;
$$;

comment on function private.per_diem_person(uuid) is 'The person a per diem is paid to: the person of its membership, of its engagement, or of its roster entry (private.roster_people). NULL for an unclaimed roster invitation. Unfiltered: read only inside definer functions.';
revoke all on function private.per_diem_person(uuid) from public, anon, authenticated;

-- The guard ----------------------------------------------------------------------------------------------------------------

create or replace function private.guard_per_diem_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.in_trusted_operation('per_diem_payment') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.paid_on is not null or new.paid_reference is not null then
      perform private.refuse('per_diem_payment_rpc', 'A per diem is marked paid through app.record_per_diem_payments.');
    end if;
    return new;
  end if;
  if new.paid_on is distinct from old.paid_on or new.paid_reference is distinct from old.paid_reference then
    perform private.refuse('per_diem_payment_rpc', 'A per diem is marked paid through app.record_per_diem_payments.');
  end if;
  if old.paid_on is not null and (
       new.amount_minor <> old.amount_minor or new.currency_code <> old.currency_code or new.day <> old.day
       or new.membership_id is distinct from old.membership_id or new.engagement_id is distinct from old.engagement_id
       or new.roster_entry_id is distinct from old.roster_entry_id or new.allocation_id is distinct from old.allocation_id
       or new.deleted_at is distinct from old.deleted_at) then
    perform private.refuse('per_diem_paid_locked', 'A paid per diem stays as it was paid; clear its payment first.');
  end if;
  return new;
end;
$$;

comment on function private.guard_per_diem_payment() is 'Per diem payments (3014): paid_on and paid_reference change only inside app.record_per_diem_payments and app.clear_per_diem_payment (per_diem_payment_rpc), and a paid per diem keeps its amount, currency, day, worker and allocation and stays out of Trash (per_diem_paid_locked).';
revoke all on function private.guard_per_diem_payment() from public, anon, authenticated;

create trigger t44_guard_per_diem_payment before insert or update on app.per_diems
  for each row execute function private.guard_per_diem_payment();

-- Recording and clearing ---------------------------------------------------------------------------------------------------

create or replace function app.record_per_diem_payments(p_per_diem_ids uuid[], p_paid_on date, p_reference text default null)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_ids uuid[] := array(select distinct u from unnest(coalesce(p_per_diem_ids, '{}'::uuid[])) u where u is not null);
  v_orgs uuid[];
  v_found integer;
  v_reference text := nullif(btrim(coalesce(p_reference, '')), '');
  v_count integer;
begin
  if cardinality(v_ids) not between 1 and 500 then
    perform private.refuse('per_diem_payment_batch', 'Mark 1 to 500 per diems paid at a time.');
  end if;
  select array_agg(distinct d.org_id), count(*) into v_orgs, v_found
  from app.per_diems d where d.id = any (v_ids) and d.deleted_at is null;
  if v_found <> cardinality(v_ids) or cardinality(v_orgs) <> 1
     or not private.has_capability(v_orgs[1], 'finance.payment.write') then
    raise exception using errcode = '42501', message = 'finance.payment.write is required in the org of every per diem';
  end if;
  perform private.assert_separation('sod_reimbursement_payee', v_person, private.per_diem_person(u)) from unnest(v_ids) u;
  if p_paid_on is null then
    perform private.refuse('per_diem_payment_date', 'Give the date the per diems were paid.');
  end if;
  perform 1 from app.per_diems d where d.id = any (v_ids) order by d.id for update;
  if exists (select 1 from app.per_diems d where d.id = any (v_ids) and d.paid_on is not null) then
    perform private.refuse('per_diem_already_paid', 'One of these per diems is already paid.');
  end if;

  perform private.begin_trusted_operation('per_diem_payment');
  update app.per_diems d set paid_on = p_paid_on, paid_reference = v_reference where d.id = any (v_ids);
  get diagnostics v_count = row_count;
  perform private.end_trusted_operation('per_diem_payment');

  perform private.write_audit_event(v_orgs[1], 'crew.per_diems_paid', 'app.per_diems', u,
    jsonb_build_object('paid_on', p_paid_on, 'paid_reference', v_reference, 'batch', to_jsonb(v_ids)))
  from unnest(v_ids) u;
  return v_count;
end;
$$;

comment on function app.record_per_diem_payments(uuid[], date, text) is 'Records that 1 to 500 live, unpaid per diems of one org were paid on p_paid_on, with an optional remittance reference. Needs finance.payment.write in the org (42501), refuses a per diem whose worker is the caller (sod_reimbursement_payee) and one already paid (per_diem_already_paid). Writes a crew.per_diems_paid audit event per per diem and returns how many were marked. XOS records the payment and moves no money (decision 20).';
revoke all on function app.record_per_diem_payments(uuid[], date, text) from public, anon;
grant execute on function app.record_per_diem_payments(uuid[], date, text) to authenticated, service_role;

create or replace function app.clear_per_diem_payment(p_per_diem_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_per_diem app.per_diems;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  select * into v_per_diem from app.per_diems d where d.id = p_per_diem_id and d.deleted_at is null for update;
  if v_per_diem.id is null or not private.has_capability(v_per_diem.org_id, 'finance.payment.write') then
    raise exception using errcode = '42501', message = 'finance.payment.write is required';
  end if;
  perform private.assert_separation('sod_reimbursement_payee', v_person, private.per_diem_person(v_per_diem.id));
  if char_length(v_reason) not between 1 and 500 then
    perform private.refuse('per_diem_payment_reason', 'Say why the payment is cleared, in up to 500 characters.');
  end if;
  if v_per_diem.paid_on is null then
    perform private.refuse('per_diem_not_paid', 'This per diem has no payment to clear.');
  end if;
  perform private.begin_trusted_operation('per_diem_payment');
  update app.per_diems d set paid_on = null, paid_reference = null where d.id = v_per_diem.id;
  perform private.end_trusted_operation('per_diem_payment');
  perform private.write_audit_event(v_per_diem.org_id, 'crew.per_diem_payment_cleared', 'app.per_diems', v_per_diem.id,
    jsonb_build_object('paid_on', v_per_diem.paid_on, 'paid_reference', v_per_diem.paid_reference, 'reason', v_reason));
  return v_per_diem.id;
end;
$$;

comment on function app.clear_per_diem_payment(uuid, text) is 'Undoes a per diem payment recorded in error, with a reason of 1 to 500 characters: clears paid_on and paid_reference. Needs finance.payment.write in the org (42501), refuses the worker (sod_reimbursement_payee) and an unpaid per diem (per_diem_not_paid). Writes the crew.per_diem_payment_cleared audit event.';
revoke all on function app.clear_per_diem_payment(uuid, text) from public, anon;
grant execute on function app.clear_per_diem_payment(uuid, text) to authenticated, service_role;

create or replace function app.can_record_payments(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.has_capability(p_org_id, 'finance.payment.write'), false);
$$;

comment on function app.can_record_payments(uuid) is 'Whether the signed-in person records payments in the org (finance.payment.write): Atlas shows Mark paid, Clear payment, Record reimbursement and Void by it. For showing controls only; the RPCs check again.';
revoke all on function app.can_record_payments(uuid) from public, anon;
grant execute on function app.can_record_payments(uuid) to authenticated, service_role;
