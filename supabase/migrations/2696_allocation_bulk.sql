-- 2696_allocation_bulk.sql
-- R7 Allocations, Atlas side (RRR-187, Section 11.7). Requested allocations are approved or declined in bulk the way
-- A121 bulk-approves BEOs (2150): each row goes through app.decide_allocation, so the capability, the compare-and-set,
-- the requester separation, the decline reason, the caps and the holds apply to every row. A decision is stamped
-- once, so its inverse is refused (bulk_decision_final). Approving assets in bulk holds their default sources.

create or replace function private.bulk_advance_allocations_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.advance_allocations;
  v_state app.allocation_state;
begin
  perform private.bulk_check_fields(p_set, p_expect, 'allocation_state');
  select a.* into v_old from app.advance_allocations a where a.id = p_id and a.deleted_at is null;
  if v_old.id is null or v_old.project_id not in (select private.project_ids_with('advancing.packet.read')) then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);
  v_state := case when p_set ? 'allocation_state' then (p_set ->> 'allocation_state')::app.allocation_state else v_old.allocation_state end;
  if v_state = v_old.allocation_state then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;
  if v_old.allocation_state <> 'Requested' or v_state not in ('Approved', 'Declined') then
    perform private.refuse('bulk_decision_final', 'An allocation is decided once; withdraw it instead of undoing the decision.');
  end if;
  perform app.decide_allocation(p_id, case when v_state = 'Approved' then 'Approved' else 'Rejected' end::app.approval_decision, p_reason, null);
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true,
    'before', jsonb_build_object('allocation_state', v_old.allocation_state),
    'after', jsonb_build_object('allocation_state', v_state));
end;
$$;
comment on function private.bulk_advance_allocations_row(uuid, jsonb, jsonb, text) is 'One allocation of a bulk decision: Approved or Declined (with the call''s one reason). Goes through app.decide_allocation, so the review capability, the Requested state, the requester separation, the reason, the caps and the default holds apply to each row; anything but a first decision is refused (bulk_decision_final).';
revoke all on function private.bulk_advance_allocations_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

insert into private.bulk_resources (resource, table_name, row_function) values
  ('advance_allocations', 'app.advance_allocations', 'private.bulk_advance_allocations_row');

create or replace function app.bulk_update_advance_allocations(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('advance_allocations', p_rows, coalesce(p_preview, false), p_reason);
$$;
comment on function app.bulk_update_advance_allocations(jsonb, boolean, text) is 'Approves or declines allocations in bulk in one transaction (Section 11.7), every rule of a single decision applying to each row, with the answer of app.bulk_update_records. A decline carries the call''s one reason.';
revoke all on function app.bulk_update_advance_allocations(jsonb, boolean, text) from public, anon;
grant execute on function app.bulk_update_advance_allocations(jsonb, boolean, text) to authenticated, service_role;
