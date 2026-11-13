-- pgTAP: migration 904110702, a client or sponsor engagement submits no invoice (crawl 4.9, ADR 0019 decision 69).
-- Coral Group (cleo, Account Owner) is org_a's client and Fizz Beverage (spencer, Account Owner) its sponsor on prj_a,
-- both Active so their money areas are open. Neither creates a Payable invoice to the org; the vendor account still
-- submits one as before.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(5);

select pg_temp.new_user('cleo', 'cleo@coral-group.test', 'Cleo Marsh');
select pg_temp.new_user('spencer', 'spencer@fizz-beverage.test', 'Spencer Hale');
select pg_temp.as_user('cleo');
insert into world values ('acct_c', app.create_external_account('Coral Group', 'coral-group'));
select pg_temp.as_user('spencer');
insert into world values ('acct_s', app.create_external_account('Fizz Beverage', 'fizz-beverage'));
select pg_temp.as_user('alice');
insert into world values ('cp_c_a', app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_c')));
insert into world values ('cp_s_a', app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_s')));
with e as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('cleo'), pg_temp.id('cp_c_a'), 'Client', '2027-06-01') returning id)
insert into world select 'eng_client_a', id from e;
with e as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('spencer'), pg_temp.id('cp_s_a'), 'Sponsor', '2027-06-01') returning id)
insert into world select 'eng_sponsor_a', id from e;
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_client_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_sponsor_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');

select pg_temp.as_user('spencer');
select throws_ok(format($$select app.submit_engagement_invoice('%s', 'SP-1', '2027-06-05', '2027-07-05', 'USD',
  '[{"description": "Sponsorship fee", "quantity": 1, "unit_price_minor": 500000}]')$$, pg_temp.id('eng_sponsor_a')),
  'XR001', 'invoice_unpaid_role: The organization never pays a client or sponsor engagement, so it takes no invoice from one.',
  'a sponsor''s Account Owner cannot invoice the org');
select pg_temp.as_user('cleo');
select throws_ok(format($$select app.submit_engagement_invoice('%s', 'CL-1', null, null, 'USD', '[{"description": "Refund"}]')$$,
  pg_temp.id('eng_client_a')),
  'XR001', 'invoice_unpaid_role: The organization never pays a client or sponsor engagement, so it takes no invoice from one.',
  'nor can a client''s');
select pg_temp.as_platform();
select is((select count(*)::int from app.invoices where counterparty_id in (pg_temp.id('cp_c_a'), pg_temp.id('cp_s_a'))), 0,
  'and no invoice is written for either');

select pg_temp.as_user('victor');
select lives_ok(format($$select app.submit_engagement_invoice('%s', 'BA-2001', '2027-06-05', '2027-07-05', 'USD',
  '[{"description": "Audio crew day", "quantity": 2, "unit_price_minor": 120000}]')$$, pg_temp.id('eng_vendor_a')),
  'a vendor account still submits its invoice');
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.submit_engagement_invoice('%s', 'SP-2', null, null, 'USD', '[{"description": "Fee"}]')$$,
  pg_temp.id('eng_sponsor_a')),
  '42501', null, 'someone outside the sponsor account is refused access first, as before');
select pg_temp.as_platform();

select * from finish();
rollback;
