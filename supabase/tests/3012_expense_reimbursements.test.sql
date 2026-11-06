-- pgTAP: 3012, reimbursements (B12, RRR-236, gap G-228; decision 20). A reimbursable expense is Recorded, Owed and Paid;
-- app.record_expense_reimbursement records the payment at the net owed, needs finance.payment.write, refuses the payee
-- (sod_reimbursement_payee) and every unfit batch with its code, and writes one audit event; app.void_expense_reimbursement
-- returns the expenses to Approved once. app.transition_expense never leaves Paid and never pays a reimbursable charge.
-- A void emits expense.state_changed and no expense.approved. app.submit_expense_receipt keeps one signature with
-- p_is_reimbursable and replays by name. app.reimbursement_balances and app.owed_reimbursable_expenses report complete
-- figures only to holders of finance.payment.read and finance.expense.read at organization reach, count only net above
-- zero as owed, read no name from app.people, and neither form_1099_nec_rows nor the journal sees a reimbursement.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql
\ir 3010_payables_world.psql

select no_plan();

-- Catalog ------------------------------------------------------------------------------------------------------------------
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'app' and p.proname = 'submit_expense_receipt'), 1, 'app.submit_expense_receipt keeps one signature');
select is((select pg_get_function_arguments(p.oid) like '%p_is_reimbursable boolean DEFAULT false' from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'submit_expense_receipt'), true,
  'its last argument is p_is_reimbursable, false by default');
select ok(exists (select 1 from private.sync_rpcs where rpc = 'app.submit_expense_receipt'), 'it stays a sync RPC');
select ok(not exists (select 1 from private.sync_rpcs where rpc = 'app.record_expense_reimbursement'),
  'recording a reimbursement is not a sync RPC');
select ok(exists (select 1 from app.lifecycle_transition_rules where lifecycle = 'expense' and from_state = 'Paid' and to_state = 'Approved'),
  'Paid returns to Approved, for a voided reimbursement');
select ok(exists (select 1 from private.separation_of_duties_rules where code = 'sod_reimbursement_payee'),
  'sod_reimbursement_payee is registered');
select ok(not has_function_privilege('anon', 'app.record_expense_reimbursement(uuid, uuid[], date, text)', 'execute')
  and has_function_privilege('authenticated', 'app.record_expense_reimbursement(uuid, uuid[], date, text)', 'execute'),
  'signed-in people may call the RPC; anonymous callers may not');

-- Expenses: carol paid three out of pocket, frank one; a charge that is not reimbursable ------------------------------------
select pg_temp.expense('r1', 'carol', 'line_a', 3000, '2027-06-10', null, true);
select pg_temp.expense('r2', 'carol', 'line_a', 2500, '2027-06-11', 'cp_lake', true);
select pg_temp.expense('r3', 'carol', 'line_b', 1200, '2027-06-12', null, true);
select pg_temp.expense('r_frank', 'frank', 'line_a', 1800, '2027-06-12', null, true);
select pg_temp.expense('plain', 'carol', 'line_a', 900, '2027-06-12');
select pg_temp.approve(k) from unnest(array['r1', 'r2', 'r_frank', 'plain']) k;
-- r2 has an approved 5.00 credit, so it is owed 20.00.
select pg_temp.expense('r2_credit', 'bob', 'line_a', 500, '2027-06-13', null, false, 'r2');
select pg_temp.approve('r2_credit', 'alice');

-- Balances before payment.
select pg_temp.as_user('alice');
select is((select recorded_count || '/' || recorded_minor || '/' || owed_count || '/' || owed_minor || '/' || paid_minor
  from app.reimbursement_balances(pg_temp.id('org_a')) where payee_person_id = pg_temp.id('carol')),
  '1/1200/2/5000/0', 'carol: one Recorded (12.00), two Owed (30.00 + 20.00 net), nothing Paid');
select is((select owed_minor from app.reimbursement_balances(pg_temp.id('org_a')) where payee_person_id = pg_temp.id('frank')),
  1800::bigint, 'frank is owed his 18.00');
select is((select string_agg(expense_id::text || ':' || net_minor, ',' order by incurred_on)
  from app.owed_reimbursable_expenses(pg_temp.id('org_a'), pg_temp.id('carol'))),
  pg_temp.id('r1')::text || ':3000,' || pg_temp.id('r2')::text || ':2000', 'the sheet lists exactly the Owed expenses, at their net');
select is((select pending_credit_minor from app.owed_reimbursable_expenses(pg_temp.id('org_a'), pg_temp.id('carol')) where expense_id = pg_temp.id('r1')),
  0::bigint, 'with what its Proposed credits would take');
select is((select count(*)::int from app.owed_reimbursable_expenses(pg_temp.id('org_a'), pg_temp.id('carol'), pg_temp.id('prj_a2'))), 0,
  'p_project_id narrows the list');
select is(app.can_read_reimbursements(pg_temp.id('org_a')), true, 'an owner reads reimbursements');
select pg_temp.as_user('gina');
select is(app.can_read_reimbursements(pg_temp.id('org_a')), false, 'a viewer does not');
select throws_ok(format($$select * from app.reimbursement_balances(%L)$$, pg_temp.id('org_a')), '42501', null,
  'reimbursement balances need finance.payment.read and finance.expense.read');
select throws_ok(format($$select * from app.owed_reimbursable_expenses(%L, %L)$$, pg_temp.id('org_a'), pg_temp.id('carol')), '42501', null,
  'and so does the owed list');
select pg_temp.as_platform();
select ok(position('app.people' in pg_get_functiondef('app.reimbursement_balances(uuid, uuid)'::regprocedure)) = 0
  and position('app.people' in pg_get_functiondef('app.owed_reimbursable_expenses(uuid, uuid, uuid)'::regprocedure)) = 0,
  'neither reads app.people: names come through app.person_names');
-- Without one of the two capabilities the member, who holds both at organization reach, is refused.
delete from app.role_capabilities where role_id = pg_temp.system_role('member') and capability_code = 'finance.expense.read';
select pg_temp.as_user('dave');
select throws_ok(format($$select * from app.reimbursement_balances(%L)$$, pg_temp.id('org_a')), '42501', null,
  'finance.payment.read alone is refused');
select pg_temp.as_platform();
insert into app.role_capabilities (role_id, capability_code, reach) values (pg_temp.system_role('member'), 'finance.expense.read', 'organization');
delete from app.role_capabilities where role_id = pg_temp.system_role('member') and capability_code = 'finance.payment.read';
select pg_temp.as_user('dave');
select throws_ok(format($$select * from app.owed_reimbursable_expenses(%L, %L)$$, pg_temp.id('org_a'), pg_temp.id('carol')), '42501', null,
  'finance.expense.read alone is refused');
select pg_temp.as_platform();
insert into app.role_capabilities (role_id, capability_code, reach) values (pg_temp.system_role('member'), 'finance.payment.read', 'organization');

-- Transitions ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select throws_ok(format($$select app.transition_expense(%L, 'Approved', 'Paid', 'Paid by hand.')$$, pg_temp.id('r1')),
  'XR001', 'expense_reimbursement_use_rpc: A reimbursable expense is paid by recording its reimbursement.',
  'a reimbursable charge is not marked Paid directly (expense_reimbursement_use_rpc)');
select lives_ok(format($$select app.transition_expense(%L, 'Approved', 'Paid', 'Paid by card.')$$, pg_temp.id('plain')),
  'a charge that is not reimbursable still is');
select throws_ok(format($$select app.transition_expense(%L, 'Paid', 'Approved', 'Undo.')$$, pg_temp.id('plain')),
  'XR001', 'expense_paid_final: A paid expense stays paid; void its reimbursement to reopen it.',
  'nothing leaves Paid through transition_expense (expense_paid_final)');
select throws_like(format($$select app.transition_expense(%L, 'Approved', 'Canceled', 'Too late.')$$, pg_temp.id('r2')),
  'expense_transition_not_allowed:%', 'a move the lifecycle still refuses throws expense_transition_not_allowed');

-- Recording: refusals ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok(format($$select app.record_expense_reimbursement(%L, array[%L]::uuid[], '2027-06-20')$$, pg_temp.id('carol'), pg_temp.id('r1')),
  '42501', null, 'recording needs finance.payment.write');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.record_expense_reimbursement(%L, array[%L]::uuid[], '2027-06-20')$$, pg_temp.id('carol'), pg_temp.id('r1')),
  'XR001', 'sod_reimbursement_payee: A person cannot record a reimbursement or a per diem payment to themselves.',
  'the payee cannot record their own reimbursement (sod_reimbursement_payee)');
select pg_temp.as_user('alice');
select throws_ok(format($$select app.record_expense_reimbursement(%L, '{}'::uuid[], '2027-06-20')$$, pg_temp.id('carol')),
  'XR001', 'expense_reimbursement_batch: A reimbursement settles 1 to 200 expenses.', 'an empty batch is refused (expense_reimbursement_batch)');
select throws_ok(format($$select app.record_expense_reimbursement(%L, array[%L]::uuid[], null)$$, pg_temp.id('carol'), pg_temp.id('r1')),
  'XR001', 'expense_reimbursement_date: Give the date the money moved.', 'the paid-on date is required (expense_reimbursement_date)');
select throws_ok(format($$select app.record_expense_reimbursement(%L, array[%L, %L]::uuid[], '2027-06-20')$$, pg_temp.id('carol'), pg_temp.id('r1'), pg_temp.id('r_frank')),
  'XR001', 'expense_reimbursement_expense: Reimburse live, approved, reimbursable expenses the payee filed and is still owed.',
  'another payee''s expense is refused (expense_reimbursement_expense)');
select throws_ok(format($$select app.record_expense_reimbursement(%L, array[%L]::uuid[], '2027-06-20')$$, pg_temp.id('carol'), pg_temp.id('r3')),
  'XR001', 'expense_reimbursement_expense: Reimburse live, approved, reimbursable expenses the payee filed and is still owed.',
  'a Proposed expense is refused');
select throws_ok(format($$select app.record_expense_reimbursement(%L, array[%L]::uuid[], '2027-06-20')$$, pg_temp.id('carol'), pg_temp.id('plain')),
  'XR001', 'expense_reimbursement_expense: Reimburse live, approved, reimbursable expenses the payee filed and is still owed.',
  'an expense that is not reimbursable is refused');
select pg_temp.as_platform();

-- A Proposed credit pending blocks the batch until it is decided.
select pg_temp.expense('r1_pending', 'bob', 'line_a', 300, '2027-06-14', null, false, 'r1');
select pg_temp.as_user('alice');
select throws_ok(format($$select app.record_expense_reimbursement(%L, array[%L, %L]::uuid[], '2027-06-20')$$, pg_temp.id('carol'), pg_temp.id('r1'), pg_temp.id('r2')),
  'XR001', 'expense_reimbursement_pending_credit: A credit waits for approval on one of these expenses; decide it first.',
  'a Proposed credit pending is refused (expense_reimbursement_pending_credit)');
select pg_temp.as_user('bob');
select app.transition_expense(pg_temp.id('r1_pending'), 'Proposed', 'Canceled', 'Entered in error.');

-- Mixed currencies: a EUR budget for carol's EUR expense.
select pg_temp.as_user('carol');
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Euro Leg', 'EUR') returning id)
  insert into world select 'bud_eur', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud_eur'), 1, 'Ferry.', '0000.01.01', 1, 10000, 'X', 'Declared') returning id) insert into world select 'line_eur', id from x;
with x as (insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code, is_reimbursable)
  values (pg_temp.id('line_eur'), 'Ferry tickets.', '2027-06-12', 4000, 'EUR', true) returning id) insert into world select 'r_eur', id from x;
select pg_temp.as_platform();
select pg_temp.approve('r_eur');
select pg_temp.as_user('alice');
select throws_ok(format($$select app.record_expense_reimbursement(%L, array[%L, %L]::uuid[], '2027-06-20')$$, pg_temp.id('carol'), pg_temp.id('r1'), pg_temp.id('r_eur')),
  'XR001', 'expense_reimbursement_currency: A reimbursement settles expenses in one currency.',
  'mixed currencies are refused (expense_reimbursement_currency)');

-- Recording ----------------------------------------------------------------------------------------------------------------
select lives_ok(format($$insert into world values ('reimb', app.record_expense_reimbursement(%L, array[%L, %L]::uuid[], '2027-06-20', 'ACH 20270620-1'))$$,
  pg_temp.id('carol'), pg_temp.id('r1'), pg_temp.id('r2')), 'alice records carol''s reimbursement');
select pg_temp.as_platform();
select is((select paid_minor from app.expense_reimbursements where id = pg_temp.id('reimb')), 5000::bigint,
  'the amount is the net owed: 30.00 + (25.00 - 5.00)');
select is((select reference_identifier || '/' || paid_on || '/' || currency_code from app.expense_reimbursements where id = pg_temp.id('reimb')),
  'ACH 20270620-1/2027-06-20/USD', 'with the reference, the date and the currency');
select is((select string_agg(expense_state::text, ',' order by id) from app.expenses where id in (pg_temp.id('r1'), pg_temp.id('r2'))),
  'Paid,Paid', 'both expenses are Paid');
select is((select count(*)::int from app.expenses where reimbursement_id = pg_temp.id('reimb')), 2, 'and linked to the reimbursement');
select is((select count(*)::int from app.audit_events where action = 'finance.expense_reimbursed' and subject_id = pg_temp.id('reimb')), 1,
  'one audit event records it');
select is((select reason from app.expense_state_transitions where expense_id = pg_temp.id('r1') and to_state = 'Paid'),
  'Reimbursed on 2027-06-20.', 'the transition says when it was reimbursed');
select pg_temp.as_user('alice');
select is((select owed_minor || '/' || paid_minor || '/' || last_paid_on from app.reimbursement_balances(pg_temp.id('org_a'))
  where payee_person_id = pg_temp.id('carol') and currency_code = 'USD'), '0/5000/2027-06-20', 'carol is owed nothing more and was paid 50.00');
select throws_ok(format($$select app.record_expense_reimbursement(%L, array[%L]::uuid[], '2027-06-21')$$, pg_temp.id('carol'), pg_temp.id('r1')),
  'XR001', 'expense_reimbursement_expense: Reimburse live, approved, reimbursable expenses the payee filed and is still owed.',
  'a reimbursed expense is not reimbursed twice');

-- Reading reimbursements.
select pg_temp.as_user('carol');
select is((select count(*)::int from app.expense_reimbursements where id = pg_temp.id('reimb')), 1, 'the payee reads their reimbursement');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.expense_reimbursements where id = pg_temp.id('reimb')), 0,
  'another member without finance.payment.read reads none');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.expense_reimbursements), 0, 'nor does a viewer');

-- Voiding ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok(format($$select app.void_expense_reimbursement(%L, 'Mine.')$$, pg_temp.id('reimb')),
  'XR001', 'sod_reimbursement_payee: A person cannot record a reimbursement or a per diem payment to themselves.',
  'the payee cannot void their own reimbursement');
select pg_temp.as_user('alice');
select throws_ok(format($$select app.void_expense_reimbursement(%L, '  ')$$, pg_temp.id('reimb')),
  'XR001', 'expense_reimbursement_void_reason: Say why the reimbursement is voided, in up to 500 characters.', 'a void needs a reason');
select lives_ok(format($$select app.void_expense_reimbursement(%L, 'Bank returned the transfer.')$$, pg_temp.id('reimb')), 'alice voids it');
select pg_temp.as_platform();
select is((select string_agg(expense_state::text, ',' order by id) from app.expenses where id in (pg_temp.id('r1'), pg_temp.id('r2'))),
  'Approved,Approved', 'the expenses are Approved again');
select is((select count(*)::int from app.expenses where reimbursement_id = pg_temp.id('reimb')), 0, 'and no longer linked');
select is((select (voided_at is not null)::text || '/' || (voided_by = pg_temp.id('alice'))::text || '/' || void_reason
  from app.expense_reimbursements where id = pg_temp.id('reimb')), 'true/true/Bank returned the transfer.', 'the void is recorded');
select is((select count(*)::int from app.audit_events where action = 'finance.expense_reimbursement_voided' and subject_id = pg_temp.id('reimb')), 1,
  'and audited');
select is((select count(*)::int from app.domain_events where event_type = 'expense.approved' and subject_id = pg_temp.id('r1')), 1,
  'returning to Approved emits no second expense.approved');
select is((select count(*)::int from app.domain_events e where e.event_type = 'expense.state_changed' and e.subject_id = pg_temp.id('r1')
  and e.data ->> 'from_state' = 'Paid' and e.data ->> 'to_state' = 'Approved'), 1,
  'a void emits one expense.state_changed from Paid to Approved');
select is((select count(*)::int from app.journal_entries j where j.source_table = 'expense_reimbursements'), 0,
  'neither recording nor voiding writes a journal entry');
select is((select count(*)::int from app.journal_entries j where j.source_table = 'expenses' and j.source_id = pg_temp.id('r1')), 1,
  'the charge keeps only its approval entry');
select ok(position('expense_reimbursements' in pg_get_functiondef((select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'app' and p.proname = 'form_1099_nec_rows' limit 1))) = 0, 'app.form_1099_nec_rows counts no reimbursement');
select pg_temp.as_user('alice');
select throws_ok(format($$select app.void_expense_reimbursement(%L, 'Again.')$$, pg_temp.id('reimb')),
  'XR001', 'expense_reimbursement_voided: This reimbursement is already voided.', 'a second void is refused (expense_reimbursement_voided)');
select is((select owed_minor || '/' || paid_minor from app.reimbursement_balances(pg_temp.id('org_a'))
  where payee_person_id = pg_temp.id('carol') and currency_code = 'USD'), '5000/0', 'carol is owed again, and nothing counts as paid');
select pg_temp.as_platform();

-- A charge credited to net zero is not owed and is not on the sheet.
select pg_temp.expense('r_zero', 'carol', 'line_b', 800, '2027-06-14', null, true);
select pg_temp.approve('r_zero');
select pg_temp.expense('r_zero_credit', 'bob', 'line_b', 800, '2027-06-15', null, false, 'r_zero');
select pg_temp.approve('r_zero_credit', 'alice');
select pg_temp.as_user('alice');
select is((select owed_count || '/' || owed_minor from app.reimbursement_balances(pg_temp.id('org_a'))
  where payee_person_id = pg_temp.id('carol') and currency_code = 'USD'), '2/5000', 'a net-zero charge counts in neither owed figure');
select ok(not exists (select 1 from app.owed_reimbursable_expenses(pg_temp.id('org_a'), pg_temp.id('carol')) where expense_id = pg_temp.id('r_zero')),
  'and is not offered for reimbursement');
select pg_temp.as_platform();
select pg_temp.expense('r2_pending', 'bob', 'line_a', 100, '2027-06-15', null, false, 'r2');
select pg_temp.as_user('alice');
select is((select pending_credit_minor from app.owed_reimbursable_expenses(pg_temp.id('org_a'), pg_temp.id('carol')) where expense_id = pg_temp.id('r2')),
  100::bigint, 'a charge with a Proposed credit is listed with what it waits on');
select pg_temp.as_platform();

-- Filing from Compass ------------------------------------------------------------------------------------------------------
insert into world values ('exp_tape', gen_random_uuid());
select pg_temp.as_user('frank');
select is(app.submit_expense_receipt(pg_temp.id('exp_tape'), pg_temp.id('line_a'), 'Gaffer tape', 1899, 'USD', '2027-06-11',
  pg_temp.id('org_a')::text || '/expense-receipts/' || pg_temp.id('prj_a')::text || '/tape.jpg', 'Camera', null, null, true),
  pg_temp.id('exp_tape'), 'a field crew member files a reimbursable expense with its receipt');
select pg_temp.as_platform();
select is((select is_reimbursable from app.expenses where id = pg_temp.id('exp_tape')), true, 'it is reimbursable');
select pg_temp.as_user('frank');
select is(app.submit_expense_receipt(pg_temp.id('exp_tape'), pg_temp.id('line_a'), 'Gaffer tape', 1899, 'USD', '2027-06-11',
  pg_temp.id('org_a')::text || '/expense-receipts/' || pg_temp.id('prj_a')::text || '/tape.jpg', 'Camera', null, null, true),
  pg_temp.id('exp_tape'), 'a replay of the same id returns the same expense');
insert into world values ('mut_old', gen_random_uuid()), ('exp_old', gen_random_uuid());
select ok(app.apply_sync_mutation(pg_temp.id('mut_old'), pg_temp.id('org_a'), 'compass-device', 'app.submit_expense_receipt',
  jsonb_build_object('p_id', pg_temp.id('exp_old'), 'p_budget_line_id', pg_temp.id('line_a'), 'p_description', 'Water',
    'p_amount_minor', 600, 'p_currency_code', 'USD', 'p_incurred_on', '2027-06-12',
    'p_media_uri', pg_temp.id('org_a')::text || '/expense-receipts/' || pg_temp.id('prj_a')::text || '/water.jpg')) is not null,
  'a queued call from an older build, without p_is_reimbursable, still replays');
select pg_temp.as_platform();
select is((select is_reimbursable from app.expenses where id = pg_temp.id('exp_old')), false, 'and files an expense that is not reimbursable');

select * from finish();
rollback;
