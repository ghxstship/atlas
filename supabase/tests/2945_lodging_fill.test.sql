-- pgTAP: migration 2945 (B5, G-66 and G-67), hotel blocks by night, acts without rooms and lodging against the budget.
-- The nights view matches private.block_peak_occupancy on every night; acts without rooms lists exactly the Artist
-- engagements with Lodging offered none of whose people holds a room; a block links to a live line of its own project's
-- budget by a writer holding finance.budget.read, in the budget's currency; app.budget_line_lodging sums held and
-- assigned room nights and amounts, NULL when a block is unpriced, and withholds everything from a reader without
-- hospitality.fulfillment.read. Nothing is written to the budget line.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql
\ir 2940_travel_world.psql

select no_plan();

select pg_temp.producer('hospwriter', 'hospitality.accommodation.write');
select pg_temp.producer('fin', 'finance.budget.read');
-- hospwriter also reads hospitality, as a desk writer does, and still lacks finance.budget.read.
insert into app.role_capabilities (role_id, capability_code, reach)
select r.id, 'hospitality.fulfillment.read', 'organization' from app.roles r where r.org_id = pg_temp.id('org_a') and r.code = 'hospwriter_only';

-- Nights -----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into app.accommodation_assignments (accommodation_block_id, person_id, check_in_on, check_out_on)
values (pg_temp.id('blk'), pg_temp.id('kai'), '2027-06-01', '2027-06-04'), (pg_temp.id('blk'), pg_temp.id('mo'), '2027-06-02', '2027-06-03');
select pg_temp.as_platform();

select pg_temp.as_user('hops');
create temporary table nights as select * from app.accommodation_block_nights where block_id = pg_temp.id('blk');
select pg_temp.as_platform();
select is((select array_agg(night order by night) from nights),
  array['2027-05-31', '2027-06-01', '2027-06-02', '2027-06-03', '2027-06-04', '2027-06-05']::date[], 'one row per night held');
select is((select array_agg(assigned order by night) from nights), array[0, 1, 2, 1, 0, 0], 'rooms assigned per night');
select is((select array_agg(free order by night) from nights), array[10, 9, 8, 9, 10, 10], 'rooms free per night');
select is((select count(*)::int from nights n where n.assigned <> private.block_peak_occupancy(pg_temp.id('blk'), null, n.night, n.night + 1)), 0,
  'every night matches private.block_peak_occupancy');
select pg_temp.as_user('creds');
select is((select count(*)::int from app.accommodation_block_nights), 0, 'a reader without hospitality.fulfillment.read sees none');
select pg_temp.as_platform();
select ok(not has_table_privilege('xos_backup', 'app.accommodation_block_nights', 'select'), 'xos_backup cannot select it');

-- Acts without rooms ---------------------------------------------------------------------------------------------------------------
create function pg_temp.roomless(p_who text) returns setof uuid
language plpgsql as $$
begin
  perform pg_temp.as_user(p_who);
  return query select a.engagement_id from app.acts_without_rooms(pg_temp.id('prj_a')) a;
  perform pg_temp.as_platform();
end $$;

select pg_temp.as_user('creds');
select throws_ok(format($$select * from app.acts_without_rooms(%L)$$, pg_temp.id('prj_a')), '42501', null,
  'acts without rooms needs hospitality.fulfillment.read');
select pg_temp.as_platform();
select is(array(select pg_temp.roomless('hops')), array[pg_temp.id('eng_art_a')], 'the artist without a room is listed; vendors are not');
select pg_temp.as_user('hops');
select is((select act_name from app.acts_without_rooms(pg_temp.id('prj_a'))), 'Arturo Bell', 'by name');
select is((select people_count from app.acts_without_rooms(pg_temp.id('prj_a'))), 1, 'with one person');
select pg_temp.as_platform();
-- A guest on the artist's roster, written directly as the platform (the roster RPCs are tested in 2635).
with x as (insert into app.engagement_roster_entries (engagement_id, person_id) values (pg_temp.id('eng_art_a'), pg_temp.id('una'))
  returning id)
insert into world select 'e_art_guest', id from x;
select pg_temp.as_user('alice');
insert into app.accommodation_assignments (accommodation_block_id, person_id, check_in_on, check_out_on)
values (pg_temp.id('blk'), pg_temp.id('una'), '2027-06-04', '2027-06-05');
select pg_temp.as_platform();
select is(array(select pg_temp.roomless('hops')), '{}'::uuid[], 'a room held by a person on the act''s roster counts for the act');
alter table app.engagement_roster_entries disable trigger user;
update app.engagement_roster_entries set person_response = 'Declined', responded_at = now() where id = pg_temp.id('e_art_guest');
alter table app.engagement_roster_entries enable trigger user;
select is(array(select pg_temp.roomless('hops')), array[pg_temp.id('eng_art_a')], 'a declined roster person does not');
insert into app.offering_rules (org_id, project_id, offering, external_role_type, offering_mode)
values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Lodging', 'Artist', 'Not Offered');
select is(array(select pg_temp.roomless('hops')), '{}'::uuid[], 'an artist without Lodging offered is not listed');
delete from app.offering_rules where offering = 'Lodging' and project_id = pg_temp.id('prj_a');

-- Budget line ----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Summer Series Budget', 'USD') returning id)
insert into world select 'bud', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), 1, 'Crew hotel.', '0000.01.01', 1, 1500000, 'X', 'Declared') returning id)
insert into world select 'bl', id from x;
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a2'), 'Winter Gala Budget', 'USD') returning id)
insert into world select 'bud2', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud2'), 1, 'Gala hotel.', '0000.01.01', 1, 100000, 'X', 'Declared') returning id)
insert into world select 'bl2', id from x;
select pg_temp.as_platform();

select is(pg_temp.rule_of(format($$select pg_temp.as_user('alice'); update app.accommodation_blocks set budget_line_id = %L where id = %L$$,
  pg_temp.id('bl2'), pg_temp.id('blk'))), 'accommodation_block_budget_project', 'another project''s line is refused');
select is(pg_temp.rule_of(format($$select pg_temp.as_user('hospwriter'); update app.accommodation_blocks set budget_line_id = %L where id = %L$$,
  pg_temp.id('bl'), pg_temp.id('blk'))), '42501', 'a writer without finance.budget.read cannot link');
select is(pg_temp.rule_of(format($$select pg_temp.as_user('alice'); update app.accommodation_blocks set budget_line_id = %L,
  nightly_rate_minor = 20000, currency_code = 'EUR' where id = %L$$, pg_temp.id('bl'), pg_temp.id('blk'))),
  'accommodation_block_budget_currency', 'a priced block in another currency is refused');
select pg_temp.as_platform();
select pg_temp.as_user('alice');
update app.accommodation_blocks set budget_line_id = pg_temp.id('bl'), nightly_rate_minor = 20000, currency_code = 'USD'
where id = pg_temp.id('blk');
select pg_temp.as_platform();
select is((select budget_line_id from app.accommodation_blocks where id = pg_temp.id('blk')), pg_temp.id('bl'), 'a block links to its project''s line');
select is(pg_temp.rule_of(format($$select pg_temp.as_user('alice'); update app.accommodation_blocks set currency_code = 'EUR' where id = %L$$,
  pg_temp.id('blk'))), 'accommodation_block_budget_currency', 'a later change of currency is refused too');
select pg_temp.as_platform();

create function pg_temp.lodging(p_who text) returns app.budget_line_lodging
language plpgsql as $$
declare v app.budget_line_lodging;
begin
  perform pg_temp.as_user(p_who);
  select * into v from app.budget_line_lodging l where l.budget_line_id = pg_temp.id('bl');
  perform pg_temp.as_platform();
  return v;
end $$;

-- kai 3 nights, mo 1 and una 1: 5 assigned room nights of 60 held.
select is((pg_temp.lodging('alice')).held_room_nights, 60::bigint, 'ten rooms for six nights are 60 room nights held');
select is((pg_temp.lodging('alice')).held_minor, 1200000::bigint, 'times the nightly rate');
select is((pg_temp.lodging('alice')).assigned_room_nights, 5::bigint, 'five room nights are assigned');
select is((pg_temp.lodging('alice')).assigned_minor, 100000::bigint, 'at the block''s rate');
select is((pg_temp.lodging('fin')).is_lodging_withheld, true, 'a finance reader without hospitality.fulfillment.read is withheld');
select is((pg_temp.lodging('fin')).held_minor, null, 'with no amount');
select is((pg_temp.lodging('fin')).held_room_nights, null, 'and no room nights');
select pg_temp.as_user('alice');
insert into app.accommodation_blocks (project_id, title, check_in_on, check_out_on, rooms_held, budget_line_id)
values (pg_temp.id('prj_a'), 'Overflow Hotel', '2027-06-02', '2027-06-04', 2, pg_temp.id('bl'));
select pg_temp.as_platform();
select is((pg_temp.lodging('alice')).held_room_nights, 64::bigint, 'an unpriced block adds its room nights');
select is((pg_temp.lodging('alice')).held_minor, null, 'and makes the amount unknown');
select is((pg_temp.lodging('alice')).block_count, 2, 'two blocks draw on the line');
select is((select unit_price_minor from app.budget_lines where id = pg_temp.id('bl')), 1500000::bigint, 'the budget line is unchanged');
select ok(not has_table_privilege('xos_backup', 'app.budget_line_lodging', 'select'), 'xos_backup cannot select it');

select * from finish();
rollback;
