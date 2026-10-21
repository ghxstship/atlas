-- 1460_marketplace_discovery.sql
-- A89 (RRR-134), findings A65-008 and A65-031, work package WP8: marketplace discovery and recommendations
-- (Section 4.4.3 Discovery, Section 11.12 Discover).
--   * the missing discovery filters: discipline and category, distance from a place, and required certifications,
--     on app.saved_searches too, so an alert matches exactly what Explore showed. Distance uses PostGIS, which the
--     venues already use (app.venues.location, 0420, with its GiST index): earthdistance is not installed and would
--     restate the point as a cube
--   * app.passed_opportunities: a person passes on a listing (swipe left on a phone, or the Pass button), which hides
--     it from Explore until they undo it. The org never sees who passed
--   * private.listing_matches: the one filter rule Explore's search and the saved-search matcher (1462) share
--   * app.search_marketplace: the marketplace RPC. Only listings open to the caller (private.opportunity_open_to_person,
--     with A76's gateway.marketplace_visibility cap from 1327); it never widens who sees a listing. Each row carries a
--     recommendation score from 0 to 100 built from the caller's own profile: skills (40), certifications (30),
--     location (20) and availability (10), listed on Gateway's public "How ranking works" page. No placement can be
--     bought: nothing an org pays for enters the score
--   * app.marketplace_places: the localities of located venues among the listings open to the caller, to search near
--   * private.person_today: today on the person's own calendar (their personal locale.time_zone), the SQL twin of
--     Gateway's personToday

-- Calendars and keys -------------------------------------------------------------------------------------------------

create or replace function private.person_time_zone(p_person_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select pv.value_text from app.personal_setting_values pv
  where pv.person_id = p_person_id and pv.org_id is null and pv.setting_key = 'locale.time_zone' and pv.deleted_at is null
  order by pv.updated_at desc limit 1;
$$;

comment on function private.person_time_zone(uuid) is 'The person''s own time zone: their personal locale.time_zone setting kept for no org; NULL when they never chose one.';
revoke all on function private.person_time_zone(uuid) from public, anon, authenticated;

create or replace function private.person_today(p_person_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select private.zone_today(private.person_time_zone(p_person_id));
$$;

comment on function private.person_today(uuid) is 'Today on the person''s own calendar (private.person_time_zone), UTC until they choose a zone, as Gateway''s personToday. Personal items (profile certifications, a passport) count days on it (A89).';
revoke all on function private.person_today(uuid) from public, anon, authenticated;

create or replace function private.gateway_display_key(p_prefix text, p_id uuid)
returns text
language sql
immutable
set search_path = ''
as $$
  select p_prefix || '-' || string_agg(
    substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', substring(s.b from g.i * 5 + 1 for 5)::integer + 1, 1), '' order by g.i)
  from (select (B'00' || ('x' || replace(p_id::text, '-', ''))::bit(128)) as b) s
  cross join generate_series(0, 25) as g (i);
$$;

comment on function private.gateway_display_key(text, uuid) is 'A Gateway display key, the prefix and the row id in 26 Crockford base 32 characters (ADR 0006 item 13), exactly as toDisplayKey in @xos/data/gateway-keys. Notifications use it for the gatewayPath of a listing or an engagement.';
revoke all on function private.gateway_display_key(text, uuid) from public, anon;
grant execute on function private.gateway_display_key(text, uuid) to authenticated, service_role;

-- Saved search filters ----------------------------------------------------------------------------------------------

alter table app.saved_searches
  add column query_text text,
  add column disc_code text references xpms.dim_discipline (disc_code),
  add column certification_name text,
  add column near_label text,
  add column near_latitude double precision,
  add column near_longitude double precision,
  add column radius_km numeric(6, 1),
  add constraint saved_searches_query_text_length check (query_text is null or char_length(btrim(query_text)) between 1 and 200),
  add constraint saved_searches_certification_name_length check (certification_name is null or char_length(btrim(certification_name)) between 1 and 200),
  add constraint saved_searches_near_label_length check (near_label is null or char_length(btrim(near_label)) between 1 and 200),
  add constraint saved_searches_near check (
    (near_latitude is null and near_longitude is null and radius_km is null and near_label is null)
    or (near_latitude between -90 and 90 and near_longitude between -180 and 180 and radius_km > 0 and radius_km <= 500));

create index saved_searches_disc_code_idx on app.saved_searches (disc_code);

comment on column app.saved_searches.query_text is 'Words matched against the listing title and description; NULL matches every listing.';
comment on column app.saved_searches.disc_code is 'Canon discipline filter: listings whose category belongs to this discipline (A89).';
comment on column app.saved_searches.certification_name is 'Required certification filter: listings with a certification requirement of this name, ignoring case (A89).';
comment on column app.saved_searches.near_label is 'Name of the place the distance filter measures from, as the person chose it.';
comment on column app.saved_searches.near_latitude is 'Latitude in WGS 84 degrees of the place the distance filter measures from.';
comment on column app.saved_searches.near_longitude is 'Longitude in WGS 84 degrees of the place the distance filter measures from.';
comment on column app.saved_searches.radius_km is 'Distance filter radius in kilometers, up to 500; a listing whose venue is not located never matches it.';

create or replace view api_external.my_saved_searches as
select s.id, s.org_id, s.name, s.role_type, s.role_code, s.cat_urid, s.jurisdiction_id, s.starts_after, s.ends_before,
  s.min_rate_minor, s.currency_code, s.alerts_enabled, s.created_at,
  s.query_text, s.disc_code, s.certification_name, s.near_label, s.near_latitude, s.near_longitude, s.radius_km
from app.saved_searches s
where s.deleted_at is null and s.person_id = private.current_person_id();

comment on column api_external.my_saved_searches.query_text is 'Words filter.';
comment on column api_external.my_saved_searches.disc_code is 'Canon discipline filter.';
comment on column api_external.my_saved_searches.certification_name is 'Required certification filter.';
comment on column api_external.my_saved_searches.near_label is 'Place the distance filter measures from.';
comment on column api_external.my_saved_searches.near_latitude is 'Latitude of that place.';
comment on column api_external.my_saved_searches.near_longitude is 'Longitude of that place.';
comment on column api_external.my_saved_searches.radius_km is 'Distance filter radius in kilometers.';

-- Passed opportunities ------------------------------------------------------------------------------------------------

create table app.passed_opportunities (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  opportunity_id uuid not null references app.opportunities (id),
  person_id uuid not null references app.people (id),
  passed_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index passed_opportunities_opportunity_id_idx on app.passed_opportunities (opportunity_id);
create index passed_opportunities_person_id_idx on app.passed_opportunities (person_id, passed_at);
create unique index passed_opportunities_key on app.passed_opportunities (person_id, opportunity_id) where deleted_at is null;

call private.install_domain_table('app.passed_opportunities', 'app.opportunities', 'opportunity_id');
call private.describe('app.passed_opportunities', 'Listings a Gateway user passed on (Section 11.12 Discover: swipe left to pass, with a Pass button for both). A passed listing leaves Explore and alerts until the person undoes the pass by soft delete. Owned by the person; the org never sees who passed.', array[
  'org_id', 'Org of the passed opportunity, derived from it.',
  'opportunity_id', 'Opportunity passed on, open to the person when they passed.',
  'person_id', 'Person who passed, set from the session.',
  'passed_at', 'When they passed, set by the database.'
]);

create or replace function private.guard_passed_opportunity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opp app.opportunities;
begin
  if tg_op = 'UPDATE' then
    if new.opportunity_id <> old.opportunity_id or new.person_id <> old.person_id or new.passed_at <> old.passed_at then
      perform private.refuse('passed_opportunity_immutable', 'A pass keeps its opportunity and person.');
    end if;
    return new;
  end if;
  new.passed_at := now();
  if auth.uid() is null then
    return new;
  end if;
  new.person_id := private.require_person();
  select o.* into v_opp from app.opportunities o where o.id = new.opportunity_id and o.deleted_at is null;
  if v_opp.id is null or not private.opportunity_open_to(v_opp.id, v_opp.org_id, v_opp.visibility, v_opp.opportunity_state) then
    perform private.refuse('opportunity_not_available', 'This opportunity is not open to you.');
  end if;
  return new;
end;
$$;

comment on function private.guard_passed_opportunity() is 'Passed opportunities: the person from the session, only listings open to them (an unseen listing and a Do Not Engage flag refuse alike, as saving does), and the opportunity and person never change.';
revoke all on function private.guard_passed_opportunity() from public, anon, authenticated;

create trigger t40_guard_passed_opportunity before insert or update on app.passed_opportunities
  for each row execute function private.guard_passed_opportunity();

call private.install_policies('app.passed_opportunities',
  $$person_id = (select private.current_person_id())$$,
  $$person_id = (select private.current_person_id())$$);

revoke insert, update on app.passed_opportunities from authenticated;
grant insert (opportunity_id), update (deleted_at) on app.passed_opportunities to authenticated;

call private.install_default_retention('app.passed_opportunities', interval '1 year');

-- The shared filter rule ------------------------------------------------------------------------------------------------

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
        and extensions.st_dwithin(v.location,
          extensions.st_setsrid(extensions.st_makepoint(p_near_longitude, p_near_latitude), 4326)::extensions.geography,
          (p_radius_km * 1000)::double precision)))
  );
$$;

comment on function private.listing_matches(uuid, text, app.external_role_type[], text, text, text, text, date, date, bigint, text, text, double precision, double precision, numeric, uuid) is 'Section 4.4.3 discovery filters, the one rule Explore''s search (app.search_marketplace) and the saved-search matcher share: words in the title or description; role types; canon role; discipline (the category''s discipline) and category; jurisdiction, including those beneath it, read from the listing, its venue or its project; dates; lowest pay, where Rate on Request and bid listings stay in; a required certification by name; distance from a point, where a listing whose venue is not located never matches (PostGIS on app.venues.location); and the org of a white-label Gateway. NULL filters match everything. It decides only matching; visibility is private.opportunity_open_to_person.';
revoke all on function private.listing_matches(uuid, text, app.external_role_type[], text, text, text, text, date, date, bigint, text, text, double precision, double precision, numeric, uuid) from public, anon, authenticated;

-- Recommendation factors --------------------------------------------------------------------------------------------------

create or replace function private.person_meets_certification(p_person_id uuid, p_certification_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_certification_id is not null and (
    exists (
      select 1 from app.certification_holders h
      where h.certification_id = p_certification_id and h.person_id = p_person_id and h.deleted_at is null
        and (h.expires_on is null or h.expires_on >= private.org_today(h.org_id)))
    or exists (
      select 1 from app.person_certifications pc
      join app.certifications c on c.id = p_certification_id
      where pc.person_id = p_person_id and pc.deleted_at is null and lower(btrim(pc.name)) = lower(btrim(c.name))
        and (pc.expires_on is null or pc.expires_on >= private.person_today(p_person_id))));
$$;

comment on function private.person_meets_certification(uuid, uuid) is 'For ranking only: true when the person holds the certification on a current org record (counted on that org''s calendar), or lists a current certification of the same name on their profile (counted on their own calendar). The org still verifies it during onboarding; the requirements check on a listing reads only verified records.';
revoke all on function private.person_meets_certification(uuid, uuid) from public, anon, authenticated;

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
  select o.id, o.cat_urid, o.role_code, o.starts_on, o.ends_on, v.location, v.locality,
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

comment on function private.recommendation_points(uuid, uuid, double precision, double precision) is 'The recommendation factors of one listing for one person (Section 4.4.3: profile skills, certifications, location and availability), as Gateway''s How ranking works page lists them: skills up to 40, certifications up to 30, location up to 20 and availability up to 10. Reads only the person''s own profile; nothing an org pays for enters it.';
revoke all on function private.recommendation_points(uuid, uuid, double precision, double precision) from public, anon, authenticated;

-- The marketplace RPC ---------------------------------------------------------------------------------------------------------

create or replace function app.search_marketplace(
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
  is_passed boolean
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
  scored as (
    select o.*, og.name as org_name, v.name as venue_name, v.locality as venue_locality,
      extensions.st_y(v.location::extensions.geometry) as venue_latitude,
      extensions.st_x(v.location::extensions.geometry) as venue_longitude,
      case when v_point is not null and v.location is not null
        then round((extensions.st_distance(v.location, v_point) / 1000)::numeric, 1) end as distance_km,
      rp.skill_points, rp.certification_points, rp.location_points, rp.availability_points,
      rp.certifications_required, rp.certifications_met,
      exists (select 1 from app.saved_opportunities so where so.person_id = v_me and so.opportunity_id = o.id and so.deleted_at is null) as is_saved,
      exists (select 1 from app.passed_opportunities po where po.person_id = v_me and po.opportunity_id = o.id and po.deleted_at is null) as is_passed
    from open_listings o
    join app.organizations og on og.id = o.org_id
    left join app.venues v on v.id = o.venue_id
    cross join lateral private.recommendation_points(v_me, o.id, p_near_latitude, p_near_longitude) rp
  )
  select s.id, s.org_id, s.org_name, private.organization_verified(s.org_id), s.title, s.description, s.role_type, s.role_code,
    s.cat_urid, s.venue_name, s.venue_locality, s.venue_latitude, s.venue_longitude, s.jurisdiction_id, s.starts_on, s.ends_on,
    s.visibility, s.rate_type, s.pay_min_minor, s.pay_max_minor, s.currency_code::text, (s.rate_type is null), s.deadline_at,
    s.minimum_age, s.opportunity_state,
    (select count(*)::integer from app.opportunity_positions pp where pp.opportunity_id = s.id and pp.deleted_at is null),
    s.distance_km,
    (s.skill_points + s.certification_points + s.location_points + s.availability_points),
    s.skill_points, s.certification_points, s.location_points, s.availability_points, s.certifications_required,
    s.certifications_met, s.is_saved, s.is_passed
  from scored s
  where p_include_passed or not s.is_passed
  order by
    case when p_sort = 'recommended' then s.skill_points + s.certification_points + s.location_points + s.availability_points end desc nulls last,
    s.deadline_at asc nulls last, s.starts_on asc nulls last, s.id
  limit least(greatest(coalesce(p_limit, 100), 1), 200);
end;
$$;

comment on function app.search_marketplace(text, app.external_role_type[], text, text, date, date, bigint, text, text, double precision, double precision, numeric, uuid, text, boolean, integer) is 'The Gateway marketplace search (Section 4.4.3 Discovery, A65-008): Published listings open to the caller (private.opportunity_open_to_person with the org''s marketplace visibility cap, 1327), filtered by private.listing_matches, without the listings the caller passed on unless asked. Recommended order is the recommendation score (private.recommendation_points: skills 40, certifications 30, location 20, availability 10, from the caller''s own profile; nothing paid for), then the deadline and the start date; soonest order is the deadline, then the start date. Distance is from the place searched near, in kilometers. At most 200 rows.';

create or replace function app.marketplace_places()
returns table (label text, latitude double precision, longitude double precision, listing_count integer)
language sql
stable
security definer
set search_path = ''
as $$
  select min(btrim(v.locality)), avg(extensions.st_y(v.location::extensions.geometry)), avg(extensions.st_x(v.location::extensions.geometry)),
    count(*)::integer
  from app.opportunities o
  join app.venues v on v.id = o.venue_id
  where private.current_person_id() is not null
    and o.deleted_at is null and o.opportunity_state = 'Published' and v.location is not null
    and nullif(btrim(v.locality), '') is not null
    and private.opportunity_open_to_person(o.id, o.org_id, o.visibility, o.opportunity_state, private.current_person_id())
  group by lower(btrim(v.locality))
  order by count(*) desc, min(btrim(v.locality))
  limit 50;
$$;

comment on function app.marketplace_places() is 'Places to search near (Section 4.4.3 distance): the localities of located venues among the listings open to the caller, each at the mean of its venues'' coordinates, busiest first, at most 50. Only the place name and a point leave the database, never a venue address.';

-- Account deletion --------------------------------------------------------------------------------------------------------------

create or replace function private.erase_passed_opportunities()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from app.passed_opportunities where person_id = new.id;
  return null;
end;
$$;

comment on function private.erase_passed_opportunities() is 'After a person is deleted (account deletion, 1112): deletes the listings they passed on.';
revoke all on function private.erase_passed_opportunities() from public, anon, authenticated;

create trigger t61_erase_passed_opportunities after update of deleted_at on app.people
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.erase_passed_opportunities();

-- Privileges ----------------------------------------------------------------------------------------------------------------------

revoke all on function app.search_marketplace(text, app.external_role_type[], text, text, date, date, bigint, text, text, double precision, double precision, numeric, uuid, text, boolean, integer) from public, anon;
grant execute on function app.search_marketplace(text, app.external_role_type[], text, text, date, date, bigint, text, text, double precision, double precision, numeric, uuid, text, boolean, integer) to authenticated, service_role;
revoke all on function app.marketplace_places() from public, anon;
grant execute on function app.marketplace_places() to authenticated, service_role;
