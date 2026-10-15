-- pgTAP: app.record_punch (late slot, requested by A17). Idempotent on the client punch id; In refused
-- while clocked in (punch_already_in); breaks accumulate whole minutes; Out closes the entry; skew
-- tolerance with and without a monotonic offset; the server checks the geofence; punches on a shift need
-- the A13 Accepted state; members punch for themselves, engaged externals on their open engagement, the
-- kiosk service for a verified worker; replay through the sync wrapper; the 16-hour close is scheduled.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(36);

create temporary table punches (key text primary key, punch app.clock_punches);
grant select, insert on punches to public;

-- World --------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
with x as (insert into app.geofences (venue_id, name, boundary) values (pg_temp.id('venue_a'), 'Pavilion Fence',
  'SRID=4326;POLYGON((-80.20 25.77, -80.19 25.77, -80.19 25.78, -80.20 25.78, -80.20 25.77))') returning id) insert into world select 'fence', id from x;
select pg_temp.as_user('carol');
with x as (insert into app.shifts (project_id, membership_id, starts_at, ends_at, time_zone) values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), now() - interval '4 hours', now() + interval '4 hours', 'America/New_York') returning id) insert into world select 'sh_frank', id from x;
with x as (insert into app.shifts (project_id, membership_id, starts_at, ends_at, time_zone) values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), now() + interval '1 day', now() + interval '1 day 8 hours', 'America/New_York') returning id) insert into world select 'sh_draft', id from x;
select app.publish_shifts(array[pg_temp.id('sh_frank')]);
select pg_temp.as_user('frank');
select app.accept_shift(pg_temp.id('sh_frank'));
select pg_temp.as_platform();
insert into world values ('p_in', gen_random_uuid()), ('p_bs', gen_random_uuid()), ('p_be', gen_random_uuid()), ('p_out', gen_random_uuid()),
  ('p_in2', gen_random_uuid()), ('p_out2', gen_random_uuid()), ('p_in3', gen_random_uuid());

-- In, replay, second In -------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
insert into punches select 'in', app.record_punch(pg_temp.id('p_in'), pg_temp.id('prj_a'), 'In', now() - interval '3 hours', null, pg_temp.id('sh_frank'),
  25.775, -80.195, 8, pg_temp.id('fence'));
select is(((select punch from punches where key = 'in')).effective_at, now() - interval '3 hours', 'a device time within tolerance counts');
select is(((select punch from punches where key = 'in')).skew_flagged, false, 'and is not flagged');
select is(((select punch from punches where key = 'in')).geofence_verified, true, 'the server finds the point inside the geofence');
select is((select count(*)::int from app.time_entries where membership_id = pg_temp.id('frank@org_a') and clock_out is null), 1, 'In opens a time entry');
select is((select shift_id from app.time_entries where id = ((select punch from punches where key = 'in')).time_entry_id), pg_temp.id('sh_frank'), 'on the accepted shift');
select is((app.record_punch(pg_temp.id('p_in'), pg_temp.id('prj_a'), 'In', now() - interval '3 hours')).time_entry_id,
  ((select punch from punches where key = 'in')).time_entry_id, 'a replayed punch returns the stored punch');
select is((select count(*)::int from app.time_entries where membership_id = pg_temp.id('frank@org_a')), 1, 'and opens nothing new');
select throws_ok($$select app.record_punch(gen_random_uuid(), (select id from world where key = 'prj_a'), 'In', now())$$,
  'XR001', 'punch_already_in: You are already clocked in; clock out first.', 'a second In while clocked in is refused');
select throws_ok($$select app.record_punch((select id from world where key = 'p_in'), (select id from world where key = 'prj_a'), 'Out', now())$$,
  'XR001', null, 'a punch id reused for another kind is refused');

-- Breaks and Out ------------------------------------------------------------------------------------------------
select throws_ok($$select app.record_punch(gen_random_uuid(), (select id from world where key = 'prj_a'), 'Break End', now() - interval '2 hours')$$,
  'XR001', 'punch_no_break: No break is running.', 'a break cannot end before it starts');
select lives_ok($$select app.record_punch((select id from world where key = 'p_bs'), (select id from world where key = 'prj_a'), 'Break Start', now() - interval '2 hours')$$, 'a break starts');
select throws_ok($$select app.record_punch(gen_random_uuid(), (select id from world where key = 'prj_a'), 'Break Start', now() - interval '110 minutes')$$,
  'XR001', 'punch_break_open: A break is already running; end it first.', 'one break at a time');
select lives_ok($$select app.record_punch((select id from world where key = 'p_be'), (select id from world where key = 'prj_a'), 'Break End', now() - interval '89 minutes 30 seconds')$$, 'the break ends');
select is((select break_minutes from app.time_entries where id = ((select punch from punches where key = 'in')).time_entry_id), 31, 'break minutes round up to whole minutes');
select lives_ok($$select app.record_punch((select id from world where key = 'p_out'), (select id from world where key = 'prj_a'), 'Out', now() - interval '10 minutes', null, null, 25.775, -80.10, 15, (select id from world where key = 'fence'))$$, 'Out closes the entry');
select is((select clock_out from app.time_entries where id = ((select punch from punches where key = 'in')).time_entry_id), now() - interval '10 minutes', 'at the punch time');
select is((select geofence_verified from app.clock_punches where id = pg_temp.id('p_out')), false, 'a point outside the geofence is recorded as outside');
select is((select count(*)::int from app.clock_punches where time_entry_id = ((select punch from punches where key = 'in')).time_entry_id), 4, 'every punch is kept against its entry');
select throws_ok($$select app.record_punch(gen_random_uuid(), (select id from world where key = 'prj_a'), 'Out', now())$$,
  'XR001', 'punch_not_in: You are not clocked in.', 'Out without an open entry is refused');

-- Skew ---------------------------------------------------------------------------------------------------------------
select lives_ok($$select app.record_punch((select id from world where key = 'p_in2'), (select id from world where key = 'prj_a'), 'In', now() + interval '1 hour')$$, 'a punch from a clock running ahead is accepted');
select is((select skew_flagged from app.clock_punches where id = pg_temp.id('p_in2')), true, 'but flagged');
select is((select effective_at from app.clock_punches where id = pg_temp.id('p_in2')), now(), 'and counted at the received time');
select is((select needs_review from app.time_entries t join app.clock_punches c on c.time_entry_id = t.id where c.id = pg_temp.id('p_in2')), true, 'its entry needs review');
select pg_temp.as_platform();
update app.time_entries set clock_in = now() - interval '5 minutes' where id = (select time_entry_id from app.clock_punches where id = pg_temp.id('p_in2'));
select pg_temp.as_user('frank');
select lives_ok($$select app.record_punch((select id from world where key = 'p_out2'), (select id from world where key = 'prj_a'), 'Out', '2020-01-01 00:00+00', 5000)$$, 'a wrong wall clock with a monotonic offset is accepted');
select is((select effective_at from app.clock_punches where id = pg_temp.id('p_out2')), now() - interval '5 seconds', 'and counted at the received time less the offset');

-- Refusals ---------------------------------------------------------------------------------------------------------------
select throws_ok($$select app.record_punch(gen_random_uuid(), (select id from world where key = 'prj_a'), 'In', now(), null, (select id from world where key = 'sh_draft'))$$,
  'XR001', 'punch_shift_not_accepted: Punch on a shift only once it is yours and Accepted.', 'a punch on a shift that is not Accepted is refused');
select throws_ok($$select app.record_punch(gen_random_uuid(), (select id from world where key = 'prj_a'), 'In', now(), null, null, null, null, null, null, 'Kiosk')$$,
  'XR001', null, 'a signed-in device records only Mobile punches');
select pg_temp.as_user('xavier');
select throws_ok($$select app.record_punch(gen_random_uuid(), (select id from world where key = 'prj_a'), 'In', now())$$, '42501', null, 'a person outside the org cannot punch on its project');
select pg_temp.as_anon();
select throws_ok($$select app.record_punch(gen_random_uuid(), (select id from world where key = 'prj_a'), 'In', now())$$, '42501', null, 'anon cannot punch');

-- Kiosk service ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into world select 'kiosk', k.kiosk_device_id from app.register_kiosk_device(pg_temp.id('org_a'), 'Pavilion Gate Kiosk', pg_temp.id('prj_a')) k;
select pg_temp.as_platform();
select is(((app.record_punch(gen_random_uuid(), pg_temp.id('prj_a'), 'In', now() - interval '1 minute', null, null, null, null, null, null, 'Kiosk', pg_temp.id('kiosk'), 'kiosk/photos/erin.jpg', pg_temp.id('erin@org_a'))).source)::text,
  'Kiosk', 'the kiosk service punches for the member whose PIN it verified');
select is((select source::text from app.time_entries where membership_id = pg_temp.id('erin@org_a') and clock_out is null), 'Kiosk', 'and the entry records the kiosk');
select throws_ok($$select app.record_punch(gen_random_uuid(), (select id from world where key = 'prj_a'), 'In', now(), null, null, null, null, null, null, 'Kiosk', (select id from world where key = 'kiosk'))$$,
  'XR001', null, 'a kiosk punch names its worker');

-- External crew ----------------------------------------------------------------------------------------------------------------
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.as_user('ivy');
select is(((app.record_punch(pg_temp.id('p_in3'), pg_temp.id('prj_a'), 'In', now() - interval '1 minute', null, null, null, null, null, null, 'Mobile', null, null, null, pg_temp.id('eng_ivy_a'))).engagement_id),
  pg_temp.id('eng_ivy_a'), 'an engaged external punches on their engagement');
select pg_temp.as_user('quinn');
select throws_ok($$select app.record_punch(gen_random_uuid(), (select id from world where key = 'prj_a'), 'In', now(), null, null, null, null, null, null, 'Mobile', null, null, null, (select id from world where key = 'eng_ivy_a'))$$,
  '42501', null, 'nobody else punches on that engagement');

-- Sync wrapper and schedule --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select ok((app.apply_sync_mutation(gen_random_uuid(), pg_temp.id('org_a'), 'phone-dave', 'app.record_punch',
  jsonb_build_object('p_punch_id', gen_random_uuid(), 'p_project_id', pg_temp.id('prj_a'), 'p_punch_kind', 'In', 'p_device_time', now() - interval '2 minutes'))) ? 'data',
  'an offline punch replays through the sync wrapper');
select pg_temp.as_platform();
select is((select count(*)::int from cron.job where jobname = 'xos_close_stale_time_entries'), 1, 'the 16-hour close is scheduled');

select * from finish();
rollback;
