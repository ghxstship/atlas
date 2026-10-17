-- 1090_geofence_shapes_org.sql
-- A39 Compass device QA. app.geofence_shapes (0366) carries the geofence's org, as app.geofences does.
-- Compass pulls the shapes over REST when PowerSync is not configured, and the device-side scope check
-- (packages/sync TABLE_RULES) keeps a geofence only when its org_id is one of the person's orgs. The view
-- had no org_id, so every downloaded shape was refused and Today read "This project has no geofence"
-- on a site that has one. The PowerSync bucket query already selects org_id from app.geofences.
-- The new column goes last, so `create or replace view` keeps every existing column and grant.

create or replace view app.geofence_shapes with (security_invoker = true) as
select g.id, g.venue_id, g.zone_id, g.name, extensions.st_asgeojson(g.boundary)::jsonb as boundary_geojson, g.org_id
from app.geofences g
where g.deleted_at is null;

call private.describe('app.geofence_shapes', 'Geofence outlines as GeoJSON for maps and on-device checks (Section 13). Visible under the same policy as app.geofences; the server still decides geofence_verified on every punch.', array[
  'id', 'Geofence.',
  'venue_id', 'Venue.',
  'zone_id', 'Zone the geofence outlines, when it outlines one.',
  'name', 'Geofence name.',
  'boundary_geojson', 'Boundary as a GeoJSON Polygon in WGS 84 (RFC 7946), the documented JSON exception for a geometry exchange format.',
  'org_id', 'Organization that owns the geofence, so a device keeps only its own orgs'' outlines.'
]);
