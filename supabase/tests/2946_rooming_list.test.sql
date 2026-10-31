-- pgTAP: migration 2946 (B5, G-67), the rooming list. Credentials covering days 1 to 3 and 5 to 6 suggest two stays
-- (check-in 1 to check-out 4, and 5 to 7) for a reader holding credentials.credential.read, and the travel dates for a
-- reader without it; a person without a credential falls back to the travel dates, a person with neither shows No
-- Dates; Covered, Partial and Missing follow the live assignments; cost is per currency. It needs
-- hospitality.fulfillment.read, leaves out engagements with Lodging not offered, names an Approved block allocation not
-- yet issued, and writes one project_facts.viewed (Travel) and one audit event per returned entry.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql
\ir 2940_travel_world.psql

select no_plan();

create function pg_temp.rooming(p_who text) returns setof jsonb
language plpgsql as $$
begin
  perform pg_temp.as_user(p_who);
  return query select * from app.rooming_list(pg_temp.id('prj_a'));
  perform pg_temp.as_platform();
end $$;

create function pg_temp.room_of(p_who text, p_entry text) returns jsonb
language sql as $$ select m from pg_temp.rooming(p_who) m where m ->> 'roster_entry_id' = pg_temp.id(p_entry)::text $$;

update app.projects set starts_on = '2027-05-30', ends_on = '2027-06-10' where id = pg_temp.id('prj_a');

-- Travel requests: kai and mo need lodging with dates; sam needs lodging with airports only.
select pg_temp.as_user('kai');
select app.save_roster_travel_request(pg_temp.id('e_kai'), 'MIA', 'JFK', '2027-06-01', '2027-06-04', 'Aisle', null, false, true, null);
select pg_temp.as_user('mo');
select app.save_roster_travel_request(pg_temp.id('e_mo'), 'LHR', 'LHR', '2027-06-02', '2027-06-05', null, null, false, true, null);
select pg_temp.as_user('sam');
select app.save_roster_travel_request(pg_temp.id('self_sam'), 'MIA', 'MIA', null, null, null, null, false, true, null);
select pg_temp.as_platform();

-- Kai's passes: June 1 to 3 and June 5 to 6 (project zone).
select pg_temp.as_user('alice');
insert into app.credentials (credential_category_id, holder_person_id, engagement_id, valid_from, valid_to) values
  (pg_temp.id('cat_crew'), pg_temp.id('kai'), pg_temp.id('eng_vendor_a'), '2027-06-01 08:00-04', '2027-06-04 00:00-04'),
  (pg_temp.id('cat_crew'), pg_temp.id('kai'), pg_temp.id('eng_vendor_a'), '2027-06-05 08:00-04', '2027-06-07 00:00-04');
with x as (insert into app.accommodation_blocks (project_id, title, check_in_on, check_out_on, rooms_held, nightly_rate_minor, currency_code)
  values (pg_temp.id('prj_a'), 'Bayview Hotel', '2027-05-30', '2027-06-10', 5, 18000, 'USD') returning id)
insert into world select 'bay', id from x;
select pg_temp.as_platform();

-- Readers ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('creds');
select throws_ok(format($$select * from app.rooming_list(%L)$$, pg_temp.id('prj_a')), '42501', null,
  'the rooming list needs hospitality.fulfillment.read');
select pg_temp.as_platform();

-- Suggestions --------------------------------------------------------------------------------------------------------------------
select is(pg_temp.room_of('alice', 'e_kai') -> 'suggested_stays', '[
  {"check_in_on": "2027-06-01", "check_out_on": "2027-06-04", "source": "Credentials"},
  {"check_in_on": "2027-06-05", "check_out_on": "2027-06-07", "source": "Credentials"}]'::jsonb,
  'credential days 1 to 3 and 5 to 6 suggest two stays');
select is(pg_temp.room_of('hops', 'e_kai') -> 'suggested_stays', '[
  {"check_in_on": "2027-06-01", "check_out_on": "2027-06-04", "source": "Travel"}]'::jsonb,
  'a reader without credentials.credential.read gets the travel dates instead');
select is(pg_temp.room_of('alice', 'e_mo') -> 'suggested_stays', '[
  {"check_in_on": "2027-06-02", "check_out_on": "2027-06-05", "source": "Travel"}]'::jsonb, 'a person without a credential falls back to travel');
select is(pg_temp.room_of('alice', 'self_sam') ->> 'status', 'No Dates', 'a person with neither shows No Dates');
select is(pg_temp.room_of('alice', 'e_mo') ->> 'status', 'Missing', 'no room yet is Missing');
select is((pg_temp.room_of('alice', 'e_kai') ->> 'uncovered_nights')::int, 5, 'all five of kai''s nights are uncovered');

-- Assignments ---------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into app.accommodation_assignments (accommodation_block_id, person_id, check_in_on, check_out_on)
values (pg_temp.id('bay'), pg_temp.id('kai'), '2027-06-01', '2027-06-04');
select pg_temp.as_platform();
select is(pg_temp.room_of('alice', 'e_kai') ->> 'status', 'Partial', 'three of five nights covered is Partial');
select is((pg_temp.room_of('alice', 'e_kai') ->> 'uncovered_nights')::int, 2, 'with two uncovered');
select is(pg_temp.room_of('hops', 'e_kai') ->> 'status', 'Covered', 'against the travel dates the same room covers everything');
select is(pg_temp.room_of('alice', 'e_kai') -> 'assigned_stays' -> 0 ->> 'block_title', 'Bayview Hotel', 'the assigned stay names its block');
select is(pg_temp.room_of('alice', 'e_kai') -> 'cost', '[{"currency_code": "USD", "nights": 3, "amount_minor": 54000}]'::jsonb,
  'cost is nights times the block''s rate, per currency');
select pg_temp.as_user('alice');
insert into app.accommodation_assignments (accommodation_block_id, person_id, check_in_on, check_out_on)
values (pg_temp.id('bay'), pg_temp.id('kai'), '2027-06-05', '2027-06-07');
select pg_temp.as_platform();
select is(pg_temp.room_of('alice', 'e_kai') ->> 'status', 'Covered', 'both stays assigned is Covered');

-- The allocation to issue ------------------------------------------------------------------------------------------------------------
select is(pg_temp.room_of('alice', 'e_mo') ->> 'lodging_allocation_id', null, 'no allocation, none named');
insert into world select 'mo_room', pg_temp.alloc('assign', 'carol', 'e_mo', 'block', 'blk', 1);
select is(pg_temp.room_of('alice', 'e_mo') ->> 'lodging_allocation_id', pg_temp.id('mo_room')::text,
  'an Approved block allocation not yet issued is named, so Assign room opens the Issue dialog');

-- Logging and offerings ------------------------------------------------------------------------------------------------------------
create temporary table audit_seen (id uuid primary key);
insert into audit_seen select a.id from app.audit_events a;
delete from app.work_detail_events where action = 'project_facts.viewed';
select count(*) from pg_temp.rooming('hops');
select is((select count(*)::int from app.work_detail_events where action = 'project_facts.viewed'), 3,
  'one read logs kai, mo and sam once each');
select is((select count(*)::int from app.audit_events a where a.action = 'project_facts.viewed' and a.id not in (select x.id from audit_seen x)),
  3, 'with one audit event each');
select is((select fact_kinds from app.work_detail_events where action = 'project_facts.viewed' and person_id = pg_temp.id('kai')),
  array['Travel']::app.project_fact_kind[], 'as Travel');
insert into app.offering_rules (org_id, project_id, offering, external_role_type, offering_mode)
values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Lodging', 'Vendor', 'Not Offered');
select is((select count(*)::int from pg_temp.rooming('alice')), 0, 'an engagement with Lodging not offered is left out');

select * from finish();
rollback;
