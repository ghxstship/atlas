-- pgTAP: migration 2952 (B6, RRR-230, G-65, ADR 0145), api_external.itinerary_changes. Once a person's itinerary has a
-- baseline, what others changed on their travel, rooms and set times shows by field name only: a fare change marks
-- nothing, a cue call marks nothing, a person on a roster never sees a colleague's rows, the person's own edits are left
-- out, and a removed segment is titled by its route.
--
-- Time order: everything in one test transaction carries the same now(), and a change counts only when it is strictly
-- later than the baseline. Each case runs the flow for real, then, as postgres, writes the later change as the ledger
-- row its trigger would write a few seconds after now() (pg_temp.later).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql

select no_plan();

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;
create function pg_temp.k(p_key text) returns uuid language sql stable as $$ select k.id from k where k.key = p_key $$;

create function pg_temp.columns(p_view text) returns text[]
language sql security definer as $$
  select array_agg(a.attname::text order by a.attnum) from pg_attribute a
  where a.attrelid = p_view::regclass and a.attnum > 0 and not a.attisdropped
$$;

-- The ledger row a change by p_actor writes, p_seconds after now().
create function pg_temp.later(p_table text, p_id uuid, p_actor text, p_op text, p_diff jsonb, p_seconds numeric default 1) returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  -- The stamp trigger would set created_at to now(); off for this one row, it keeps the instant given.
  alter table app.audit_events disable trigger t90_stamp_audit_columns;
  insert into app.audit_events (org_id, actor_kind, actor_person_id, action, subject_table, subject_id, diff, created_at)
  values (pg_temp.id('org_a'), 'Person', pg_temp.id(p_actor), split_part(p_table, '.', 2) || '.' || p_op, p_table, p_id, p_diff,
    now() + make_interval(secs => p_seconds));
  alter table app.audit_events enable trigger t90_stamp_audit_columns;
end $$;

-- Issues one travel allocation to a roster entry as Carol; returns the travel segment it made.
create function pg_temp.trip(p_entry text, p_from text, p_to text) returns uuid
language plpgsql as $$
declare
  v_allocation uuid;
begin
  v_allocation := pg_temp.alloc('assign', 'carol', p_entry, 'travel', null, 1);
  perform pg_temp.as_user('carol');
  perform app.issue_allocation(gen_random_uuid(), v_allocation, jsonb_build_array(jsonb_build_object(
    'travel_mode', 'Flight', 'departs_from', p_from, 'departs_at', '2027-06-01T08:00:00Z', 'departs_time_zone', 'America/New_York',
    'arrives_at_place', p_to, 'arrives_time_zone', 'America/New_York', 'price_minor', 32000, 'currency_code', 'USD')));
  perform pg_temp.as_platform();
  return (select t.id from app.travel_segments t where t.allocation_id = v_allocation);
end $$;

create function pg_temp.room(p_entry text) returns uuid
language plpgsql as $$
declare
  v_allocation uuid;
begin
  v_allocation := pg_temp.alloc('assign', 'carol', p_entry, 'block', 'blk', 1);
  perform pg_temp.as_user('carol');
  perform app.issue_allocation(gen_random_uuid(), v_allocation, '[{}]'::jsonb);
  perform pg_temp.as_platform();
  return (select a.id from app.accommodation_assignments a where a.allocation_id = v_allocation);
end $$;

-- 12. The view's shape --------------------------------------------------------------------------------------------------------
select is(pg_temp.columns('api_external.itinerary_changes'), array['subject_kind', 'subject_id', 'engagement_id', 'project_id',
  'change_kind', 'changed_fields', 'changed_at', 'baseline_at', 'title'], 'the view has exactly its nine columns');
select ok(has_table_privilege('authenticated', 'api_external.itinerary_changes', 'select')
          and not has_table_privilege('anon', 'api_external.itinerary_changes', 'select'), 'signed-in people read it, anon does not');

-- Kai's and Mo's trips and rooms, all issued now.
select pg_temp.as_platform();
insert into k values ('kai_flight', pg_temp.trip('e_kai', 'BOS', 'MIA'));
insert into k values ('kai_fare', pg_temp.trip('e_kai', 'ORD', 'MIA'));
insert into k values ('kai_new', pg_temp.trip('e_kai', 'ATL', 'MIA'));
insert into k values ('kai_gone', pg_temp.trip('e_kai', 'MIA', 'JFK'));
insert into k values ('mo_flight', pg_temp.trip('e_mo', 'JFK', 'MIA'));
insert into k values ('kai_room', pg_temp.room('e_kai'));
insert into k values ('mo_room', pg_temp.room('e_mo'));

-- 14. Before a baseline exists the view returns nothing ------------------------------------------------------------------------
select pg_temp.as_user('kai');
select is(app.record_visit('Itinerary', pg_temp.id('eng_vendor_a')), null, 'Kai''s first look at his itinerary');
select is((select count(*)::int from api_external.itinerary_changes), 0, 'before a baseline exists the view returns no rows');
select pg_temp.as_platform();
update app.seen_marks set baseline_at = now(), visit_started_at = now() where person_id = pg_temp.id('kai') and surface = 'Itinerary';

-- 13. The traveller's own itinerary --------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
update app.travel_segments set departs_at = departs_at + interval '2 hours' where id = pg_temp.k('kai_flight');
select pg_temp.later('app.travel_segments', pg_temp.k('kai_flight'), 'alice', 'update',
  '{"old": {"departs_at": "2027-06-01T08:00:00+00:00"}, "new": {"departs_at": "2027-06-01T10:00:00+00:00"}}', 1);
select pg_temp.as_user('alice');
update app.travel_segments set price_minor = 41000, currency_code = 'EUR' where id = pg_temp.k('kai_fare');
select pg_temp.later('app.travel_segments', pg_temp.k('kai_fare'), 'alice', 'update',
  '{"old": {"price_minor": 32000, "currency_code": "USD"}, "new": {"price_minor": 41000, "currency_code": "EUR"}}', 1);
select pg_temp.later('app.travel_segments', pg_temp.k('kai_new'), 'carol', 'insert',
  jsonb_build_object('new', (select to_jsonb(t) - array['created_at', 'created_by', 'updated_at', 'updated_by']
    from app.travel_segments t where t.id = pg_temp.k('kai_new'))), 1);
select pg_temp.as_user('alice');
update app.travel_segments set deleted_at = now() where id = pg_temp.k('kai_gone');
select pg_temp.later('app.travel_segments', pg_temp.k('kai_gone'), 'alice', 'update',
  jsonb_build_object('old', jsonb_build_object('deleted_at', null), 'new', jsonb_build_object('deleted_at', now())), 1);
-- Mo's flight and room move too.
select pg_temp.later('app.travel_segments', pg_temp.k('mo_flight'), 'alice', 'update',
  '{"old": {"departs_at": "2027-06-01T08:00:00+00:00"}, "new": {"departs_at": "2027-06-01T09:00:00+00:00"}}', 1);
select pg_temp.later('app.accommodation_assignments', pg_temp.k('mo_room'), 'alice', 'update',
  '{"old": {"check_in_on": "2027-05-31"}, "new": {"check_in_on": "2027-06-01"}}', 1);
-- Kai's room changes dates, and he edits his own flight's operator himself.
select pg_temp.later('app.accommodation_assignments', pg_temp.k('kai_room'), 'alice', 'update',
  '{"old": {"check_out_on": "2027-06-06"}, "new": {"check_out_on": "2027-06-05"}}', 1);
select pg_temp.later('app.travel_segments', pg_temp.k('kai_flight'), 'kai', 'update',
  '{"old": {"operator_name": null}, "new": {"operator_name": "Coastal Air"}}', 2);

select pg_temp.as_user('kai');
create temporary table kai_changes as select * from api_external.itinerary_changes;
grant select on kai_changes to public;
select is((select count(*)::int from kai_changes where subject_id = pg_temp.k('kai_flight')), 1, 'the moved flight is one row');
select is((select change_kind || ' ' || subject_kind from kai_changes where subject_id = pg_temp.k('kai_flight')), 'changed travel',
  'a changed travel row');
select is((select changed_fields from kai_changes where subject_id = pg_temp.k('kai_flight')), array['departs_at'],
  'naming the departure, and not his own edit of the operator');
select is((select count(*)::int from kai_changes where subject_id = pg_temp.k('kai_fare')), 0,
  'a change to the fare and its currency produces no row');
select is((select change_kind from kai_changes where subject_id = pg_temp.k('kai_new')), 'added', 'a new segment is added');
select is((select change_kind from kai_changes where subject_id = pg_temp.k('kai_gone')), 'removed', 'a soft-deleted segment is removed');
select is((select title from kai_changes where subject_id = pg_temp.k('kai_gone')), 'MIA → JFK', 'titled by its route');
select is((select changed_fields from kai_changes where subject_id = pg_temp.k('kai_room')), array['check_out_on'],
  'his room''s new check-out date');
select is((select baseline_at from kai_changes limit 1), now(), 'every row carries the baseline it compares against');
select ok((select bool_and(engagement_id = pg_temp.id('eng_vendor_a')) from kai_changes), 'on the engagement whose itinerary it is');

-- 14. What other viewers see ----------------------------------------------------------------------------------------------------
select is((select count(*)::int from kai_changes where subject_id in (pg_temp.k('mo_flight'), pg_temp.k('mo_room'))), 0,
  'a person on a roster never sees a colleague''s travel or room');

-- The artist's set time.
select pg_temp.move_engagement('eng_art_a', 'Onboarding', 'Active');
select pg_temp.as_user('alice');
with x as (insert into app.run_of_show (project_id, name, show_date) values (pg_temp.id('prj_a'), 'Main Stage', '2027-06-02') returning id)
insert into k select 'ros', id from x;
with x as (insert into app.cues (run_of_show_id, position, label, planned_at) values (pg_temp.k('ros'), 1, 'Headliner Set', '2027-06-02 23:00+00')
  returning id)
insert into k select 'set', id from x;
with x as (insert into app.cues (run_of_show_id, position, label, planned_at) values (pg_temp.k('ros'), 2, 'House Lights', '2027-06-03 00:30+00')
  returning id)
insert into k select 'house', id from x;
insert into app.engagement_cues (engagement_id, cue_id) values (pg_temp.id('eng_art_a'), pg_temp.k('set'));
select pg_temp.as_user('art');
select app.record_visit('Itinerary', pg_temp.id('eng_art_a'));
select pg_temp.as_platform();
update app.seen_marks set baseline_at = now(), visit_started_at = now() where person_id = pg_temp.id('art') and surface = 'Itinerary';
select pg_temp.as_user('alice');
update app.cues set planned_at = planned_at + interval '15 minutes' where id = pg_temp.k('set');
select pg_temp.later('app.cues', pg_temp.k('set'), 'alice', 'update',
  '{"old": {"planned_at": "2027-06-02T23:00:00+00:00"}, "new": {"planned_at": "2027-06-02T23:15:00+00:00"}}', 1);
select pg_temp.later('app.cues', pg_temp.k('house'), 'alice', 'update',
  '{"old": {"planned_at": "2027-06-03T00:30:00+00:00"}, "new": {"planned_at": "2027-06-03T00:45:00+00:00"}}', 1);
select pg_temp.as_user('art');
select is((select subject_kind || ' ' || array_to_string(changed_fields, ',') from api_external.itinerary_changes
           where subject_id = pg_temp.k('set')), 'set_time planned_at', 'the artist sees a planned_at change on their set as set_time');
select is((select count(*)::int from api_external.itinerary_changes where subject_id = pg_temp.k('house')), 0,
  'and nothing of the rest of the running order');

select pg_temp.as_user('alice');
update app.cues set called_at = now() where id = pg_temp.k('set');
select pg_temp.later('app.cues', pg_temp.k('set'), 'alice', 'update',
  jsonb_build_object('old', jsonb_build_object('called_at', null, 'called_by', null),
    'new', jsonb_build_object('called_at', now(), 'called_by', pg_temp.id('alice'))), 3);
select pg_temp.as_user('art');
select is((select changed_fields from api_external.itinerary_changes where subject_id = pg_temp.k('set')), array['planned_at'],
  'calling the cue marks nothing');

-- The traveller's own edits are excluded.
select pg_temp.later('app.cues', pg_temp.k('set'), 'art', 'update', '{"old": {"label": "Headliner Set"}, "new": {"label": "Headline Set"}}', 4);
select pg_temp.as_user('art');
select is((select changed_fields from api_external.itinerary_changes where subject_id = pg_temp.k('set')), array['planned_at'],
  'the person''s own edits are excluded');

select pg_temp.as_user('xavier');
select is((select count(*)::int from api_external.itinerary_changes), 0, 'someone without a mark reads nothing');

select * from finish();
rollback;
