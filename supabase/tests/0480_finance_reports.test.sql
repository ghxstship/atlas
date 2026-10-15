-- pgTAP: A15 finance and reports (0480). The finance domain events,
-- and the NULL-aware report views: budget line facts, change order line facts and budget totals
-- revised by approved change orders. Same-tenant allow, cross-tenant deny, anon deny, role bands.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(27);

-- World ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.cost_centers (org_id, code, name, kind) values (pg_temp.id('org_a'), 'CC-VENUE', 'Venue Operations', 'Standing') returning id) insert into world select 'cc_venue', id from x;
with x as (insert into app.budgets (project_id, name, currency_code, is_baseline) values (pg_temp.id('prj_a'), 'Summer Series Budget', 'USD', true) returning id) insert into world select 'bud_a', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, cost_center_id, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud_a'), 1, 'Stage deck rental.', '5000.04.02', pg_temp.id('cc_venue'), 2, 15000, 'X', 'Declared') returning id) insert into world select 'line_stage', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, xyz, xyz_basis)
  values (pg_temp.id('bud_a'), 2, 'Sound package.', '5000.01.01', 1, 'X', 'Declared') returning id) insert into world select 'line_sound', id from x;
select pg_temp.as_platform();

-- Domain events ---------------------------------------------------------------------------------
select is((select count(*)::int from app.domain_events where event_type = 'budget.created' and subject_id = pg_temp.id('bud_a')), 1,
  'creating a budget emits budget.created');
select is((select project_id from app.domain_events where event_type = 'budget.created' and subject_id = pg_temp.id('bud_a')), pg_temp.id('prj_a'),
  'and carries its project for per-project subscriptions');
select is((select count(*)::int from app.domain_events where event_type = 'cost_center.created' and subject_id = pg_temp.id('cc_venue')), 1,
  'creating a cost center emits cost_center.created');
select pg_temp.as_user('carol');
update app.budget_lines set unit_price_minor = 16000 where id = pg_temp.id('line_stage');
select pg_temp.as_platform();

-- Budget line facts --------------------------------------------------------------------------------------------
select is((select account_code from app.budget_line_facts where budget_line_id = pg_temp.id('line_stage')), '5500',
  'a line carries the account derived from its URID class');
select is((select cost_center_code from app.budget_line_facts where budget_line_id = pg_temp.id('line_stage')), 'CC-VENUE',
  'and its cost center code');
select is((select dept_code from app.budget_line_facts where budget_line_id = pg_temp.id('line_stage')), '5000',
  'and its department class');
select is((select extended_minor from app.budget_line_facts where budget_line_id = pg_temp.id('line_sound')), null::bigint,
  'an unpriced line extends to NULL, never zero');
select is((select is_unpriced from app.budget_line_facts where budget_line_id = pg_temp.id('line_sound')), true,
  'and is flagged unpriced');

-- Change orders revise the budget (journey 6) --------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.change_orders (project_id, budget_id, title, order_type_enum_id) values (pg_temp.id('prj_a'), pg_temp.id('bud_a'), 'Add a second stage', 'ENM-092') returning id) insert into world select 'co1', id from x;
with x as (insert into app.change_order_lines (change_order_id, budget_line_id, description, urid, quantity) values (pg_temp.id('co1'), pg_temp.id('line_stage'), 'Second stage deck.', '5000.04.02', 1) returning id) insert into world select 'col1', id from x;
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'change_order.requested' and subject_id = pg_temp.id('co1')), 1,
  'requesting a change order emits change_order.requested');
select is((select extended_minor from app.change_order_line_facts where change_order_line_id = pg_temp.id('col1')), null::bigint,
  'an unpriced change order line extends to NULL, never zero');
select is((select cost_center_id from app.change_order_line_facts where change_order_line_id = pg_temp.id('col1')), pg_temp.id('cc_venue'),
  'a change line inherits the cost center of the line it adjusts');
select is((select account_code from app.change_order_line_facts where change_order_line_id = pg_temp.id('col1')), '5500',
  'and the account of its URID class');
select is((select revised_total_minor from app.budget_revised_totals where budget_id = pg_temp.id('bud_a')), null::bigint,
  'the revised total of a budget with an unpriced line is NULL');

select pg_temp.as_user('carol');
update app.budget_lines set unit_price_minor = 50000 where id = pg_temp.id('line_sound');
update app.change_order_lines set unit_price_minor = 25000 where id = pg_temp.id('col1');
select app.price_change_order(pg_temp.id('co1'), 'Priced.');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'change_order.state_changed' and subject_id = pg_temp.id('co1')), 1,
  'pricing emits change_order.state_changed');
select is((select approved_change_minor from app.budget_revised_totals where budget_id = pg_temp.id('bud_a')), 0::bigint,
  'a priced change order does not revise the budget before approval');
select is((select revised_total_minor from app.budget_revised_totals where budget_id = pg_temp.id('bud_a')), 82000::bigint,
  'the revised total equals the original total before approval');

insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor) values (pg_temp.id('org_a'), pg_temp.system_role('owner'), 'Change Order', 'USD', 1000000);
select pg_temp.as_user('alice');
select is(app.approve_change_order(pg_temp.id('co1'), 'Approved.'), true, 'the Owner approves within spend authority');
select pg_temp.as_platform();
select is((select approved_change_count::int from app.budget_revised_totals where budget_id = pg_temp.id('bud_a')), 1,
  'the budget counts one approved change order');
select is((select approved_change_minor from app.budget_revised_totals where budget_id = pg_temp.id('bud_a')), 25000::bigint,
  'with its approved amount');
select is((select revised_total_minor from app.budget_revised_totals where budget_id = pg_temp.id('bud_a')), 107000::bigint,
  'and the revised total includes it');

-- Expense and payment state events -------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.expenses (budget_line_id, description, incurred_on, amount_minor, currency_code)
  values (pg_temp.id('line_stage'), 'Deck deposit.', '2027-06-10', 4000, 'USD') returning id) insert into world select 'exp1', id from x;
select app.transition_expense(pg_temp.id('exp1'), 'Proposed', 'Canceled', 'Duplicate entry.');
select pg_temp.as_platform();
select is((select data ->> 'to_state' from app.domain_events where event_type = 'expense.state_changed' and subject_id = pg_temp.id('exp1')), 'Canceled',
  'canceling an expense emits expense.state_changed with the new state');

-- RLS on the views ------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is((select count(*)::int from app.budget_line_facts), 2, 'a Member reads the line facts of their project');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.budget_line_facts), 0, 'a Viewer in no project reads no line facts');
select is((select count(*)::int from app.budget_revised_totals), 0, 'nor revised totals');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.change_order_line_facts), 0, 'another org reads no change order line facts');
select is((select count(*)::int from app.budget_revised_totals), 0, 'nor another org''s revised totals');
select pg_temp.as_anon();
select throws_ok('select 1 from app.budget_line_facts', '42501', null, 'anon cannot read budget line facts');
select pg_temp.as_platform();

select * from finish();
rollback;
