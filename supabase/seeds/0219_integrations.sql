-- 0219_integrations.sql
-- A19 Integrations (Section 19.6: the demo tenant exercises the feature). On the demo org, Settings > Integrations
-- shows every connection state and both sync outcomes without any real credential:
--   * Xero waiting for its credential, with GL accounts 5000 and 2100 mapped (UPL projection ready)
--   * Google Calendar waiting to connect, with project meetings targeted at a team calendar
--   * Slack waiting to connect, with record events of the demo project routed to a channel
--   * UPS and Gusto waiting to connect
--   * the ticketing CSV import connected (it needs no credential), with one succeeded import that recorded
--     opening-weekend attendance for the gate 8 measurement and one failed import showing its error
-- Changes run as the demo Admin through the same tables and RPCs the app uses, and as the platform for the runner's
-- part. Guarded on A30's demo org and A07's demo project, and idempotent: nothing runs once the Xero connection exists.
--
-- Fixed ids this file adds (in A19's block 0219):
--   Xero connection                                 01920000-0000-7000-8000-000000219001
--   Google Calendar connection                      01920000-0000-7000-8000-000000219002
--   Slack connection                                01920000-0000-7000-8000-000000219003
--   UPS connection                                  01920000-0000-7000-8000-000000219004
--   Gusto connection                                01920000-0000-7000-8000-000000219005
--   Ticketing CSV connection                        01920000-0000-7000-8000-000000219006

do $$
declare
  c_org constant uuid := '01920000-0000-7000-8000-000000000001';
  c_project constant uuid := '01920000-0000-7000-8000-000000001001';
  c_admin constant uuid := '01920000-0000-7000-8000-000000000102';
  c_xero constant uuid := '01920000-0000-7000-8000-000000219001';
  c_gcal constant uuid := '01920000-0000-7000-8000-000000219002';
  c_slack constant uuid := '01920000-0000-7000-8000-000000219003';
  c_ups constant uuid := '01920000-0000-7000-8000-000000219004';
  c_gusto constant uuid := '01920000-0000-7000-8000-000000219005';
  c_csv constant uuid := '01920000-0000-7000-8000-000000219006';
  v_run uuid;
begin
  if not exists (select 1 from app.organizations where id = c_org)
     or not exists (select 1 from app.projects where id = c_project)
     or exists (select 1 from app.integration_connections where id = c_xero) then
    return;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', c_admin, 'role', 'authenticated')::text, true);

  insert into app.integration_connections (id, org_id, provider_code, display_name, external_account_id) values
    (c_xero, c_org, 'xero', 'Northwind Books', 'demo-xero-tenant'),
    (c_gcal, c_org, 'google_calendar', 'Production Calendar', null),
    (c_slack, c_org, 'slack', 'Northwind Slack', 'T0DEMO'),
    (c_ups, c_org, 'ups', 'Northwind UPS', null),
    (c_gusto, c_org, 'gusto', 'Northwind Payroll', null),
    (c_csv, c_org, 'ticketing_csv', 'Box Office Exports', null)
  on conflict (id) do nothing;

  insert into app.integration_account_mappings (integration_connection_id, account_code, external_account_id)
  select c_xero, a.account_code, case a.account_code when '5000' then '400' else '800' end
  from xpms.dim_gl_account a where a.account_code in ('5000', '2100')
  on conflict do nothing;

  insert into app.integration_calendar_targets (integration_connection_id, project_id, sync_kind, external_calendar_id)
  values (c_gcal, c_project, 'Meeting', 'production-meetings@group.calendar.example.com')
  on conflict do nothing;

  insert into app.integration_channel_routes (integration_connection_id, project_id, event_type, external_channel_id) values
    (c_slack, c_project, 'record.created', 'C0DEMOPROD'),
    (c_slack, c_project, 'record.state_changed', 'C0DEMOPROD')
  on conflict do nothing;

  perform app.transition_integration_connection(c_csv, 'Pending', 'Connected', 'Ready for box office exports.');
  v_run := app.enqueue_integration_sync(c_csv, 'Attendance Import', 'Inbound', 'demo-box-office-opening', c_project, 3::smallint,
    null, null, 'imports/' || c_admin || '/01920000-0000-7000-8000-000000219001.csv');

  -- The runner's part, as the platform.
  perform set_config('request.jwt.claims', '', true);
  perform app.claim_integration_sync(v_run);
  perform app.record_attendance(v_run, jsonb_build_array(
    jsonb_build_object('counted_on', '2027-06-05', 'ticket_class', 'General Admission', 'tickets_sold', 1800, 'tickets_scanned', 1650,
      'comps', 40, 'gross_minor', 8100000, 'currency_code', 'USD'),
    jsonb_build_object('counted_on', '2027-06-05', 'ticket_class', 'VIP', 'tickets_sold', 210, 'tickets_scanned', 198,
      'gross_minor', 2100000, 'currency_code', 'USD'),
    jsonb_build_object('counted_on', '2027-06-06', 'ticket_class', 'General Admission', 'tickets_sold', 1500)));
  perform app.complete_integration_sync(v_run, 3, 3, 0, 0, null);

  perform set_config('request.jwt.claims', json_build_object('sub', c_admin, 'role', 'authenticated')::text, true);
  v_run := app.enqueue_integration_sync(c_csv, 'Attendance Import', 'Inbound', 'demo-box-office-sunday', c_project, 1::smallint,
    null, null, 'imports/' || c_admin || '/01920000-0000-7000-8000-000000219002.csv');
  perform set_config('request.jwt.claims', '', true);
  perform app.claim_integration_sync(v_run);
  perform app.fail_integration_sync(v_run, 'csv_header_missing', 'The file needs a ticket class column.', false);
end $$;
