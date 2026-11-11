-- pgTAP: 6546, duplicate warnings (B12, RRR-236, gap G-224). Expenses: another live charge of the org in the same
-- currency from the same or an alike-named vendor (0.85 similarity), or with no vendor from the same submitter, within 1%
-- and 7 days, never a credit, a Rejected or Canceled row, another currency, an amount 2% away or a date 8 days away, and
-- only for Proposed or Approved subjects; a field crew member sees only rows they can read. Purchase orders: an alike
-- vendor, the same currency, totals within 1% and created within 30 days, never a Canceled order or one the caller cannot
-- read. Nothing is refused, and candidates are probed by date window first: each function stays quick over 2,000 expenses.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql
\ir 6540_payables_world.psql

select no_plan();

select ok(private.counterparties_alike(pg_temp.id('cp_rig'), pg_temp.id('cp_rig2')), 'Pier Rigging Co and Pier Rigging Co. are alike');
select ok(not private.counterparties_alike(pg_temp.id('cp_rig'), pg_temp.id('cp_lake')), 'Lakeshore Brands is not');
select ok(not private.counterparties_alike(null, pg_temp.id('cp_lake')), 'no vendor is alike to nothing');

-- Charges -------------------------------------------------------------------------------------------------------------------
select pg_temp.expense('d1', 'carol', 'line_a', 10000, '2027-06-10', 'cp_rig');
select pg_temp.expense('d2', 'carol', 'line_a', 10050, '2027-06-14', 'cp_rig2');
select pg_temp.expense('d3', 'carol', 'line_a', 10200, '2027-06-11', 'cp_rig');
select pg_temp.expense('d4', 'carol', 'line_a', 10000, '2027-06-18', 'cp_rig');
select pg_temp.expense('d_appr', 'carol', 'line_a', 10000, '2027-06-11', 'cp_rig');
select pg_temp.approve('d_appr');
select pg_temp.expense('d_cr', 'carol', 'line_a', 9950, '2027-06-12', null, false, 'd_appr');
select pg_temp.expense('d_rej', 'carol', 'line_a', 10000, '2027-06-10', 'cp_rig');
select pg_temp.as_user('bob');
select app.reject_expense(pg_temp.id('d_rej'), 'Duplicate.');
select pg_temp.expense('d_lake', 'carol', 'line_a', 10000, '2027-06-10', 'cp_lake');
select pg_temp.expense('f2', 'frank', 'line_a', 10000, '2027-06-10', 'cp_rig');
-- The same receipt in euros.
select pg_temp.as_user('carol');
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Euro Leg', 'EUR') returning id)
  insert into world select 'bud_eur', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud_eur'), 1, 'Ferry.', '0000.01.01', 1, 10000, 'X', 'Declared') returning id) insert into world select 'line_eur', id from x;
with x as (insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code, counterparty_id)
  values (pg_temp.id('line_eur'), 'Rigging in euros.', '2027-06-10', 10000, 'EUR', pg_temp.id('cp_rig')) returning id) insert into world select 'd_eur', id from x;
select pg_temp.as_platform();

select pg_temp.as_user('carol');
select is((select string_agg(w.key, ',' order by w.key collate "C") from app.expense_duplicate_candidates(array[pg_temp.id('d1')]) c
  join world w on w.id = c.candidate_id), 'd2,d_appr,f2',
  'look-alikes: an alike vendor within 1% and 7 days, an Approved charge and another person''s exact copy');
select is((select string_agg(w.key, ',' order by c.day_gap) from app.expense_duplicate_candidates(array[pg_temp.id('d1')]) c
  join world w on w.id = c.candidate_id where c.amount_delta_minor = 0), 'f2,d_appr', 'exact amounts come by nearest date');
select is((select same_vendor::text || '/' || amount_delta_minor || '/' || day_gap from app.expense_duplicate_candidates(array[pg_temp.id('d1')]) c
  where c.candidate_id = pg_temp.id('d2')), 'false/50/4', 'an alike vendor is not the same vendor, and the gaps are given');
select ok(not exists (select 1 from app.expense_duplicate_candidates(array[pg_temp.id('d1')]) c
  where c.candidate_id in (pg_temp.id('d3'), pg_temp.id('d4'), pg_temp.id('d_cr'), pg_temp.id('d_rej'), pg_temp.id('d_lake'), pg_temp.id('d_eur'))),
  'never 2% away, 8 days away, a credit, a Rejected row, another vendor or another currency');
select pg_temp.as_platform();

-- No vendor on either: the same submitter only.
select pg_temp.expense('n1', 'carol', 'line_b', 5000, '2027-06-10');
select pg_temp.expense('n2', 'carol', 'line_b', 5000, '2027-06-12');
select pg_temp.expense('n3', 'bob', 'line_b', 5000, '2027-06-11');
select pg_temp.as_user('carol');
select is((select string_agg(w.key, ',' order by w.key) from app.expense_duplicate_candidates(array[pg_temp.id('n1')]) c
  join world w on w.id = c.candidate_id), 'n2', 'with no vendor, only the same submitter''s look-alike');
select pg_temp.as_platform();

-- A paid subject is past warning.
select pg_temp.approve('n1');
select pg_temp.as_user('alice');
select app.transition_expense(pg_temp.id('n1'), 'Approved', 'Paid', 'Paid by card.');
select is((select count(*)::int from app.expense_duplicate_candidates(array[pg_temp.id('n1')])), 0, 'a Paid subject is not checked');

-- A field crew member sees only what they can read.
select pg_temp.as_user('frank');
select is((select count(*)::int from app.expense_duplicate_candidates(array[pg_temp.id('f2')])), 0,
  'frank''s expense matches carol''s, but he reads none of them');
select pg_temp.as_user('carol');
select ok((select count(*) from app.expense_duplicate_candidates(array[pg_temp.id('f2')])) >= 3, 'carol reads them all');

-- A draft before it is saved.
select is((select string_agg(w.key, ',' order by w.key collate "C") from app.find_expense_duplicates(pg_temp.id('line_a'), pg_temp.id('cp_rig2'), 10000, '2027-06-12') c
  join world w on w.id = c.candidate_id), 'd1,d2,d4,d_appr,f2', 'a draft is checked by the same rule');
select is((select count(*)::int from app.find_expense_duplicates(pg_temp.id('line_a'), pg_temp.id('cp_rig2'), 10000, '2027-06-12', pg_temp.id('d1')) c
  where c.candidate_id = pg_temp.id('d1')), 0, 'leaving out the expense being edited');
select pg_temp.as_platform();

-- Purchase orders ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_rig')) returning id) insert into world select 'v1', id from x;
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_rig2')) returning id) insert into world select 'v2', id from x;
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_lake')) returning id) insert into world select 'v3', id from x;
select pg_temp.as_platform();
create temporary table orders (key text, vendor text, price bigint);
insert into orders values ('po1', 'v1', 100000), ('po2', 'v2', 100500), ('po3', 'v1', 100000), ('po4', 'v3', 100000), ('po5', 'v1', 102000);
create function pg_temp.place(p_key text, p_vendor text, p_price bigint) returns void
language plpgsql as $$
declare
  v uuid;
begin
  perform pg_temp.as_user('carol');
  insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id(p_vendor), 'USD') returning id into v;
  insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_price_minor) values (v, 1, 'Truss.', 1, p_price);
  perform pg_temp.as_platform();
  insert into world values (p_key, v);
end $$;
select pg_temp.place(o.key, o.vendor, o.price) from orders o;
select pg_temp.as_user('bob');
select app.approve_purchase_order(pg_temp.id('po3'), 'Within limit.');
select pg_temp.as_user('carol');
select app.transition_purchase_order(pg_temp.id('po3'), 'Approved', 'Canceled', 'Placed twice.');
select is((select string_agg(w.key, ',' order by w.key) from app.purchase_order_duplicate_candidates(array[pg_temp.id('po1')]) c
  join world w on w.id = c.candidate_id), 'po2', 'an alike vendor''s order within 1%; never a Canceled order, another vendor or 2% away');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.purchase_order_duplicate_candidates(array[pg_temp.id('po1')])), 0,
  'a reader without procurement.po.read sees none');
select pg_temp.as_platform();

-- The name similarity helper is read only inside definer functions --------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'private.counterparties_alike(uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'private.counterparties_alike(uuid, uuid)', 'execute'), 'signed-in people do not call the name test directly');
select ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'readable_expense_ids'),
  'the org''s readable ids are not materialized');

-- 2,000 expenses in one org, with candidates tested by window first -----------------------------------------------------------
insert into app.expenses (org_id, budget_line_id, description, incurred_on, amount_minor, currency_code, counterparty_id, submitter_person_id)
select pg_temp.id('org_a'), pg_temp.id('line_b'), 'Seeded ' || g, date '2027-01-01' + (g % 300), 20000 + g, 'USD',
  case when g % 2 = 0 then pg_temp.id('cp_rig') else pg_temp.id('cp_lake') end, pg_temp.id('carol')
from generate_series(1, 2000) g;
select pg_temp.place('po_seed' || g, 'v1', 300000 + g) from generate_series(1, 200) g;
insert into world select 'e_seed', e.id from app.expenses e where e.description = 'Seeded 1000';
select pg_temp.as_user('carol');
set local statement_timeout = '5s';
select lives_ok(format($$select * from app.expense_duplicate_candidates(array[%L]::uuid[])$$, pg_temp.id('e_seed')), 'the saved check stays quick over 2,000 expenses');
select lives_ok(format($$select * from app.find_expense_duplicates(%L, %L, 21000, '2027-03-01')$$, pg_temp.id('line_b'), pg_temp.id('cp_rig')), 'so does the draft check');
select lives_ok(format($$select * from app.purchase_order_duplicate_candidates(array[%L]::uuid[])$$, pg_temp.id('po_seed100')), 'and the order check');
select lives_ok(format($$select * from app.expense_duplicate_candidates(array(select e.id from app.expenses e where e.description like 'Seeded %%' limit 20))$$), 'and the check of a page of charges');
set local statement_timeout = 0;
select pg_temp.as_platform();

select * from finish();
rollback;
