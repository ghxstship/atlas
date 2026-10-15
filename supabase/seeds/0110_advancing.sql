-- 0110_advancing.sql
-- A10 Advancing demo data (Section 19.6: the demo tenant exercises the feature).
--
-- For the demo org and its demo project NWS (Northwind Summer Series):
--   * a sent headliner advance with three sections and two recipients: one answer came through a
--     Gateway link and was returned with a reason, one was recorded from a phone call and accepted,
--     so the packet sits Awaiting answers with work in the review queue
--   * a draft vendor advance still being written
--   * a technical rider with four asks, one fulfilled, and a hospitality rider being entered
--   * a guest list: one guest checked in, one approved, one requested and waiting for a decision
--   * a comment on the headliner packet
-- A09's 0109 already ran the project's first reconciliation, which leaves one gate 3 gap.
--
-- Writes act as the demo people, so guards, ledgers, domain events, activity and audit carry real
-- entries. Guarded on A30's demo org and A07's demo project, and idempotent: nothing runs when the
-- headliner packet already exists. The link token below is never shown; it exists so the demo
-- answer arrives through the same path a recipient uses.

do $$
declare
  c_org constant uuid := '01920000-0000-7000-8000-000000000001';
  c_project constant uuid := '01920000-0000-7000-8000-000000001001';
  c_owner constant uuid := '01920000-0000-7000-8000-000000000101';
  c_producer constant uuid := '01920000-0000-7000-8000-000000000103';
  c_field constant uuid := '01920000-0000-7000-8000-000000000104';
  c_crew constant uuid := '01920000-0000-7000-8000-000000000201';
  c_vendor_person constant uuid := '01920000-0000-7000-8000-000000000302';
  c_headliner constant uuid := '01920000-0000-7000-8000-000000011001';
  c_vendor_packet constant uuid := '01920000-0000-7000-8000-000000011002';
  c_arrival constant uuid := '01920000-0000-7000-8000-000000011011';
  c_backline constant uuid := '01920000-0000-7000-8000-000000011012';
  c_hospitality constant uuid := '01920000-0000-7000-8000-000000011013';
  c_power constant uuid := '01920000-0000-7000-8000-000000011014';
  c_rcpt_crew constant uuid := '01920000-0000-7000-8000-000000011021';
  c_rcpt_vendor constant uuid := '01920000-0000-7000-8000-000000011022';
  c_tech_rider constant uuid := '01920000-0000-7000-8000-000000011031';
  c_hosp_rider constant uuid := '01920000-0000-7000-8000-000000011032';
  v_token text;
  v_code text;
  v_answer uuid;
  v_phone uuid;
  v_line uuid;
  v_show uuid;
  v_guest uuid;
begin
  if not exists (select 1 from app.organizations where id = c_org)
     or not exists (select 1 from app.projects where id = c_project)
     or exists (select 1 from app.advance_packets where id = c_headliner) then
    return;
  end if;
  select n.id into v_show from app.scope_nodes n
  where n.project_id = c_project and n.scope_kind = 'Show' and n.deleted_at is null order by n.scope_code limit 1;

  -- The Producer builds and sends the headliner advance, and starts the vendor advance.
  perform set_config('request.jwt.claims', json_build_object('sub', c_producer, 'role', 'authenticated')::text, true);
  insert into app.advance_packets (id, org_id, project_id, title, due_at) values
    (c_headliner, c_org, c_project, 'Headliner Advance', now() + interval '10 days'),
    (c_vendor_packet, c_org, c_project, 'Staging Vendor Advance', now() + interval '21 days');
  insert into app.advance_sections (id, org_id, advance_packet_id, position, title, prompt) values
    (c_arrival, c_org, c_headliner, 1, 'Arrival', 'When does the party arrive, how many travel, and in how many vehicles?'),
    (c_backline, c_org, c_headliner, 2, 'Backline', 'List the backline you bring and what you need from the house.'),
    (c_hospitality, c_org, c_headliner, 3, 'Hospitality', 'Dressing room, catering and dietary needs.'),
    (c_power, c_org, c_vendor_packet, 1, 'Power', 'Total load and distribution you need at the stage.');
  insert into app.advance_recipients (id, org_id, advance_packet_id, person_id) values
    (c_rcpt_crew, c_org, c_headliner, c_crew),
    (c_rcpt_vendor, c_org, c_headliner, c_vendor_person);
  perform app.send_advance_packet(c_headliner);
  select i.token, i.access_code into v_token, v_code
  from app.issue_advance_token(c_rcpt_crew, 'crew@example.com', interval '30 days') i;

  -- The crew contact answers Arrival through the Gateway link.
  perform set_config('request.jwt.claims', '', true);
  select s.submission_id into v_answer
  from api_public.submit_advance(v_token, v_code, c_arrival, 'Party of 8 lands at 14:20 on show day; two vans from the airport.') s;

  -- The Producer records the vendor contact's Backline answer from a phone call.
  perform set_config('request.jwt.claims', json_build_object('sub', c_producer, 'role', 'authenticated')::text, true);
  insert into app.advance_submissions (org_id, advance_section_id, advance_recipient_id, body)
  values (c_org, c_backline, c_rcpt_vendor, 'Bringing two guitar amps and a drum kit; need an 8 ft x 8 ft riser and four wedges.')
  returning id into v_phone;
  update app.advance_submissions set reviewed_at = now(), reviewed_by = c_producer, review_outcome = 'Returned',
    return_reason = 'Please add the flight number so we can track arrival.'
  where id = v_answer;

  -- The Owner reviews the answer the Producer recorded (sod_advance_submitter keeps the Producer out).
  perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);
  update app.advance_submissions set reviewed_at = now(), reviewed_by = c_owner, review_outcome = 'Accepted' where id = v_phone;
  perform app.post_comment('app.advance_packets', c_headliner, 'Confirm the riser size with the staging vendor before Friday.', '{}', null);

  -- Riders: the technical rider with asks, one fulfilled; the hospitality rider being entered.
  perform set_config('request.jwt.claims', json_build_object('sub', c_producer, 'role', 'authenticated')::text, true);
  insert into app.riders (id, org_id, project_id, title) values
    (c_tech_rider, c_org, c_project, 'Headliner Technical Rider'),
    (c_hosp_rider, c_org, c_project, 'Headliner Hospitality Rider');
  insert into app.rider_lines (org_id, rider_id, description, quantity) values
    (c_org, c_tech_rider, 'Four wedge monitors on separate mixes', 4),
    (c_org, c_tech_rider, 'Drum riser 8 ft x 8 ft x 2 ft', 1),
    (c_org, c_tech_rider, 'Stage power at stage left, 2 x 20 A circuits', 2);
  insert into app.rider_lines (org_id, rider_id, description, quantity)
  values (c_org, c_tech_rider, 'Towels for the stage', 12)
  returning id into v_line;
  update app.rider_lines set fulfilled_at = now() where id = v_line;

  -- Guest list: the Field lead requests, the Producer decides, the door checks one guest in.
  perform set_config('request.jwt.claims', json_build_object('sub', c_field, 'role', 'authenticated')::text, true);
  insert into app.guest_list_entries (org_id, project_id, scope_node_id, guest_name, plus_ones, note)
  values (c_org, c_project, v_show, 'Jordan Pike', 1, 'Side stage, artist family.')
  returning id into v_guest;
  insert into app.guest_list_entries (org_id, project_id, scope_node_id, guest_name, plus_ones)
  values (c_org, c_project, v_show, 'Morgan Lee', 0);
  insert into app.guest_list_entries (org_id, project_id, scope_node_id, guest_name, plus_ones, note)
  values (c_org, c_project, v_show, 'Riley Chen', 2, 'Press.');
  perform set_config('request.jwt.claims', json_build_object('sub', c_producer, 'role', 'authenticated')::text, true);
  update app.guest_list_entries set entry_state = 'Approved'
  where project_id = c_project and guest_name in ('Jordan Pike', 'Morgan Lee') and entry_state = 'Requested';
  perform set_config('request.jwt.claims', json_build_object('sub', c_field, 'role', 'authenticated')::text, true);
  update app.guest_list_entries set entry_state = 'Checked In' where id = v_guest;

  perform set_config('request.jwt.claims', '', true);
end $$;
