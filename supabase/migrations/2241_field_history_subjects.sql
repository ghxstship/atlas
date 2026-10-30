-- 2241_field_history_subjects.sql
--
-- A131 (RRR-177, S4.10-04, ADR 0090). Section 4.10: "a history tab on every record". 1452 offered field history for
-- eight tables (records, shifts, invoices, asset units, SOPs, documents, purchase orders and vendors) and 2100 added
-- custom object records. Every other entity with a record page or peek in Atlas had none, the per diems of R1's Crew
-- page included (app.per_diems dates from 0341). This migration lists them in private.field_history_subjects, so
-- app.field_history answers for their rows (each table's own read policies decide who reads it, and Restricted
-- columns never reach a diff), and gives the ones without an audit trail one.
--
-- app.time_entries is listed too: A130 partitioned it (2231), and since 2230 its audit events name the parent table,
-- so its history reads the parent's events under the parent's read policies.
--
-- Left out: app.form_submissions, whose answers are submitted once and may hold what a form asks about a person, so
-- they stay out of the ledger; and app.projects, whose page is the project overview rather than a record page.

-- 1. Audit trails for the subjects that had none ---------------------------------------------------------------------------

call private.install_audit_trail('app.accommodation_blocks');
call private.install_audit_trail('app.advance_packets');
call private.install_audit_trail('app.advance_submissions');
call private.install_audit_trail('app.asset_classes');
call private.install_audit_trail('app.asset_damage');
call private.install_audit_trail('app.asset_lots');
call private.install_audit_trail('app.asset_maintenance');
call private.install_audit_trail('app.beos');
call private.install_audit_trail('app.call_sheets');
call private.install_audit_trail('app.capability_documents');
call private.install_audit_trail('app.day_sheets');
call private.install_audit_trail('app.dock_slots');
call private.install_audit_trail('app.feed_posts');
call private.install_audit_trail('app.fulfillments');
call private.install_audit_trail('app.groups');
call private.install_audit_trail('app.guest_list_entries');
call private.install_audit_trail('app.handbook_articles');
call private.install_audit_trail('app.inspection_templates');
call private.install_audit_trail('app.inspections');
call private.install_audit_trail('app.lost_found_items');
call private.install_audit_trail('app.permit_requirements');
call private.install_audit_trail('app.reconciliations');
call private.install_audit_trail('app.riders');
call private.install_audit_trail('app.run_of_show');
call private.install_audit_trail('app.schedule_baselines');
call private.install_audit_trail('app.shipments');
call private.install_audit_trail('app.site_plans');
call private.install_audit_trail('app.spaces');
call private.install_audit_trail('app.venues');
call private.install_audit_trail('app.work_orders');
call private.install_audit_trail('app.workforce_events');
call private.install_audit_trail('app.zones');

-- 2. The subjects --------------------------------------------------------------------------------------------------------------

insert into private.field_history_subjects (table_name) values
  -- Finance
  ('app.accounting_periods'),
  ('app.budgets'),
  ('app.change_orders'),
  ('app.cost_centers'),
  ('app.expenses'),
  ('app.journal_entries'),
  ('app.payments'),
  ('app.settlements'),
  -- People, crew and opportunities
  ('app.agreements'),
  ('app.applications'),
  ('app.engagements'),
  ('app.offers'),
  ('app.opportunities'),
  ('app.pay_periods'),
  ('app.payroll_runs'),
  ('app.per_diems'),
  ('app.rate_cards'),
  ('app.requisitions'),
  ('app.shift_swaps'),
  ('app.time_entries'),
  ('app.time_off_requests'),
  ('app.timesheets'),
  -- Procurement, vendors and canon
  ('app.canon_extension_proposals'),
  ('app.catalog_bindings'),
  ('app.goods_receipts'),
  ('app.insurance_certificates'),
  ('app.invoice_matches'),
  ('app.prequalifications'),
  ('app.rfqs'),
  ('app.sponsor_entitlements'),
  ('app.submittals'),
  ('app.vendor_scorecards'),
  -- Operations
  ('app.credential_categories'),
  ('app.credentials'),
  ('app.incidents'),
  ('app.radio_channels'),
  ('app.work_orders'),
  -- Advancing, logistics and hospitality
  ('app.accommodation_blocks'),
  ('app.advance_packets'),
  ('app.advance_submissions'),
  ('app.beos'),
  ('app.dock_slots'),
  ('app.fulfillments'),
  ('app.guest_list_entries'),
  ('app.reconciliations'),
  ('app.riders'),
  ('app.shipments'),
  -- Assets
  ('app.asset_classes'),
  ('app.asset_damage'),
  ('app.asset_lots'),
  ('app.asset_maintenance'),
  -- Places and safety
  ('app.capability_documents'),
  ('app.inspection_templates'),
  ('app.inspections'),
  ('app.permit_requirements'),
  ('app.site_plans'),
  ('app.spaces'),
  ('app.venues'),
  ('app.zones'),
  -- Show and schedule
  ('app.call_sheets'),
  ('app.day_sheets'),
  ('app.run_of_show'),
  ('app.schedule_baselines'),
  -- Workforce
  ('app.feed_posts'),
  ('app.groups'),
  ('app.handbook_articles'),
  ('app.lost_found_items'),
  ('app.workforce_events')
on conflict (table_name) do nothing;
