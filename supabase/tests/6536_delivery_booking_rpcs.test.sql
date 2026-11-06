-- pgTAP: migration 6536 (B11, G-115, ADR 0150), booking and the gate. Schedules across a DST change, who may book, closed
-- windows, foreign shipments, replays, approvals, cancel and plate changes, the external views, and arrivals with the
-- sync wrapper's rules.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql
\ir 6531_supply_world.psql

select no_plan();

-- 1. Schedules ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is(cardinality(app.create_delivery_windows(pg_temp.id('prj_a'), pg_temp.id('gate_a'), '2027-07-01', '2027-07-02', '08:00', '12:00', 60, 3)), 8, 'two days of four hours in slots of an hour');
select is((select min(starts_at) from app.delivery_windows where zone_id = pg_temp.id('gate_a')), '2027-07-01 08:00-04'::timestamptz, 'on the project''s local time');
-- New York, spring forward on 2028-03-12: 02:00 to 03:00 does not exist.
select is(cardinality(app.create_delivery_windows(pg_temp.id('prj_a'), pg_temp.id('gate_b'), '2028-03-11', '2028-03-12', '01:00', '04:00', 60, 3)), 5, 'the local hour the clocks skip gets no window');
select is((select min(starts_at) from app.delivery_windows where zone_id = pg_temp.id('gate_b') and starts_at >= '2028-03-12 00:00-05'), '2028-03-12 01:00-05'::timestamptz, 'the hour before the change is on standard time');
select is((select max(starts_at) from app.delivery_windows where zone_id = pg_temp.id('gate_b')), '2028-03-12 03:00-04'::timestamptz, 'the hour after it on daylight time');
select is((select count(*)::integer from app.delivery_windows where zone_id = pg_temp.id('gate_b') and starts_at <> '2028-03-12 01:00-05' and starts_at < '2028-03-12 04:00-04'
           and starts_at >= '2028-03-12 00:00-05' and ends_at - starts_at <> interval '1 hour'), 0, 'every window after it is an hour long');
select throws_like(format($$select app.create_delivery_windows(%L, %L, '2029-01-01', '2029-12-31', '08:00', '18:00', 60, 1)$$, pg_temp.id('prj_a'), pg_temp.id('gate_a')), 'delivery_window_count:%', 'above 500 windows refuses delivery_window_count');
select throws_like(format($$select app.create_delivery_windows(%L, %L, '2029-01-02', '2029-01-01', '08:00', '18:00', 60, 1)$$, pg_temp.id('prj_a'), pg_temp.id('gate_a')), 'delivery_window_range:%', 'days out of order refuse');
select pg_temp.producer('reader', 'logistics.shipment.read');
select pg_temp.as_user('reader');
select throws_ok(format($$select app.create_delivery_windows(%L, %L, '2029-01-01', '2029-01-01', '08:00', '09:00', 60, 1)$$, pg_temp.id('prj_a'), pg_temp.id('gate_a')), '42501', null, 'without logistics.dock_slot.write, 42501');

-- 2. Booking -----------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
delete from app.delivery_windows where zone_id = pg_temp.id('gate_b');
select pg_temp.as_user('carol');
insert into app.delivery_windows (project_id, zone_id, starts_at, ends_at, vehicle_limit)
values (pg_temp.id('prj_a'), pg_temp.id('gate_b'), now() + interval '5 days', now() + interval '5 days 2 hours', 2);
insert into world select 'w', id from app.delivery_windows where zone_id = pg_temp.id('gate_b');
select pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Active');

insert into world values ('b1', gen_random_uuid());
select pg_temp.as_user('sam');
select throws_ok(format($$select app.book_delivery_window(%L, %L)$$, pg_temp.id('b1'), pg_temp.id('w')), '42501', null, 'no engagement and no dock right, 42501');
select is(app.book_delivery_window(pg_temp.id('b1'), pg_temp.id('w'), pg_temp.id('eng_vendor_a'), ' FL ABC 123 '), pg_temp.id('b1'), 'a Vendor engagement books, and the event id is the slot id');
select pg_temp.as_platform();
select is((select created_by from app.dock_slots where id = pg_temp.id('b1')), pg_temp.id('sam'), 'created_by stays the person');
select is((select vehicle_identifier from app.dock_slots where id = pg_temp.id('b1')), 'FL ABC 123', 'the plate is trimmed');
select is((select count(*)::integer from app.dock_slots where id = pg_temp.id('b1')), 1, 'before replay');
select pg_temp.as_user('sam');
select is(app.book_delivery_window(pg_temp.id('b1'), pg_temp.id('w'), pg_temp.id('eng_vendor_a')), pg_temp.id('b1'), 'a replay returns it');
select pg_temp.as_platform();
select is((select count(*)::integer from app.dock_slots where delivery_window_id = pg_temp.id('w')), 1, 'and creates nothing');
select pg_temp.as_user('carol');
select throws_like(format($$select app.book_delivery_window(%L, %L, %L)$$, pg_temp.id('b1'), pg_temp.id('w'), pg_temp.id('eng_art_a')), 'booking_event_reused:%', 'a replay naming another engagement refuses booking_event_reused');
insert into app.delivery_windows (project_id, zone_id, starts_at, ends_at, vehicle_limit)
values (pg_temp.id('prj_a'), pg_temp.id('gate_b'), now() + interval '6 days', now() + interval '6 days 2 hours', 2);
insert into world select 'w2', id from app.delivery_windows where zone_id = pg_temp.id('gate_b') and id <> pg_temp.id('w');
select throws_like(format($$select app.book_delivery_window(%L, %L, %L)$$, pg_temp.id('b1'), pg_temp.id('w2'), pg_temp.id('eng_vendor_a')), 'booking_event_reused:%', 'and so does one naming another window');
select pg_temp.as_user('art');
select throws_ok(format($$select app.book_delivery_window(gen_random_uuid(), %L, %L)$$, pg_temp.id('w'), pg_temp.id('eng_art_a')), '42501', null, 'an engagement that is not a Vendor''s gets 42501');
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.book_delivery_window(gen_random_uuid(), %L, %L)$$, pg_temp.id('w'), pg_temp.id('eng_vendor_a')), '42501', null, 'another party naming the vendor''s engagement gets 42501');
-- Closed, started, deleted.
select pg_temp.as_user('carol');
update app.delivery_windows set is_open = false where id = pg_temp.id('w2');
select pg_temp.as_user('sam');
select throws_like(format($$select app.book_delivery_window(gen_random_uuid(), %L, %L)$$, pg_temp.id('w2'), pg_temp.id('eng_vendor_a')), 'delivery_window_closed:%', 'a closed window refuses');
select pg_temp.as_platform();
update app.delivery_windows set is_open = true, starts_at = now() - interval '1 hour', ends_at = now() + interval '1 hour' where id = pg_temp.id('w2');
select pg_temp.as_user('sam');
select throws_like(format($$select app.book_delivery_window(gen_random_uuid(), %L, %L)$$, pg_temp.id('w2'), pg_temp.id('eng_vendor_a')), 'delivery_window_closed:%', 'a started window refuses');
select pg_temp.as_platform();
update app.delivery_windows set deleted_at = now(), starts_at = now() + interval '6 days', ends_at = now() + interval '6 days 1 hour' where id = pg_temp.id('w2');
select pg_temp.as_user('sam');
select throws_like(format($$select app.book_delivery_window(gen_random_uuid(), %L, %L)$$, pg_temp.id('w2'), pg_temp.id('eng_vendor_a')), 'delivery_window_closed:%', 'a deleted window refuses');
-- A foreign shipment.
select pg_temp.as_user('carol');
insert into app.shipments (project_id, direction, description) values (pg_temp.id('prj_a'), 'Inbound', 'Someone else''s trailer');
insert into world select 'ship_x', id from app.shipments where description = 'Someone else''s trailer';
insert into app.shipments (project_id, direction, description, carrier_counterparty_id) values (pg_temp.id('prj_a'), 'Inbound', 'Our trailer', pg_temp.id('cp_v_a'));
insert into world select 'ship_v', id from app.shipments where description = 'Our trailer';
select pg_temp.as_user('sam');
select throws_like(format($$select app.book_delivery_window(gen_random_uuid(), %L, %L, null, %L)$$, pg_temp.id('w'), pg_temp.id('eng_vendor_a'), pg_temp.id('ship_x')), 'delivery_booking_shipment:%', 'a shipment the vendor does not carry refuses');

-- 3. Approvals (P9) ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is((select count(*)::integer from app.subject_approvals), 0, 'creating a window opens no approval');
select pg_temp.as_user('alice');
with x as (insert into app.approval_rules (project_id, subject, name, zone_id) values (pg_temp.id('prj_a'), 'Delivery', 'Gate B bookings', pg_temp.id('gate_b')) returning id) insert into world select 'rule', id from x;
insert into app.approval_rule_steps (approval_rule_id, step_order, name, approver_membership_id) values (pg_temp.id('rule'), 1, 'Logistics', pg_temp.id('carol@org_a'));
select app.transition_approval_rule(pg_temp.id('rule'), 'Draft', 'Active', 'Gate B.');
insert into world values ('b2', gen_random_uuid());
select pg_temp.as_user('sam');
select app.book_delivery_window(pg_temp.id('b2'), pg_temp.id('w'), pg_temp.id('eng_vendor_a'), null, pg_temp.id('ship_v'));
select pg_temp.as_platform();
select is((select count(*)::integer from app.subject_approvals a where a.dock_slot_id = pg_temp.id('b2')), 1, 'a matching rule opens one approval per booking');
select is((select requested_by from app.subject_approvals a where a.dock_slot_id = pg_temp.id('b2')), pg_temp.id('sam'), 'requested by the vendor person');
select pg_temp.as_user('sam');
select app.set_delivery_booking_vehicle(pg_temp.id('b2'), 'TX 777');
select pg_temp.as_platform();
select is((select vehicle_identifier from app.dock_slots where id = pg_temp.id('b2')), 'TX 777', 'the vendor changes the plate');
select pg_temp.as_user('sam');
select app.cancel_delivery_booking(pg_temp.id('b2'));
select pg_temp.as_user('carol');
select is((select approval_state::text from app.subject_approval_status where dock_slot_id = pg_temp.id('b2')), 'Canceled', 'cancel cancels the approval');

-- 4. Cancel rules ---------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('quinn');
select throws_ok(format($$select app.cancel_delivery_booking(%L)$$, pg_temp.id('b1')), '42501', null, 'another party cannot cancel');
select throws_ok(format($$select app.set_delivery_booking_vehicle(%L, 'Z')$$, pg_temp.id('b1')), '42501', null, 'nor change the plate');
select pg_temp.as_user('carol');
select app.check_in_dock_slot(pg_temp.id('b1'));
select pg_temp.as_user('sam');
select throws_like(format($$select app.cancel_delivery_booking(%L)$$, pg_temp.id('b1')), 'delivery_booking_locked:%', 'after check-in, cancel refuses delivery_booking_locked');
select throws_like(format($$select app.set_delivery_booking_vehicle(%L, 'Z')$$, pg_temp.id('b1')), 'delivery_booking_locked:%', 'and so does a plate change');
select pg_temp.as_platform();
insert into app.delivery_windows (project_id, zone_id, starts_at, ends_at, vehicle_limit) values (pg_temp.id('prj_a'), pg_temp.id('gate_b'), now() + interval '8 days', now() + interval '8 days 1 hour', 2);
insert into world select 'w3', id from app.delivery_windows where zone_id = pg_temp.id('gate_b') and starts_at > now() + interval '7 days';
select pg_temp.as_user('sam');
insert into world select 'b3', app.book_delivery_window(gen_random_uuid(), pg_temp.id('w3'), pg_temp.id('eng_vendor_a'));
select pg_temp.as_platform();
alter table app.delivery_windows disable trigger t40_guard_delivery_window;
alter table app.dock_slots disable trigger t40_guard_dock_slot;
update app.delivery_windows set starts_at = now() - interval '1 minute', ends_at = now() + interval '1 minute' where id = pg_temp.id('w3');
update app.dock_slots set starts_at = now() - interval '1 minute', ends_at = now() + interval '1 minute' where id = pg_temp.id('b3');
alter table app.delivery_windows enable trigger t40_guard_delivery_window;
alter table app.dock_slots enable trigger t40_guard_dock_slot;
select pg_temp.as_user('sam');
select throws_like(format($$select app.cancel_delivery_booking(%L)$$, pg_temp.id('b3')), 'delivery_booking_locked:%', 'after the window starts, too');

-- 5. External views ---------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('sam');
select is((select places_left from api_external.delivery_windows where id = pg_temp.id('w')), 1, 'a vendor sees the places left');
select is((select count(*)::integer from api_external.delivery_windows where id = pg_temp.id('w3')), 0, 'and no window that has started');
select ok((select reference_code from api_external.dock_slots where id = pg_temp.id('b1')) is not null, 'its booking shows the code');
select is((select vehicle_identifier from api_external.dock_slots where id = pg_temp.id('b1')), 'FL ABC 123', 'and the plate');
select ok((select time_zone from api_external.dock_slots where id = pg_temp.id('b1')) is not null, 'and the project''s time zone, to read its times in');
select pg_temp.as_user('carol');
insert into world select 'b4', app.book_delivery_window(gen_random_uuid(), pg_temp.id('w'));
select pg_temp.as_user('sam');
select is((select count(*)::integer from api_external.dock_slots where id = pg_temp.id('b4')), 0, 'and no booking of anyone else');
select is(col_description('api_external.dock_slots'::regclass, (select attnum from pg_attribute where attrelid = 'api_external.dock_slots'::regclass and attname = 'reference_code'))::text is not null, true, 'the new columns are described');
select pg_temp.as_user('quinn');
select is((select count(*)::integer from api_external.delivery_windows where id = pg_temp.id('w')), 0, 'a person with no Vendor engagement on the project sees no window');
select is((select count(*)::integer from api_external.dock_slots where id = pg_temp.id('b1')), 0, 'nor booking');

-- 6. Arrivals ---------------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('sam');
select throws_ok(format($$select app.record_booking_arrival(%L)$$, pg_temp.id('b4')), '42501', null, 'without logistics.yard.write, 42501');
select pg_temp.as_user('carol');
select throws_like(format($$select app.record_booking_arrival(%L)$$, pg_temp.id('b4')), 'gate_vehicle_required:%', 'no plate given or on the slot refuses gate_vehicle_required');
select lives_ok(format($$select app.record_booking_arrival(%L, 'NY 1')$$, pg_temp.id('b4')), 'with a plate it records');
select throws_like(format($$select app.record_booking_arrival(%L, 'NY 1')$$, pg_temp.id('b4')), 'booking_already_arrived:%', 'a repeat refuses booking_already_arrived');
select is((select dock_slot_id from app.gate_queue where vehicle_identifier = 'NY 1'), pg_temp.id('b4'), 'the gate row names the slot');
select lives_ok(format($$select app.record_booking_arrival(%L)$$, pg_temp.id('b1')), 'without a plate, it uses the slot''s');
select is((select vehicle_identifier from app.gate_queue where dock_slot_id = pg_temp.id('b1')), 'FL ABC 123', 'the slot''s plate');
select throws_like(format($$select app.record_booking_arrival(%L, 'X')$$, pg_temp.id('b2')), 'dock_slot_canceled:%', 'a slot that is not live refuses');
-- Arrived, then Release of the row the phone is showing, through the path a queued mutation takes.
select pg_temp.as_user('carol');
insert into app.delivery_windows (project_id, zone_id, starts_at, ends_at, vehicle_limit)
values (pg_temp.id('prj_a'), pg_temp.id('gate_b'), now() + interval '10 days', now() + interval '10 days 2 hours', 2);
insert into world select 'w5', id from app.delivery_windows where zone_id = pg_temp.id('gate_b') and starts_at > now() + interval '9 days';
insert into world select 'b5', app.book_delivery_window(gen_random_uuid(), pg_temp.id('w5'), null, 'FL EVT 5');
insert into world values ('arrival5', gen_random_uuid()), ('arrival5_m', gen_random_uuid()), ('release5_m', gen_random_uuid());
select is(
  app.apply_sync_mutation(pg_temp.id('arrival5_m'), pg_temp.id('org_a'), 'gate-phone', 'app.record_booking_arrival',
    jsonb_build_object('p_dock_slot_id', pg_temp.id('b5'), 'p_vehicle_identifier', null, 'p_event_id', pg_temp.id('arrival5'))) ->> 'data',
  pg_temp.id('arrival5')::text, 'a queued Arrived makes the gate row under the phone''s id');
select is((select dock_slot_id from app.gate_queue where id = pg_temp.id('arrival5')), pg_temp.id('b5'), 'and the row under that id names the slot');
select is(app.record_booking_arrival(pg_temp.id('b5'), null, pg_temp.id('arrival5')), pg_temp.id('arrival5'), 'a replay returns the same row');
select is((select count(*)::integer from app.gate_queue where dock_slot_id = pg_temp.id('b5') and deleted_at is null), 1, 'and adds none');
select throws_like(format($$select app.record_booking_arrival(%L, null, gen_random_uuid())$$, pg_temp.id('b5')), 'booking_already_arrived:%', 'another event for the same booking refuses booking_already_arrived');
select throws_like(format($$select app.record_booking_arrival(%L, 'OTHER', %L)$$, pg_temp.id('b4'), pg_temp.id('arrival5')), 'booking_event_reused:%', 'an event id used for another slot refuses booking_event_reused');
select is(
  (app.apply_sync_mutation(pg_temp.id('release5_m'), pg_temp.id('org_a'), 'gate-phone', 'app.release_vehicle',
    jsonb_build_object('p_gate_queue_id', pg_temp.id('arrival5')))) ? 'refusal',
  false, 'a queued Release naming that id is not refused');
select ok((select released_at from app.gate_queue where id = pg_temp.id('arrival5')) is not null, 'and the vehicle reads released on the server');
select is(app.record_booking_arrival(pg_temp.id('b5'), null, pg_temp.id('arrival5')), pg_temp.id('arrival5'), 'a late replay after the release still returns the row');
select pg_temp.as_platform();
select ok((select p.prosecdef from pg_proc p where p.oid = 'app.record_booking_arrival(uuid, text, uuid)'::regprocedure), 'it is security definer, as private.sync_call requires');
select ok(exists (select 1 from private.sync_rpcs where rpc = 'app.record_booking_arrival'), 'and in private.sync_rpcs');
select throws_ok(format($$insert into app.gate_queue (project_id, vehicle_identifier, dock_slot_id) values (%L, 'Y', %L)$$, pg_temp.id('prj_a2'), pg_temp.id('b1')), 'XR001', null, 'a gate row names a slot of its own project');

select * from finish();
rollback;
