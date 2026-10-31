-- pgTAP: vendor line history (B15, RRR-239, migration 3043). For each description, at most three earlier lines with a
-- similarity of 0.5 or more, from the same counterparty's other invoices and its vendor's purchase orders; another
-- counterparty's lines never appear; row level security decides what is read; no budget line or tax rate is returned;
-- at most 100 descriptions.
-- World: 0700_engagement_world (cp_v_a is Bayside Audio as org_a's counterparty; carol manager, gina viewer).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

create function pg_temp.invoice(p_key text, p_counterparty text, p_number text, p_issued date) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.invoices (project_id, direction, counterparty_id, invoice_number, issued_on, currency_code)
  values (pg_temp.id('prj_a'), 'Payable', pg_temp.id(p_counterparty), p_number, p_issued, 'USD') returning id into v;
  insert into world values (p_key, v);
  return v;
end $$;

select pg_temp.as_user('alice');
insert into world values ('cp_other', app.create_counterparty(pg_temp.id('org_a'), 'Coastal Staging Co', null, null));
select pg_temp.invoice('inv_new', 'cp_v_a', 'INV-0099', null);
select pg_temp.invoice('inv_old', 'cp_v_a', 'INV-0042', '2027-05-01');
select pg_temp.invoice('inv_other', 'cp_other', 'CS-7', '2027-05-02');
insert into app.invoice_lines (invoice_id, line_number, description, quantity, unit_price_minor) values
  (pg_temp.id('inv_old'), 1, 'Wedge monitor rental', 4, 4500),
  (pg_temp.id('inv_old'), 2, 'Wedge monitor rental, weekend', 4, 5000),
  (pg_temp.id('inv_old'), 3, 'Wedge monitors rental', 2, 4800),
  (pg_temp.id('inv_old'), 4, 'Stagehand labor', 6, 3500),
  (pg_temp.id('inv_other'), 1, 'Wedge monitor rental', 10, 1000);
with v as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_v_a')) returning id)
  insert into world select 'vendor_v', id from v;
select pg_temp.as_platform();
select private.transition_lifecycle('vendor', 'app.vendors', 'vendor_state', 'app.vendor_state_transitions', 'vendor_id',
  pg_temp.id('vendor_v'), f.s, t.s, 'Fixture onboarding.')
from (values (1, 'Prospect', 'Onboarded'), (2, 'Onboarded', 'Active')) as m (o, a, b)
cross join lateral (select m.a as s) f cross join lateral (select m.b as s) t order by m.o;
select pg_temp.as_user('alice');
with po as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('vendor_v'), 'USD') returning id)
  insert into world select 'po_v', id from po;
insert into app.po_lines (purchase_order_id, line_number, description, quantity, unit_price_minor) values
  (pg_temp.id('po_v'), 3, 'Wedge monitor rental per day', 24, 4500);

select pg_temp.as_user('carol');
create temporary table history as
select * from app.vendor_line_history(pg_temp.id('inv_new'), array['Wedge monitor rental', 'Catering for the green room']);
select is((select count(*)::int from history where description_index = 1), 3, 'at most three lines per description');
select ok((select bool_and(similarity >= 0.5) from history), 'each with a similarity of 0.5 or more');
select is((select count(*)::int from history where description_index = 2), 0, 'an unlike description has no history');
select is((select reference from history where description_index = 1 order by similarity desc, source limit 1), 'INV-0042',
  'the closest line is the same vendor''s earlier invoice');
select is((select count(*)::int from history where reference = 'CS-7'), 0, 'another counterparty''s line never appears');
select is((select count(*)::int from app.vendor_line_history(pg_temp.id('inv_new'), array['Wedge monitor rental per day'])
  where source = 'purchase_order' and quantity = 24 and unit_price_minor = 4500), 1, 'the vendor''s purchase order line is a hint');
select ok(not exists (select 1 from pg_proc p, unnest(p.proargnames) a where p.oid = 'app.vendor_line_history(uuid, text[])'::regprocedure
  and a in ('budget_line_id', 'tax_rate_id')), 'no budget line or tax rate is returned');
select throws_ok($$select * from app.vendor_line_history((select id from world where key = 'inv_new'), array_fill('x'::text, array[101]))$$,
  'XR001', 'aurora_intake_item_invalid: Look up at most 100 lines at a time.', 'at most 100 descriptions');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.vendor_line_history(pg_temp.id('inv_new'), array['Wedge monitor rental'])), 0,
  'someone who cannot read the invoices reads no history');
select ok(not (select prosecdef from pg_proc where oid = 'app.vendor_line_history(uuid, text[])'::regprocedure), 'the function is security invoker');

select * from finish();
rollback;
