-- pgTAP: migration 2871, the external projections of a listing whose client and event are hidden until booking (P10,
-- RRR-224, gap G-128). An invitee reads the listing with client_hidden, no venue name and the venue point rounded to 1
-- decimal, and everything else unchanged, until their application is Accepted; Explore's search masks the same way and
-- measures a hidden row's distance from the rounded point to whole kilometers; and the radius test, the location
-- points and the places to search near all use the rounded point for a flagged listing, so no search can pin the venue.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(28);

-- Venues: Miami (venue_a) and Coral Gables, each located.
update app.venues set locality = 'Miami', location = extensions.st_setsrid(extensions.st_makepoint(-80.1918, 25.7617), 4326)::extensions.geography
where id = pg_temp.id('venue_a');
select pg_temp.as_user('alice');
insert into app.venues (org_id, name, jurisdiction_id, time_zone, locality, location)
values (pg_temp.id('org_a'), 'Gables Garden Court', 'US-FL-MIAMI-DADE', 'America/New_York', 'Coral Gables',
  extensions.st_setsrid(extensions.st_makepoint(-80.2684, 25.7215), 4326)::extensions.geography)
returning id as v_cg \gset
insert into world values ('venue_cg', :'v_cg');
select pg_temp.as_platform();

-- Published vendor listings on prj_a, invited to nina.
create function pg_temp.listing(p_key text, p_venue text, p_hidden boolean) returns uuid
language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.as_user('carol');
  insert into app.opportunities (project_id, role_type, cat_urid, title, description, visibility, rate_type, venue_id, deadline_at,
    starts_on, ends_on, hide_client_until_booked)
  values (pg_temp.id('prj_a'), 'Vendor', '5000.01.02', 'Audio Package ' || p_key, 'Line arrays and consoles.', 'Invited', 'Bid',
    pg_temp.id(p_venue), now() + interval '20 days', '2027-06-01', '2027-06-03', p_hidden)
  returning id into v;
  insert into world values (p_key, v);
  insert into app.opportunity_invitations (opportunity_id, person_id) values (v, pg_temp.id('nina'));
  perform app.transition_opportunity(v, 'Draft', 'Pending Approval', 'Ready for approval.');
  perform app.transition_opportunity(v, 'Pending Approval', 'Published', 'Approved.');
  perform pg_temp.as_platform();
  return v;
end $$;
grant execute on function pg_temp.listing(text, text, boolean) to public;

select pg_temp.listing('opp_hidden', 'venue_a', true);
select pg_temp.listing('opp_open', 'venue_a', false);
select pg_temp.listing('opp_cg', 'venue_cg', true);

create function pg_temp.application_state(p_key text, p_state text) returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  alter table app.applications disable trigger user;
  update app.applications set application_state = p_state::app.application_state where id = pg_temp.id(p_key);
  alter table app.applications enable trigger user;
end $$;

-- api_external.opportunities ------------------------------------------------------------------------------------------
select pg_temp.as_user('nina');
select results_eq($$select client_hidden, venue_name, venue_latitude, venue_longitude from api_external.opportunities where id = pg_temp.id('opp_hidden')$$,
  $$values (true, null::text, 25.8::double precision, -80.2::double precision)$$,
  'an invitee reads a hidden listing with no venue name and the venue point rounded to 1 decimal');
select results_eq($$select org_name, org_verified is not null, venue_locality, starts_on, ends_on, rate_type::text, deadline_at > now() from api_external.opportunities where id = pg_temp.id('opp_hidden')$$,
  $$values ('Northwind Live'::text, true, 'Miami'::text, '2027-06-01'::date, '2027-06-03'::date, 'Bid'::text, true)$$,
  'the org, its badge, the city, the dates and the pay terms stay');
select results_eq($$select client_hidden, venue_name, venue_latitude, venue_longitude from api_external.opportunities where id = pg_temp.id('opp_open')$$,
  $$values (false, 'Northwind Pier Pavilion'::text, 25.7617::double precision, -80.1918::double precision)$$,
  'a listing with the flag off shows its venue');

with a as (insert into app.applications (opportunity_id, applicant_person_id) values (pg_temp.id('opp_hidden'), pg_temp.id('nina')) returning id)
insert into world select 'app_nina', id from a;
select is((select client_hidden from api_external.opportunities where id = pg_temp.id('opp_hidden')), true, 'a Submitted application keeps it hidden');
select pg_temp.application_state('app_nina', 'Shortlisted');
select pg_temp.as_user('nina');
select is((select client_hidden from api_external.opportunities where id = pg_temp.id('opp_hidden')), true, 'so does Shortlisted');
select pg_temp.application_state('app_nina', 'Offered');
select pg_temp.as_user('nina');
select is((select venue_name from api_external.opportunities where id = pg_temp.id('opp_hidden')), null::text, 'and Offered');
select pg_temp.application_state('app_nina', 'Accepted');
select pg_temp.as_user('nina');
select results_eq($$select client_hidden, venue_name, venue_latitude, venue_longitude from api_external.opportunities where id = pg_temp.id('opp_hidden')$$,
  $$values (false, 'Northwind Pier Pavilion'::text, 25.7617::double precision, -80.1918::double precision)$$,
  'once Accepted the booked person reads the real venue and point');
select pg_temp.as_user('carol');
select results_eq($$select hide_client_until_booked, venue_id from app.opportunities where id = pg_temp.id('opp_hidden')$$,
  $$select true, pg_temp.id('venue_a')$$, 'an org member reads app.opportunities unchanged');
select pg_temp.as_platform();
select isnt(col_description('api_external.opportunities'::regclass,
  (select attnum from pg_attribute where attrelid = 'api_external.opportunities'::regclass and attname = 'client_hidden')::integer), null,
  'the client_hidden column is documented');

-- app.search_marketplace -------------------------------------------------------------------------------------------------
-- Expected distances from a place in Miami, from the exact and the rounded venue points.
select round((extensions.st_distance(private.coarse_point(v.location),
    extensions.st_setsrid(extensions.st_makepoint(-80.13, 25.79), 4326)::extensions.geography) / 1000)::numeric) as km_rounded
from app.venues v where v.id = pg_temp.id('venue_cg') \gset

select pg_temp.as_user('nina');
select is((select (array_agg(p.parameter_name order by p.ordinal_position desc))[1] from information_schema.parameters p
  join information_schema.routines r on r.specific_name = p.specific_name
  where r.routine_schema = 'app' and r.routine_name = 'search_marketplace' and p.parameter_mode = 'OUT'), 'client_hidden',
  'client_hidden is the last column search_marketplace returns');
select results_eq($$select client_hidden, venue_name, venue_latitude, venue_longitude, venue_locality from app.search_marketplace() where id = pg_temp.id('opp_cg')$$,
  $$values (true, null::text, 25.7::double precision, -80.3::double precision, 'Coral Gables'::text)$$,
  'Explore masks a hidden listing the same way');
select is((select distance_km from app.search_marketplace(p_near_latitude => 25.79, p_near_longitude => -80.13) where id = pg_temp.id('opp_cg')),
  :'km_rounded'::numeric, 'a hidden row''s distance is from the rounded point, to whole kilometers');
select is((select scale(distance_km) from app.search_marketplace(p_near_latitude => 25.79, p_near_longitude => -80.13) where id = pg_temp.id('opp_cg')),
  0, 'with no decimals');
select is((select scale(distance_km) from app.search_marketplace(p_near_latitude => 25.79, p_near_longitude => -80.13) where id = pg_temp.id('opp_open')),
  1, 'a listing with the flag off keeps one decimal');
select results_eq($$select client_hidden, venue_name from app.search_marketplace() where id = pg_temp.id('opp_hidden')$$,
  $$values (false, 'Northwind Pier Pavilion'::text)$$, 'the booked person''s search shows the venue');
select pg_temp.as_user('quinn');
select is((select count(*)::integer from app.search_marketplace() where id in (pg_temp.id('opp_hidden'), pg_temp.id('opp_cg'))), 0,
  'visibility is unchanged: a person not invited sees neither listing in Explore');
select pg_temp.as_platform();
select ok(obj_description('app.search_marketplace(text, app.external_role_type[], text, text, date, date, bigint, text, text, double precision, double precision, numeric, uuid, text, boolean, integer)'::regprocedure, 'pg_proc') is not null,
  'search_marketplace keeps its comment');
select ok(not has_function_privilege('anon', 'app.search_marketplace(text, app.external_role_type[], text, text, date, date, bigint, text, text, double precision, double precision, numeric, uuid, text, boolean, integer)', 'execute')
  and has_function_privilege('authenticated', 'app.search_marketplace(text, app.external_role_type[], text, text, date, date, bigint, text, text, double precision, double precision, numeric, uuid, text, boolean, integer)', 'execute')
  and has_function_privilege('service_role', 'app.search_marketplace(text, app.external_role_type[], text, text, date, date, bigint, text, text, double precision, double precision, numeric, uuid, text, boolean, integer)', 'execute'),
  'and its grants: signed-in callers and the service role, never anon');

-- The radius test, the location points and the places ------------------------------------------------------------------
-- A point 4 km from the exact Miami venue and about 8 km from its rounded point.
select ok(extensions.st_distance(v.location, extensions.st_setsrid(extensions.st_makepoint(-80.1918, 25.7257), 4326)::extensions.geography) < 5000
  and extensions.st_distance(private.coarse_point(v.location), extensions.st_setsrid(extensions.st_makepoint(-80.1918, 25.7257), 4326)::extensions.geography) > 5000,
  'the Miami test point is within 5 km of the venue and beyond 5 km of its rounded point')
from app.venues v where v.id = pg_temp.id('venue_a');
select is(private.listing_matches(pg_temp.id('opp_open'), null, null, null, null, null, null, null, null, null, null, null, 25.7257, -80.1918, 5, null),
  true, 'a listing with the flag off is tested against its exact venue');
select is(private.listing_matches(pg_temp.id('opp_hidden'), null, null, null, null, null, null, null, null, null, null, null, 25.7257, -80.1918, 5, null),
  false, 'a hidden listing is tested against its rounded point, so a tight radius cannot pin the venue');
select is(private.listing_matches(pg_temp.id('opp_hidden'), null, null, null, null, null, null, null, null, null, null, null, 25.7257, -80.1918, 10, null),
  true, 'and matches a radius that reaches the rounded point');

-- A point 49 km from the exact Coral Gables venue and more than 50 km from its rounded point.
select ok(extensions.st_distance(v.location, extensions.st_setsrid(extensions.st_makepoint(-79.876, 25.987), 4326)::extensions.geography) < 50000
  and extensions.st_distance(private.coarse_point(v.location), extensions.st_setsrid(extensions.st_makepoint(-79.876, 25.987), 4326)::extensions.geography) > 50000,
  'the Coral Gables test point is within 50 km of the venue and beyond 50 km of its rounded point')
from app.venues v where v.id = pg_temp.id('venue_cg');
select is((select location_points from private.recommendation_points(pg_temp.id('nina'), pg_temp.id('opp_cg'), 25.987, -79.876)), 10,
  'location points of a hidden listing are scored from the rounded point (10 beyond 50 km), not the exact venue (20)');
select pg_temp.as_user('nina');
select is((select location_points from app.search_marketplace(p_near_latitude => 25.987, p_near_longitude => -79.876) where id = pg_temp.id('opp_cg')), 10,
  'and Explore returns those points');
select results_eq($$select round(latitude::numeric, 6), round(longitude::numeric, 6), listing_count from app.marketplace_places() where label = 'Coral Gables'$$,
  $$values (25.7::numeric, -80.3::numeric, 1)$$,
  'a locality whose only located listing is hidden is placed at the rounded point');
select pg_temp.as_platform();
select ok(not has_function_privilege('anon', 'app.marketplace_places()', 'execute')
  and has_function_privilege('authenticated', 'app.marketplace_places()', 'execute'), 'marketplace_places keeps its grants');
select ok(not has_function_privilege('authenticated', 'private.recommendation_points(uuid, uuid, double precision, double precision)', 'execute')
  and not has_function_privilege('anon', 'private.coarse_point(extensions.geography)', 'execute'),
  'the scoring helper is not callable, and anon cannot call the rounding one');

select * from finish();
rollback;
