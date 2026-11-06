-- pgTAP: 3027, estimate to complete, estimated final cost and forward exposure (B13, RRR-237, gap G-205). No commitment;
-- commitment above actual; actual above commitment; an ETC override; unpriced without and with an entered ETC; an unpriced
-- purchase order line; withheld all NULL for a reader missing purchase orders, expenses or change orders; the unallocated
-- approved change row; totals reconcile with revised.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select no_plan();

select pg_temp.as_user('alice');
insert into world values ('cp_v', app.create_counterparty(pg_temp.id('org_a'), 'Harborline Staging', 'Equipment Rental'));
select pg_temp.as_platform();
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor) values
  (pg_temp.id('org_a'), pg_temp.system_role('admin'), 'Purchase Order', 'USD', 10000000),
  (pg_temp.id('org_a'), pg_temp.system_role('owner'), 'Change Order', 'USD', 10000000);
select pg_temp.as_user('carol');
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_v')) returning id) insert into world select 'ven', id from x;
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Forecast', 'USD') returning id) insert into world select 'bud', id from x;

create function pg_temp.line(p_key text, p_n int, p_price bigint, p_etc bigint default null) returns void language plpgsql as $$
declare v uuid;
begin
  insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, etc_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), p_n, p_key, '5000.04.02', 1, p_price, p_etc, 'X', 'Declared') returning id into v;
  insert into world values (p_key, v);
end $$;
grant execute on function pg_temp.line(text, int, bigint, bigint) to public;

create function pg_temp.committed(p_line text, p_price bigint) returns void language plpgsql as $$
declare v_po uuid; v_number bigint := (select coalesce(max(po_number), 9000) + 1 from app.purchase_orders);
begin
  insert into app.purchase_orders (org_id, project_id, po_number, vendor_id, currency_code, po_state)
  values (pg_temp.id('org_a'), pg_temp.id('prj_a'), v_number, pg_temp.id('ven'), 'USD', 'Approved') returning id into v_po;
  insert into app.po_lines (org_id, purchase_order_id, line_number, description, budget_line_id, quantity, unit_price_minor)
  values (pg_temp.id('org_a'), v_po, 1, 'Committed line.', pg_temp.id(p_line), 1, p_price);
end $$;
grant execute on function pg_temp.committed(text, bigint) to public;

create function pg_temp.spent(p_line text, p_amount bigint) returns void language plpgsql as $$
begin
  insert into app.expenses (org_id, budget_line_id, amount_minor, currency_code, description, incurred_on, expense_state)
  values (pg_temp.id('org_a'), pg_temp.id(p_line), p_amount, 'USD', 'Spend.', '2027-06-01', 'Approved');
end $$;
grant execute on function pg_temp.spent(text, bigint) to public;

select pg_temp.line('none', 1, 1000);
select pg_temp.line('above', 2, 1000);
select pg_temp.line('below', 3, 1000);
select pg_temp.line('over', 4, 1000);
select pg_temp.line('etc', 5, 1000, 250);
select pg_temp.line('unpriced', 6, null);
select pg_temp.line('unpriced_etc', 7, null, 400);
select pg_temp.line('po_unpriced', 8, 1000);
select pg_temp.as_platform();
alter table app.purchase_orders disable trigger user;
alter table app.po_lines disable trigger user;
alter table app.expenses disable trigger user;
select pg_temp.committed('above', 800);
select pg_temp.spent('above', 300);
select pg_temp.committed('below', 200);
select pg_temp.spent('below', 300);
select pg_temp.spent('over', 1500);
select pg_temp.committed('po_unpriced', null);
alter table app.purchase_orders enable trigger user;
alter table app.po_lines enable trigger user;
alter table app.expenses enable trigger user;

select pg_temp.as_user('carol');
create function pg_temp.f(p_key text) returns app.budget_line_forecasts language sql as $$
  select * from app.budget_line_forecasts where budget_line_id = pg_temp.id(p_key) $$;
grant execute on function pg_temp.f(text) to public;

select is((pg_temp.f('none')).etc_minor, 1000::bigint, 'no commitment: ETC = current budget - actual');
select is((pg_temp.f('none')).efc_minor, 1000::bigint, 'and EFC = max(current budget, actual)');
select is((pg_temp.f('none')).etc_source, 'Derived', 'the ETC is derived');
select is((pg_temp.f('above')).remaining_commitment_minor, 500::bigint, 'committed 800, actual 300: remaining 500');
select is((pg_temp.f('above')).efc_minor, (pg_temp.f('above')).actual_minor + 500 + (pg_temp.f('above')).etc_minor, 'EFC = actual + remaining + ETC');
select is((pg_temp.f('above')).efc_minor, 1000::bigint, 'EFC = max(current budget, committed, actual)');
select is((pg_temp.f('below')).remaining_commitment_minor, 0::bigint, 'committed 200, actual 300: remaining 0');
select is((pg_temp.f('below')).efc_minor, 1000::bigint, 'with EFC at the current budget');
select is((pg_temp.f('over')).etc_minor, 0::bigint, 'actual above budget: ETC is 0');
select is((pg_temp.f('over')).efc_minor, 1500::bigint, 'and EFC is the actual');
select is((pg_temp.f('over')).variance_at_completion_minor, -500::bigint, 'variance at completion is negative');
select is((pg_temp.f('etc')).etc_minor, 250::bigint, 'an entered ETC replaces the derived one');
select is((pg_temp.f('etc')).etc_source, 'Entered', 'and says so');
update app.budget_lines set etc_minor = null where id = pg_temp.id('etc');
select is((pg_temp.f('etc')).etc_source, 'Derived', 'clearing it derives again');
select is((pg_temp.f('unpriced')).etc_minor, null::bigint, 'unpriced without an ETC: NULL ETC, never 0 (GREATEST ignores NULL, so the case is explicit)');
select is((pg_temp.f('unpriced')).efc_minor, null::bigint, 'and NULL EFC');
select is((pg_temp.f('unpriced_etc')).efc_minor, 400::bigint, 'an entered ETC makes EFC known on an unpriced line');
select is((pg_temp.f('unpriced_etc')).variance_at_completion_minor, null::bigint, 'while variance at completion stays NULL');
select is((pg_temp.f('po_unpriced')).remaining_commitment_minor, null::bigint, 'an unpriced PO line: NULL remaining, not 0');
select is((pg_temp.f('po_unpriced')).efc_minor, null::bigint, 'and NULL EFC');
select is((pg_temp.f('po_unpriced')).is_withheld, false, 'without being withheld');
select is((select efc_minor from app.budget_forecast_totals where budget_id = pg_temp.id('bud')), null::bigint, 'totals are NULL while a line is unknown');

-- An entered ETC with unknown commitments leaves EFC unknown.
update app.budget_lines set etc_minor = 100 where id = pg_temp.id('po_unpriced');
select is((pg_temp.f('po_unpriced')).efc_minor, null::bigint, 'an entered ETC does not cover an unknown commitment');

-- Totals reconcile with revised, with an approved change that names no line ------------------------------------------------
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Reconcile', 'USD') returning id) insert into world select 'bud2', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud2'), 1, 'Deck.', '5000.04.02', 1, 1000, 'X', 'Declared') returning id) insert into world select 'r1', id from x;
select pg_temp.as_platform();
alter table app.change_orders disable trigger user;
alter table app.change_order_lines disable trigger user;
with c as (insert into app.change_orders (project_id, budget_id, title, reason, change_order_state, change_order_number, org_id)
  values (pg_temp.id('prj_a'), pg_temp.id('bud2'), 'More scope', 'More.', 'Approved', 9001, pg_temp.id('org_a')) returning id)
  insert into world select 'co', id from c;
insert into app.change_order_lines (change_order_id, org_id, description, urid, quantity, unit_price_minor)
  values (pg_temp.id('co'), pg_temp.id('org_a'), 'Added scope.', '5000.04.02', 1, 300);
alter table app.change_orders enable trigger user;
alter table app.change_order_lines enable trigger user;
select pg_temp.as_user('alice');
select is((select efc_minor from app.budget_forecast_totals where budget_id = pg_temp.id('bud2')),
  (select revised_total_minor from app.budget_revised_totals where budget_id = pg_temp.id('bud2')), 'total EFC reconciles with the revised budget');
select is((select unallocated_change_minor from app.budget_forecast_totals where budget_id = pg_temp.id('bud2')), 300::bigint, 'the unallocated change is counted');

-- Withheld, never partial (C8) ------------------------------------------------------------------------------------------------
create function pg_temp.reader(p_code text, p_caps text[]) returns void language plpgsql as $$
begin
  perform pg_temp.as_user('alice');
  insert into app.roles (org_id, code, name, band, description) values (pg_temp.id('org_a'), p_code, p_code, 4, 'Test reader.');
  insert into app.role_capabilities (role_id, capability_code, reach)
    select r.id, c, 'organization' from app.roles r, unnest(p_caps) c where r.code = p_code and r.org_id = pg_temp.id('org_a');
  perform pg_temp.as_user_stepped_up('alice');
  update app.membership_roles set deleted_at = now() where membership_id = pg_temp.id('erin@org_a') and deleted_at is null;
  insert into app.membership_roles (membership_id, role_id)
    select pg_temp.id('erin@org_a'), r.id from app.roles r where r.code = p_code and r.org_id = pg_temp.id('org_a');
  perform pg_temp.as_user('erin');
end $$;
grant execute on function pg_temp.reader(text, text[]) to public;

select pg_temp.reader('no_po', array['finance.budget.read', 'finance.expense.read', 'finance.change_order.read']);
select is((select bool_and(is_withheld and efc_minor is null and etc_minor is null and remaining_commitment_minor is null and forward_exposure_minor is null
                           and variance_at_completion_minor is null) from app.budget_line_forecasts where budget_id = pg_temp.id('bud')), true,
  'without procurement.po.read every forecast figure is blank');
select is((select is_withheld and efc_minor is null from app.budget_forecast_totals where budget_id = pg_temp.id('bud')), true, 'and the totals');
select pg_temp.reader('no_expense', array['finance.budget.read', 'procurement.po.read', 'finance.change_order.read']);
select is((select bool_and(is_withheld and efc_minor is null) from app.budget_line_forecasts where budget_id = pg_temp.id('bud')), true,
  'without finance.expense.read too');
select pg_temp.reader('no_change', array['finance.budget.read', 'procurement.po.read', 'finance.expense.read']);
select is((select bool_and(is_withheld and efc_minor is null) from app.budget_line_forecasts where budget_id = pg_temp.id('bud')), true,
  'and without finance.change_order.read');
select pg_temp.reader('all_three', array['finance.budget.read', 'procurement.po.read', 'finance.expense.read', 'finance.change_order.read']);
select is((select bool_and(not is_withheld) from app.budget_line_forecasts where budget_id = pg_temp.id('bud')), true, 'with all three the figures show');

select pg_temp.as_platform();
select ok(not exists (select 1 from pg_roles where rolname = 'xos_backup') or not has_table_privilege('xos_backup', 'app.budget_line_forecasts', 'select'),
  'the backup login has no SELECT on forecasts');

select * from finish();
rollback;
