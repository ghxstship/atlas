-- pgTAP: migration 1594, the description of partner client prices in the words of ADR 0033 decision 66 (RRR-125; finding
-- A65-026). The partner invoices its clients itself, so the table no longer says it bills them through Stripe Connect;
-- the column comments 1060 wrote stay.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(3);

select is(obj_description('app.partner_client_prices'::regclass, 'pg_class'),
  'What a partner charges a client org each month (Section 4.6.1; ADR 0033 decision 66). The partner invoices the client itself; XOS records the price for the partner''s reference and never shows it to the client. Read and written by the partner only.',
  'app.partner_client_prices: the partner invoices the client itself and XOS records the price for its reference');
select ok(obj_description('app.partner_client_prices'::regclass, 'pg_class') not like '%Stripe Connect%',
  'app.partner_client_prices: no word of billing clients through Stripe Connect');
select is(col_description('app.partner_client_prices'::regclass,
    (select attnum from pg_attribute where attrelid = 'app.partner_client_prices'::regclass and attname = 'monthly_minor')),
  'Monthly price in minor units of currency_code.', 'app.partner_client_prices: the column comments stand');

select * from finish();
rollback;
