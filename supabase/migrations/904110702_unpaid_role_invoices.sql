-- 4.11 fix (crawl 4.9, RRR-243): a client or sponsor engagement submits no invoice to the org. A client pays the org
-- and a sponsor contributes to a project; the org pays neither (ADR 0019 decision 69), and Gateway hides the paid-work
-- pages from them. Yet app.submit_engagement_invoice checked only the money area and the account role, so a sponsor's
-- Account Owner created a Payable invoice to the org from the engagement's Invoices tab, and Money then showed it as
-- pending pay. It now refuses both role types (invoice_unpaid_role) after the access checks and before writing anything. Every other party submits
-- as before, and invoices the org sends a client are untouched. The definition starts from 1122, the latest; the
-- signature, security definer, search_path, grants (0765) and description stay, and the description now says so.
create or replace function app.submit_engagement_invoice(
  p_engagement_id uuid,
  p_invoice_number text,
  p_issued_on date,
  p_due_on date,
  p_currency_code text,
  p_lines jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_invoice uuid;
  v_line jsonb;
  v_number integer := 0;
  v_urid text;
  v_person uuid := private.require_person();
begin
  select e.* into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  if v_engagement.id is null
     or not private.engagement_area_open(v_engagement.id, v_engagement.person_id, v_engagement.counterparty_id, v_engagement.role_type,
                                         v_engagement.engagement_state, 'money') then
    raise exception using errcode = '42501', message = 'the money area of this engagement is not open to the caller';
  end if;
  if v_engagement.counterparty_id is null then
    if v_engagement.person_id is distinct from v_person then
      raise exception using errcode = '42501', message = 'only the person engaged submits an individual''s invoices';
    end if;
  elsif v_engagement.counterparty_id not in (
      select c.id from app.counterparties c
      where c.organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin', 'Account Finance']::app.account_role[]))) then
    raise exception using errcode = '42501', message = 'an Account Owner, Admin or Finance member submits the account''s invoices';
  end if;
  -- A client pays the org and a sponsor contributes to a project; the org pays neither (ADR 0019 decision 69).
  if v_engagement.role_type in ('Client', 'Sponsor') then
    perform private.refuse('invoice_unpaid_role', 'The organization never pays a client or sponsor engagement, so it takes no invoice from one.');
  end if;
  if p_invoice_number is null or char_length(btrim(p_invoice_number)) not between 1 and 60 then
    perform private.refuse('invoice_number_required', 'Give the invoice your own invoice number.');
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    perform private.refuse('invoice_lines_required', 'An invoice needs at least one line.');
  end if;
  insert into app.invoices (project_id, direction, counterparty_id, payee_person_id, engagement_id, invoice_number, issued_on, due_on, currency_code)
  values (v_engagement.project_id, 'Payable', v_engagement.counterparty_id,
          case when v_engagement.counterparty_id is null then v_person end, v_engagement.id,
          btrim(p_invoice_number), p_issued_on, p_due_on, p_currency_code)
  returning id into v_invoice;
  -- Lines post under the engagement role's discipline, as self-billed lines do, so the org can approve them.
  select d.disc_code into v_urid from xpms.role ro join xpms.dim_discipline d on d.disc_code = left(ro.role_code, 7)
  where ro.role_code = v_engagement.role_code;
  for v_line in select x from jsonb_array_elements(p_lines) x loop
    v_number := v_number + 1;
    insert into app.invoice_lines (invoice_id, line_number, description, quantity, unit_price_minor, urid)
    values (v_invoice, v_number, v_line ->> 'description', coalesce((v_line ->> 'quantity')::numeric, 1), (v_line ->> 'unit_price_minor')::bigint, v_urid);
  end loop;
  return v_invoice;
end;
$$;

comment on function app.submit_engagement_invoice(uuid, text, date, date, text, jsonb) is 'The engaged party submits a payable invoice against its engagement while the money area is open (Section 4.4.5): the account''s Owner, Admin or Finance member for an account, or the person engaged as an individual. A client or sponsor engagement, which the org never pays, submits none (invoice_unpaid_role, ADR 0019 decision 69). Lines are an array of {description, quantity, unit_price_minor}; a missing price stays unpriced, and each line carries the engagement role''s discipline as its URID for posting. The invoice arrives Proposed for the org to approve. Returns the invoice id.';

revoke all on function app.submit_engagement_invoice(uuid, text, date, date, text, jsonb) from public, anon;
grant execute on function app.submit_engagement_invoice(uuid, text, date, date, text, jsonb) to authenticated, service_role;
