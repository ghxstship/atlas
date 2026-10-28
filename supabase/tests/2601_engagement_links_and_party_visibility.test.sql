-- pgTAP: migration 2601 (R1), badges under an engagement and the party visibility of the external views.
-- A badge issued under a Crew or Vendor engagement is held by its person; an Artist engagement carries party badges
-- for anyone; a Complete engagement takes no badge. For a vendor-supplied person (sam, supplied by Bayside Audio),
-- badges, travel, lodging, hospitality lines and per diems read for the person, the account's Owner and Admin, and
-- never for an Account Member or Account Finance; the artist's Advance representative reads the party badges; an
-- unrelated person reads nothing. Each recreated view keeps its columns in the same order.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.columns_of(p_view text) returns text[]
language sql stable as $$
  select array_agg(column_name::text order by ordinal_position) from information_schema.columns
  where table_schema = 'api_external' and table_name = p_view;
$$;

-- The account's Admin and a second Account Member who is not the supplied person.
select pg_temp.new_user('ada', 'ada@bayside-audio.test', 'Ada Brennan');
select pg_temp.new_user('mo', 'mo@bayside-audio.test', 'Mo Lindqvist');
select pg_temp.as_user('victor');
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id('ada'), 'Account Admin');
select app.add_account_member(pg_temp.id('acct_v'), pg_temp.id('mo'), 'Account Member');
select pg_temp.as_platform();

select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');

select pg_temp.as_user('alice');
with x as (insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('quinn'), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-05-01')
  returning id) insert into world select 'eng_quinn_done', id from x;
with c as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'CREW', 'Crew') returning id)
  insert into world select 'cat', id from c;
with c as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'ARTIST', 'Artist Party') returning id)
  insert into world select 'cat_artist', id from c;
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_quinn_done', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_quinn_done', 'Active', 'Closing');
select pg_temp.move_engagement('eng_quinn_done', 'Closing', 'Complete');

-- Badges under an engagement -----------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok(format($$insert into app.credentials (credential_category_id, holder_person_id, engagement_id) values (%L, %L, %L)$$,
    pg_temp.id('cat'), pg_temp.id('sam'), pg_temp.id('eng_ivy_a')),
  'XR001', 'credential_engagement_holder: A badge issued under an engagement is held by the person it names; only an artist''s engagement carries party badges.',
  'a Crew engagement''s badge is not held by someone else');
select lives_ok(format($$insert into app.credentials (credential_category_id, holder_person_id, engagement_id) values (%L, %L, %L)$$,
    pg_temp.id('cat_artist'), pg_temp.id('nina'), pg_temp.id('eng_art_a')),
  'an Artist engagement carries a party badge for another holder');
select throws_ok(format($$insert into app.credentials (credential_category_id, holder_person_id, engagement_id) values (%L, %L, %L)$$,
    pg_temp.id('cat'), pg_temp.id('quinn'), pg_temp.id('eng_quinn_done')),
  'XR001', 'credential_engagement_closed: A badge is issued under an engagement that is still open.', 'a Complete engagement takes no badge');
select lives_ok(format($$insert into app.credentials (credential_category_id, holder_person_id, engagement_id) values (%L, %L, %L)$$,
    pg_temp.id('cat'), pg_temp.id('sam'), pg_temp.id('eng_vendor_a')),
  'a vendor engagement''s badge is held by the person it names');
select throws_ok(format($$update app.credentials set holder_person_id = %L where engagement_id = %L$$, pg_temp.id('ivy'), pg_temp.id('eng_vendor_a')),
  'XR001', null, 'changing the holder is checked too');
select lives_ok(format($$insert into app.credentials (credential_category_id, holder_person_id) values (%L, %L)$$, pg_temp.id('cat'), pg_temp.id('ivy')),
  'a badge without an engagement is unchanged');
select pg_temp.as_platform();

-- Fixture for the vendor-supplied person ----------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into app.travel_segments (project_id, person_id, engagement_id, travel_mode, operator_name, service_identifier, confirmation_identifier,
  departs_from, departs_at, departs_time_zone, arrives_at_place, arrives_at, arrives_time_zone)
values (pg_temp.id('prj_a'), pg_temp.id('sam'), pg_temp.id('eng_vendor_a'), 'Flight', 'Fictional Air', 'FA 310', 'BAY310',
  'Newark', '2027-05-31 13:00+00', 'America/New_York', 'Miami', '2027-05-31 16:05+00', 'America/New_York');
with b as (insert into app.accommodation_blocks (project_id, title, check_in_on, check_out_on, rooms_held, nightly_rate_minor, currency_code)
  values (pg_temp.id('prj_a'), 'Harbor Inn Vendor Block', '2027-05-31', '2027-06-04', 2, 18900, 'USD') returning id)
  insert into world select 'block', id from b;
insert into app.accommodation_assignments (accommodation_block_id, person_id, check_in_on, check_out_on)
values (pg_temp.id('block'), pg_temp.id('sam'), '2027-05-31', '2027-06-03');
with f as (insert into app.fulfillments (project_id, fulfillment_kind, title, starts_at, ends_at)
  values (pg_temp.id('prj_a'), 'Catering', 'Load-In Lunch', '2027-06-01 16:00+00', '2027-06-01 17:00+00') returning id)
  insert into world select 'lunch', id from f;
insert into app.fulfillment_lines (fulfillment_id, description, person_id) values (pg_temp.id('lunch'), 'Vegetarian plate', pg_temp.id('sam'));
insert into app.per_diems (project_id, engagement_id, day, amount_minor, currency_code)
values (pg_temp.id('prj_a'), pg_temp.id('eng_vendor_a'), '2027-06-01', 6500, 'USD');
select pg_temp.as_platform();

-- Visibility matrix ----------------------------------------------------------------------------------------------------------------
create temporary table matrix (view_name text, filter text);
insert into matrix values
  ('credentials', 'holder_person_id'), ('travel', null), ('lodging', 'person_id'), ('hospitality', 'person_id'), ('per_diems', null);
grant select on matrix to public;

create function pg_temp.reads(p_who text, p_view text) returns integer
language plpgsql as $$
begin
  if p_view in ('travel', 'per_diems') then
    return pg_temp.n(p_who, format('select 1 from api_external.%I where engagement_id = %L', p_view, pg_temp.id('eng_vendor_a')));
  end if;
  return pg_temp.n(p_who, format('select 1 from api_external.%I where %I = %L', p_view,
    case p_view when 'credentials' then 'holder_person_id' else 'person_id' end, pg_temp.id('sam')));
end $$;

select is(pg_temp.reads('sam', m.view_name), 1, 'the supplied person reads their own ' || m.view_name) from matrix m;
select is(pg_temp.reads('victor', m.view_name), 1, 'the Account Owner reads ' || m.view_name || ' of the person the account supplies') from matrix m;
select is(pg_temp.reads('ada', m.view_name), 1, 'the Account Admin reads ' || m.view_name) from matrix m;
select is(pg_temp.reads('mo', m.view_name), 0, 'an Account Member does not read another person''s ' || m.view_name) from matrix m;
select is(pg_temp.reads('fiona', m.view_name), 0, 'Account Finance does not read ' || m.view_name) from matrix m;
select is(pg_temp.reads('ivy', m.view_name), 0, 'an unrelated person reads none of ' || m.view_name) from matrix m;
select is(pg_temp.reads('xavier', m.view_name), 0, 'another tenant reads none of ' || m.view_name) from matrix m;

select is(pg_temp.n('rita', format('select 1 from api_external.credentials where engagement_id = %L', pg_temp.id('eng_art_a'))), 1,
  'the Advance representative reads the artist''s party badges');
select is(pg_temp.n('art', format('select 1 from api_external.credentials where engagement_id = %L', pg_temp.id('eng_art_a'))), 1,
  'and so does the artist');
select is(pg_temp.n('victor', format('select 1 from api_external.credentials where engagement_id = %L', pg_temp.id('eng_art_a'))), 0,
  'a vendor account does not read another engagement''s party badges');
select is(pg_temp.n('ivy', 'select 1 from api_external.credentials'), 1, 'a crew member reads only their own badge');
select is(pg_temp.n('sam', 'select 1 from api_external.credentials'), 1, 'the supplied person reads only their own badge');

-- The time box still applies -------------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_vendor_a', 'Active', 'Closing');
select is(pg_temp.reads('victor', 'lodging'), 1, 'Closing keeps the operational area open');
select pg_temp.move_engagement('eng_vendor_a', 'Closing', 'Complete');
select is(pg_temp.reads('victor', m.view_name), 0, 'Complete closes ' || m.view_name || ' for the Owner') from matrix m;
select is(pg_temp.reads('sam', m.view_name), 0, 'and for the person') from matrix m;

-- Columns keep their order ----------------------------------------------------------------------------------------------------------
select is(pg_temp.columns_of('credentials'), array['id', 'project_id', 'project_name', 'category_code', 'category_name', 'holder_person_id',
  'holder_name', 'credential_number', 'valid_from', 'valid_to', 'revoked_at', 'engagement_id'], 'credentials keeps its columns in order');
select is(pg_temp.columns_of('lodging'), array['id', 'project_id', 'project_name', 'block_title', 'hotel_name', 'person_id', 'guest_name',
  'check_in_on', 'check_out_on'], 'lodging keeps its columns in order');
select is(pg_temp.columns_of('hospitality'), array['id', 'fulfillment_id', 'project_id', 'project_name', 'fulfillment_kind', 'title',
  'supplier_name', 'starts_at', 'ends_at', 'description', 'quantity', 'person_id'], 'hospitality keeps its columns in order');
select is(pg_temp.columns_of('travel'), array['id', 'engagement_id', 'project_id', 'project_name', 'travel_mode', 'operator_name',
  'service_identifier', 'confirmation_identifier', 'departs_from', 'departs_at', 'departs_time_zone', 'arrives_at_place', 'arrives_at',
  'arrives_time_zone'], 'travel keeps its columns in order');
select is(pg_temp.columns_of('per_diems'), array['id', 'engagement_id', 'project_id', 'project_name', 'day', 'amount_minor', 'currency_code'],
  'per_diems keeps its columns in order');
select ok(has_table_privilege('authenticated', 'api_external.' || m.view_name, 'select'), m.view_name || ' stays readable by signed-in users')
from matrix m;
select ok(not has_table_privilege('anon', 'api_external.' || m.view_name, 'select'), m.view_name || ' stays closed to anon') from matrix m;
select ok(not has_function_privilege('anon', 'private.engagement_principal(uuid)', 'execute'), 'anon cannot call engagement_principal');

select * from finish();
rollback;
