-- 3000_b11_delivery_booking.sql
-- B11 (RRR-235, G-115): one delivery window on the demo project's dedicated Gate C, with one booking the desk made, so
-- the Compass gate view has something to find. The Maestro flow field-gate-view looks it up by its plate; the reference
-- code is issued at random, as it is for any booking. The date is outside the demo's load-in week, so no dock
-- schedule baseline shows it. Idempotent.
do $$
declare
  c_owner constant uuid := '01920000-0000-7000-8000-000000000101';
  c_project constant uuid := '01920000-0000-7000-8000-000000001001';
  c_zone constant uuid := '01920000-0000-7000-8000-000000300001';
  c_window constant uuid := '01920000-0000-7000-8000-000000300002';
  c_slot constant uuid := '01920000-0000-7000-8000-000000300003';
  v_venue uuid;
begin
  select p.venue_id into v_venue from app.projects p where p.id = c_project;
  if v_venue is null or exists (select 1 from app.delivery_windows where id = c_window) then
    return;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);
  insert into app.zones (id, venue_id, code, name) values (c_zone, v_venue, 'GATE-C', 'Gate C');
  insert into app.delivery_windows (id, project_id, zone_id, starts_at, ends_at, vehicle_limit)
  values (c_window, c_project, c_zone, '2027-04-20 13:00+00', '2027-04-20 15:00+00', 5);
  perform app.book_delivery_window(c_slot, c_window, null, 'FL GATE-42', null);
end $$;
