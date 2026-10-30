-- pgTAP: migration 2612 (R2), what Gateway Home's Up Next card reads. A crew member reads the venue, the name of the
-- member who set up the engagement and their next Published shift in the shift's zone; a vendor reads the next dock slot
-- and an artist the next set cue, in the project's zone. There is no next call while Onboarding, the contact goes once
-- its member leaves the org, and an unrelated person reads no row. The tables read carry no column classifications.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create function pg_temp.up_next(p_who text, p_engagement text) returns api_external.engagement_up_next
language plpgsql as $$
declare v api_external.engagement_up_next;
begin
  perform pg_temp.as_user(p_who);
  select * into v from api_external.engagement_up_next u where u.engagement_id = pg_temp.id(p_engagement);
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.publish_shift(p_key text) returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  perform private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions', 'shift_id',
    pg_temp.id(p_key), 'Draft', 'Published', 'Fixture publish.');
end $$;

-- Fixture: the venue's address, ivy's shifts, a dock slot for the vendor, a set cue for the artist ----------------------------
select pg_temp.as_user('alice');
update app.venues set street_address = '1 Pier Way', locality = 'Miami', postal_code = '33132' where id = pg_temp.id('venue_a');
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'DOCK-V', 'Vendor Dock') returning id)
  insert into world select 'dock', id from x;
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date)
  values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Opening Night Running Order', current_date + 6) returning id)
  insert into world select 'ros', id from x;
with x as (insert into app.cues (run_of_show_id, position, label, planned_at) values (pg_temp.id('ros'), 1, 'Headliner Set', now() + interval '6 days')
  returning id) insert into world select 'cue_set', id from x;
with x as (insert into app.cues (run_of_show_id, position, label, planned_at) values (pg_temp.id('ros'), 2, 'Encore', now() + interval '7 days')
  returning id) insert into world select 'cue_encore', id from x;
insert into app.engagement_cues (engagement_id, cue_id) values
  (pg_temp.id('eng_art_a'), pg_temp.id('cue_set')), (pg_temp.id('eng_art_a'), pg_temp.id('cue_encore'));
select pg_temp.as_user('carol');
with x as (insert into app.shifts (project_id, engagement_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '5000.51.02', now() + interval '1 day', now() + interval '1 day 8 hours', 'America/Chicago')
  returning id) insert into world select 'sh_draft', id from x;
with x as (insert into app.shifts (project_id, engagement_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '5000.51.02', now() + interval '2 days', now() + interval '2 days 8 hours', 'America/Chicago')
  returning id) insert into world select 'sh_next', id from x;
with x as (insert into app.shifts (project_id, engagement_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '5000.51.02', now() + interval '4 days', now() + interval '4 days 8 hours', 'America/Chicago')
  returning id) insert into world select 'sh_later', id from x;
select pg_temp.as_user('dave');
with x as (insert into app.dock_slots (project_id, zone_id, engagement_id, starts_at, ends_at)
  values (pg_temp.id('prj_a'), pg_temp.id('dock'), pg_temp.id('eng_vendor_a'), now() + interval '3 days', now() + interval '3 days 1 hour')
  returning id) insert into world select 'slot', id from x;
select pg_temp.as_platform();
select pg_temp.publish_shift('sh_next');
select pg_temp.publish_shift('sh_later');

-- Onboarding: the card shows where and whom, no call yet -------------------------------------------------------------------------
select is(pg_temp.n('ivy', format('select 1 from api_external.engagement_up_next where engagement_id = %L', pg_temp.id('eng_ivy_a'))), 1,
  'the crew member reads their engagement''s row while Onboarding');
select is((pg_temp.up_next('ivy', 'eng_ivy_a')).venue_name, 'Northwind Pier Pavilion', 'with the project''s venue');
select ok((pg_temp.up_next('ivy', 'eng_ivy_a')).next_call_at is null and (pg_temp.up_next('ivy', 'eng_ivy_a')).next_call_kind is null,
  'next_call is null while Onboarding');

select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Active');

-- Crew -----------------------------------------------------------------------------------------------------------------------------
select is((pg_temp.up_next('ivy', 'eng_ivy_a')).next_call_at, (select starts_at from app.shifts where id = pg_temp.id('sh_next')),
  'crew: the next call is the earliest Published shift, not an earlier Draft');
select is((pg_temp.up_next('ivy', 'eng_ivy_a')).next_call_kind, 'Shift', 'of kind Shift');
select is((pg_temp.up_next('ivy', 'eng_ivy_a')).next_call_time_zone, 'America/Chicago', 'in the shift''s own zone');
select is(array[(pg_temp.up_next('ivy', 'eng_ivy_a')).venue_street_address, (pg_temp.up_next('ivy', 'eng_ivy_a')).venue_locality,
  (pg_temp.up_next('ivy', 'eng_ivy_a')).venue_postal_code], array['1 Pier Way', 'Miami', '33132'], 'crew: the venue''s address');
select is((pg_temp.up_next('ivy', 'eng_ivy_a')).contact_name, 'Alice Moreno', 'crew: the member who set up the engagement');

select pg_temp.as_platform();
select private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions', 'shift_id',
  pg_temp.id('sh_next'), 'Published', 'Canceled', 'Fixture cancel.');
select is((pg_temp.up_next('ivy', 'eng_ivy_a')).next_call_at, (select starts_at from app.shifts where id = pg_temp.id('sh_later')),
  'a canceled shift gives way to the next Published one');

-- Vendor and artist ------------------------------------------------------------------------------------------------------------------
select is((pg_temp.up_next('victor', 'eng_vendor_a')).next_call_at, (select starts_at from app.dock_slots where id = pg_temp.id('slot')),
  'vendor: the next call is the dock slot');
select is((pg_temp.up_next('victor', 'eng_vendor_a')).next_call_kind, 'Dock Slot', 'of kind Dock Slot');
select is((pg_temp.up_next('sam', 'eng_vendor_a')).next_call_time_zone, 'America/New_York', 'in the project''s zone');
select pg_temp.as_user('dave');
update app.dock_slots set checked_in_at = now() where id = pg_temp.id('slot');
select pg_temp.as_platform();
select ok((pg_temp.up_next('victor', 'eng_vendor_a')).next_call_at is null, 'a checked-in slot is no longer a call');

select is((pg_temp.up_next('art', 'eng_art_a')).next_call_at, (select planned_at from app.cues where id = pg_temp.id('cue_set')),
  'artist: the next call is the earliest set cue');
select is((pg_temp.up_next('rita', 'eng_art_a')).next_call_kind, 'Set', 'of kind Set, for the Advance representative too');
select pg_temp.as_user('alice');
update app.cues set called_at = now() where id = pg_temp.id('cue_set');
select pg_temp.as_platform();
select is((pg_temp.up_next('art', 'eng_art_a')).next_call_at, (select planned_at from app.cues where id = pg_temp.id('cue_encore')),
  'a called cue gives way to the next set');

-- Contact ------------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('quinn'), 'Crew', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-06-01')
  returning id) insert into world select 'eng_quinn_a', id from x;
select pg_temp.as_platform();
select is((pg_temp.up_next('quinn', 'eng_quinn_a')).contact_name, 'Carol Nguyen', 'the contact is the member who set up the engagement');
update app.memberships set valid_to = now() where id = pg_temp.id('carol@org_a');
select ok((pg_temp.up_next('quinn', 'eng_quinn_a')).contact_name is null, 'contact_name is null once that member leaves the org');

-- Who reads ------------------------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('ivy', format('select 1 from api_external.engagement_up_next where engagement_id = %L', pg_temp.id('eng_vendor_a'))), 0,
  'an unrelated person reads no row of another engagement');
select is(pg_temp.n('xavier', 'select 1 from api_external.engagement_up_next'), 0, 'an org user with no engagement reads no row');
select is(pg_temp.n('nina', 'select 1 from api_external.engagement_up_next'), 0, 'a person with no engagement reads no row');
select is(pg_temp.n('ivy', 'select 1 from api_external.engagement_up_next'), 2, 'the crew member reads one row per engagement, across orgs');

-- Catalog --------------------------------------------------------------------------------------------------------------------------------
select is((select count(*)::int from private.column_classifications
  where table_name in ('app.submittals', 'app.riders', 'app.venues', 'app.shifts', 'app.dock_slots', 'app.cues')), 0,
  'the tables read by R2''s views carry no column classifications, so there is no new logged read');
select is((select array_agg(column_name::text order by ordinal_position) from information_schema.columns
  where table_schema = 'api_external' and table_name = 'engagement_up_next'),
  array['engagement_id', 'project_id', 'venue_name', 'venue_street_address', 'venue_locality', 'venue_postal_code', 'contact_name',
    'next_call_at', 'next_call_time_zone', 'next_call_kind', 'next_call_tbc'], 'the view lists its columns (next_call_tbc appended by 2790)');
select ok(has_table_privilege('authenticated', 'api_external.engagement_up_next', 'select'), 'signed-in users read the view');
select ok(not has_table_privilege('anon', 'api_external.engagement_up_next', 'select'), 'anon does not');

select * from finish();
rollback;
