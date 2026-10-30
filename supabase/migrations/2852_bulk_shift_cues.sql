-- 2852_bulk_shift_cues.sql
-- P8 (RRR-222; parity gap G-35; ADR 0022 block 2850 to 2859). Bulk edit (Section 11.7, S11.7-04 and S11.7-05; ADR 0044)
-- carries record windows and cue times:
--
--   * private.bulk_records_row, restated from 1451 (its only definition), also edits starts_at and ends_at. An undo of
--     a shift or a placement (2850, 2851) sends its inverse rows ({set: the old dates, expect: the new}) through
--     app.bulk_update_records, so compare-and-set (bulk_stale) refuses an undo after someone else's change. A change of
--     any date from Scheduled onward is logged as a replan with the reason, by 1451's rule, and a window that is locked
--     into a baseline keeps its start and end, as app.reschedule_record keeps it (2260).
--   * Cues become a bulk resource: private.bulk_cues_row shifts a cue's planned time by whole minutes or sets it,
--     app.bulk_update_cues runs it through 1451's driver, and app.cues gains a field-level audit trail. A called cue
--     keeps its time (cue_called).

-- 1. Records: start and end in bulk ---------------------------------------------------------------------------------------

create or replace function private.bulk_records_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.records;
  v_new app.records;
  v_state text;
  v_owner uuid;
  v_accountable uuid;
  v_starts timestamptz;
  v_ends timestamptz;
  v_due timestamptz;
  v_phase text;
  v_keys jsonb;
  v_before jsonb;
  v_after jsonb;
  v_dates_changed boolean;
begin
  perform private.bulk_check_fields(p_set, p_expect,
    'record_state,owner_party_id,accountable_party_id,starts_at,ends_at,due_at,phase_code,blocker_text,replan_reason');
  select * into v_old from app.records r where r.id = p_id and r.deleted_at is null for update;
  if v_old.id is null
     or not (v_old.project_id in (select private.project_ids_with('work.record.read'))
             or v_old.id in (select private.my_record_ids('work.record.read'))
             or v_old.org_id in (select private.oversight_org_ids('work.record.read'))) then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  if not (v_old.project_id in (select private.project_ids_with('work.record.write'))
          or v_old.id in (select private.my_record_ids('work.record.write'))) then
    raise exception using errcode = '42501', message = 'work.record.write is required on this record''s project.';
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);

  v_state := case when p_set ? 'record_state' then p_set ->> 'record_state' else v_old.record_state end;
  v_owner := case when p_set ? 'owner_party_id' then (p_set ->> 'owner_party_id')::uuid else v_old.owner_party_id end;
  v_accountable := case when p_set ? 'accountable_party_id' then (p_set ->> 'accountable_party_id')::uuid else v_old.accountable_party_id end;
  v_starts := case when p_set ? 'starts_at' then (p_set ->> 'starts_at')::timestamptz else v_old.starts_at end;
  v_ends := case when p_set ? 'ends_at' then (p_set ->> 'ends_at')::timestamptz else v_old.ends_at end;
  v_due := case when p_set ? 'due_at' then (p_set ->> 'due_at')::timestamptz else v_old.due_at end;
  v_phase := case when p_set ? 'phase_code' then p_set ->> 'phase_code' else v_old.phase_code end;
  v_dates_changed := v_starts is distinct from v_old.starts_at or v_ends is distinct from v_old.ends_at
    or v_due is distinct from v_old.due_at;

  if v_state is not distinct from v_old.record_state and v_owner is not distinct from v_old.owner_party_id
     and v_accountable is not distinct from v_old.accountable_party_id and not v_dates_changed
     and v_phase is not distinct from v_old.phase_code then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;

  -- A Timeline window locked into a baseline keeps its start and end (2260's rule).
  if (v_starts is distinct from v_old.starts_at or v_ends is distinct from v_old.ends_at)
     and exists (select 1 from app.record_timeline t where t.record_id = p_id and t.baseline_locked_at is not null) then
    perform private.refuse('reschedule_locked',
      app.record_display_key(v_old) || ' ' || v_old.title || ' is locked: it is complete or its window is locked into a baseline.');
  end if;

  if v_owner is distinct from v_old.owner_party_id or v_accountable is distinct from v_old.accountable_party_id
     or v_dates_changed or v_phase is distinct from v_old.phase_code then
    update app.records
    set owner_party_id = v_owner,
        accountable_party_id = v_accountable,
        starts_at = v_starts,
        ends_at = v_ends,
        due_at = v_due,
        phase_code = v_phase,
        replan_reason = case when v_dates_changed and v_old.record_state not in ('Proposed', 'Ready')
                             then coalesce(nullif(btrim(p_set ->> 'replan_reason'), ''), nullif(btrim(p_reason), ''), 'Changed in bulk.')
                             else replan_reason end
    where id = p_id;
  end if;
  if v_state is distinct from v_old.record_state then
    perform app.transition_record(p_id, v_old.record_state, v_state,
      coalesce(nullif(btrim(p_reason), ''), 'Changed in bulk.'), p_set ->> 'blocker_text', p_set ->> 'replan_reason');
  end if;

  select * into v_new from app.records r where r.id = p_id;
  v_keys := p_set - 'blocker_text' - 'replan_reason';
  v_before := private.bulk_pick(to_jsonb(v_old), v_keys);
  v_after := private.bulk_pick(to_jsonb(v_new), v_keys);
  -- Undoing a move out of Blocked or Deferred must name the blocker or the reason again.
  if v_keys ? 'record_state' and v_old.record_state = 'Blocked' then
    v_before := v_before || jsonb_build_object('blocker_text', v_old.blocker_text);
  elsif v_keys ? 'record_state' and v_old.record_state = 'Deferred' then
    v_before := v_before || jsonb_build_object('replan_reason', v_old.replan_reason);
  end if;
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true, 'before', v_before, 'after', v_after);
end;
$$;

comment on function private.bulk_records_row(uuid, jsonb, jsonb, text) is 'One record of a bulk change: state through app.transition_record, owner, accountable party, start, end and due times and phase. Needs work.record.write on the record as its policy does; a date change from Scheduled onward is logged as a replan with the reason, and a Timeline window locked into a baseline keeps its start and end (reschedule_locked). The undo of a shift or a placement (2850, 2851) comes through here.';
revoke all on function private.bulk_records_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

comment on function app.bulk_update_records(jsonb, boolean, text) is 'Changes records in bulk in one transaction (Section 11.7): rows as [{id, set, expect}] with state, owner, accountable party, start, end or due time, or phase. All or nothing; answers changed and unchanged counts, each refused row with its rule, and the inverse rows for undo. p_preview checks without changing anything.';

-- 2. Cues ------------------------------------------------------------------------------------------------------------

create or replace function private.bulk_cues_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.cues;
  v_new app.cues;
  v_minutes integer;
  v_planned timestamptz;
begin
  perform private.bulk_check_fields(p_set, p_expect, 'shift_minutes,planned_at');
  if p_set ? 'shift_minutes' and p_set ? 'planned_at' then
    perform private.refuse('bulk_shape', 'A cue row either shifts the planned time or sets it, not both.');
  end if;
  select * into v_old from app.cues c where c.id = p_id and c.deleted_at is null for update;
  if v_old.id is null or not private.can_on_project(v_old.project_id, 'show.run_of_show.read') then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  if not private.can_on_project(v_old.project_id, 'show.run_of_show.write') then
    raise exception using errcode = '42501', message = 'show.run_of_show.write is required on this cue''s project.';
  end if;
  if v_old.called_at is not null then
    perform private.refuse('cue_called', 'This cue has been called; its time stays as it was.');
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);

  if p_set ? 'shift_minutes' then
    if jsonb_typeof(p_set -> 'shift_minutes') is distinct from 'number'
       or (p_set ->> 'shift_minutes')::numeric <> trunc((p_set ->> 'shift_minutes')::numeric)
       or abs((p_set ->> 'shift_minutes')::numeric) > 1440 then
      raise exception using errcode = '22023', message = 'shift_minutes is a whole number of minutes, at most a day either way';
    end if;
    v_minutes := (p_set ->> 'shift_minutes')::integer;
    -- A cue with no planned time has nothing to shift.
    v_planned := v_old.planned_at + pg_catalog.make_interval(mins => v_minutes);
  elsif p_set ? 'planned_at' then
    v_planned := (p_set ->> 'planned_at')::timestamptz;
  else
    v_planned := v_old.planned_at;
  end if;

  if v_planned is not distinct from v_old.planned_at then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;
  update app.cues set planned_at = v_planned where id = p_id;
  select * into v_new from app.cues c where c.id = p_id;
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true,
    'before', jsonb_build_object('planned_at', to_jsonb(v_old) -> 'planned_at'),
    'after', jsonb_build_object('planned_at', to_jsonb(v_new) -> 'planned_at'));
end;
$$;

comment on function private.bulk_cues_row(uuid, jsonb, jsonb, text) is 'One cue of a bulk change: shift_minutes moves its planned time by whole minutes (at most a day either way; a cue with no planned time is unchanged), planned_at sets it. Needs show.run_of_show.write on the cue''s project; a called cue keeps its time (cue_called). Before and after are {planned_at}, so the undo sets the old time back.';
revoke all on function private.bulk_cues_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

insert into private.bulk_resources (resource, table_name, row_function) values
  ('cues', 'app.cues', 'private.bulk_cues_row');

create or replace function app.bulk_update_cues(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('cues', p_rows, coalesce(p_preview, false), p_reason);
$$;

comment on function app.bulk_update_cues(jsonb, boolean, text) is 'Shifts or sets the planned times of cues in a running order in bulk in one transaction (Section 11.7): rows as [{id, set: {shift_minutes} or {planned_at}, expect}]. A called cue is refused (cue_called) and nothing changes. Answers as app.bulk_update_records does, with the inverse rows that set the old times back.';
revoke all on function app.bulk_update_cues(jsonb, boolean, text) from public, anon;
grant execute on function app.bulk_update_cues(jsonb, boolean, text) to authenticated, service_role;

-- Field history for cues, as app.records gained in 1451.
call private.install_audit_trail('app.cues');
