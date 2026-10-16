-- 0217_compass.sql
-- A17 Compass (Section 19.6: the demo tenant exercises the feature). On the demo project (NWS, Northwind
-- Summer Series), the field data Compass works from:
--   * the Northwind Pier venue with three zones and a geofence around the site, so clock-in shows
--     "You're at Northwind Pier Site"
--   * today's shift for the Demo Field Lead, published and accepted, so Today leads with Clock In
--   * a CREW credential category, an access grid for the Main Gate and Backstage open today, and badges for
--     the Demo Field Lead and the external crew person, so gate scans grant and deny
--   * a radio plan and two published SOPs for Reference
--   * a Stage Safety Walk inspection template with four items, one critical
--   * one asset class and two tagged units with a GTIN identifier and a custody hand-over
-- Writes run as the Demo Owner through the same tables and RPCs the app uses. Guarded on the demo project
-- (A07's 0107) and idempotent: nothing runs once the Compass venue exists. Fixed ids use the 0217 block.

do $$
declare
  c_org constant uuid := '01920000-0000-7000-8000-000000000001';
  c_project constant uuid := '01920000-0000-7000-8000-000000001001';
  c_owner constant uuid := '01920000-0000-7000-8000-000000000101';
  c_field constant uuid := '01920000-0000-7000-8000-000000000104';
  c_field_membership constant uuid := '01920000-0000-7000-8000-00000000a104';
  c_crew constant uuid := '01920000-0000-7000-8000-000000000201';
  c_venue constant uuid := '01920000-0000-7000-8000-000000217001';
  c_zone_gate constant uuid := '01920000-0000-7000-8000-000000217011';
  c_zone_backstage constant uuid := '01920000-0000-7000-8000-000000217012';
  c_zone_stage constant uuid := '01920000-0000-7000-8000-000000217013';
  c_geofence constant uuid := '01920000-0000-7000-8000-000000217021';
  c_shift constant uuid := '01920000-0000-7000-8000-000000217031';
  c_category constant uuid := '01920000-0000-7000-8000-000000217041';
  c_template constant uuid := '01920000-0000-7000-8000-000000217051';
  c_asset_class constant uuid := '01920000-0000-7000-8000-000000217061';
  c_unit_a constant uuid := '01920000-0000-7000-8000-000000217062';
  c_unit_b constant uuid := '01920000-0000-7000-8000-000000217063';
  v_jurisdiction text;
  v_element text;
  v_full_access text;
  v_day_start timestamptz := date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York';
begin
  if not exists (select 1 from app.projects where id = c_project)
     or not exists (select 1 from app.memberships where id = c_field_membership)
     or exists (select 1 from app.venues where id = c_venue) then
    return;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);
  select p.jurisdiction_id into v_jurisdiction from app.projects p where p.id = c_project;
  select e.record_id into v_full_access from xpms.std_enumeration e where e.enum_domain = 'Access Level' order by e.sort_order limit 1;

  -- Venue, zones and the site geofence ---------------------------------------------------------------------
  insert into app.venues (id, org_id, name, jurisdiction_id, time_zone, street_address, locality)
  values (c_venue, c_org, 'Northwind Pier', v_jurisdiction, 'America/New_York', '1 Harbor Walk', 'Miami');
  insert into app.zones (id, org_id, venue_id, code, name) values
    (c_zone_gate, c_org, c_venue, 'GATE-A', 'Main Gate'),
    (c_zone_backstage, c_org, c_venue, 'BACK', 'Backstage'),
    (c_zone_stage, c_org, c_venue, 'STAGE', 'Main Stage');
  insert into app.geofences (id, org_id, venue_id, name, boundary)
  values (c_geofence, c_org, c_venue, 'Northwind Pier Site',
    extensions.st_geogfromtext('SRID=4326;POLYGON((-80.1880 25.7780, -80.1840 25.7780, -80.1840 25.7810, -80.1880 25.7810, -80.1880 25.7780))'));

  -- Today's shift for the Demo Field Lead: published, then accepted as the field lead -------------------------
  insert into app.shifts (id, org_id, project_id, membership_id, role_code, starts_at, ends_at, time_zone)
  select c_shift, c_org, c_project, c_field_membership, r.role_code, v_day_start + interval '6 hours', v_day_start + interval '22 hours', 'America/New_York'
  from xpms.role r order by r.role_code limit 1;
  perform app.publish_shifts(array[c_shift], 'Published for the demo.');
  perform set_config('request.jwt.claims', json_build_object('sub', c_field, 'role', 'authenticated')::text, true);
  perform app.accept_shift(c_shift, 'Accepted for the demo.');
  perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);

  -- Credentials and the access grid -------------------------------------------------------------------------
  insert into app.credential_categories (id, org_id, project_id, code, name)
  values (c_category, c_org, c_project, 'CREW', 'Crew');
  insert into app.credentials (org_id, credential_category_id, holder_person_id, valid_from, valid_to) values
    (c_org, c_category, c_field, v_day_start - interval '1 day', v_day_start + interval '30 days'),
    (c_org, c_category, c_crew, v_day_start - interval '1 day', v_day_start + interval '30 days');
  insert into app.access_grid (org_id, credential_category_id, zone_id, access_level_enum_id, window_starts_at, window_ends_at) values
    (c_org, c_category, c_zone_gate, v_full_access, v_day_start, v_day_start + interval '30 days'),
    (c_org, c_category, c_zone_backstage, v_full_access, v_day_start + interval '12 hours', v_day_start + interval '30 days');

  -- Reference: radio plan and SOPs ------------------------------------------------------------------------------
  insert into app.radio_channels (org_id, project_id, channel_number, name, zone_id) values
    (c_org, c_project, 1, 'Production', null),
    (c_org, c_project, 2, 'Security', c_zone_gate),
    (c_org, c_project, 3, 'Stage Management', c_zone_stage);
  insert into app.sops (org_id, code, title, body)
  select c_org, s.code, s.title, s.body from (values
    ('SOP-101', 'Pier Evacuation', 'On a Code Red or a Monitor-to-Evacuate weather call, stop the show, bring house lights up and direct guests to the two pier exits. Supervisors sweep their zones and report clear on channel 1.'),
    ('SOP-102', 'Lost Child', 'Keep the reporting adult with you, radio the description on channel 2 and post staff at both pier exits until the child is found.')
  ) as s (code, title, body)
  where not exists (select 1 from app.sops x where x.org_id = c_org and x.code = s.code and x.deleted_at is null);
  update app.sops set published_at = now() where org_id = c_org and code in ('SOP-101', 'SOP-102') and published_at is null;

  -- Inspections ---------------------------------------------------------------------------------------------------
  insert into app.inspection_templates (id, org_id, name) values (c_template, c_org, 'Stage Safety Walk');
  insert into app.inspection_items (org_id, inspection_template_id, position, prompt, is_critical) values
    (c_org, c_template, 1, 'Fire extinguishers tagged and in place', false),
    (c_org, c_template, 2, 'Emergency exits clear and lit', true),
    (c_org, c_template, 3, 'Cable runs taped or ramped', false),
    (c_org, c_template, 4, 'Stage edge marked', false);

  -- Assets ---------------------------------------------------------------------------------------------------
  select e.element_id into v_element from xpms.elements e order by e.element_id limit 1;
  if v_element is not null then
    insert into app.asset_classes (id, org_id, element_id, name) values (c_asset_class, c_org, v_element, 'Wireless Microphone');
    insert into app.asset_units (id, org_id, asset_class_id, asset_tag, home_venue_id) values
      (c_unit_a, c_org, c_asset_class, 'AUD-0042', c_venue),
      (c_unit_b, c_org, c_asset_class, 'AUD-0043', c_venue);
    perform app.transition_asset(c_unit_a, 'Proposed', 'Received', 'Received for the demo.');
    perform app.transition_asset(c_unit_a, 'Received', 'Available', 'Checked in.');
    insert into app.asset_identifiers (org_id, asset_unit_id, scheme, value) values (c_org, c_unit_a, 'gtin14', '09501101530003');
    insert into app.asset_custody (org_id, asset_unit_id, custodian_membership_id, project_id, note)
    values (c_org, c_unit_a, c_field_membership, c_project, 'Issued for load-in.');
  end if;
end $$;
