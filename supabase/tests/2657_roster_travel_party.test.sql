-- pgTAP: migration 2657 (R5, G-175), the travel party. Only hospitality.fulfillment.read holders read it; Draft entries
-- and engagements with travel not offered are absent; the room, pickup and pass flags follow live assignment, Ground
-- segment and credential rows, and pass is null without credentials.credential.read; each entry returned with travel
-- writes one project_facts.viewed (Travel) and one audit event, while the person's own reads log nothing; the day
-- counts of a 3-night stay with lodging and a pickup, logged as project_facts.counted.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql

select no_plan();

create function pg_temp.party(p_who text) returns setof jsonb
language plpgsql as $$
begin
  perform pg_temp.as_user(p_who);
  return query select * from app.roster_travel_party(pg_temp.id('prj_a'));
  perform pg_temp.as_platform();
end $$;

-- The audit ledger is append-only, so counts start after a mark (pg_temp.mark_audits).
create temporary table audit_seen (id uuid primary key);
create function pg_temp.mark_audits() returns void
language sql as $$ insert into audit_seen select a.id from app.audit_events a on conflict do nothing $$;
create function pg_temp.audits(p_action text) returns integer
language sql as $$
  select count(*)::int from app.audit_events a where a.action = p_action and a.id not in (select x.id from audit_seen x)
$$;

create function pg_temp.member(p_who text, p_entry text) returns jsonb
language sql as $$ select m from pg_temp.party(p_who) m where m ->> 'roster_entry_id' = pg_temp.id(p_entry)::text $$;

-- Travel: kai arrives June 1 and leaves June 4 (3 nights) with lodging and a pickup; mo travels without either.
select pg_temp.as_user('kai');
select app.save_roster_travel_request(pg_temp.id('e_kai'), 'MIA', 'JFK', '2027-06-01', '2027-06-04', 'Aisle', null, true, true, null);
select pg_temp.as_user('mo');
select app.save_roster_travel_request(pg_temp.id('e_mo'), 'LHR', 'LHR', '2027-06-02', '2027-06-03');
select pg_temp.as_user('una');
select app.save_roster_travel_request(pg_temp.id('e_una'), 'MIA', 'MIA', '2027-06-01', '2027-06-02');
select pg_temp.as_platform();
-- Artists on prj_a get no travel.
insert into app.offering_rules (org_id, project_id, offering, external_role_type, offering_mode)
values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Travel', 'Artist', 'Not Offered');

-- Who reads ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('creds');
select throws_ok(format($$select * from app.roster_travel_party(%L)$$, pg_temp.id('prj_a')), '42501', null,
  'credentials.credential.read alone does not read the travel party');
select throws_ok(format($$select * from app.roster_travel_day_counts(%L)$$, pg_temp.id('prj_a')), '42501', null, 'nor its counts');
select pg_temp.as_user('victor');
select throws_ok(format($$select * from app.roster_travel_party(%L)$$, pg_temp.id('prj_a')), '42501', null, 'nor does the company');
select pg_temp.as_platform();

delete from app.work_detail_events where action = 'project_facts.viewed';
select is((select count(*)::int from pg_temp.party('hops')), 4, 'hospitality reads sam, ivy, kai and mo');
select is(pg_temp.member('hops', 'e_una'), null, 'a Draft entry is absent');
select is(pg_temp.member('hops', 'self_art'), null, 'and an engagement with travel not offered');
select is(pg_temp.member('hops', 'e_kai') -> 'travel' ->> 'inbound_airport_name', 'Miami International Airport', 'travel carries airport names');
select is(pg_temp.member('hops', 'e_kai') ->> 'person_name', 'Kai Morgan', 'and the person''s name');
select is(pg_temp.member('hops', 'e_kai') ->> 'party_name', 'Bayside Audio', 'and the party');
select is(pg_temp.member('hops', 'self_sam') -> 'travel', 'null'::jsonb, 'an entry without travel shows null');

-- Logging: 7 reads above returned kai and mo with travel each time
select is((select count(*)::int from app.work_detail_events where action = 'project_facts.viewed' and person_id = pg_temp.id('kai')),
  (select count(*)::int from app.audit_events where action = 'project_facts.viewed' and subject_id = pg_temp.id('e_kai')
    and id not in (select x.id from audit_seen x)),
  'each read writes one access-log row and one audit event per entry with travel');
delete from app.work_detail_events where action = 'project_facts.viewed';
select pg_temp.mark_audits();
select count(*) from pg_temp.party('hops');
select is((select count(*)::int from app.work_detail_events where action = 'project_facts.viewed'), 2, 'one read logs kai and mo, not sam or ivy');
select is((select fact_kinds from app.work_detail_events where action = 'project_facts.viewed' and person_id = pg_temp.id('kai')),
  array['Travel']::app.project_fact_kind[], 'as Travel');
select is((select org_id from app.work_detail_events where action = 'project_facts.viewed' and person_id = pg_temp.id('kai')),
  pg_temp.id('org_a'), 'under the producing org');
select is(pg_temp.audits('project_facts.viewed'), 2, 'with one audit event each');
select pg_temp.as_user('kai');
select app.roster_project_facts(pg_temp.id('e_kai'));
select pg_temp.as_platform();
select is((select count(*)::int from app.work_detail_events where action = 'project_facts.viewed'), 2, 'the person''s own read logs nothing');

-- Room, pickup and pass ------------------------------------------------------------------------------------------------------
select is(pg_temp.member('hops', 'e_kai') -> 'room' ->> 'assigned', 'false', 'no room yet');
select is(pg_temp.member('hops', 'e_kai') -> 'pickup' ->> 'booked', 'false', 'no pickup yet');
select is(pg_temp.member('hops', 'e_kai') -> 'pass', 'null'::jsonb, 'pass is null without credentials.credential.read');

with x as (insert into app.accommodation_blocks (org_id, project_id, title, check_in_on, check_out_on, rooms_held)
  values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Hotel Cadillac', '2027-05-30', '2027-06-10', 10) returning id)
insert into world select 'blk', id from x;
with x as (insert into app.accommodation_assignments (org_id, accommodation_block_id, person_id, check_in_on, check_out_on)
  values (pg_temp.id('org_a'), pg_temp.id('blk'), pg_temp.id('kai'), '2027-06-01', '2027-06-04') returning id)
insert into world select 'room', id from x;
with x as (insert into app.travel_segments (org_id, project_id, person_id, travel_mode, departs_from, departs_at,
  departs_time_zone, arrives_at_place, arrives_time_zone)
  values (pg_temp.id('org_a'), pg_temp.id('prj_a'), pg_temp.id('kai'), 'Ground', 'Miami International Airport (MIA)',
    ('2027-06-01 14:00'::timestamp at time zone (select time_zone from app.projects where id = pg_temp.id('prj_a'))),
    (select time_zone from app.projects where id = pg_temp.id('prj_a')), 'Hotel Cadillac',
    (select time_zone from app.projects where id = pg_temp.id('prj_a'))) returning id)
insert into world select 'seg', id from x;
with x as (insert into app.credential_categories (org_id, project_id, code, name)
  values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'CREW', 'Crew') returning id)
insert into world select 'cat', id from x;
with x as (insert into app.credentials (org_id, project_id, credential_category_id, holder_person_id, engagement_id)
  values (pg_temp.id('org_a'), pg_temp.id('prj_a'), pg_temp.id('cat'), pg_temp.id('sam'), pg_temp.id('eng_vendor_a')) returning id)
insert into world select 'pass', id from x;

select is(pg_temp.member('hops', 'e_kai') -> 'room', jsonb_build_object('assigned', true, 'check_in_on', '2027-06-01',
  'check_out_on', '2027-06-04', 'block_name', 'Hotel Cadillac'), 'a live assignment on the project''s block assigns the room');
select is(pg_temp.member('hops', 'e_kai') -> 'pickup' ->> 'booked', 'true', 'a Ground segment on the arrival day books the pickup');
select is(pg_temp.member('hops', 'e_mo') -> 'room' ->> 'assigned', 'false', 'mo still has no room');
select pg_temp.as_user('alice');
select is((select m -> 'pass' ->> 'issued' from app.roster_travel_party(pg_temp.id('prj_a')) m
  where m ->> 'roster_entry_id' = pg_temp.id('self_sam')::text), 'true', 'a credentials reader sees sam''s badge on the engagement issued');
select is((select m -> 'pass' ->> 'issued' from app.roster_travel_party(pg_temp.id('prj_a')) m
  where m ->> 'roster_entry_id' = pg_temp.id('e_kai')::text), 'false', 'and kai''s not');
select pg_temp.as_platform();
update app.accommodation_assignments set deleted_at = now() where id = pg_temp.id('room');
update app.travel_segments set deleted_at = now() where id = pg_temp.id('seg');
select pg_temp.claims('alice');
update app.credentials set revoked_at = now(), revoked_by = pg_temp.id('alice') where id = pg_temp.id('pass');
select pg_temp.as_platform();
select is(pg_temp.member('hops', 'e_kai') -> 'room' ->> 'assigned', 'false', 'a deleted assignment frees the room');
select is(pg_temp.member('hops', 'e_kai') -> 'pickup' ->> 'booked', 'false', 'a deleted segment unbooks the pickup');
select pg_temp.as_user('alice');
select is((select m -> 'pass' ->> 'issued' from app.roster_travel_party(pg_temp.id('prj_a')) m
  where m ->> 'roster_entry_id' = pg_temp.id('self_sam')::text), 'false', 'a revoked credential is no pass');
select pg_temp.as_platform();

-- Day counts -------------------------------------------------------------------------------------------------------------------
delete from app.work_detail_events where action = 'project_facts.counted';
select pg_temp.mark_audits();
select pg_temp.as_user('hops');
create temporary table counts as select * from app.roster_travel_day_counts(pg_temp.id('prj_a'));
select pg_temp.as_platform();
select is((select array_agg(day order by day) from counts), array['2027-06-01', '2027-06-02', '2027-06-03', '2027-06-04']::date[],
  'the days run from the first arrival to the last departure');
select is((select array_agg(arriving order by day) from counts), array[1, 1, 0, 0], 'arrivals');
select is((select array_agg(departing order by day) from counts), array[0, 0, 1, 1], 'departures');
select is((select array_agg(on_site order by day) from counts), array[1, 2, 2, 1], 'people on site');
select is((select array_agg(rooms_needed order by day) from counts), array[1, 1, 1, 0], 'three nights of lodging for kai');
select is((select array_agg(pickups_needed order by day) from counts), array[1, 0, 0, 0], 'one pickup on arrival');
select is((select bool_or(truncated) from counts), false, 'not truncated');
select is((select count(*)::int from app.work_detail_events where action = 'project_facts.counted'), 2,
  'one project_facts.counted row per person counted');
select is(pg_temp.audits('project_facts.counted'), 1,
  'and one audit event per call');

select * from finish();
rollback;
