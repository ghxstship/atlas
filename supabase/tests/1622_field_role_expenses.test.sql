-- pgTAP: migration 1622, owner decision 38 of 2026-10-23 (RRR-125). The Field role records expenses on the projects its
-- holder is assigned to, so frank (Field, a member of prj_a only) picks a budget line in Compass without reading the
-- budget, stores the receipt photo and files the expense. Approval stays with the budget owner: frank cannot approve,
-- nor cancel an expense someone else filed. Write alone reads only the receipts of one's own expenses.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(20);

create function pg_temp.receipt_path(p_org text, p_project text, p_file text) returns text
language sql stable as $$ select format('%s/expense-receipts/%s/%s', pg_temp.id(p_org), pg_temp.id(p_project), p_file) $$;

create function pg_temp.field_grant(p_capability text) returns text
language sql as $$
  select rc.reach::text from app.role_capabilities rc join app.roles r on r.id = rc.role_id
  where r.org_id is null and r.code = 'field' and rc.capability_code = p_capability and rc.deleted_at is null
$$;

-- World: carol's USD budgets on prj_a (frank's project) and prj_a2 (nobody's), one line each, and carol's own expense
-- on prj_a with its receipt.
select pg_temp.as_user('carol');
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Summer Series Working', 'USD') returning id)
insert into world select 'bud_a', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud_a'), 1, 'Crew meals and incidentals.', '0000.01.01', 1, 250000, 'X', 'Declared') returning id)
insert into world select 'line_a', id from x;
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a2'), 'Winter Gala Working', 'USD') returning id)
insert into world select 'bud_a2', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud_a2'), 1, 'Crew meals.', '0000.01.01', 1, 90000, 'X', 'Declared') returning id)
insert into world select 'line_a2', id from x;
insert into storage.objects (bucket_id, name) values ('field-media', pg_temp.receipt_path('org_a', 'prj_a', 'carol.jpg'));
insert into world values ('exp_carol', gen_random_uuid());
select app.submit_expense_receipt(pg_temp.id('exp_carol'), pg_temp.id('line_a'), 'Hotel incidentals', 12000, 'USD', '2027-06-09',
  pg_temp.receipt_path('org_a', 'prj_a', 'carol.jpg'));
select pg_temp.as_platform();

-- 1. The grant ---------------------------------------------------------------------------------------------------------
select is(pg_temp.field_grant('finance.expense.write'), 'assigned', 'the Field role records expenses on its assigned projects');
select is(pg_temp.field_grant('finance.expense.approve'), null, 'and approves none');
select is(pg_temp.field_grant('finance.budget.read'), null, 'nor reads budgets');

-- 2. The line picker, without amounts ----------------------------------------------------------------------------------
select is_empty($$select column_name from information_schema.columns
  where table_schema = 'app' and table_name = 'expense_budget_lines'
    and column_name ~ '(quantity|price|amount|total|minor)'$$, 'the picker''s lines carry no quantity, price or amount');
select pg_temp.as_user('frank');
select results_eq($$select id, project_id, budget_name, currency_code::text from app.expense_budget_lines$$,
  format($$values (%L::uuid, %L::uuid, 'Summer Series Working', 'USD')$$, pg_temp.id('line_a'), pg_temp.id('prj_a')),
  'frank picks among the lines of his own project only');
select is((select count(*)::int from app.budget_lines), 0, 'and still reads no budget line itself');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.expense_budget_lines), 2, 'a manager picks among every line she records expenses on');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.expense_budget_lines), 0, 'a viewer, who records none, picks none');

-- 3. Filing from Compass --------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select lives_ok(format($$insert into storage.objects (bucket_id, name) values ('field-media', %L)$$,
  pg_temp.receipt_path('org_a', 'prj_a', 'frank.jpg')), 'frank stores a receipt photo on his project');
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('field-media', %L)$$,
  pg_temp.receipt_path('org_a', 'prj_a2', 'frank.jpg')), '42501', null, 'but not on a project he is not assigned to');
insert into world values ('exp_frank', gen_random_uuid());
select is(app.submit_expense_receipt(pg_temp.id('exp_frank'), pg_temp.id('line_a'), 'Ice and water for the crew', 4250, 'USD',
    '2027-06-10', pg_temp.receipt_path('org_a', 'prj_a', 'frank.jpg'), 'Camera', '2027-06-10T18:00:00Z'),
  pg_temp.id('exp_frank'), 'frank files the expense with its receipt');
select results_eq(format($$select submitter_person_id, expense_state::text from app.expenses where id = %L$$, pg_temp.id('exp_frank')),
  format($$values (%L::uuid, 'Proposed')$$, pg_temp.id('frank')), 'it waits Proposed, with frank as its submitter');
select throws_ok(format($$select app.submit_expense_receipt(gen_random_uuid(), %L, 'Taxi', 1800, 'USD', '2027-06-10', %L)$$,
    pg_temp.id('line_a2'), pg_temp.receipt_path('org_a', 'prj_a2', 'taxi.jpg')),
  '42501', null, 'he cannot file against a project he is not assigned to');

-- 4. Approval stays with the budget owner ---------------------------------------------------------------------------------
select throws_ok(format($$select app.approve_expense(%L, 'Mine.')$$, pg_temp.id('exp_frank')), '42501', null,
  'frank cannot approve his expense');
select throws_ok(format($$select app.approve_expense(%L, 'Hers.')$$, pg_temp.id('exp_carol')), '42501', null,
  'nor anyone else''s');
select throws_ok(format($$select app.transition_expense(%L, 'Proposed', 'Canceled', 'Not needed.')$$, pg_temp.id('exp_carol')),
  '42501', null, 'nor cancel an expense someone else filed, although he records expenses on the project');
select lives_ok(format($$select app.transition_expense(%L, 'Proposed', 'Canceled', 'Filed twice.')$$, pg_temp.id('exp_frank')),
  'he cancels his own');

-- 5. Receipts read with the expense ---------------------------------------------------------------------------------------
-- Photos read once they scan clean (1041); both have.
select pg_temp.as_platform();
update private.object_scans set scan_status = 'Clean', scanned_at = now() where bucket_id = 'field-media';
select pg_temp.as_user('frank');
select is((select array_agg(name order by name) from storage.objects where bucket_id = 'field-media'),
  array[pg_temp.receipt_path('org_a', 'prj_a', 'frank.jpg')], 'frank reads his own receipt photo, never a colleague''s');
select pg_temp.as_user('dave');
select is((select count(*)::int from storage.objects where bucket_id = 'field-media'), 2, 'a member who reads expenses reads both');
select pg_temp.as_user('alice');
select lives_ok(format($$select app.transition_expense(%L, 'Proposed', 'Canceled', 'Booked on the hotel folio.')$$, pg_temp.id('exp_carol')),
  'the budget owner''s side still cancels an expense someone else filed');

select * from finish();
rollback;
