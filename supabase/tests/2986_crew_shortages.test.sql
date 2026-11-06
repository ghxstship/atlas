-- pgTAP: migration 2986 (B9, RRR-233, ADR 0148), app.crew_shortages. Over 14 days it returns, on projects the caller
-- reads shifts on: open shifts (naming the position one is held for), unfilled agency slots, shifts published to
-- someone who has not answered (with when they were asked), unanswered and declined "Still coming?" asks of the current
-- worker, no-shows without a replacement someone holds; and unacknowledged labor lines of Approved or Sent purchase
-- orders, only to procurement.po.read holders. More than 62 days refuses crew_shortages_range; another org reads nothing.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2750_agency_world.psql

select no_plan();

create function pg_temp.kinds(p_user text) returns text
language plpgsql as $$
declare
  v text;
begin
  perform pg_temp.as_user(p_user);
  select coalesce(string_agg(distinct x.kind, ',' order by x.kind), '') into v
  from app.crew_shortages(pg_temp.id('org_a'), current_date, current_date + 14) x;
  return v;
end $$;

-- Shifts in the next days -----------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.project_positions (project_id, title) values (pg_temp.id('prj_a'), 'Deck Chief') returning id)
insert into world select 'pos', id from x;
with x as (insert into app.shifts (project_id, role_code, starts_at, ends_at, time_zone, project_position_id)
  values (pg_temp.id('prj_a'), '0000.50.01', now() + interval '3 days', now() + interval '3 days 8 hours', 'America/New_York', pg_temp.id('pos'))
  returning id) insert into world select 'open_pos', id from x;
-- An Accepted member shift with an unanswered ask, one whose worker declined while staying on, and a no-show.
with x as (insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('mia@org_a'), '0000.50.01', now() + interval '4 days', now() + interval '4 days 8 hours', 'America/New_York')
  returning id) insert into world select 'rc_wait', id from x;
with x as (insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('dave@org_a'), '0000.50.01', now() + interval '5 days', now() + interval '5 days 8 hours', 'America/New_York')
  returning id) insert into world select 'rc_decl', id from x;
with x as (insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('erin@org_a'), '0000.50.01', now() - interval '20 minutes', now() + interval '7 hours', 'America/New_York')
  returning id) insert into world select 'ns', id from x;
select app.publish_shifts(array[pg_temp.id('rc_wait'), pg_temp.id('rc_decl'), pg_temp.id('ns')]);
select pg_temp.as_user('mia');
select app.accept_shift(pg_temp.id('rc_wait'));
select pg_temp.as_user('dave');
select app.accept_shift(pg_temp.id('rc_decl'));
select pg_temp.as_user('erin');
select app.accept_shift(pg_temp.id('ns'));
select pg_temp.as_platform();
insert into app.shift_responses (project_id, shift_id, person_id, ask_kind) values
  (pg_temp.id('prj_a'), pg_temp.id('rc_wait'), pg_temp.id('mia'), 'Reconfirmation');
insert into app.shift_responses (project_id, shift_id, person_id, ask_kind, answer, answered_at, reason) values
  (pg_temp.id('prj_a'), pg_temp.id('rc_decl'), pg_temp.id('dave'), 'Reconfirmation', 'Declined', now(), 'Car trouble.');
select pg_temp.as_user('carol');
select app.mark_shift_no_show(gen_random_uuid(), pg_temp.id('ns'), 'Not at the gate.');

-- A labor order the vendor has not acknowledged --------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into world values ('cp_lab', app.create_counterparty(pg_temp.id('org_a'), 'Tideline Labor', 'Equipment Rental'));
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor)
values (pg_temp.id('org_a'), pg_temp.system_role('admin'), 'Purchase Order', 'USD', 10000000) on conflict do nothing;
select pg_temp.as_user('carol');
with x as (insert into app.vendors (counterparty_id, payment_terms_days) values (pg_temp.id('cp_lab'), 30) returning id)
insert into world select 'ven_lab', id from x;
select app.transition_vendor(pg_temp.id('ven_lab'), 'Prospect', 'Onboarded', 'Paperwork in.');
select app.transition_vendor(pg_temp.id('ven_lab'), 'Onboarded', 'Active', 'Approved for use.');
with x as (insert into app.purchase_orders (project_id, vendor_id, currency_code) values (pg_temp.id('prj_a'), pg_temp.id('ven_lab'), 'USD')
  returning id) insert into world select 'po_lab', id from x;
with x as (insert into app.po_lines (purchase_order_id, line_number, description, element_id, quantity, unit_price_minor)
  values (pg_temp.id('po_lab'), 1, 'Stagehands for the load in.', '2000.07.01-XPMS-001', 6, 2500) returning id)
insert into world select 'l_lab', id from x;
select pg_temp.as_user('bob');
select app.approve_purchase_order(pg_temp.id('po_lab'), 'Within limit.');
select pg_temp.as_platform();
update app.projects set starts_on = current_date + 1, ends_on = current_date + 10 where id = pg_temp.id('prj_a');

-- What carol sees ----------------------------------------------------------------------------------------------------------------------
select is(pg_temp.kinds('carol'),
  'agency_unfilled,awaiting_answer,no_show,not_reconfirmed,open,reconfirm_declined,vendor_unconfirmed',
  'every kind of shortage on the project, crew and vendor alike');
select pg_temp.as_user('carol');
select is((select detail from app.crew_shortages(pg_temp.id('org_a'), current_date, current_date + 14) where shift_id = pg_temp.id('open_pos')),
  'Deck Chief', 'an open shift held for a position names it');
select is((select party_name from app.crew_shortages(pg_temp.id('org_a'), current_date, current_date + 14)
  where kind = 'agency_unfilled' and shift_id = pg_temp.id('slot_1')), 'Crestline Staffing', 'an unfilled slot names its agency');
select isnt((select asked_at from app.crew_shortages(pg_temp.id('org_a'), current_date, current_date + 14)
  where kind = 'awaiting_answer' and shift_id = pg_temp.id('sh_frank_day')), null, 'a shift waiting on its worker says when they were asked');
select is((select detail from app.crew_shortages(pg_temp.id('org_a'), current_date, current_date + 14) where kind = 'reconfirm_declined'),
  'Car trouble.', 'a declined reconfirmation says why');
select results_eq(format($$select quantity, party_name from app.crew_shortages(%L, current_date, current_date + 14) where kind = 'vendor_unconfirmed'$$,
    pg_temp.id('org_a')),
  $$values (6::numeric, 'Tideline Labor'::text)$$, 'the unacknowledged labor line, with its quantity and vendor');
select is((select count(*)::int from app.crew_shortages(pg_temp.id('org_a'), current_date, current_date + 14) where kind = 'awaiting_answer'
  and shift_id = pg_temp.id('rc_wait')), 0, 'an Accepted shift is not waiting on an answer');

-- Acknowledging and replacing clear them
select pg_temp.as_platform();
insert into app.po_acknowledgments (purchase_order_id) values (pg_temp.id('po_lab'));
select ok(pg_temp.kinds('carol') not like '%vendor_unconfirmed%', 'an acknowledged order is no longer a shortage');

-- Who sees what ---------------------------------------------------------------------------------------------------------------------------
select ok(pg_temp.kinds('frank') not like '%vendor_unconfirmed%', 'without procurement.po.read no vendor rows');
select is(pg_temp.kinds('xavier'), '', 'another org reads nothing');
select pg_temp.as_user('carol');
select throws_ok(format($$select * from app.crew_shortages(%L, current_date, current_date + 62)$$, pg_temp.id('org_a')), 'XR001',
  'crew_shortages_range: Pick a range of 1 to 62 days.', 'a range over 62 days is refused');
select lives_ok(format($$select * from app.crew_shortages(%L, current_date, current_date + 61)$$, pg_temp.id('org_a')), '62 days is fine');

select * from finish();
rollback;
