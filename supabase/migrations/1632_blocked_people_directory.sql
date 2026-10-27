-- 1632_blocked_people_directory.sql
-- ADR 0033 decision 57 (2026-10-23, RRR-137): the workforce directory honours person blocks, as A52's profile reads do
-- (1206). Compass and Atlas show a member's preferred name and headline there, text the member writes about
-- themselves, and 1206 enforced blocks only in the api_public profile RPCs. app.workforce_directory (from 1010, its only
-- definition) still lists every member by name, roles and work phone, because a block ends no work (Section 4.4.4),
-- but leaves out the preferred name, headline and photo when a block stands between the member and the signed-in
-- person (private.blocked_between, 1206): the blocked person's from the blocker, and the blocker's from the blocked
-- person, as profiles are hidden both ways. A search no longer matches on what it leaves out.

create or replace function app.workforce_directory(p_org_id uuid, p_search text default null, p_on_site_only boolean default false)
returns table (
  membership_id uuid,
  person_id uuid,
  full_name text,
  preferred_name text,
  headline text,
  photo_path text,
  role_names text[],
  on_site_now boolean,
  on_site_project_id uuid,
  on_site_since timestamptz,
  work_phone text,
  recognition_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid;
begin
  perform private.require_membership_in(p_org_id);
  v_me := private.current_person_id();
  return query
    with members as (
      select m.id, m.person_id from app.memberships m
      where m.org_id = p_org_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    ),
    on_site as (
      select distinct on (te.membership_id) te.membership_id, te.project_id, te.clock_in
      from app.time_entries te
      join members mm on mm.id = te.membership_id
      where te.clock_out is null and te.deleted_at is null and te.clock_in >= now() - interval '24 hours'
        and exists (select 1 from app.clock_punches cp where cp.time_entry_id = te.id and cp.punch_kind = 'In'
                    and cp.geofence_verified and cp.deleted_at is null)
      order by te.membership_id, te.clock_in desc
    ),
    -- The profile basics a member shares with their network, unless a block stands between them and the viewer.
    shared as (
      select pp.person_id, pp.preferred_name, pp.headline, pp.photo_path
      from app.person_profiles pp
      where pp.person_id in (select mm.person_id from members mm)
        and pp.deleted_at is null and pp.visibility in ('Network', 'Public')
        and not private.blocked_between(v_me, pp.person_id)
    )
    select mm.id, mm.person_id, coalesce(pe.full_name, ''),
      sp.preferred_name,
      sp.headline,
      sp.photo_path,
      coalesce((select array_agg(coalesce(r.name, r.code) order by r.band) from app.membership_roles mr join app.roles r on r.id = mr.role_id
                where mr.membership_id = mm.id and mr.deleted_at is null), '{}'),
      os.membership_id is not null, os.project_id, os.clock_in,
      (select psv.value_text from app.personal_setting_values psv where psv.person_id = mm.person_id and psv.setting_key = 'workforce.work_phone'
         and psv.deleted_at is null and (psv.org_id is null or psv.org_id = p_org_id) order by psv.org_id nulls last limit 1),
      app.recognition_count(p_org_id, mm.person_id)
    from members mm
    join app.people pe on pe.id = mm.person_id and pe.deleted_at is null
    left join shared sp on sp.person_id = mm.person_id
    left join on_site os on os.membership_id = mm.id
    where (coalesce(btrim(p_search), '') = '' or pe.full_name ilike '%' || btrim(p_search) || '%'
           or sp.preferred_name ilike '%' || btrim(p_search) || '%' or sp.headline ilike '%' || btrim(p_search) || '%')
      and (not coalesce(p_on_site_only, false) or os.membership_id is not null)
    order by os.membership_id is null, pe.full_name;
end;
$$;

comment on function app.workforce_directory(uuid, text, boolean) is 'The searchable people directory of an org for its members (Section 4.9 Directory): name, profile basics the person shares with their network (left out when a block stands between them and the viewer, either way, 1632), roles, whether they are on site now (open time entry clocked in inside a geofence within 24 hours), the work phone they chose to share and their recognition count when consented. On-site members first.';
revoke all on function app.workforce_directory(uuid, text, boolean) from public, anon;
grant execute on function app.workforce_directory(uuid, text, boolean) to authenticated, service_role;
