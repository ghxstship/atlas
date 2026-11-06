-- 3044_invoice_tie_out.sql
-- B15 invoice and receipt lines, tie-out and vendor history (RRR-239, parity gap G-225; ADR 0154). An invoice keeps the total
-- it printed as a fact, and the residual against its lines is computed, never stored (ADR 0103 style). The residual is a
-- warning: it never blocks approval or posting and does not touch app.invoice_matches.
--
--   * app.invoices.printed_total_minor: the total as printed, set from the document on save.
--   * app.invoice_tie_out: printed total against app.invoice_totals, by row level security.
--   * app.vendor_line_history: what the same counterparty billed before, computed in code and never sent to a model.
--   * app.apply_invoice_line_suggestions: adds kept lines, as the caller, so RLS and private.guard_invoice_line decide.

alter table app.invoices add column printed_total_minor bigint,
  add constraint invoices_printed_total_nonnegative check (printed_total_minor is null or printed_total_minor >= 0);
comment on column app.invoices.printed_total_minor is 'The total the document printed, in minor units, as a fact (B15). Null when none was read. The computed total stays in app.invoice_totals; app.invoice_tie_out compares them.';

create view app.invoice_tie_out with (security_invoker = true) as
select t.invoice_id, i.printed_total_minor,
  (t.subtotal_minor + t.tax_minor)::bigint as computed_total_minor,
  (i.printed_total_minor - (t.subtotal_minor + t.tax_minor))::bigint as residual_minor
from app.invoice_totals t
join app.invoices i on i.id = t.invoice_id;

comment on view app.invoice_tie_out is 'An invoice''s printed total against its lines (B15). computed_total_minor is subtotal_minor + tax_minor from app.invoice_totals, null while a line is unpriced or the invoice has none; residual_minor is null when either side is null. Tolerance is zero. Never stored and never a gate: it blocks neither approval nor posting.';
comment on column app.invoice_tie_out.invoice_id is 'Invoice.';
comment on column app.invoice_tie_out.printed_total_minor is 'The total the document printed.';
comment on column app.invoice_tie_out.computed_total_minor is 'Subtotal plus tax of the invoice''s lines; null while unpriced.';
comment on column app.invoice_tie_out.residual_minor is 'Printed total minus computed total; null when either is null.';

grant select on app.invoice_tie_out to authenticated, service_role;
revoke select on app.invoice_tie_out from xos_backup;

create or replace function app.vendor_line_history(p_invoice_id uuid, p_descriptions text[])
returns table (
  description_index integer,
  description text,
  quantity numeric,
  unit_price_minor bigint,
  currency_code text,
  invoice_number text,
  issued_on date,
  budget_line_id uuid,
  budget_line_name text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
begin
  if coalesce(cardinality(p_descriptions), 0) > 50 then
    raise exception using errcode = 'XR001', hint = 'aurora_intake_item_invalid',
      message = 'aurora_intake_item_invalid: Look up at most 50 lines at a time.';
  end if;
  return query
    with inv as (
      select i.id, i.counterparty_id, i.project_id, i.direction from app.invoices i
      where i.id = p_invoice_id and i.deleted_at is null and i.counterparty_id is not null
    ),
    named as (
      select n.ord::integer as idx, lower(btrim(n.text)) as probe
      from unnest(p_descriptions) with ordinality n (text, ord)
      where btrim(coalesce(n.text, '')) <> ''
    )
    select nm.idx, h.description, h.quantity, h.unit_price_minor, h.currency_code, h.invoice_number, h.issued_on,
      h.budget_line_id, h.budget_line_name
    from named nm
    cross join inv
    cross join lateral (
      select l.description, l.quantity, l.unit_price_minor, i2.currency_code::text as currency_code, i2.invoice_number, i2.issued_on,
        case when i2.project_id = inv.project_id then l.budget_line_id end as budget_line_id,
        case when i2.project_id = inv.project_id then bl.description end as budget_line_name
      from app.invoices i2
      join app.invoice_lines l on l.invoice_id = i2.id and l.deleted_at is null
      left join app.budget_lines bl on bl.id = l.budget_line_id
      where i2.counterparty_id = inv.counterparty_id and i2.direction = inv.direction and i2.id <> inv.id and i2.deleted_at is null
        and extensions.similarity(lower(btrim(l.description)), nm.probe) >= 0.3
      order by extensions.similarity(lower(btrim(l.description)), nm.probe) desc, i2.issued_on desc nulls last, l.id desc
      limit 3
    ) h
    order by nm.idx;
end;
$$;

comment on function app.vendor_line_history(uuid, text[]) is 'For each description (at most 50, aurora_intake_item_invalid otherwise), up to three prior live lines the same counterparty billed in the same direction with a trigram similarity of 0.3 or more, leaving out the invoice itself (B15). Returns description, quantity, unit price, currency, invoice number, issue date, and the budget line with its name only when the prior invoice is on the same project. Nothing for an individual payee, who has no counterparty (1120). Security invoker, so row level security decides what it reads. Calls no model, and the history is never sent to one.';

create or replace function app.apply_invoice_line_suggestions(p_invoice_id uuid, p_items jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_currency text;
  v_item jsonb;
  v_values jsonb;
  v_key text;
  v_line integer := 0;
  v_number integer;
  v_seen uuid[] := '{}';
  v_suggestion_id uuid;
  v_suggestion app.ai_suggestions;
  v_header_id uuid;
  v_header_currency text;
  v_description text;
  v_quantity numeric;
  v_price bigint;
  v_budget uuid;
  v_id uuid;
  v_written jsonb := '[]';
  v_state text;
  v_message text;
  v_hint text;
begin
  select i.currency_code::text into v_currency from app.invoices i where i.id = p_invoice_id and i.deleted_at is null;
  if v_currency is null then
    raise exception using errcode = '42501', message = 'the invoice is not visible to you';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 40 then
    raise exception using errcode = 'XR001', hint = 'aurora_intake_item_invalid',
      message = 'aurora_intake_item_invalid: Add between 1 and 40 lines.';
  end if;
  select coalesce(max(l.line_number), 0) into v_number from app.invoice_lines l where l.invoice_id = p_invoice_id and l.deleted_at is null;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_line := v_line + 1;
    begin
      v_suggestion_id := (v_item ->> 'suggestion_id')::uuid;
      select * into v_suggestion from app.ai_suggestions s where s.id = v_suggestion_id and s.deleted_at is null;
      -- Row level security shows this row to its asker and to audit readers; app.transition_ai_suggestion
      -- below refuses anyone but the asker, which rolls back the call.
      if v_suggestion.id is null then
        raise exception using errcode = '42501', message = 'only the person who asked adds these lines';
      end if;
      if v_suggestion.operation_id <> 'invoiceLines.create' or v_suggestion_id = any (v_seen)
         or v_suggestion.suggestion_state <> 'Proposed' or v_suggestion.expires_at <= now() then
        raise exception using errcode = 'XR001', hint = 'aurora_intake_item_invalid',
          message = 'aurora_intake_item_invalid: This line is not a proposed invoice line.';
      end if;
      v_seen := v_seen || v_suggestion_id;
      -- A line belongs to the invoice its request's header suggestion was saved as.
      select h.id into v_header_id from app.ai_suggestions h
      where h.request_id = v_suggestion.request_id and h.operation_id = 'invoices.create' and h.suggestion_state = 'Applied'
        and h.applied_id = p_invoice_id and h.deleted_at is null;
      if v_header_id is null then
        raise exception using errcode = 'XR001', hint = 'aurora_invoice_lines_foreign',
          message = 'aurora_invoice_lines_foreign: These lines were read for another invoice.';
      end if;
      select f.proposed_value #>> '{}' into v_header_currency from app.ai_suggestion_fields f
      where f.suggestion_id = v_header_id and f.field_path = 'currency_code' and f.refusal is null and f.deleted_at is null;
      if v_header_currency is not null and upper(v_header_currency) <> v_currency then
        raise exception using errcode = 'XR001', hint = 'aurora_invoice_currency',
          message = 'aurora_invoice_currency: The document''s currency is not the invoice''s.';
      end if;
      v_values := coalesce(v_item -> 'values', '{}'::jsonb);
      for v_key in select jsonb_object_keys(v_values) loop
        if not (v_key = any (array['description', 'quantity', 'unit_price_minor', 'budget_line_id'])) then
          raise exception using errcode = 'XR001', hint = 'aurora_intake_item_invalid',
            message = format('aurora_intake_item_invalid: It cannot set %s.', v_key);
        end if;
      end loop;
      select coalesce(v_values ->> 'description', f.proposed_value #>> '{}') into v_description
      from (select 1) x left join app.ai_suggestion_fields f
        on f.suggestion_id = v_suggestion_id and f.field_path = 'description' and f.refusal is null and f.deleted_at is null;
      select coalesce((v_values ->> 'quantity')::numeric, (f.proposed_value #>> '{}')::numeric, 1) into v_quantity
      from (select 1) x left join app.ai_suggestion_fields f
        on f.suggestion_id = v_suggestion_id and f.field_path = 'quantity' and f.refusal is null and f.deleted_at is null;
      select case when v_values ? 'unit_price_minor' then (v_values ->> 'unit_price_minor')::bigint else (f.proposed_value #>> '{}')::bigint end
      into v_price
      from (select 1) x left join app.ai_suggestion_fields f
        on f.suggestion_id = v_suggestion_id and f.field_path = 'unit_price_minor' and f.refusal is null and f.deleted_at is null;
      v_budget := nullif(v_values ->> 'budget_line_id', '')::uuid;
      v_number := v_number + 1;
      insert into app.invoice_lines (invoice_id, line_number, description, quantity, unit_price_minor, budget_line_id)
      values (p_invoice_id, v_number, btrim(v_description), v_quantity, v_price, v_budget)
      returning id into v_id;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_hint = pg_exception_hint;
      if v_state = 'XR001' then
        -- Keep the refusal contract: message '<rule>: <sentence>' and hint '<rule>'.
        v_hint := coalesce(nullif(v_hint, ''), 'refused');
        raise exception using errcode = 'XR001', hint = v_hint,
          message = v_hint || ': Line ' || v_line || ': '
            || case when left(v_message, char_length(v_hint) + 2) = v_hint || ': '
                    then substr(v_message, char_length(v_hint) + 3) else v_message end;
      elsif v_state in ('23514', '23502', '23503', '22P02', '22003', '22007', '22008') then
        raise exception using errcode = v_state, message = 'Line ' || v_line || ': ' || v_message;
      end if;
      raise;
    end;
    v_written := v_written || jsonb_build_array(jsonb_build_object('suggestion_id', v_suggestion_id, 'id', v_id));
  end loop;

  for v_item in select value from jsonb_array_elements(v_written) loop
    perform app.transition_ai_suggestion((v_item ->> 'suggestion_id')::uuid, 'Proposed', 'Confirmed', 'Kept in the invoice lines review.');
    perform app.transition_ai_suggestion((v_item ->> 'suggestion_id')::uuid, 'Confirmed', 'Applied',
      'Written by app.apply_invoice_line_suggestions.', (v_item ->> 'id')::uuid);
  end loop;

  return jsonb_build_object('written', v_written);
end;
$$;

comment on function app.apply_invoice_line_suggestions(uuid, jsonb) is 'Adds kept invoice lines read by Aurora (B15, ADR 0154). Security invoker, so row level security on app.invoice_lines and private.guard_invoice_line (invoice_locked, invoice_line_budget) decide. p_items lists 1 to 40 {suggestion_id, values: {description, quantity, unit_price_minor, budget_line_id}}: each the caller''s own (42501, through app.transition_ai_suggestion, which rolls back the call) Proposed, unexpired invoiceLines.create suggestion named once (aurora_intake_item_invalid). A line belongs to an invoice when the invoices.create suggestion of the same request is Applied with applied_id that invoice, refused aurora_invoice_lines_foreign otherwise, and that suggestion''s currency_code must equal the invoice''s (aurora_invoice_currency). Lines are numbered from max(line_number) + 1, each suggestion goes Proposed, Confirmed, Applied with its line, and the rest stay open. Every refusal names its line and rolls back the call. Returns {written: [{suggestion_id, id}]}. Calls no model and meters nothing.';

revoke all on function app.vendor_line_history(uuid, text[]) from public, anon;
revoke all on function app.apply_invoice_line_suggestions(uuid, jsonb) from public, anon;
grant execute on function app.vendor_line_history(uuid, text[]) to authenticated, service_role;
grant execute on function app.apply_invoice_line_suggestions(uuid, jsonb) to authenticated, service_role;
