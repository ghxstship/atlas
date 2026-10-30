-- pgTAP: 2810, committed on every budget line (P4, RRR-218, gap G-204). app.budget_line_commitments sums the live lines
-- of live purchase orders in Approved, Sent or Closed that draw on a budget line in the budget's currency; Proposed and
-- Canceled orders, soft-deleted rows, header tax and shipping, other-currency lines (counted only) and budget change
-- orders never add to it. A reader who cannot read the project's purchase orders sees it withheld, never partial, and
-- app.budget_line_facts carries the same columns after actual_minor.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(30);

-- World ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into world values ('cp_v', app.create_counterparty(pg_temp.id('org_a'), 'Harborline Staging', 'Equipment Rental'));
select pg_temp.as_platform();
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor) values
  (pg_temp.id('org_a'), pg_temp.system_role('admin'), 'Purchase Order', 'USD', 10000000),
  (pg_temp.id('org_a'), pg_temp.system_role('admin'), 'Purchase Order', 'EUR', 10000000),
  (pg_temp.id('org_a'), pg_temp.system_role('owner'), 'Change Order', 'USD', 10000000);
select pg_temp.as_user('carol');
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_v')) returning id) insert into world select 'ven', id from x;
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Summer Series Budget', 'USD') returning id)
  insert into world select 'bud', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), 1, 'Stage deck rental.', '5000.04.02', 1, 100000, 'X', 'Declared') returning id) insert into world select 'line_a', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), 2, 'Sound package.', '5000.01.01', 1, 20000, 'X', 'Declared') returning id) insert into world select 'line_b', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), 3, 'Lighting rig.', '5000.01.01', 1, 30000, 'X', 'Declared') returning id) insert into world select 'line_c', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), 4, 'Removed line.', '5000.01.01', 1, 1000, 'X', 'Declared') returning id) insert into world select 'line_d', id from x;
update app.budget_lines set deleted_at = now() where id = pg_temp.id('line_d');

-- One order per state, each with a line on line_a. The Approved order also carries a soft-deleted line, tax and shipping.
create function pg_temp.order_with_line(p_key text, p_currency text, p_line text, p_quantity numeric, p_price bigint)
returns void language plpgsql as $$
declare
  v_po uuid;
begin
  insert into app.purchase_orders (project_id, vendor_id, currency_code)
  values (pg_temp.id('prj_a'), pg_temp.id('ven'), p_currency) returning id into v_po;
  insert into world values (p_key, v_po);
  insert into app.po_lines (purchase_order_id, line_number, description, budget_line_id, quantity, unit_price_minor)
  values (v_po, 1, 'Committed line.', pg_temp.id(p_line), p_quantity, p_price);
end $$;
select pg_temp.order_with_line('po_approved', 'USD', 'line_a', 2, 10000);
select pg_temp.order_with_line('po_sent', 'USD', 'line_a', 1, 30000);
select pg_temp.order_with_line('po_closed', 'USD', 'line_a', 3, 1000);
select pg_temp.order_with_line('po_proposed', 'USD', 'line_a', 1, 50000);
select pg_temp.order_with_line('po_canceled', 'USD', 'line_a', 1, 70000);
select pg_temp.order_with_line('po_eur', 'EUR', 'line_a', 1, 40000);
insert into app.po_lines (purchase_order_id, line_number, description, budget_line_id, quantity, unit_price_minor)
  values (pg_temp.id('po_sent'), 2, 'Monitor mixes.', pg_temp.id('line_b'), 1, 5000);
with x as (insert into app.po_lines (purchase_order_id, line_number, description, budget_line_id, quantity, unit_price_minor)
  values (pg_temp.id('po_approved'), 2, 'Withdrawn line.', pg_temp.id('line_a'), 1, 999) returning id) insert into world select 'pol_gone', id from x;
update app.po_lines set deleted_at = now() where id = pg_temp.id('pol_gone');
update app.purchase_orders set tax_minor = 500, shipping_minor = 700 where id = pg_temp.id('po_approved');

-- The creator (carol) cannot approve; the Admin approves within spend authority.
select pg_temp.as_user('bob');
select app.approve_purchase_order(pg_temp.id(k), 'Approved.') from (values ('po_approved'), ('po_sent'), ('po_closed'), ('po_canceled'), ('po_eur')) as v (k);
select pg_temp.as_user('carol');
select app.transition_purchase_order(pg_temp.id('po_sent'), 'Approved', 'Sent', 'Emailed.');
select app.transition_purchase_order(pg_temp.id('po_closed'), 'Approved', 'Sent', 'Emailed.');
select app.transition_purchase_order(pg_temp.id('po_closed'), 'Sent', 'Closed', 'Delivered.');
select app.transition_purchase_order(pg_temp.id('po_canceled'), 'Approved', 'Canceled', 'Vendor withdrew.');
select pg_temp.as_platform();

-- The view ---------------------------------------------------------------------------------------------------------------
select has_view('app', 'budget_line_commitments', 'app.budget_line_commitments exists');
select ok((select reloptions @> array['security_invoker=true'] from pg_class where oid = 'app.budget_line_commitments'::regclass),
  'it is security invoker, so the purchase order read policies decide each sum');
select ok(has_table_privilege('authenticated', 'app.budget_line_commitments', 'select')
  and not has_table_privilege('anon', 'app.budget_line_commitments', 'select'),
  'signed-in people may select it; anonymous callers may not');
select ok(not has_table_privilege('xos_backup', 'app.budget_line_commitments', 'select'),
  'the backup login has no SELECT on the view (1650: pg_dump never reads a view''s rows)');

select pg_temp.as_user('carol');
select is((select count(*)::int from app.budget_line_commitments where budget_id = pg_temp.id('bud')), 3,
  'one row per live budget line of the budget');
select is_empty($$select 1 from app.budget_line_commitments where budget_line_id = pg_temp.id('line_d')$$,
  'a soft-deleted budget line has no row');

-- Approved, Sent and Closed count; Proposed, Canceled, the deleted line, tax, shipping and EUR do not.
select is((select committed_minor from app.budget_line_commitments where budget_line_id = pg_temp.id('line_a')), 53000::bigint,
  'committed sums the Approved (2 x 100.00), Sent (300.00) and Closed (3 x 10.00) lines, leaving out the Proposed and Canceled orders, the soft-deleted line, header tax and shipping, and the EUR order');
select is((select po_line_count from app.budget_line_commitments where budget_line_id = pg_temp.id('line_a')), 3,
  'three purchase order lines are counted');
select is((select other_currency_po_line_count from app.budget_line_commitments where budget_line_id = pg_temp.id('line_a')), 1,
  'the approved EUR line is counted as another currency');
select is((select committed_minor from app.budget_line_commitments where budget_line_id = pg_temp.id('line_b')), 5000::bigint,
  'a second line on the Sent order commits its own budget line');
select is((select committed_minor from app.budget_line_commitments where budget_line_id = pg_temp.id('line_c')), 0::bigint,
  'a line no approved order draws on commits zero, never NULL');
select is((select is_committed_withheld from app.budget_line_commitments where budget_line_id = pg_temp.id('line_a')), false,
  'a Manager who reads the project''s purchase orders sees the figure');

-- The stated rule, computed from the source rows.
select set_eq(
  $$select c.budget_line_id, c.committed_minor from app.budget_line_commitments c where c.budget_id = pg_temp.id('bud')$$,
  $$select bl.id, coalesce(sum(round(pl.quantity * pl.unit_price_minor))
      filter (where o.po_state in ('Approved', 'Sent', 'Closed') and o.currency_code = 'USD'), 0)::bigint
    from app.budget_lines bl
    left join app.po_lines pl on pl.budget_line_id = bl.id and pl.deleted_at is null
    left join app.purchase_orders o on o.id = pl.purchase_order_id and o.deleted_at is null
    where bl.budget_id = pg_temp.id('bud') and bl.deleted_at is null
    group by bl.id$$,
  'committed equals extended amounts of live lines on live Approved, Sent or Closed orders in the budget currency');

-- The Canceled order had been approved: canceling takes an approved order out of Committed.
select is((select count(*)::int from app.purchase_order_state_transitions
           where purchase_order_id = pg_temp.id('po_canceled') and to_state in ('Approved', 'Canceled')), 2,
  'the canceled order was approved before it was canceled, and no longer counts');
select pg_temp.as_user('bob');
select app.approve_purchase_order(pg_temp.id('po_proposed'), 'Approved.');
select pg_temp.as_user('carol');
select is((select committed_minor from app.budget_line_commitments where budget_line_id = pg_temp.id('line_a')), 103000::bigint,
  'the Proposed order counts from the moment it is approved');
select is((select po_line_count from app.budget_line_commitments where budget_line_id = pg_temp.id('line_a')), 4,
  'and its line is counted');

-- Budget change orders amend the budget (Approved changes and Revised, 0480), never Committed.
with x as (insert into app.change_orders (project_id, budget_id, title, order_type_enum_id)
  values (pg_temp.id('prj_a'), pg_temp.id('bud'), 'Add a second stage', 'ENM-092') returning id) insert into world select 'co1', id from x;
insert into app.change_order_lines (change_order_id, budget_line_id, description, urid, quantity, unit_price_minor)
  values (pg_temp.id('co1'), pg_temp.id('line_a'), 'Second stage deck.', '5000.04.02', 1, 25000);
select app.price_change_order(pg_temp.id('co1'), 'Priced.');
select pg_temp.as_user('alice');
select app.approve_change_order(pg_temp.id('co1'), 'Approved.');
select pg_temp.as_user('carol');
select is((select approved_change_minor from app.budget_revised_totals where budget_id = pg_temp.id('bud')), 25000::bigint,
  'the approved change order revises the budget');
select is((select committed_minor from app.budget_line_commitments where budget_line_id = pg_temp.id('line_a')), 103000::bigint,
  'and leaves the line''s committed amount unchanged');

-- Budget line facts --------------------------------------------------------------------------------------------------------
select is((select committed_minor from app.budget_line_facts where budget_line_id = pg_temp.id('line_a')), 103000::bigint,
  'budget line facts carry the committed amount');
select is((select other_currency_po_line_count from app.budget_line_facts where budget_line_id = pg_temp.id('line_a')), 1,
  'and the other-currency count');
select pg_temp.as_platform();
select is(
  (select array_agg(column_name::text order by ordinal_position) from information_schema.columns
   where table_schema = 'app' and table_name = 'budget_line_facts' and ordinal_position > 20),
  array['committed_minor', 'other_currency_po_line_count', 'is_committed_withheld'],
  'the committed columns are appended after actual_minor, keeping 0480''s columns in place');
select is(
  (select array_agg(column_name::text order by ordinal_position) from information_schema.columns
   where table_schema = 'app' and table_name = 'budget_line_facts' and column_name in ('committed_minor', 'other_currency_po_line_count', 'is_committed_withheld')),
  (select array_agg(column_name::text order by ordinal_position) from information_schema.columns
   where table_schema = 'app' and table_name = 'budget_line_commitments' and column_name in ('committed_minor', 'other_currency_po_line_count', 'is_committed_withheld')),
  'the appended columns are the commitment view''s');
select ok(col_description('app.budget_line_facts'::regclass,
    (select attnum from pg_attribute where attrelid = 'app.budget_line_facts'::regclass and attname = 'account_code'))
  like 'Expense account the line posts to (app.budget_line_amounts)%',
  '1611''s comment on account_code is kept');

-- Withheld, never partial ----------------------------------------------------------------------------------------------------
-- erin (Collaborator, a project member of NWL) gains a custom role with finance.budget.read and nothing on purchase orders.
select pg_temp.as_user('erin');
select is((select count(*)::int from app.budget_line_commitments), 0, 'without finance.budget.read a project member reads no commitments');
select pg_temp.as_user('alice');
insert into app.roles (org_id, code, name, band, description)
values (pg_temp.id('org_a'), 'budget_reader', 'Budget Reader', 4, 'Reads budgets only.');
insert into app.role_capabilities (role_id, capability_code, reach)
  select id, 'finance.budget.read', 'organization' from app.roles where code = 'budget_reader' and org_id = pg_temp.id('org_a');
select pg_temp.as_user_stepped_up('alice');
insert into app.membership_roles (membership_id, role_id)
  select pg_temp.id('erin@org_a'), id from app.roles where code = 'budget_reader' and org_id = pg_temp.id('org_a');
select pg_temp.as_user('erin');
select is((select count(*)::int from app.budget_line_commitments where budget_id = pg_temp.id('bud')), 3,
  'with finance.budget.read alone she reads every line of the budget');
select ok((select bool_and(is_committed_withheld and committed_minor is null) from app.budget_line_commitments where budget_id = pg_temp.id('bud')),
  'but without procurement.po.read committed is withheld on every line: NULL, never a partial sum');
select ok((select bool_and(is_committed_withheld and committed_minor is null) from app.budget_line_facts where budget_id = pg_temp.id('bud')),
  'and so it is in budget line facts');

-- Other readers ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select is((select count(*)::int from app.budget_line_commitments), 0, 'a Viewer in no project reads no rows');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.budget_line_commitments), 0, 'another org reads no rows');
select pg_temp.as_anon();
select throws_ok('select 1 from app.budget_line_commitments', '42501', null, 'anon cannot read commitments');
select pg_temp.as_platform();

select * from finish();
rollback;
