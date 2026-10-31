-- 2976_weather_feed.sql
-- B8 Weather feed (RRR-232, gap G-150, ADR 0147 decision 8). For a US venue with a location, the weather-feed Edge
-- Function polls the US National Weather Service every 10 minutes during the project window (three days before it
-- starts to the day after it ends, in the project's time zone): the latest observation of the nearest station, the
-- active alerts for the point, and the hourly forecast at most once an hour. The NWS is a public data source and not a
-- subprocessor: only the venue's coordinates, rounded to 4 decimals, are sent (legal/subprocessors.md section 4).
--
--   * Wind and Heat observations become app.weather_readings with source NWS and feed the same thresholds as manual
--     readings. The threshold and alert logic of app.record_weather_reading (0806) moves into
--     private.apply_weather_level, which both call. A station may be miles from the venue, so an NWS reading never
--     lowers or clears an alert a Manual reading raised; it may only raise it. Manual readings behave exactly as in
--     0806. Lightning stays manual.
--   * Official alerts become app.weather_warnings, ended when the NWS cancels them or drops them from the active list.
--     A new Actual alert of severity Extreme or Severe tells the project's alert-role people and dispatchers once
--     (weather.warning).
--   * app.weather_forecast_periods is a provider cache of the next 48 hours, replaced on each fetch with a hard delete:
--     no audit trail and never in Trash.
--   * private.weather_feed_runs logs every run, kept 90 days; app.weather_feed_status summarizes it.

create type app.weather_provider as enum ('NWS');
comment on type app.weather_provider is 'Official weather source a project''s feed reads: NWS, the US National Weather Service (api.weather.gov).';

create type app.weather_reading_source as enum ('Manual', 'NWS');
comment on type app.weather_reading_source is 'Where a weather reading came from: recorded by a person on site, or the NWS feed.';

-- Readings gain their source ----------------------------------------------------------------------------------------------

alter table app.weather_readings add column source app.weather_reading_source not null default 'Manual';
alter table app.weather_readings add constraint weather_readings_source_recorder check (source = 'Manual' or recorded_by_membership_id is null);
create unique index weather_readings_feed_key on app.weather_readings (project_id, hazard, observed_at) where source <> 'Manual';
comment on column app.weather_readings.source is 'Manual (a person recorded it) or NWS (the official feed, from the station nearest the venue). Readings before migration 2976 are Manual.';

-- Feeds -----------------------------------------------------------------------------------------------------------------

create table app.weather_feeds (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  provider app.weather_provider not null default 'NWS',
  nws_forecast_hourly_url text,
  nws_station_id text,
  points_checked_at timestamptz,
  constraint weather_feeds_url check (nws_forecast_hourly_url is null or (nws_forecast_hourly_url ~ '^https://api\.weather\.gov/' and char_length(nws_forecast_hourly_url) <= 300)),
  constraint weather_feeds_station check (nws_station_id is null or nws_station_id ~ '^[A-Z0-9]{3,8}$')
);
call private.install_domain_table('app.weather_feeds', 'app.projects', 'project_id');
create unique index weather_feeds_project_key on app.weather_feeds (project_id) where deleted_at is null;
call private.describe('app.weather_feeds', 'A project''s official weather feed (gap G-150, ADR 0147 decision 8): on while live, off once deleted. Only for a venue with a location in the US. The URL, station and check time are provider facts the worker caches.', array[
  'project_id', 'Project.',
  'provider', 'NWS.',
  'nws_forecast_hourly_url', 'Hourly forecast URL the NWS points endpoint returned for the venue, cached by the worker.',
  'nws_station_id', 'Nearest observation station the NWS listed for the venue, cached by the worker.',
  'points_checked_at', 'When the worker last asked the NWS for the venue''s forecast URL and station; asked again after 30 days.'
]);
call private.install_policies('app.weather_feeds',
  $$project_id in (select private.project_ids_with('safety.incident.read'))$$,
  $$org_id in (select private.orgs_with_capability('safety.emergency_code.write')) and project_id in (select private.readable_project_ids())$$);
call private.install_audit_trail('app.weather_feeds');
call private.install_default_retention('app.weather_feeds');

create function private.weather_feed_supported(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.projects p
    join app.venues v on v.id = p.venue_id and v.deleted_at is null
    join xpms.jurisdiction j on j.jurisdiction_id = v.jurisdiction_id
    where p.id = p_project_id and v.location is not null and j.country = 'US');
$$;
comment on function private.weather_feed_supported(uuid) is 'True when the project''s venue has a location and its jurisdiction is in the US, the area the NWS covers.';
revoke all on function private.weather_feed_supported(uuid) from public, anon, authenticated;

create function private.guard_weather_feed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is null and (tg_op = 'INSERT' or old.deleted_at is not null)
     and not private.weather_feed_supported(new.project_id) then
    perform private.refuse('weather_feed_unsupported', 'The official feed covers US venues with a location.');
  end if;
  return new;
end;
$$;
comment on function private.guard_weather_feed() is 'Weather feeds: turned on only for a project whose venue has a location in the US (weather_feed_unsupported).';
revoke all on function private.guard_weather_feed() from public, anon, authenticated;
create trigger t42_guard_weather_feed before insert or update of deleted_at on app.weather_feeds
  for each row execute function private.guard_weather_feed();

create table private.weather_feed_runs (
  id uuid primary key default private.uuid_v7(),
  weather_feed_id uuid not null references app.weather_feeds (id),
  ran_at timestamptz not null default now(),
  outcome text not null,
  error text,
  constraint weather_feed_runs_outcome check (outcome in ('Succeeded', 'Failed')),
  constraint weather_feed_runs_error check ((outcome = 'Failed') = (error is not null) and (error is null or char_length(error) <= 500))
);
create index weather_feed_runs_feed_ran_idx on private.weather_feed_runs (weather_feed_id, ran_at desc);
comment on table private.weather_feed_runs is 'Every run of a project''s weather feed, succeeded or failed, so no failure is silent; kept 90 days. app.weather_feed_status summarizes it.';
comment on column private.weather_feed_runs.id is 'Run id.';
comment on column private.weather_feed_runs.weather_feed_id is 'Feed.';
comment on column private.weather_feed_runs.ran_at is 'When the run ended.';
comment on column private.weather_feed_runs.outcome is 'Succeeded or Failed.';
comment on column private.weather_feed_runs.error is 'Why a failed run failed (at most 500 characters).';
alter table private.weather_feed_runs enable row level security;
revoke all on private.weather_feed_runs from public, anon, authenticated;
grant select on private.weather_feed_runs to service_role;

create function app.weather_feed_status(p_project_id uuid)
returns table (
  feed_id uuid,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text,
  failures_since_success integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_feed uuid := (select f.id from app.weather_feeds f where f.project_id = p_project_id and f.deleted_at is null);
begin
  perform private.require_person();
  if not private.can_on_project(p_project_id, 'safety.incident.read') then
    raise exception using errcode = '42501', message = 'the weather feed needs safety.incident.read on the project';
  end if;
  if v_feed is null then
    return;
  end if;
  return query
    select v_feed,
      (select max(r.ran_at) from private.weather_feed_runs r where r.weather_feed_id = v_feed and r.outcome = 'Succeeded'),
      (select r.ran_at from private.weather_feed_runs r where r.weather_feed_id = v_feed and r.outcome = 'Failed' order by r.ran_at desc limit 1),
      (select r.error from private.weather_feed_runs r where r.weather_feed_id = v_feed and r.outcome = 'Failed' order by r.ran_at desc limit 1),
      (select count(*)::integer from private.weather_feed_runs r
        where r.weather_feed_id = v_feed and r.outcome = 'Failed'
          and r.ran_at > coalesce((select max(s.ran_at) from private.weather_feed_runs s
                                   where s.weather_feed_id = v_feed and s.outcome = 'Succeeded'), '-infinity'::timestamptz));
end;
$$;
comment on function app.weather_feed_status(uuid) is 'A project''s weather feed for the Weather page (safety.incident.read): its id, when it last succeeded, its last failure and reason, and how many runs failed since the last success. No row while the feed is off.';
revoke all on function app.weather_feed_status(uuid) from public, anon;
grant execute on function app.weather_feed_status(uuid) to authenticated, service_role;

-- Warnings and forecast ---------------------------------------------------------------------------------------------------------

create table app.weather_warnings (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  provider app.weather_provider not null default 'NWS',
  provider_alert_id text not null,
  event text not null,
  severity text not null,
  certainty text,
  urgency text,
  headline text,
  description text,
  instruction text,
  onset timestamptz,
  expires_at timestamptz,
  ends_at timestamptz,
  sent_at timestamptz,
  ended_at timestamptz,
  constraint weather_warnings_alert_id_length check (char_length(provider_alert_id) between 1 and 300),
  constraint weather_warnings_event_length check (char_length(btrim(event)) between 1 and 200),
  constraint weather_warnings_severity check (severity in ('Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown')),
  constraint weather_warnings_certainty_length check (certainty is null or char_length(certainty) <= 40),
  constraint weather_warnings_urgency_length check (urgency is null or char_length(urgency) <= 40),
  constraint weather_warnings_headline_length check (headline is null or char_length(headline) <= 300),
  constraint weather_warnings_description_length check (description is null or char_length(description) <= 4000),
  constraint weather_warnings_instruction_length check (instruction is null or char_length(instruction) <= 2000)
);
create unique index weather_warnings_alert_key on app.weather_warnings (project_id, provider_alert_id);
create index weather_warnings_active_idx on app.weather_warnings (project_id, ended_at);
call private.install_domain_table('app.weather_warnings', 'app.projects', 'project_id');
call private.describe('app.weather_warnings', 'Official weather alerts for a project''s venue (gap G-150), as the NWS issued them, in English. Written only by the weather feed; ended when the NWS cancels the alert or drops it from the active list.', array[
  'project_id', 'Project.',
  'provider', 'NWS.',
  'provider_alert_id', 'The provider''s alert identifier.',
  'event', 'Alert event, such as Severe Thunderstorm Warning.',
  'severity', 'Extreme, Severe, Moderate, Minor or Unknown.',
  'certainty', 'Certainty as the provider gave it, such as Observed or Likely.',
  'urgency', 'Urgency as the provider gave it, such as Immediate or Expected.',
  'headline', 'Headline, up to 300 characters.',
  'description', 'Description, up to 4,000 characters.',
  'instruction', 'What to do, up to 2,000 characters.',
  'onset', 'When the hazard is expected to begin.',
  'expires_at', 'When the alert message expires.',
  'ends_at', 'When the hazard is expected to end.',
  'sent_at', 'When the provider sent the alert.',
  'ended_at', 'When the feed saw the alert canceled or no longer active.'
]);
call private.install_policies('app.weather_warnings', $$project_id in (select private.project_ids_with('safety.incident.read'))$$);
insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.weather_warnings', 'Age', 'created_at', interval '2 years', 'Delete', 'Official alerts kept two years with the project''s safety record.')
on conflict (table_name) do nothing;

create table app.weather_forecast_periods (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  provider app.weather_provider not null default 'NWS',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  temperature_f numeric,
  wind_speed_mph numeric,
  precipitation_percent smallint,
  short_forecast text,
  fetched_at timestamptz not null default now(),
  constraint weather_forecast_periods_window check (ends_at > starts_at),
  constraint weather_forecast_periods_precipitation check (precipitation_percent is null or precipitation_percent between 0 and 100),
  constraint weather_forecast_periods_short_length check (short_forecast is null or char_length(short_forecast) <= 200)
);
create index weather_forecast_periods_project_idx on app.weather_forecast_periods (project_id, starts_at);
call private.install_domain_table('app.weather_forecast_periods', 'app.projects', 'project_id');
call private.describe('app.weather_forecast_periods', 'The provider''s hourly forecast for a project''s venue, at most the next 48 periods (gap G-150). A cache: each fetch replaces the project''s rows, with no audit trail.', array[
  'project_id', 'Project.',
  'provider', 'NWS.',
  'starts_at', 'Start of the period.',
  'ends_at', 'End of the period.',
  'temperature_f', 'Temperature in °F.',
  'wind_speed_mph', 'Sustained wind speed in mph, the upper end when the provider gives a range.',
  'precipitation_percent', 'Probability of precipitation, 0 to 100, as the provider gives it.',
  'short_forecast', 'Short forecast text, in English.',
  'fetched_at', 'When the feed fetched it.'
]);
call private.install_policies('app.weather_forecast_periods', $$project_id in (select private.project_ids_with('safety.incident.read'))$$);
insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.weather_forecast_periods', 'Age', 'created_at', interval '7 days', 'Delete', 'Provider cache, replaced on each fetch.')
on conflict (table_name) do nothing;
insert into private.trash_excluded_tables (table_name, rationale) values
  ('weather_forecast_periods', 'A provider cache the weather feed replaces on each fetch; nothing a person deletes or restores.')
on conflict (table_name) do nothing;

do $$
declare
  v_table text;
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    foreach v_table in array array['weather_warnings'] loop
      if not exists (select 1 from pg_catalog.pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'app' and tablename = v_table) then
        execute format('alter publication supabase_realtime add table app.%I', v_table);
      end if;
    end loop;
  end if;
end;
$$;

-- Thresholds and alerts (from 0806 app.record_weather_reading) ------------------------------------------------------------

create function private.apply_weather_level(
  p_project_id uuid,
  p_hazard app.weather_hazard,
  p_value numeric,
  p_reading_id uuid,
  p_source app.weather_reading_source
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select p.org_id from app.projects p where p.id = p_project_id);
  v_level app.weather_alert_level;
  v_active app.weather_alerts;
  v_active_source app.weather_reading_source;
  v_alert uuid;
  v_person uuid;
begin
  select t.alert_level into v_level from app.weather_thresholds t
  where t.project_id = p_project_id and t.hazard = p_hazard and t.deleted_at is null
    and ((t.comparison = 'At or Above' and p_value >= t.threshold_value) or (t.comparison = 'At or Below' and p_value <= t.threshold_value))
  order by t.alert_level desc limit 1;
  select * into v_active from app.weather_alerts a where a.project_id = p_project_id and a.hazard = p_hazard and a.cleared_at is null;
  if v_level is not distinct from v_active.alert_level then
    return;
  end if;
  if p_source = 'NWS' and v_active.id is not null then
    select r.source into v_active_source from app.weather_readings r where r.id = v_active.weather_reading_id;
    if v_active_source = 'Manual' and (v_level is null or v_level < v_active.alert_level) then
      return;
    end if;
  end if;
  if v_active.id is not null then
    update app.weather_alerts set cleared_at = now() where id = v_active.id;
    if v_level is null then
      perform private.emit_event(v_org, 'weather_alert.cleared', 'weather_alerts', v_active.id, p_project_id,
        jsonb_build_object('hazard', p_hazard, 'reading', p_value));
    end if;
  end if;
  if v_level is not null then
    insert into app.weather_alerts (project_id, hazard, alert_level, weather_reading_id) values (p_project_id, p_hazard, v_level, p_reading_id)
    returning id into v_alert;
    perform private.emit_event(v_org, 'weather_alert.raised', 'weather_alerts', v_alert, p_project_id,
      jsonb_build_object('hazard', p_hazard, 'level', v_level, 'reading', p_value));
    for v_person in
      select distinct ra.person_id from app.role_assignments ra
      join app.weather_alert_roles r on r.project_id = ra.project_id and r.role_code = ra.role_code and r.deleted_at is null and r.alert_level = v_level
      where ra.project_id = p_project_id and ra.person_id is not null and ra.deleted_at is null
      union
      select private.project_member_people_with(p_project_id, 'safety.incident.dispatch')
    loop
      perform private.notify(v_org, v_person, 'weather.alert', 'app.weather_alerts', v_alert, p_project_id,
        jsonb_build_object('hazard', p_hazard, 'level', v_level, 'reading', p_value));
    end loop;
  end if;
end;
$$;
comment on function private.apply_weather_level(uuid, app.weather_hazard, numeric, uuid, app.weather_reading_source) is 'A new weather reading against the project''s thresholds (the logic of 0806 app.record_weather_reading): the highest Monitor, Restrict or Evacuate level it meets raises an alert to the canon roles named for that level and the project''s dispatchers (weather.alert); a reading below every level clears the hazard''s alert. An NWS reading never lowers or clears an alert a Manual reading raised; it may only raise it.';
revoke all on function private.apply_weather_level(uuid, app.weather_hazard, numeric, uuid, app.weather_reading_source) from public, anon, authenticated;

create or replace function app.record_weather_reading(p_project_id uuid, p_hazard app.weather_hazard, p_value numeric, p_observed_at timestamptz default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select p.org_id from app.projects p where p.id = p_project_id and p.deleted_at is null);
  v_reading uuid;
begin
  perform private.require_person();
  if v_org is null or not private.can_on_project(p_project_id, 'safety.incident.write') then
    raise exception using errcode = '42501', message = 'recording weather needs safety.incident.write on the project';
  end if;
  insert into app.weather_readings (project_id, hazard, reading_value, observed_at, recorded_by_membership_id, source)
  values (p_project_id, p_hazard, p_value, coalesce(p_observed_at, now()), private.my_membership_in(v_org), 'Manual')
  returning id into v_reading;
  perform private.apply_weather_level(p_project_id, p_hazard, p_value, v_reading, 'Manual');
  return v_reading;
end;
$$;
comment on function app.record_weather_reading(uuid, app.weather_hazard, numeric, timestamptz) is 'Records a weather reading on a project (safety.incident.write). The highest Monitor, Restrict or Evacuate threshold it meets raises an alert to the canon roles named for that level and the project''s dispatchers; a reading below every level clears the hazard''s alert (private.apply_weather_level). Returns the reading id.';
revoke all on function app.record_weather_reading(uuid, app.weather_hazard, numeric, timestamptz) from public, anon;
grant execute on function app.record_weather_reading(uuid, app.weather_hazard, numeric, timestamptz) to authenticated, service_role;

-- The worker (service role) -------------------------------------------------------------------------------------------------------

create function app.record_weather_feed_failure(p_feed_id uuid, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from private.weather_feed_runs r where r.weather_feed_id = p_feed_id and r.ran_at < now() - interval '90 days';
  insert into private.weather_feed_runs (weather_feed_id, outcome, error)
  values (p_feed_id, 'Failed', left(coalesce(nullif(btrim(p_error), ''), 'The feed failed without a message.'), 500));
$$;
comment on function app.record_weather_feed_failure(uuid, text) is 'Records a failed weather feed run with its reason (at most 500 characters), so the Weather page can say the feed is stale. Runs older than 90 days are removed. Service role only.';
revoke all on function app.record_weather_feed_failure(uuid, text) from public, anon, authenticated;
grant execute on function app.record_weather_feed_failure(uuid, text) to service_role;

create function app.due_weather_feeds()
returns table (
  feed_id uuid,
  project_id uuid,
  latitude numeric,
  longitude numeric,
  nws_forecast_hourly_url text,
  nws_station_id text,
  points_checked_at timestamptz,
  forecast_fetched_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_feed record;
begin
  for v_feed in
    select f.id, f.project_id, f.nws_forecast_hourly_url, f.nws_station_id, f.points_checked_at, v.location,
      j.country
    from app.weather_feeds f
    join app.projects p on p.id = f.project_id and p.deleted_at is null and p.archived_at is null
    left join app.venues v on v.id = p.venue_id and v.deleted_at is null
    left join xpms.jurisdiction j on j.jurisdiction_id = v.jurisdiction_id
    where f.deleted_at is null
      and (now() at time zone p.time_zone)::date between coalesce(p.starts_on - 3, '-infinity'::date) and coalesce(p.ends_on + 1, 'infinity'::date)
      and not exists (select 1 from private.weather_feed_runs r where r.weather_feed_id = f.id and r.ran_at > now() - interval '9 minutes')
  loop
    if v_feed.location is null or v_feed.country is distinct from 'US' then
      perform app.record_weather_feed_failure(v_feed.id, 'The project''s venue no longer has a location in the US, so the official feed cannot run.');
      continue;
    end if;
    return query select v_feed.id, v_feed.project_id,
      round(extensions.st_y(v_feed.location::extensions.geometry)::numeric, 4),
      round(extensions.st_x(v_feed.location::extensions.geometry)::numeric, 4),
      v_feed.nws_forecast_hourly_url, v_feed.nws_station_id, v_feed.points_checked_at,
      (select max(w.fetched_at) from app.weather_forecast_periods w where w.project_id = v_feed.project_id);
  end loop;
end;
$$;
comment on function app.due_weather_feeds() is 'The weather feeds the worker polls now (service role): live, of a project that is neither deleted nor archived, today in the project''s time zone between three days before it starts and the day after it ends, and not run in the last 9 minutes. Gives the venue''s coordinates rounded to 4 decimals, the cached forecast URL and station, and when the forecast was last fetched. A feed whose venue has since lost its location or left the US records a failed run instead.';
revoke all on function app.due_weather_feeds() from public, anon, authenticated;
grant execute on function app.due_weather_feeds() to service_role;

create function app.record_weather_feed(p_feed_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_feed app.weather_feeds;
  v_org uuid;
  v_obs jsonb := p_payload -> 'observation';
  v_observed timestamptz;
  v_hazard app.weather_hazard;
  v_value numeric;
  v_reading uuid;
  v_readings integer := 0;
  v_alert jsonb;
  v_warning app.weather_warnings;
  v_new boolean;
  v_person uuid;
  v_ids text[] := '{}';
  v_notified integer := 0;
  v_forecast integer := 0;
begin
  select * into v_feed from app.weather_feeds f where f.id = p_feed_id and f.deleted_at is null;
  if v_feed.id is null then
    raise exception using errcode = '42501', message = 'the weather feed does not exist or is off';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object'
     or (p_payload ? 'alerts' and jsonb_typeof(p_payload -> 'alerts') not in ('array', 'null'))
     or (p_payload ? 'forecast' and jsonb_typeof(p_payload -> 'forecast') not in ('array', 'null'))
     or (p_payload ? 'observation' and jsonb_typeof(v_obs) not in ('object', 'null')) then
    perform private.refuse('weather_feed_payload', 'The weather feed payload is not in the expected shape.');
  end if;
  v_org := v_feed.org_id;

  -- Feed metadata.
  if p_payload ? 'points' and jsonb_typeof(p_payload -> 'points') = 'object' then
    update app.weather_feeds set nws_forecast_hourly_url = p_payload -> 'points' ->> 'forecast_hourly_url',
      nws_station_id = p_payload -> 'points' ->> 'station_id', points_checked_at = now()
    where id = v_feed.id;
  end if;

  -- Readings: Wind in mph and Heat in °F, converted by the worker from the observation's units.
  if jsonb_typeof(v_obs) = 'object' and v_obs ->> 'observed_at' is not null then
    v_observed := (v_obs ->> 'observed_at')::timestamptz;
    foreach v_hazard in array array['Wind', 'Heat']::app.weather_hazard[] loop
      v_value := (v_obs ->> case v_hazard when 'Wind' then 'wind_mph' else 'heat_f' end)::numeric;
      continue when v_value is null or v_value < 0 or v_value > 200 or v_observed > now() + interval '5 minutes';
      continue when exists (select 1 from app.weather_readings r where r.project_id = v_feed.project_id and r.hazard = v_hazard
                            and r.source = 'NWS' and r.observed_at >= v_observed);
      insert into app.weather_readings (project_id, hazard, reading_value, observed_at, source)
      values (v_feed.project_id, v_hazard, round(v_value, 1), v_observed, 'NWS')
      returning id into v_reading;
      v_readings := v_readings + 1;
      perform private.apply_weather_level(v_feed.project_id, v_hazard, round(v_value, 1), v_reading, 'NWS');
    end loop;
  end if;

  -- Warnings, upserted by the provider's id.
  if jsonb_typeof(p_payload -> 'alerts') = 'array' then
    for v_alert in select * from jsonb_array_elements(p_payload -> 'alerts') loop
      continue when v_alert ->> 'id' is null or coalesce(v_alert ->> 'event', '') = '';
      v_ids := v_ids || (v_alert ->> 'id');
      select * into v_warning from app.weather_warnings w where w.project_id = v_feed.project_id and w.provider_alert_id = v_alert ->> 'id';
      v_new := v_warning.id is null;
      if v_new then
        insert into app.weather_warnings (project_id, provider, provider_alert_id, event, severity, certainty, urgency, headline,
          description, instruction, onset, expires_at, ends_at, sent_at, ended_at)
        values (v_feed.project_id, 'NWS', left(v_alert ->> 'id', 300), left(v_alert ->> 'event', 200),
          case when v_alert ->> 'severity' in ('Extreme', 'Severe', 'Moderate', 'Minor') then v_alert ->> 'severity' else 'Unknown' end,
          left(v_alert ->> 'certainty', 40), left(v_alert ->> 'urgency', 40), left(v_alert ->> 'headline', 300),
          left(v_alert ->> 'description', 4000), left(v_alert ->> 'instruction', 2000),
          (v_alert ->> 'onset')::timestamptz, (v_alert ->> 'expires')::timestamptz, (v_alert ->> 'ends')::timestamptz,
          (v_alert ->> 'sent')::timestamptz, case when v_alert ->> 'message_type' = 'Cancel' then now() end)
        returning * into v_warning;
      else
        update app.weather_warnings set headline = left(v_alert ->> 'headline', 300), description = left(v_alert ->> 'description', 4000),
          instruction = left(v_alert ->> 'instruction', 2000), expires_at = (v_alert ->> 'expires')::timestamptz,
          ends_at = (v_alert ->> 'ends')::timestamptz,
          ended_at = case when v_alert ->> 'message_type' = 'Cancel' then coalesce(ended_at, now()) else ended_at end
        where id = v_warning.id;
      end if;
      if v_alert ->> 'message_type' = 'Cancel' and jsonb_typeof(v_alert -> 'references') = 'array' then
        update app.weather_warnings set ended_at = now()
        where project_id = v_feed.project_id and ended_at is null
          and provider_alert_id in (select jsonb_array_elements_text(v_alert -> 'references'));
      end if;
      if v_new and coalesce(v_alert ->> 'status', 'Actual') = 'Actual' and coalesce(v_alert ->> 'message_type', 'Alert') <> 'Cancel'
         and v_warning.severity in ('Extreme', 'Severe') then
        for v_person in
          select distinct ra.person_id from app.role_assignments ra
          join app.weather_alert_roles r on r.project_id = ra.project_id and r.role_code = ra.role_code and r.deleted_at is null
          where ra.project_id = v_feed.project_id and ra.person_id is not null and ra.deleted_at is null
          union
          select private.project_member_people_with(v_feed.project_id, 'safety.incident.dispatch')
        loop
          perform private.notify(v_org, v_person, 'weather.warning', 'app.weather_warnings', v_warning.id, v_feed.project_id,
            jsonb_build_object('event', v_warning.event, 'severity', v_warning.severity, 'headline', coalesce(v_warning.headline, v_warning.event),
              'ends_at', coalesce(v_warning.ends_at, v_warning.expires_at)));
          v_notified := v_notified + 1;
        end loop;
      end if;
    end loop;
    update app.weather_warnings set ended_at = now()
    where project_id = v_feed.project_id and ended_at is null and not (provider_alert_id = any (v_ids));
  end if;

  -- Forecast, replaced.
  if jsonb_typeof(p_payload -> 'forecast') = 'array' then
    delete from app.weather_forecast_periods w where w.project_id = v_feed.project_id;
    insert into app.weather_forecast_periods (project_id, provider, starts_at, ends_at, temperature_f, wind_speed_mph,
      precipitation_percent, short_forecast)
    select v_feed.project_id, 'NWS', (x ->> 'starts_at')::timestamptz, (x ->> 'ends_at')::timestamptz,
      (x ->> 'temperature_f')::numeric, (x ->> 'wind_speed_mph')::numeric,
      case when (x ->> 'precipitation_percent')::numeric between 0 and 100 then round((x ->> 'precipitation_percent')::numeric)::smallint end,
      left(x ->> 'short_forecast', 200)
    from (select x from jsonb_array_elements(p_payload -> 'forecast') with ordinality t (x, n)
          where x ->> 'starts_at' is not null and x ->> 'ends_at' is not null
            and (x ->> 'ends_at')::timestamptz > (x ->> 'starts_at')::timestamptz
            and (x ->> 'ends_at')::timestamptz > now()
          order by (x ->> 'starts_at')::timestamptz
          limit 48) f;
    get diagnostics v_forecast = row_count;
  end if;

  delete from private.weather_feed_runs r where r.weather_feed_id = v_feed.id and r.ran_at < now() - interval '90 days';
  insert into private.weather_feed_runs (weather_feed_id, outcome) values (v_feed.id, 'Succeeded');
  return jsonb_build_object('readings', v_readings, 'warnings', cardinality(v_ids), 'notified', v_notified, 'forecast_periods', v_forecast);
end;
$$;
comment on function app.record_weather_feed(uuid, jsonb) is 'Records one poll of a project''s NWS feed in one transaction (service role, the weather-feed Edge Function): the cached forecast URL and station; Wind (mph) and Heat (°F) readings with source NWS when present, between 0 and 200 and newer than the last NWS reading of the hazard, each through private.apply_weather_level; the active alerts upserted by the provider''s id, a Cancel or an alert missing from the active list ending them, and a new Actual Extreme or Severe alert telling the alert-role people and dispatchers once (weather.warning); the forecast replaced with the next 48 periods; and a Succeeded run. A rerun with the same observation writes no reading. Returns counts.';
revoke all on function app.record_weather_feed(uuid, jsonb) from public, anon, authenticated;
grant execute on function app.record_weather_feed(uuid, jsonb) to service_role;

create function private.request_weather_feed()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_key text;
begin
  if not exists (select 1 from app.weather_feeds f where f.deleted_at is null) then
    return;
  end if;
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'xos_functions_url';
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'xos_worker_key';
  if v_url is null or v_key is null then
    return;
  end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/weather-feed',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;
comment on function private.request_weather_feed() is 'pg_cron''s weather step: while any weather feed is on, calls the weather-feed Edge Function with the service key from Vault (xos_worker_key) at the functions URL in Vault (xos_functions_url). Without either it does nothing (infra/runbooks/production.md, Edge Functions).';
revoke all on function private.request_weather_feed() from public, anon, authenticated;

select cron.schedule('xos_weather_feed', '*/10 * * * *', 'select private.request_weather_feed()');
