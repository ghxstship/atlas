-- 0108_schedule_work_show.sql
-- A08 Schedule, Work and Show (Section 19.6: the demo tenant exercises the feature).
--
-- On the demo project (NWS, Northwind Summer Series, a fictional waterfront festival):
--   * records of sixteen kinds across load-in, show and load-out, with kind attributes, checklists,
--     assignees, a recurring production meeting and dependencies from build to rehearsal to show
--   * records moved through their states (Ready, Scheduled, Active, Blocked with its blocker,
--     Complete), a captured Gate 3 baseline, then one scheduled record slipped two days, so the
--     replan log and the baseline variance show it
--   * a work order open for bids with a priced and an unpriced bid, and a punch item from a walk
--   * the Opening Night running order with cues, the first one called, a published day sheet and
--     a call sheet
-- Writes run as the demo people through the same tables and RPCs the app uses, so ledgers, domain
-- events, activity and audit carry real entries. Guarded on the demo project (A07's 0107) and
-- idempotent: nothing runs once the demo project has records.

do $$
declare
  c_org constant uuid := '01920000-0000-7000-8000-000000000001';
  c_project constant uuid := '01920000-0000-7000-8000-000000001001';
  c_owner constant uuid := '01920000-0000-7000-8000-000000000101';
  c_producer constant uuid := '01920000-0000-7000-8000-000000000103';
  c_field constant uuid := '01920000-0000-7000-8000-000000000104';
  c_field_membership constant uuid := '01920000-0000-7000-8000-00000000a104';
  c_vendor_org constant uuid := '01920000-0000-7000-8000-000000000301';
  v_show uuid;
  v_window uuid;
  v_deck uuid;
  v_truss uuid;
  v_rehearsal uuid;
  v_event uuid;
  v_strike uuid;
  v_milestone uuid;
  v_permit uuid;
  v_booking uuid;
  v_contract uuid;
  v_meeting uuid;
  v_risk uuid;
  v_inspection uuid;
  v_document uuid;
  v_deadline uuid;
  v_shift uuid;
  v_focus uuid;
  v_baseline uuid;
  v_work_order uuid;
  v_counterparty uuid;
  v_run uuid;
  v_cue uuid;
begin
  if not exists (select 1 from app.projects where id = c_project)
     or exists (select 1 from app.records where project_id = c_project) then
    return;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);
  select n.id into v_show from app.scope_nodes n where n.project_id = c_project and n.scope_code = 'NWS-S01';

  -- Records -------------------------------------------------------------------------------------------------
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, starts_at, ends_at)
  values (c_project, 'Timeline', 'Show Cycle', 'Load-In Window', 'Z', 'Declared', 'INS', c_producer,
    '2027-03-10 12:00+00', '2027-03-12 22:00+00') returning id into v_window;
  insert into app.records (project_id, scope_node_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, starts_at, ends_at)
  values (c_project, v_show, 'Build', 'Structural', 'Install the stage deck', 'Y', 'Declared', 'BLD', c_field,
    '2027-03-10 13:00+00', '2027-03-10 21:00+00') returning id into v_deck;
  insert into app.records (project_id, scope_node_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, starts_at, ends_at)
  values (c_project, v_show, 'Task', 'Execute', 'Hang the main truss', 'Y', 'Declared', 'INS', c_field,
    '2027-03-11 13:00+00', '2027-03-11 20:00+00') returning id into v_truss;
  insert into app.records (project_id, scope_node_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, starts_at, ends_at)
  values (c_project, v_show, 'Task', 'Verify', 'Focus the wash lights', 'Y', 'Declared', 'INS', c_field,
    '2027-03-11 22:00+00', '2027-03-12 02:00+00') returning id into v_focus;
  insert into app.records (project_id, scope_node_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, starts_at, ends_at)
  values (c_project, v_show, 'Rehearsal', 'Full Run', 'Run the full show', 'Y', 'Declared', 'INS', c_producer,
    '2027-03-12 18:00+00', '2027-03-12 21:00+00') returning id into v_rehearsal;
  insert into app.records (project_id, scope_node_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, starts_at, ends_at)
  values (c_project, v_show, 'Event', 'Flagship Activation', 'Opening Night Concert', 'Z', 'Declared', 'OPR', c_producer,
    '2027-03-13 23:00+00', '2027-03-14 03:00+00') returning id into v_event;
  insert into app.records (project_id, scope_node_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, starts_at, ends_at)
  values (c_project, v_show, 'Strike', 'Show Strike', 'Strike the pier stage', 'Y', 'Declared', 'CLS', c_field,
    '2027-03-15 14:00+00', '2027-03-15 22:00+00') returning id into v_strike;
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, due_at)
  values (c_project, 'Milestone', 'Handover', 'Stage Load-In Complete', 'Z', 'Declared', 'INS', c_producer,
    '2027-03-12 22:00+00') returning id into v_milestone;
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, due_at)
  values (c_project, 'Permit', 'Special Event', 'Special Event Permit', 'Y', 'Declared', 'ADV', c_producer,
    '2027-02-26 21:00+00') returning id into v_permit;
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, starts_at, ends_at)
  values (c_project, 'Booking', 'Crew', 'Crew Hotel Block', 'X', 'Declared', 'PRC', c_producer,
    '2027-03-09 20:00+00', '2027-03-16 15:00+00') returning id into v_booking;
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, due_at)
  values (c_project, 'Contract', 'Service Agreement', 'Sound Vendor Agreement', 'Y', 'Declared', 'ENG', c_producer,
    '2027-02-15 21:00+00') returning id into v_contract;
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, starts_at, ends_at)
  values (c_project, 'Meeting', 'Recurring', 'Production Meeting', 'Z', 'Declared', 'ADV', c_producer,
    '2027-02-22 15:00+00', '2027-02-22 16:00+00') returning id into v_meeting;
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id)
  values (c_project, 'Risk', 'Safety', 'Afternoon Thunderstorm', 'Z', 'Declared', 'OPR', c_producer) returning id into v_risk;
  insert into app.records (project_id, scope_node_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, due_at)
  values (c_project, v_show, 'Inspection', 'Safety', 'Fire Marshal Walk', 'Y', 'Declared', 'INS', c_producer,
    '2027-03-12 20:00+00') returning id into v_inspection;
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, due_at)
  values (c_project, 'Document', 'Plan', 'Rigging Plan', 'Y', 'Declared', 'ADV', c_field, '2027-03-01 21:00+00') returning id into v_document;
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, due_at)
  values (c_project, 'Deadline', 'Vendor Owed', 'Final Artist Rider', 'Y', 'Declared', 'ADV', c_producer,
    '2027-02-27 21:00+00') returning id into v_deadline;
  insert into app.records (project_id, scope_node_id, record_kind, record_subtype, title, xyz, xyz_basis, phase_code, owner_party_id, starts_at, ends_at)
  values (c_project, v_show, 'Shift', 'Load-in', 'Stagehand · Load-in', 'X', 'Declared', 'INS', c_field,
    '2027-03-10 12:00+00', '2027-03-10 22:00+00') returning id into v_shift;

  -- Kind attributes ----------------------------------------------------------------------------------------
  insert into app.record_timeline (record_id) values (v_window);
  insert into app.record_build (record_id, engineering_stamp_required) values (v_deck, true);
  insert into app.record_task (record_id, progress_pct, effort_hours) values (v_truss, 0, 7), (v_focus, null, 4);
  insert into app.record_rehearsal (record_id, run_number) values (v_rehearsal, 1);
  insert into app.record_event (record_id, capacity) values (v_event, 4500);
  insert into app.record_strike (record_id, restoration_required) values (v_strike, true);
  insert into app.record_milestone (record_id) values (v_milestone);
  insert into app.record_permit (record_id, permit_identifier) values (v_permit, 'SEP-2027-0413');
  insert into app.record_booking (record_id, confirmation_identifier, quantity) values (v_booking, 'HB-88231', 24);
  insert into app.record_contract (record_id, value_minor, currency_code, effective_from, effective_to)
  values (v_contract, 4850000, 'USD', date '2027-03-10', date '2027-03-15');
  insert into app.record_meeting (record_id, location_text) values (v_meeting, 'Production office, Pier 3');
  insert into app.record_risk (record_id, likelihood, impact, mitigation)
  values (v_risk, 3, 4, 'Lightning detection on site; hold the show at 8 miles and clear the lawn at 6.');
  insert into app.record_inspection (record_id) values (v_inspection);
  insert into app.record_document (record_id, version_label) values (v_document, 'Rev C');
  insert into app.record_deadline (record_id, owed_to) values (v_deadline, 'Northwind Live production office');
  insert into app.record_shift (record_id, headcount) values (v_shift, 12);

  insert into app.record_checklist_items (record_id, position, label) values
    (v_truss, 1, 'Inspect every shackle and safety'),
    (v_truss, 2, 'Confirm the rigging plot revision'),
    (v_truss, 3, 'Clear the deck below before the lift');
  insert into app.record_assignments (record_id, membership_id) values (v_truss, c_field_membership), (v_focus, c_field_membership);
  insert into app.record_recurrences (record_id, rrule, time_zone, until_at)
  values (v_meeting, 'FREQ=WEEKLY;BYDAY=MO', 'America/New_York', '2027-03-15 23:59+00');
  insert into app.record_dependencies (predecessor_record_id, successor_record_id) values
    (v_deck, v_truss), (v_truss, v_focus), (v_focus, v_rehearsal), (v_rehearsal, v_event), (v_event, v_strike);

  -- States --------------------------------------------------------------------------------------------------
  perform app.transition_record(v_contract, 'Proposed', 'Ready', 'Terms agreed with the sound vendor.');
  perform app.transition_record(v_contract, 'Ready', 'Active', 'Countersigned.');
  perform app.transition_record(v_contract, 'Active', 'Complete', 'Executed copy on file.');
  perform app.transition_record(v_document, 'Proposed', 'Ready', 'Draft accepted.');
  perform app.transition_record(v_document, 'Ready', 'Active', 'Engineer reviewing Rev C.');
  perform app.transition_record(v_document, 'Active', 'In Review', 'Sent for stamp.');
  perform app.transition_record(v_permit, 'Proposed', 'Ready', 'Application packet complete.');
  perform app.transition_record(v_permit, 'Ready', 'Blocked', 'Waiting on the county.', 'Site plan resubmission requested by the fire marshal.');
  foreach v_cue in array array[v_deck, v_truss, v_focus, v_rehearsal, v_event, v_strike, v_milestone, v_shift, v_booking] loop
    perform app.transition_record(v_cue, 'Proposed', 'Scheduled', 'Dated and resourced on the load-in plan.');
  end loop;
  perform app.transition_record(v_booking, 'Scheduled', 'Active', 'Rooms held under the crew block.');

  -- Baseline, then a slip that the replan log keeps ------------------------------------------------------------
  insert into app.schedule_baselines (project_id, name) values (c_project, 'Gate 3 Baseline') returning id into v_baseline;
  perform app.lock_baseline(v_baseline);
  update app.records
  set starts_at = '2027-03-13 13:00+00', ends_at = '2027-03-13 20:00+00',
      replan_reason = 'Truss delivery moved two days by the carrier.'
  where id = v_truss;

  -- Work order with bids, and a punch item ---------------------------------------------------------------------
  insert into app.work_orders (project_id, scope_node_id, record_id, title, scope_of_work, location_text,
    scheduled_starts_at, scheduled_ends_at, estimated_hours, bid_due_at, budget_minor, currency_code)
  values (c_project, v_show, v_deck, 'Fabricate the Bar Fascia', 'Build and install a 24 ft x 4 ft printed fascia on the pier bar, including delivery.',
    'Bayfront Pier bar', '2027-03-09 13:00+00', '2027-03-10 21:00+00', 32, '2027-02-20 22:00+00', 850000, 'USD')
  returning id into v_work_order;
  perform app.transition_work_order(v_work_order, 'Draft', 'Open', 'Bids invited from the fabrication pool.');
  select c.id into v_counterparty from app.counterparties c where c.org_id = c_org and c.organization_id = c_vendor_org and c.deleted_at is null;
  if v_counterparty is not null then
    insert into app.work_order_bids (work_order_id, bidder_organization_id, amount_minor, currency_code, note)
    values (v_work_order, c_vendor_org, 790000, 'USD', 'Includes delivery and install; print proof in five days.');
  end if;
  insert into app.work_order_bids (work_order_id, bidder_person_id, currency_code, note)
  values (v_work_order, c_field, 'USD', 'Price to follow after the site walk.');
  perform app.create_punch_item(c_project, 'the stair 2 handrail is loose', v_inspection, null, null, 'Stair 2 landing', c_field,
    '2027-03-12 18:00+00');

  -- Show: running order, cues, sheets -------------------------------------------------------------------------
  insert into app.run_of_show (project_id, scope_node_id, name, show_date)
  values (c_project, v_show, 'Opening Night Running Order', date '2027-03-13') returning id into v_run;
  insert into app.cues (run_of_show_id, project_id, position, label, planned_at, duration) values
    (v_run, c_project, 1, 'House to Half', '2027-03-13 23:55+00', '30 seconds'),
    (v_run, c_project, 2, 'Walk-in Music Out', '2027-03-14 00:00+00', '10 seconds'),
    (v_run, c_project, 3, 'Host Welcome', '2027-03-14 00:01+00', '5 minutes'),
    (v_run, c_project, 4, 'Headliner On', '2027-03-14 00:10+00', '75 minutes'),
    (v_run, c_project, 5, 'House Lights Up', '2027-03-14 01:30+00', null);
  perform set_config('request.jwt.claims', json_build_object('sub', c_producer, 'role', 'authenticated')::text, true);
  select c.id into v_cue from app.cues c where c.run_of_show_id = v_run and c.position = 1;
  perform app.call_cue(v_cue);
  insert into app.day_sheets (project_id, day, body)
  values (c_project, date '2027-03-13',
    'Crew call 10:00 at the pier gate. Lunch 13:00. Sound check 16:00. Doors 19:00. Show 20:00. Curfew 23:00; load-out follows.');
  update app.day_sheets set published_at = now() where project_id = c_project and day = date '2027-03-13';
  insert into app.call_sheets (project_id, day) values (c_project, date '2027-03-13');
end $$;
