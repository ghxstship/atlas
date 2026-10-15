-- 0107_projects.sql
-- A07 Projects, scope tree, gates and evidence (Section 19.6: the demo tenant exercises the feature).
--
-- The demo project (fixed id 01920000-0000-7000-8000-000000001001, key NWS) is a fictional
-- waterfront festival in Miami-Dade:
--   * an engagement root with two standing venues and four shows beneath them
--   * the Demo Producer as Producer and the Demo Field Lead as Field on the project
--   * gate 1 passed on attested evidence, so the project is Active in Engage
--   * gate 2 half evidenced: contracts are attested, the accountable party criterion is still a gap,
--     which Home and the Gates tab show as the open blocker
-- A second project (key NWG) stays Proposed at Scope with no evidence, so the board, timeline and
-- gate readiness views show projects at different points.
--
-- Changes run through the same RPCs the app uses, acting as the demo people, so the state ledgers,
-- domain events, activity feed and audit ledger carry real entries. Guarded on A30's demo org and
-- idempotent: nothing runs when the demo project already exists.

do $$
declare
  c_org constant uuid := '01920000-0000-7000-8000-000000000001';
  c_project constant uuid := '01920000-0000-7000-8000-000000001001';
  c_owner constant uuid := '01920000-0000-7000-8000-000000000101';
  c_producer constant uuid := '01920000-0000-7000-8000-000000000103';
  v_root uuid;
  v_pier uuid;
  v_park uuid;
  v_second uuid;
begin
  if not exists (select 1 from app.organizations where id = c_org)
     or exists (select 1 from app.projects where id = c_project) then
    return;
  end if;

  -- The Owner sets the project up and staffs it.
  perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);

  insert into app.projects (id, org_id, project_key, name, jurisdiction_id, region_code, tier_code, time_zone,
    starts_on, ends_on)
  values (c_project, c_org, 'NWS', 'Northwind Summer Series', 'US-FL-MIAMI-DADE', 'NA-SE-MIA', '05',
    'America/New_York', date '2027-03-12', date '2027-03-15');

  insert into app.scope_nodes (project_id, scope_kind, scope_code, name, path)
  values (c_project, 'Engagement Root', 'NWS-E01', 'Northwind Summer Series', 'NWS_E01')
  returning id into v_root;
  insert into app.scope_nodes (project_id, parent_id, scope_kind, scope_code, name, path)
  values (c_project, v_root, 'Standing Venue', 'NWS-V01', 'Bayfront Pier Stage', 'NWS_V01')
  returning id into v_pier;
  insert into app.scope_nodes (project_id, parent_id, scope_kind, scope_code, name, path)
  values (c_project, v_root, 'Standing Venue', 'NWS-V02', 'Harborside Park Lawn', 'NWS_V02')
  returning id into v_park;
  insert into app.scope_nodes (project_id, parent_id, scope_kind, scope_code, name, path) values
    (c_project, v_pier, 'Show', 'NWS-S01', 'Opening Night Concert', 'NWS_S01'),
    (c_project, v_pier, 'Show', 'NWS-S02', 'Closing Night Concert', 'NWS_S02'),
    (c_project, v_park, 'Show', 'NWS-S03', 'Family Day Program', 'NWS_S03'),
    (c_project, v_park, 'Show', 'NWS-S04', 'Sunset Cinema Screening', 'NWS_S04');

  insert into app.project_members (project_id, membership_id, project_role) values
    (c_project, '01920000-0000-7000-8000-00000000a103', 'Producer'),
    (c_project, '01920000-0000-7000-8000-00000000a104', 'Field');

  -- The Producer attests gate 1, passes it and starts gate 2.
  perform set_config('request.jwt.claims', json_build_object('sub', c_producer, 'role', 'authenticated')::text, true);

  insert into app.gate_evidence (project_id, criterion_id, evidence_uri, note, assertion_rank) values
    (c_project, 'G1.BUDGET_ENVELOPE', 'https://docs.example.com/nws/budget-envelope-v2.pdf',
      'Budget envelope approved by the client steering group.', 4),
    (c_project, 'G1.GONOGO', 'https://docs.example.com/nws/go-decision.pdf',
      'Go decision ratified by the executive producer.', 4),
    (c_project, 'G1.OBJECTIVES_STATED', 'https://docs.example.com/nws/objectives.pdf',
      'Attendance, sponsor reach and sentiment targets recorded.', 3),
    (c_project, 'G1.JURISDICTION', 'https://docs.example.com/nws/jurisdiction-memo.pdf',
      'Miami-Dade County confirmed as the authority having jurisdiction.', 4),
    (c_project, 'G1.SCOPE_LOCK', 'https://docs.example.com/nws/scope-lock.pdf',
      'Stage plots, site plan and sample approvals signed off.', 4);

  perform app.transition_project(c_project, 'Proposed', 'Active', 'Client signed the engagement letter.');
  perform app.transition_production(c_project, 'Proposed', 'Active', 'Production budget released.');
  perform app.pass_gate(c_project, 'SCP', 'Go decision ratified; scope locked with the client.');

  insert into app.gate_evidence (project_id, criterion_id, evidence_uri, note, assertion_rank) values
    (c_project, 'G2.CONTRACTS', 'https://docs.example.com/nws/executed-contracts.pdf',
      'Staging, audio and lighting vendors awarded and countersigned.', 4);

  -- A second project still in Scope.
  v_second := app.create_project(c_org, 'NWG', 'Northwind Winter Gala', 'America/New_York',
    'US-FL-MIAMI-DADE', 'NA-SE-MIA', '06', null, date '2027-12-04', date '2027-12-04');

  perform set_config('request.jwt.claims', '', true);
end;
$$;
