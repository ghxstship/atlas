-- 2253_assign_open_shift.sql
--
-- Putting a member on an open shift from the schedule's drag board (ADR 0022, 2250-2259), A132, RRR-194, ADR 0063.
-- The board used to write app.shifts.membership_id directly, guarded only by "nobody holds it yet". Under the
-- approval and seniority claiming rules (scheduling.open_shift_claiming, 1322) a claim waits in app.shift_claims
-- while the shift stays open, so that write gave the shift to someone else past the waiting claims: they stayed
-- Requested with nobody to decide them, a later approval failed with shift_already_claimed, and under seniority the
-- most senior claimant was passed over. The assignment is now one RPC that keeps the 1322 rules in effect:
--   * app.assign_open_shift(shift, membership) needs crew.shift.write on the shift's project, locks the shift row as
--     app.claim_open_shift and app.decide_shift_claim do, and refuses a shift someone holds (shift_already_filled)
--     or one with claims waiting (shift_claims_waiting): the planner decides those claims on the shift instead.
--     The person must be an active member of the shift's org. Overlap stays a warning on the board, not a refusal
--     (ADR 0063 item 5).

create or replace function app.assign_open_shift(p_shift_id uuid, p_membership_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shift app.shifts;
begin
  perform private.require_person();
  select * into v_shift from app.shifts s where s.id = p_shift_id and s.deleted_at is null for update;
  if v_shift.id is null or not private.can_on_project(v_shift.project_id, 'crew.shift.write') then
    raise exception using errcode = '42501', message = 'crew.shift.write is required on the project';
  end if;
  if v_shift.membership_id is not null then
    perform private.refuse('shift_already_filled', 'Someone was put on this shift since the schedule was read.');
  end if;
  if exists (select 1 from app.shift_claims c where c.shift_id = p_shift_id and c.claim_state = 'Requested' and c.deleted_at is null) then
    perform private.refuse('shift_claims_waiting', 'Members claimed this shift; approve or reject their claims on the shift.');
  end if;
  if not exists (
    select 1 from app.memberships m
    where m.id = p_membership_id and m.org_id = v_shift.org_id and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
    raise exception using errcode = '42501', message = 'only an active member of the org is put on its shift';
  end if;
  update app.shifts set membership_id = p_membership_id where id = p_shift_id;
  return p_shift_id;
end;
$$;

comment on function app.assign_open_shift(uuid, uuid) is 'Puts an active member of the org on an open shift from the schedule''s drag board (A132, ADR 0063), with crew.shift.write on the project. Refused while someone holds the shift (shift_already_filled) or members wait on a claim for it (shift_claims_waiting, the 1322 approval and seniority rules), so a waiting claim is always decided on the shift. Returns the shift id.';

revoke all on function app.assign_open_shift(uuid, uuid) from public, anon;
grant execute on function app.assign_open_shift(uuid, uuid) to authenticated, service_role;
