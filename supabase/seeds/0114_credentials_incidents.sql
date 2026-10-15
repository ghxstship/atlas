-- 0114_credentials_incidents.sql
-- A14 Credentials and Safety incidents (Section 19.6: the demo tenant exercises the feature). On the demo
-- project (NWS, Northwind Summer Series):
--   * the Bayside Festival Grounds venue with three zones (LAWN, VIP, FOH-PARK)
--   * four credential categories (ALL-ACCESS, PRODUCTION, VENDOR, ARTIST) and an access grid over the
--     lawn zones, with one past window so the matrix shows both open and closed access
--   * badges for the Demo Admin, the Demo Producer and the external crew person, one of them revoked
--   * scans decided by the database: granted, denied by zone and denied after revocation
--   * three incidents: a critical one dispatched with a responder on the way, a moderate one contained
--     with a medical encounter, and a minor one closed with sign-off by someone other than its reporter
--   * an ended crisis alert under Code Yellow (power failure) and four radio channels (4 to 7) beside A17's 1 to 3
-- Writes run through the same tables and RPCs the app uses, as the person who would make them. Guarded on
-- the demo project (A07's 0107) and the Field membership (A30's 0010), and idempotent: nothing runs once
-- the ALL-ACCESS category exists. Codes and channel numbers avoid A17's 0217 (CREW, channels 1 to 3).
-- Fixed ids use the 0114 block.

do $$
declare
  c_org constant uuid := '01920000-0000-7000-8000-000000000001';
  c_project constant uuid := '01920000-0000-7000-8000-000000001001';
  c_owner constant uuid := '01920000-0000-7000-8000-000000000101';
  c_admin constant uuid := '01920000-0000-7000-8000-000000000102';
  c_producer constant uuid := '01920000-0000-7000-8000-000000000103';
  c_field constant uuid := '01920000-0000-7000-8000-000000000104';
  c_crew constant uuid := '01920000-0000-7000-8000-000000000201';
  c_field_membership constant uuid := '01920000-0000-7000-8000-00000000a104';
  c_producer_membership constant uuid := '01920000-0000-7000-8000-00000000a103';
  c_venue constant uuid := '01920000-0000-7000-8000-000000114001';
  c_zone_lawn constant uuid := '01920000-0000-7000-8000-000000114011';
  c_zone_vip constant uuid := '01920000-0000-7000-8000-000000114012';
  c_zone_foh constant uuid := '01920000-0000-7000-8000-000000114013';
  c_all_access constant uuid := '01920000-0000-7000-8000-000000114021';
  c_production constant uuid := '01920000-0000-7000-8000-000000114022';
  c_vendor constant uuid := '01920000-0000-7000-8000-000000114023';
  c_artist constant uuid := '01920000-0000-7000-8000-000000114024';
  c_cred_admin constant uuid := '01920000-0000-7000-8000-000000114031';
  c_cred_producer constant uuid := '01920000-0000-7000-8000-000000114032';
  c_cred_crew constant uuid := '01920000-0000-7000-8000-000000114033';
  c_incident_critical constant uuid := '01920000-0000-7000-8000-000000114041';
  c_incident_moderate constant uuid := '01920000-0000-7000-8000-000000114042';
  c_incident_minor constant uuid := '01920000-0000-7000-8000-000000114043';
  v_jurisdiction text;
  v_full text;
  v_restricted text;
  v_escort text;
  v_critical text;
  v_moderate text;
  v_minor text;
  v_now timestamptz := now();
begin
  if not exists (select 1 from app.projects where id = c_project)
     or not exists (select 1 from app.memberships where id = c_field_membership)
     or exists (select 1 from app.credential_categories where id = c_all_access) then
    return;
  end if;

  select p.jurisdiction_id into v_jurisdiction from app.projects p where p.id = c_project;
  select e.record_id into v_full from xpms.std_enumeration e where e.enum_domain = 'Access Level' order by e.sort_order limit 1;
  select e.record_id into v_restricted from xpms.std_enumeration e where e.enum_domain = 'Access Level' order by e.sort_order offset 1 limit 1;
  select e.record_id into v_escort from xpms.std_enumeration e where e.enum_domain = 'Access Level' order by e.sort_order offset 2 limit 1;
  select e.record_id into v_critical from xpms.std_enumeration e where e.enum_domain = 'Incident Severity' order by e.sort_order limit 1;
  select e.record_id into v_moderate from xpms.std_enumeration e where e.enum_domain = 'Incident Severity' order by e.sort_order offset 2 limit 1;
  select e.record_id into v_minor from xpms.std_enumeration e where e.enum_domain = 'Incident Severity' order by e.sort_order offset 3 limit 1;

  -- The Owner sets up the venue, categories and the access grid ---------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);

  insert into app.venues (id, org_id, name, jurisdiction_id, time_zone, street_address, locality)
  values (c_venue, c_org, 'Bayside Festival Grounds', v_jurisdiction, 'America/New_York', '200 Bayshore Drive', 'Miami');
  insert into app.zones (id, org_id, venue_id, code, name) values
    (c_zone_lawn, c_org, c_venue, 'LAWN', 'Festival Lawn'),
    (c_zone_vip, c_org, c_venue, 'VIP', 'VIP Terrace'),
    (c_zone_foh, c_org, c_venue, 'FOH-PARK', 'Front of House Riser');

  insert into app.credential_categories (id, org_id, project_id, code, name) values
    (c_all_access, c_org, c_project, 'ALL-ACCESS', 'All Access'),
    (c_production, c_org, c_project, 'PRODUCTION', 'Production'),
    (c_vendor, c_org, c_project, 'VENDOR', 'Vendor'),
    (c_artist, c_org, c_project, 'ARTIST', 'Artist Party');

  insert into app.access_grid (org_id, project_id, credential_category_id, zone_id, access_level_enum_id, window_starts_at, window_ends_at) values
    (c_org, c_project, c_all_access, c_zone_lawn, v_full, v_now - interval '1 day', v_now + interval '60 days'),
    (c_org, c_project, c_all_access, c_zone_vip, v_full, v_now - interval '1 day', v_now + interval '60 days'),
    (c_org, c_project, c_all_access, c_zone_foh, v_full, v_now - interval '1 day', v_now + interval '60 days'),
    (c_org, c_project, c_production, c_zone_lawn, v_full, v_now - interval '1 day', v_now + interval '60 days'),
    (c_org, c_project, c_production, c_zone_foh, v_restricted, v_now - interval '1 day', v_now + interval '60 days'),
    (c_org, c_project, c_vendor, c_zone_lawn, v_escort, v_now - interval '10 days', v_now - interval '2 days'),
    (c_org, c_project, c_artist, c_zone_vip, v_restricted, v_now - interval '1 day', v_now + interval '60 days');

  -- Badges: the Owner issues them; nobody issues their own (invariant 21) ------------------------------------
  insert into app.credentials (id, org_id, project_id, credential_category_id, holder_person_id, valid_from, valid_to) values
    (c_cred_admin, c_org, c_project, c_all_access, c_admin, v_now - interval '1 day', null),
    (c_cred_producer, c_org, c_project, c_production, c_producer, v_now - interval '1 day', v_now + interval '60 days'),
    (c_cred_crew, c_org, c_project, c_artist, c_crew, v_now - interval '1 day', v_now + interval '60 days');

  -- Scans at the gate: granted, denied by zone, then denied after revocation ---------------------------------
  perform app.record_scan(c_zone_lawn, c_cred_admin);
  perform app.record_scan(c_zone_vip, c_cred_producer);
  perform app.record_scan(c_zone_vip, c_cred_crew);
  update app.credentials set revoked_at = now() where id = c_cred_crew;
  perform app.record_scan(c_zone_vip, c_cred_crew);

  -- The radio plan beside A17's channels 1 to 3 ---------------------------------------------------------------
  insert into app.radio_channels (org_id, project_id, channel_number, name, zone_id) values
    (c_org, c_project, 4, 'Medical', null),
    (c_org, c_project, 5, 'Lawn Operations', c_zone_lawn),
    (c_org, c_project, 6, 'VIP Hosts', c_zone_vip),
    (c_org, c_project, 7, 'Front of House', c_zone_foh);

  -- Incidents, filed by the Field Lead from Compass ------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', c_field, 'role', 'authenticated')::text, true);
  perform app.report_incident(c_project, 'Lighting Tower Leaning at the Lawn Edge', v_critical, v_now - interval '20 minutes',
    c_zone_lawn, 25.770100, -80.186200, 6, v_now - interval '19 minutes', c_incident_critical);
  perform app.report_incident(c_project, 'Guest Fainted Near the VIP Terrace', v_moderate, v_now - interval '2 hours',
    c_zone_vip, 25.770800, -80.185400, 10, v_now - interval '2 hours', c_incident_moderate);
  perform app.report_incident(c_project, 'Spilled Ice at the Front of House Riser', v_minor, v_now - interval '5 hours',
    c_zone_foh, 25.771300, -80.186900, 12, v_now - interval '5 hours', c_incident_minor);
  perform app.add_incident_party(c_incident_moderate, 'Guest, adult, treated on site');
  perform app.add_incident_party(c_incident_critical, 'Rigging lead, witness', c_producer);

  -- The Producer dispatches, contains and signs off ----------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', c_producer, 'role', 'authenticated')::text, true);
  perform app.dispatch_responder(c_incident_critical, c_field_membership);
  perform app.transition_incident(c_incident_critical, 'Reported', 'Dispatched', 'Riggers sent to secure the tower.');
  perform app.dispatch_responder(c_incident_moderate, c_producer_membership);
  perform app.mark_dispatch_arrived((select d.id from app.dispatch_assignments d where d.incident_id = c_incident_moderate limit 1));
  perform app.transition_incident(c_incident_moderate, 'Reported', 'Contained', 'Guest recovered and seated in the shade.');
  perform app.transition_incident(c_incident_minor, 'Reported', 'Contained', 'Area mopped and dried.');
  perform app.close_incident(c_incident_minor, 'Riser inspected; surface dry and safe.');

  -- The Owner holds the medical records permission and records the encounter ---------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);
  perform app.record_medical_encounter(c_incident_moderate, 'Guest, adult', 'Heat exhaustion; cooled, oral fluids given.', 'Released');

  insert into app.crisis_alerts (org_id, project_id, emergency_code, message, issued_at, ended_at)
  select c_org, c_project, c.code, 'Power failure at the lawn stage. Hold the audience in place and keep the aisles clear.',
    v_now - interval '1 day', v_now - interval '1 day' + interval '40 minutes'
  from xpms.emergency_code c where c.code = 'CODE_YELLOW';

  perform set_config('request.jwt.claims', '', true);
end;
$$;
