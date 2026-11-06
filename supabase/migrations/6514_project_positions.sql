-- 6514_project_positions.sql
-- B9 (RRR-233; ADR 0148 decision 3; parity gap G-118): a project position is a seat on a project filled later by
-- exactly one member or one person of an agency's roster. Shifts and records are planned against the position before
-- anyone holds it; filling it resolves them to the holder.
--
--   * app.project_positions: title (unique live per project), role, and for an agency position the agency's Staff
--     engagement (an agency-slot engagement, R12). The holder columns change only inside the trusted operation
--     position_fill (app.fill_position, app.vacate_position; position_holder_rpc). A position goes to Trash only while
--     unfilled and no live, not-ended shift and no live record assignment names it (position_in_use).
--   * app.shifts.project_position_id: a shift held for a position. t37_guard_shift_position keeps it on the same
--     project and keeps anyone else off it (shift_held_for_position): an agency position's shifts are its agency's
--     slots or roster shifts of that engagement, so the agency may place any accepted person of that roster on the slot
--     (R12's per-shift placement in Gateway); a member position's shifts are open or the holder's. This covers
--     direct writes by shift writers and app.save_roster_shift (2755, which runs as the caller). Open shifts held for a
--     position are not open to claims (private.assert_claimable), to the open-shift read policy, to shifts_open_idx or
--     to the drag board (app.assign_open_shift, app.assign_open_shift_to_roster). A swap is refused when it is asked
--     for (private.guard_shift_swap, from 6512), since applying it could only be refused later.
--   * app.record_position_assignments: records assigned to a position. For a member holder each resolves to an
--     app.record_assignments row (resolved_assignment_id, set only when the fill inserted it); for a roster holder
--     the record stays on the position (records assign only to memberships, 0310), and the holder and their agency's
--     leads read it through api_external.position_records. Assigning a record to a position (work.record.write) is the
--     authorization that filling resolves, so a crew.shift.write filler needs no work.record.write.
--   * app.fill_position and app.vacate_position. The roster path places the person through app.assign_roster_shift per
--     shift, catching its refusals into shifts_skipped; the member path skips a shift with waiting claims or one the
--     holder overlaps.
--   * api_external.shifts (from 2750) appends project_position_id and position_title for Gateway's Positions tab, and
--     has_no_show so Gateway can show the state and hide the action without reading an app table.
--   * private.reopen_declined_shift (from 6511) clears a reopened member or engaged shift's position too.
-- Positions are distinct from app.opportunity_positions (0720) and from Gateway's engagement.positions tab (agency
-- slots). Engaged individual freelancers do not hold positions (ADR 0148).

-- Positions ---------------------------------------------------------------------------------------------------------------------

create table app.project_positions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  title text not null,
  role_code text references xpms.role (role_code),
  engagement_id uuid references app.engagements (id),
  membership_id uuid references app.memberships (id),
  roster_entry_id uuid references app.engagement_roster_entries (id),
  filled_at timestamptz,
  constraint project_positions_title_length check (char_length(btrim(title)) between 1 and 120),
  constraint project_positions_one_holder check (num_nonnulls(membership_id, roster_entry_id) <= 1),
  constraint project_positions_filled check ((filled_at is null) = (membership_id is null and roster_entry_id is null)),
  constraint project_positions_agency_holder check (engagement_id is null or membership_id is null),
  constraint project_positions_member_holder check (engagement_id is not null or roster_entry_id is null)
);

create index project_positions_project_id_idx on app.project_positions (project_id);
create index project_positions_role_code_idx on app.project_positions (role_code);
create index project_positions_engagement_id_idx on app.project_positions (engagement_id);
create index project_positions_membership_id_idx on app.project_positions (membership_id);
create index project_positions_roster_entry_id_idx on app.project_positions (roster_entry_id);

-- The cross-org guards come from install_domain_table's references (memberships, engagements and roster entries of the org).
call private.install_domain_table('app.project_positions', 'app.projects', 'project_id',
  array['app.engagements', 'engagement_id', 'app.memberships', 'membership_id', 'app.engagement_roster_entries', 'roster_entry_id']);
create unique index project_positions_title_key on app.project_positions (project_id, lower(btrim(title))) where deleted_at is null;

call private.describe('app.project_positions', 'Seats on a project filled later by exactly one member or one person of an agency''s roster (ADR 0148), for example Stage Manager or Rigger 2. Shifts (app.shifts.project_position_id) and records (app.record_position_assignments) are planned against a position before anyone holds it; app.fill_position resolves them to the holder and app.vacate_position returns them. Read by shift readers of the project, the holder and the agency''s leads; written by crew.shift.write holders.', array[
  'project_id', 'Project the position is on.',
  'title', 'Name of the seat, unique among the project''s live positions.',
  'role_code', 'Canon role of the seat (Roles Library); null when the title says it.',
  'engagement_id', 'For an agency position, the staffing agency''s Staff engagement (an agency-slot engagement, R12) whose roster fills it; null for a member position.',
  'membership_id', 'Member who holds the position. Written only by app.fill_position and app.vacate_position.',
  'roster_entry_id', 'Roster entry of the agency staff member who holds the position. Written only by app.fill_position and app.vacate_position.',
  'filled_at', 'When the current holder filled it; null while unfilled.'
]);

create or replace function private.guard_project_position()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.engagement_id is not null then
    if not private.is_agency_slot_engagement(new.engagement_id) then
      perform private.refuse('position_engagement_not_agency', 'An agency position names a staffing agency''s Staff engagement.');
    end if;
    if (select e.project_id from app.engagements e where e.id = new.engagement_id) is distinct from new.project_id then
      perform private.refuse('same_project', 'project_positions.engagement_id points to an engagement of another project.');
    end if;
  end if;
  -- An unfilled agency position must not turn into a member position, or move, and strand the shifts and records it holds.
  if tg_op = 'UPDATE' and (new.engagement_id is distinct from old.engagement_id or new.project_id <> old.project_id)
     and (exists (select 1 from app.shifts s where s.project_position_id = new.id and s.deleted_at is null and s.shift_state <> 'Canceled')
          or exists (select 1 from app.record_position_assignments a where a.project_position_id = new.id and a.deleted_at is null)) then
    perform private.refuse('position_in_use', 'Move this position''s shifts and records off it before changing its agency or project.');
  end if;
  if new.roster_entry_id is not null
     and (select r.engagement_id from app.engagement_roster_entries r where r.id = new.roster_entry_id) is distinct from new.engagement_id then
    perform private.refuse('position_holder_kind', 'An agency position is held by a person of its own agency''s roster.');
  end if;
  if (tg_op = 'INSERT' and num_nonnulls(new.membership_id, new.roster_entry_id) > 0
      or tg_op = 'UPDATE' and (new.membership_id, new.roster_entry_id, new.filled_at) is distinct from (old.membership_id, old.roster_entry_id, old.filled_at)
      or tg_op = 'UPDATE' and new.engagement_id is distinct from old.engagement_id and num_nonnulls(old.membership_id, old.roster_entry_id) > 0)
     and not private.in_trusted_operation('position_fill') then
    perform private.refuse('position_holder_rpc', 'Fill a position with app.fill_position and vacate it with app.vacate_position.');
  end if;
  return new;
end;
$$;

comment on function private.guard_project_position() is 'Project positions (B9): an agency position names an agency-slot engagement (position_engagement_not_agency) on its project, a roster holder is on that engagement''s roster (position_holder_kind), the holder columns change only inside app.fill_position and app.vacate_position (position_holder_rpc), a held position keeps its agency, and agency or project do not change while a live shift or record assignment names the position (position_in_use).';
revoke all on function private.guard_project_position() from public, anon, authenticated;

create trigger t36_guard_project_position before insert or update on app.project_positions
  for each row execute function private.guard_project_position();

call private.install_policies('app.project_positions',
  $$project_id in (select private.project_ids_with('crew.shift.read'))
    or membership_id in (select private.my_membership_ids())
    or roster_entry_id in (select private.my_roster_entry_ids('operational'))
    or (engagement_id is not null and private.can_manage_roster(engagement_id))$$,
  $$project_id in (select private.project_ids_with('crew.shift.write'))$$);
call private.install_default_retention('app.project_positions');
call private.install_audit_trail('app.project_positions');

-- Shifts held for a position --------------------------------------------------------------------------------------------------------

alter table app.shifts add column project_position_id uuid references app.project_positions (id);
create index shifts_project_position_id_idx on app.shifts (project_position_id);
comment on column app.shifts.project_position_id is 'Project position the shift is held for (B9). While it is unfilled nobody claims or is dragged onto the shift; an agency position''s shifts are its agency''s slots. Filling the position puts its holder on the shift.';

-- 2750's references with the position added.
call private.install_tenant_guards('app.shifts', 'app.projects', 'project_id',
  array['app.records', 'record_id', 'app.scope_nodes', 'scope_node_id', 'app.memberships', 'membership_id', 'app.engagements', 'engagement_id',
        'app.engagement_roster_entries', 'roster_entry_id', 'app.project_positions', 'project_position_id']);

create or replace function private.guard_shift_position()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_position app.project_positions;
begin
  if new.project_position_id is null then
    return new;
  end if;
  select * into v_position from app.project_positions p where p.id = new.project_position_id;
  if v_position.project_id is distinct from new.project_id then
    perform private.refuse('same_project', 'shifts.project_position_id points to a position of another project.');
  end if;
  -- Held, a claim could never be approved or filled past: decide the claims first.
  if tg_op = 'UPDATE' and new.project_position_id is distinct from old.project_position_id
     and exists (select 1 from app.shift_claims c where c.shift_id = new.id and c.claim_state = 'Requested' and c.deleted_at is null) then
    perform private.refuse('shift_claims_waiting', 'Members claimed this shift; approve or reject their claims on the shift first.');
  end if;
  if private.in_trusted_operation('position_fill') or private.in_trusted_operation('shift_reconfirm') then
    return new;
  end if;
  if v_position.engagement_id is not null then
    if new.membership_id is null
       and ((new.engagement_id = v_position.engagement_id and new.roster_entry_id is null)
            or (new.engagement_id is null and new.roster_entry_id is not null
                and (select r.engagement_id from app.engagement_roster_entries r where r.id = new.roster_entry_id) = v_position.engagement_id)) then
      return new;
    end if;
  elsif new.engagement_id is null and new.roster_entry_id is null
        and (new.membership_id is null or new.membership_id is not distinct from v_position.membership_id) then
    return new;
  end if;
  perform private.refuse('shift_held_for_position', 'This shift is held for a position. Fill the position, or take the shift off it first.');
  return new;
end;
$$;

comment on function private.guard_shift_position() is 'Shifts held for a project position (B9): the position is on the shift''s project, and nobody else is put on the shift (shift_held_for_position): an agency position''s shifts are its agency''s slots or held by any accepted person of its roster, a member position''s are open or its holder''s. A shift with waiting claims is not put on a position (shift_claims_waiting). app.fill_position, app.vacate_position (position_fill) and a reopen after a declined reconfirmation (shift_reconfirm) are exempt.';
revoke all on function private.guard_shift_position() from public, anon, authenticated;

create trigger t37_guard_shift_position before insert or update of project_position_id, project_id, membership_id, engagement_id, roster_entry_id on app.shifts
  for each row execute function private.guard_shift_position();

-- A swap would change who works a held shift, which t37 refuses when it is applied: say so when it is asked for. From 6512.
create or replace function private.guard_shift_swap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if (select s.membership_id from app.shifts s where s.id = new.shift_id) is distinct from new.requested_by_membership_id then
      perform private.refuse('swap_not_on_shift', 'Only the person on a shift asks to swap it.');
    end if;
    if not coalesce(private.project_setting_boolean((select s.project_id from app.shifts s where s.id = new.shift_id), 'scheduling.allow_swaps'), true) then
      perform private.refuse('swap_not_allowed', 'This project does not allow shift swaps.');
    end if;
    if (select s.project_position_id from app.shifts s where s.id = new.shift_id) is not null then
      perform private.refuse('shift_held_for_position', 'This shift is held for a position. Fill the position, or take the shift off it first.');
    end if;
    if nullif(btrim(coalesce(new.reason, '')), '') is null
       and coalesce(private.project_setting_boolean((select s.project_id from app.shifts s where s.id = new.shift_id), 'scheduling.swap_reason_required'), false) then
      perform private.refuse('swap_reason_required', 'Say why you are asking to swap this shift.');
    end if;
  elsif new.shift_id <> old.shift_id or new.requested_by_membership_id <> old.requested_by_membership_id
        or new.proposed_membership_id <> old.proposed_membership_id or new.reason is distinct from old.reason then
    perform private.refuse('swap_immutable', 'A swap keeps its shift, people and reason; cancel it and ask again.');
  end if;
  return new;
end;
$$;

comment on function private.guard_shift_swap() is 'Shift swaps are asked for by the person on the shift, only while the project allows swaps (scheduling.allow_swaps, 1322), never on a shift held for a position (shift_held_for_position, B9), with a reason while scheduling.swap_reason_required is on (B9), and never change parties or reason.';
revoke all on function private.guard_shift_swap() from public, anon, authenticated;

-- Open shifts held for a position are not open (latest: 2750) -----------------------------------------------------------------------

create or replace function private.assert_claimable(p_shift app.shifts, p_person uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if num_nonnulls(p_shift.membership_id, p_shift.engagement_id, p_shift.roster_entry_id) > 0 then
    perform private.refuse('shift_already_claimed', 'Someone already holds this shift.');
  end if;
  if p_shift.project_position_id is not null then
    perform private.refuse('shift_held_for_position', 'This shift is held for a position until someone fills it.');
  end if;
  if p_shift.shift_state <> 'Published' then
    perform private.refuse('shift_not_published', 'Only a published open shift can be claimed.');
  end if;
  if exists (
    select 1 from app.shifts s
    where s.org_id = p_shift.org_id and s.deleted_at is null and s.shift_state <> 'Canceled'
      and private.shift_worker_person_id(s.membership_id, s.engagement_id, s.roster_entry_id) = p_person
      and tstzrange(s.starts_at, s.ends_at) && tstzrange(p_shift.starts_at, p_shift.ends_at)) then
    perform private.refuse('shift_double_booked', 'You already hold a shift that overlaps this one.');
  end if;
end;
$$;

comment on function private.assert_claimable(app.shifts, uuid) is 'Refuses a claim on a shift someone holds through any worker column (a membership, an engagement or agency slot, or a roster entry, R12), a shift held for a project position (shift_held_for_position, B9), a shift that is not Published, or one overlapping another shift the person holds through any of them.';
revoke all on function private.assert_claimable(app.shifts, uuid) from public, anon, authenticated;

alter policy shifts_read on app.shifts using (
  (project_id in (select private.project_ids_with('crew.shift.read')))
  or (membership_id in (select private.my_membership_ids()))
  or (engagement_id in (select private.my_engagement_ids('operational')))
  or (roster_entry_id in (select private.my_roster_entry_ids('operational')))
  or (membership_id is null and engagement_id is null and roster_entry_id is null and project_position_id is null
      and shift_state = 'Published' and deleted_at is null
      and private.capability_reach(org_id, 'crew.shift.read') is not null)
);
comment on policy shifts_read on app.shifts is 'Shifts of projects where the person may read shifts, their own shifts, engaged shifts and roster shifts (R12), and published open shifts, with every worker column NULL and held for no position (B9), for every member who may read shifts at any reach, so crew can claim them (0462, folded in by 1221).';

drop index app.shifts_open_idx;
create index shifts_open_idx on app.shifts (org_id, starts_at)
  where membership_id is null and engagement_id is null and roster_entry_id is null and project_position_id is null and deleted_at is null;

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
  if num_nonnulls(v_shift.membership_id, v_shift.engagement_id, v_shift.roster_entry_id) > 0 then
    perform private.refuse('shift_already_filled', 'Someone was put on this shift since the schedule was read.');
  end if;
  if v_shift.project_position_id is not null then
    perform private.refuse('shift_held_for_position', 'This shift is held for a position. Fill the position instead.');
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

comment on function app.assign_open_shift(uuid, uuid) is 'Puts an active member of the org on an open shift from the schedule''s drag board (A132, ADR 0063), with crew.shift.write on the project. Refused while someone holds the shift through any worker column, an agency slot included (shift_already_filled, R12), while it is held for a project position (shift_held_for_position, B9), or members wait on a claim for it (shift_claims_waiting, the 1322 approval and seniority rules), so a waiting claim is always decided on the shift. Returns the shift id.';
revoke all on function app.assign_open_shift(uuid, uuid) from public, anon;
grant execute on function app.assign_open_shift(uuid, uuid) to authenticated, service_role;

create or replace function app.assign_open_shift_to_roster(p_shift_id uuid, p_roster_entry_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shift app.shifts;
  v_engagement uuid;
begin
  perform private.require_person();
  select * into v_shift from app.shifts s where s.id = p_shift_id and s.deleted_at is null for update;
  if v_shift.id is null or not private.can_on_project(v_shift.project_id, 'crew.shift.write') then
    raise exception using errcode = '42501', message = 'crew.shift.write is required on the project';
  end if;
  if num_nonnulls(v_shift.membership_id, v_shift.engagement_id, v_shift.roster_entry_id) > 0 then
    perform private.refuse('shift_already_filled', 'Someone was put on this shift since the schedule was read.');
  end if;
  if v_shift.project_position_id is not null then
    perform private.refuse('shift_held_for_position', 'This shift is held for a position. Fill the position instead.');
  end if;
  if exists (select 1 from app.shift_claims c where c.shift_id = p_shift_id and c.claim_state = 'Requested' and c.deleted_at is null) then
    perform private.refuse('shift_claims_waiting', 'Members claimed this shift; approve or reject their claims on the shift.');
  end if;
  select r.engagement_id into v_engagement from app.engagement_roster_entries r where r.id = p_roster_entry_id and r.deleted_at is null;
  if v_engagement is null or not private.is_agency_slot_engagement(v_engagement) then
    perform private.refuse('roster_shift_not_agency_slot', 'Only an agency slot, or a shift held by the agency''s roster, takes agency staff.');
  end if;
  -- The shift becomes the agency's slot, then app.assign_roster_shift checks the entry, the training and overlaps
  -- and places the person; any refusal undoes both.
  update app.shifts set engagement_id = v_engagement where id = p_shift_id;
  return app.assign_roster_shift(p_shift_id, p_roster_entry_id);
end;
$$;

comment on function app.assign_open_shift_to_roster(uuid, uuid) is 'Puts an accepted person of an agency''s roster on an open shift from the schedule''s drag board (R12 with A132), with crew.shift.write on the project: the shift becomes the agency''s slot and app.assign_roster_shift places the person, in one transaction, so any of its refusals leaves the shift open. Refused while someone holds the shift (shift_already_filled), while it is held for a project position (shift_held_for_position, B9) or members wait on a claim for it (shift_claims_waiting), and for an entry outside a Staff company engagement (roster_shift_not_agency_slot). Returns the shift id.';
revoke all on function app.assign_open_shift_to_roster(uuid, uuid) from public, anon;
grant execute on function app.assign_open_shift_to_roster(uuid, uuid) to authenticated, service_role;

-- A reopened shift leaves its position (latest: 6511) ------------------------------------------------------------------------------------

create or replace function private.reopen_declined_shift(p_shift_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shift app.shifts;
  v_engagement uuid;
begin
  select * into v_shift from app.shifts s where s.id = p_shift_id and s.deleted_at is null for update;
  if v_shift.id is null or v_shift.shift_state = 'Canceled' then
    return;
  end if;
  if v_shift.roster_entry_id is not null then
    -- A roster shift goes back to its agency's slot, as app.unassign_roster_shift does, for the agency to fill again; it
    -- stays on an agency position, whose shifts are that agency's slots.
    v_engagement := (select r.engagement_id from app.engagement_roster_entries r where r.id = v_shift.roster_entry_id);
    perform private.begin_trusted_operation('roster_shift_assignment');
    if v_shift.shift_state = 'Accepted' then
      perform private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions',
        'shift_id', v_shift.id, 'Accepted', 'Published', p_reason);
    end if;
    update app.shifts set engagement_id = v_engagement, roster_entry_id = null where id = v_shift.id;
    perform private.end_trusted_operation('roster_shift_assignment');
    return;
  end if;
  -- A member or engaged shift becomes an ordinary open shift: Published first, with its worker, then no worker and no
  -- position, so anyone may claim it under the project's 1322 rule.
  perform private.begin_trusted_operation('shift_reconfirm');
  if v_shift.shift_state = 'Accepted' then
    perform private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions',
      'shift_id', v_shift.id, 'Accepted', 'Published', p_reason);
  end if;
  if v_shift.engagement_id is not null then
    -- private.guard_engaged_worker (R12, 2750) is not redefined: its trusted operation roster_shift_assignment is the
    -- one that lets a definer RPC clear engagement_id for a caller without crew.shift.write.
    perform private.begin_trusted_operation('roster_shift_assignment');
    update app.shifts set engagement_id = null where id = v_shift.id;
    perform private.end_trusted_operation('roster_shift_assignment');
  end if;
  update app.shifts set membership_id = null, project_position_id = null where id = v_shift.id;
  perform private.end_trusted_operation('shift_reconfirm');
end;
$$;

comment on function private.reopen_declined_shift(uuid, text) is 'Reopens a shift whose worker said they are not coming (6511): a member or engaged shift becomes a Published open shift with every worker column and project_position_id NULL (trusted operation shift_reconfirm), claimable under the project''s 1322 rule; a roster shift goes back to its agency''s slot (trusted operation roster_shift_assignment), still on its agency position. The reason goes in the shift''s ledger.';
revoke all on function private.reopen_declined_shift(uuid, text) from public, anon, authenticated;

-- A position goes to Trash only when nothing hangs on it -------------------------------------------------------------------------------

create or replace function private.guard_position_trash()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null
     and (num_nonnulls(new.membership_id, new.roster_entry_id) > 0
          or exists (select 1 from app.shifts s where s.project_position_id = new.id and s.deleted_at is null
                     and s.shift_state <> 'Canceled' and s.ends_at > now())
          or exists (select 1 from app.record_position_assignments a where a.project_position_id = new.id and a.deleted_at is null)) then
    perform private.refuse('position_in_use', 'Vacate the position and move its shifts and records off it before moving it to Trash.');
  end if;
  return new;
end;
$$;

comment on function private.guard_position_trash() is 'A project position goes to Trash only while unfilled and no live, not-ended shift and no live record assignment names it (position_in_use, B9), so restoring it is always safe and a removed position never holds shifts.';
revoke all on function private.guard_position_trash() from public, anon, authenticated;

-- Records assigned to a position ---------------------------------------------------------------------------------------------------------

create table app.record_position_assignments (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  record_id uuid not null references app.records (id),
  project_position_id uuid not null references app.project_positions (id),
  resolved_assignment_id uuid references app.record_assignments (id)
);

create index record_position_assignments_record_id_idx on app.record_position_assignments (record_id);
create index record_position_assignments_position_idx on app.record_position_assignments (project_position_id);
create index record_position_assignments_resolved_idx on app.record_position_assignments (resolved_assignment_id);

call private.install_domain_table('app.record_position_assignments', 'app.records', 'record_id',
  array['app.project_positions', 'project_position_id', 'app.record_assignments', 'resolved_assignment_id']);
create unique index record_position_assignments_key on app.record_position_assignments (record_id, project_position_id)
  where deleted_at is null;

call private.describe('app.record_position_assignments', 'Records assigned to a project position (B9, ADR 0148), before or after someone holds it. For a member holder each resolves to an app.record_assignments row the fill created; for a roster holder the record stays on the position and the holder reads it through api_external.position_records. Unassigning (a soft delete) is the undo.', array[
  'record_id', 'Record, on the position''s project.',
  'project_position_id', 'Position the record is assigned to.',
  'resolved_assignment_id', 'Record assignment of the member holder that filling the position created; null when the member already held one, for a roster holder, or while unfilled.'
]);

create trigger t38_guard_position_trash before update of deleted_at on app.project_positions
  for each row execute function private.guard_position_trash();

create or replace function private.holds_position(p_position_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p.membership_id in (select private.my_membership_ids())
                       or p.roster_entry_id in (select private.my_roster_entry_ids('operational'))
                       or (p.engagement_id is not null and private.can_manage_roster(p.engagement_id))
                   from app.project_positions p where p.id = p_position_id and p.deleted_at is null), false);
$$;

comment on function private.holds_position(uuid) is 'B9: true when the signed-in person holds the position (a member or a person of the roster) or leads its agency''s roster.';
revoke all on function private.holds_position(uuid) from public, anon;
-- Function calls inside a policy run with the caller's execute privilege, so signed-in users need this.
grant execute on function private.holds_position(uuid) to authenticated, service_role;

create or replace function private.guard_record_position_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select r.project_id from app.records r where r.id = new.record_id)
     is distinct from (select p.project_id from app.project_positions p where p.id = new.project_position_id) then
    perform private.refuse('same_project', 'record_position_assignments: the record and the position are on the same project.');
  end if;
  if (tg_op = 'INSERT' and new.resolved_assignment_id is not null
      or tg_op = 'UPDATE' and (new.resolved_assignment_id is distinct from old.resolved_assignment_id
                               or new.record_id <> old.record_id or new.project_position_id <> old.project_position_id))
     and not private.in_trusted_operation('position_fill') then
    perform private.refuse('position_holder_rpc', 'A record assignment of a position resolves only when the position is filled.');
  end if;
  return new;
end;
$$;

comment on function private.guard_record_position_assignment() is 'B9: a record is assigned to a position of its own project, keeps its record and position, and resolves to a record assignment only inside app.fill_position and app.vacate_position (position_holder_rpc).';
revoke all on function private.guard_record_position_assignment() from public, anon, authenticated;

create trigger t36_guard_record_position_assignment before insert or update on app.record_position_assignments
  for each row execute function private.guard_record_position_assignment();

-- A record assigned to a position a member already holds resolves at once; unassigning removes what it resolved to.
create or replace function private.sync_record_position_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership uuid := (select p.membership_id from app.project_positions p where p.id = new.project_position_id and p.deleted_at is null);
  v_assignment uuid;
begin
  if tg_op = 'INSERT' and new.deleted_at is null and v_membership is not null
     and not exists (select 1 from app.record_assignments a where a.record_id = new.record_id and a.membership_id = v_membership
                     and a.deleted_at is null) then
    insert into app.record_assignments (record_id, membership_id) values (new.record_id, v_membership) returning id into v_assignment;
    perform private.begin_trusted_operation('position_fill');
    update app.record_position_assignments set resolved_assignment_id = v_assignment where id = new.id;
    perform private.end_trusted_operation('position_fill');
  elsif tg_op = 'UPDATE' and new.deleted_at is not null and old.deleted_at is null and new.resolved_assignment_id is not null then
    update app.record_assignments set deleted_at = now() where id = new.resolved_assignment_id and deleted_at is null;
    perform private.begin_trusted_operation('position_fill');
    update app.record_position_assignments set resolved_assignment_id = null where id = new.id;
    perform private.end_trusted_operation('position_fill');
  end if;
  return null;
end;
$$;

comment on function private.sync_record_position_assignment() is 'After a record is assigned to a position (B9): when a member holds it and is not already assigned, the record is assigned to them and the row resolves to that assignment. Unassigning the record from the position removes the assignment it resolved to, and only that.';
revoke all on function private.sync_record_position_assignment() from public, anon, authenticated;

create trigger t92_sync_record_position_assignment after insert or update of deleted_at on app.record_position_assignments
  for each row execute function private.sync_record_position_assignment();

call private.install_policies('app.record_position_assignments',
  -- The shape 0943 gives record child tables: the one parent record by primary key, never every reachable record.
  $$org_id = any (array(select private.oversight_org_ids('work.record.read')))
    or exists (select 1 from app.records r where r.id = record_id and r.deleted_at is null
               and (r.project_id = any (array(select private.project_ids_with('work.record.read')))
                    or r.id = any (array(select private.my_record_ids('work.record.read')))))
    or private.holds_position(project_position_id)$$,
  $$record_id in (select r.id from app.records r where r.project_id in (select private.project_ids_with('work.record.write')))$$);
call private.install_default_retention('app.record_position_assignments');
call private.install_audit_trail('app.record_position_assignments');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('record_position_assignments', 'Unassigning a record from a position is undone by assigning it again, never from Trash.')
on conflict (table_name) do nothing;

-- Filling and vacating ----------------------------------------------------------------------------------------------------------------------

create or replace function app.fill_position(p_position_id uuid, p_membership_id uuid default null, p_roster_entry_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_position app.project_positions;
  v_entry app.engagement_roster_entries;
  v_holder uuid;
  v_shift app.shifts;
  v_filled integer := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_records integer := 0;
  v_link app.record_position_assignments;
  v_assignment uuid;
  v_code text;
  v_filled_ids uuid[] := '{}';
  v_warnings jsonb;
begin
  select * into v_position from app.project_positions p where p.id = p_position_id and p.deleted_at is null for update;
  -- The caller first: nobody learns from a refusal that a position exists unless they may fill it.
  if v_position.id is null
     or not (private.can_on_project(v_position.project_id, 'crew.shift.write')
             or (v_position.engagement_id is not null and private.can_place_roster_staff(v_position.engagement_id))) then
    raise exception using errcode = '42501', message = 'crew.shift.write on the project, or the agency''s lead for an agency position, fills it';
  end if;
  if num_nonnulls(p_membership_id, p_roster_entry_id) <> 1 then
    perform private.refuse('position_holder_one', 'Fill a position with one member or one person of an agency''s roster.');
  end if;
  if p_membership_id is not null then
    if not private.can_on_project(v_position.project_id, 'crew.shift.write') then
      raise exception using errcode = '42501', message = 'crew.shift.write is required on the project to fill a position with a member';
    end if;
    if v_position.engagement_id is not null then
      perform private.refuse('position_holder_kind', 'An agency position is filled from its agency''s roster.');
    end if;
    if not exists (
      select 1 from app.memberships m
      where m.id = p_membership_id and m.org_id = v_position.org_id and m.deleted_at is null
        and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
      raise exception using errcode = '42501', message = 'only an active member of the org fills its position';
    end if;
    v_holder := (select m.person_id from app.memberships m where m.id = p_membership_id);
  else
    select * into v_entry from app.engagement_roster_entries r where r.id = p_roster_entry_id and r.deleted_at is null;
    if v_position.engagement_id is null or v_entry.id is null or v_entry.engagement_id <> v_position.engagement_id then
      perform private.refuse('position_holder_kind', 'An agency position is held by a person of its own agency''s roster.');
    end if;
    if v_entry.entry_state <> 'Accepted' or v_entry.person_response <> 'Accepted' then
      perform private.refuse('roster_entry_not_accepted', 'Fill the position once the production accepted the roster entry and the person accepted it too.');
    end if;
    if exists (select 1 from private.roster_training_due(v_entry.id)) then
      perform private.refuse('roster_training_incomplete', 'This person has training to acknowledge, or to be verified, before their first shift.');
    end if;
    v_holder := private.roster_entry_person(v_entry.id);
  end if;
  if num_nonnulls(v_position.membership_id, v_position.roster_entry_id) > 0 then
    perform private.refuse('position_filled', 'Someone holds this position. Vacate it first.');
  end if;

  perform private.begin_trusted_operation('position_fill');
  update app.project_positions set membership_id = p_membership_id, roster_entry_id = p_roster_entry_id, filled_at = now()
  where id = v_position.id;

  for v_shift in
    select s.* from app.shifts s
    where s.project_position_id = v_position.id and s.deleted_at is null and s.shift_state <> 'Canceled' and s.ends_at > now()
      and private.shift_worker_person_id(s.membership_id, s.engagement_id, s.roster_entry_id) is null
    order by s.starts_at, s.id
    for update
  loop
    if p_membership_id is not null then
      if exists (select 1 from app.shift_claims c where c.shift_id = v_shift.id and c.claim_state = 'Requested' and c.deleted_at is null) then
        v_skipped := v_skipped || jsonb_build_object('shift_id', v_shift.id, 'code', 'shift_claims_waiting');
      elsif exists (
        select 1 from app.shifts s
        where s.id <> v_shift.id and s.org_id = v_shift.org_id and s.deleted_at is null and s.shift_state <> 'Canceled'
          and private.shift_worker_person_id(s.membership_id, s.engagement_id, s.roster_entry_id) = v_holder
          and tstzrange(s.starts_at, s.ends_at) && tstzrange(v_shift.starts_at, v_shift.ends_at)) then
        v_skipped := v_skipped || jsonb_build_object('shift_id', v_shift.id, 'code', 'shift_double_booked');
      else
        update app.shifts set membership_id = p_membership_id where id = v_shift.id;
        v_filled := v_filled + 1;
        v_filled_ids := v_filled_ids || v_shift.id;
      end if;
    else
      -- app.assign_roster_shift decides every roster rule; a refusal skips the shift and names its rule.
      begin
        perform app.assign_roster_shift(v_shift.id, p_roster_entry_id);
        v_filled := v_filled + 1;
        v_filled_ids := v_filled_ids || v_shift.id;
      exception when sqlstate 'XR001' then
        get stacked diagnostics v_code = pg_exception_hint;
        v_skipped := v_skipped || jsonb_build_object('shift_id', v_shift.id, 'code', v_code);
      end;
    end if;
  end loop;

  if p_membership_id is not null then
    for v_link in
      select a.* from app.record_position_assignments a
      where a.project_position_id = v_position.id and a.deleted_at is null and a.resolved_assignment_id is null
      for update
    loop
      -- A member already assigned to the record keeps that assignment, and the position never removes it.
      if not exists (select 1 from app.record_assignments r where r.record_id = v_link.record_id and r.membership_id = p_membership_id
                     and r.deleted_at is null) then
        insert into app.record_assignments (record_id, membership_id) values (v_link.record_id, p_membership_id)
        returning id into v_assignment;
        update app.record_position_assignments set resolved_assignment_id = v_assignment where id = v_link.id;
        v_records := v_records + 1;
      end if;
    end loop;
  end if;
  perform private.end_trusted_operation('position_fill');

  -- Filling is an assignment path: the org's scheduling warnings for what it just did, never a refusal (6513).
  select coalesce(jsonb_agg(jsonb_build_object('shift_id', x.id, 'code', x.code) order by x.id, x.code), '[]'::jsonb) into v_warnings
  from (select distinct f.id, w.code from unnest(v_filled_ids) f (id) cross join lateral private.shift_policy_warnings(f.id, v_holder) w) x;

  perform private.write_audit_event(v_position.org_id, 'crew.position_filled', 'app.project_positions', v_position.id,
    jsonb_build_object('membership_id', p_membership_id, 'roster_entry_id', p_roster_entry_id, 'shifts_filled', v_filled,
      'records_resolved', v_records));
  return jsonb_build_object('position_id', v_position.id, 'shifts_filled', v_filled, 'shifts_skipped', v_skipped,
    'records_resolved', v_records, 'policy_warnings', v_warnings);
end;
$$;

comment on function app.fill_position(uuid, uuid, uuid) is 'Fills a project position (B9, ADR 0148) with exactly one holder (position_holder_one): a member (crew.shift.write on the project, an active member of the org, a member position) or a person of the agency''s roster (crew.shift.write, or the agency''s lead while the operational area is open; the entry and the person accepted, roster_entry_not_accepted; no training due, roster_training_incomplete). A held position refuses position_filled. Each live, not canceled, not ended shift of the position with no person goes to the holder: a member directly, skipping a shift with waiting claims (shift_claims_waiting) or one the holder overlaps (shift_double_booked); a roster person through app.assign_roster_shift, skipping a shift it refuses with that rule. For a member holder each record assigned to the position becomes their record assignment unless they already hold one. Audits crew.position_filled. Returns {position_id, shifts_filled, shifts_skipped: [{shift_id, code}], records_resolved, policy_warnings: [{shift_id, code}]}; the warnings are the org''s scheduling warnings for the shifts it filled, never refusals.';
revoke all on function app.fill_position(uuid, uuid, uuid) from public, anon;
grant execute on function app.fill_position(uuid, uuid, uuid) to authenticated, service_role;

create or replace function app.vacate_position(p_position_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_position app.project_positions;
  v_reason text := left(coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Position vacated.'), 500);
  v_shift app.shifts;
  v_returned integer := 0;
  v_records integer := 0;
begin
  perform private.require_person();
  select * into v_position from app.project_positions p where p.id = p_position_id and p.deleted_at is null for update;
  if v_position.id is null
     or not (private.can_on_project(v_position.project_id, 'crew.shift.write')
             or (v_position.roster_entry_id is not null and private.can_place_roster_staff(v_position.engagement_id))) then
    raise exception using errcode = '42501', message = 'crew.shift.write on the project, or the agency''s lead for an agency position, vacates it';
  end if;
  if num_nonnulls(v_position.membership_id, v_position.roster_entry_id) = 0 then
    perform private.refuse('position_vacant', 'Nobody holds this position.');
  end if;

  perform private.begin_trusted_operation('position_fill');
  for v_shift in
    select s.* from app.shifts s
    where s.project_position_id = v_position.id and s.deleted_at is null and s.shift_state <> 'Canceled' and s.starts_at > now()
      and (s.membership_id = v_position.membership_id or s.roster_entry_id = v_position.roster_entry_id)
    order by s.starts_at, s.id
    for update
  loop
    if v_shift.roster_entry_id is not null then
      perform app.unassign_roster_shift(v_shift.id, v_reason);
    else
      if v_shift.shift_state = 'Accepted' then
        perform private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions',
          'shift_id', v_shift.id, 'Accepted', 'Published', v_reason);
      end if;
      update app.shifts set membership_id = null where id = v_shift.id;
    end if;
    v_returned := v_returned + 1;
  end loop;

  -- Only the record assignments filling made go; one the member held before stays.
  with gone as (
    update app.record_assignments r set deleted_at = now()
    from app.record_position_assignments a
    where a.project_position_id = v_position.id and a.deleted_at is null and a.resolved_assignment_id = r.id and r.deleted_at is null
    returning r.id)
  select count(*)::integer into v_records from gone;
  update app.record_position_assignments set resolved_assignment_id = null
  where project_position_id = v_position.id and resolved_assignment_id is not null;
  update app.project_positions set membership_id = null, roster_entry_id = null, filled_at = null where id = v_position.id;
  perform private.end_trusted_operation('position_fill');

  perform private.write_audit_event(v_position.org_id, 'crew.position_vacated', 'app.project_positions', v_position.id,
    jsonb_build_object('membership_id', v_position.membership_id, 'roster_entry_id', v_position.roster_entry_id,
      'reason', v_reason, 'shifts_returned', v_returned, 'records_unassigned', v_records));
  return jsonb_build_object('position_id', v_position.id, 'shifts_returned', v_returned, 'records_unassigned', v_records);
end;
$$;

comment on function app.vacate_position(uuid, text) is 'Vacates a filled project position (B9), by crew.shift.write on the project or, for an agency position, the agency''s lead: the holder''s future, not started shifts of the position return to it (an Accepted shift to Published with the reason; a roster shift through app.unassign_roster_shift, back to the agency''s slot), the record assignments filling created are removed and nothing else, and the holder is cleared. Refuses position_vacant. Audits crew.position_vacated. Returns {position_id, shifts_returned, records_unassigned}.';
revoke all on function app.vacate_position(uuid, text) from public, anon;
grant execute on function app.vacate_position(uuid, text) to authenticated, service_role;

-- External reads --------------------------------------------------------------------------------------------------------------------------------

create or replace view api_external.position_records as
select r.id, r.project_id, r.record_kind, r.title, r.record_state, r.due_at, r.starts_at,
  p.id as project_position_id, p.title as position_title
from app.record_position_assignments a
join app.project_positions p on p.id = a.project_position_id and p.deleted_at is null
join app.records r on r.id = a.record_id and r.deleted_at is null
where a.deleted_at is null
  and (p.roster_entry_id in (select private.my_roster_entry_ids('operational'))
       or (p.engagement_id is not null and private.can_manage_roster(p.engagement_id)));

call private.describe('api_external.position_records', 'Records assigned to the project positions an agency staff member holds, and to the positions of rosters the caller leads (B9, ADR 0148), for Gateway''s Positions tab: assigning a record to a position is the authorization to show its title, kind, state and dates to its holder. Read through the view''s own filter.', array[
  'id', 'Record.',
  'project_id', 'Project of the record and the position.',
  'record_kind', 'Kind of record.',
  'title', 'Record title.',
  'record_state', 'Record state.',
  'due_at', 'When the record is due.',
  'starts_at', 'Start of the record''s window.',
  'project_position_id', 'Position the record is assigned to.',
  'position_title', 'Title of the position.'
]);
revoke all on api_external.position_records from public, anon;
grant select on api_external.position_records to authenticated, service_role;

create or replace view api_external.shifts as
select s.id, s.engagement_id, s.project_id, p.name as project_name, s.scope_node_id, n.name as scope_node_name,
  s.role_code, r.job_title, s.starts_at, s.ends_at, s.time_zone, s.shift_state,
  s.roster_entry_id,
  case when s.roster_entry_id is not null
        and (s.roster_entry_id in (select private.my_roster_entry_ids('operational')) or private.roster_entry_lead(s.roster_entry_id))
    then (select h.full_name from private.roster_people rp join app.people h on h.id = rp.person_id where rp.roster_entry_id = s.roster_entry_id)
  end as holder_name,
  private.is_agency_slot_engagement(s.engagement_id) as is_agency_slot,
  s.project_position_id,
  pos.title as position_title,
  exists (select 1 from app.shift_no_shows ns where ns.shift_id = s.id and ns.deleted_at is null) as has_no_show
from app.shifts s
join app.projects p on p.id = s.project_id
left join app.scope_nodes n on n.id = s.scope_node_id
left join xpms.role r on r.role_code = s.role_code
left join app.project_positions pos on pos.id = s.project_position_id and pos.deleted_at is null
where s.deleted_at is null and s.shift_state in ('Published', 'Accepted', 'Canceled')
  and ((s.engagement_id in (select private.my_engagement_ids('operational')) and not private.is_agency_slot_engagement(s.engagement_id))
    or (s.engagement_id is not null and private.is_agency_slot_engagement(s.engagement_id) and private.can_manage_roster(s.engagement_id))
    or s.roster_entry_id in (select private.my_roster_entry_ids('operational'))
    or private.roster_entry_lead(s.roster_entry_id));

comment on view api_external.shifts is 'Shifts assigned to the caller''s engagements, once published (Section 4.4.4 Crew and Staff: shifts and call times), while the operational area is open. A staffing agency''s leads also read its agency slots and the shifts of its roster staff with the holder''s name; a person on the roster reads their own (R12). Each names the project position it is held for (B9), which Gateway''s Positions tab groups by. Drafts never appear.';
comment on column api_external.shifts.roster_entry_id is 'Roster entry of the agency staff member who works the shift (R12); NULL otherwise.';
comment on column api_external.shifts.holder_name is 'Name of the agency staff member on the shift, for that person and the agency''s leads; NULL otherwise.';
comment on column api_external.shifts.is_agency_slot is 'True for an agency slot: a shift the production allocated to the staffing agency that no one on its roster holds yet.';
comment on column api_external.shifts.project_position_id is 'Project position the shift is held for (B9); NULL otherwise.';
comment on column api_external.shifts.position_title is 'Title of the project position the shift is held for (B9); NULL otherwise.';
comment on column api_external.shifts.has_no_show is 'True while the shift has a live no-show (B9), so Gateway shows the state without reading an app table.';

-- A removed position belongs in Trash (ADR 0110): register it now rather than at the nightly sweep.
select private.sync_trash_tables();
