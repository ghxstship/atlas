-- 0115_finance.sql
-- A15 Finance and Reports (Section 19.6: the demo tenant exercises the feature). On the demo project
-- (NWS, Northwind Summer Series):
--   * three cost centers (CC-VENUE, CC-CORP and CC-NWS-S01 for the Opening Night show)
--   * accounting periods for August to December 2026; August is Closed, so a posting into it is refused
--   * spend authority for the Owner, Admin and Manager roles on expenses, change orders, invoice
--     approvals and contracts, with a dual approval threshold
--   * the gate 3 baseline budget and a working budget built from catalog elements at the Base, Elevated
--     and Premium grades with canon prices, one unpriced line, a labor line and a priced contingency
--   * expenses Approved (posted to the ledger), Proposed (waiting on the Owner) and Rejected
--   * a change order approved into the working budget, and one raised without a price (stored unpriced)
--   * a payable invoice from Coastline Freight Lines approved and posted, a payment against it, and a
--     receivable invoice drafted for Demo Staging Supply
--   * a manual accrual prepared by the Producer, waiting for someone else to post it
--   * a settlement drafted for the Demo Staging Supply engagement, and a USD to EUR exchange rate
-- Writes run through the tables and RPCs the app uses, as the person who would make them. Guarded on the
-- demo project (A07's 0107), the memberships (A30's 0010) and A28's vendor engagement (0228), and
-- idempotent: nothing runs once the CC-VENUE cost center exists. Fixed ids use the 0115 block.

do $$
declare
  c_org constant uuid := '01920000-0000-7000-8000-000000000001';
  c_project constant uuid := '01920000-0000-7000-8000-000000001001';
  c_owner constant uuid := '01920000-0000-7000-8000-000000000101';
  c_admin constant uuid := '01920000-0000-7000-8000-000000000102';
  c_producer constant uuid := '01920000-0000-7000-8000-000000000103';
  c_vendor_engagement constant uuid := '01920000-0000-7000-8000-000000228402';
  c_vendor_counterparty constant uuid := '01920000-0000-7000-8000-000000228801';
  c_cc_venue constant uuid := '01920000-0000-7000-8000-000000115001';
  c_cc_corp constant uuid := '01920000-0000-7000-8000-000000115002';
  c_cc_show constant uuid := '01920000-0000-7000-8000-000000115003';
  c_period_aug constant uuid := '01920000-0000-7000-8000-000000115011';
  c_baseline constant uuid := '01920000-0000-7000-8000-000000115021';
  c_working constant uuid := '01920000-0000-7000-8000-000000115022';
  c_expense_approved constant uuid := '01920000-0000-7000-8000-000000115031';
  c_expense_waiting constant uuid := '01920000-0000-7000-8000-000000115032';
  c_expense_rejected constant uuid := '01920000-0000-7000-8000-000000115033';
  c_co_approved constant uuid := '01920000-0000-7000-8000-000000115041';
  c_co_unpriced constant uuid := '01920000-0000-7000-8000-000000115042';
  c_invoice_payable constant uuid := '01920000-0000-7000-8000-000000115051';
  c_invoice_receivable constant uuid := '01920000-0000-7000-8000-000000115052';
  c_payment constant uuid := '01920000-0000-7000-8000-000000115061';
  c_settlement constant uuid := '01920000-0000-7000-8000-000000115071';
  v_freight uuid;
  v_show_node uuid;
  v_role_owner uuid;
  v_role_admin uuid;
  v_role_manager uuid;
  v_line_stage uuid;
  v_line_sound uuid;
  v_line_contingency uuid;
  v_month date;
  v_doc text;
begin
  if not exists (select 1 from app.projects where id = c_project)
     or not exists (select 1 from app.memberships where id = '01920000-0000-7000-8000-00000000a103')
     or exists (select 1 from app.cost_centers where id = c_cc_venue) then
    return;
  end if;

  select c.id into v_freight from app.counterparties c join app.organizations o on o.id = c.organization_id
  where c.org_id = c_org and o.name = 'Coastline Freight Lines' limit 1;
  select n.id into v_show_node from app.scope_nodes n where n.project_id = c_project and n.scope_code = 'NWS-S01';
  select r.id into v_role_owner from app.roles r where r.org_id is null and r.code = 'owner';
  select r.id into v_role_admin from app.roles r where r.org_id is null and r.code = 'admin';
  select r.id into v_role_manager from app.roles r where r.org_id is null and r.code = 'manager';

  -- Cost centers, periods and spend authority (Owner) ---------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);
  insert into app.cost_centers (id, org_id, code, name, kind, scope_node_id, template_id) values
    (c_cc_venue, c_org, 'CC-VENUE', 'Venue Standing Operations', 'Standing', null, 'CC-VENUE'),
    (c_cc_corp, c_org, 'CC-CORP', 'Corporate Governance', 'Overhead', null, 'CC-CORP');
  if v_show_node is not null then
    insert into app.cost_centers (id, org_id, code, name, kind, scope_node_id)
    values (c_cc_show, c_org, 'CC-NWS-S01', 'Opening Night Concert', 'Event', v_show_node);
  end if;

  insert into app.accounting_periods (id, org_id, starts_on, ends_on) values (c_period_aug, c_org, '2026-08-01', '2026-08-31');
  for v_month in select generate_series('2026-09-01'::date, '2026-12-01'::date, interval '1 month')::date loop
    insert into app.accounting_periods (org_id, starts_on, ends_on) values (c_org, v_month, (v_month + interval '1 month' - interval '1 day')::date);
  end loop;
  perform app.transition_accounting_period(c_period_aug, 'Open', 'In Period', 'August is under way.');
  perform app.transition_accounting_period(c_period_aug, 'In Period', 'Closing', 'Month end close started.');
  perform app.transition_accounting_period(c_period_aug, 'Closing', 'Closed', 'August is reconciled and closed.');
  perform app.transition_accounting_period(p.id, 'Open', 'In Period', 'The month is under way.')
  from app.accounting_periods p where p.org_id = c_org and p.starts_on in ('2026-09-01', '2026-10-01');

  insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor, dual_approval_above_minor)
  select c_org, r.id, d.doc::app.spend_document_type, 'USD', r.limit_minor, r.dual
  from (values (v_role_admin, 5000000::bigint, 2500000::bigint), (v_role_manager, 1000000::bigint, null::bigint)) as r (id, limit_minor, dual)
  cross join (values ('Expense'), ('Change Order'), ('Invoice Approval'), ('Contract')) as d (doc);

  insert into app.fx_rates (org_id, base_currency, quote_currency, rate, effective_on, source)
  values (c_org, 'USD', 'EUR', 0.9180, '2026-10-01', 'Demo treasury rate sheet');

  -- The Owner's own limit is set by the Admin (a person never sets a limit that applies to themselves).
  perform set_config('request.jwt.claims', json_build_object('sub', c_admin, 'role', 'authenticated')::text, true);
  insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor, dual_approval_above_minor)
  select c_org, v_role_owner, d.doc::app.spend_document_type, 'USD', 25000000, 10000000
  from (values ('Expense'), ('Change Order'), ('Invoice Approval'), ('Contract')) as d (doc);

  -- Budgets (Producer) ------------------------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', c_producer, 'role', 'authenticated')::text, true);
  insert into app.budgets (id, org_id, project_id, name, currency_code, is_baseline) values
    (c_baseline, c_org, c_project, 'Gate 3 Baseline', 'USD', true),
    (c_working, c_org, c_project, 'Working Budget', 'USD', false);

  insert into app.budget_lines (org_id, budget_id, line_number, description, line_type, urid, cost_center_id, grade_code,
    element_id, quantity, unit_basis, unit_price_minor, xyz, xyz_basis)
  select c_org, b.budget_id, x.n, x.description, x.line_type::app.budget_line_type, e.urid,
    case when x.event then coalesce((select id from app.cost_centers where id = c_cc_show), c_cc_venue) else c_cc_venue end,
    x.grade, e.element_id, x.qty,
    (select a.alias from xpms.dim_unit_alias a where a.alias = e.unit_basis),
    (select pb.amount_minor from xpms.element_price_bands pb
      where pb.element_id = e.element_id and pb.grade_code = x.grade and pb.currency_code = 'USD' limit 1),
    e.xyz,
    case when (select c.xyz from xpms.dim_category c where c.cat_urid = e.urid) = e.xyz then 'Category' else 'Declared' end::app.xyz_basis
  from (values
    (1, '3000.05.01-GHXST-001', 'IMAG camera for the main stage.', 'Cost', 'elevated', 2, true),
    (2, '5000.10.01-XPMS-002', 'Headline DJ package.', 'Cost', 'premium', 1, true),
    (3, '5000.02.01-GHXST-007', 'Bistro string lights across the lawn.', 'Cost', 'base', 40, false),
    (4, '4000.01.01-GHXST-023', 'Telehandler for load-in.', 'Cost', 'base', 3, false),
    (5, '4000.09.01-XPMS-005', 'General install labor and scenic finishes.', 'Cost', 'base', 1, false),
    (6, '6000.06.02-XPMS-001', 'Guard booth for the back gate.', 'Cost', 'base', 1, false)
  ) as x (n, element_id, description, line_type, grade, qty, event)
  join xpms.elements e on e.element_id = x.element_id
  cross join (values (c_baseline), (c_working)) as b (budget_id);

  insert into app.budget_lines (org_id, budget_id, line_number, description, line_type, urid, cost_center_id, quantity,
    unit_price_minor, xyz, xyz_basis)
  select c_org, b.budget_id, x.n, x.description, x.line_type::app.budget_line_type, x.urid, x.cc, x.qty, x.price,
    x.xyz::xpms.xyz_tag, 'Declared'
  from (values
    (7, 'Stagehand labor for load-in and strike.', 'Labor', '5000.04', c_cc_venue, 24, 4500, 'Y'),
    (8, 'Production management fee.', 'Fee', '0000.01', c_cc_corp, 1, 1500000, 'Y'),
    (9, 'Production contingency.', 'Contingency', '0000.01', c_cc_corp, 1, 2000000, 'Y')
  ) as x (n, description, line_type, urid, cc, qty, price, xyz)
  cross join (values (c_baseline), (c_working)) as b (budget_id);

  select id into v_line_stage from app.budget_lines where budget_id = c_working and line_number = 4;
  select id into v_line_sound from app.budget_lines where budget_id = c_working and line_number = 2;
  select id into v_line_contingency from app.budget_lines where budget_id = c_working and line_number = 9;

  insert into app.contingency_draws (org_id, from_budget_line_id, to_budget_line_id, amount_minor, reason)
  values (c_org, v_line_contingency, v_line_stage, 250000, 'Extra telehandler day after the wind delay.');

  -- Expenses (Producer submits, the Owner decides) ------------------------------------------------------------------
  insert into app.expenses (id, org_id, budget_line_id, counterparty_id, description, incurred_on, amount_minor, currency_code) values
    (c_expense_approved, c_org, v_line_stage, v_freight, 'Telehandler delivery and pickup.', '2026-10-05', 185000, 'USD'),
    (c_expense_waiting, c_org, v_line_stage, v_freight, 'Telehandler fuel top-up.', '2026-10-09', 32000, 'USD'),
    (c_expense_rejected, c_org, v_line_sound, null, 'Duplicate DJ deposit.', '2026-10-02', 50000, 'USD');

  -- Change orders (Producer requests and prices) --------------------------------------------------------------------
  insert into app.change_orders (id, org_id, project_id, budget_id, title, order_type_enum_id, reason) values
    (c_co_approved, c_org, c_project, c_working, 'Add a second IMAG screen', 'ENM-092', 'The client asked for a second screen at the lawn.'),
    (c_co_unpriced, c_org, c_project, c_working, 'Extend the stage apron', 'ENM-092', 'The headliner rider asks for a deeper apron.');
  insert into app.change_order_lines (org_id, change_order_id, budget_line_id, description, urid, quantity, unit_price_minor) values
    (c_org, c_co_approved, null, 'Second IMAG screen and camera feed.', '3000.05.01', 1, 425000),
    (c_org, c_co_unpriced, null, 'Stage apron extension, 8 ft x 32 ft.', '4000.01.01', 1, null);
  perform app.price_change_order(c_co_approved, 'Priced from the vendor quote.');

  -- Invoices, payment and a prepared accrual (Producer) ---------------------------------------------------------------
  if v_freight is not null then
    insert into app.invoices (id, org_id, project_id, direction, counterparty_id, invoice_number, issued_on, due_on, currency_code)
    values (c_invoice_payable, c_org, c_project, 'Payable', v_freight, 'CFL-20481', '2026-10-06', '2026-11-05', 'USD');
    insert into app.invoice_lines (org_id, invoice_id, line_number, description, quantity, unit_price_minor, budget_line_id) values
      (c_org, c_invoice_payable, 1, 'Freight for staging and lighting.', 1, 240000, v_line_stage);
  end if;
  if exists (select 1 from app.counterparties where id = c_vendor_counterparty) then
    insert into app.invoices (id, org_id, project_id, direction, counterparty_id, invoice_number, currency_code)
    values (c_invoice_receivable, c_org, c_project, 'Receivable', c_vendor_counterparty, 'NWS-1001', 'USD');
    insert into app.invoice_lines (org_id, invoice_id, line_number, description, quantity, unit_price_minor, urid) values
      (c_org, c_invoice_receivable, 1, 'Sponsored lounge activation fee.', 1, 600000, '7000.01'),
      (c_org, c_invoice_receivable, 2, 'Branded bar wrap.', 1, null, '7000.01');
  end if;

  insert into app.journal_entries (org_id, accounting_period_id, project_id, entry_date, memo)
  select c_org, p.id, c_project, '2026-10-12', 'Accrue October venue power.'
  from app.accounting_periods p where p.org_id = c_org and p.starts_on = '2026-10-01'
  returning id into v_doc;
  insert into app.journal_lines (org_id, journal_entry_id, line_number, account_code, cost_center_id, urid, description, debit_minor, credit_minor, currency_code) values
    (c_org, v_doc::uuid, 1, '5600', c_cc_venue, '6000.01', 'October venue power.', 140000, 0, 'USD'),
    (c_org, v_doc::uuid, 2, '2100', c_cc_venue, null, 'October venue power.', 0, 140000, 'USD');

  if exists (select 1 from app.engagements where id = c_vendor_engagement) then
    insert into app.settlements (id, org_id, engagement_id, project_id, title, currency_code, settled_on)
    values (c_settlement, c_org, c_vendor_engagement, c_project, 'Staging supply settlement', 'USD', '2026-09-28');
    insert into app.settlement_lines (org_id, settlement_id, line_number, line_kind, description, amount_minor) values
      (c_org, c_settlement, 1, 'Guarantee', 'Agreed staging supply fee.', 900000),
      (c_org, c_settlement, 2, 'Expense', 'Overnight security for the staging yard.', 45000),
      (c_org, c_settlement, 3, 'Deduction', 'Damaged deck panel.', null);
  end if;

  -- Decisions (Owner) ---------------------------------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', c_owner, 'role', 'authenticated')::text, true);
  perform app.approve_expense(c_expense_approved, 'Matches the delivery ticket.');
  perform app.reject_expense(c_expense_rejected, 'Already paid under the DJ contract.');
  perform app.approve_change_order(c_co_approved, 'Approved within the client allowance.');
  if v_freight is not null then
    perform app.approve_invoice(c_invoice_payable, 'Freight matches the bills of lading.');
    perform set_config('request.jwt.claims', json_build_object('sub', c_producer, 'role', 'authenticated')::text, true);
    insert into app.payments (id, org_id, counterparty_id, direction, amount_minor, currency_code, paid_on, reference_identifier)
    values (c_payment, c_org, v_freight, 'Payable', 120000, 'USD', '2026-10-10', 'ACH 55120');
    -- The Owner recorded the freight vendor, so the Admin approves the payment to it (sod_vendor_payment).
    perform set_config('request.jwt.claims', json_build_object('sub', c_admin, 'role', 'authenticated')::text, true);
    perform app.approve_payment(c_payment, 'First half of the freight invoice.');
    insert into app.payment_applications (org_id, payment_id, invoice_id, amount_minor) values (c_org, c_payment, c_invoice_payable, 120000);
  end if;

  perform set_config('request.jwt.claims', '', true);
end;
$$;
