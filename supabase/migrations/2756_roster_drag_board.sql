-- 2756_roster_drag_board.sql
-- R12 Agency staff on shifts (RRR-190), A132's drag board takes agency staff.
--
--   * app.rank_roster_candidates ranks, for one shift, the accepted people of the agencies' rosters on its project the
--     way app.rank_shift_candidates (2251) ranks members: free of an overlapping shift first, then by the availability
--     they share with the org (a calendar kept for the org, or a Public one; otherwise not stated), then those who
--     worked the role, then the fewest hours that week. It also counts the training still due, which
--     app.assign_roster_shift refuses on. Their availability is read here because planners' row level security reads
--     only members' calendars (2251), and agency staff hold no membership.
--   * app.assign_open_shift_to_roster puts one of them on an open shift from the board: the shift becomes their
--     agency's slot and app.assign_roster_shift places them, in one transaction, so a refusal leaves the shift open.
--     Like app.assign_open_shift, it lands only while the shift is still open (shift_already_filled) and no claim
--     waits on it (shift_claims_waiting).

create or replace function app.rank_roster_candidates(p_shift_id uuid, p_week_start date default null)
returns table (
  roster_entry_id uuid,
  engagement_id uuid,
  person_id uuid,
  full_name text,
  account_name text,
  availability text,
  conflict boolean,
  worked_role boolean,
  training_due integer,
  week_minutes integer,
  candidate_rank integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shift app.shifts;
  v_held_engagement uuid;
  v_week_start timestamptz;
begin
  perform private.require_person();
  select * into v_shift from app.shifts s where s.id = p_shift_id and s.deleted_at is null;
  if v_shift.id is null or not private.can_on_project(v_shift.project_id, 'crew.shift.write') then
    raise exception using errcode = '42501', message = 'crew.shift.write is required on the shift''s project';
  end if;
  -- A shift held through a roster takes only another person of the same agency (roster_entry_other_engagement).
  select r.engagement_id into v_held_engagement from app.engagement_roster_entries r where r.id = v_shift.roster_entry_id;
  v_week_start := coalesce(p_week_start, date_trunc('week', v_shift.starts_at at time zone v_shift.time_zone)::date)::timestamp
    at time zone v_shift.time_zone;
  return query
  with entries as (
    select r.id as roster_entry_id, r.engagement_id, rp.person_id, p.full_name, o.name as account_name
    from app.engagement_roster_entries r
    join app.engagements e on e.id = r.engagement_id and e.deleted_at is null
    join private.roster_people rp on rp.roster_entry_id = r.id
    join app.people p on p.id = rp.person_id and p.deleted_at is null
    join app.counterparties c on c.id = e.counterparty_id
    left join app.organizations o on o.id = c.organization_id
    where e.project_id = v_shift.project_id and e.role_type = 'Staff' and e.person_id is null
      and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
      and r.deleted_at is null and not r.is_self and r.entry_state = 'Accepted' and r.person_response = 'Accepted'
      and r.id is distinct from v_shift.roster_entry_id
      and (v_held_engagement is null or r.engagement_id = v_held_engagement)
      and (v_shift.engagement_id is null or not private.is_agency_slot_engagement(v_shift.engagement_id)
           or r.engagement_id = v_shift.engagement_id)
  ), blocks as (
    select c.person_id, b.availability_kind, b.starts_at, b.ends_at
    from app.availability_blocks b
    join app.availability_calendars c on c.id = b.availability_calendar_id and c.deleted_at is null
    where b.deleted_at is null and b.starts_at < v_shift.ends_at and b.ends_at > v_shift.starts_at
      and (c.org_id = v_shift.org_id or (c.org_id is null and c.visibility = 'Public'))
      and c.person_id in (select en.person_id from entries en)
  ), held as (
    -- The live shifts of the org each candidate works, through any worker column.
    select o.id, o.role_code, o.starts_at, o.ends_at, en.person_id
    from entries en
    join app.shifts o on o.org_id = v_shift.org_id and o.deleted_at is null and o.shift_state <> 'Canceled' and o.id <> v_shift.id
      and (o.roster_entry_id in (select x.roster_entry_id from private.roster_people x where x.person_id = en.person_id)
           or o.membership_id in (select m.id from app.memberships m where m.person_id = en.person_id and m.org_id = v_shift.org_id)
           or o.engagement_id in (select g.id from app.engagements g where g.person_id = en.person_id))
  ), scored as (
    select en.roster_entry_id, en.engagement_id, en.person_id, en.full_name, en.account_name,
      case
        when exists (select 1 from blocks b where b.person_id = en.person_id and b.availability_kind = 'Unavailable') then 'Unavailable'
        when exists (select 1 from blocks b where b.person_id = en.person_id and b.availability_kind = 'Available'
                     and b.starts_at <= v_shift.starts_at and b.ends_at >= v_shift.ends_at) then 'Available'
        when exists (select 1 from blocks b where b.person_id = en.person_id) then 'Tentative'
        else 'Unstated'
      end as availability,
      exists (select 1 from held h where h.person_id = en.person_id
              and h.starts_at < v_shift.ends_at and h.ends_at > v_shift.starts_at) as conflict,
      v_shift.role_code is not null and exists (
        select 1 from held h where h.person_id = en.person_id and h.role_code = v_shift.role_code) as worked_role,
      (select count(*)::integer from private.roster_training_due(en.roster_entry_id)) as training_due,
      coalesce((select sum(extract(epoch from (h.ends_at - h.starts_at)) / 60)::integer from held h
                where h.person_id = en.person_id
                  and h.starts_at >= v_week_start and h.starts_at < v_week_start + interval '7 days'), 0) as week_minutes
    from entries en
  )
  select s.roster_entry_id, s.engagement_id, s.person_id, s.full_name, s.account_name, s.availability, s.conflict,
    s.worked_role, s.training_due, s.week_minutes,
    (row_number() over (order by s.conflict, s.training_due > 0,
      array_position(array['Available', 'Tentative', 'Unstated', 'Unavailable'], s.availability),
      s.worked_role desc, s.week_minutes, s.full_name nulls last, s.roster_entry_id))::integer
  from scored s
  order by 11;
end;
$$;

comment on function app.rank_roster_candidates(uuid, date) is 'The accepted people of the agencies'' rosters on a shift''s project ranked for it (R12, beside A132''s app.rank_shift_candidates), for the schedule''s drag list: free of an overlapping live shift first, then those with no training due, then by the availability they share with the org over the shift (Available covering it, Tentative or partly stated, not stated, Unavailable) from a calendar kept for the org or a Public one, then those who worked the role, then the fewest scheduled minutes in the week (from p_week_start, or the ISO week of the shift in its zone). A slot or a roster-held shift ranks only its own agency''s people. Needs crew.shift.write on the shift''s project; notes never appear.';
revoke all on function app.rank_roster_candidates(uuid, date) from public, anon;
grant execute on function app.rank_roster_candidates(uuid, date) to authenticated, service_role;

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

comment on function app.assign_open_shift_to_roster(uuid, uuid) is 'Puts an accepted person of an agency''s roster on an open shift from the schedule''s drag board (R12 with A132), with crew.shift.write on the project: the shift becomes the agency''s slot and app.assign_roster_shift places the person, in one transaction, so any of its refusals leaves the shift open. Refused while someone holds the shift (shift_already_filled) or members wait on a claim for it (shift_claims_waiting), and for an entry outside a Staff company engagement (roster_shift_not_agency_slot). Returns the shift id.';
revoke all on function app.assign_open_shift_to_roster(uuid, uuid) from public, anon;
grant execute on function app.assign_open_shift_to_roster(uuid, uuid) to authenticated, service_role;
