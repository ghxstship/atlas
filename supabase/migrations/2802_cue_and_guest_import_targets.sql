-- 2802_cue_and_guest_import_targets.sql
-- P3 Rundown and guest list import (RRR-217, gaps G-84 and G-72, Section 4.6.2): cues and guest list entries become
-- import wizard targets.
--   * cues import into a running order (destination run_of_show_id) under show.run_of_show.write; guest list entries
--     into a project (destination project_id) under advancing.rider.write, with fuzzy matching on the guest name.
--   * Fields use the target tables' column names, so the Playbook column map (canon/map/playbook-columns.yaml, sheet
--     Run of Show) suggests them. called_at, called_by, entry_state, decided_* and checked_in_* are not fields: an
--     import never calls a cue and never approves or checks in a guest.
--   * Separation of duties for imported guests (review correction C7): the worker writes with the service role, so an
--     imported guest has no created_by and sod_guest_requester never fired. private.is_import_requester names the
--     people who supplied an imported row: the person who created the import and the person who committed its batch.
--     private.guard_guest_list_entry (from 0431, its only definition) refuses both. Bulk decisions
--     (2151 private.bulk_guest_list_entries_row) go through the same guard.
-- No table becomes Trash-eligible here, so private.sync_trash_tables() is not called (ADR 0110).

insert into private.import_targets (code, target_table, write_capability, fuzzy_match, sort_order, destination) values
  ('cues', 'app.cues', 'show.run_of_show.write', false, 5, 'run_of_show_id'),
  ('guest_list_entries', 'app.guest_list_entries', 'advancing.rider.write', true, 6, 'project_id');

insert into private.import_target_fields (target_code, field_name, required, strong_key) values
  ('cues', 'position', false, true),
  ('cues', 'label', true, false),
  ('cues', 'segment', false, false),
  ('cues', 'description', false, false),
  ('cues', 'planned_at', false, false),
  ('cues', 'duration', false, false),
  ('cues', 'space_id', false, false),
  ('guest_list_entries', 'guest_name', true, true),
  ('guest_list_entries', 'plus_ones', false, false),
  ('guest_list_entries', 'note', false, false),
  ('guest_list_entries', 'scope_node_id', false, false),
  ('guest_list_entries', 'counterparty_id', false, false);

-- Who supplied an imported row --------------------------------------------------------------------------------------

create or replace function private.is_import_requester(p_table text, p_id uuid, p_person uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_person is not null and exists (
    select 1 from app.import_row_results r
    join app.import_batches b on b.id = r.import_batch_id
    join app.import_jobs j on j.id = r.import_job_id
    where r.target_table = p_table and r.target_id = p_id
      and r.row_state = 'Written' and r.write_action = 'Created'
      and (j.created_by = p_person or b.created_by = p_person));
$$;

comment on function private.is_import_requester(text, uuid, uuid) is 'True when the person supplied an imported row: they created the import that created it, or committed the batch that wrote it. Separation of duties treats both as its requester.';
revoke all on function private.is_import_requester(text, uuid, uuid) from public, anon, authenticated;

-- The guest list guard (from 0431; only the requester check changes) -----------------------------------------------

create or replace function private.guard_guest_list_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.current_person_id();
  v_trusted boolean := private.in_trusted_operation('request_engaged_guest');
begin
  if tg_op = 'INSERT' then
    if new.decided_at is not null or new.decided_by is not null or new.checked_in_at is not null or new.checked_in_by is not null then
      perform private.refuse('guest_entry_stamped', 'Decision and check-in times are set by the database.');
    end if;
    if new.entry_state = 'Checked In' or new.entry_state = 'Declined' then
      perform private.refuse('guest_entry_state', 'A guest is added as Requested, or as Approved by a reviewer.');
    end if;
    if new.entry_state = 'Approved' then
      if v_trusted or not private.can_on_project(new.project_id, 'advancing.submission.review') then
        perform private.refuse('guest_entry_authority', 'Approving guests needs advancing.submission.review on the project.');
      end if;
      new.decided_at := now();
      new.decided_by := v_person;
    end if;
    return new;
  end if;

  if old.entry_state <> 'Requested' and (new.guest_name is distinct from old.guest_name or new.plus_ones is distinct from old.plus_ones
     or new.person_id is distinct from old.person_id or new.counterparty_id is distinct from old.counterparty_id
     or new.scope_node_id is distinct from old.scope_node_id) then
    perform private.refuse('guest_entry_decided', 'A decided guest keeps its name, plus-ones, party and show; decline it and request again.');
  end if;
  if new.decided_at is distinct from old.decided_at or new.decided_by is distinct from old.decided_by
     or new.checked_in_at is distinct from old.checked_in_at or new.checked_in_by is distinct from old.checked_in_by then
    if new.entry_state is not distinct from old.entry_state then
      perform private.refuse('guest_entry_stamped', 'Decision and check-in times are set by the database.');
    end if;
  end if;
  if new.entry_state is distinct from old.entry_state then
    if old.entry_state = 'Requested' and new.entry_state in ('Approved', 'Declined') then
      if not private.can_on_project(new.project_id, 'advancing.submission.review') then
        perform private.refuse('guest_entry_authority', 'Approving or declining guests needs advancing.submission.review on the project.');
      end if;
      if v_person is not null and (v_person = old.created_by
         or (old.created_by is null and private.is_import_requester('app.guest_list_entries', old.id, v_person))) then
        perform private.refuse('sod_guest_requester', 'The person who requested a guest cannot approve or decline the request.');
      end if;
      new.decided_at := now();
      new.decided_by := v_person;
      new.checked_in_at := null;
      new.checked_in_by := null;
    elsif old.entry_state = 'Approved' and new.entry_state = 'Checked In' then
      new.decided_at := old.decided_at;
      new.decided_by := old.decided_by;
      new.checked_in_at := now();
      new.checked_in_by := v_person;
    else
      perform private.refuse('guest_entry_transition', format('A guest moves from %s only as the guest list allows.', old.entry_state));
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_guest_list_entry() is 'Guest list state machine: Requested to Approved or Declined (review authority, never the requester: for an imported guest, neither the person who created the import nor the one who committed it), Approved to Checked In; the database stamps who and when; a decided entry keeps its guest.';
revoke all on function private.guard_guest_list_entry() from public, anon, authenticated;
