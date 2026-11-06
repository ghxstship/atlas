-- pgTAP: 3018, the all-in cost of an act (B12, RRR-236, gap G-186; Section 3.7). app.engagement_cost_items attributes each
-- cost to one engagement (by allocation, then an explicit engagement or roster entry, then the person) and
-- app.engagement_costs sums it per engagement and currency: settlement (withholding not subtracted), bills, travel,
-- lodging (nights times rate), per diems including a roster entry's, hospitality (catering and amenity only), expenses net
-- of credits and purchase order lines. An engagement bill counts only the part above its settlements in that currency,
-- with an unpriced earlier bill or settlement leaving it NULL. An unpriced travel segment makes the engagement's total NULL
-- with the priced total and the count beside it; currencies are never summed together. Both refuse a reader without all six
-- capabilities on the project, and neither reads engagements.agreed_rate_minor.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql
\ir 3010_payables_world.psql

select no_plan();

select ok(position('agreed_rate_minor' in pg_get_functiondef('app.engagement_cost_items(uuid, uuid)'::regprocedure)) = 0
  and position('agreed_rate_minor' in pg_get_functiondef('app.engagement_costs(uuid, uuid)'::regprocedure)) = 0,
  'neither function reads the Restricted agreed rate');

-- art (eng_art_a): every component ---------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.settlements (engagement_id, project_id, title, currency_code, settled_on)
  values (pg_temp.id('eng_art_a'), pg_temp.id('prj_a'), 'Headline set', 'USD', '2027-06-06') returning id) insert into world select 'st_art', id from x;
insert into app.settlement_lines (settlement_id, line_number, line_kind, description, amount_minor) values
  (pg_temp.id('st_art'), 1, 'Guarantee', 'Guarantee.', 100000),
  (pg_temp.id('st_art'), 2, 'Bonus', 'Sell-out bonus.', 20000),
  (pg_temp.id('st_art'), 3, 'Deduction', 'Merch commission.', 5000),
  (pg_temp.id('st_art'), 4, 'Withholding', 'State withholding.', 10000);
select pg_temp.move('settlement', 'app.settlements', 'settlement_id', 'st_art', 'Proposed', 'Submitted');
select pg_temp.move('settlement', 'app.settlements', 'settlement_id', 'st_art', 'Submitted', 'Accepted');
-- art billed the settled fee: listed, counted at nothing.
select pg_temp.bill('bill_art', null, 'USD', 115000, '2027-06-09', 'Approved', 'art', 'eng_art_a');
select pg_temp.as_platform();
update app.accommodation_blocks set nightly_rate_minor = 20000, currency_code = 'USD' where id = pg_temp.id('blk');
insert into app.travel_segments (project_id, person_id, travel_mode, departs_from, departs_at, departs_time_zone, arrives_at_place,
  arrives_time_zone, price_minor, currency_code)
values (pg_temp.id('prj_a'), pg_temp.id('art'), 'Flight', 'LAX', '2027-06-01 15:00+00', 'America/Los_Angeles', 'MIA',
  'America/New_York', 30000, 'USD');
insert into app.accommodation_assignments (accommodation_block_id, person_id, check_in_on, check_out_on)
values (pg_temp.id('blk'), pg_temp.id('art'), '2027-06-01', '2027-06-03');
insert into app.fulfillment_lines (fulfillment_id, description, person_id, quantity, unit_price_minor, currency_code) values
  (pg_temp.id('ful_cat'), 'Rider catering.', pg_temp.id('art'), 2, 1500, 'USD'),
  (pg_temp.id('ful_trv'), 'Flight booking fee.', pg_temp.id('art'), 1, 99999, 'USD');
select pg_temp.expense('art_backline', 'carol', 'line_a', 25000, '2027-06-05');
select pg_temp.as_user('carol');
update app.expenses set engagement_id = pg_temp.id('eng_art_a') where id = pg_temp.id('art_backline');
select pg_temp.as_platform();
select pg_temp.approve('art_backline');
select pg_temp.expense('art_refund', 'carol', 'line_a', 5000, '2027-06-07', null, false, 'art_backline');
select pg_temp.approve('art_refund');
select pg_temp.as_user('carol');
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_rig')) returning id) insert into world select 'v_rig', id from x;
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code, tax_minor) values (pg_temp.id('prj_a'), pg_temp.id('v_rig'), 'USD', 999) returning id)
  insert into world select 'po_art', id from x;
insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_price_minor, engagement_id) values
  (pg_temp.id('po_art'), 1, 'Drum riser hire.', 2, 10000, pg_temp.id('eng_art_a')),
  (pg_temp.id('po_art'), 2, 'House rigging.', 1, 70000, null);
select pg_temp.as_user('bob');
select app.approve_purchase_order(pg_temp.id('po_art'), 'Within limit.');

-- kai on Bayside Audio's roster (eng_vendor_a): a roster per diem and an unpriced flight.
select pg_temp.as_user('carol');
insert into app.per_diems (project_id, roster_entry_id, day, amount_minor, currency_code)
values (pg_temp.id('prj_a'), pg_temp.id('e_kai'), '2027-06-02', 4500, 'USD');
select pg_temp.as_platform();
insert into app.travel_segments (project_id, person_id, travel_mode, departs_from, departs_at, departs_time_zone, arrives_at_place, arrives_time_zone)
values (pg_temp.id('prj_a'), pg_temp.id('kai'), 'Ground', 'Orlando', '2027-06-01 12:00+00', 'America/New_York', 'Miami', 'America/New_York');

-- art again, on settlements with withholding: Guarantee 1000 and Withholding 300 with a bill of 1000, of 700 or of 1200.
select pg_temp.as_platform();
create function pg_temp.settled(p_key text, p_currency text, p_engagement text default 'eng_art_a', p_guarantee bigint default 100000, p_withholding bigint default 30000) returns void
language plpgsql as $$
declare
  v uuid;
begin
  perform pg_temp.as_user('carol');
  insert into app.settlements (engagement_id, project_id, title, currency_code, settled_on)
  values (pg_temp.id(p_engagement), pg_temp.id('prj_a'), 'Settled in ' || p_currency, p_currency, '2027-06-06') returning id into v;
  insert into world values (p_key, v);
  insert into app.settlement_lines (settlement_id, line_number, line_kind, description, amount_minor) values
    (v, 1, 'Guarantee', 'Guarantee.', p_guarantee), (v, 2, 'Withholding', 'State withholding.', p_withholding);
  perform pg_temp.move('settlement', 'app.settlements', 'settlement_id', p_key, 'Proposed', 'Submitted');
  perform pg_temp.move('settlement', 'app.settlements', 'settlement_id', p_key, 'Submitted', 'Accepted');
end $$;
select pg_temp.settled('st_eur', 'EUR');
select pg_temp.bill('bill_eur', null, 'EUR', 100000, '2027-06-09', 'Approved', 'art', 'eng_art_a');
select pg_temp.settled('st_gbp', 'GBP');
select pg_temp.bill('bill_gbp', null, 'GBP', 70000, '2027-06-09', 'Approved', 'art', 'eng_art_a');
select pg_temp.settled('st_cad', 'CAD');
select pg_temp.bill('bill_cad', null, 'CAD', 120000, '2027-06-09', 'Approved', 'art', 'eng_art_a');

-- On Bayside Audio, whose total is already NULL: an unpriced bill leaves every later one uncounted, and so does an unpriced
-- settlement.
select pg_temp.bill('bill_gbp1', 'cp_v_a', 'GBP', 900, '2027-06-01', 'Approved', null, 'eng_vendor_a');
-- An Approved bill cannot lose its price through any RPC (invoice_unpriced), so the fixture takes it directly.
alter table app.invoice_lines disable trigger user;
update app.invoice_lines set unit_price_minor = null where invoice_id = pg_temp.id('bill_gbp1');
alter table app.invoice_lines enable trigger user;
select pg_temp.bill('bill_gbp2', 'cp_v_a', 'GBP', 5000, '2027-06-02', 'Approved', null, 'eng_vendor_a');
select pg_temp.settled('st_cad_v', 'CAD', 'eng_vendor_a', null, 0);
select pg_temp.bill('bill_cad_v', 'cp_v_a', 'CAD', 5000, '2027-06-02', 'Approved', null, 'eng_vendor_a');

-- A person step for a per diem naming only a membership: on an act's engagement it goes there, and internal crew stay out.
select pg_temp.as_platform();
insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
select pg_temp.id('prj_a'), pg_temp.id('frank'), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-06-01';
select pg_temp.as_user('carol');
with x as (insert into app.per_diems (project_id, membership_id, day, amount_minor, currency_code)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-06-03', 1200, 'USD') returning id) insert into world select 'pd_frank', id from x;
with x as (insert into app.per_diems (project_id, membership_id, day, amount_minor, currency_code)
  values (pg_temp.id('prj_a'), pg_temp.id('dave@org_a'), '2027-06-03', 1300, 'USD') returning id) insert into world select 'pd_dave', id from x;

-- ivy (eng_ivy_a): bills in two currencies, no settlement.
select pg_temp.bill('bill_ivy_usd', null, 'USD', 7000, '2027-06-09', 'Approved', 'ivy', 'eng_ivy_a');
select pg_temp.bill('bill_ivy_eur', null, 'EUR', 3000, '2027-06-09', 'Disputed', 'ivy', 'eng_ivy_a');
select pg_temp.bill('bill_ivy_prop', null, 'USD', 9000, '2027-06-09', 'Proposed', 'ivy', 'eng_ivy_a');

-- Items ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select string_agg(component || ':' || coalesce(amount_minor::text, 'null') || ':' || coalesce(counted_minor::text, 'null'), ','
    order by component, amount_minor)
  from app.engagement_cost_items(pg_temp.id('prj_a'), pg_temp.id('eng_art_a')) where currency_code = 'USD'),
  'expense:20000:20000,hospitality:3000:3000,invoice:115000:0,lodging:40000:40000,purchase_order:20000:20000,settlement:115000:115000,travel:30000:30000',
  'art''s items: settlement without withholding, the billed settlement counted at nothing, travel, two nights, catering only, the expense net of its credit and the attributed line');
select is((select invoice_minor || '/' || settlement_minor || '/' || total_minor from app.engagement_costs(pg_temp.id('prj_a'), pg_temp.id('eng_art_a')) where currency_code = 'EUR'),
  '0/100000/100000', 'Guarantee 1000 and Withholding 300 with a bill of 1000 costs 1000');
select is((select invoice_minor || '/' || settlement_minor || '/' || total_minor from app.engagement_costs(pg_temp.id('prj_a'), pg_temp.id('eng_art_a')) where currency_code = 'GBP'),
  '0/100000/100000', 'with a bill of 700 it costs 1000');
select is((select invoice_minor || '/' || settlement_minor || '/' || total_minor from app.engagement_costs(pg_temp.id('prj_a'), pg_temp.id('eng_art_a')) where currency_code = 'CAD'),
  '20000/100000/120000', 'with a bill of 1200 it costs 1200');
select is((select coalesce(counted_minor::text, 'null') from app.engagement_cost_items(pg_temp.id('prj_a'), pg_temp.id('eng_vendor_a')) where source_id = pg_temp.id('bill_gbp2')),
  'null', 'a priced bill after an unpriced one is not counted');
select is((select coalesce(counted_minor::text, 'null') from app.engagement_cost_items(pg_temp.id('prj_a'), pg_temp.id('eng_vendor_a')) where source_id = pg_temp.id('bill_cad_v')),
  'null', 'nor a bill beside an unpriced settlement');
select is((select string_agg(component || ':' || coalesce(amount_minor::text, 'null'), ',' order by component)
  from app.engagement_cost_items(pg_temp.id('prj_a'), pg_temp.id('eng_vendor_a')) where component in ('per_diem', 'travel')), 'per_diem:4500,travel:null',
  'kai''s roster per diem and unpriced trip go to the roster''s engagement');
select is((select e.person_id from app.engagement_cost_items(pg_temp.id('prj_a')) i join app.engagements e on e.id = i.engagement_id where i.source_id = pg_temp.id('pd_frank')),
  pg_temp.id('frank'), 'a per diem naming only a membership follows its person to their act');
select is((select count(*)::int from app.engagement_cost_items(pg_temp.id('prj_a')) where source_id = pg_temp.id('pd_dave')), 0,
  'internal crew attribute to no act');
select is((select count(*)::int from app.engagement_cost_items(pg_temp.id('prj_a'))
  where source_id in (select pl.id from app.po_lines pl where pl.purchase_order_id = pg_temp.id('po_art') and pl.engagement_id is null)), 0,
  'a line naming no engagement is no act''s cost');
select is((select count(*)::int from (select source_id from app.engagement_cost_items(pg_temp.id('prj_a')) group by source_id having count(*) > 1) d), 0,
  'each item is attributed to one engagement only');

-- Roll-up ----------------------------------------------------------------------------------------------------------------------
select is((select settlement_minor || '/' || invoice_minor || '/' || travel_minor || '/' || lodging_minor || '/' || per_diem_minor || '/'
    || hospitality_minor || '/' || expense_minor || '/' || purchase_order_minor || '/' || priced_total_minor || '/' || total_minor || '/' || unpriced_count
  from app.engagement_costs(pg_temp.id('prj_a'), pg_temp.id('eng_art_a')) where currency_code = 'USD'),
  '115000/0/30000/40000/0/3000/20000/20000/228000/228000/0', 'art''s all-in cost in USD');
select is((select person_id::text || '/' || role_type::text from app.engagement_costs(pg_temp.id('prj_a'), pg_temp.id('eng_art_a')) where currency_code = 'USD'),
  pg_temp.id('art')::text || '/Artist', 'with the engagement''s party and role');
select is((select coalesce(total_minor::text, 'null') || '/' || priced_total_minor || '/' || unpriced_count || '/' || coalesce(travel_minor::text, 'null')
  from app.engagement_costs(pg_temp.id('prj_a'), pg_temp.id('eng_vendor_a')) where currency_code = 'USD'),
  'null/4500/5/null', 'an unpriced item leaves the total NULL, with the priced total and the unpriced count beside it, and a trip with no currency reads as no 0 under travel');
select is((select coalesce(travel_minor::text, 'null') || '/' || lodging_minor from app.engagement_costs(pg_temp.id('prj_a'), pg_temp.id('eng_vendor_a')) where currency_code = 'GBP'),
  'null/0', 'on every currency''s row, while a component with nothing unpriced still sums');
select is((select string_agg(currency_code || ':' || invoice_minor || ':' || total_minor, ',' order by currency_code)
  from app.engagement_costs(pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'))), 'EUR:3000:3000,USD:7000:7000',
  'one row per currency, never summed; a Proposed bill is not yet a cost');
select ok((select count(distinct engagement_id) from app.engagement_costs(pg_temp.id('prj_a'))) >= 3, 'the project''s acts each have rows');

-- Gate ---------------------------------------------------------------------------------------------------------------------------
select is(app.can_read_engagement_costs(pg_temp.id('prj_a')), true, 'a manager reads all-in costs');
select pg_temp.as_user('gina');
select is(app.can_read_engagement_costs(pg_temp.id('prj_a')), false, 'a viewer does not');
select throws_ok(format($$select * from app.engagement_costs(%L)$$, pg_temp.id('prj_a')), '42501', null,
  'the roll-up refuses a reader without the finance capabilities');
select throws_ok(format($$select * from app.engagement_cost_items(%L)$$, pg_temp.id('prj_a')), '42501', null, 'and so do the items');
select pg_temp.as_user('xavier');
select throws_ok(format($$select * from app.engagement_costs(%L)$$, pg_temp.id('prj_a')), '42501', null, 'another org reads none of it');
select pg_temp.as_platform();

-- Each of the six capabilities is needed: the member holds them all, until one is taken away.
create function pg_temp.check_capability(p_capability text) returns setof text
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  delete from app.role_capabilities where role_id = pg_temp.system_role('member') and capability_code = p_capability;
  perform pg_temp.as_user('dave');
  return next ok(not app.can_read_engagement_costs(pg_temp.id('prj_a')), 'the roll-up needs ' || p_capability);
  return next throws_ok(format($q$select * from app.engagement_costs(%L)$q$, pg_temp.id('prj_a')), '42501', null, 'and refuses without ' || p_capability);
  perform pg_temp.as_platform();
  insert into app.role_capabilities (role_id, capability_code, reach) values (pg_temp.system_role('member'), p_capability, 'organization');
end $$;
select pg_temp.as_user('dave');
select ok(app.can_read_engagement_costs(pg_temp.id('prj_a')), 'a member on the project holds all six');
select r from unnest(array['finance.invoice.read', 'finance.expense.read', 'procurement.po.read', 'crew.time_entry.read', 'hospitality.fulfillment.read', 'opportunities.engagement.read']) c, pg_temp.check_capability(c) r;
select pg_temp.as_platform();

select * from finish();
rollback;
