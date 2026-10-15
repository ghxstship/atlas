-- pgTAP: app.record_rfq_response (migration 0493). A buyer records a sealed response with its lines
-- although neither is readable until the RFQ closes; the 0331 guards still apply; members,
-- other tenants and anon cannot record.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(13);

select pg_temp.as_user('alice');
insert into world values ('cp', app.create_counterparty(pg_temp.id('org_a'), 'Harborline Staging', 'Equipment Rental'));
insert into world values ('cp2', app.create_counterparty(pg_temp.id('org_a'), 'Bayside Audio', 'Equipment Rental'));
select pg_temp.as_user('carol');
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp')) returning id) insert into world select 'ven', id from x;
with x as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp2')) returning id) insert into world select 'ven2', id from x;
with x as (insert into app.rfqs (project_id, title) values (pg_temp.id('prj_a'), 'Delay towers') returning id) insert into world select 'rfq', id from x;
insert into app.rfq_invitations (rfq_id, vendor_id) values (pg_temp.id('rfq'), pg_temp.id('ven'));

select throws_ok($$select app.record_rfq_response((select id from world where key = 'rfq'), (select id from world where key = 'ven'), null, 'USD',
  '[{"description": "Delay tower", "quantity": 4, "unit_price_minor": 420000}]')$$,
  'XR001', 'rfq_not_open: Responses are accepted only while the RFQ is Issued.', 'no response before the RFQ is issued');
select lives_ok($$select app.transition_rfq((select id from world where key = 'rfq'), 'Proposed', 'Issued', 'Out.')$$, 'the RFQ is issued');
select throws_ok($$select app.record_rfq_response((select id from world where key = 'rfq'), (select id from world where key = 'ven'), null, 'USD', '[]')$$,
  'XR001', 'rfq_response_lines_required: A response quotes at least one line.', 'a response needs at least one line');
select throws_ok($$select app.record_rfq_response((select id from world where key = 'rfq'), (select id from world where key = 'ven2'), null, 'USD',
  '[{"description": "Delay tower", "quantity": 4, "unit_price_minor": 400000}]')$$,
  'XR001', 'rfq_not_invited: Only an invited vendor responds to an RFQ.', 'an uninvited vendor cannot respond');
select lives_ok($$insert into world select 'resp', app.record_rfq_response((select id from world where key = 'rfq'), (select id from world where key = 'ven'), '2027-03-01', 'usd',
  '[{"description": "Delay tower", "quantity": 4, "unit_price_minor": 420000}, {"description": "Rigging", "quantity": 1, "unit_price_minor": null}]')$$,
  'the buyer records a sealed response with its lines');
select is((select count(*)::int from app.rfq_responses), 0, 'the response stays sealed for its recorder');
select throws_ok($$select app.record_rfq_response((select id from world where key = 'rfq'), (select id from world where key = 'ven'), null, 'USD',
  '[{"description": "Again", "quantity": 1, "unit_price_minor": 1}]')$$,
  '23505', null, 'one response per vendor');

select pg_temp.as_user('dave');
select throws_ok($$select app.record_rfq_response((select id from world where key = 'rfq'), (select id from world where key = 'ven'), null, 'USD',
  '[{"description": "Member", "quantity": 1, "unit_price_minor": 1}]')$$,
  '42501', null, 'a Member without procurement.rfq.write cannot record');
select pg_temp.as_user('xavier');
select throws_ok($$select app.record_rfq_response((select id from world where key = 'rfq'), (select id from world where key = 'ven'), null, 'USD',
  '[{"description": "Other tenant", "quantity": 1, "unit_price_minor": 1}]')$$,
  '42501', null, 'another tenant cannot record');
select pg_temp.as_anon();
select throws_ok($$select app.record_rfq_response((select id from world where key = 'rfq'), (select id from world where key = 'ven'), null, 'USD', '[]')$$,
  '42501', null, 'anon cannot record');

select pg_temp.as_user('carol');
select lives_ok($$select app.transition_rfq((select id from world where key = 'rfq'), 'Issued', 'Closed', 'Deadline.')$$, 'the RFQ closes');
select is((select count(*)::int from app.rfq_response_lines l where l.rfq_response_id = pg_temp.id('resp')), 2, 'both lines unseal with the response');
select is((select string_agg(currency_code, ',') from app.rfq_response_lines where rfq_response_id = pg_temp.id('resp')), 'USD,USD', 'the currency is stored upper case');

select * from finish();
rollback;
