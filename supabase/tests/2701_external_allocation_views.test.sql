-- pgTAP: migration 2701 (R8), what Gateway and Compass read. The column lists of api_external.advance_allocations and
-- api_external.my_parking_passes carry no price, order number, vendor or plate. A person on a roster reads their own
-- badge, parking pass, custody, travel, room, catering line and per diem and none of a colleague's; the party reads the
-- pool. api_external.my_roster_engagements returns the engagement only while the entry is live and accepted.
-- api_external.requestable_items lists only what is Provided. The widened views keep their earlier columns in place.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql

select no_plan();

create function pg_temp.columns(p_view text) returns text[]
language sql security definer as $$
  select array_agg(a.attname::text order by a.attnum) from pg_attribute a
  where a.attrelid = p_view::regclass and a.attnum > 0 and not a.attisdropped
$$;

-- Assigns p_kind to an entry as Carol and issues it with p_items under a fresh event id.
create function pg_temp.give(p_entry text, p_kind text, p_target text, p_items jsonb) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  v_id := pg_temp.alloc('assign', 'carol', p_entry, p_kind, p_target, 1);
  perform pg_temp.as_user('carol');
  perform app.issue_allocation(gen_random_uuid(), v_id, p_items);
  perform pg_temp.as_platform();
  return v_id;
end $$;

-- Column lists ----------------------------------------------------------------------------------------------------------------
select ok(not (pg_temp.columns('api_external.advance_allocations') && array['price_minor', 'unit_price_minor', 'po_number',
  'purchase_order_id', 'po_line_id', 'vendor_id', 'vendor_name', 'supplier_name', 'asset_tag', 'plate']),
  'allocations carry no price, order, vendor or tag');
select ok(not (pg_temp.columns('api_external.my_parking_passes') && array['plate', 'plate_region', 'price_minor', 'vendor_name']),
  'parking passes carry no plate');
select is(pg_temp.columns('api_external.credentials'), array['id', 'project_id', 'project_name', 'category_code', 'category_name',
  'holder_person_id', 'holder_name', 'credential_number', 'valid_from', 'valid_to', 'revoked_at', 'engagement_id', 'category_kind'],
  'credentials keep their columns and end with category_kind');
select is(pg_temp.columns('api_external.asset_custody'), array['id', 'asset_unit_id', 'asset_tag', 'class_name', 'asset_state',
  'engagement_id', 'project_id', 'project_name', 'held_since', 'roster_entry_id'], 'custody ends with roster_entry_id');
select is(pg_temp.columns('api_external.per_diems'), array['id', 'engagement_id', 'project_id', 'project_name', 'day', 'amount_minor',
  'currency_code', 'roster_entry_id'], 'per diems end with roster_entry_id');
select is(pg_temp.columns('api_external.travel'), array['id', 'engagement_id', 'project_id', 'project_name', 'travel_mode',
  'operator_name', 'service_identifier', 'confirmation_identifier', 'departs_from', 'departs_at', 'departs_time_zone',
  'arrives_at_place', 'arrives_at', 'arrives_time_zone'], 'travel keeps its columns');
select is((pg_temp.columns('api_external.my_roster_engagements'))[1:20], pg_temp.columns('api_external.engagements'),
  'roster engagements start with the columns of api_external.engagements');
select is((pg_temp.columns('app.advance_allocation_status'))[1:3], array['allocation_id', 'org_id', 'project_id'],
  'the producing org''s status view keeps its columns');

-- What Kai and Mo were given ---------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into world select 'kai_badge', pg_temp.give('e_kai', 'category', 'cat_crew', '[{}]');
insert into world select 'mo_badge', pg_temp.give('e_mo', 'category', 'cat_crew', '[{}]');
insert into world select 'kai_radio', pg_temp.give('e_kai', 'class', 'cls_radio', '[{"asset_tag": "NWL-RAD-001"}]');
insert into world select 'mo_radio', pg_temp.give('e_mo', 'class', 'cls_radio', '[{"asset_tag": "NWL-RAD-002"}]');
insert into world select 'kai_trip', pg_temp.give('e_kai', 'travel', null, '[{"travel_mode": "Flight", "departs_from": "BOS", "departs_at": "2027-06-01T08:00:00Z", "departs_time_zone": "America/New_York", "arrives_at_place": "MIA", "arrives_time_zone": "America/New_York"}]');
insert into world select 'mo_trip', pg_temp.give('e_mo', 'travel', null, '[{"travel_mode": "Flight", "departs_from": "JFK", "departs_at": "2027-06-01T09:00:00Z", "departs_time_zone": "America/New_York", "arrives_at_place": "MIA", "arrives_time_zone": "America/New_York"}]');
insert into world select 'kai_room', pg_temp.give('e_kai', 'block', 'blk', '[{}]');
insert into world select 'mo_room', pg_temp.give('e_mo', 'block', 'blk', '[{}]');
insert into world select 'kai_meals', pg_temp.give('e_kai', 'fulfillment', 'ful_cat', '[{"quantity": 1}]');
insert into world select 'mo_meals', pg_temp.give('e_mo', 'fulfillment', 'ful_cat', '[{"quantity": 1}]');
insert into world select 'kai_pd', pg_temp.give('e_kai', 'per_diem', null, '[{"day": "2027-06-01", "amount_minor": 5000, "currency_code": "USD"}]');
insert into world select 'mo_pd', pg_temp.give('e_mo', 'per_diem', null, '[{"day": "2027-06-01", "amount_minor": 5000, "currency_code": "USD"}]');
-- Kai's parking pass, for his van, in Lot A.
select pg_temp.as_user('kai');
select app.save_roster_vehicle(pg_temp.id('e_kai'), 'Ford', 'Transit', 'White', 'ABC1234', 'US-FL');
select pg_temp.as_platform();
insert into world select 'kai_car', id from app.roster_vehicles where roster_entry_id = pg_temp.id('e_kai');
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'LOT-A', 'Lot A') returning id)
insert into world select 'lot_a', id from x;
insert into app.access_grid (credential_category_id, zone_id, access_level_enum_id, window_starts_at, window_ends_at)
values (pg_temp.id('cat_park'), pg_temp.id('lot_a'), 'ENM-036', '2027-06-01 00:00+00', '2027-06-06 00:00+00');
insert into world select 'kai_park', pg_temp.give('e_kai', 'category', 'cat_park',
  jsonb_build_array(jsonb_build_object('roster_vehicle_id', pg_temp.id('kai_car'))));
-- A pending pool request, the party's own.
insert into world select 'pool', pg_temp.alloc('request', 'dave', 'eng_vendor_a', 'class', 'cls_radio', 2);

-- Kai reads his own and nobody else's -----------------------------------------------------------------------------------------
select pg_temp.as_user('kai');
select is((select count(*)::int from api_external.credentials where holder_person_id = pg_temp.id('kai')), 2,
  'Kai reads his badge and his parking pass');
select is((select count(*)::int from api_external.credentials where holder_person_id = pg_temp.id('mo')), 0, 'and not Mo''s badge');
select is((select category_kind::text from api_external.credentials where id = (select c.id from api_external.credentials c
  where c.category_name = 'Crew Parking')), 'Parking', 'the pass reads as Parking');
select is((select string_agg(asset_tag, ',') from api_external.asset_custody), 'NWL-RAD-001', 'Kai reads only his radio');
select is((select roster_entry_id from api_external.asset_custody), pg_temp.id('e_kai'), 'held on his entry');
select is((select string_agg(departs_from, ',') from api_external.travel), 'BOS', 'his own trip only');
select is((select count(*)::int from api_external.lodging), 1, 'his own room only');
select is((select person_id from api_external.lodging), pg_temp.id('kai'), 'his');
select is((select count(*)::int from api_external.hospitality), 1, 'his own catering line only');
select is((select roster_entry_id from api_external.per_diems), pg_temp.id('e_kai'), 'his own per diem only');
select is((select count(*)::int from api_external.per_diems), 1, 'one day');
select is((select array_agg(allocation_id order by allocation_id) from api_external.advance_allocations),
  (select array_agg(id order by id) from world where key in ('kai_badge', 'kai_radio', 'kai_trip', 'kai_room', 'kai_meals', 'kai_pd', 'kai_park')),
  'his allocations, not Mo''s and not the pool');
select is((select display_status from api_external.advance_allocations where allocation_id = pg_temp.id('kai_radio')), 'Issued',
  'with the computed status');
select is((select count(*)::int from api_external.requestable_items), 0, 'Kai may ask for nothing');
select is((select array_to_string(zone_names, ',') || ' ' || vehicle_make || ' ' || vehicle_model || ' ' || vehicle_color
           from api_external.my_parking_passes),
  'Lot A Ford Transit White', 'his parking pass names Lot A and his van, never its plate');
select is((select count(*)::int from api_external.my_parking_passes), 1, 'one pass');

-- The party reads the pool and every person ----------------------------------------------------------------------------------
select pg_temp.as_user('victor');
select ok((select count(*) from api_external.advance_allocations where roster_entry_id is null) = 1, 'the Owner reads the pool');
select ok((select count(*) from api_external.advance_allocations where roster_entry_id = pg_temp.id('e_mo')) = 6,
  'and Mo''s allocations');
select is((select person_name from api_external.advance_allocations where allocation_id = pg_temp.id('mo_badge')), 'Mo Lindqvist',
  'with his name');
select ok((select count(*) from api_external.requestable_items where engagement_id = pg_temp.id('eng_vendor_a')
           and item_kind = 'credential_category' and item_id = pg_temp.id('cat_crew')) = 1, 'an Access badge is requestable');
select is((select requested_quantity from api_external.requestable_items where engagement_id = pg_temp.id('eng_vendor_a')
           and item_kind = 'asset_class' and item_id = pg_temp.id('cls_radio')), 4::numeric, 'radios with what is already asked');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'offerings.parking', 'Organization', null, 'reimbursed');
select pg_temp.as_user('victor');
select is((select count(*)::int from api_external.requestable_items where item_id = pg_temp.id('cat_park')), 0,
  'a Parking pass is requestable only while parking is Provided');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'offerings.parking', 'Organization', null, 'provided');

-- Engagements through the roster ---------------------------------------------------------------------------------------------
select pg_temp.as_user('kai');
select is((select roster_entry_id from api_external.my_roster_engagements where id = pg_temp.id('eng_vendor_a')), pg_temp.id('e_kai'),
  'Kai reaches the vendor engagement through his accepted entry');
select is((select lead_name from api_external.my_roster_engagements), 'Pia Larsen', 'with the Advancing Lead to ask');
select is((select areas from api_external.my_roster_engagements), array['onboarding', 'operational', 'roster'],
  'and his roster areas');
select is((select rate_minor from api_external.my_roster_engagements), null::bigint, 'never the party''s rate');
select ok(exists (select 1 from api_external.engagement_offerings where engagement_id = pg_temp.id('eng_vendor_a')),
  'Kai reads what the org offers on it');
select ok(exists (select 1 from api_external.engagement_up_next where engagement_id = pg_temp.id('eng_vendor_a')),
  'and its Up Next venue');
select pg_temp.as_user('una');
select is((select count(*)::int from api_external.my_roster_engagements), 0, 'a Draft entry reaches nothing');
select pg_temp.as_user('victor');
select is((select count(*)::int from api_external.my_roster_engagements), 0, 'the Owner reads the engagement as the party');
select pg_temp.as_user('victor');
select app.withdraw_roster_entry(pg_temp.id('e_kai'), 'Swapped out.');
select pg_temp.as_user('kai');
select is((select count(*)::int from api_external.my_roster_engagements where roster_entry_id is not null), 0,
  'a withdrawn entry reaches nothing');

select * from finish();
rollback;
