-- 0422_geofence_writes_zone_space.sql
-- A09 Places:
--   * app.save_geofence: creates or edits a geofence from a GeoJSON Polygon (RFC 7946), the exchange
--     format app.geofence_shapes (0366) reads back, so the API and Compass write and read one shape
--   * a zone that sits in a space sits in a space of its own venue (a zone of venue A inside a space of
--     venue B was accepted before this guard)

create or replace function app.save_geofence(
  p_id uuid,
  p_venue_id uuid,
  p_zone_id uuid,
  p_name text,
  p_boundary_geojson jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_boundary extensions.geography;
  v_id uuid;
  v_org uuid := case when p_id is null then (select v.org_id from app.venues v where v.id = p_venue_id and v.deleted_at is null)
                     else (select g.org_id from app.geofences g where g.id = p_id and g.deleted_at is null) end;
begin
  perform private.require_person();
  if v_org is null or v_org not in (select private.orgs_with_capability('places.space.write')) then
    raise exception using errcode = '42501', message = 'places.space.write is required on the venue';
  end if;
  if p_boundary_geojson is null or p_boundary_geojson ->> 'type' is distinct from 'Polygon' then
    perform private.refuse('geofence_polygon', 'A geofence boundary is a GeoJSON Polygon in WGS 84.');
  end if;
  begin
    v_boundary := extensions.st_setsrid(extensions.st_geomfromgeojson(p_boundary_geojson::text), 4326)::extensions.geography;
  exception when others then
    perform private.refuse('geofence_polygon', 'A geofence boundary is a GeoJSON Polygon in WGS 84.');
  end;
  if p_id is null then
    insert into app.geofences (org_id, venue_id, zone_id, name, boundary)
    values ((select v.org_id from app.venues v where v.id = p_venue_id), p_venue_id, p_zone_id, btrim(p_name), v_boundary)
    returning id into v_id;
  else
    update app.geofences set zone_id = p_zone_id, name = btrim(p_name), boundary = v_boundary
    where id = p_id and deleted_at is null
    returning id into v_id;
  end if;
  return v_id;
end;
$$;
comment on function app.save_geofence(uuid, uuid, uuid, text, jsonb) is 'Creates (p_id NULL) or edits a geofence from a GeoJSON Polygon in WGS 84. Needs places.space.write in the venue''s org; a boundary that is not a polygon is refused with geofence_polygon.';
revoke all on function app.save_geofence(uuid, uuid, uuid, text, jsonb) from public, anon;
grant execute on function app.save_geofence(uuid, uuid, uuid, text, jsonb) to authenticated, service_role;

create or replace function private.guard_zone_space()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.space_id is not null and not exists (
    select 1 from app.spaces s where s.id = new.space_id and s.venue_id = new.venue_id) then
    perform private.refuse('zone_space_venue', 'A zone sits in a space of its own venue.');
  end if;
  return new;
end;
$$;
comment on function private.guard_zone_space() is 'Zones: the space a zone sits in belongs to the zone''s venue.';
revoke all on function private.guard_zone_space() from public, anon, authenticated;
create trigger t40_guard_zone_space before insert or update on app.zones
  for each row execute function private.guard_zone_space();
