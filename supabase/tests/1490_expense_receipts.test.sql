-- pgTAP: migration 1490, expense receipts filed from Compass (A92, RRR-137, A65-011 part 1). A person with
-- finance.expense.write on the project stores the receipt photo under <org_id>/expense-receipts/<project_id>/ and files
-- the expense with it in one call, replayed once from an offline queue; a viewer and another org cannot (the Field
-- role records expenses since 1622, covered there). The
-- receipt reads with the expense. A confirmed Aurora receipt extraction is applied with the expense; someone else's
-- suggestion is refused. Incident, inspection and kiosk media keep their rules.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(25);

create function pg_temp.receipt_path(p_org text, p_project text, p_file text) returns text
language sql stable as $$ select format('%s/expense-receipts/%s/%s', pg_temp.id(p_org), pg_temp.id(p_project), p_file) $$;

-- World: a USD budget line on prj_a, and an Aurora receipt extraction for carol and one for bob.
select pg_temp.as_user('carol');
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Summer Series Working', 'USD') returning id)
insert into world select 'bud_a', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud_a'), 1, 'Crew catering.', '0000.01.01', 1, 50000, 'X', 'Declared') returning id)
insert into world select 'line_a', id from x;
select pg_temp.as_platform();
with x as (insert into app.ai_requests (org_id, person_id, feature, model, outcome, completed_at)
  values (pg_temp.id('org_a'), pg_temp.id('carol'), 'extraction', 'claude-opus-5-5', 'Answered', now()) returning id)
insert into world select 'req_carol', id from x;
with x as (insert into app.ai_suggestions (request_id, operation_id, summary)
  values (pg_temp.id('req_carol'), 'expenses.create', 'Create a receipt record from the extracted document with 4 of 4 fields read.') returning id)
insert into world select 'sug_carol', id from x;
with x as (insert into app.ai_requests (org_id, person_id, feature, model, outcome, completed_at)
  values (pg_temp.id('org_a'), pg_temp.id('bob'), 'extraction', 'claude-opus-5-5', 'Answered', now()) returning id)
insert into world select 'req_bob', id from x;
with x as (insert into app.ai_suggestions (request_id, operation_id, summary)
  values (pg_temp.id('req_bob'), 'expenses.create', 'Create a receipt record from the extracted document with 3 of 4 fields read.') returning id)
insert into world select 'sug_bob', id from x;

-- Storage ------------------------------------------------------------------------------------------------------------
select results_eq(format($$select kind, project_id from private.field_media_subject(%L)$$, pg_temp.receipt_path('org_a', 'prj_a', 'r1.jpg')),
  format($$values ('expense-receipts'::text, %L::uuid)$$, pg_temp.id('prj_a')), 'a receipt photo belongs to its project');
select is((select count(*)::int from private.field_media_subject(pg_temp.receipt_path('org_a', 'prj_b', 'x.jpg'))), 0,
  'a project of another org under one''s own org path names no subject');

select pg_temp.as_user('carol');
select lives_ok(format($$insert into storage.objects (bucket_id, name) values ('field-media', %L)$$, pg_temp.receipt_path('org_a', 'prj_a', 'r1.jpg')),
  'a person who records expenses on the project stores the receipt photo');
select pg_temp.as_user('gina');
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('field-media', %L)$$, pg_temp.receipt_path('org_a', 'prj_a', 'gina.jpg')),
  '42501', null, 'a viewer without finance.expense.write cannot store receipts');
select pg_temp.as_user('xavier');
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('field-media', %L)$$, pg_temp.receipt_path('org_a', 'prj_a', 'x.jpg')),
  '42501', null, 'another org cannot store receipts for the project');

-- Filing -------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into world values ('exp_1', gen_random_uuid());
select is(app.submit_expense_receipt(pg_temp.id('exp_1'), pg_temp.id('line_a'), 'Ice and water for the crew', 4250, 'usd',
    '2027-06-10', pg_temp.receipt_path('org_a', 'prj_a', 'r1.jpg'), 'Camera', '2027-06-10T18:00:00Z'),
  pg_temp.id('exp_1'), 'the expense is filed under the device-minted id');
select results_eq(format($$select budget_line_id, submitter_person_id, amount_minor, currency_code::text, expense_state::text
    from app.expenses where id = %L$$, pg_temp.id('exp_1')),
  format($$values (%L::uuid, %L::uuid, 4250::bigint, 'USD', 'Proposed')$$, pg_temp.id('line_a'), pg_temp.id('carol')),
  'it posts to the one budget line, Proposed, with the session person as submitter and the currency in capitals');
select results_eq(format($$select media_uri, capture_source, ai_suggestion_id from app.expense_receipts where expense_id = %L$$, pg_temp.id('exp_1')),
  format($$values (%L, 'Camera', null::uuid)$$, pg_temp.receipt_path('org_a', 'prj_a', 'r1.jpg')),
  'the receipt photo is attached');
select is(app.submit_expense_receipt(pg_temp.id('exp_1'), pg_temp.id('line_a'), 'Ice and water for the crew', 4250, 'USD',
    '2027-06-10', pg_temp.receipt_path('org_a', 'prj_a', 'r1.jpg')),
  pg_temp.id('exp_1'), 'a replay returns the expense it made');
select is((select count(*)::int from app.expense_receipts where expense_id = pg_temp.id('exp_1')), 1, 'and attaches nothing twice');
select throws_ok(format($$select app.submit_expense_receipt(gen_random_uuid(), %L, 'Elsewhere', 100, 'USD', '2027-06-10', %L)$$,
    pg_temp.id('line_a'), pg_temp.receipt_path('org_a', 'prj_a2', 'r2.jpg')),
  'XR001', null, 'a photo stored under another project is refused');
select throws_ok(format($$select app.submit_expense_receipt(gen_random_uuid(), %L, 'Euro dinner', 100, 'EUR', '2027-06-10', %L)$$,
    pg_temp.id('line_a'), pg_temp.receipt_path('org_a', 'prj_a', 'r3.jpg')),
  'XR001', null, 'an expense in another currency than its budget is refused (0321)');
select throws_ok(format($$insert into app.expense_receipts (expense_id, media_uri) values (%L, %L)$$,
    pg_temp.id('exp_1'), pg_temp.receipt_path('org_a', 'prj_a', 'direct.jpg')),
  '42501', null, 'receipts are written only through app.submit_expense_receipt');

select pg_temp.as_user('gina');
select throws_ok(format($$select app.submit_expense_receipt(gen_random_uuid(), %L, 'Taxi', 100, 'USD', '2027-06-10', %L)$$,
    pg_temp.id('line_a'), pg_temp.receipt_path('org_a', 'prj_a', 'g.jpg')),
  '42501', null, 'a viewer without finance.expense.write cannot file an expense');
select pg_temp.as_user('xavier');
select throws_ok(format($$select app.submit_expense_receipt(gen_random_uuid(), %L, 'Taxi', 100, 'USD', '2027-06-10', %L)$$,
    pg_temp.id('line_a'), pg_temp.receipt_path('org_a', 'prj_a', 'x.jpg')),
  '42501', null, 'another org cannot file against the line');

-- Aurora --------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into world values ('exp_2', gen_random_uuid());
select lives_ok(format($$select app.submit_expense_receipt(%L, %L, 'Gaffer tape', 1899, 'USD', '2027-06-11', %L, 'Photo Library', null, %L)$$,
    pg_temp.id('exp_2'), pg_temp.id('line_a'), pg_temp.receipt_path('org_a', 'prj_a', 'r4.jpg'), pg_temp.id('sug_carol')),
  'an expense from confirmed Aurora fields is filed');
select results_eq(format($$select suggestion_state::text, applied_id from app.ai_suggestions where id = %L$$, pg_temp.id('sug_carol')),
  format($$values ('Applied', %L::uuid)$$, pg_temp.id('exp_2')),
  'the suggestion is confirmed and applied with the expense as the record written');
select is((select ai_suggestion_id from app.expense_receipts where expense_id = pg_temp.id('exp_2')), pg_temp.id('sug_carol'),
  'the receipt names the suggestion whose fields were confirmed');
select throws_ok(format($$select app.submit_expense_receipt(gen_random_uuid(), %L, 'Borrowed', 100, 'USD', '2027-06-11', %L, 'Camera', null, %L)$$,
    pg_temp.id('line_a'), pg_temp.receipt_path('org_a', 'prj_a', 'r5.jpg'), pg_temp.id('sug_bob')),
  'XR001', null, 'another person''s suggestion is refused');

-- Reads ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is((select count(*)::int from app.expense_receipts), 2, 'a member who reads expenses reads their receipts');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.expense_receipts), 0, 'a field member reads none of the receipts others filed');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.expense_receipts), 0, 'another org reads none');

-- Offline replay ---------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select ok(exists (select 1 from private.sync_rpcs where rpc = 'app.submit_expense_receipt'), 'the device may replay the filing');
select pg_temp.as_user('carol');
insert into world values ('exp_3', gen_random_uuid());
insert into world values ('mut_3', gen_random_uuid());
select is(app.apply_sync_mutation(pg_temp.id('mut_3'), pg_temp.id('org_a'), 'compass-device', 'app.submit_expense_receipt',
    jsonb_build_object('p_id', pg_temp.id('exp_3'), 'p_budget_line_id', pg_temp.id('line_a'), 'p_description', 'Parking',
      'p_amount_minor', 2000, 'p_currency_code', 'USD', 'p_incurred_on', '2027-06-12',
      'p_media_uri', pg_temp.receipt_path('org_a', 'prj_a', 'r6.jpg'))) -> 'data',
  to_jsonb(pg_temp.id('exp_3')), 'a queued filing replays through apply_sync_mutation');
select is((select count(*)::int from app.expenses where id = pg_temp.id('exp_3')), 1, 'and files the expense once');

select * from finish();
rollback;
