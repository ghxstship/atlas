-- 0113_people_crew.sql
-- A13 People and Crew demo seed (Section 19.6: the demo tenant exercises every feature).
--
-- On the demo project NWS (Northwind Summer Series, March 12 to 15, 2027, America/New_York):
--   * Crew: earning codes, a time off policy, a rate card adopted from canon Labor Rate Card rows, the
--     Field Lead's pay rate, four shifts (two accepted by the Field Lead, one published open shift for
--     crew to claim, one draft), a swap request, two days of time entries, a submitted and approved
--     timesheet, an open pay period with a draft payroll run, and a time off request
--   * People: a role assignment to canon Rigging, a priced bartending requisition sized from the canon
--     ratio (39 people for 2,500 guests), a contractor agreement sent for signature, and a rigging
--     certificate recorded by the Owner
-- Every change runs as the demo person who would make it, through the same RPCs the app uses, so the
-- state ledgers, domain events, activity feed and audit ledger carry real entries. Guarded on A30's
-- demo org and A07's demo project, and idempotent: nothing runs when the REG earning code exists.

do $$
declare
  c_org constant uuid := '01920000-0000-7000-8000-000000000001';
  c_project constant uuid := '01920000-0000-7000-8000-000000001001';
  c_owner constant uuid := '01920000-0000-7000-8000-000000000101';
  c_producer constant uuid := '01920000-0000-7000-8000-000000000103';
  c_field constant uuid := '01920000-0000-7000-8000-000000000104';
  c_admin_m constant uuid := '01920000-0000-7000-8000-00000000a102';
  c_field_m constant uuid := '01920000-0000-7000-8000-00000000a104';
  v_card uuid;
  v_policy uuid;
  v_cert uuid;
  v_shift1 uuid;
  v_shift2 uuid;
  v_open uuid;
  v_draft uuid;
  v_sheet uuid;
  v_period uuid;
  v_agreement uuid;
begin
  if not exists (select 1 from app.organizations where id = c_org)
     or not exists (select 1 from app.projects where id = c_project)
     or exists (select 1 from app.earning_codes where org_id = c_org and code = 'REG' and deleted_at is null) then
    return;
  end if;

  -- Owner: payroll setup, the rate card, the Field Lead's pay rate and a verified certificate.
  perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);
  insert into app.earning_codes (org_id, code, name) values (c_org, 'REG', 'Regular Hours');
  insert into app.earning_codes (org_id, code, name, is_overtime) values (c_org, 'OT', 'Overtime Hours', true);
  insert into app.time_off_policies (org_id, name, accrual_hours_per_period) values (c_org, 'Paid Time Off', 4)
    returning id into v_policy;
  insert into app.rate_cards (org_id, name, currency_code, effective_from) values (c_org, '2027 Crew Rates', 'USD', date '2027-01-01')
    returning id into v_card;
  insert into app.rate_card_lines (rate_card_id, role_code, worker_classification, pay_basis, arrangement, canon_rate_card_id, overtime_rule_id, rate_minor)
  select v_card, rc.role_code, rc.worker_classification, rc.pay_basis, rc.arrangement, rc.rate_card_id, rc.overtime_rule_id, rc.standard_rate_minor
  from xpms.rate_card rc
  where rc.currency_code = 'USD'
  order by rc.rate_card_id
  limit 6;
  insert into app.pay_rates (membership_id, role_code, rate_minor, currency_code, effective_from)
  values (c_field_m, '5000.51.02', 3200, 'USD', date '2027-01-01');
  insert into app.certifications (org_id, name, issuing_body)
  values (c_org, 'ETCP Arena Rigger', 'Entertainment Technician Certification Program') returning id into v_cert;
  insert into app.certification_holders (certification_id, person_id, issued_on, expires_on)
  values (v_cert, c_field, date '2025-04-01', date '2028-04-01');
  insert into app.agreements (org_id, project_id, person_id, agreement_kind, title, body)
  values (c_org, c_project, c_field, 'Contractor Agreement', 'Rigging Services for Northwind Summer Series',
    'The contractor provides arena rigging for the Northwind Summer Series from March 12 to 15, 2027, at the rates in the 2027 Crew Rates card, under the org''s safety program.')
  returning id into v_agreement;
  perform app.send_agreement(v_agreement, 'Sent for signature.', interval '30 days');

  -- Producer: shifts, a role assignment, a requisition, the pay period and its draft run.
  perform set_config('request.jwt.claims', json_build_object('sub', c_producer, 'role', 'authenticated')::text, true);
  insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone)
  values (c_project, c_field_m, '5000.51.02', timestamptz '2027-03-12 08:00-05', timestamptz '2027-03-12 18:00-05', 'America/New_York')
  returning id into v_shift1;
  insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone)
  values (c_project, c_field_m, '5000.51.02', timestamptz '2027-03-13 08:00-05', timestamptz '2027-03-13 18:00-05', 'America/New_York')
  returning id into v_shift2;
  insert into app.shifts (project_id, role_code, starts_at, ends_at, time_zone)
  values (c_project, '5000.51.02', timestamptz '2027-03-14 08:00-04', timestamptz '2027-03-14 16:00-04', 'America/New_York')
  returning id into v_open;
  insert into app.shifts (project_id, role_code, starts_at, ends_at, time_zone)
  values (c_project, '5000.51.01', timestamptz '2027-03-15 07:00-04', timestamptz '2027-03-15 19:00-04', 'America/New_York')
  returning id into v_draft;
  perform app.publish_shifts(array[v_shift1, v_shift2, v_open], 'Opening weekend schedule published.');
  insert into app.role_assignments (project_id, role_code, person_id, staffing_basis, starts_on, ends_on)
  values (c_project, '5000.51.02', c_field, 'Fixed', date '2027-03-12', date '2027-03-15');
  insert into app.requisitions (project_id, role_code, role_type, worker_classification, pay_basis, arrangement,
    headcount, units_per_head, rate_minor, currency_code, starts_on, ends_on, justification)
  select c_project, rc.role_code, 'Staff', rc.worker_classification, rc.pay_basis, rc.arrangement,
    39, 8, coalesce(rc.standard_rate_minor, 2500), 'USD', date '2027-03-12', date '2027-03-15',
    'Bar service for 2,500 guests at the canon ratio of one bartender per 65 guests.'
  from xpms.rate_card rc
  where rc.role_code = '8000.50.01' and rc.currency_code = 'USD'
  order by rc.rate_card_id
  limit 1;
  insert into app.pay_periods (org_id, starts_on, ends_on) values (c_org, date '2027-03-08', date '2027-03-21')
    returning id into v_period;
  insert into app.payroll_runs (pay_period_id, currency_code) values (v_period, 'USD');

  -- Field Lead: accepts the assigned shifts, asks to swap one, works two days, submits the week and
  -- requests time off.
  perform set_config('request.jwt.claims', json_build_object('sub', c_field, 'role', 'authenticated')::text, true);
  perform app.accept_shift(v_shift1, 'See you at load-in.');
  perform app.accept_shift(v_shift2, 'Confirmed.');
  insert into app.shift_swaps (shift_id, project_id, requested_by_membership_id, proposed_membership_id)
  values (v_shift2, c_project, c_field_m, c_admin_m);
  insert into app.time_entries (project_id, membership_id, shift_id, clock_in, clock_out, break_minutes, source)
  values
    (c_project, c_field_m, v_shift1, timestamptz '2027-03-12 07:55-05', timestamptz '2027-03-12 18:10-05', 30, 'Mobile'),
    (c_project, c_field_m, v_shift2, timestamptz '2027-03-13 08:02-05', timestamptz '2027-03-13 17:45-05', 30, 'Mobile');
  insert into app.timesheets (project_id, membership_id, period_start, period_end)
  values (c_project, c_field_m, date '2027-03-08', date '2027-03-14') returning id into v_sheet;
  perform app.submit_timesheet(v_sheet, 'Opening weekend hours.');
  insert into app.time_off_requests (time_off_policy_id, membership_id, starts_on, ends_on, hours)
  values (v_policy, c_field_m, date '2027-04-05', date '2027-04-06', 16);

  -- Producer approves the timesheet (neither the worker nor the submitter).
  perform set_config('request.jwt.claims', json_build_object('sub', c_producer, 'role', 'authenticated')::text, true);
  perform app.decide_timesheet(v_sheet, 'Approved', 'Matches the call sheet.');

  perform set_config('request.jwt.claims', '', true);
end;
$$;
