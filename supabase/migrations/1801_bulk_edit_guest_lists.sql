-- 1801_bulk_edit_guest_lists.sql
-- A121 (RRR-167, A65-006, ADR 0080). Bulk edit (Section 11.7) reaches Advancing: guest list entries change state in
-- bulk on the driver of 1451, so a reviewer approves or declines a show's requests, or the door checks a group in, in
-- one all-or-nothing call ("approve 20 in 60 s", Section 11.11).
--
--   * Each row needs advancing.rider.write on the guest's project, as the guest list's update policy does. The guest
--     list guard (0431) still decides every move: approving or declining needs advancing.submission.review and is
--     never by the person who requested the guest (sod_guest_requester), only an Approved guest is checked in, and the
--     database stamps who and when. Decisions and check-ins move one way, so undoing one is refused by that guard.
--   * Packets, riders and reconciliation runs have no property that changes in bulk: a packet's state follows its
--     sending, a rider's its lines and a run's its results.
--   * The guest list gains the audit trail app.records has (1451), so each decision reaches the ledger field by field.

create or replace function private.bulk_guest_list_entries_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.guest_list_entries;
  v_new app.guest_list_entries;
  v_state app.guest_entry_state;
begin
  perform private.bulk_check_fields(p_set, p_expect, 'entry_state');
  select * into v_old from app.guest_list_entries g where g.id = p_id and g.deleted_at is null for update;
  if v_old.id is null or v_old.project_id not in (select private.project_ids_with('advancing.packet.read')) then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  if v_old.project_id not in (select private.project_ids_with('advancing.rider.write')) then
    raise exception using errcode = '42501', message = 'advancing.rider.write is required on this guest''s project.';
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);
  v_state := case when p_set ? 'entry_state' then (p_set ->> 'entry_state')::app.guest_entry_state else v_old.entry_state end;
  if v_state = v_old.entry_state then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;
  -- guard_guest_list_entry checks review authority, separation from the requester and the allowed move, and stamps.
  update app.guest_list_entries set entry_state = v_state where id = p_id;
  select * into v_new from app.guest_list_entries g where g.id = p_id;
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true,
    'before', jsonb_build_object('entry_state', v_old.entry_state),
    'after', jsonb_build_object('entry_state', v_new.entry_state));
end;
$$;

comment on function private.bulk_guest_list_entries_row(uuid, jsonb, jsonb, text) is 'One guest list entry of a bulk change: approve, decline or check in. Needs advancing.rider.write on the project as its update policy does; the guest list guard still asks for advancing.submission.review on decisions, refuses the requester and allows only its one-way moves.';
revoke all on function private.bulk_guest_list_entries_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

insert into private.bulk_resources (resource, table_name, row_function) values
  ('guest_list_entries', 'app.guest_list_entries', 'private.bulk_guest_list_entries_row');

create or replace function app.bulk_update_guest_list_entries(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('guest_list_entries', p_rows, coalesce(p_preview, false), p_reason);
$$;

comment on function app.bulk_update_guest_list_entries(jsonb, boolean, text) is 'Approves, declines or checks in guests in bulk in one transaction (Section 11.7, approve 20 in 60 s), every rule of a single decision applying to each row, with the answer of app.bulk_update_records.';

revoke all on function app.bulk_update_guest_list_entries(jsonb, boolean, text) from public, anon;
grant execute on function app.bulk_update_guest_list_entries(jsonb, boolean, text) to authenticated, service_role;

call private.install_audit_trail('app.guest_list_entries');
