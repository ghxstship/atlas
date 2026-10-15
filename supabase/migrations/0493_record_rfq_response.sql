-- A16: record a sealed RFQ response with its lines in one call.
--
-- Responses stay unreadable until the RFQ is Closed (0331), so a buyer recording a quote that
-- arrived by email cannot read back the response row, and the line policy (which looks the
-- response up under RLS) refuses its lines. This function records both atomically for anyone
-- with procurement.rfq.write on the project; the 0331 guard still accepts responses only from
-- invited vendors while the RFQ is Issued.

create or replace function app.record_rfq_response(
  p_rfq_id uuid,
  p_vendor_id uuid,
  p_valid_until date,
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
  v_project uuid;
  v_response uuid;
  v_line jsonb;
begin
  perform private.require_person();
  select r.project_id into v_project from app.rfqs r where r.id = p_rfq_id and r.deleted_at is null;
  if v_project is null or not private.can_on_project(v_project, 'procurement.rfq.write') then
    raise exception using errcode = '42501', message = 'procurement.rfq.write is required on the project';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    perform private.refuse('rfq_response_lines_required', 'A response quotes at least one line.');
  end if;

  insert into app.rfq_responses (rfq_id, vendor_id, valid_until)
  values (p_rfq_id, p_vendor_id, p_valid_until)
  returning id into v_response;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    insert into app.rfq_response_lines (rfq_response_id, description, element_id, quantity, unit_price_minor, currency_code)
    values (
      v_response,
      v_line ->> 'description',
      nullif(v_line ->> 'element_id', ''),
      coalesce((v_line ->> 'quantity')::numeric, 1),
      (v_line ->> 'unit_price_minor')::bigint,
      upper(p_currency_code)
    );
  end loop;
  return v_response;
end;
$$;

comment on function app.record_rfq_response(uuid, uuid, date, text, jsonb) is 'Records a sealed RFQ response and its quoted lines for a vendor (procurement.rfq.write on the project); the response stays unreadable until the RFQ is Closed.';

revoke all on function app.record_rfq_response(uuid, uuid, date, text, jsonb) from public, anon;
grant execute on function app.record_rfq_response(uuid, uuid, date, text, jsonb) to authenticated, service_role;
