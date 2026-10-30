-- 2790_start_tbc.sql
-- P2 Run of show and show calling (RRR-216, ADR 0131 decision 1; gap G-40). A start time can be an estimate that is still
-- to be confirmed: the time stays, so records and cues still sort and schedule by it, and a flag beside it says TBC.
--
--   * app.records.start_tbc and app.cues.start_tbc, false by default.
--   * private.normalize_start_tbc: a TBC needs an estimate. A writer that clears the start (the v1 API, an older client)
--     also clears the flag, so no check fails and no TBC is left without a time.
--   * api_external.cues (from 1020) and api_external.records (from 0750) append start_tbc, so Gateway shows TBC to a
--     Client or an artist. The views are redefined verbatim otherwise; their grants survive create or replace.
--   * api_external.engagement_up_next (from 2612) appends next_call_tbc: a set whose cue is TBC is not a firm call on
--     Gateway Home.
-- No column here names a row, so no table becomes eligible for Trash (ADR 0110).

alter table app.records add column start_tbc boolean not null default false;
alter table app.cues add column start_tbc boolean not null default false;

comment on column app.records.start_tbc is 'True while the start time is an estimate to be confirmed: shown as TBC, still sorted and scheduled by the estimate.';
comment on column app.cues.start_tbc is 'True while the start time is an estimate to be confirmed: shown as TBC, still sorted and scheduled by the estimate.';

create or replace function private.normalize_start_tbc()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if to_jsonb(new) ->> tg_argv[0] is null then
    new.start_tbc := false;
  end if;
  return new;
end;
$$;

comment on function private.normalize_start_tbc() is 'Before insert or update trigger: a start time to be confirmed needs an estimate, so a row whose start column (the trigger argument) is NULL is never TBC. Writers that clear the start, the v1 API among them, clear the flag with it.';
revoke all on function private.normalize_start_tbc() from public, anon, authenticated;

create trigger t17_normalize_start_tbc before insert or update of start_tbc, starts_at on app.records
  for each row execute function private.normalize_start_tbc('starts_at');
create trigger t17_normalize_start_tbc before insert or update of start_tbc, planned_at on app.cues
  for each row execute function private.normalize_start_tbc('planned_at');

-- External views append start_tbc ---------------------------------------------------------------------------------------

create or replace view api_external.cues as
select c.id, c.run_of_show_id, c.position, c.label, c.planned_at, c.duration, c.called_at,
  (c.id in (select private.my_set_cue_ids())) as is_my_set,
  r.project_id,
  c.start_tbc
from app.cues c
join app.run_of_show r on r.id = c.run_of_show_id and r.deleted_at is null
where c.deleted_at is null
  and (private.engaged_as(r.project_id, 'Client') or c.id in (select private.my_set_cue_ids()));

comment on column api_external.cues.start_tbc is 'True while the planned time is an estimate to be confirmed: show TBC, not the time.';

create or replace view api_external.records as
select r.id, r.project_id, r.record_kind, r.record_subtype, r.record_state, r.title, r.starts_at, r.ends_at, r.due_at, r.time_zone,
  r.start_tbc
from app.records r
where r.deleted_at is null and private.is_engaged_party(r.project_id)
  and exists (
    select 1 from app.record_external_visibility v
    where v.record_id = r.id and v.deleted_at is null
      and (v.external_role_type in (select private.engaged_role_types(r.project_id))
        or v.person_id = private.current_person_id()
        or v.organization_id in (select private.engaged_organization_ids(r.project_id))));

comment on column api_external.records.start_tbc is 'True while the start is an estimate to be confirmed: show TBC, not the time.';

create or replace view api_external.engagement_up_next as
select e.id as engagement_id, e.project_id,
  v.name as venue_name, v.street_address as venue_street_address, v.locality as venue_locality, v.postal_code as venue_postal_code,
  case when exists (
    select 1 from app.memberships m
    where m.person_id = e.created_by and m.org_id = e.org_id and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()))
  then cp.full_name end as contact_name,
  n.starts_at as next_call_at, n.time_zone as next_call_time_zone, n.call_kind as next_call_kind,
  n.start_tbc as next_call_tbc
from app.engagements e
join app.projects p on p.id = e.project_id
left join app.venues v on v.id = p.venue_id and v.deleted_at is null
left join app.people cp on cp.id = e.created_by
cross join lateral (select array(select s from private.engagement_scope(e.id) s) as areas) a
left join lateral (
  select x.starts_at, x.time_zone, x.call_kind, x.start_tbc
  from (
    select s.starts_at, s.time_zone, 'Shift'::text as call_kind, false as start_tbc
    from app.shifts s
    where s.engagement_id = e.id and s.deleted_at is null and s.shift_state in ('Published', 'Accepted') and s.starts_at > now()
    union all
    select d.starts_at, p.time_zone, 'Dock Slot'::text, false
    from app.dock_slots d
    where d.engagement_id = e.id and d.deleted_at is null and d.checked_in_at is null and d.starts_at > now()
    union all
    select c.planned_at, p.time_zone, 'Set'::text, c.start_tbc
    from app.engagement_cues ec
    join app.cues c on c.id = ec.cue_id and c.deleted_at is null
    join app.run_of_show r on r.id = c.run_of_show_id and r.deleted_at is null
    where ec.engagement_id = e.id and ec.deleted_at is null and c.planned_at > now() and c.called_at is null
  ) x
  where 'operational' = any (a.areas)
  order by x.starts_at
  limit 1
) n on true
where e.deleted_at is null and e.id in (select private.my_engagement_ids('engagement'));

comment on column api_external.engagement_up_next.next_call_tbc is 'True when the next call is a set whose time is an estimate to be confirmed: show TBC, not the time. False for shifts and dock slots, and NULL when there is no next call.';

revoke all on api_external.engagement_up_next from public, anon;
grant select on api_external.engagement_up_next to authenticated, service_role;
