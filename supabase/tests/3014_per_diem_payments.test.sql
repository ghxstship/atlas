-- pgTAP: 3014, per diem payments (B12, RRR-236, gap G-184; decision 20). paid_on and paid_reference are written only by
-- app.record_per_diem_payments and app.clear_per_diem_payment (per_diem_payment_rpc), even by a crew.time_entry.write
-- holder; a paid per diem is locked (per_diem_paid_locked), its allocation included; recording and clearing need
-- finance.payment.write and refuse the worker (sod_reimbursement_payee), recording refuses an already paid per diem
-- (per_diem_already_paid); both work on a closed production, which still takes no new per diem; both RPCs write audit
-- events; and app.can_record_payments shows the controls.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql
\ir 3010_payables_world.psql

select no_plan();

create function pg_temp.per_diem(p_key text, p_membership text, p_day date, p_amount bigint) returns void
language plpgsql as $$
declare
  v uuid;
begin
  perform pg_temp.as_user('carol');
  insert into app.per_diems (project_id, membership_id, day, amount_minor, currency_code)
  values (pg_temp.id('prj_a'), pg_temp.id(p_membership), p_day, p_amount, 'USD') returning id into v;
  perform pg_temp.as_platform();
  insert into world values (p_key, v);
end $$;

-- Catalog ------------------------------------------------------------------------------------------------------------------
select has_column('app', 'per_diems', 'paid_on', 'a per diem records the day it was paid');
select has_column('app', 'per_diems', 'paid_reference', 'and the remittance reference');
select is((select count(*)::int from pg_trigger where tgrelid = 'app.per_diems'::regclass and tgname = 't44_guard_per_diem_payment'), 1,
  'the payment guard is installed');

select pg_temp.per_diem('pd_dave_1', 'dave@org_a', '2027-06-01', 5000);
select pg_temp.per_diem('pd_dave_2', 'dave@org_a', '2027-06-02', 5000);
select pg_temp.per_diem('pd_carol', 'carol@org_a', '2027-06-01', 5000);

-- Direct writes ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok(format($$insert into app.per_diems (project_id, membership_id, day, amount_minor, currency_code, paid_on)
  values (%L, %L, '2027-06-03', 5000, 'USD', '2027-06-04')$$, pg_temp.id('prj_a'), pg_temp.id('dave@org_a')),
  'XR001', 'per_diem_payment_rpc: A per diem is marked paid through app.record_per_diem_payments.',
  'a per diem is not filed already paid (per_diem_payment_rpc)');
select throws_ok(format($$update app.per_diems set paid_on = '2027-06-04' where id = %L$$, pg_temp.id('pd_dave_1')),
  'XR001', 'per_diem_payment_rpc: A per diem is marked paid through app.record_per_diem_payments.',
  'a crew.time_entry.write holder cannot mark a per diem paid directly');
select pg_temp.as_platform();
select throws_ok(format($$update app.per_diems set paid_reference = 'X' where id = %L$$, pg_temp.id('pd_dave_1')),
  'XR001', null, 'nor can anything outside the RPCs');

-- Recording ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok(format($$select app.record_per_diem_payments(array[%L]::uuid[], '2027-06-05')$$, pg_temp.id('pd_dave_1')),
  '42501', null, 'recording needs finance.payment.write');
select is(app.can_record_payments(pg_temp.id('org_a')), false, 'and the controls stay hidden from a viewer');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.record_per_diem_payments(array[%L, %L]::uuid[], '2027-06-05')$$, pg_temp.id('pd_dave_1'), pg_temp.id('pd_carol')),
  'XR001', 'sod_reimbursement_payee: A person cannot record a reimbursement or a per diem payment to themselves.',
  'the worker cannot record their own per diem paid (sod_reimbursement_payee)');
select pg_temp.as_user('alice');
select is(app.can_record_payments(pg_temp.id('org_a')), true, 'the owner sees the controls');
select throws_ok($$select app.record_per_diem_payments('{}'::uuid[], '2027-06-05')$$,
  'XR001', 'per_diem_payment_batch: Mark 1 to 500 per diems paid at a time.', 'an empty batch is refused');
select throws_ok(format($$select app.record_per_diem_payments(array[%L]::uuid[], null)$$, pg_temp.id('pd_dave_1')),
  'XR001', 'per_diem_payment_date: Give the date the per diems were paid.', 'the paid-on date is required');
select is(app.record_per_diem_payments(array[pg_temp.id('pd_dave_1'), pg_temp.id('pd_dave_2')], '2027-06-05', 'PAYROLL-0605'), 2,
  'the owner records two per diems paid');
select pg_temp.as_platform();
select is((select string_agg(paid_on || ':' || paid_reference, ',') from app.per_diems where id in (pg_temp.id('pd_dave_1'), pg_temp.id('pd_dave_2'))),
  '2027-06-05:PAYROLL-0605,2027-06-05:PAYROLL-0605', 'with the date and the reference');
select is((select count(*)::int from app.audit_events where action = 'crew.per_diems_paid'
  and subject_id in (pg_temp.id('pd_dave_1'), pg_temp.id('pd_dave_2'))), 2, 'each payment is audited');
select pg_temp.as_user('alice');
select throws_ok(format($$select app.record_per_diem_payments(array[%L]::uuid[], '2027-06-06')$$, pg_temp.id('pd_dave_1')),
  'XR001', 'per_diem_already_paid: One of these per diems is already paid.', 'a paid per diem is not paid twice (per_diem_already_paid)');

-- A paid per diem is locked ------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok(format($$update app.per_diems set amount_minor = 6000 where id = %L$$, pg_temp.id('pd_dave_1')),
  'XR001', 'per_diem_paid_locked: A paid per diem stays as it was paid; clear its payment first.',
  'its amount is fixed (per_diem_paid_locked)');
select throws_ok(format($$update app.per_diems set day = '2027-06-09' where id = %L$$, pg_temp.id('pd_dave_1')),
  'XR001', 'per_diem_paid_locked: A paid per diem stays as it was paid; clear its payment first.', 'and its day');
select throws_ok(format($$update app.per_diems set currency_code = 'EUR' where id = %L$$, pg_temp.id('pd_dave_1')),
  'XR001', 'per_diem_paid_locked: A paid per diem stays as it was paid; clear its payment first.', 'and its currency');
select throws_ok(format($$update app.per_diems set membership_id = %L where id = %L$$, pg_temp.id('erin@org_a'), pg_temp.id('pd_dave_1')),
  'XR001', 'per_diem_paid_locked: A paid per diem stays as it was paid; clear its payment first.', 'and its worker');
select throws_ok(format($$update app.per_diems set deleted_at = now() where id = %L$$, pg_temp.id('pd_dave_1')),
  'XR001', 'per_diem_paid_locked: A paid per diem stays as it was paid; clear its payment first.', 'and it stays out of Trash');
select lives_ok(format($$update app.per_diems set amount_minor = 5500 where id = %L$$, pg_temp.id('pd_carol')),
  'an unpaid per diem still changes');

-- A per diem issued under an allocation is paid like any other, and keeps its allocation.
insert into world select 'pd_alloc', pg_temp.alloc('assign', 'carol', 'e_kai', 'per_diem', null, 1);
select pg_temp.as_user('carol');
select app.issue_allocation(gen_random_uuid(), pg_temp.id('pd_alloc'), '[{"day": "2027-06-01", "amount_minor": 5000, "currency_code": "USD"}]');
select pg_temp.as_platform();
insert into world select 'pd_kai', d.id from app.per_diems d where d.allocation_id = pg_temp.id('pd_alloc');
select pg_temp.as_user('alice');
select is(app.record_per_diem_payments(array[pg_temp.id('pd_kai')], '2027-06-05'), 1, 'an issued per diem is recorded paid');
select pg_temp.as_user('carol');
select throws_ok(format($$update app.per_diems set allocation_id = null where id = %L$$, pg_temp.id('pd_kai')),
  'XR001', 'per_diems_allocation_mismatch: An issued row keeps the allocation it was issued under.', 'and keeps its allocation');
select pg_temp.as_platform();

-- Clearing -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok(format($$select app.clear_per_diem_payment(%L, 'Wrong day.')$$, pg_temp.id('pd_dave_1')), '42501', null,
  'clearing needs finance.payment.write');
select pg_temp.as_user('alice');
select throws_ok(format($$select app.clear_per_diem_payment(%L, '')$$, pg_temp.id('pd_dave_1')),
  'XR001', 'per_diem_payment_reason: Say why the payment is cleared, in up to 500 characters.', 'clearing needs a reason');
select throws_ok(format($$select app.clear_per_diem_payment(%L, 'Never paid.')$$, pg_temp.id('pd_carol')),
  'XR001', 'per_diem_not_paid: This per diem has no payment to clear.', 'an unpaid per diem has nothing to clear');
select is(app.record_per_diem_payments(array[pg_temp.id('pd_carol')], '2027-06-05'), 1, 'the owner records carol''s per diem');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.clear_per_diem_payment(%L, 'Not mine after all.')$$, pg_temp.id('pd_carol')),
  'XR001', 'sod_reimbursement_payee: A person cannot record a reimbursement or a per diem payment to themselves.',
  'the worker cannot clear their own payment (sod_reimbursement_payee)');
select pg_temp.as_user('alice');
select is(app.clear_per_diem_payment(pg_temp.id('pd_dave_1'), 'Paid on the wrong run.'), pg_temp.id('pd_dave_1'), 'the owner clears a payment');
select pg_temp.as_platform();
select is((select coalesce(paid_on::text, 'null') || '/' || coalesce(paid_reference, 'null') from app.per_diems where id = pg_temp.id('pd_dave_1')),
  'null/null', 'the per diem is unpaid again');
select is((select count(*)::int from app.audit_events where action = 'crew.per_diem_payment_cleared' and subject_id = pg_temp.id('pd_dave_1')), 1,
  'and the undo is audited');
select pg_temp.as_user('carol');
select lives_ok(format($$update app.per_diems set amount_minor = 6000 where id = %L$$, pg_temp.id('pd_dave_1')),
  'once cleared it changes again');
select pg_temp.as_platform();

-- A closed production ------------------------------------------------------------------------------------------------------
-- Closing stops new spend. What was already filed can still be recorded paid, and a recording in error still cleared.
select pg_temp.as_user('alice');
select app.transition_production(pg_temp.id('prj_a'), 'Proposed', 'Active', 'Live.');
select app.transition_production(pg_temp.id('prj_a'), 'Active', 'Complete', 'Wrapped.');
select app.transition_production(pg_temp.id('prj_a'), 'Complete', 'Closed', 'Closed.');
select is(app.record_per_diem_payments(array[pg_temp.id('pd_dave_1')], '2027-06-20', 'PAYROLL-0620'), 1, 'recording works on a closed production');
select is(app.clear_per_diem_payment(pg_temp.id('pd_dave_2'), 'Paid twice.'), pg_temp.id('pd_dave_2'), 'and so does clearing');
select pg_temp.as_user('carol');
select throws_ok(format($$insert into app.per_diems (project_id, membership_id, day, amount_minor, currency_code)
  values (%L, %L, '2027-06-21', 5000, 'USD')$$, pg_temp.id('prj_a'), pg_temp.id('dave@org_a')),
  'XR001', 'production_closed: A closed production refuses new invoices, purchase orders, expenses, time entries and change orders.',
  'while a new per diem is refused (production_closed)');
select pg_temp.as_platform();

select * from finish();
rollback;
