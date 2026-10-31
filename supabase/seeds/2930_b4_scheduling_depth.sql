-- 2930_b4_scheduling_depth.sql
-- B4 Scheduling depth (RRR-228, ADR 0143). Demo data for day types, the anchor, workload and clashes on the Demo Summer
-- Series (0107, 0108): its anchor day, a Load In, a Show and a split Load Out and Travel day, effort estimates on three
-- open tasks, and a side-stage running order on the show day where the headliner (Demo Multi Role, 1080) is also booked
-- for an acoustic set while the main stage plays (set_two_stages), followed five minutes later by the Demo Harbor Trio
-- (a changeover under the 15-minute minimum). Opening Night's running order stays as 0108 and 2790 left it. Idempotent.

do $$
declare
  c_project constant uuid := '01920000-0000-7000-8000-000000001001';
  c_artist constant uuid := '01920000-0000-7000-8000-000010800110';
  c_trio constant uuid := '01920000-0000-7000-8000-000029300101';
  e_headliner constant uuid := '01920000-0000-7000-8000-000029300201';
  e_trio constant uuid := '01920000-0000-7000-8000-000029300202';
  r_side constant uuid := '01920000-0000-7000-8000-000029300301';
  v_main uuid;
  v_headliner_cue uuid;
  v_pier uuid;
  v_show uuid;
  v_side_show uuid;
begin
  if not exists (select 1 from app.projects where id = c_project and deleted_at is null) then
    return;
  end if;

  -- The anchor: the plan counts from Opening Night.
  update app.projects set anchor_on = date '2027-03-13' where id = c_project and anchor_on is null;

  -- Day types.
  select n.venue_id into v_pier from app.scope_nodes n where n.project_id = c_project and n.scope_code = 'NWS-S01';
  select n.id into v_show from app.scope_nodes n where n.project_id = c_project and n.scope_code = 'NWS-S01';
  select n.id into v_side_show from app.scope_nodes n where n.project_id = c_project and n.scope_code = 'NWS-S02';
  if not exists (select 1 from app.project_days d where d.project_id = c_project and d.deleted_at is null) then
    insert into app.project_days (project_id, day_on, day_type, sort_order, label, venue_id, scope_node_id, location_text) values
      (c_project, date '2027-03-12', 'Load In', 1, null, v_pier, null, null),
      (c_project, date '2027-03-13', 'Show', 1, null, null, v_show, null),
      (c_project, date '2027-03-14', 'Load Out', 1, null, v_pier, null, null),
      (c_project, date '2027-03-14', 'Travel', 2, 'Travel to Orlando', null, null, 'Orlando, Florida');
  end if;

  -- Effort estimates on the first three open tasks.
  insert into app.record_task (record_id, org_id, effort_hours)
  select r.id, r.org_id, e.hours
  from (select r.id, r.org_id, row_number() over (order by r.record_number) as n from app.records r
        where r.project_id = c_project and r.record_kind = 'Task' and r.deleted_at is null
          and r.record_state not in ('Complete', 'Canceled')) r
  join (values (1, 6.0), (2, 4.0), (3, 3.0)) e (n, hours) on e.n = r.n
  on conflict (record_id) do update set effort_hours = excluded.effort_hours where app.record_task.effort_hours is null;

  -- The side stage on the show day, and the artists' set times.
  select r.id into v_main from app.run_of_show r
  where r.project_id = c_project and r.name = 'Opening Night Running Order' and r.deleted_at is null;
  select c.id into v_headliner_cue from app.cues c where c.run_of_show_id = v_main and c.label = 'Headliner On' and c.deleted_at is null;
  if v_main is null or v_headliner_cue is null or v_side_show is null or not exists (select 1 from app.people where id = c_artist) then
    return;
  end if;

  insert into app.people (id, full_name) values (c_trio, 'Demo Harbor Trio') on conflict (id) do nothing;
  insert into app.engagements (id, project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement,
    agreed_rate_minor, currency_code, start_date, end_date)
  values
    (e_headliner, c_project, c_artist, 'Artist', '2000.50.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement',
     300000, 'USD', '2027-03-13', '2027-03-13'),
    (e_trio, c_project, c_trio, 'Artist', '2000.50.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement',
     80000, 'USD', '2027-03-13', '2027-03-13')
  on conflict (id) do nothing;

  insert into app.run_of_show (id, project_id, scope_node_id, name, show_date)
  values (r_side, c_project, v_side_show, 'Opening Night Side Stage', date '2027-03-13')
  on conflict (id) do nothing;
  if not exists (select 1 from app.cues c where c.run_of_show_id = r_side and c.deleted_at is null) then
    insert into app.cues (run_of_show_id, project_id, position, label, planned_at, duration, segment) values
      (r_side, c_project, 1, 'Headliner Acoustic Set', '2027-03-14 00:20+00', '40 minutes', 'Side Stage'),
      (r_side, c_project, 2, 'Harbor Trio Set', '2027-03-14 01:05+00', '45 minutes', 'Side Stage');
  end if;

  insert into app.engagement_cues (engagement_id, cue_id)
  select x.engagement_id, x.cue_id from (values
    (e_headliner, v_headliner_cue),
    (e_headliner, (select c.id from app.cues c where c.run_of_show_id = r_side and c.position = 1 and c.deleted_at is null)),
    (e_trio, (select c.id from app.cues c where c.run_of_show_id = r_side and c.position = 2 and c.deleted_at is null))
  ) x (engagement_id, cue_id)
  where x.cue_id is not null
    and not exists (select 1 from app.engagement_cues ec where ec.engagement_id = x.engagement_id and ec.cue_id = x.cue_id
                    and ec.deleted_at is null);
end $$;
