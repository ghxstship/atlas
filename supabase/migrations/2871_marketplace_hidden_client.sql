-- 2871_marketplace_hidden_client.sql
-- P10 (RRR-224), gap G-128, Section 4.4.3 Discovery: the external projections of a listing whose client and event are
-- hidden until booking (2870). Until private.opportunity_disclosed_to_me answers true, the venue name is NULL and the
-- venue point is rounded to 1 decimal (about 11 km); the locality, jurisdiction, dates, pay, org name and verified
-- badge stay. Every path that measures from the venue point uses the rounded point for a flagged listing, so
-- repeated searches cannot pin the venue:
--   * api_external.opportunities (latest 1020): appends client_hidden; the API's distance search reads this view
--   * app.search_marketplace (1460): appends client_hidden, so it is dropped and created again; a hidden row's
--     distance is measured from the rounded point, to whole kilometers
--   * private.listing_matches (1460): the radius test of Explore and of the saved-search matcher (1462)
--   * private.recommendation_points (1460): location points by distance from the place searched near
--   * app.marketplace_places (1460): a locality's mean point, which with one located listing is that venue's point
-- The radius test, the location points and the places use the rounded point whenever the flag is on, whoever reads:
-- the flag decides there, not disclosure, since the results are shared across readers' searches and alerts.
-- private.coarse_point is the one rounding rule. Each object starts from its latest definition.

create or replace function private.coarse_point(p_location extensions.geography)
returns extensions.geography
language sql
immutable
set search_path = ''
as $$
  select case when p_location is not null then
    extensions.st_setsrid(extensions.st_makepoint(
      round(extensions.st_x(p_location::extensions.geometry)::numeric, 1)::double precision,
      round(extensions.st_y(p_location::extensions.geometry)::numeric, 1)::double precision), 4326)::extensions.geography
  end;
$$;

comment on function private.coarse_point(extensions.geography) is 'A venue point with its longitude and latitude rounded to 1 decimal (about 11 km), the point a listing with its client and event hidden until booking shows and is measured from (2871). NULL stays NULL.';
-- The external view calls it as the reader, so signed-in callers hold execute; it reads nothing.
revoke all on function private.coarse_point(extensions.geography) from public, anon;
grant execute on function private.coarse_point(extensions.geography) to authenticated, service_role;

-- The external listing view (columns appended to the 1020 view) --------------------------------------------------------

create or replace view api_external.opportunities as
select op.id, op.org_id, o.name as org_name, op.title, op.description, op.role_type, op.role_code, op.cat_urid,
  case when h.client_hidden then null else v.name end as venue_name,
  op.jurisdiction_id, op.starts_on, op.ends_on, op.visibility, op.rate_type,
  op.pay_min_minor, op.pay_max_minor, op.currency_code, (op.rate_type is null) as rate_on_request,
  op.deadline_at, op.minimum_age, op.opportunity_state,
  (select count(*) from app.opportunity_positions pp where pp.opportunity_id = op.id and pp.deleted_at is null) as position_count,
  v.locality as venue_locality,
  private.organization_verified(op.org_id) as org_verified,
  extensions.st_y((case when h.client_hidden then private.coarse_point(v.location) else v.location end)::extensions.geometry) as venue_latitude,
  extensions.st_x((case when h.client_hidden then private.coarse_point(v.location) else v.location end)::extensions.geometry) as venue_longitude,
  h.client_hidden
from app.opportunities op
join app.organizations o on o.id = op.org_id
left join app.venues v on v.id = op.venue_id
cross join lateral (
  -- The disclosure check runs only for flagged listings.
  select case when op.hide_client_until_booked then not private.opportunity_disclosed_to_me(op.id) else false end as client_hidden
) h
where op.deleted_at is null
  and (op.id in (select private.visible_opportunity_ids())
    or op.id in (select a.opportunity_id from app.applications a where a.id in (select private.my_application_ids())));

comment on column api_external.opportunities.venue_name is 'Venue; NULL while client_hidden.';
comment on column api_external.opportunities.venue_latitude is 'Latitude of the venue in WGS 84 degrees, rounded to 1 decimal while client_hidden; NULL when the venue is not located, and then distance search leaves the listing out.';
comment on column api_external.opportunities.venue_longitude is 'Longitude of the venue in WGS 84 degrees, rounded to 1 decimal while client_hidden; NULL when the venue is not located.';
comment on column api_external.opportunities.client_hidden is 'True while the org hides the client and event until booking (2870) and the caller''s side holds no Accepted application on the listing: the venue name is NULL and the venue point is rounded to 1 decimal. The posting org stays named.';

-- The shared filter rule (from 1460) ----------------------------------------------------------------------------------

create or replace function private.listing_matches(
  p_opportunity_id uuid,
  p_query text,
  p_role_types app.external_role_type[],
  p_role_code text,
  p_disc_code text,
  p_cat_urid text,
  p_jurisdiction_id text,
  p_starts_after date,
  p_ends_before date,
  p_min_pay_minor bigint,
  p_currency_code text,
  p_certification_name text,
  p_near_latitude double precision,
  p_near_longitude double precision,
  p_radius_km numeric,
  p_org_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app.opportunities o
    left join app.venues v on v.id = o.venue_id
    left join app.projects pr on pr.id = o.project_id
    where o.id = p_opportunity_id
      and (p_org_id is null or o.org_id = p_org_id)
      and (nullif(btrim(p_query), '') is null
        or o.title ilike '%' || replace(replace(replace(btrim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        or o.description ilike '%' || replace(replace(replace(btrim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%')
      and (coalesce(cardinality(p_role_types), 0) = 0 or o.role_type = any (p_role_types))
      and (p_role_code is null or o.role_code = p_role_code)
      and (p_disc_code is null or left(o.cat_urid, 7) = p_disc_code)
      and (p_cat_urid is null or o.cat_urid = p_cat_urid)
      and (p_jurisdiction_id is null or p_jurisdiction_id in (
        select private.jurisdiction_chain(coalesce(o.jurisdiction_id, v.jurisdiction_id, pr.jurisdiction_id))))
      and (p_starts_after is null or o.starts_on >= p_starts_after)
      and (p_ends_before is null or o.ends_on <= p_ends_before)
      and (p_min_pay_minor is null or o.rate_type is null or o.rate_type = 'Bid'
        or ((p_currency_code is null or o.currency_code = p_currency_code)
          and (o.pay_max_minor >= p_min_pay_minor or o.pay_min_minor >= p_min_pay_minor)))
      and (nullif(btrim(p_certification_name), '') is null or exists (
        select 1 from app.opportunity_requirements rq
        left join app.certifications c on c.id = rq.certification_id
        where rq.opportunity_id = o.id and rq.deleted_at is null and rq.requirement_kind = 'Certification'
          and (c.name ilike '%' || btrim(p_certification_name) || '%' or rq.description ilike '%' || btrim(p_certification_name) || '%')))
      and (p_radius_km is null or (v.location is not null and p_near_latitude is not null and p_near_longitude is not null
        and extensions.st_dwithin(
          case when o.hide_client_until_booked then private.coarse_point(v.location) else v.location end,
          extensions.st_setsrid(extensions.st_makepoint(p_near_longitude, p_near_latitude), 4326)::extensions.geography,
          (p_radius_km * 1000)::double precision)))
  );
$$;

comment on function private.listing_matches(uuid, text, app.external_role_type[], text, text, text, text, date, date, bigint, text, text, double precision, double precision, numeric, uuid) is 'Section 4.4.3 discovery filters, the one rule Explore''s search (app.search_marketplace) and the saved-search matcher share: words in the title or description; role types; canon role; discipline (the category''s discipline) and category; jurisdiction, including those beneath it, read from the listing, its venue or its project; dates; lowest pay, where Rate on Request and bid listings stay in; a required certification by name; distance from a point, where a listing whose venue is not located never matches (PostGIS on app.venues.location) and a listing with its client hidden until booking is measured from its venue point rounded to 1 decimal (private.coarse_point, 2871); and the org of a white-label Gateway. NULL filters match everything. It decides only matching; visibility is private.opportunity_open_to_person.';
revoke all on function private.listing_matches(uuid, text, app.external_role_type[], text, text, text, text, date, date, bigint, text, text, double precision, double precision, numeric, uuid) from public, anon, authenticated;

-- Recommendation factors (from 1460) ------------------------------------------------------------------------------------

create or replace function private.recommendation_points(
  p_person_id uuid,
  p_opportunity_id uuid,
  p_near_latitude double precision default null,
  p_near_longitude double precision default null
)
returns table (
  skill_points integer,
  certification_points integer,
  location_points integer,
  availability_points integer,
  certifications_required integer,
  certifications_met integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_opp record;
  v_profile record;
  v_point extensions.geography;
  v_km double precision;
  v_from timestamptz;
  v_to timestamptz;
begin
  -- A listing with its client hidden until booking is scored from its rounded venue point (2871), so the sharp 50 and
  -- 150 km thresholds cannot trace the venue.
  select o.id, o.cat_urid, o.role_code, o.starts_on, o.ends_on,
    case when o.hide_client_until_booked then private.coarse_point(v.location) else v.location end as location,
    v.locality,
    coalesce(o.jurisdiction_id, v.jurisdiction_id, pr.jurisdiction_id) as jurisdiction_id,
    coalesce(v.time_zone, pr.time_zone) as time_zone
  into v_opp
  from app.opportunities o
  left join app.venues v on v.id = o.venue_id
  left join app.projects pr on pr.id = o.project_id
  where o.id = p_opportunity_id;
  if v_opp.id is null or p_person_id is null then
    return;
  end if;
  select p.city, p.country_code into v_profile from app.person_profiles p where p.person_id = p_person_id and p.deleted_at is null;

  -- Skills (40): the listing's category is one of the person's skills; 25 for the same discipline; 10 for the same
  -- department (a role-coded listing reads the department from its canon role code).
  skill_points := case
    when v_opp.cat_urid is not null and exists (select 1 from app.person_skills s
      where s.person_id = p_person_id and s.deleted_at is null and s.cat_urid = v_opp.cat_urid) then 40
    when v_opp.cat_urid is not null and exists (select 1 from app.person_skills s
      where s.person_id = p_person_id and s.deleted_at is null and left(s.cat_urid, 7) = left(v_opp.cat_urid, 7)) then 25
    when coalesce(left(v_opp.cat_urid, 4), left(v_opp.role_code, 4)) is not null and exists (select 1 from app.person_skills s
      where s.person_id = p_person_id and s.deleted_at is null
        and left(s.cat_urid, 4) = coalesce(left(v_opp.cat_urid, 4), left(v_opp.role_code, 4))) then 10
    else 0 end;

  -- Certifications (30): the share of certification requirements the person meets; a listing that requires none
  -- has nothing missing.
  select count(*)::integer, count(*) filter (where private.person_meets_certification(p_person_id, rq.certification_id))::integer
  into certifications_required, certifications_met
  from app.opportunity_requirements rq
  where rq.opportunity_id = p_opportunity_id and rq.deleted_at is null and rq.requirement_kind = 'Certification';
  certification_points := case when certifications_required = 0 then 30
    else round(30.0 * certifications_met / certifications_required)::integer end;

  -- Location (20): within 50 km of the place searched near (10 within 150 km); with no place, the venue is in the
  -- profile's city (20) or country (5).
  if p_near_latitude is not null and p_near_longitude is not null then
    v_point := extensions.st_setsrid(extensions.st_makepoint(p_near_longitude, p_near_latitude), 4326)::extensions.geography;
    v_km := case when v_opp.location is not null then extensions.st_distance(v_opp.location, v_point) / 1000 end;
    location_points := case when v_km is null then 0 when v_km <= 50 then 20 when v_km <= 150 then 10 else 0 end;
  else
    location_points := case
      when nullif(btrim(v_profile.city), '') is not null and lower(btrim(v_profile.city)) = lower(btrim(v_opp.locality)) then 20
      when v_profile.country_code is not null and v_opp.jurisdiction_id is not null
        and upper(left(v_opp.jurisdiction_id, 2)) = v_profile.country_code then 5
      else 0 end;
  end if;

  -- Availability (10): no Unavailable block of the person's overlaps the listing's dates, read on the venue's or the
  -- project's calendar; 5 when the listing has no dates.
  if v_opp.starts_on is null then
    availability_points := 5;
  else
    v_from := v_opp.starts_on::timestamp at time zone coalesce(v_opp.time_zone, 'UTC');
    v_to := (coalesce(v_opp.ends_on, v_opp.starts_on) + 1)::timestamp at time zone coalesce(v_opp.time_zone, 'UTC');
    availability_points := case when exists (
      select 1 from app.availability_blocks b
      join app.availability_calendars c on c.id = b.availability_calendar_id and c.deleted_at is null
      where c.person_id = p_person_id and b.deleted_at is null and b.availability_kind = 'Unavailable'
        and b.starts_at < v_to and b.ends_at > v_from) then 0 else 10 end;
  end if;
  return next;
end;
$$;

comment on function private.recommendation_points(uuid, uuid, double precision, double precision) is 'The recommendation factors of one listing for one person (Section 4.4.3: profile skills, certifications, location and availability), as Gateway''s How ranking works page lists them: skills up to 40, certifications up to 30, location up to 20 and availability up to 10. A listing with its client hidden until booking is scored for location from its venue point rounded to 1 decimal (2871). Reads only the person''s own profile; nothing an org pays for enters it.';
revoke all on function private.recommendation_points(uuid, uuid, double precision, double precision) from public, anon, authenticated;

-- The marketplace RPC (from 1460, with client_hidden appended) -----------------------------------------------------------

drop function app.search_marketplace(text, app.external_role_type[], text, text, date, date, bigint, text, text, double precision, double precision, numeric, uuid, text, boolean, integer);

create function app.search_marketplace(
  p_query text default null,
  p_role_types app.external_role_type[] default null,
  p_disc_code text default null,
  p_cat_urid text default null,
  p_starts_after date default null,
  p_ends_before date default null,
  p_min_pay_minor bigint default null,
  p_currency_code text default null,
  p_certification_name text default null,
  p_near_latitude double precision default null,
  p_near_longitude double precision default null,
  p_radius_km numeric default null,
  p_org_id uuid default null,
  p_sort text default 'recommended',
  p_include_passed boolean default false,
  p_limit integer default 100
)
returns table (
  id uuid,
  org_id uuid,
  org_name text,
  org_verified boolean,
  title text,
  description text,
  role_type app.external_role_type,
  role_code text,
  cat_urid text,
  venue_name text,
  venue_locality text,
  venue_latitude double precision,
  venue_longitude double precision,
  jurisdiction_id text,
  starts_on date,
  ends_on date,
  visibility app.opportunity_visibility,
  rate_type app.rate_type,
  pay_min_minor bigint,
  pay_max_minor bigint,
  currency_code text,
  rate_on_request boolean,
  deadline_at timestamptz,
  minimum_age smallint,
  opportunity_state app.opportunity_state,
  position_count integer,
  distance_km numeric,
  recommendation_score integer,
  skill_points integer,
  certification_points integer,
  location_points integer,
  availability_points integer,
  certifications_required integer,
  certifications_met integer,
  is_saved boolean,
  is_passed boolean,
  client_hidden boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me uuid := private.current_person_id();
  v_point extensions.geography;
begin
  if v_me is null then
    return;
  end if;
  if p_sort not in ('recommended', 'soonest') then
    perform private.refuse('marketplace_sort_unknown', 'Sort by recommended or soonest.');
  end if;
  if p_radius_km is not null and (p_near_latitude is null or p_near_longitude is null) then
    perform private.refuse('marketplace_radius_needs_near', 'A search radius needs a place to measure from.');
  end if;
  if (p_near_latitude is not null and abs(p_near_latitude) > 90) or (p_near_longitude is not null and abs(p_near_longitude) > 180) then
    perform private.refuse('marketplace_near_out_of_range', 'The place needs a latitude from -90 to 90 and a longitude from -180 to 180.');
  end if;
  if p_near_latitude is not null and p_near_longitude is not null then
    v_point := extensions.st_setsrid(extensions.st_makepoint(p_near_longitude, p_near_latitude), 4326)::extensions.geography;
  end if;
  return query
  with open_listings as (
    select o.* from app.opportunities o
    where o.deleted_at is null and o.opportunity_state = 'Published'
      and private.opportunity_open_to_person(o.id, o.org_id, o.visibility, o.opportunity_state, v_me)
      and private.listing_matches(o.id, p_query, p_role_types, null, p_disc_code, p_cat_urid, null, p_starts_after, p_ends_before,
        p_min_pay_minor, p_currency_code, p_certification_name, p_near_latitude, p_near_longitude, p_radius_km, p_org_id)
  ),
  masked as (
    -- The disclosure check runs only for flagged listings; a hidden listing shows and is measured from its rounded point.
    select o.*, h.hidden,
      case when h.hidden then private.coarse_point(v.location) else v.location end as shown_location,
      case when h.hidden then null else v.name end as shown_venue_name, v.locality as shown_locality
    from open_listings o
    left join app.venues v on v.id = o.venue_id
    cross join lateral (
      select case when o.hide_client_until_booked then not private.opportunity_disclosed_to_me(o.id) else false end as hidden
    ) h
  ),
  scored as (
    select o.*, og.name as org_name,
      extensions.st_y(o.shown_location::extensions.geometry) as venue_latitude,
      extensions.st_x(o.shown_location::extensions.geometry) as venue_longitude,
      case when v_point is not null and o.shown_location is not null
        then round((extensions.st_distance(o.shown_location, v_point) / 1000)::numeric, case when o.hidden then 0 else 1 end) end as distance_km,
      rp.skill_points, rp.certification_points, rp.location_points, rp.availability_points,
      rp.certifications_required, rp.certifications_met,
      exists (select 1 from app.saved_opportunities so where so.person_id = v_me and so.opportunity_id = o.id and so.deleted_at is null) as is_saved,
      exists (select 1 from app.passed_opportunities po where po.person_id = v_me and po.opportunity_id = o.id and po.deleted_at is null) as is_passed
    from masked o
    join app.organizations og on og.id = o.org_id
    cross join lateral private.recommendation_points(v_me, o.id, p_near_latitude, p_near_longitude) rp
  )
  select s.id, s.org_id, s.org_name, private.organization_verified(s.org_id), s.title, s.description, s.role_type, s.role_code,
    s.cat_urid, s.shown_venue_name, s.shown_locality, s.venue_latitude, s.venue_longitude, s.jurisdiction_id, s.starts_on, s.ends_on,
    s.visibility, s.rate_type, s.pay_min_minor, s.pay_max_minor, s.currency_code::text, (s.rate_type is null), s.deadline_at,
    s.minimum_age, s.opportunity_state,
    (select count(*)::integer from app.opportunity_positions pp where pp.opportunity_id = s.id and pp.deleted_at is null),
    s.distance_km,
    (s.skill_points + s.certification_points + s.location_points + s.availability_points),
    s.skill_points, s.certification_points, s.location_points, s.availability_points, s.certifications_required,
    s.certifications_met, s.is_saved, s.is_passed, s.hidden
  from scored s
  where p_include_passed or not s.is_passed
  order by
    case when p_sort = 'recommended' then s.skill_points + s.certification_points + s.location_points + s.availability_points end desc nulls last,
    s.deadline_at asc nulls last, s.starts_on asc nulls last, s.id
  limit least(greatest(coalesce(p_limit, 100), 1), 200);
end;
$$;

comment on function app.search_marketplace(text, app.external_role_type[], text, text, date, date, bigint, text, text, double precision, double precision, numeric, uuid, text, boolean, integer) is 'The Gateway marketplace search (Section 4.4.3 Discovery, A65-008): Published listings open to the caller (private.opportunity_open_to_person with the org''s marketplace visibility cap, 1327), filtered by private.listing_matches, without the listings the caller passed on unless asked. Recommended order is the recommendation score (private.recommendation_points: skills 40, certifications 30, location 20, availability 10, from the caller''s own profile; nothing paid for), then the deadline and the start date; soonest order is the deadline, then the start date. Distance is from the place searched near, in kilometers. A listing with its client and event hidden until booking (client_hidden, 2871) has no venue name, its venue point rounded to 1 decimal, and its distance measured from that point to whole kilometers. At most 200 rows.';

-- Places to search near (from 1460) --------------------------------------------------------------------------------------

create or replace function app.marketplace_places()
returns table (label text, latitude double precision, longitude double precision, listing_count integer)
language sql
stable
security definer
set search_path = ''
as $$
  select min(btrim(v.locality)), avg(extensions.st_y(p.location::extensions.geometry)), avg(extensions.st_x(p.location::extensions.geometry)),
    count(*)::integer
  from app.opportunities o
  join app.venues v on v.id = o.venue_id
  -- A listing with its client hidden until booking adds its rounded point (2871): with one located listing in a
  -- locality, the mean is that listing's point.
  cross join lateral (
    select case when o.hide_client_until_booked then private.coarse_point(v.location) else v.location end as location
  ) p
  where private.current_person_id() is not null
    and o.deleted_at is null and o.opportunity_state = 'Published' and v.location is not null
    and nullif(btrim(v.locality), '') is not null
    and private.opportunity_open_to_person(o.id, o.org_id, o.visibility, o.opportunity_state, private.current_person_id())
  group by lower(btrim(v.locality))
  order by count(*) desc, min(btrim(v.locality))
  limit 50;
$$;

comment on function app.marketplace_places() is 'Places to search near (Section 4.4.3 distance): the localities of located venues among the listings open to the caller, each at the mean of its venues'' coordinates, where a listing with its client hidden until booking adds its point rounded to 1 decimal (2871), busiest first, at most 50. Only the place name and a point leave the database, never a venue address.';

-- Privileges ----------------------------------------------------------------------------------------------------------------

revoke all on function app.search_marketplace(text, app.external_role_type[], text, text, date, date, bigint, text, text, double precision, double precision, numeric, uuid, text, boolean, integer) from public, anon;
grant execute on function app.search_marketplace(text, app.external_role_type[], text, text, date, date, bigint, text, text, double precision, double precision, numeric, uuid, text, boolean, integer) to authenticated, service_role;
revoke all on function app.marketplace_places() from public, anon;
grant execute on function app.marketplace_places() to authenticated, service_role;
