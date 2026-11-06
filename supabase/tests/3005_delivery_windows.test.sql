-- pgTAP: migrations 3005 and 3006 (B11, G-115, ADR 0150), delivery windows and their guard. Windows and direct slots keep
-- clear of each other, a booking stays in its window, the limit holds, a window with bookings is fixed, the reference
-- code, and the G-99 warnings. pgTAP runs on one connection, so the limit is asserted sequentially and the row lock from
-- the function's definition; real concurrency is not exercised here.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql
\ir 3001_supply_world.psql

select no_plan();

select pg_temp.as_user('carol');
insert into app.delivery_windows (project_id, zone_id, starts_at, ends_at, vehicle_limit)
values (pg_temp.id('prj_a'), pg_temp.id('gate_a'), now() + interval '5 days', now() + interval '5 days 2 hours', 2);
insert into world select 'w', id from app.delivery_windows where zone_id = pg_temp.id('gate_a');

-- Overlaps.
select throws_like(format($$insert into app.delivery_windows (project_id, zone_id, starts_at, ends_at, vehicle_limit)
  values (%L, %L, now() + interval '5 days 1 hour', now() + interval '5 days 3 hours', 2)$$, pg_temp.id('prj_a'), pg_temp.id('gate_a')), 'delivery_window_overlap:%', 'a window overlapping another window refuses');
select throws_like(format($$insert into app.dock_slots (project_id, zone_id, starts_at, ends_at)
  values (%L, %L, now() + interval '5 days 1 hour', now() + interval '5 days 3 hours')$$, pg_temp.id('prj_a'), pg_temp.id('gate_a')), 'dock_slot_overlap:%', 'a direct slot overlapping a window refuses');
insert into app.dock_slots (project_id, zone_id, starts_at, ends_at) values (pg_temp.id('prj_a'), pg_temp.id('gate_a'), now() + interval '6 days', now() + interval '6 days 1 hour');
select throws_like(format($$insert into app.delivery_windows (project_id, zone_id, starts_at, ends_at, vehicle_limit)
  values (%L, %L, now() + interval '6 days', now() + interval '6 days 2 hours', 2)$$, pg_temp.id('prj_a'), pg_temp.id('gate_a')), 'delivery_window_overlap:%', 'a window overlapping a direct slot refuses');
select throws_like(format($$insert into app.dock_slots (project_id, zone_id, starts_at, ends_at)
  values (%L, %L, now() + interval '6 days', now() + interval '6 days 1 hour')$$, pg_temp.id('prj_a'), pg_temp.id('gate_a')), 'dock_slot_overlap:%', 'two direct slots still refuse');
select lives_ok(format($$insert into app.delivery_windows (project_id, zone_id, starts_at, ends_at, vehicle_limit)
  values (%L, %L, now() + interval '5 days', now() + interval '5 days 2 hours', 2)$$, pg_temp.id('prj_a'), pg_temp.id('gate_b')), 'another gate is free');
insert into world select 'w_b', id from app.delivery_windows where zone_id = pg_temp.id('gate_b');
select throws_ok(format($$insert into app.delivery_windows (project_id, zone_id, starts_at, ends_at, vehicle_limit)
  values (%L, %L, now() + interval '9 days', now() + interval '9 days 1 hour', 0)$$, pg_temp.id('prj_a'), pg_temp.id('gate_b')), '23514', null, 'a limit of 0 refuses');

-- Bookings only through the RPC.
select throws_like(format($$insert into app.dock_slots (project_id, zone_id, starts_at, ends_at, delivery_window_id)
  values (%L, %L, now() + interval '5 days', now() + interval '5 days 1 hour', %L)$$, pg_temp.id('prj_a'), pg_temp.id('gate_a'), pg_temp.id('w')), 'delivery_booking_direct:%', 'a direct insert cannot attach a window');

-- The limit.
insert into world values ('b1', gen_random_uuid()), ('b2', gen_random_uuid()), ('b3', gen_random_uuid());
select lives_ok(format($$select app.book_delivery_window(%L, %L, %L, 'FL ABC 123')$$, pg_temp.id('b1'), pg_temp.id('w'), pg_temp.id('eng_vendor_a')), 'first booking');
select lives_ok(format($$select app.book_delivery_window(%L, %L)$$, pg_temp.id('b2'), pg_temp.id('w')), 'second booking');
select throws_like(format($$select app.book_delivery_window(%L, %L)$$, pg_temp.id('b3'), pg_temp.id('w')), 'delivery_window_full:%', 'the third refuses delivery_window_full');
select pg_temp.as_platform();
select ok(pg_get_functiondef('private.guard_dock_slot()'::regprocedure) like '%for update%', 'the guard takes the window''s row lock');
select ok(position('for update' in pg_get_functiondef('private.guard_dock_slot()'::regprocedure)) < position('pg_advisory_xact_lock' in pg_get_functiondef('private.guard_dock_slot()'::regprocedure)), 'before the advisory lock');
select ok(pg_get_functiondef('app.book_delivery_window(uuid, uuid, uuid, text, uuid)'::regprocedure) like '%for update%', 'and the booking path takes it first');
select pg_temp.as_user('carol');

-- Soft delete and restore.
select app.cancel_delivery_booking(pg_temp.id('b2'));
select lives_ok(format($$select app.book_delivery_window(%L, %L)$$, pg_temp.id('b3'), pg_temp.id('w')), 'a canceled booking frees its place');
select throws_like(format($$update app.dock_slots set deleted_at = null where id = %L$$, pg_temp.id('b2')), 'delivery_window_full:%', 'restoring a booking into a full window refuses');

-- Fixed while booked.
select throws_like(format($$update app.delivery_windows set starts_at = starts_at + interval '10 minutes' where id = %L$$, pg_temp.id('w')), 'delivery_window_booked:%', 'time is fixed while bookings exist');
select throws_like(format($$update app.delivery_windows set zone_id = %L where id = %L$$, pg_temp.id('gate_b'), pg_temp.id('w')), 'delivery_window_booked:%', 'and zone');
select throws_like(format($$update app.delivery_windows set deleted_at = now() where id = %L$$, pg_temp.id('w')), 'delivery_window_booked:%', 'and it cannot be deleted');
select throws_like(format($$update app.delivery_windows set vehicle_limit = 1 where id = %L$$, pg_temp.id('w')), 'delivery_window_limit:%', 'a limit below live bookings refuses');
select lives_ok(format($$update app.delivery_windows set vehicle_limit = 3 where id = %L$$, pg_temp.id('w')), 'a higher limit is fine');
select lives_ok(format($$update app.delivery_windows set vehicle_limit = 2 where id = %L$$, pg_temp.id('w')), 'and back');

-- A booking stays in its window.
select throws_like(format($$update app.dock_slots set delivery_window_id = %L where id = %L$$, pg_temp.id('w_b'), pg_temp.id('b1')), 'delivery_booking_direct:%', 'the window never changes');
select throws_like(format($$update app.dock_slots set delivery_window_id = null where id = %L$$, pg_temp.id('b1')), 'delivery_booking_direct:%', 'nor detaches');
select throws_like(format($$update app.dock_slots set zone_id = %L where id = %L$$, pg_temp.id('gate_b'), pg_temp.id('b1')), 'delivery_booking_outside_window:%', 'a booking moved off its gate refuses');
select throws_like(format($$update app.dock_slots set ends_at = ends_at + interval '4 hours' where id = %L$$, pg_temp.id('b1')), 'delivery_booking_outside_window:%', 'and one moved off its window');
select ok(app.bulk_update_dock_slots(jsonb_build_array(jsonb_build_object('id', pg_temp.id('b1'), 'set', jsonb_build_object('zone_id', pg_temp.id('gate_b')))), false, 'Move.')::text like '%delivery_booking_outside_window%', 'including through the bulk edit');

-- The reference code.
select matches((select reference_code from app.dock_slots where id = pg_temp.id('b1')), '^[23456789A-HJ-NP-Z]{6}$', 'a booking gets a code of the format');
select isnt((select reference_code from app.dock_slots where id = pg_temp.id('b1')), (select reference_code from app.dock_slots where id = pg_temp.id('b3')), 'different codes for different bookings');
select throws_like(format($$update app.dock_slots set reference_code = 'AAAAAA' where id = %L$$, pg_temp.id('b1')), 'delivery_booking_reference:%', 'fixed once set');
select is((select reference_code from app.dock_slots where delivery_window_id is null and project_id = pg_temp.id('prj_a') limit 1), null::text, 'a direct slot has none');

-- Zones.
select pg_temp.as_platform();
update app.zones set deleted_at = now() where id = pg_temp.id('gate_b');
select pg_temp.as_user('carol');
select throws_like(format($$insert into app.delivery_windows (project_id, zone_id, starts_at, ends_at, vehicle_limit) values (%L, %L, now() + interval '20 days', now() + interval '20 days 1 hour', 1)$$, pg_temp.id('prj_a'), pg_temp.id('gate_b')), 'delivery_window_zone:%', 'a deleted zone refuses delivery_window_zone');
select pg_temp.as_platform();
update app.zones set deleted_at = null where id = pg_temp.id('gate_b');

-- A deleted window frees the gate, and restores under the same guard.
select pg_temp.as_user('carol');
select lives_ok(format($$update app.delivery_windows set deleted_at = now() where id = %L$$, pg_temp.id('w_b')), 'a window with no bookings goes');
select lives_ok(format($$insert into app.dock_slots (project_id, zone_id, starts_at, ends_at) values (%L, %L, now() + interval '5 days', now() + interval '5 days 1 hour')$$, pg_temp.id('prj_a'), pg_temp.id('gate_b')), 'and a slot can take the gate');
select throws_like(format($$update app.delivery_windows set deleted_at = null where id = %L$$, pg_temp.id('w_b')), 'delivery_window_overlap:%', 'restoring it then refuses');
select pg_temp.as_platform();
select ok(exists (select 1 from private.trash_excluded_tables t where t.table_name = 'delivery_windows'), 'windows stay out of Trash with a rationale');

-- G-99 (from 2683). The helper is private, so a security definer wrapper calls it with the signed-in person's claims.
select pg_temp.as_platform();
create function pg_temp.docks_full(p_project text, p_at timestamptz) returns boolean language sql security definer as $$ select private.project_docks_full_at(pg_temp.id(p_project), p_at) $$;
select pg_temp.as_user('carol');
select is(pg_temp.docks_full('prj_a', now() + interval '5 days 30 minutes'), true, 'a full window at gate A and a slot at gate B leave no free dock');
select pg_temp.as_user('alice');
insert into app.delivery_windows (project_id, zone_id, starts_at, ends_at, vehicle_limit) values (pg_temp.id('prj_a2'), pg_temp.id('gate_b'), now() + interval '30 days', now() + interval '30 days 2 hours', 1);
insert into world select 'w_f', id from app.delivery_windows where project_id = pg_temp.id('prj_a2');
select is(pg_temp.docks_full('prj_a2', now() + interval '30 days 1 hour'), false, 'a window with places left is not full, and a zone with only windows counts');
select is(pg_temp.docks_full('prj_a2', now() + interval '31 days'), false, 'outside the window, free');
select app.book_delivery_window(gen_random_uuid(), pg_temp.id('w_f'));
select is(pg_temp.docks_full('prj_a2', now() + interval '30 days 1 hour'), true, 'and full once its places are taken');

select * from finish();
rollback;
