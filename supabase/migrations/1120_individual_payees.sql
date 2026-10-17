-- 1120_individual_payees.sql
-- A43 (RRR-87), finding A38-007: a person engaged as an individual (no company account) can be billed and paid.
-- Invoices and payments named only a counterparty (an external organization), so a freelancer with no account
-- could neither be self-billed nor paid. Both now name exactly one payee:
--   * counterparty_id, the external account, as before; or
--   * payee_person_id, the engaged person, for a payable to someone the org engages as an individual.
-- An invoice also records the engagement it bills (engagement_id), required for a person payee so Gateway
-- scopes it to that engagement's money area (Section 8.7). Invoice and payment states are unchanged:
-- invoice_state Proposed, Issued, Approved, Disputed, Canceled; payment_state Proposed, Approved, Canceled.
-- The guards that compared counterparties with <> now compare payees with IS DISTINCT FROM, so a NULL
-- counterparty can neither slip past an immutability check nor match another payee.

-- Invoices ---------------------------------------------------------------------------------------------------

alter table app.invoices
  alter column counterparty_id drop not null,
  add column payee_person_id uuid references app.people (id),
  add column engagement_id uuid references app.engagements (id),
  add constraint invoices_one_payee check (num_nonnulls(counterparty_id, payee_person_id) = 1),
  add constraint invoices_person_payable check (payee_person_id is null or direction = 'Payable'),
  add constraint invoices_person_engagement check (payee_person_id is null or engagement_id is not null);

create index invoices_payee_person_id_idx on app.invoices (payee_person_id);
create index invoices_engagement_id_idx on app.invoices (engagement_id);
create unique index invoices_person_number_key on app.invoices (org_id, direction, payee_person_id, invoice_number)
  where payee_person_id is not null and invoice_number is not null and deleted_at is null;

comment on column app.invoices.counterparty_id is 'Client billed or vendor billing; NULL when a person engaged as an individual is the payee.';
comment on column app.invoices.payee_person_id is 'Person billing as an individual (a payable for someone engaged with no company account). Exactly one of counterparty_id and payee_person_id is set.';
comment on column app.invoices.engagement_id is 'Engagement the invoice bills, when it bills one; always set for a person payee.';

call private.install_tenant_guards('app.invoices', 'app.projects', 'project_id',
  array['app.counterparties', 'counterparty_id', 'app.engagements', 'engagement_id']);

create or replace function private.guard_invoice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
begin
  if tg_op = 'INSERT' then
    perform private.assert_production_open(new.project_id);
  elsif new.project_id <> old.project_id or new.direction <> old.direction or new.currency_code <> old.currency_code
        or new.counterparty_id is distinct from old.counterparty_id or new.payee_person_id is distinct from old.payee_person_id
        or new.engagement_id is distinct from old.engagement_id then
    perform private.refuse('invoice_immutable', 'An invoice keeps its project, direction, payee, engagement and currency.');
  end if;
  if tg_op = 'INSERT' and new.engagement_id is not null then
    select e.* into v_engagement from app.engagements e where e.id = new.engagement_id;
    if v_engagement.project_id <> new.project_id then
      perform private.refuse('invoice_engagement_project', 'An invoice bills an engagement of its own project.');
    end if;
    if new.counterparty_id is distinct from v_engagement.counterparty_id
       or (new.payee_person_id is not null and new.payee_person_id is distinct from v_engagement.person_id) then
      perform private.refuse('invoice_engagement_payee', 'The payee of an engagement invoice is the engaged party: its account, or the person when no account bills.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_invoice() is 'Invoices: no new invoice on a closed production (invariant 10); project, direction, payee, engagement and currency fixed; an engagement invoice is of the engagement''s project and names its party as payee.';

-- Payments ---------------------------------------------------------------------------------------------------

alter table app.payments
  alter column counterparty_id drop not null,
  add column payee_person_id uuid references app.people (id),
  add constraint payments_one_payee check (num_nonnulls(counterparty_id, payee_person_id) = 1),
  add constraint payments_person_payable check (payee_person_id is null or direction = 'Payable');

create index payments_payee_person_id_idx on app.payments (payee_person_id);

comment on column app.payments.counterparty_id is 'Counterparty paid or paying; NULL when the payee is a person engaged as an individual.';
comment on column app.payments.payee_person_id is 'Person paid as an individual. Exactly one of counterparty_id and payee_person_id is set.';
comment on column app.payments.org_id is 'Owning org, derived from the counterparty on insert. For a person payee it is the paying org, which must engage the person as an individual; never changed.';

-- A payment to a person has no counterparty to derive its org from. The org is the caller's (the insert
-- policy still demands finance.payment.write in it) and must engage the person with no account.
create or replace function private.derive_payment_org_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if new.counterparty_id is not null then
    select c.org_id into v_org from app.counterparties c where c.id = new.counterparty_id;
    if v_org is null then
      raise exception using errcode = '23503', message = 'payments.counterparty_id references a missing app.counterparties row';
    end if;
    new.org_id := v_org;
  elsif new.payee_person_id is null then
    raise exception using errcode = '23502', message = 'payments needs counterparty_id or payee_person_id';
  elsif new.org_id is null or not exists (
      select 1 from app.engagements e
      where e.org_id = new.org_id and e.person_id = new.payee_person_id and e.counterparty_id is null and e.deleted_at is null) then
    perform private.refuse('payment_payee_not_engaged', 'A payment to a person pays someone this org engages as an individual.');
  end if;
  return new;
end;
$$;

comment on function private.derive_payment_org_id() is 'Payments: org_id from the counterparty; for a person payee, the given org, which must engage the person as an individual. Replaces derive_org_id on app.payments.';
revoke all on function private.derive_payment_org_id() from public, anon, authenticated;

drop trigger t10_derive_org_id on app.payments;
create trigger t10_derive_payment_org_id before insert or update of counterparty_id, payee_person_id on app.payments
  for each row execute function private.derive_payment_org_id();

create or replace function private.guard_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.counterparty_id is distinct from old.counterparty_id or new.payee_person_id is distinct from old.payee_person_id
      or new.direction <> old.direction or new.currency_code <> old.currency_code or new.amount_minor <> old.amount_minor) then
    perform private.refuse('payment_immutable', 'A payment keeps its payee, direction, currency and amount; cancel it and record another.');
  end if;
  return new;
end;
$$;

comment on function private.guard_payment() is 'Payments keep their payee (counterparty or person), direction, currency and amount.';

create or replace function private.guard_payment_application()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment app.payments;
  v_invoice app.invoices;
  v_applied bigint;
  v_paid bigint;
  v_total bigint;
begin
  if tg_op = 'UPDATE' and (new.payment_id <> old.payment_id or new.invoice_id <> old.invoice_id or new.amount_minor <> old.amount_minor) then
    perform private.refuse('payment_application_immutable', 'An application is removed and recorded again, never edited.');
  end if;
  if new.deleted_at is not null then
    return new;
  end if;
  select * into v_payment from app.payments p where p.id = new.payment_id for update;
  select * into v_invoice from app.invoices i where i.id = new.invoice_id for update;
  if v_payment.counterparty_id is distinct from v_invoice.counterparty_id
     or v_payment.payee_person_id is distinct from v_invoice.payee_person_id
     or v_payment.direction <> v_invoice.direction or v_payment.currency_code <> v_invoice.currency_code then
    perform private.refuse('payment_application_mismatch', 'A payment settles invoices of the same payee, direction and currency.');
  end if;
  if v_payment.payment_state = 'Canceled' or v_invoice.invoice_state not in ('Issued', 'Approved', 'Disputed') then
    perform private.refuse('payment_application_state', 'Apply live payments to issued or approved invoices.');
  end if;
  select coalesce(sum(a.amount_minor), 0) into v_applied from app.payment_applications a
  where a.payment_id = new.payment_id and a.deleted_at is null and a.id <> new.id;
  if v_applied + new.amount_minor > v_payment.amount_minor then
    perform private.refuse('payment_overapplied', 'A payment is never applied beyond its amount.');
  end if;
  v_total := private.invoice_total(new.invoice_id);
  select coalesce(sum(a.amount_minor), 0) into v_paid from app.payment_applications a
  where a.invoice_id = new.invoice_id and a.deleted_at is null and a.id <> new.id;
  if v_total is null or v_paid + new.amount_minor > v_total then
    perform private.refuse('invoice_overpaid', 'An invoice is never paid beyond its total.');
  end if;
  return new;
end;
$$;

comment on function private.guard_payment_application() is 'Invariant 16: an application matches payee (counterparty or person), direction and currency, never exceeds the payment remaining or the invoice balance, and is never edited; the unique index applies a payment to an invoice once.';

-- The payee's display name for org members: the counterparty organization's name, or the engaged person's.
create or replace function app.payee_name(p_org_id uuid, p_counterparty_id uuid, p_payee_person_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_org_id not in (select private.my_org_ids()) then null
    when p_counterparty_id is not null then
      (select o.name from app.counterparties c join app.organizations o on o.id = c.organization_id
       where c.id = p_counterparty_id and c.org_id = p_org_id)
    else
      (select p.full_name from app.people p
       where p.id = p_payee_person_id
         and exists (select 1 from app.engagements e where e.org_id = p_org_id and e.person_id = p.id and e.deleted_at is null))
  end;
$$;

comment on function app.payee_name(uuid, uuid, uuid) is 'Name of an invoice or payment payee for members of the org: the counterparty organization, or a person the org engages. NULL for anyone else.';
revoke all on function app.payee_name(uuid, uuid, uuid) from public, anon;
grant execute on function app.payee_name(uuid, uuid, uuid) to authenticated, service_role;
