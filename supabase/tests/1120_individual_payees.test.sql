-- pgTAP: A43 (RRR-87), migrations 1120 to 1123, finding A38-007. A person engaged as an individual is
-- self-billed from approved timesheets and accepted milestones, submits their own invoice, sees it in
-- Gateway from Submitted to Paid, and Atlas finance records the payment. Exactly one payee per invoice and
-- payment; payee guards are NULL-safe; same-tenant allow, cross-tenant deny, anon deny, role band.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(53);

-- World: ivy is engaged by org_a as an individual Crew member (Day Rate 99,000 USD), self-billing is on.
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_user('carol');
with x as (insert into app.accounting_periods (org_id, starts_on, ends_on)
  values (pg_temp.id('org_a'), date_trunc('month', current_date)::date, (date_trunc('month', current_date) + interval '1 month - 1 day')::date) returning id)
  insert into world select 'period', id from x;
select pg_temp.as_user('bob');
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor) values
  (pg_temp.id('org_a'), pg_temp.system_role('owner'), 'Invoice Approval', 'USD', 100000000);
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'finance.self_billing_enabled', 'Organization', pg_temp.id('org_a'), null, true, null, false);
with r as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis) values (pg_temp.id('prj_a'), 'Document', 'Rigging Plot', 'Y', 'Declared') returning id)
  insert into world select 'rec', id from r;
with d as (select app.add_engagement_deliverable(pg_temp.id('eng_ivy_a'), pg_temp.id('rec')) as id) insert into world select 'dlv', id from d;
select pg_temp.as_platform();
insert into app.time_entries (project_id, engagement_id, clock_in, clock_out, break_minutes)
values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), current_date - 3 + time '12:00', current_date - 3 + time '20:00', 30);
with t as (insert into app.timesheets (project_id, engagement_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), current_date - 6, current_date) returning id)
  insert into world select 'sheet', id from t;
select private.transition_lifecycle('timesheet', 'app.timesheets', 'timesheet_state', 'app.timesheet_state_transitions', 'timesheet_id',
  pg_temp.id('sheet'), 'Proposed', 'Submitted', 'Fixture.');
select private.transition_lifecycle('timesheet', 'app.timesheets', 'timesheet_state', 'app.timesheet_state_transitions', 'timesheet_id',
  pg_temp.id('sheet'), 'Submitted', 'Approved', 'Fixture.');

-- Exactly one payee (1120) -------------------------------------------------------------------------------------
select pg_temp.as_platform();
select throws_ok(format($$insert into app.invoices (project_id, direction, currency_code) values ('%s', 'Payable', 'USD')$$, pg_temp.id('prj_a')),
  '23514', null, 'an invoice without a payee is refused');
select throws_ok(format($$insert into app.invoices (project_id, direction, counterparty_id, payee_person_id, currency_code)
  values ('%s', 'Payable', '%s', '%s', 'USD')$$, pg_temp.id('prj_a'), pg_temp.id('cp_v_a'), pg_temp.id('ivy')),
  '23514', null, 'an invoice naming both a counterparty and a person is refused');
select throws_ok(format($$insert into app.invoices (project_id, direction, payee_person_id, currency_code) values ('%s', 'Payable', '%s', 'USD')$$,
  pg_temp.id('prj_a'), pg_temp.id('ivy')), '23514', null, 'a person payee needs the engagement billed');
select throws_ok(format($$insert into app.invoices (project_id, direction, payee_person_id, engagement_id, currency_code) values ('%s', 'Receivable', '%s', '%s', 'USD')$$,
  pg_temp.id('prj_a'), pg_temp.id('ivy'), pg_temp.id('eng_ivy_a')), '23514', null, 'a person is only ever a payee of a payable');
select throws_ok(format($$insert into app.invoices (project_id, direction, payee_person_id, engagement_id, currency_code) values ('%s', 'Payable', '%s', '%s', 'USD')$$,
  pg_temp.id('prj_a'), pg_temp.id('quinn'), pg_temp.id('eng_ivy_a')), 'XR001',
  'invoice_engagement_payee: The payee of an engagement invoice is the engaged party: its account, or the person when no account bills.',
  'the person payee is the engaged person');
select throws_ok(format($$insert into app.invoices (project_id, direction, counterparty_id, engagement_id, currency_code) values ('%s', 'Payable', '%s', '%s', 'USD')$$,
  pg_temp.id('prj_a'), pg_temp.id('cp_v_a'), pg_temp.id('eng_ivy_a')), 'XR001', null, 'an account cannot bill an individual''s engagement');
select throws_ok(format($$insert into app.payments (counterparty_id, payee_person_id, direction, amount_minor, currency_code, paid_on)
  values ('%s', '%s', 'Payable', 100, 'USD', current_date)$$, pg_temp.id('cp_v_a'), pg_temp.id('ivy')),
  '23514', null, 'a payment naming both payees is refused');
select throws_ok(format($$insert into app.payments (org_id, payee_person_id, direction, amount_minor, currency_code, paid_on)
  values ('%s', '%s', 'Payable', 100, 'USD', current_date)$$, pg_temp.id('org_a'), pg_temp.id('quinn')),
  'XR001', 'payment_payee_not_engaged: A payment to a person pays someone this org engages as an individual.',
  'a payment to a person the org does not engage individually is refused');
select throws_ok(format($$insert into app.payments (payee_person_id, direction, amount_minor, currency_code, paid_on)
  values ('%s', 'Payable', 100, 'USD', current_date)$$, pg_temp.id('ivy')), 'XR001', null, 'a person payment names its paying org');
select is((select count(*)::int from pg_indexes where schemaname = 'app' and indexname in
  ('invoices_payee_person_id_idx', 'invoices_engagement_id_idx', 'payments_payee_person_id_idx', 'self_billed_deliverables_deliverable_idx')), 4,
  'the new foreign keys are indexed');

-- Milestone fee (1121) -----------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok(format($$select app.set_deliverable_fee('%s', 250000)$$, pg_temp.id('dlv')), '42501', null, 'role band: a Member cannot price a milestone');
select pg_temp.as_user('xavier');
select throws_ok(format($$select app.set_deliverable_fee('%s', 250000)$$, pg_temp.id('dlv')), '42501', null, 'cross tenant: another org cannot price it');
select pg_temp.as_user('carol');
select lives_ok(format($$select app.set_deliverable_fee('%s', 250000)$$, pg_temp.id('dlv')), 'the org prices the milestone');
select throws_ok(format($$select app.set_deliverable_fee('%s', -1)$$, pg_temp.id('dlv')), '23514', null, 'a fee is never negative');
select pg_temp.as_user('ivy');
select is((select fee_minor from api_external.deliverables where id = pg_temp.id('dlv')), 250000::bigint, 'the party sees the fee');
select app.submit_deliverable(pg_temp.id('dlv'), null, 'Plot attached.');
select pg_temp.as_user('carol');
select app.decide_deliverable(pg_temp.id('dlv'), 'Approved', null);
select throws_ok(format($$select app.set_deliverable_fee('%s', 1)$$, pg_temp.id('dlv')), 'XR001',
  'deliverable_fee_fixed: An accepted milestone keeps its fee.', 'an accepted milestone keeps its fee');

-- Self-billing an individual (1122) -----------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok(format($$select app.generate_self_billed_invoice('%s', current_date - 7, current_date)$$, pg_temp.id('eng_ivy_a')), 'XR001',
  'self_billing_not_agreed: The party has not agreed to self-billing on this engagement; they agree in Gateway.', 'no agreement refuses');
select pg_temp.as_user('ivy');
select lives_ok(format($$select app.agree_self_billing('%s')$$, pg_temp.id('eng_ivy_a')), 'the individual agrees to self-billing');
select pg_temp.as_user('carol');
select lives_ok(format($$insert into world values ('sb', app.generate_self_billed_invoice('%s', current_date - 7, current_date))$$, pg_temp.id('eng_ivy_a')),
  'an individual with no account is self-billed');
select is((select payee_person_id from app.invoices where id = pg_temp.id('sb')), pg_temp.id('ivy'), 'the payee is the engaged person');
select is((select counterparty_id from app.invoices where id = pg_temp.id('sb')), null::uuid, 'with no counterparty');
select is((select engagement_id from app.invoices where id = pg_temp.id('sb')), pg_temp.id('eng_ivy_a'), 'and the engagement billed');
select is((select count(*)::int from app.invoice_lines where invoice_id = pg_temp.id('sb')), 2, 'one line for the timesheet and one for the milestone');
select is((select unit_price_minor from app.invoice_lines l join app.self_billed_deliverables b on b.invoice_line_id = l.id where l.invoice_id = pg_temp.id('sb')),
  250000::bigint, 'the milestone bills its fee');
select is((select quantity * unit_price_minor from app.invoice_lines l join app.self_billed_timesheets b on b.invoice_line_id = l.id where l.invoice_id = pg_temp.id('sb')),
  99000::numeric, 'the timesheet bills one worked day at the day rate');
select throws_ok(format($$select app.generate_self_billed_invoice('%s', current_date - 7, current_date)$$, pg_temp.id('eng_ivy_a')), 'XR001',
  'self_billing_nothing_to_bill: No approved timesheets or accepted milestones in this period are waiting to be billed.', 'each is billed once');
select throws_ok(format($$update app.invoices set payee_person_id = null, counterparty_id = '%s' where id = '%s'$$, pg_temp.id('cp_v_a'), pg_temp.id('sb')),
  'XR001', null, 'an invoice keeps its payee');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.self_billed_deliverables), 0, 'cross tenant: no billed milestone links');
select pg_temp.as_user('ivy');
select is((select invoice_state::text from api_external.invoices where id = pg_temp.id('sb')), 'Proposed', 'Gateway: the individual sees the invoice, Submitted');
select is((select total_minor from api_external.invoices where id = pg_temp.id('sb')), 349000::bigint, 'with its NULL-aware total');
select is((select count(*)::int from api_external.invoice_lines where invoice_id = pg_temp.id('sb')), 2, 'and its lines');
select pg_temp.as_user('quinn');
select is((select count(*)::int from api_external.invoices), 0, 'denial: another freelancer reads none');
select pg_temp.as_user('fiona');
select is((select count(*)::int from api_external.invoices where id = pg_temp.id('sb')), 0, 'denial: an account member reads no individual''s invoice');

-- Submitting an own invoice (1122) -----------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select lives_ok(format($$insert into world values ('own', app.submit_engagement_invoice('%s', 'IVY-001', current_date, current_date + 30, 'USD',
  '[{"description": "Load-out overtime.", "quantity": 2, "unit_price_minor": 12000}]'::jsonb))$$, pg_temp.id('eng_ivy_a')),
  'the individual submits their own invoice');
select is((select payee_person_id from api_external.invoices where id = pg_temp.id('own')), pg_temp.id('ivy'), 'naming themselves as payee');
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.submit_engagement_invoice('%s', 'Q-1', current_date, null, 'USD', '[{"description": "Mine."}]'::jsonb)$$, pg_temp.id('eng_ivy_a')),
  '42501', null, 'another person cannot invoice an individual''s engagement');

-- Approve, record payment, approve payment (1123) ---------------------------------------------------------------
select pg_temp.as_user('alice');
select is(app.approve_invoice(pg_temp.id('sb'), 'Hours and milestone checked.'), true, 'the org approves the self-billed invoice');
select pg_temp.as_user('ivy');
select ok((select approved_at is not null from api_external.invoices where id = pg_temp.id('sb')), 'Gateway: Approved, with its date');
select pg_temp.as_user('dave');
select throws_ok(format($$select app.record_invoice_payment('%s', current_date, null, 'ACH-1')$$, pg_temp.id('sb')), '42501', null,
  'role band: a Member cannot record a payment');
select pg_temp.as_user('xavier');
select throws_ok(format($$select app.record_invoice_payment('%s', current_date, null, 'ACH-1')$$, pg_temp.id('sb')), '42501', null,
  'cross tenant: another org cannot record a payment');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.record_invoice_payment('%s', current_date, null, 'ACH-1')$$, pg_temp.id('own')), 'XR001', null,
  'a Proposed invoice cannot be paid');
select lives_ok(format($$insert into world values ('pay', app.record_invoice_payment('%s', current_date, null, 'ACH-2027-0042'))$$, pg_temp.id('sb')),
  'finance records the payment of the whole balance');
select is((select payee_person_id from app.payments where id = pg_temp.id('pay')), pg_temp.id('ivy'), 'the payment pays the person');
select is((select org_id from app.payments where id = pg_temp.id('pay')), pg_temp.id('org_a'), 'from the invoice''s org');
select throws_ok(format($$select app.record_invoice_payment('%s', current_date, null, 'ACH-3')$$, pg_temp.id('sb')), 'XR001',
  'invoice_payment_amount: Nothing is left to pay on this invoice.', 'nothing is paid twice');
select pg_temp.as_user('ivy');
select is((select scheduled_minor from api_external.invoices where id = pg_temp.id('sb')), 349000::bigint, 'Gateway: Scheduled while the payment awaits approval');
select is((select count(*)::int from api_external.payments), 0, 'a payment awaiting approval is not yet shown as paid');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.approve_payment('%s', 'Self.')$$, pg_temp.id('pay')), 'XR001', null, 'the recorder cannot approve the payment');
select pg_temp.as_user('alice');
select lives_ok(format($$select app.approve_payment('%s', 'Remittance confirmed.')$$, pg_temp.id('pay')), 'another eligible person approves it');
select pg_temp.as_user('ivy');
select is((select balance_minor from api_external.invoices where id = pg_temp.id('sb')), 0::bigint, 'Gateway: Paid, the balance is zero');
select is((select reference_identifier from api_external.payments where id = pg_temp.id('pay')), 'ACH-2027-0042', 'the individual reads their payment');
select pg_temp.as_user('quinn');
select is((select count(*)::int from api_external.payments), 0, 'denial: another person reads no payment');
select pg_temp.as_anon();
select throws_ok('select 1 from api_external.payments', '42501', null, 'anon deny');
select pg_temp.as_platform();

select * from finish();
rollback;
