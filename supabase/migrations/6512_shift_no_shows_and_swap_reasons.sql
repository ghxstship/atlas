-- 6512_shift_no_shows_and_swap_reasons.sql
-- B9 (RRR-233; ADR 0148 decision 1; parity gap G-119): a no-show is an outcome record, never a shift state, so the
-- frozen shifts.shift_state label and every lifecycle reader stay as they are; and a swap request can say why.
--
--   * app.shift_no_shows: one live no-show per shift, with the supervisor's reason and the replacement shift opened for
--     it. Its id is the client's, so Compass's offline replay of app.mark_shift_no_show (private.sync_rpcs) and an
--     external agency lead's direct call are both recognized when they arrive twice.
--   * app.mark_shift_no_show: a holder of crew.shift.write on the project, or for a roster shift the agency's lead,
--     marks the worker of a started, live Accepted or Published shift who has not clocked in on it. Never the worker
--     themself. It can open one replacement from now (rounded up to the minute) to the shift's end: an open shift, or
--     for a roster shift a Published slot of the entry's engagement for the agency to fill. The replacement never holds
--     the shift's position. The worker is told (shift.no_show).
--   * t41_guard_shift_no_show freezes the shift's worker, times and state (other than Canceled) while the no-show is
--     live; this is the only place that rule lives.
--   * app.withdraw_shift_no_show by the same callers, with a reason, and automatically when the worker clocks in on the
--     shift afterwards (t94_withdraw_no_show_on_clock_in on app.time_entries).
--   * app.shift_swaps.reason, required while scheduling.swap_reason_required is on (private.guard_shift_swap, from
--     1322) and never changed after the request.

-- No-shows -------------------------------------------------------------------------------------------------------------------

create table app.shift_no_shows (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  shift_id uuid not null references app.shifts (id),
  reason text not null,
  recorded_at timestamptz not null default now(),
  replacement_shift_id uuid references app.shifts (id),
  constraint shift_no_shows_reason_length check (char_length(btrim(reason)) between 1 and 500)
);

create index shift_no_shows_shift_id_idx on app.shift_no_shows (shift_id);
create index shift_no_shows_project_id_idx on app.shift_no_shows (project_id);
create index shift_no_shows_replacement_shift_id_idx on app.shift_no_shows (replacement_shift_id);

call private.install_domain_table('app.shift_no_shows', 'app.shifts', 'shift_id',
  array['app.projects', 'project_id', 'app.shifts', 'replacement_shift_id']);
create unique index shift_no_shows_one_live on app.shift_no_shows (shift_id) where deleted_at is null;

call private.describe('app.shift_no_shows', 'Crew members who did not arrive for a shift (ADR 0148): the outcome, never a shift state. Written only by app.mark_shift_no_show and app.withdraw_shift_no_show, and withdrawn automatically when the worker clocks in on the shift. While one is live the shift''s worker, times and state (other than Canceled) are frozen.', array[
  'id', 'Primary key, chosen by the client that marked it, so a replayed mark is recognized.',
  'project_id', 'Project of the shift.',
  'shift_id', 'Shift the worker did not arrive for.',
  'reason', 'What the supervisor saw. Confidential.',
  'recorded_at', 'When the no-show was marked.',
  'replacement_shift_id', 'Shift opened to replace the worker, when one was.'
]);

-- Readers of the shift's project, the worker and, for a roster shift, the agency's lead.
create or replace function private.shift_no_show_reader(p_shift_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select private.shift_worker_person_id(s.membership_id, s.engagement_id, s.roster_entry_id) = private.current_person_id()
        or private.roster_entry_lead(s.roster_entry_id)
    from app.shifts s where s.id = p_shift_id), false);
$$;

comment on function private.shift_no_show_reader(uuid) is 'B9: true when the signed-in person works the shift or leads the roster its worker is on (R12''s private.roster_entry_lead), so they read its no-show.';
revoke all on function private.shift_no_show_reader(uuid) from public, anon;
-- Function calls inside a policy run with the caller's execute privilege, so signed-in users need this.
grant execute on function private.shift_no_show_reader(uuid) to authenticated, service_role;

call private.install_policies('app.shift_no_shows',
  $$project_id in (select private.project_ids_with('crew.shift.read')) or private.shift_no_show_reader(shift_id)$$);
revoke insert, update on app.shift_no_shows from authenticated;
call private.install_default_retention('app.shift_no_shows');
call private.install_audit_trail('app.shift_no_shows');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('shift_no_shows', 'A no-show is withdrawn through app.withdraw_shift_no_show, with a reason, or when the worker clocks in; never restored from Trash.')
on conflict (table_name) do nothing;

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.shift_no_shows', 'reason', 'Confidential', null);

-- The shift is frozen while a no-show is live -----------------------------------------------------------------------------------

create or replace function private.guard_shift_no_show()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if ((new.membership_id, new.engagement_id, new.roster_entry_id) is distinct from (old.membership_id, old.engagement_id, old.roster_entry_id)
      or new.starts_at <> old.starts_at or new.ends_at <> old.ends_at
      or (new.shift_state <> old.shift_state and new.shift_state <> 'Canceled'))
     and exists (select 1 from app.shift_no_shows n where n.shift_id = new.id and n.deleted_at is null) then
    perform private.refuse('shift_no_show_frozen', 'This shift has a no-show. Withdraw the no-show before changing its worker, times or state, or cancel the shift.');
  end if;
  return new;
end;
$$;

comment on function private.guard_shift_no_show() is 'B9: while a shift has a live no-show, its worker columns, times and state (other than a cancel) do not change (shift_no_show_frozen). The one place this rule lives.';
revoke all on function private.guard_shift_no_show() from public, anon, authenticated;

create trigger t41_guard_shift_no_show before update on app.shifts
  for each row execute function private.guard_shift_no_show();

-- Marking -----------------------------------------------------------------------------------------------------------------------------

create or replace function app.mark_shift_no_show(p_no_show_id uuid, p_shift_id uuid, p_reason text, p_open_replacement boolean default false)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_existing app.shift_no_shows;
  v_shift app.shifts;
  v_worker uuid;
  v_writer boolean;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_id uuid := coalesce(p_no_show_id, private.uuid_v7());
  v_from timestamptz;
  v_slot uuid;
  v_replacement uuid;
begin
  -- A replay of the same mark returns it, even after it was withdrawn; the same id for another shift is a client bug.
  select * into v_existing from app.shift_no_shows n where n.id = v_id;
  if v_existing.id is not null then
    -- Only the person who made it, or someone who may mark that shift, learns the id is taken: it is no existence oracle.
    if v_existing.created_by is distinct from v_person and not (
         private.can_on_project(v_existing.project_id, 'crew.shift.write')
         or private.roster_entry_lead((select s.roster_entry_id from app.shifts s where s.id = v_existing.shift_id))) then
      raise exception using errcode = '42501', message = 'shift not found';
    end if;
    if v_existing.shift_id = p_shift_id then
      return v_existing.id;
    end if;
    perform private.refuse('no_show_id_conflict', 'This no-show id was already used for another shift.');
  end if;
  select * into v_shift from app.shifts s where s.id = p_shift_id and s.deleted_at is null for update;
  if v_shift.id is null then
    raise exception using errcode = '42501', message = 'shift not found';
  end if;
  v_worker := private.shift_worker_person_id(v_shift.membership_id, v_shift.engagement_id, v_shift.roster_entry_id);
  if v_worker is not distinct from v_person then
    perform private.refuse('shift_no_show_self', 'You cannot mark yourself as a no-show. Tell your supervisor.');
  end if;
  v_writer := private.can_on_project(v_shift.project_id, 'crew.shift.write');
  if not v_writer and not private.roster_entry_lead(v_shift.roster_entry_id) then
    raise exception using errcode = '42501', message = 'crew.shift.write on the project, or the agency''s lead for its roster staff, marks a no-show';
  end if;
  if v_worker is null or v_shift.shift_state not in ('Accepted', 'Published') or v_shift.starts_at > now() then
    perform private.refuse('shift_no_show_state', 'Mark a no-show once the shift has started and someone is on it.');
  end if;
  if exists (
    select 1 from app.time_entries e
    where e.shift_id = v_shift.id and e.deleted_at is null
      and private.worker_person_id(e.membership_id, e.engagement_id, e.roster_entry_id) = v_worker) then
    perform private.refuse('shift_no_show_clocked_in', 'This person clocked in on the shift, so they are not a no-show.');
  end if;
  if v_reason is null then
    perform private.refuse('shift_no_show_reason', 'Say what happened.');
  end if;
  select * into v_existing from app.shift_no_shows n where n.shift_id = v_shift.id and n.deleted_at is null;
  if v_existing.id is not null then
    return v_existing.id;
  end if;

  if coalesce(p_open_replacement, false) then
    v_from := greatest(now(), v_shift.starts_at);
    v_from := date_trunc('minute', v_from) + case when v_from > date_trunc('minute', v_from) then interval '1 minute' else interval '0' end;
    if v_shift.ends_at - v_from < interval '15 minutes' then
      perform private.refuse('shift_no_show_too_late', 'Less than 15 minutes of this shift are left, too little for a replacement.');
    end if;
    -- A roster shift's replacement is a slot of the same engagement, for the agency to fill; any other shift's is an open
    -- shift. Neither holds the shift's position.
    if v_shift.roster_entry_id is not null then
      v_slot := (select r.engagement_id from app.engagement_roster_entries r where r.id = v_shift.roster_entry_id);
    end if;
    insert into app.shifts (org_id, project_id, role_code, scope_node_id, record_id, time_zone, scheduled_break_minutes,
      starts_at, ends_at, engagement_id)
    values (v_shift.org_id, v_shift.project_id, v_shift.role_code, v_shift.scope_node_id, v_shift.record_id, v_shift.time_zone,
      case when coalesce(v_shift.scheduled_break_minutes, 0) * interval '1 minute' < v_shift.ends_at - v_from
           then v_shift.scheduled_break_minutes end,
      v_from, v_shift.ends_at, v_slot)
    returning id into v_replacement;
    perform private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions',
      'shift_id', v_replacement, 'Draft', 'Published', 'Replacement for a no-show.');
  end if;

  insert into app.shift_no_shows (id, project_id, shift_id, reason, replacement_shift_id)
  values (v_id, v_shift.project_id, v_shift.id, left(v_reason, 500), v_replacement);
  perform private.write_audit_event(v_shift.org_id, 'crew.no_show', 'app.shifts', v_shift.id,
    jsonb_build_object('no_show_id', v_id, 'replacement_shift_id', v_replacement));
  perform private.notify(v_shift.org_id, v_worker, 'shift.no_show', 'app.shifts', v_shift.id, v_shift.project_id,
    jsonb_build_object('title', private.shift_notification_title(v_shift.id),
      'startsAt', to_char(v_shift.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'endsAt', to_char(v_shift.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
  return v_id;
end;
$$;

comment on function app.mark_shift_no_show(uuid, uuid, text, boolean) is 'Records that the worker of a shift did not arrive (ADR 0148): crew.shift.write on the project, or the agency''s lead for a roster shift; never the worker (shift_no_show_self). The shift is live, Accepted or Published with a worker, and started (shift_no_show_state); the worker has no time entry on it (shift_no_show_clocked_in); a reason is required (shift_no_show_reason). With p_open_replacement it opens one Published replacement of the same role, scope, record and zone from now, rounded up to the minute, to the shift''s end (shift_no_show_too_late under 15 minutes): an open shift, or for a roster shift a slot of the entry''s engagement. Idempotent on p_no_show_id (no_show_id_conflict for another shift), so Compass replays it offline. Audits crew.no_show and tells the worker (shift.no_show). Returns the no-show id.';
revoke all on function app.mark_shift_no_show(uuid, uuid, text, boolean) from public, anon;
grant execute on function app.mark_shift_no_show(uuid, uuid, text, boolean) to authenticated, service_role;

insert into private.sync_rpcs (rpc, description) values
  ('app.mark_shift_no_show', 'A supervisor marks a crew member who did not arrive as a no-show offline; idempotent on the client id.')
on conflict (rpc) do nothing;

create or replace function app.withdraw_shift_no_show(p_no_show_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_no_show app.shift_no_shows;
  v_shift app.shifts;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform private.require_person();
  select * into v_no_show from app.shift_no_shows n where n.id = p_no_show_id and n.deleted_at is null for update;
  select * into v_shift from app.shifts s where s.id = v_no_show.shift_id;
  if v_no_show.id is null
     or not (private.can_on_project(v_shift.project_id, 'crew.shift.write') or private.roster_entry_lead(v_shift.roster_entry_id))
     or private.shift_worker_person_id(v_shift.membership_id, v_shift.engagement_id, v_shift.roster_entry_id) is not distinct from private.current_person_id() then
    raise exception using errcode = '42501', message = 'crew.shift.write on the project, or the agency''s lead for its roster staff, withdraws a no-show';
  end if;
  if v_reason is null then
    perform private.refuse('shift_no_show_reason', 'Say why the no-show is withdrawn.');
  end if;
  update app.shift_no_shows set deleted_at = now() where id = v_no_show.id;
  perform private.write_audit_event(v_no_show.org_id, 'crew.no_show_withdrawn', 'app.shifts', v_no_show.shift_id,
    jsonb_build_object('no_show_id', v_no_show.id, 'reason', left(v_reason, 500)));
  return v_no_show.id;
end;
$$;

comment on function app.withdraw_shift_no_show(uuid, text) is 'Withdraws a live no-show (ADR 0148), by the callers who mark one, with the reason in the audit trail (crew.no_show_withdrawn); the shift is no longer frozen. A replacement shift opened for it stays. Returns the no-show id.';
revoke all on function app.withdraw_shift_no_show(uuid, text) from public, anon;
grant execute on function app.withdraw_shift_no_show(uuid, text) to authenticated, service_role;

-- A clock-in after the mark withdraws it -----------------------------------------------------------------------------------------------

create or replace function private.withdraw_no_show_on_clock_in()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_no_show app.shift_no_shows;
begin
  if new.shift_id is null or new.deleted_at is not null then
    return null;
  end if;
  select n.* into v_no_show from app.shift_no_shows n join app.shifts s on s.id = n.shift_id
  where n.shift_id = new.shift_id and n.deleted_at is null
    and private.shift_worker_person_id(s.membership_id, s.engagement_id, s.roster_entry_id)
        = private.worker_person_id(new.membership_id, new.engagement_id, new.roster_entry_id);
  if v_no_show.id is null then
    return null;
  end if;
  update app.shift_no_shows set deleted_at = now() where id = v_no_show.id;
  perform private.write_audit_event(v_no_show.org_id, 'crew.no_show_withdrawn', 'app.shifts', v_no_show.shift_id,
    jsonb_build_object('no_show_id', v_no_show.id, 'reason', 'Clocked in after being marked a no-show.'));
  return null;
end;
$$;

comment on function private.withdraw_no_show_on_clock_in() is 'After a time entry is inserted (B9): when its worker is the worker of a shift with a live no-show and the entry works that shift, the no-show is withdrawn with the reason ''Clocked in after being marked a no-show.'' in the audit trail.';
revoke all on function private.withdraw_no_show_on_clock_in() from public, anon, authenticated;

create trigger t94_withdraw_no_show_on_clock_in after insert on app.time_entries
  for each row execute function private.withdraw_no_show_on_clock_in();

-- Swap reasons ----------------------------------------------------------------------------------------------------------------------------

alter table app.shift_swaps add column reason text;
alter table app.shift_swaps add constraint shift_swaps_reason_length check (reason is null or char_length(btrim(reason)) between 1 and 500);
comment on column app.shift_swaps.reason is 'Why the person on the shift asks to hand it over (B9). Required while scheduling.swap_reason_required is on for the project; never changes after the request.';

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

comment on function private.guard_shift_swap() is 'Shift swaps are asked for by the person on the shift, only while the project allows swaps (scheduling.allow_swaps, 1322), with a reason while scheduling.swap_reason_required is on (B9), and never change parties or reason.';
revoke all on function private.guard_shift_swap() from public, anon, authenticated;

-- A withdrawn no-show is never restored from Trash, so the registry stays exact (ADR 0110).
select private.sync_trash_tables();
