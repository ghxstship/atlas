-- 0431_advancing_guest_list.sql
-- A10 Advancing (ADR 0022 range 0430 to 0439):
--   * app.guest_list_entries: the guest list of a project (Section 4.5.8 Artist tab Guest List, Section 4.5.7
--     Compass guest list), one row per guest with plus-ones, the party whose list it is, and a small state
--     machine: Requested, then Approved or Declined by someone with review authority who did not request
--     it (sod_guest_requester), then Checked In at the door. Engaged parties request guests through
--     app.request_engaged_guest in the late slot (0965), which adds the engagement link.
-- Retention: 0501 sweeps every table that exists before it, this one included.

insert into private.separation_of_duties_rules (code, enforced_on, description) values
  ('sod_guest_requester', 'Guest lists', 'The person who requested a guest cannot approve or decline the request.')
on conflict (code) do nothing;

insert into private.domain_event_types (code, subject, description) values
  ('guest_list_entry.requested', 'guest_list_entries', 'A guest was requested for a project''s guest list.'),
  ('guest_list_entry.decided', 'guest_list_entries', 'A guest request was approved or declined.'),
  ('guest_list_entry.checked_in', 'guest_list_entries', 'An approved guest was checked in at the door.')
on conflict (code) do nothing;

create type app.guest_entry_state as enum ('Requested', 'Approved', 'Declined', 'Checked In');
comment on type app.guest_entry_state is 'Where a guest list entry stands: Requested, then Approved or Declined, then Checked In for an approved guest.';

create table app.guest_list_entries (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  scope_node_id uuid references app.scope_nodes (id),
  person_id uuid references app.people (id),
  counterparty_id uuid references app.counterparties (id),
  guest_name text not null,
  plus_ones smallint not null default 0,
  note text,
  entry_state app.guest_entry_state not null default 'Requested',
  decided_at timestamptz,
  decided_by uuid references app.people (id),
  checked_in_at timestamptz,
  checked_in_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint guest_list_entries_name_length check (char_length(btrim(guest_name)) between 1 and 200),
  constraint guest_list_entries_plus_ones check (plus_ones between 0 and 20),
  constraint guest_list_entries_note_length check (note is null or char_length(note) <= 500),
  constraint guest_list_entries_one_party check (num_nonnulls(person_id, counterparty_id) <= 1),
  constraint guest_list_entries_decision_pair check ((decided_at is null) = (decided_by is null)),
  constraint guest_list_entries_check_in_pair check ((checked_in_at is null) = (checked_in_by is null)),
  constraint guest_list_entries_state_facts check (
    (entry_state = 'Requested' and decided_at is null and checked_in_at is null)
    or (entry_state in ('Approved', 'Declined') and decided_at is not null and checked_in_at is null)
    or (entry_state = 'Checked In' and decided_at is not null and checked_in_at is not null))
);
create index guest_list_entries_project_idx on app.guest_list_entries (project_id, entry_state);
create index guest_list_entries_scope_node_id_idx on app.guest_list_entries (scope_node_id);
create index guest_list_entries_person_id_idx on app.guest_list_entries (person_id);
create index guest_list_entries_counterparty_id_idx on app.guest_list_entries (counterparty_id);
create index guest_list_entries_decided_by_idx on app.guest_list_entries (decided_by);
create index guest_list_entries_checked_in_by_idx on app.guest_list_entries (checked_in_by);
call private.install_project_table('app.guest_list_entries', 'advancing.packet.read', 'advancing.rider.write',
  array['app.scope_nodes', 'scope_node_id', 'app.counterparties', 'counterparty_id']);
call private.describe('app.guest_list_entries', 'Guest list of a project: each guest with plus-ones and the party whose list it is. Requested guests are approved or declined by someone with advancing.submission.review who did not request them, then checked in at the door.', array[
  'project_id', 'Project.', 'scope_node_id', 'Show or other scope node of the same project the guest attends; NULL for the whole project.',
  'person_id', 'Person whose list the guest is on, such as the artist.', 'counterparty_id', 'Organization whose list the guest is on.',
  'guest_name', 'Name the guest gives at the door.', 'plus_ones', 'Additional guests admitted with this guest, 0 to 20.',
  'note', 'Notes for the door, such as access level asked.', 'entry_state', 'Requested, Approved, Declined or Checked In.',
  'decided_at', 'When the request was approved or declined. Set by the database.', 'decided_by', 'Who decided. Set by the database.',
  'checked_in_at', 'When the guest was checked in. Set by the database.', 'checked_in_by', 'Who checked the guest in. Set by the database.'
]);
create trigger t39_guest_list_scope_project before insert or update on app.guest_list_entries
  for each row execute function private.assert_same_project('app.scope_nodes', 'scope_node_id');

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
      if v_person is not null and v_person = old.created_by then
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
comment on function private.guard_guest_list_entry() is 'Guest list state machine: Requested to Approved or Declined (review authority, never the requester), Approved to Checked In; the database stamps who and when; a decided entry keeps its guest.';
revoke all on function private.guard_guest_list_entry() from public, anon, authenticated;
create trigger t40_guard_guest_list_entry before insert or update on app.guest_list_entries
  for each row execute function private.guard_guest_list_entry();

create trigger t90_emit_guest_requested after insert on app.guest_list_entries
  for each row execute function private.emit_row_event('guest_list_entry.requested', 'project_id', 'entry_state', 'plus_ones', 'scope_node_id');
create trigger t90_emit_guest_decided after update of entry_state on app.guest_list_entries
  for each row when (old.entry_state = 'Requested' and new.entry_state in ('Approved', 'Declined'))
  execute function private.emit_row_event('guest_list_entry.decided', 'project_id', 'entry_state', 'decided_at');
create trigger t90_emit_guest_checked_in after update of entry_state on app.guest_list_entries
  for each row when (new.entry_state = 'Checked In' and old.entry_state = 'Approved')
  execute function private.emit_row_event('guest_list_entry.checked_in', 'project_id', 'checked_in_at');
