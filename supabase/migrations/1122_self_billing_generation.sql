-- 1122_self_billing_generation.sql
-- A43 (RRR-87), finding A38-007. Generation and submission for individuals:
--   * app.generate_self_billed_invoice bills the engagement's account, or the engaged person when there is
--     no account, from approved timesheets and from milestones accepted in the period (1121);
--   * app.submit_engagement_invoice lets a person engaged as an individual submit their own invoice.
-- Both set the invoice's engagement_id (1120).

create or replace function app.generate_self_billed_invoice(p_engagement_id uuid, p_period_start date, p_period_end date)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_enabled boolean;
  v_invoice uuid;
  v_line uuid;
  v_number integer := 0;
  v_urid text;
  v_currency text;
  v_time_zone text;
  r record;
begin
  perform private.require_person();
  select e.* into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  if v_engagement.id is null or not private.can_on_project(v_engagement.project_id, 'finance.invoice.write') then
    raise exception using errcode = '42501', message = 'finance.invoice.write is required on the project';
  end if;
  select s.value_boolean into v_enabled
  from app.resolve_settings(v_engagement.org_id, v_engagement.project_id) s where s.setting_key = 'finance.self_billing_enabled';
  if v_enabled is not true then
    perform private.refuse('self_billing_disabled', 'Self-billing is off for this project; turn it on in Legal Entities and Fiscal settings first.');
  end if;
  if not exists (select 1 from app.self_billing_agreements a
                 where a.engagement_id = p_engagement_id and a.revoked_at is null and a.deleted_at is null) then
    perform private.refuse('self_billing_not_agreed', 'The party has not agreed to self-billing on this engagement; they agree in Gateway.');
  end if;
  if p_period_start is null or p_period_end is null or p_period_end < p_period_start then
    perform private.refuse('self_billing_period', 'Choose a period whose end is on or after its start.');
  end if;
  v_currency := coalesce(v_engagement.currency_code,
    (select s.value_text from app.resolve_settings(v_engagement.org_id) s where s.setting_key = 'org.base_currency'));
  if v_currency is null then
    perform private.refuse('self_billing_currency', 'The engagement has no currency; set its rate and currency first.');
  end if;
  select d.disc_code into v_urid from xpms.role ro join xpms.dim_discipline d on d.disc_code = left(ro.role_code, 7)
  where ro.role_code = v_engagement.role_code;
  select p.time_zone into v_time_zone from app.projects p where p.id = v_engagement.project_id;

  for r in
    select 'timesheet' as source, t.id, t.period_start as sort_on,
      format('Approved timesheet %s to %s.', t.period_start, t.period_end) as description,
      case when v_engagement.pay_basis = 'Day Rate' then
        (select count(distinct (te.clock_in at time zone v_time_zone)::date) from app.time_entries te
         where te.engagement_id = t.engagement_id and te.deleted_at is null and te.clock_out is not null
           and (te.clock_in at time zone v_time_zone)::date between t.period_start and t.period_end)::numeric
      else round(coalesce(h.worked_minutes, 0)::numeric / 60, 2) end as quantity,
      case when v_engagement.pay_basis in ('Hourly', 'Day Rate') then v_engagement.agreed_rate_minor end as unit_price_minor
    from app.timesheets t
    join app.timesheet_hours h on h.timesheet_id = t.id
    where t.engagement_id = p_engagement_id and t.deleted_at is null and t.timesheet_state = 'Approved'
      and t.period_start >= p_period_start and t.period_end <= p_period_end
      and not exists (
        select 1 from app.self_billed_timesheets b
        join app.invoice_lines l on l.id = b.invoice_line_id
        join app.invoices i on i.id = l.invoice_id
        where b.timesheet_id = t.id and l.deleted_at is null and i.deleted_at is null and i.invoice_state <> 'Canceled')
    union all
    select 'deliverable', d.id, (d.decided_at at time zone v_time_zone)::date,
      format('Accepted milestone: %s.', rtrim(rec.title, '.')), 1::numeric, d.fee_minor
    from app.engagement_deliverables d
    join app.records rec on rec.id = d.record_id
    where d.engagement_id = p_engagement_id and d.deleted_at is null and d.deliverable_state = 'Accepted'
      and (d.decided_at at time zone v_time_zone)::date between p_period_start and p_period_end
      and not exists (
        select 1 from app.self_billed_deliverables b
        join app.invoice_lines l on l.id = b.invoice_line_id
        join app.invoices i on i.id = l.invoice_id
        where b.engagement_deliverable_id = d.id and l.deleted_at is null and i.deleted_at is null and i.invoice_state <> 'Canceled')
    order by 3, 1
  loop
    if v_invoice is null then
      insert into app.invoices (org_id, project_id, direction, counterparty_id, payee_person_id, engagement_id, invoice_number, issued_on, currency_code)
      values (v_engagement.org_id, v_engagement.project_id, 'Payable', v_engagement.counterparty_id,
              case when v_engagement.counterparty_id is null then v_engagement.person_id end, v_engagement.id,
              format('SB-%s-%s', to_char(p_period_end, 'YYYYMMDD'), left(replace(p_engagement_id::text, '-', ''), 8)),
              current_date, v_currency)
      returning id into v_invoice;
    end if;
    v_number := v_number + 1;
    insert into app.invoice_lines (org_id, invoice_id, line_number, description, quantity, unit_price_minor, urid)
    values (v_engagement.org_id, v_invoice, v_number, left(r.description, 500), r.quantity, r.unit_price_minor, v_urid)
    returning id into v_line;
    if r.source = 'timesheet' then
      insert into app.self_billed_timesheets (org_id, invoice_line_id, timesheet_id) values (v_engagement.org_id, v_line, r.id);
    else
      insert into app.self_billed_deliverables (org_id, invoice_line_id, engagement_deliverable_id) values (v_engagement.org_id, v_line, r.id);
    end if;
  end loop;

  if v_invoice is null then
    perform private.refuse('self_billing_nothing_to_bill', 'No approved timesheets or accepted milestones in this period are waiting to be billed.');
  end if;
  perform private.emit_event(v_engagement.org_id, 'invoice.self_billed', 'invoices', v_invoice, v_engagement.project_id,
    jsonb_build_object('engagement_id', p_engagement_id, 'line_count', v_number));
  return v_invoice;
end;
$$;

comment on function app.generate_self_billed_invoice(uuid, date, date) is 'Section 4.4.5 self-billing: generates a Proposed payable invoice for the engaged party (its account, or the person engaged as an individual) with one line per approved timesheet in the period and per milestone accepted in it, each not already billed. Needs finance.invoice.write on the project, the finance.self_billing_enabled setting and a live self_billing_agreements row. Hourly engagements bill worked hours and Day Rate engagements worked days at the agreed rate; milestones bill their fee; anything else bills unpriced for the org to price before approval (Section 3.7). Returns the invoice id.';

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
  for v_line in select x from jsonb_array_elements(p_lines) x loop
    v_number := v_number + 1;
    insert into app.invoice_lines (invoice_id, line_number, description, quantity, unit_price_minor)
    values (v_invoice, v_number, v_line ->> 'description', coalesce((v_line ->> 'quantity')::numeric, 1), (v_line ->> 'unit_price_minor')::bigint);
  end loop;
  return v_invoice;
end;
$$;

comment on function app.submit_engagement_invoice(uuid, text, date, date, text, jsonb) is 'The engaged party submits a payable invoice against its engagement while the money area is open (Section 4.4.5): the account''s Owner, Admin or Finance member for an account, or the person engaged as an individual. Lines are an array of {description, quantity, unit_price_minor}; a missing price stays unpriced. The invoice arrives Proposed for the org to approve. Returns the invoice id.';
