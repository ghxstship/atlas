-- pgTAP: migration 2950 (B6, RRR-230, ADR 0145), change tracking. Travel segments, room assignments and cues have an
-- audit trail and a field history; app.changes_since names the fields others changed after an instant on the rows a
-- caller reads, never a value, never a Restricted column or one signed-in people cannot select; seen marks keep a
-- 30-minute visit window per person and page; app.today_changes lists what others changed on a person's records and
-- shifts since their last visit to Today.
--
-- Time order: everything in one test transaction carries the same now(), and an event counts as after an instant only
-- when it is strictly later. Each case runs the flow for real, then, as postgres, either writes the later change as the
-- ledger row its trigger would write a few seconds after now() (pg_temp.later), or moves the earlier instant back.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;
create function pg_temp.k(p_key text) returns uuid language sql stable as $$ select k.id from k where k.key = p_key $$;

-- The ledger row a change by p_actor writes, p_seconds after now().
create function pg_temp.later(p_table text, p_id uuid, p_actor text, p_diff jsonb, p_seconds numeric default 1) returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  -- The stamp trigger would set created_at to now(); off for this one row, it keeps the instant given.
  alter table app.audit_events disable trigger t90_stamp_audit_columns;
  insert into app.audit_events (org_id, actor_kind, actor_person_id, action, subject_table, subject_id, diff, created_at)
  values (pg_temp.id('org_a'), 'Person', pg_temp.id(p_actor), split_part(p_table, '.', 2) || '.update', p_table, p_id, p_diff,
    now() + make_interval(secs => p_seconds));
  alter table app.audit_events enable trigger t90_stamp_audit_columns;
end $$;

-- 1. Audit trails and history subjects ------------------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_catalog.pg_trigger t
   where t.tgname = 't85_audit_trail'
     and t.tgrelid in ('app.travel_segments'::regclass, 'app.accommodation_assignments'::regclass, 'app.cues'::regclass)),
  3, 'travel segments, room assignments and cues each have an audit trail');
select is(
  (select count(*)::int from private.field_history_subjects
   where table_name in ('app.travel_segments', 'app.accommodation_assignments', 'app.cues')),
  3, 'and are field history subjects');

select pg_temp.as_user('alice');
with x as (
  insert into app.travel_segments (project_id, person_id, engagement_id, travel_mode, operator_name, service_identifier,
    confirmation_identifier, departs_from, departs_at, departs_time_zone, arrives_at_place, arrives_at, arrives_time_zone,
    price_minor, currency_code)
  values (pg_temp.id('prj_a'), pg_temp.id('ivy'), pg_temp.id('eng_ivy_a'), 'Flight', 'Coastal Air', 'CA 210', 'QX7P2L', 'MIA',
    now() + interval '2 days', 'America/New_York', 'JFK', now() + interval '2 days 3 hours', 'America/New_York', 45000, 'USD')
  returning id)
insert into k select 'seg', id from x;
with x as (
  insert into app.accommodation_blocks (project_id, title, check_in_on, check_out_on, rooms_held)
  values (pg_temp.id('prj_a'), 'Crew Hotel', current_date + 1, current_date + 6, 10) returning id)
insert into k select 'blk', id from x;
with x as (
  insert into app.accommodation_assignments (accommodation_block_id, person_id, check_in_on, check_out_on)
  values (pg_temp.k('blk'), pg_temp.id('ivy'), current_date + 1, current_date + 4) returning id)
insert into k select 'room', id from x;
with x as (
  insert into app.run_of_show (project_id, name, show_date) values (pg_temp.id('prj_a'), 'Main Stage', current_date) returning id)
insert into k select 'ros', id from x;
with x as (
  insert into app.cues (run_of_show_id, position, label, planned_at) values (pg_temp.k('ros'), 1, 'Doors', now() + interval '1 hour')
  returning id)
insert into k select 'cue', id from x;
update app.cues set label = 'Doors Open' where id = pg_temp.k('cue');

select pg_temp.as_user('carol');
select ok((select count(*) from app.field_history('app.travel_segments', pg_temp.k('seg'))) >= 1,
  'a reader gets a travel segment''s history');
select ok((select count(*) from app.field_history('app.accommodation_assignments', pg_temp.k('room'))) >= 1,
  'a room assignment''s');
select is((select count(*)::int from app.field_history('app.cues', pg_temp.k('cue')) where field = 'label'), 1,
  'and a cue''s, with the renamed label');

-- 2. app.changes_since on travel segments and records ------------------------------------------------------------------
select pg_temp.as_user('alice');
update app.travel_segments set departs_at = departs_at + interval '1 hour', price_minor = 47000 where id = pg_temp.k('seg');
select pg_temp.later('app.travel_segments', pg_temp.k('seg'), 'alice',
  '{"old": {"departs_at": "2027-06-03T12:00:00+00:00", "price_minor": 45000}, "new": {"departs_at": "2027-06-03T13:00:00+00:00", "price_minor": 47000}}', 1);

select pg_temp.as_user('carol');
create temporary table seg_changes as select * from app.changes_since('app.travel_segments', array[pg_temp.k('seg')], now());
grant select on seg_changes to public;
select is((select change_kind from seg_changes), 'changed', 'a move after the baseline reads as changed');
select is((select fields from seg_changes), array['departs_at', 'price_minor'],
  'naming the departure, and the fare, an Internal column signed-in people can select');
select is((select actor_name from seg_changes), 'Alice Moreno', 'by the member who moved it');

select pg_temp.later('app.travel_segments', pg_temp.k('seg'), 'alice', '{"old": {"price_minor": 47000}, "new": {"price_minor": 49000}}', 2);
select pg_temp.as_user('carol');
select is((select fields from app.changes_since('app.travel_segments', array[pg_temp.k('seg')], now() + interval '1.5 seconds')),
  array['price_minor'], 'a change to the fare alone still names price_minor here; the itinerary leaves it out (2952)');
select is((select change_kind from app.changes_since('app.travel_segments', array[pg_temp.k('seg')], now() - interval '1 minute')),
  'added', 'a row inserted after the baseline reads as added');
select is((select count(*)::int from app.changes_since('app.travel_segments', array[pg_temp.k('seg')], now() + interval '5 seconds')),
  0, 'events before the baseline return nothing');
select pg_temp.as_user('alice');
select is((select count(*)::int from app.changes_since('app.travel_segments', array[pg_temp.k('seg')], now())), 0,
  'the caller''s own changes return nothing');

-- A record whose kind attribute changed names attributes.<column>.
select pg_temp.as_user('dave');
with x as (
  insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Task', 'Rig the truss', 'Y', 'Declared') returning id)
insert into k select 'task', id from x;
insert into app.record_task (record_id, progress_pct) values (pg_temp.k('task'), 40);
update app.record_task set progress_pct = 75 where record_id = pg_temp.k('task');
select pg_temp.later('app.record_task', pg_temp.k('task'), 'dave', '{"old": {"progress_pct": 40}, "new": {"progress_pct": 75}}', 1);
select pg_temp.as_user('alice');
select is((select fields from app.changes_since('app.records', array[pg_temp.k('task')], now())), array['attributes.progress_pct'],
  'a record''s kind attribute reads as attributes.<column>');

-- 3. Refusals and filtering ----------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_like($$select * from app.changes_since('app.people', array[gen_random_uuid()], now())$$,
  'field_history_unavailable%', 'a table without a field history is refused');
select throws_like($$select * from app.changes_since('app.travel_segments', array(select gen_random_uuid() from generate_series(1, 201)), now())$$,
  'change_tracking_too_many%', '201 ids are refused');
select is((select count(*)::int from app.changes_since('app.travel_segments', array[pg_temp.k('seg')], null)), 0,
  'a null baseline returns nothing');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.changes_since('app.travel_segments', array[pg_temp.k('seg')], now() - interval '1 minute')),
  0, 'a member of another org gets no rows for a segment they cannot read');

-- A Restricted field never appears, even from an event whose diff carries it.
select pg_temp.as_platform();
insert into private.column_classifications (table_name, column_name, classification, read_capability)
values ('app.travel_segments', 'operator_name', 'Restricted', 'data.restricted.read.payroll');
select pg_temp.later('app.travel_segments', pg_temp.k('seg'), 'alice',
  '{"old": {"operator_name": "Coastal Air", "service_identifier": "CA 210"}, "new": {"operator_name": "Gulf Air", "service_identifier": "GA 12"}}', 3);
select pg_temp.as_user('carol');
select is((select fields from app.changes_since('app.travel_segments', array[pg_temp.k('seg')], now() + interval '2.5 seconds')),
  array['service_identifier'], 'a Restricted column never appears');

-- Nor does a column signed-in people cannot select.
select pg_temp.as_platform();
do $$
declare
  v_columns text;
begin
  select string_agg(quote_ident(a.attname), ', ') into v_columns from pg_catalog.pg_attribute a
  where a.attrelid = 'app.travel_segments'::regclass and a.attnum > 0 and not a.attisdropped
    and a.attname <> 'confirmation_identifier';
  revoke select on app.travel_segments from authenticated;
  execute format('grant select (%s) on app.travel_segments to authenticated', v_columns);
end $$;
select pg_temp.later('app.travel_segments', pg_temp.k('seg'), 'alice',
  '{"old": {"confirmation_identifier": "QX7P2L", "arrives_at_place": "JFK"}, "new": {"confirmation_identifier": "ZZ9K1M", "arrives_at_place": "LGA"}}', 4);
select pg_temp.as_user('carol');
select is((select fields from app.changes_since('app.travel_segments', array[pg_temp.k('seg')], now() + interval '3.5 seconds')),
  array['arrives_at_place'], 'nor does a column without an authenticated select grant');
select pg_temp.as_platform();
grant select on app.travel_segments to authenticated;

select is(pg_catalog.pg_get_function_result('app.changes_since(text, uuid[], timestamptz)'::regprocedure),
  'TABLE(subject_id uuid, change_kind text, fields text[], changed_at timestamp with time zone, actor_person_id uuid, actor_name text)',
  'no result column holds a value');
select ok(not has_function_privilege('authenticated', 'private.audit_changes_since(text, uuid, timestamptz, uuid, text[])', 'execute')
          and not has_function_privilege('authenticated', 'private.audit_field_changes(text, uuid, timestamptz, uuid)', 'execute'),
  'the ledger readers stay private');

-- 4. Seen marks -------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is(app.seen_baseline('Today', pg_temp.id('org_a')), null, 'before a first visit there is no baseline');
select is(app.record_visit('Today', pg_temp.id('org_a')), null, 'the first visit returns no baseline');
select pg_temp.as_platform();
update app.seen_marks set visit_started_at = now() - interval '10 minutes' where person_id = pg_temp.id('carol') and surface = 'Today';
select pg_temp.as_user('carol');
select is(app.seen_baseline('Today', pg_temp.id('org_a')), null, 'ten minutes into the visit the baseline is still none');
select is(app.record_visit('Today', pg_temp.id('org_a')), null, 'a visit inside the window returns the same');
select is((select visit_started_at from app.seen_marks where surface = 'Today'), now() - interval '10 minutes',
  'and leaves the visit''s start alone');
select pg_temp.as_platform();
update app.seen_marks set visit_started_at = now() - interval '31 minutes' where person_id = pg_temp.id('carol') and surface = 'Today';
select pg_temp.as_user('carol');
select is(app.seen_baseline('Today', pg_temp.id('org_a')), now() - interval '31 minutes',
  'once 30 minutes have passed, the page compares against the previous visit''s start');
select is(app.record_visit('Today', pg_temp.id('org_a')), now() - interval '31 minutes', 'which the next visit returns');
select is((select visit_started_at from app.seen_marks where surface = 'Today'), now(), 'and a new visit starts now');
select is((select baseline_at from app.seen_marks where surface = 'Today'), now() - interval '31 minutes', 'keeping that start');
select is(app.mark_seen('Today', pg_temp.id('org_a')), now(), 'Mark all as seen returns now');
select is((select baseline_at = now() and visit_started_at = now() from app.seen_marks where surface = 'Today'), true,
  'and sets both instants');
select is(app.seen_baseline('Today', pg_temp.id('org_a')), app.record_visit('Today', pg_temp.id('org_a')),
  'the baseline a render reads is what the visit returns');

-- 5. Seen marks access ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is((select count(*)::int from app.seen_marks), 0, 'a person reads none of another''s marks');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.seen_marks), 1, 'and their own');
select ok(not has_table_privilege('authenticated', 'app.seen_marks', 'insert')
          and not has_table_privilege('authenticated', 'app.seen_marks', 'update')
          and not has_table_privilege('authenticated', 'app.seen_marks', 'delete'),
  'signed-in people cannot write marks directly');
select throws_ok($$select app.record_visit('Today', (select id from world where key = 'org_b'))$$, '42501', null,
  'Today on an org the caller does not belong to is refused');
select throws_ok($$select app.record_visit('Itinerary', (select id from world where key = 'eng_ivy_b'))$$, '42501', null,
  'an itinerary of an engagement the caller does not reach is refused');
select pg_temp.as_user('xavier');
select throws_ok($$select app.record_visit('Show Day', (select id from world where key = 'prj_a'))$$, '42501', null,
  'Show day without show.run_of_show.read is refused');

-- 6. app.today_changes ----------------------------------------------------------------------------------------------------
-- Frank is assigned to one record and watches another in his project, watches one in a project he cannot read, and
-- works a shift.
select pg_temp.as_user('dave');
with x as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Task', 'Hang the banners', 'Y', 'Declared') returning id) insert into k select 'r_assigned', id from x;
with x as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Task', 'Wire the gate', 'Y', 'Declared') returning id) insert into k select 'r_watched', id from x;
with x as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Task', 'Sweep the deck', 'Y', 'Declared') returning id) insert into k select 'r_other', id from x;
select pg_temp.as_user('alice');
with x as (insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a2'), 'Task', 'Book the gala band', 'Y', 'Declared') returning id) insert into k select 'r_hidden', id from x;
select pg_temp.as_platform();
insert into app.record_assignments (record_id, membership_id) values (pg_temp.k('r_assigned'), pg_temp.id('frank@org_a'));
insert into app.record_watchers (record_id, person_id) values
  (pg_temp.k('r_watched'), pg_temp.id('frank')), (pg_temp.k('r_hidden'), pg_temp.id('frank'));
select pg_temp.as_user('carol');
with x as (insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '0000.50.01', now() + interval '2 days', now() + interval '2 days 8 hours',
    'America/New_York') returning id)
insert into k select 'frank_shift', id from x;

select pg_temp.as_user('frank');
select is((select count(*)::int from app.today_changes(pg_temp.id('org_a'))), 0, 'before a baseline exists Today lists nothing');
select app.record_visit('Today', pg_temp.id('org_a'));
select pg_temp.as_platform();
update app.seen_marks set baseline_at = now(), visit_started_at = now() where person_id = pg_temp.id('frank') and surface = 'Today';

select pg_temp.as_user('dave');
update app.records set title = 'Hang the side banners' where id = pg_temp.k('r_assigned');
select pg_temp.later('app.records', pg_temp.k('r_assigned'), 'dave', '{"old": {"title": "Hang the banners"}, "new": {"title": "Hang the side banners"}}', 1);
select pg_temp.later('app.records', pg_temp.k('r_watched'), 'dave', '{"old": {"title": "Wire the gate"}, "new": {"title": "Wire both gates"}}', 1);
select pg_temp.later('app.records', pg_temp.k('r_other'), 'dave', '{"old": {"title": "Sweep the deck"}, "new": {"title": "Mop the deck"}}', 1);
select pg_temp.later('app.records', pg_temp.k('r_hidden'), 'alice', '{"old": {"title": "Book the gala band"}, "new": {"title": "Book the gala trio"}}', 1);
select pg_temp.later('app.shifts', pg_temp.k('frank_shift'), 'carol', '{"old": {"role_code": "0000.50.01"}, "new": {"role_code": "0000.51.01"}}', 2);
select pg_temp.later('app.records', pg_temp.k('r_assigned'), 'frank', '{"old": {"blocker_text": null}, "new": {"blocker_text": "Waiting on the lift."}}', 3);

select pg_temp.as_user('frank');
create temporary table today as select * from app.today_changes(pg_temp.id('org_a'));
grant select on today to public;
select is((select array_agg(subject_id order by subject_id) from today),
  (select array_agg(id order by id) from k where key in ('r_assigned', 'r_watched', 'frank_shift')),
  'Today lists the records the person is assigned to or watches and their shift, not another record or one they cannot read');
select is((select fields from today where subject_id = pg_temp.k('r_assigned')), array['title'],
  'leaving out the person''s own change');
select is((select actor_name from today where subject_id = pg_temp.k('r_assigned')), 'Dave Lindqvist', 'and naming who changed it');
select is((select subject_key from today where subject_id = pg_temp.k('r_assigned')),
  (select p.project_key || '-' || r.record_number from app.records r join app.projects p on p.id = r.project_id where r.id = pg_temp.k('r_assigned')),
  'with the record''s key');
select is((select fields from today where subject_id = pg_temp.k('frank_shift')), array['role_code'], 'and the shift''s role change');
select is((select subject_table from today order by changed_at desc limit 1), 'app.shifts', 'newest first');

select pg_temp.as_user('erin');
select is((select count(*)::int from app.today_changes(pg_temp.id('org_a'))), 0, 'someone who never visited Today gets nothing');

select * from finish();
rollback;
