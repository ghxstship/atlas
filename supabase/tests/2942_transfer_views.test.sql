-- pgTAP: migration 2942 (B5, G-33), what the desk, drivers and riders read about transfers. app.transfer_board reports
-- Unassigned, Assigned, Underway and Done from the driver, vehicle and clock (fixed times relative to now()), Tight
-- turnaround from hospitality.transfer_turnaround_minutes (default 15, a project value of 0 clears it) whatever the
-- reader sees, and Flight lands after pickup. app.transfer_person_options lists the people a transfer may carry. In
-- api_external.my_transfers a driver reads every passenger, a passenger only themselves, an account Owner the people
-- named on the engagement they answer for (and not a roster person's transfer), and a colleague or an outsider nothing;
-- no note, fulfillment or supplier column exists. app.roster_travel_party books a pickup from a transfer on the
-- inbound date.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql
\ir 2940_travel_world.psql

select no_plan();

create function pg_temp.board(p_who text, p_key text) returns app.transfer_board
language plpgsql as $$
declare
  v app.transfer_board;
begin
  perform pg_temp.as_user(p_who);
  select * into v from app.transfer_board b where b.id = pg_temp.id(p_key);
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.mine(p_who text) returns setof api_external.my_transfers
language plpgsql as $$
begin
  perform pg_temp.as_user(p_who);
  return query select * from api_external.my_transfers m order by m.pickup_at;
  perform pg_temp.as_platform();
end $$;

-- Status -----------------------------------------------------------------------------------------------------------------------
select pg_temp.transfer('ta', now() + interval '2 hours', now() + interval '3 hours', 'dave', 'van');
select pg_temp.transfer('tb', now() - interval '30 minutes', now() + interval '30 minutes', 'erin', 'sedan');
select pg_temp.transfer('tc', now() - interval '3 hours', now() - interval '2 hours', 'frank', null);
select pg_temp.transfer('td', now() + interval '5 hours', now() + interval '6 hours', null, 'van');
select is((pg_temp.board('hops', 'ta')).status, 'Assigned', 'a future transfer with a driver and a vehicle is Assigned');
select is((pg_temp.board('hops', 'tb')).status, 'Underway', 'between pickup and drop-off it is Underway');
select is((pg_temp.board('hops', 'tc')).status, 'Done', 'after the drop-off it is Done');
select is((pg_temp.board('hops', 'td')).status, 'Unassigned', 'without a driver it is Unassigned');
select is((pg_temp.board('hops', 'ta')).vehicle_label, 'Van 1', 'the board names the vehicle');
select is((pg_temp.board('hops', 'ta')).driver_name, 'Dave Lindqvist', 'and the driver');
select is((pg_temp.board('creds', 'ta')).id, null, 'a reader without hospitality.fulfillment.read sees no transfer');
select ok(not has_table_privilege('xos_backup', 'app.transfer_board', 'select'), 'xos_backup cannot select the board');

-- Turnaround ---------------------------------------------------------------------------------------------------------------------
select pg_temp.transfer('te', now() + interval '3 hours 10 minutes', now() + interval '4 hours', 'dave', null);
select is((pg_temp.board('hops', 'te')).tight_turnaround, true, 'ten minutes after the previous drop-off is tight at 15 minutes');
select is((pg_temp.board('hops', 'ta')).tight_turnaround, false, 'the earlier transfer is not');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'hospitality.transfer_turnaround_minutes', 'Project', pg_temp.id('prj_a'), p_value_integer => 0);
select pg_temp.as_platform();
select is((pg_temp.board('hops', 'te')).tight_turnaround, false, 'a project turnaround of 0 clears the warning');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'hospitality.transfer_turnaround_minutes', 'Project', pg_temp.id('prj_a'), p_value_integer => 30);
select pg_temp.as_platform();
select is((pg_temp.board('hops', 'te')).tight_turnaround, true, 'and 30 minutes warns again');
select is(private.transfer_tight_turnaround(pg_temp.id('te')), true, 'the warning reads every transfer of the driver, as the platform sees it');

-- The met flight ------------------------------------------------------------------------------------------------------------------
select pg_temp.flight('fl', 'kai', 'NW101', 'LHR', now() - interval '5 hours', 'MIA', now() + interval '2 hours 20 minutes');
select pg_temp.as_user('alice');
update app.transfers set meets_travel_segment_id = pg_temp.id('fl') where id = pg_temp.id('ta');
select pg_temp.as_platform();
select is((pg_temp.board('hops', 'ta')).meets_flight_after_pickup, true, 'a flight landing after the pickup is flagged');
select is((pg_temp.board('hops', 'ta')).meets_service_identifier, 'NW101', 'and named');

-- Person options -------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('creds');
select throws_ok(format($$select * from app.transfer_person_options(%L)$$, pg_temp.id('prj_a')), '42501', null,
  'the people a transfer may carry need hospitality.fulfillment.read');
select pg_temp.as_user('hops');
create temporary table options as select * from app.transfer_person_options(pg_temp.id('prj_a'));
select pg_temp.as_platform();
select ok((select count(*) from options where person_id = pg_temp.id('dave') and membership_id is not null) = 1, 'a member, with the membership');
select ok((select count(*) from options where person_id = pg_temp.id('sam') and engagement_id = pg_temp.id('eng_vendor_a')) = 1,
  'an engaged person, with the engagement');
select is((select party_name from options where person_id = pg_temp.id('kai')), 'Bayside Audio', 'a roster person, with the party');
select is((select roster_entry_id from options where person_id = pg_temp.id('kai')), pg_temp.id('e_kai'), 'and the entry');
select is((select count(*)::int from options where person_id = pg_temp.id('quinn')), 0, 'never someone off the project');
select is((select count(*)::int from options group by person_id order by 1 desc limit 1), 1, 'one row per person');

-- What drivers and riders read ------------------------------------------------------------------------------------------------------
select pg_temp.ride('ta', 'kai', true);
select pg_temp.ride('ta', 'sam');
select pg_temp.transfer('tf', now() + interval '1 day', now() + interval '1 day 1 hour', 'erin', 'van');
select pg_temp.ride('tf', 'mo');
select is((select m.my_role from pg_temp.mine('dave') m where m.id = pg_temp.id('ta')), 'Driver', 'the driver reads the transfer as Driver');
select is((select m.passenger_names from pg_temp.mine('dave') m where m.id = pg_temp.id('ta')), array['Kai Morgan', 'Sam Kowalski'],
  'with every passenger, primary first');
select is((select m.my_role from pg_temp.mine('kai') m where m.id = pg_temp.id('ta')), 'Passenger', 'kai reads it as Passenger');
select is((select m.passenger_names from pg_temp.mine('kai') m where m.id = pg_temp.id('ta')), array['Kai Morgan'], 'naming only kai');
select is((select m.driver_name from pg_temp.mine('kai') m where m.id = pg_temp.id('ta')), 'Dave Lindqvist', 'and the driver');
select is((select count(*)::int from pg_temp.mine('kai')), 1, 'kai reads only their own transfer');
select is((select count(*)::int from pg_temp.mine('mo') m where m.id = pg_temp.id('ta')), 0, 'a colleague on the roster reads none of kai''s');
select is((select m.my_role from pg_temp.mine('victor') m where m.id = pg_temp.id('ta')), 'Party',
  'the account Owner reads the transfer of the engaged person they answer for');
select is((select m.passenger_names from pg_temp.mine('victor') m where m.id = pg_temp.id('ta')), array['Sam Kowalski'],
  'naming only the person named on the engagement');
select is((select count(*)::int from pg_temp.mine('victor') m where m.id = pg_temp.id('tf')), 0,
  'and not the transfer of a roster person');
select is((select count(*)::int from pg_temp.mine('quinn')), 0, 'someone without project reach reads nothing');
select ok(not exists (select 1 from information_schema.columns where table_schema = 'api_external' and table_name = 'my_transfers'
  and column_name in ('notes', 'fulfillment_id', 'counterparty_id', 'supplier_name')), 'no notes, fulfillment or supplier');
select pg_temp.ride('tf', 'dave');
select is((select array_agg(m.my_role order by m.pickup_at) from pg_temp.mine('dave') m), array['Driver', 'Driver', 'Passenger'],
  'a person who drives two transfers and rides a third reads each once');

-- The travel party's pickup --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('kai');
select app.save_roster_travel_request(pg_temp.id('e_kai'), 'MIA', 'JFK', '2027-06-01', '2027-06-04', 'Aisle', null, true, true, null);
select pg_temp.as_platform();
create function pg_temp.pickup(p_entry text) returns text
language plpgsql as $$
declare v text;
begin
  perform pg_temp.as_user('hops');
  select m -> 'pickup' ->> 'booked' into v from app.roster_travel_party(pg_temp.id('prj_a')) m
  where m ->> 'roster_entry_id' = pg_temp.id(p_entry)::text;
  perform pg_temp.as_platform();
  return v;
end $$;
select is(pg_temp.pickup('e_kai'), 'false', 'no pickup on the inbound date yet');
select pg_temp.transfer('tk', '2027-06-01 18:00+00', '2027-06-01 19:00+00', null, null);
select pg_temp.ride('tk', 'kai');
select is(pg_temp.pickup('e_kai'), 'true', 'a transfer picking kai up on the inbound date (project zone) books the pickup');
select pg_temp.as_user('alice');
update app.transfers set deleted_at = now() where id = pg_temp.id('tk');
select pg_temp.as_platform();
select is(pg_temp.pickup('e_kai'), 'false', 'a canceled transfer does not');
select pg_temp.transfer('tk2', '2027-06-02 03:30+00', '2027-06-02 04:30+00', null, null);
select pg_temp.ride('tk2', 'kai');
select is(pg_temp.pickup('e_kai'), 'true', 'June 1 23:30 in New York is the inbound date, though June 2 in UTC');

select * from finish();
rollback;
