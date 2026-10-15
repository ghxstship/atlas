-- pgTAP: invoice and payroll postings to the Universal Posting Line (Section 3.11, RRR-71). Receivable
-- invoices post when Issued, payable invoices when Approved, payroll runs when Approved; a cancellation
-- reverses a standing posting; each document posts once; invariant 13 (no posting into a missing or closed
-- period) refuses the transition; the GL account comes from the URID or role class (decision D13); payroll
-- posts per role and cost center, never per person (Section 8.3); tenancy of the posted lines.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(56);

-- World -----------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.cost_centers (org_id, code, name, kind) values (pg_temp.id('org_a'), 'CC-VENUE', 'Venue Operations', 'Standing') returning id) insert into world select 'cc_venue', id from x;
with x as (insert into app.accounting_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-06-01', '2027-06-30') returning id) insert into world select 'per_jun', id from x;
with x as (insert into app.accounting_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-07-01', '2027-07-31') returning id) insert into world select 'per_jul', id from x;
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Summer Series Budget', 'USD') returning id) insert into world select 'bud_a', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, cost_center_id, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud_a'), 1, 'Sponsorship activation.', '0000.01.01', pg_temp.id('cc_venue'), 1, 50000, 'X', 'Declared') returning id) insert into world select 'line_exec', id from x;
with x as (insert into app.tax_jurisdictions (org_id, jurisdiction_id, name) values (pg_temp.id('org_a'), 'US-FL', 'Florida Department of Revenue') returning id) insert into world select 'tj', id from x;
with x as (insert into app.tax_rates (tax_jurisdiction_id, tax_type, rate_percent, effective_from) values (pg_temp.id('tj'), 'Tax on Sales', 6, '2027-01-01') returning id) insert into world select 'tax6', id from x;
insert into world values ('cp_client', app.create_counterparty(pg_temp.id('org_a'), 'Lakeshore Brands', null));
insert into world values ('cp_vendor', app.create_counterparty(pg_temp.id('org_a'), 'Pier Rigging Co', 'Rigging Engineering'));
select pg_temp.as_user('alice');
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor) values
  (pg_temp.id('org_a'), pg_temp.system_role('admin'), 'Invoice Approval', 'USD', 10000000),
  (pg_temp.id('org_a'), pg_temp.system_role('admin'), 'Payroll Run', 'USD', 10000000);
select pg_temp.as_user('bob');
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor) values
  (pg_temp.id('org_a'), pg_temp.system_role('owner'), 'Invoice Approval', 'USD', 10000000);
select pg_temp.as_platform();

-- Receivable invoice posts when Issued ---------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.invoices (project_id, direction, counterparty_id, invoice_number, currency_code, issued_on)
  values (pg_temp.id('prj_a'), 'Receivable', pg_temp.id('cp_client'), 'NWL-INV-101', 'USD', '2027-06-10') returning id) insert into world select 'inv_r', id from x;
insert into app.invoice_lines (invoice_id, line_number, description, quantity, unit_price_minor, budget_line_id, tax_rate_id)
  values (pg_temp.id('inv_r'), 1, 'Activation fee.', 2, 10000, pg_temp.id('line_exec'), pg_temp.id('tax6'));
insert into app.invoice_lines (invoice_id, line_number, description, quantity, unit_price_minor, urid)
  values (pg_temp.id('inv_r'), 2, 'Hospitality package.', 1, 5000, '0000.01.01');
select throws_ok($$insert into app.invoice_lines (invoice_id, line_number, description, unit_price_minor, urid) values ((select id from world where key = 'inv_r'), 3, 'Bad.', 1, '9999.99.99')$$,
  'XR001', null, 'an invoice line''s dimension 2 is a canon URID');
select lives_ok($$select app.issue_invoice((select id from world where key = 'inv_r'), 'Sent to the client.')$$, 'the receivable is issued');
select pg_temp.as_platform();
select is((select count(*)::int from app.posting_lines where external_ref = pg_temp.id('inv_r')), 4, 'issuing posted revenue, tax, revenue and receivable lines');
select is((select sum(amount_minor)::bigint from app.posting_lines where external_ref = pg_temp.id('inv_r')), 0::bigint, 'the posting balances');
select is((select amount_minor from app.posting_lines where external_ref = pg_temp.id('inv_r') and account_code = '1100'), 26200::bigint, 'Accounts Receivable is debited with the total including tax');
select is((select sum(amount_minor)::bigint from app.posting_lines where external_ref = pg_temp.id('inv_r') and account_code = '4000'), -25000::bigint, 'the earning class revenue account is credited (decision D13)');
select is((select amount_minor from app.posting_lines where external_ref = pg_temp.id('inv_r') and account_code = '2300'), -1200::bigint, 'tax is credited to Sales Tax Payable');
select is((select cost_center_id from app.posting_lines where external_ref = pg_temp.id('inv_r') and account_code = '2300'), 'CC-VENUE', 'a line on a budget line carries its cost center');
select is((select count(*)::int from app.posting_lines where external_ref = pg_temp.id('inv_r') and vendor_id = pg_temp.id('cp_client')), 4, 'every line names the client');
select is((select date from app.posting_lines where external_ref = pg_temp.id('inv_r') and account_code = '1100'), '2027-06-10'::date, 'the posting is dated the issue date');
select is((select e.prepared_by from app.journal_entries e where e.source_id = pg_temp.id('inv_r')), null::uuid, 'the platform prepared the entry');
select is((select e.posted_by from app.journal_entries e where e.source_id = pg_temp.id('inv_r')), pg_temp.id('carol'), 'the person who issued it posted it');
select is((select count(*)::int from app.domain_events d join app.journal_entries e on e.id = d.subject_id where d.event_type = 'journal.posted' and e.source_id = pg_temp.id('inv_r')), 1, 'journal.posted was emitted');

-- Refusals that keep the invoice Proposed
select pg_temp.as_user('carol');
with x as (insert into app.invoices (project_id, direction, counterparty_id, currency_code, issued_on)
  values (pg_temp.id('prj_a'), 'Receivable', pg_temp.id('cp_client'), 'USD', '2027-06-11') returning id) insert into world select 'inv_noclass', id from x;
insert into app.invoice_lines (invoice_id, line_number, description, unit_price_minor, urid) values (pg_temp.id('inv_noclass'), 1, 'Stage build.', 1000, '5000.01.01');
select throws_ok($$select app.issue_invoice((select id from world where key = 'inv_noclass'), 'Send.')$$,
  'XR001', 'gl_account_unresolved: No revenue account resolves for 5000.01.01; bill revenue under an earning class.', 'revenue posts only under an earning class');
with x as (insert into app.invoices (project_id, direction, counterparty_id, currency_code, issued_on)
  values (pg_temp.id('prj_a'), 'Receivable', pg_temp.id('cp_client'), 'USD', '2027-06-11') returning id) insert into world select 'inv_nodim', id from x;
insert into app.invoice_lines (invoice_id, line_number, description, unit_price_minor) values (pg_temp.id('inv_nodim'), 1, 'Miscellaneous.', 1000);
select throws_ok($$select app.issue_invoice((select id from world where key = 'inv_nodim'), 'Send.')$$,
  'XR001', 'invoice_line_dimension_missing: Give every invoice line a URID or a budget line before it posts.', 'a line without dimension 2 does not post');
with x as (insert into app.invoices (project_id, direction, counterparty_id, currency_code, issued_on)
  values (pg_temp.id('prj_a'), 'Receivable', pg_temp.id('cp_client'), 'USD', '2028-02-01') returning id) insert into world select 'inv_noperiod', id from x;
insert into app.invoice_lines (invoice_id, line_number, description, unit_price_minor, urid) values (pg_temp.id('inv_noperiod'), 1, 'Retainer.', 1000, '0000.01.01');
select throws_ok($$select app.issue_invoice((select id from world where key = 'inv_noperiod'), 'Send.')$$,
  'XR001', 'period_missing: No accounting period covers 2028-02-01; open one before posting.', 'an issue date without a period refuses the issue (invariant 13)');
select pg_temp.as_platform();
select is((select string_agg(invoice_state::text, ',') from app.invoices where id in (pg_temp.id('inv_noclass'), pg_temp.id('inv_nodim'), pg_temp.id('inv_noperiod'))), 'Proposed,Proposed,Proposed', 'a refused posting leaves the invoice Proposed');
select is((select count(*)::int from app.journal_entries where source_id in (pg_temp.id('inv_noclass'), pg_temp.id('inv_nodim'), pg_temp.id('inv_noperiod'))), 0, 'and writes no entry');

-- Cancellation reverses
select pg_temp.as_user('carol');
select lives_ok($$select app.transition_invoice((select id from world where key = 'inv_r'), 'Issued', 'Canceled', 'Billed in error.')$$, 'an issued receivable is canceled');
select pg_temp.as_platform();
select is((select count(*)::int from app.journal_entries where source_id = pg_temp.id('inv_r') and journal_state = 'Posted'), 2, 'cancellation posted one reversing entry');
select is((select sum(amount_minor)::bigint from app.posting_lines where external_ref = pg_temp.id('inv_r') and account_code = '1100'), 0::bigint, 'the receivable nets to zero');
select is((select date from app.posting_lines where external_ref = pg_temp.id('inv_r') and account_code = '1100' and amount_minor < 0), '2027-06-10'::date, 'the reversal is dated in the original period while it is open');
select is((select count(*)::int from app.domain_events where event_type = 'invoice.canceled' and subject_id = pg_temp.id('inv_r')), 1, 'invoice.canceled was emitted');
select is((select count(*)::int from app.journal_entries where source_id = pg_temp.id('inv_noclass')), 0, 'canceling an unposted invoice reverses nothing');

-- Payable invoice posts when fully Approved, once ---------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.invoices (project_id, direction, counterparty_id, invoice_number, currency_code, issued_on)
  values (pg_temp.id('prj_a'), 'Payable', pg_temp.id('cp_vendor'), 'PRC-9001', 'USD', '2027-07-03') returning id) insert into world select 'inv_p', id from x;
insert into app.invoice_lines (invoice_id, line_number, description, quantity, unit_price_minor, urid, tax_rate_id)
  values (pg_temp.id('inv_p'), 1, 'Rigging labor.', 1, 40000, '5000.01.01', pg_temp.id('tax6'));
select pg_temp.as_user('alice');
select is(app.approve_invoice(pg_temp.id('inv_p'), 'Work received.'), true, 'the payable is approved');
select pg_temp.as_platform();
select is((select amount_minor from app.posting_lines where external_ref = pg_temp.id('inv_p') and account_code = '5500'), 42400::bigint, 'the class expense account is debited with the amount and its tax');
select is((select amount_minor from app.posting_lines where external_ref = pg_temp.id('inv_p') and account_code = '2000'), -42400::bigint, 'Accounts Payable is credited');
select is((select e.posted_by from app.journal_entries e where e.source_id = pg_temp.id('inv_p')), pg_temp.id('alice'), 'the approver posted it');
select pg_temp.as_user('carol');
select lives_ok($$select app.transition_invoice((select id from world where key = 'inv_p'), 'Approved', 'Disputed', 'Short shipment.')$$, 'the approved payable is disputed');
select pg_temp.as_user('bob');
select is(app.approve_invoice(pg_temp.id('inv_p'), 'Resolved.'), true, 'and approved again');
select pg_temp.as_platform();
select is((select count(*)::int from app.journal_entries where source_id = pg_temp.id('inv_p')), 1, 'a re-approval never posts twice');
select pg_temp.as_user('carol');
select lives_ok($$select app.transition_invoice((select id from world where key = 'inv_p'), 'Approved', 'Disputed', 'Vendor withdrew.')$$, 'disputed again');
select lives_ok($$select app.transition_invoice((select id from world where key = 'inv_p'), 'Disputed', 'Canceled', 'Vendor credit.')$$, 'and canceled');
select pg_temp.as_platform();
select is((select sum(amount_minor)::bigint from app.posting_lines where external_ref = pg_temp.id('inv_p') and account_code = '2000'), 0::bigint, 'the canceled payable nets to zero');

-- Closed period refuses the approval (invariant 13)
select pg_temp.as_user('carol');
with x as (insert into app.invoices (project_id, direction, counterparty_id, currency_code, issued_on)
  values (pg_temp.id('prj_a'), 'Payable', pg_temp.id('cp_vendor'), 'USD', '2027-06-20') returning id) insert into world select 'inv_late', id from x;
insert into app.invoice_lines (invoice_id, line_number, description, unit_price_minor, urid) values (pg_temp.id('inv_late'), 1, 'Late rigging bill.', 3000, '5000.01.01');
select app.transition_accounting_period(pg_temp.id('per_jun'), 'Open', 'In Period', 'June.');
select app.transition_accounting_period(pg_temp.id('per_jun'), 'In Period', 'Closing', 'Month end.');
select app.transition_accounting_period(pg_temp.id('per_jun'), 'Closing', 'Closed', 'Closed.');
select pg_temp.as_user('alice');
select throws_ok($$select app.approve_invoice((select id from world where key = 'inv_late'), 'Pay.')$$,
  'XR001', null, 'a payable dated in a closed period cannot post, so it is not approved');
select pg_temp.as_platform();
select is((select invoice_state::text from app.invoices where id = pg_temp.id('inv_late')), 'Proposed', 'the invoice stays Proposed');
select is((select count(*)::int from app.spend_approvals where document_id = pg_temp.id('inv_late')), 0, 'and no approval was recorded');

-- Payroll posts per role and cost center when Approved --------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.pay_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-07-05', '2027-07-18') returning id) insert into world select 'pp', id from x;
select pg_temp.as_user('bob');
with x as (insert into app.earning_codes (org_id, code, name) values (pg_temp.id('org_a'), 'REG', 'Regular') returning id) insert into world select 'ec', id from x;
select pg_temp.as_user('carol');
with x as (insert into app.payroll_runs (pay_period_id, currency_code) values (pg_temp.id('pp'), 'USD') returning id) insert into world select 'run', id from x;
insert into app.payroll_lines (payroll_run_id, membership_id, earning_code_id, hours, rate_minor, role_code, cost_center_id) values
  (pg_temp.id('run'), pg_temp.id('frank@org_a'), pg_temp.id('ec'), 10, 3000, '5000.50.01', pg_temp.id('cc_venue')),
  (pg_temp.id('run'), pg_temp.id('dave@org_a'), pg_temp.id('ec'), 5, 3000, '5000.50.01', pg_temp.id('cc_venue')),
  (pg_temp.id('run'), pg_temp.id('erin@org_a'), pg_temp.id('ec'), 2, 5000, '1000.50.01', null);
with x as (insert into app.payroll_runs (pay_period_id, currency_code) values (pg_temp.id('pp'), 'USD') returning id) insert into world select 'run_norole', id from x;
insert into app.payroll_lines (payroll_run_id, membership_id, earning_code_id, hours, rate_minor) values
  (pg_temp.id('run_norole'), pg_temp.id('frank@org_a'), pg_temp.id('ec'), 1, 3000);
select app.transition_payroll_run(pg_temp.id('run'), 'Draft', 'Calculated', 'Calculated.');
select app.transition_payroll_run(pg_temp.id('run_norole'), 'Draft', 'Calculated', 'Calculated.');
select is((select role_code from app.payroll_line_amounts where membership_id = pg_temp.id('frank@org_a') and payroll_run_id = pg_temp.id('run')), '5000.50.01', 'payroll lines carry their canon role');
select pg_temp.as_user('xavier');
with x as (insert into app.cost_centers (org_id, code, name, kind) values (pg_temp.id('org_b'), 'CC-DOCK', 'Dock', 'Standing') returning id) insert into world select 'cc_b', id from x;
select pg_temp.as_user('carol');
select throws_ok($$update app.payroll_lines set cost_center_id = (select id from world where key = 'cc_b') where payroll_run_id = (select id from world where key = 'run_norole')$$,
  'XR001', null, 'a payroll line cannot post to another org''s cost center');
select pg_temp.as_user('bob');
select throws_ok($$select app.approve_payroll_run((select id from world where key = 'run_norole'), 'Approve.')$$,
  'XR001', 'payroll_line_role_missing: Give every paid payroll line its canon role before the run posts.', 'a paid line without a role refuses the approval');
select is(app.approve_payroll_run(pg_temp.id('run'), 'Approved.'), true, 'the run is approved');
select pg_temp.as_platform();
select is((select count(*)::int from app.posting_lines where external_ref = pg_temp.id('run')), 3, 'two role groups and the payable posted');
select is((select amount_minor from app.posting_lines where external_ref = pg_temp.id('run') and account_code = '5500'), 45000::bigint, 'labor of one role and cost center is summed, never shown per person');
select is((select amount_minor from app.posting_lines where external_ref = pg_temp.id('run') and account_code = '5100'), 10000::bigint, 'each role class posts to its own expense account');
select is((select amount_minor from app.posting_lines where external_ref = pg_temp.id('run') and account_code = '2100'), -55000::bigint, 'Accrued Liabilities is credited with the run total');
select is((select urid from app.posting_lines where external_ref = pg_temp.id('run') and account_code = '5500'), '5000.50', 'dimension 2 is the role''s canon discipline');
select is((select date from app.posting_lines where external_ref = pg_temp.id('run') and account_code = '2100'), '2027-07-18'::date, 'the run posts on the last day of its pay period');
select is((select count(*)::int from app.posting_lines where external_ref = pg_temp.id('run') and description like '%Frank%'), 0, 'no posting line names a person');
select pg_temp.as_user('carol');
select lives_ok($$select app.transition_payroll_run((select id from world where key = 'run'), 'Approved', 'Exported', 'Sent to provider.')$$, 'Approved to Exported');
select lives_ok($$select app.transition_payroll_run((select id from world where key = 'run'), 'Exported', 'Approved', 'Provider rejected the file.')$$, 'Exported back to Approved');
select pg_temp.as_platform();
select is((select count(*)::int from app.journal_entries where source_id = pg_temp.id('run')), 1, 'returning to Approved never posts twice');
select pg_temp.as_user('carol');
select lives_ok($$select app.transition_payroll_run((select id from world where key = 'run'), 'Approved', 'Canceled', 'Run replaced.')$$, 'the run is canceled');
select pg_temp.as_platform();
select is((select sum(amount_minor)::bigint from app.posting_lines where external_ref = pg_temp.id('run') and account_code = '2100'), 0::bigint, 'the canceled run nets to zero');

-- Tenancy of posted lines ---------------------------------------------------------------------------------
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.posting_lines where org_id = pg_temp.id('org_a')), 0, 'another org reads none of the postings');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.posting_lines), 0, 'a Viewer without finance.journal.read reads none');
select pg_temp.as_user('carol');
select throws_ok($$insert into app.journal_lines (journal_entry_id, line_number, account_code, description, debit_minor, currency_code) values ((select id from app.journal_entries where source_id = (select id from world where key = 'inv_p') limit 1), 9, '5000', 'Tamper.', 1, 'USD')$$,
  'XR001', null, 'a posted document entry never changes');
select pg_temp.as_platform();

select * from finish();
rollback;
