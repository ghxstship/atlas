-- pgTAP: migration 2943 (B5, G-32), green rooms and dressing rooms. A booking takes a space of the project's venue and,
-- from a set time, the set's engagement. Refusals: an Exclusive booking over any live booking, a Shared one over an
-- Exclusive one (Shared bookings overlap freely), a space of another venue or org, a set time of another engagement.
-- The board groups overlapping Shared bookings, reports the peak party (not the cluster total) against capacity, and
-- Set moved once the cue's planned time leaves the window; the set columns are NULL without show.run_of_show.read. The
-- act reads its own bookings in api_external.space_bookings and never another act's.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql
\ir 2940_travel_world.psql

select no_plan();

create function pg_temp.book(p_key text, p_space text, p_from timestamptz, p_to timestamptz, p_mode text default 'Exclusive',
  p_party smallint default null, p_engagement text default null, p_cue text default null) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  perform pg_temp.as_user('alice');
  insert into app.space_bookings (project_id, space_id, engagement_id, engagement_cue_id, purpose, booking_mode, party_size, starts_at, ends_at)
  values (pg_temp.id('prj_a'), pg_temp.id(p_space), pg_temp.id(p_engagement), pg_temp.id(p_cue), 'Green Room',
    p_mode::app.space_booking_mode, p_party, p_from, p_to)
  returning id into v_id;
  perform pg_temp.as_platform();
  insert into world values (p_key, v_id);
  return v_id;
end $$;

create function pg_temp.board(p_who text, p_key text) returns app.space_booking_board
language plpgsql as $$
declare
  v app.space_booking_board;
begin
  perform pg_temp.as_user(p_who);
  select * into v from app.space_booking_board b where b.id = pg_temp.id(p_key);
  perform pg_temp.as_platform();
  return v;
end $$;

-- Spaces, a second venue and a set time -----------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
with x as (insert into app.spaces (venue_id, name, capacity) values (pg_temp.id('venue_a'), 'Green Room A', 10) returning id)
insert into world select 'gr', id from x;
with x as (insert into app.spaces (venue_id, name) values (pg_temp.id('venue_a'), 'Dressing Room 1') returning id)
insert into world select 'dr', id from x;
with x as (insert into app.venues (org_id, name, jurisdiction_id, time_zone)
  values (pg_temp.id('org_a'), 'Northwind Annex', 'US-FL-MIAMI-DADE', 'America/New_York') returning id)
insert into world select 'venue_a2', id from x;
with x as (insert into app.spaces (venue_id, name) values (pg_temp.id('venue_a2'), 'Annex Lounge') returning id)
insert into world select 'annex', id from x;
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date)
  values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Opening Night Running Order', '2027-06-05') returning id)
insert into world select 'ros', id from x;
with x as (insert into app.cues (run_of_show_id, position, label, planned_at, duration)
  values (pg_temp.id('ros'), 1, 'Arturo Bell set', '2027-06-05 01:00+00', interval '75 minutes') returning id)
insert into world select 'cue', id from x;
select pg_temp.as_user('xavier');
with x as (insert into app.spaces (venue_id, name) values (pg_temp.id('venue_b'), 'Harbor Green Room') returning id)
insert into world select 'gr_b', id from x;
select pg_temp.as_user('alice');
with x as (insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement,
  start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('quinn'), 'Artist', '2000.50.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement',
    '2027-06-05') returning id)
insert into world select 'eng_quinn_art', id from x;
select pg_temp.as_platform();
with x as (insert into app.engagement_cues (engagement_id, cue_id) values (pg_temp.id('eng_art_a'), pg_temp.id('cue')) returning id)
insert into world select 'set_art', id from x;
with x as (insert into app.engagement_cues (engagement_id, cue_id) values (pg_temp.id('eng_quinn_art'), pg_temp.id('cue')) returning id)
insert into world select 'set_quinn', id from x;

-- From a set time ------------------------------------------------------------------------------------------------------------------
select pg_temp.book('b_art', 'dr', '2027-06-04 23:30+00', '2027-06-05 03:15+00', 'Exclusive', null, null, 'set_art');
select is((select engagement_id from app.space_bookings where id = pg_temp.id('b_art')), pg_temp.id('eng_art_a'),
  'a booking from a set time takes the set''s engagement');
select is(pg_temp.rule_of($$select pg_temp.book('x', 'dr', '2027-06-06 23:30+00', '2027-06-07 03:15+00', 'Exclusive', null, 'eng_quinn_art', 'set_art')$$),
  'space_booking_set_engagement', 'a set time of another engagement is refused');
select is(pg_temp.rule_of($$select pg_temp.book('x', 'annex', '2027-06-06 10:00+00', '2027-06-06 11:00+00')$$), 'space_booking_venue',
  'a space of another venue is refused');
select is(pg_temp.rule_of($$select pg_temp.book('x', 'gr_b', '2027-06-06 10:00+00', '2027-06-06 11:00+00')$$), 'cross_org_reference',
  'a space of another org is refused');
select pg_temp.as_user('alice');
with x as (insert into app.spaces (venue_id, name, deleted_at) values (pg_temp.id('venue_a'), 'Old Lounge', now()) returning id)
insert into world select 'old', id from x;
select pg_temp.as_platform();
select is(pg_temp.rule_of($$select pg_temp.book('x', 'old', '2027-06-06 10:00+00', '2027-06-06 11:00+00')$$), 'space_booking_space',
  'a deleted space is refused');

-- Overlaps -------------------------------------------------------------------------------------------------------------------------
select is(pg_temp.rule_of($$select pg_temp.book('x', 'dr', '2027-06-05 03:00+00', '2027-06-05 04:00+00', 'Shared')$$),
  'space_booking_overlap', 'a Shared booking over an Exclusive one is refused');
select is(pg_temp.rule_of($$select pg_temp.book('x', 'dr', '2027-06-05 03:00+00', '2027-06-05 04:00+00')$$), 'space_booking_overlap',
  'an Exclusive booking over any booking is refused');
select is(pg_temp.rule_of($$select pg_temp.book('x', 'dr', '2027-06-05 03:15+00', '2027-06-05 04:00+00')$$), 'ok',
  'a booking starting as another ends does not overlap');
-- A overlaps B, B overlaps C, A and C never meet: the cluster is A, B, C; the peak is 6 + 5 = 11 over capacity 10, while
-- the cluster total of 6 + 5 + 4 = 15 is only shown.
select pg_temp.book('ga', 'gr', '2027-06-05 18:00+00', '2027-06-05 20:00+00', 'Shared', 6::smallint);
select pg_temp.book('gb', 'gr', '2027-06-05 19:00+00', '2027-06-05 22:00+00', 'Shared', 5::smallint);
select pg_temp.book('gc', 'gr', '2027-06-05 21:00+00', '2027-06-05 23:00+00', 'Shared', 4::smallint);
select pg_temp.book('gd', 'gr', '2027-06-06 18:00+00', '2027-06-06 19:00+00', 'Shared', 9::smallint);
select is(pg_temp.rule_of($$select pg_temp.book('x', 'gr', '2027-06-05 19:30+00', '2027-06-05 19:45+00')$$), 'space_booking_overlap',
  'an Exclusive booking over Shared ones is refused');

select is((pg_temp.board('hops', 'gc')).conflict_group, pg_temp.id('ga'), 'A, B and C are one conflict group');
select is((pg_temp.board('hops', 'gb')).group_size, 3, 'of three');
select is((pg_temp.board('hops', 'gb')).group_party_total, 15, 'the cluster total is 15');
select is((pg_temp.board('hops', 'gb')).group_peak_party, 11, 'the peak at one instant is 11');
select is((pg_temp.board('hops', 'ga')).over_capacity, true, 'which is over the capacity of 10');
select is((pg_temp.board('hops', 'gd')).conflict_group, null, 'a booking that overlaps none has no conflict group');
select is((pg_temp.board('hops', 'gd')).over_capacity, false, 'and 9 fits');
select is((pg_temp.board('hops', 'b_art')).over_capacity, null, 'over capacity is NULL for a space without a capacity');
select is((pg_temp.board('hops', 'gd')).space_name, 'Green Room A', 'the board names the space for the desk');

-- Set moved --------------------------------------------------------------------------------------------------------------------------
select is((pg_temp.board('alice', 'b_art')).set_moved, false, 'the set falls inside the booking');
select is((pg_temp.board('alice', 'b_art')).set_label, 'Arturo Bell set', 'with its label');
select is((pg_temp.board('alice', 'b_art')).act_name, 'Arturo Bell', 'and the act');
select pg_temp.as_user('alice');
update app.cues set duration = interval '135 minutes' where id = pg_temp.id('cue');
select pg_temp.as_platform();
select is((pg_temp.board('alice', 'b_art')).set_moved, false, 'a set ending exactly at out has not moved');
select pg_temp.as_user('alice');
update app.cues set planned_at = '2027-06-05 02:30+00' where id = pg_temp.id('cue');
select pg_temp.as_platform();
select is((pg_temp.board('alice', 'b_art')).set_moved, true, 'a set moved past out shows Set moved');
select is((pg_temp.board('hops', 'b_art')).set_planned_at, null, 'without show.run_of_show.read the set columns are NULL');
select is((pg_temp.board('hops', 'b_art')).set_moved, false, 'and nothing reads as moved');
select pg_temp.as_user('alice');
update app.cues set planned_at = null where id = pg_temp.id('cue');
select pg_temp.as_platform();
select is((pg_temp.board('alice', 'b_art')).set_moved, false, 'a set with no planned time has not moved');
select ok(not has_table_privilege('xos_backup', 'app.space_booking_board', 'select'), 'xos_backup cannot select the board');

-- What the act reads ---------------------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Active');
select pg_temp.as_user('art');
select is((select array_agg(space_name) from api_external.space_bookings), array['Dressing Room 1'], 'the artist reads their room');
select is((select set_label from api_external.space_bookings), 'Arturo Bell set', 'with the set');
select pg_temp.as_user('rita');
select is((select count(*)::int from api_external.space_bookings), 1, 'so does their representative');
select pg_temp.as_user('kai');
select is((select count(*)::int from api_external.space_bookings), 0, 'another act''s people read none');
select pg_temp.as_platform();

select * from finish();
rollback;
