-- pgTAP: migration 1460, marketplace discovery and recommendations (A89, RRR-134, A65-008 and A65-031). The marketplace
-- RPC ranks the listings open to the caller by a score from their own profile (skills 40, certifications 30, location
-- 20, availability 10), filters by discipline and category, distance and a required certification, never shows a
-- listing the caller could not see, and hides the listings they passed on.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(28);

-- Venues: Miami (located) and New York (located, no Florida jurisdiction).
update app.venues set locality = 'Miami', location = extensions.st_setsrid(extensions.st_makepoint(-80.1918, 25.7617), 4326)::extensions.geography
where id = pg_temp.id('venue_a');
insert into app.venues (org_id, name, jurisdiction_id, time_zone, locality, location)
values (pg_temp.id('org_a'), 'Hudson Yards Hall', 'US', 'America/New_York', 'New York',
  extensions.st_setsrid(extensions.st_makepoint(-74.0060, 40.7128), 4326)::extensions.geography)
returning id as v_ny \gset
insert into world values ('venue_ny', :'v_ny');
insert into app.certifications (org_id, name, issuing_body) values (pg_temp.id('org_a'), 'ETCP Rigger', 'ETCP') returning id as v_cert \gset
insert into world values ('cert_etcp', :'v_cert');

create function pg_temp.listing(p_key text, p_cat text, p_venue text, p_deadline_days integer, p_starts date) returns uuid
language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.as_user('carol');
  insert into app.opportunities (project_id, role_type, cat_urid, title, description, visibility, rate_type, venue_id, deadline_at, starts_on, ends_on)
  values (pg_temp.id('prj_a'), 'Vendor', p_cat, 'Summer Series ' || p_key, 'Line arrays and consoles for ' || p_key, 'Invited', 'Bid',
    pg_temp.id(p_venue), now() + make_interval(days => p_deadline_days), p_starts, p_starts + 2)
  returning id into v;
  insert into world values (p_key, v);
  insert into app.opportunity_invitations (opportunity_id, person_id) values (v, pg_temp.id('nina'));
  perform app.transition_opportunity(v, 'Draft', 'Pending Approval', 'Ready for approval.');
  perform app.transition_opportunity(v, 'Pending Approval', 'Published', 'Approved.');
  perform pg_temp.as_platform();
  return v;
end $$;
grant execute on function pg_temp.listing(text, text, text, integer, date) to public;

select pg_temp.listing('opp_skill', '5000.01.02', 'venue_a', 20, '2027-06-01');
select pg_temp.listing('opp_disc', '5000.01.04', 'venue_a', 10, '2027-06-10');
select pg_temp.listing('opp_cert', '5000.01.02', 'venue_a', 30, '2027-06-20');
select pg_temp.listing('opp_far', '9000.01.01', 'venue_ny', 5, '2027-07-01');
insert into app.opportunity_requirements (opportunity_id, requirement_kind, description, certification_id)
values (pg_temp.id('opp_cert'), 'Certification', 'ETCP Rigger certification', pg_temp.id('cert_etcp'));

-- Nina's profile: Miami, United States, skilled in PA Systems (5000.01.02).
select pg_temp.as_user('nina');
insert into app.person_profiles (person_id, handle, city, country_code) values (pg_temp.id('nina'), 'nina-halvorsen', 'Miami', 'US');
insert into app.person_skills (person_id, cat_urid) values (pg_temp.id('nina'), '5000.01.02');

create function pg_temp.keys(p_sql text) returns text[]
language plpgsql as $$
declare v text[];
begin
  execute format('select array_agg(w.key order by r.ord) from (select x.id, row_number() over () as ord from (%s) x) r join world w on w.id = r.id', p_sql)
  into v;
  return v;
end $$;

select is(pg_temp.keys($$select id from app.search_marketplace()$$),
  array['opp_skill', 'opp_disc', 'opp_cert', 'opp_far'],
  'recommended order: exact skill match first, then the same discipline, then a listing whose certification is missing, then another department far away');
select is((select recommendation_score from app.search_marketplace() where id = pg_temp.id('opp_skill')), 100,
  'the exact match scores skills 40, certifications 30, location 20 and availability 10');
select results_eq($$select skill_points, certification_points, location_points, availability_points from app.search_marketplace() where id = pg_temp.id('opp_disc')$$,
  $$values (25, 30, 20, 10)$$, 'the same discipline earns 25 for skills');
select results_eq($$select certification_points, certifications_required, certifications_met from app.search_marketplace() where id = pg_temp.id('opp_cert')$$,
  $$values (0, 1, 0)$$, 'a missing certification earns nothing for certifications');
select results_eq($$select skill_points, location_points from app.search_marketplace() where id = pg_temp.id('opp_far')$$,
  $$values (0, 5)$$, 'another department earns no skill points; another city in the same country earns 5 for location');
select is(pg_temp.keys($$select id from app.search_marketplace(p_sort => 'soonest')$$),
  array['opp_far', 'opp_disc', 'opp_skill', 'opp_cert'], 'soonest order is the deadline, then the start date');

-- A certification on the profile with the same name counts toward ranking.
insert into app.person_certifications (person_id, name, issuing_body, issued_on, expires_on)
values (pg_temp.id('nina'), 'ETCP Rigger', 'ETCP', '2026-01-01', '2099-01-01');
select is((select certification_points from app.search_marketplace() where id = pg_temp.id('opp_cert')), 30,
  'a current profile certification of the same name meets the requirement for ranking');
update app.person_certifications set expires_on = '2026-02-01' where person_id = pg_temp.id('nina');
select is((select certification_points from app.search_marketplace() where id = pg_temp.id('opp_cert')), 0,
  'an expired one does not');

-- Availability: an Unavailable block over the listing's dates.
insert into app.availability_calendars (person_id, time_zone) values (pg_temp.id('nina'), 'America/New_York') returning id as v_cal \gset
insert into app.availability_blocks (availability_calendar_id, starts_at, ends_at, availability_kind)
values (:'v_cal', '2027-06-02T12:00:00Z', '2027-06-02T20:00:00Z', 'Unavailable');
select is((select availability_points from app.search_marketplace() where id = pg_temp.id('opp_skill')), 0,
  'an Unavailable block during the listing''s dates costs the availability points');
select is((select availability_points from app.search_marketplace() where id = pg_temp.id('opp_disc')), 10,
  'a listing on other dates keeps them');

-- Filters.
select is(pg_temp.keys($$select id from app.search_marketplace(p_disc_code => '5000.01', p_sort => 'soonest')$$),
  array['opp_disc', 'opp_skill', 'opp_cert'], 'the discipline filter keeps listings whose category is in the discipline');
select is(pg_temp.keys($$select id from app.search_marketplace(p_cat_urid => '5000.01.04')$$), array['opp_disc'], 'the category filter');
select is(pg_temp.keys($$select id from app.search_marketplace(p_certification_name => 'etcp')$$), array['opp_cert'],
  'the required certification filter matches the certification name, ignoring case');
select is(pg_temp.keys($$select id from app.search_marketplace(p_query => 'opp_far')$$), array['opp_far'], 'the words filter');
select is(pg_temp.keys($$select id from app.search_marketplace(p_near_latitude => 25.77, p_near_longitude => -80.19, p_radius_km => 50, p_sort => 'soonest')$$),
  array['opp_disc', 'opp_skill', 'opp_cert'], 'the distance filter keeps venues within the radius (PostGIS)');
select is((select distance_km from app.search_marketplace(p_near_latitude => 25.77, p_near_longitude => -80.19) where id = pg_temp.id('opp_far')) > 1700, true,
  'and reports the distance from the place in kilometers');
select is((select location_points from app.search_marketplace(p_near_latitude => 40.71, p_near_longitude => -74.0) where id = pg_temp.id('opp_far')), 20,
  'searching near a place scores location by distance from it');
select throws_ok($$select * from app.search_marketplace(p_radius_km => 10)$$, 'XR001', null, 'a radius needs a place');
select throws_ok($$select * from app.search_marketplace(p_sort => 'paid')$$, 'XR001', null, 'only the published orders exist; no placement can be bought');

-- Passing.
insert into app.passed_opportunities (opportunity_id) values (pg_temp.id('opp_skill'));
select ok(not exists (select 1 from app.search_marketplace() where id = pg_temp.id('opp_skill')), 'a passed listing leaves the results');
select is((select is_passed from app.search_marketplace(p_include_passed => true) where id = pg_temp.id('opp_skill')), true,
  'and comes back marked when passed listings are asked for');
update app.passed_opportunities set deleted_at = now() where opportunity_id = pg_temp.id('opp_skill');
select ok(exists (select 1 from app.search_marketplace() where id = pg_temp.id('opp_skill')), 'undoing the pass brings it back');

-- Places.
select set_eq($$select label from app.marketplace_places()$$, $$values ('Miami'), ('New York')$$,
  'places to search near are the localities of located venues among the listings open to the caller');

-- Visibility is never widened.
select pg_temp.as_user('quinn');
select is((select count(*)::integer from app.search_marketplace() where id in (pg_temp.id('opp_skill'), pg_temp.id('opp_far'))), 0,
  'a person not invited sees none of the invited listings');
select is_empty($$select * from app.marketplace_places() where label = 'New York'$$, 'nor their places');
select throws_ok(format($$insert into app.passed_opportunities (opportunity_id) values (%L)$$, pg_temp.id('opp_far')), 'XR001', null,
  'nor can they pass on one');

-- Saved search filters.
select pg_temp.as_user('nina');
select lives_ok($$insert into app.saved_searches (person_id, name, disc_code, certification_name, near_label, near_latitude, near_longitude, radius_km)
  values (pg_temp.id('nina'), 'Audio near Miami', '5000.01', 'ETCP', 'Miami', 25.77, -80.19, 50)$$, 'a saved search keeps the new filters');
select throws_ok($$insert into app.saved_searches (person_id, name, near_label, near_latitude, near_longitude, radius_km)
  values (pg_temp.id('nina'), 'Too far', 'Miami', 25.77, -80.19, 900)$$, '23514', null, 'a radius above 500 km is refused');

select * from finish();
rollback;
