-- 2750_agency_shift_slots.sql
-- R12 Agency staff on shifts (RRR-190; ADR 0101 and its R12 amendment; build prompt line 454, journey 42). A staffing
-- agency wins one Staff engagement and places the people on its roster (R4) on the shifts the production allocates
-- to it. Nothing is copied: a shift names exactly one worker column, and the agency slot is the engagement itself.
--
--   * app.shifts.roster_entry_id: the roster entry (R4) that works the shift. shifts_one_worker becomes
--     num_nonnulls(membership_id, engagement_id, roster_entry_id) <= 1, and t39_shift_roster_entry_project checks that
--     the entry's engagement is on the shift's project.
--   * An agency slot is a shift whose engagement_id is a Staff engagement with counterparty_id set and person_id NULL
--     (private.is_agency_slot_engagement). Assigning it to a roster entry (app.assign_roster_shift, 2752) sets
--     roster_entry_id and clears engagement_id, so the slot is derived from the entry once it is assigned.
--   * private.guard_engaged_worker, recreated from A130's 2230 with its partition resolution: a shift may name an
--     agency-slot engagement, which has no person; time still needs a person. Changing engagement_id or roster_entry_id
--     on a shift needs crew.shift.write, unless app.assign_roster_shift or app.unassign_roster_shift is running
--     (trusted operation roster_shift_assignment), and roster_entry_id is written only there (roster_shift_rpc), so the
--     training and acceptance rules of 2752 always apply.
--   * Three-argument resolvers private.worker_person_id and private.shift_worker_person_id (the two-argument versions
--     stay for their callers); private.notify_shift_change (1394) and private.sync_scope_trigger (0942) resolve the
--     roster person through them. An agency slot resolves to nobody.
--   * Open shifts need every worker column NULL: private.assert_claimable (1322), the open-shift half of the
--     shifts_read policy (0462, folded in by 1221), shifts_open_idx (0460) and A132's app.assign_open_shift (2253).
--     Shifts assigned to an engagement no longer show as open.
--   * api_external.shifts (1000) appends roster_entry_id, holder_name and is_agency_slot. A Staff agency's leads
--     (R4's private.can_manage_roster) read its slots and the shifts of its roster with the holder's name; the person
--     on the roster reads their own shifts; an Account Member nobody assigned reads neither (decision 6).

-- Column ---------------------------------------------------------------------------------------------------------------------

alter table app.shifts add column roster_entry_id uuid references app.engagement_roster_entries (id);
create index shifts_roster_entry_id_idx on app.shifts (roster_entry_id, starts_at);

alter table app.shifts drop constraint shifts_one_worker;
alter table app.shifts add constraint shifts_one_worker check (num_nonnulls(membership_id, engagement_id, roster_entry_id) <= 1);

comment on column app.shifts.roster_entry_id is 'Roster entry (R4) of the agency staff member who works the shift. At most one of membership_id, engagement_id and roster_entry_id; none is an open shift. Written only by app.assign_roster_shift and app.unassign_roster_shift.';
comment on column app.shifts.engagement_id is 'Engagement of the external person assigned, when the shift is worked by someone without a membership, or an agency slot: a Staff company engagement with no person, until the agency assigns one of its roster (R12). At most one of membership_id, engagement_id and roster_entry_id; none is an open shift.';

call private.install_tenant_guards('app.shifts', 'app.projects', 'project_id',
  array['app.records', 'record_id', 'app.scope_nodes', 'scope_node_id', 'app.memberships', 'membership_id', 'app.engagements', 'engagement_id',
        'app.engagement_roster_entries', 'roster_entry_id']);

-- The roster entry's engagement is on the row's project ---------------------------------------------------------------------

create or replace function private.assert_roster_entry_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.roster_entry_id is not null and (
    select e.project_id from app.engagement_roster_entries r join app.engagements e on e.id = r.engagement_id
    where r.id = new.roster_entry_id) is distinct from new.project_id then
    perform private.refuse('same_project',
      format('%s.roster_entry_id points to a roster entry of another project.', private.trigger_table_name(tg_relid)));
  end if;
  return new;
end;
$$;

comment on function private.assert_roster_entry_project() is 'Before insert or update trigger (R12): refuses a roster entry whose engagement is on another project than the row. The refusal names the parent table on a partition.';
revoke all on function private.assert_roster_entry_project() from public, anon, authenticated;

create trigger t39_shift_roster_entry_project before insert or update of roster_entry_id on app.shifts
  for each row execute function private.assert_roster_entry_project();

-- Agency slots ---------------------------------------------------------------------------------------------------------------

create or replace function private.is_agency_slot_engagement(p_engagement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select e.role_type = 'Staff' and e.counterparty_id is not null and e.person_id is null
    from app.engagements e where e.id = p_engagement_id), false);
$$;

comment on function private.is_agency_slot_engagement(uuid) is 'R12: true when an engagement can hold agency slots, a Staff engagement of a company (counterparty set) that names no person. A shift naming it is a slot the agency fills from its roster.';
revoke all on function private.is_agency_slot_engagement(uuid) from public, anon;
-- Function calls inside a view run with the caller's execute privilege, so signed-in users need this.
grant execute on function private.is_agency_slot_engagement(uuid) to authenticated, service_role;

-- Worker guard (latest: 2230, A130) -------------------------------------------------------------------------------------------

create or replace function private.guard_engaged_worker()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_table text;
  v_new_entry uuid := (to_jsonb(new) ->> 'roster_entry_id')::uuid;
  v_old_entry uuid := case when tg_op = 'UPDATE' then (to_jsonb(old) ->> 'roster_entry_id')::uuid end;
begin
  if tg_op = 'UPDATE' and new.engagement_id is not distinct from old.engagement_id and v_new_entry is not distinct from v_old_entry then
    return new;
  end if;
  v_table := private.trigger_table_name(tg_relid);
  if tg_op = 'UPDATE' and v_table <> 'shifts' then
    perform private.refuse(v_table || '_worker_immutable', 'The worker of time never changes.');
  end if;
  if v_table = 'shifts' and v_new_entry is distinct from v_old_entry and not private.in_trusted_operation('roster_shift_assignment') then
    perform private.refuse('roster_shift_rpc', 'Put agency staff on a shift with app.assign_roster_shift.');
  end if;
  if tg_op = 'UPDATE' and auth.uid() is not null and not private.in_trusted_operation('roster_shift_assignment')
     and not private.can_on_project(new.project_id, 'crew.shift.write') then
    raise exception using errcode = '42501', message = 'crew.shift.write is required to reassign a shift';
  end if;
  if new.engagement_id is null then
    return new;
  end if;
  select * into v_engagement from app.engagements e where e.id = new.engagement_id;
  if v_engagement.person_id is null
     and not (v_table = 'shifts' and private.is_agency_slot_engagement(v_engagement.id)) then
    perform private.refuse('engagement_worker_person', 'Time and shifts go to an engagement that names the person who works.');
  end if;
  if v_table <> 'shifts' and v_engagement.engagement_state not in ('Active', 'Closing') then
    perform private.refuse('engagement_not_working', 'External crew record time only while their engagement is Active or Closing.');
  end if;
  return new;
end;
$$;

comment on function private.guard_engaged_worker() is 'Shifts, time entries, timesheets and punches worked through an engagement or a roster entry: the engagement names a person (a shift may name an agency slot, a Staff company engagement with none, R12), new time needs it Active or Closing, the worker of time never changes, only shift writers or the roster assignment RPCs reassign a shift, and roster_entry_id on a shift is written only by app.assign_roster_shift and app.unassign_roster_shift (roster_shift_rpc). Tables are told apart, and the refusal code named, by the parent table on a partition (private.trigger_table_name).';
revoke all on function private.guard_engaged_worker() from public, anon, authenticated;

drop trigger t38_guard_engaged_worker on app.shifts;
create trigger t38_guard_engaged_worker before insert or update of engagement_id, roster_entry_id on app.shifts
  for each row execute function private.guard_engaged_worker();

-- Worker resolution with the roster entry --------------------------------------------------------------------------------------

create or replace function private.worker_person_id(p_membership_id uuid, p_engagement_id uuid, p_roster_entry_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select m.person_id from app.memberships m where m.id = p_membership_id),
                  (select e.person_id from app.engagements e where e.id = p_engagement_id),
                  (select r.person_id from private.roster_people r where r.roster_entry_id = p_roster_entry_id));
$$;

comment on function private.worker_person_id(uuid, uuid, uuid) is 'Person behind a worker reference: the membership''s person, the engagement''s person or the roster entry''s person (private.roster_people, R12). An agency slot names nobody. Takes column values (ADR 0016 crash rule).';
revoke all on function private.worker_person_id(uuid, uuid, uuid) from public, anon, authenticated;

create or replace function private.shift_worker_person_id(p_membership_id uuid, p_engagement_id uuid, p_roster_entry_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select m.person_id from app.memberships m where m.id = p_membership_id),
    (select e.person_id from app.engagements e where e.id = p_engagement_id),
    (select r.person_id from private.roster_people r where r.roster_entry_id = p_roster_entry_id));
$$;

comment on function private.shift_worker_person_id(uuid, uuid, uuid) is 'The person who works a shift (1394, R12): the member it is assigned to, the engaged worker (0940) or the agency staff member on the roster entry. An agency slot resolves to nobody.';
revoke all on function private.shift_worker_person_id(uuid, uuid, uuid) from public, anon, authenticated;

-- Shift notifications (latest: 1394) ----------------------------------------------------------------------------------------------

create or replace function private.notify_shift_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_worker uuid;
  v_kind text;
begin
  if new.deleted_at is not null or new.shift_state not in ('Published', 'Accepted') or new.ends_at <= now() then
    return null;
  end if;
  v_worker := private.shift_worker_person_id(new.membership_id, new.engagement_id, new.roster_entry_id);
  if v_worker is null or v_worker is not distinct from private.current_person_id() then
    return null;
  end if;
  if old.shift_state not in ('Published', 'Accepted')
     or v_worker is distinct from private.shift_worker_person_id(old.membership_id, old.engagement_id, old.roster_entry_id) then
    v_kind := 'shift.assigned';
  elsif new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at then
    v_kind := 'shift.changed';
  else
    return null;
  end if;
  perform private.notify(new.org_id, v_worker, v_kind, 'app.shifts', new.id, new.project_id,
    jsonb_build_object('title', private.shift_notification_title(new.id),
      'startsAt', to_char(new.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'endsAt', to_char(new.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
  return null;
end;
$$;

comment on function private.notify_shift_change() is 'Tells a shift''s worker about it (1394): shift.assigned when a shift is published with them or a published or accepted shift becomes theirs (a reassignment, an approved swap, an approved claim or an agency placing its roster staff, R12), shift.changed when a published or accepted shift''s times move. Arguments: title, startsAt and endsAt as ISO instants, so a change to a shift starting within 12 hours bypasses quiet hours. Draft, canceled, deleted and finished shifts tell nobody, nor does a person''s own act, such as claiming an open shift first-come. An agency slot tells nobody until it is assigned.';
revoke all on function private.notify_shift_change() from public, anon, authenticated;

-- Sync scopes (latest: 0942) ---------------------------------------------------------------------------------------------------------

create or replace function private.sync_scope_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb[] := array_remove(array[case when tg_op <> 'INSERT' then to_jsonb(old) end, case when tg_op <> 'DELETE' then to_jsonb(new) end], null);
  v_row jsonb;
  v_people uuid[] := '{}';
  v_engagement uuid;
begin
  foreach v_row in array v_rows loop
    if tg_argv[0] = 'person' then
      v_people := v_people || (v_row ->> 'person_id')::uuid;
    elsif tg_argv[0] = 'membership' then
      v_people := v_people || array(select m.person_id from app.memberships m where m.id = (v_row ->> 'membership_id')::uuid);
    elsif tg_argv[0] = 'shift' then
      v_people := v_people || private.worker_person_id((v_row ->> 'membership_id')::uuid, (v_row ->> 'engagement_id')::uuid,
        (v_row ->> 'roster_entry_id')::uuid);
    elsif tg_argv[0] = 'org' then
      v_people := v_people || array(select m.person_id from app.memberships m where m.org_id = (v_row ->> 'org_id')::uuid and m.deleted_at is null);
    elsif tg_argv[0] = 'engagement' then
      v_engagement := coalesce((v_row ->> 'engagement_id')::uuid, (v_row ->> 'id')::uuid);
      v_people := v_people
        || array(select e.person_id from app.engagements e where e.id = v_engagement and e.person_id is not null)
        || array(select m.person_id from app.memberships m join app.counterparties c on c.organization_id = m.org_id
                 join app.engagements e on e.counterparty_id = c.id where e.id = v_engagement and m.deleted_at is null)
        || array(select p.id from app.people p join private.sync_scope_grants g on g.person_user_id = p.user_id
                 where g.scope_key = 'engagementIds' and g.scope_value = v_engagement::text);
    end if;
  end loop;
  perform private.refresh_sync_scopes_of_people(array_remove(v_people, null));
  return null;
end;
$$;

comment on function private.sync_scope_trigger() is 'After a change to a table that decides a person''s reach, refreshes the sync scopes of the people it affects. Argument: membership, person, shift (the member, engaged person or roster person on it, R12), org (every member of the row''s org, for a new or removed project) or engagement.';
revoke all on function private.sync_scope_trigger() from public, anon, authenticated;

drop trigger t96_sync_scopes on app.shifts;
create trigger t96_sync_scopes after insert or update of membership_id, engagement_id, roster_entry_id, deleted_at or delete on app.shifts
  for each row execute function private.sync_scope_trigger('shift');

-- Open shifts need every worker column NULL --------------------------------------------------------------------------------------------

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

comment on function private.assert_claimable(app.shifts, uuid) is 'Refuses a claim on a shift someone holds through any worker column (a membership, an engagement or agency slot, or a roster entry, R12), a shift that is not Published, or one overlapping another shift the person holds through any of them.';
revoke all on function private.assert_claimable(app.shifts, uuid) from public, anon, authenticated;

alter policy shifts_read on app.shifts using (
  (project_id in (select private.project_ids_with('crew.shift.read')))
  or (membership_id in (select private.my_membership_ids()))
  or (engagement_id in (select private.my_engagement_ids('operational')))
  or (roster_entry_id in (select private.my_roster_entry_ids('operational')))
  or (membership_id is null and engagement_id is null and roster_entry_id is null and shift_state = 'Published' and deleted_at is null
      and private.capability_reach(org_id, 'crew.shift.read') is not null)
);
comment on policy shifts_read on app.shifts is 'Shifts of projects where the person may read shifts, their own shifts, engaged shifts and roster shifts (R12), and published open shifts, with every worker column NULL, for every member who may read shifts at any reach, so crew can claim them (0462, folded in by 1221).';

drop index app.shifts_open_idx;
create index shifts_open_idx on app.shifts (org_id, starts_at)
  where membership_id is null and engagement_id is null and roster_entry_id is null and deleted_at is null;

-- The schedule's drag board (latest: 2253, A132) -----------------------------------------------------------------------------------------

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

comment on function app.assign_open_shift(uuid, uuid) is 'Puts an active member of the org on an open shift from the schedule''s drag board (A132, ADR 0063), with crew.shift.write on the project. Refused while someone holds the shift through any worker column, an agency slot included (shift_already_filled, R12), or members wait on a claim for it (shift_claims_waiting, the 1322 approval and seniority rules), so a waiting claim is always decided on the shift. Returns the shift id.';

revoke all on function app.assign_open_shift(uuid, uuid) from public, anon;
grant execute on function app.assign_open_shift(uuid, uuid) to authenticated, service_role;

-- api_external.shifts (latest: 1000) -------------------------------------------------------------------------------------------------------

create or replace function private.roster_entry_lead(p_roster_entry_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_roster_entry_id is not null and coalesce((select private.can_manage_roster(r.engagement_id)
    from app.engagement_roster_entries r where r.id = p_roster_entry_id and r.deleted_at is null), false);
$$;

comment on function private.roster_entry_lead(uuid) is 'R12: true when the signed-in person manages the roster a roster entry is on (R4''s private.can_manage_roster of its engagement): the agency lead who places the entry''s person on shifts.';
revoke all on function private.roster_entry_lead(uuid) from public, anon;
-- Function calls inside a view run with the caller's execute privilege, so signed-in users need this.
grant execute on function private.roster_entry_lead(uuid) to authenticated, service_role;

create or replace view api_external.shifts as
select s.id, s.engagement_id, s.project_id, p.name as project_name, s.scope_node_id, n.name as scope_node_name,
  s.role_code, r.job_title, s.starts_at, s.ends_at, s.time_zone, s.shift_state,
  s.roster_entry_id,
  case when s.roster_entry_id is not null
        and (s.roster_entry_id in (select private.my_roster_entry_ids('operational')) or private.roster_entry_lead(s.roster_entry_id))
    then (select h.full_name from private.roster_people rp join app.people h on h.id = rp.person_id where rp.roster_entry_id = s.roster_entry_id)
  end as holder_name,
  private.is_agency_slot_engagement(s.engagement_id) as is_agency_slot
from app.shifts s
join app.projects p on p.id = s.project_id
left join app.scope_nodes n on n.id = s.scope_node_id
left join xpms.role r on r.role_code = s.role_code
where s.deleted_at is null and s.shift_state in ('Published', 'Accepted', 'Canceled')
  and ((s.engagement_id in (select private.my_engagement_ids('operational')) and not private.is_agency_slot_engagement(s.engagement_id))
    or (s.engagement_id is not null and private.is_agency_slot_engagement(s.engagement_id) and private.can_manage_roster(s.engagement_id))
    or s.roster_entry_id in (select private.my_roster_entry_ids('operational'))
    or private.roster_entry_lead(s.roster_entry_id));

comment on view api_external.shifts is 'Shifts assigned to the caller''s engagements, once published (Section 4.4.4 Crew and Staff: shifts and call times), while the operational area is open. A staffing agency''s leads also read its agency slots and the shifts of its roster staff with the holder''s name; a person on the roster reads their own (R12). Drafts never appear.';
comment on column api_external.shifts.roster_entry_id is 'Roster entry of the agency staff member who works the shift (R12); NULL otherwise.';
comment on column api_external.shifts.holder_name is 'Name of the agency staff member on the shift, for that person and the agency''s leads; NULL otherwise.';
comment on column api_external.shifts.is_agency_slot is 'True for an agency slot: a shift the production allocated to the staffing agency that no one on its roster holds yet.';
