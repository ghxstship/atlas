-- 1124_form_1099_nec.sql
-- A43 (RRR-87), finding A38-006: the 1099-NEC data export for US payees (Section 4.4.5 year-end, 14.9).
--   * app.tax_forms gains the W-9 name and mailing address (lines 1, 5 and 6 of the form), which a 1099-NEC
--     needs and the platform did not hold; the payee sets them with app.set_tax_form_address.
--   * app.form_1099_nec_rows(org, year, include_tin) lists, per payee, the approved USD payments the org made in
--     the calendar year to people and accounts it engages as independent contractors, from $600 (60,000
--     minor units). Each row says whether a W-9 is on file and whether its address is complete. Without the
--     TIN it needs finance.payment.read; with the full TIN it is a Restricted export: data.export.restricted
--     and step-up authentication (aal2), and each export is written to the audit log.
-- The CSV in the IRS FIRE field layout is written by packages/data (form-1099.ts) from these rows.

alter table app.tax_forms
  add column legal_name text,
  add column street_address text,
  add column locality text,
  add column region_code text,
  add column postal_code text,
  add constraint tax_forms_legal_name_length check (legal_name is null or char_length(btrim(legal_name)) between 1 and 200),
  add constraint tax_forms_street_length check (street_address is null or char_length(btrim(street_address)) between 1 and 200),
  add constraint tax_forms_locality_length check (locality is null or char_length(btrim(locality)) between 1 and 100),
  add constraint tax_forms_region_format check (region_code is null or region_code ~ '^[A-Z]{2}$'),
  add constraint tax_forms_postal_format check (postal_code is null or form_kind <> 'W-9' or postal_code ~ '^[0-9]{5}(-[0-9]{4})?$');

comment on column app.tax_forms.legal_name is 'Name as shown on the form (W-9 line 1); NULL uses the person''s or account''s name.';
comment on column app.tax_forms.street_address is 'Mailing street address from the form (W-9 line 5).';
comment on column app.tax_forms.locality is 'City from the form (W-9 line 6).';
comment on column app.tax_forms.region_code is 'Two-letter state or region code from the form (W-9 line 6), for example CA.';
comment on column app.tax_forms.postal_code is 'Postal code from the form (W-9 line 6); five digits or ZIP+4 on a W-9.';

create or replace function app.set_tax_form_address(
  p_tax_form_id uuid,
  p_legal_name text,
  p_street_address text,
  p_locality text,
  p_region_code text,
  p_postal_code text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_form app.tax_forms;
begin
  perform private.require_person();
  select t.* into v_form from app.tax_forms t where t.id = p_tax_form_id and t.deleted_at is null for update;
  if v_form.id is null or not (
      v_form.person_id = private.current_person_id()
      or v_form.organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin', 'Account Finance']::app.account_role[]))) then
    raise exception using errcode = '42501', message = 'only the payee completes its tax form';
  end if;
  if nullif(btrim(coalesce(p_street_address, '')), '') is null or nullif(btrim(coalesce(p_locality, '')), '') is null
     or nullif(btrim(coalesce(p_postal_code, '')), '') is null then
    perform private.refuse('tax_form_address_incomplete', 'Give the street address, city and postal code as they appear on the form.');
  end if;
  update app.tax_forms set legal_name = nullif(btrim(coalesce(p_legal_name, '')), ''), street_address = btrim(p_street_address),
    locality = btrim(p_locality), region_code = nullif(upper(btrim(coalesce(p_region_code, ''))), ''), postal_code = btrim(p_postal_code)
  where id = p_tax_form_id;
  return p_tax_form_id;
end;
$$;

comment on function app.set_tax_form_address(uuid, text, text, text, text, text) is 'The payee (the person, or the account''s Owner, Admin or Finance member) records the name and mailing address on its tax form, which the 1099-NEC export needs. Returns the form id.';
revoke all on function app.set_tax_form_address(uuid, text, text, text, text, text) from public, anon;
grant execute on function app.set_tax_form_address(uuid, text, text, text, text, text) to authenticated, service_role;

create or replace view api_external.tax_forms as
select t.id, t.org_id, o.name as org_name, t.person_id, t.organization_id as account_id, t.form_kind, t.tin_last4,
  t.foreign_performer_withholding, t.signed_at, t.legal_name, t.street_address, t.locality, t.region_code, t.postal_code
from app.tax_forms t
join app.organizations o on o.id = t.org_id
where t.deleted_at is null
  and (t.person_id = private.current_person_id()
    or t.organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin', 'Account Finance']::app.account_role[])));

call private.describe('api_external.tax_forms', 'The caller''s own tax forms and their account''s; only the last four of the identifier. Own tax documents never close (Section 8.7).', array[
  'id', 'Tax form.', 'org_id', 'Org the form was given to.', 'org_name', 'Org name.', 'person_id', 'Payee person.',
  'account_id', 'Payee account.', 'form_kind', 'W-9, W-8BEN or W-8BEN-E.', 'tin_last4', 'Last four of the identifier.',
  'foreign_performer_withholding', 'Foreign performer withholding applies.', 'signed_at', 'When signed.',
  'legal_name', 'Name as shown on the form.', 'street_address', 'Mailing street address.', 'locality', 'City.',
  'region_code', 'State or region code.', 'postal_code', 'Postal code.']);

-- The year-end rows ------------------------------------------------------------------------------------------

create or replace function app.form_1099_nec_rows(p_org_id uuid, p_year integer, p_include_tin boolean default false)
returns table (
  payee_person_id uuid,
  payee_organization_id uuid,
  payee_name text,
  tax_form_id uuid,
  w9_on_file boolean,
  tin_type smallint,
  tin_last4 text,
  tin text,
  street_address text,
  locality text,
  region_code text,
  postal_code text,
  address_complete boolean,
  amount_minor bigint,
  payment_count integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_person();
  if not private.has_capability(p_org_id, 'finance.payment.read') then
    raise exception using errcode = '42501', message = 'finance.payment.read is required';
  end if;
  if p_year is null or p_year < 2020 or p_year > extract(year from current_date)::integer then
    perform private.refuse('form_1099_year', 'Choose a tax year from 2020 to this year.');
  end if;
  if p_include_tin then
    if not private.has_capability(p_org_id, 'data.export.restricted') then
      perform private.refuse('export_restricted', 'The 1099-NEC file carries Restricted tax identifiers and needs the restricted export capability.');
    end if;
    if private.session_aal() <> 'aal2' then
      perform private.refuse('step_up_required', 'Exporting Restricted columns needs step-up authentication.');
    end if;
  end if;

  return query
  with paid as (
    select pm.payee_person_id as person_id, c.organization_id, sum(pm.amount_minor)::bigint as amount_minor, count(*)::integer as payment_count
    from app.payments pm
    left join app.counterparties c on c.id = pm.counterparty_id
    where pm.org_id = p_org_id and pm.deleted_at is null and pm.direction = 'Payable' and pm.payment_state = 'Approved'
      and pm.currency_code = 'USD' and pm.paid_on >= make_date(p_year, 1, 1) and pm.paid_on < make_date(p_year + 1, 1, 1)
    group by 1, 2
  ),
  contractors as (
    select p.* from paid p
    where p.amount_minor >= 60000
      and exists (
        select 1 from app.engagements e
        left join app.counterparties ec on ec.id = e.counterparty_id
        where e.org_id = p_org_id and e.deleted_at is null and e.worker_classification = 'INDEPENDENT_CONTRACTOR'
          and ((p.person_id is not null and e.counterparty_id is null and e.person_id = p.person_id)
            or (p.organization_id is not null and ec.organization_id = p.organization_id)))
  )
  select k.person_id, k.organization_id,
    coalesce(w.legal_name, case when k.person_id is not null then pe.full_name else o.name end),
    w.id, w.id is not null,
    case when w.id is null then null when k.person_id is not null then 2 else 1 end::smallint,
    w.tin_last4,
    case when p_include_tin and w.id is not null then private.tax_form_tin(w.id) end,
    w.street_address, w.locality, w.region_code, w.postal_code,
    (w.street_address is not null and w.locality is not null and w.region_code is not null and w.postal_code is not null),
    k.amount_minor, k.payment_count
  from contractors k
  left join app.people pe on pe.id = k.person_id
  left join app.organizations o on o.id = k.organization_id
  left join lateral (
    select t.* from app.tax_forms t
    where t.org_id = p_org_id and t.deleted_at is null and t.form_kind = 'W-9'
      and ((k.person_id is not null and t.person_id = k.person_id) or (k.organization_id is not null and t.organization_id = k.organization_id))
    order by t.signed_at desc
    limit 1
  ) w on true
  order by 3, 1, 2;

  if p_include_tin then
    perform private.write_audit_event(p_org_id, 'finance.form_1099_nec_exported', 'app.tax_forms', null,
      jsonb_build_object('tax_year', p_year, 'classification', 'Restricted'));
  end if;
end;
$$;

comment on function app.form_1099_nec_rows(uuid, integer, boolean) is 'Section 4.4.5 year-end: per payee, the approved USD payments the org made in the calendar year to people and accounts it engages as independent contractors, from $600, with the latest W-9 on file and its address. Needs finance.payment.read; with p_include_tin the full TIN is a Restricted export (data.export.restricted, step-up aal2) written to the audit log. TIN type 2 (SSN) for a person and 1 (EIN) for an account.';
revoke all on function app.form_1099_nec_rows(uuid, integer, boolean) from public, anon;
grant execute on function app.form_1099_nec_rows(uuid, integer, boolean) to authenticated, service_role;
