-- 1092_zones_on_project_access_grid.sql
-- A39 Compass device QA. A gate scanner without places.venue.read (a Field member) saw no access point in
-- Compass: zones_read exposes only the zones of each readable project's own venue (projects.venue_id), but
-- a project's access grid names zones at every venue it uses (the demo festival grounds, pier and park).
-- So the Scan screen's access point picker was empty and no badge could be checked at the gate.
-- zones_read now also admits a zone that the access grid of a project the person can read names.
--   * private.zone_on_readable_access_grid(zone_id): true when a live access grid row of a readable
--     project names the zone. It takes the zone id as an argument and reads app.access_grid only, never
--     app.zones (ADR 0016 item 14, the Postgres 17 crash rule)

create or replace function private.zone_on_readable_access_grid(p_zone_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.access_grid g
    where g.zone_id = p_zone_id
      and g.deleted_at is null
      and g.project_id in (select private.readable_project_ids())
  );
$$;

comment on function private.zone_on_readable_access_grid(uuid) is 'True when the access grid of a project the session person can read names the zone (zones_read, A39). Takes the zone id as an argument and reads app.access_grid only (ADR 0016 item 14).';
revoke all on function private.zone_on_readable_access_grid(uuid) from public, anon;
grant execute on function private.zone_on_readable_access_grid(uuid) to authenticated, service_role;

drop policy zones_read on app.zones;
create policy zones_read on app.zones for select to authenticated using (
  venue_id in (
    select v.id from app.venues v
    where v.org_id in (select private.orgs_with_capability('places.venue.read'))
       or v.id in (select p.venue_id from app.projects p where p.id in (select private.readable_project_ids()))
  )
  or private.zone_on_readable_access_grid(id)
);
