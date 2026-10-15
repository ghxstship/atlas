-- 0366_geofence_shapes.sql
-- A03 Domain Data (requested by A17 Compass). Geofence outlines as GeoJSON, so Compass draws them on its
-- map and checks punches on the device before the server confirms them. The view runs as the caller
-- (security_invoker), so it is exactly as visible as app.geofences.

create view app.geofence_shapes with (security_invoker = true) as
select g.id, g.venue_id, g.zone_id, g.name, extensions.st_asgeojson(g.boundary)::jsonb as boundary_geojson
from app.geofences g
where g.deleted_at is null;

call private.describe('app.geofence_shapes', 'Geofence outlines as GeoJSON for maps and on-device checks (Section 13). Visible under the same policy as app.geofences; the server still decides geofence_verified on every punch.', array[
  'id', 'Geofence.',
  'venue_id', 'Venue.',
  'zone_id', 'Zone the geofence outlines, when it outlines one.',
  'name', 'Geofence name.',
  'boundary_geojson', 'Boundary as a GeoJSON Polygon in WGS 84 (RFC 7946), the documented JSON exception for a geometry exchange format.'
]);

revoke all on app.geofence_shapes from public, anon;
grant select on app.geofence_shapes to authenticated, service_role;
