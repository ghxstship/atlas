-- 0112_assets.sql
-- A12 Assets demo seed (Section 19.6). Exercises every Assets page in the demo org:
--   * the Northwind Gear Warehouse, home of the owned gear
--   * five asset classes bound to canon equipment elements (read from xpms, never invented)
--   * units in every state a crew meets: Available, Reserved, Deployed (checked out by scan to the
--     Demo Field Lead for the NWS project), In Maintenance, Damaged with its report, and Retired by
--     write-off; serial and GTIN identifiers on them
--   * two lots, with a scan check-out to the field lead and a recount in the lot ledger
--   * maintenance with a known cost and one whose cost is still unknown (stays NULL)
--   * a comment on the damaged unit
-- Writes go through the same RPCs the app uses (transition_asset, apply_asset_scan, count_asset_lot),
-- signed in as the Demo Owner, so the ledgers, events and audit rows are the real ones.
--
-- Fixed ids (01920000-0000-7000-8000-000000112xxx): warehouse 112001, classes 112101 to 112105,
-- units 112201 to 112216, lots 112301 and 112302, scan events 112401 to 112404.
-- Names and tags are this seed's own: the warehouse name and the MH-, RAD-, GEN- and BKR- tags
-- appear in no other seed. Guarded on the demo org, the NWS project and the field membership;
-- skipped when the warehouse already exists, so a second load changes nothing.

do $$
declare
  c_org constant uuid := '01920000-0000-7000-8000-000000000001';
  c_project constant uuid := '01920000-0000-7000-8000-000000001001';
  c_owner constant uuid := '01920000-0000-7000-8000-000000000101';
  c_field_membership constant uuid := '01920000-0000-7000-8000-00000000a104';
  c_producer_membership constant uuid := '01920000-0000-7000-8000-00000000a103';
  c_warehouse constant uuid := '01920000-0000-7000-8000-000000112001';
  c_spot constant uuid := '01920000-0000-7000-8000-000000112101';
  c_radio constant uuid := '01920000-0000-7000-8000-000000112102';
  c_truss constant uuid := '01920000-0000-7000-8000-000000112103';
  c_barricade constant uuid := '01920000-0000-7000-8000-000000112104';
  c_generator constant uuid := '01920000-0000-7000-8000-000000112105';
  c_lot_truss constant uuid := '01920000-0000-7000-8000-000000112301';
  c_lot_barricade constant uuid := '01920000-0000-7000-8000-000000112302';
  v_good text;
  v_fair text;
  v_poor text;
  v_unit record;
begin
  if not exists (select 1 from app.organizations where id = c_org)
     or not exists (select 1 from app.projects where id = c_project)
     or not exists (select 1 from app.memberships where id = c_field_membership)
     or exists (select 1 from app.venues where id = c_warehouse) then
    return;
  end if;
  if (select count(*) from xpms.elements where element_id in (
        '5000.02.02-XPMS-003', '9000.03.01-XPMS-003', '5000.05.03-XPMS-001', '4000.08.01-XPMS-001', '5000.06.01-XPMS-004')) <> 5 then
    return;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);
  select record_id into v_good from xpms.std_enumeration where enum_domain = 'Asset Condition' and enum_code = 'COND_GOOD';
  select record_id into v_fair from xpms.std_enumeration where enum_domain = 'Asset Condition' and enum_code = 'COND_FAIR';
  select record_id into v_poor from xpms.std_enumeration where enum_domain = 'Asset Condition' and enum_code = 'COND_POOR';

  insert into app.venues (id, org_id, name, jurisdiction_id, time_zone, street_address, locality, postal_code)
  values (c_warehouse, c_org, 'Northwind Gear Warehouse', 'US-FL-MIAMI-DADE', 'America/New_York', '2200 NW 7th Avenue', 'Miami', '33127');

  -- Classes -------------------------------------------------------------------------------------------------
  insert into app.asset_classes (id, org_id, element_id, name) values
    (c_spot, c_org, '5000.02.02-XPMS-003', 'Spot Fixture'),
    (c_radio, c_org, '9000.03.01-XPMS-003', 'Digital Two-Way Radio'),
    (c_truss, c_org, '5000.05.03-XPMS-001', 'Box Truss 12 in'),
    (c_barricade, c_org, '4000.08.01-XPMS-001', 'Bike Rack Barricade'),
    (c_generator, c_org, '5000.06.01-XPMS-004', 'Towable Generator');

  -- Units: id suffix, class, tag, condition, target state --------------------------------------------------------
  for v_unit in
    select * from (values
      ('112201', c_spot, 'MH-001', v_good, 'Available'),
      ('112202', c_spot, 'MH-002', v_good, 'Deployed'),
      ('112203', c_spot, 'MH-003', v_good, 'Deployed'),
      ('112204', c_spot, 'MH-004', v_fair, 'In Maintenance'),
      ('112205', c_spot, 'MH-005', v_poor, 'Damaged'),
      ('112206', c_spot, 'MH-006', v_poor, 'Retired'),
      ('112207', c_radio, 'RAD-001', v_good, 'Deployed'),
      ('112208', c_radio, 'RAD-002', v_good, 'Available'),
      ('112209', c_radio, 'RAD-003', v_good, 'Available'),
      ('112210', c_radio, 'RAD-004', v_good, 'Reserved'),
      ('112211', c_radio, 'RAD-005', v_good, 'Available'),
      ('112212', c_radio, 'RAD-006', null, 'Proposed'),
      ('112213', c_generator, 'GEN-001', v_good, 'Available'),
      ('112214', c_generator, 'GEN-002', v_fair, 'In Maintenance'),
      ('112215', c_barricade, 'BKR-SPARE-01', v_good, 'Available'),
      ('112216', c_radio, 'RAD-007', v_good, 'Received')
    ) u(suffix, class_id, tag, condition, target)
  loop
    insert into app.asset_units (id, org_id, asset_class_id, asset_tag, condition_enum_id, home_venue_id)
    values (('01920000-0000-7000-8000-000000' || v_unit.suffix)::uuid, c_org, v_unit.class_id, v_unit.tag, v_unit.condition, c_warehouse);
    if v_unit.target <> 'Proposed' then
      perform app.transition_asset(('01920000-0000-7000-8000-000000' || v_unit.suffix)::uuid, 'Proposed', 'Received', 'Delivered to the warehouse.');
    end if;
    if v_unit.target not in ('Proposed', 'Received') then
      perform app.transition_asset(('01920000-0000-7000-8000-000000' || v_unit.suffix)::uuid, 'Received', 'Available', 'Inspected and shelved.');
    end if;
  end loop;

  insert into app.asset_identifiers (org_id, asset_unit_id, scheme, value) values
    (c_org, '01920000-0000-7000-8000-000000112201', 'serial', 'SPX-48810'),
    (c_org, '01920000-0000-7000-8000-000000112202', 'serial', 'SPX-48811'),
    (c_org, '01920000-0000-7000-8000-000000112203', 'serial', 'SPX-48812'),
    (c_org, '01920000-0000-7000-8000-000000112207', 'gtin14', '00012345600017'),
    (c_org, '01920000-0000-7000-8000-000000112208', 'serial', 'DR-20931');

  -- Custody by scan: three units out to the field lead for NWS -----------------------------------------------
  perform app.apply_asset_scan('01920000-0000-7000-8000-000000112401', c_org, 'MH-002', 'check-out',
    c_field_membership, null, null, c_project, 'Front truss wash for the opening show.');
  perform app.apply_asset_scan('01920000-0000-7000-8000-000000112402', c_org, 'SPX-48812', 'check-out',
    c_field_membership, null, null, c_project, 'Scanned by serial at the cage.');
  perform app.apply_asset_scan('01920000-0000-7000-8000-000000112403', c_org, '00012345600017', 'check-out',
    c_producer_membership, null, null, c_project, 'Producer channel radio.');

  -- Other states -------------------------------------------------------------------------------------------------
  perform app.transition_asset('01920000-0000-7000-8000-000000112210', 'Available', 'Reserved', 'Held for the NWS advance team.');
  perform app.transition_asset('01920000-0000-7000-8000-000000112204', 'Available', 'In Maintenance', 'Lamp hours past service interval.');
  perform app.transition_asset('01920000-0000-7000-8000-000000112214', 'Available', 'In Maintenance', 'Annual load bank test.');
  perform app.transition_asset('01920000-0000-7000-8000-000000112205', 'Available', 'Deployed', 'Out for the rehearsal rig.');
  perform app.transition_asset('01920000-0000-7000-8000-000000112205', 'Deployed', 'Damaged', 'Dropped during load-out; yoke cracked.');
  perform app.transition_asset('01920000-0000-7000-8000-000000112206', 'Available', 'Deployed', 'Out for the rehearsal rig.');
  perform app.transition_asset('01920000-0000-7000-8000-000000112206', 'Deployed', 'Damaged', 'Water ingress after the storm.');
  perform app.transition_asset('01920000-0000-7000-8000-000000112206', 'Damaged', 'Retired', 'Written off; repair costs more than replacement.');

  insert into app.asset_damage (org_id, asset_unit_id, project_id, description, reported_at) values
    (c_org, '01920000-0000-7000-8000-000000112205', c_project, 'Yoke cracked when the case tipped off the lift gate during load-out.', now() - interval '2 days'),
    (c_org, '01920000-0000-7000-8000-000000112206', c_project, 'Water got into the head during the storm; the display and motor board failed.', now() - interval '9 days');

  insert into app.asset_maintenance (org_id, asset_unit_id, performed_on, description, cost_minor, currency_code) values
    (c_org, '01920000-0000-7000-8000-000000112201', current_date - 20, 'Lamp replaced and optics cleaned.', 18500, 'USD'),
    (c_org, '01920000-0000-7000-8000-000000112204', current_date - 1, 'Sent to the shop for a lamp and gobo wheel service; quote pending.', null, null),
    (c_org, '01920000-0000-7000-8000-000000112213', current_date - 45, 'Oil, filters and load bank test.', 42000, 'USD'),
    (c_org, '01920000-0000-7000-8000-000000112208', current_date - 10, 'Battery swapped.', 3900, 'USD');

  -- Lots ------------------------------------------------------------------------------------------------------------
  insert into app.asset_lots (id, org_id, asset_class_id, venue_id, quantity) values
    (c_lot_truss, c_org, c_truss, c_warehouse, 40),
    (c_lot_barricade, c_org, c_barricade, c_warehouse, 120);
  perform app.apply_asset_scan('01920000-0000-7000-8000-000000112404', c_org, 'LOT:' || c_lot_barricade, 'check-out',
    c_field_membership, null, null, c_project, 'Front of house crowd line.', 48);
  perform app.count_asset_lot(c_lot_truss, 38, 'Two sections bent; set aside for inspection.');

  perform app.post_comment('app.asset_units', '01920000-0000-7000-8000-000000112205',
    'Quote requested from the lighting shop. Keep it off the truck until the yoke is replaced.', '{}'::uuid[], null);

  perform set_config('request.jwt.claims', '', true);
end $$;
