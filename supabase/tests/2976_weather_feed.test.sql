-- pgTAP: migration 2976 (B8, G-150), the NWS weather feed. A feed needs a US venue with a location; the worker's
-- functions are service-role only; due feeds respect the window and the 9-minute rule; record_weather_feed writes NWS
-- readings once, which raise alerts through private.apply_weather_level, never lower or clear one a Manual reading raised;
-- warnings are stored once, notify once and only for Severe and Extreme, and end on a Cancel or when dropped; the
-- forecast is replaced; failures show in the status. Manual readings behave as in 0806.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select no_plan();

create function pg_temp.notified(p_who text, p_kind text) returns integer
language sql security definer as $$
  select count(*)::int from app.notifications n where n.recipient_person_id = pg_temp.id(p_who) and n.kind = p_kind
$$;

-- The guard -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$insert into app.weather_feeds (project_id) values ((select id from world where key = 'prj_a'))$$,
  'XR001', 'weather_feed_unsupported: The official feed covers US venues with a location.', 'a venue without a location has no feed');
select throws_ok($$insert into app.weather_feeds (project_id) values ((select id from world where key = 'prj_a2'))$$,
  'XR001', null, 'nor a project without a venue');
select pg_temp.as_platform();
update app.venues set location = 'SRID=4326;POINT(-80.123456 25.765432)'::extensions.geography where id = pg_temp.id('venue_a');
with x as (insert into app.venues (org_id, name, jurisdiction_id, time_zone, location)
  values (pg_temp.id('org_a'), 'Thames Pavilion', (select j.jurisdiction_id from xpms.jurisdiction j where j.country = 'GB' order by j.ordinal limit 1),
          'Europe/London', 'SRID=4326;POINT(-0.12 51.5)'::extensions.geography) returning id) insert into world select 'venue_gb', id from x;
update app.projects set venue_id = pg_temp.id('venue_gb') where id = pg_temp.id('prj_a2');
select pg_temp.as_user('carol');
select throws_ok($$insert into app.weather_feeds (project_id) values ((select id from world where key = 'prj_a2'))$$,
  'XR001', 'weather_feed_unsupported: The official feed covers US venues with a location.', 'a venue outside the US has no feed');
with x as (insert into app.weather_feeds (project_id) values (pg_temp.id('prj_a')) returning id) insert into world select 'feed', id from x;
select ok(pg_temp.id('feed') is not null, 'a located US venue''s project turns the feed on');
select pg_temp.as_user('dave');
update app.weather_feeds set deleted_at = now() where id = pg_temp.id('feed');
select pg_temp.as_platform();
select is((select deleted_at from app.weather_feeds where id = pg_temp.id('feed')), null, 'turning it off needs safety.emergency_code.write');

-- Thresholds and alert roles --------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.weather_thresholds (org_id, project_id, hazard, alert_level, threshold_value, unit, comparison, source_note) values
  (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Wind', 'Monitor', 20, 'mph', 'At or Above', 'Emergency plan 4.2'),
  (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Wind', 'Restrict', 30, 'mph', 'At or Above', 'Emergency plan 4.2'),
  (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Heat', 'Monitor', 95, 'F', 'At or Above', 'Emergency plan 4.4');
insert into app.role_assignments (project_id, role_code, person_id) values (pg_temp.id('prj_a'), (select role_code from xpms.dim_role order by role_code limit 1), pg_temp.id('erin'));
insert into app.weather_alert_roles (org_id, project_id, alert_level, role_code) values
  (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Monitor', (select role_code from xpms.dim_role order by role_code limit 1));

-- Service role only ---------------------------------------------------------------------------------------------------------------
select throws_ok($$select * from app.due_weather_feeds()$$, '42501', null, 'staff cannot list due feeds');
select throws_ok($$select app.record_weather_feed((select id from world where key = 'feed'), '{}')$$, '42501', null, 'nor record a feed');
select pg_temp.as_platform();
select is((select count(*)::int from app.due_weather_feeds() where feed_id = pg_temp.id('feed')), 1, 'the feed is due: no window set and never polled');
select is((select latitude::text || ',' || longitude::text from app.due_weather_feeds() where feed_id = pg_temp.id('feed')), '25.7654,-80.1235',
  'with the venue''s coordinates rounded to 4 decimals');

-- A poll ----------------------------------------------------------------------------------------------------------------------------
select is(app.record_weather_feed(pg_temp.id('feed'), jsonb_build_object(
  'points', jsonb_build_object('forecast_hourly_url', 'https://api.weather.gov/gridpoints/MFL/110,50/forecast/hourly', 'station_id', 'KMIA'),
  'observation', jsonb_build_object('observed_at', now() - interval '20 minutes', 'wind_mph', 33.6, 'heat_f', 91.4),
  'alerts', jsonb_build_array(
    jsonb_build_object('id', 'urn:oid:2.49.0.1.840.0.a', 'event', 'Severe Thunderstorm Warning', 'severity', 'Severe', 'certainty', 'Observed',
      'urgency', 'Immediate', 'headline', 'Severe Thunderstorm Warning until 6 PM EDT', 'status', 'Actual', 'message_type', 'Alert',
      'ends', now() + interval '2 hours'),
    jsonb_build_object('id', 'urn:oid:2.49.0.1.840.0.b', 'event', 'Heat Advisory', 'severity', 'Moderate', 'status', 'Actual', 'message_type', 'Alert')),
  'forecast', jsonb_build_array(
    jsonb_build_object('starts_at', now(), 'ends_at', now() + interval '1 hour', 'temperature_f', 88, 'wind_speed_mph', 15, 'precipitation_percent', 40, 'short_forecast', 'Chance Showers'),
    jsonb_build_object('starts_at', now() + interval '1 hour', 'ends_at', now() + interval '2 hours', 'temperature_f', 86, 'wind_speed_mph', 12, 'precipitation_percent', 60, 'short_forecast', 'Showers')))) ->> 'readings',
  '2', 'a poll writes a Wind and a Heat reading');
select is((select string_agg(hazard::text || ':' || reading_value::text || ':' || source::text, ',' order by hazard) from app.weather_readings where project_id = pg_temp.id('prj_a')),
  'Wind:33.6:NWS,Heat:91.4:NWS', 'both with source NWS and no recorder');
select is((select alert_level::text from app.weather_alerts where project_id = pg_temp.id('prj_a') and hazard = 'Wind' and cleared_at is null), 'Restrict',
  'a wind reading above a threshold raises the alert as a manual reading does');
select ok(pg_temp.notified('erin', 'weather.alert') = 0, 'erin''s role is named for Monitor only');
select is((select nws_station_id from app.weather_feeds where id = pg_temp.id('feed')), 'KMIA', 'the station is cached');
select is((select count(*)::int from app.weather_warnings where project_id = pg_temp.id('prj_a')), 2, 'both alerts are stored');
select is(pg_temp.notified('erin', 'weather.warning'), 1, 'a Severe warning tells the alert-role people');
select is(pg_temp.notified('carol', 'weather.warning'), 1, 'and the dispatchers, once each');
select is((select count(*)::int from app.weather_forecast_periods where project_id = pg_temp.id('prj_a')), 2, 'the forecast is stored');
select is((select count(*)::int from app.due_weather_feeds() where feed_id = pg_temp.id('feed')), 0, 'a feed polled in the last 9 minutes is not due');

-- A rerun ----------------------------------------------------------------------------------------------------------------------------
select is(app.record_weather_feed(pg_temp.id('feed'), jsonb_build_object(
  'observation', jsonb_build_object('observed_at', now() - interval '20 minutes', 'wind_mph', 33.6, 'heat_f', 91.4),
  'alerts', jsonb_build_array(
    jsonb_build_object('id', 'urn:oid:2.49.0.1.840.0.a', 'event', 'Severe Thunderstorm Warning', 'severity', 'Severe', 'status', 'Actual', 'message_type', 'Alert')),
  'forecast', jsonb_build_array(
    jsonb_build_object('starts_at', now() + interval '2 hours', 'ends_at', now() + interval '3 hours', 'temperature_f', 84, 'precipitation_percent', 20)))) ->> 'readings',
  '0', 'a rerun with the same observation writes no reading');
select is(pg_temp.notified('erin', 'weather.warning'), 1, 'a known warning notifies nobody again');
select is((select ended_at is not null from app.weather_warnings where provider_alert_id = 'urn:oid:2.49.0.1.840.0.b'), true, 'an alert dropped from the active list ends');
select is((select count(*)::int from app.weather_forecast_periods where project_id = pg_temp.id('prj_a')), 1, 'the forecast is replaced');

-- A Cancel, and a Moderate alert notifies nobody -----------------------------------------------------------------------------------------
select app.record_weather_feed(pg_temp.id('feed'), jsonb_build_object('alerts', jsonb_build_array(
  jsonb_build_object('id', 'urn:oid:2.49.0.1.840.0.c', 'event', 'Severe Thunderstorm Warning', 'severity', 'Severe', 'status', 'Actual',
    'message_type', 'Cancel', 'references', jsonb_build_array('urn:oid:2.49.0.1.840.0.a')),
  jsonb_build_object('id', 'urn:oid:2.49.0.1.840.0.d', 'event', 'Wind Advisory', 'severity', 'Moderate', 'status', 'Actual', 'message_type', 'Alert'))));
select is((select ended_at is not null from app.weather_warnings where provider_alert_id = 'urn:oid:2.49.0.1.840.0.a'), true, 'a Cancel ends the warning it references');
select is(pg_temp.notified('erin', 'weather.warning'), 1, 'neither the Cancel nor a Moderate alert notifies');

-- An NWS reading never lowers a Manual alert ----------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select app.record_weather_reading(pg_temp.id('prj_a'), 'Wind', 21);
select is((select alert_level::text from app.weather_alerts where project_id = pg_temp.id('prj_a') and hazard = 'Wind' and cleared_at is null), 'Monitor',
  'a manual reading lowers the level as in 0806');
select pg_temp.as_platform();
select app.record_weather_feed(pg_temp.id('feed'), jsonb_build_object('observation', jsonb_build_object('observed_at', now() - interval '5 minutes', 'wind_mph', 8)));
select is((select alert_level::text from app.weather_alerts where project_id = pg_temp.id('prj_a') and hazard = 'Wind' and cleared_at is null), 'Monitor',
  'a calm NWS reading never clears an alert a manual reading raised');
select app.record_weather_feed(pg_temp.id('feed'), jsonb_build_object('observation', jsonb_build_object('observed_at', now() - interval '1 minute', 'wind_mph', 31)));
select is((select alert_level::text from app.weather_alerts where project_id = pg_temp.id('prj_a') and hazard = 'Wind' and cleared_at is null), 'Restrict',
  'but a stronger NWS reading raises it');
select app.record_weather_feed(pg_temp.id('feed'), jsonb_build_object('observation', jsonb_build_object('observed_at', now(), 'wind_mph', 5)));
select is((select count(*)::int from app.weather_alerts where project_id = pg_temp.id('prj_a') and hazard = 'Wind' and cleared_at is null), 0,
  'and an alert the NWS raised, the NWS may clear');

-- Failures and status ------------------------------------------------------------------------------------------------------------------
update private.weather_feed_runs set ran_at = ran_at - interval '1 minute' where weather_feed_id = pg_temp.id('feed');
select app.record_weather_feed_failure(pg_temp.id('feed'), 'XOS_WEATHER_USER_AGENT is not set');
select pg_temp.as_user('gina');
select is((select last_error || ':' || failures_since_success from app.weather_feed_status(pg_temp.id('prj_a'))), 'XOS_WEATHER_USER_AGENT is not set:1',
  'the status shows the failure and how many since the last success');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.weather_feed_status((select id from world where key = 'prj_a'))$$, '42501', null, 'another org cannot read the status');
select is((select count(*)::int from app.weather_warnings), 0, 'nor the warnings');
select pg_temp.as_platform();
select throws_ok($$select app.record_weather_feed((select id from world where key = 'feed'), '[]')$$,
  'XR001', 'weather_feed_payload: The weather feed payload is not in the expected shape.', 'a payload of the wrong shape is refused');
update app.venues set location = null where id = pg_temp.id('venue_a');
set local session_replication_role = replica;
delete from private.weather_feed_runs where weather_feed_id = pg_temp.id('feed');
set local session_replication_role = origin;
select is((select count(*)::int from app.due_weather_feeds()), 0, 'a venue that lost its location is not polled');
select is((select error from private.weather_feed_runs where weather_feed_id = pg_temp.id('feed') order by ran_at desc limit 1),
  'The project''s venue no longer has a location in the US, so the official feed cannot run.', 'and records a failed run saying why');
select is((select count(*)::int from cron.job where jobname = 'xos_weather_feed' and schedule = '*/10 * * * *'), 1, 'pg_cron polls every 10 minutes');
select lives_ok($$select private.request_weather_feed()$$, 'the request is a no-op without the Vault secrets');

select * from finish();
rollback;
