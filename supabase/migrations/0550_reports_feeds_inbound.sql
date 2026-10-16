-- 0550_reports_feeds_inbound.sql
-- A18 Platform Services. Reports, dashboards and data delivery (Section 4.6.4, Section 7.3 Search and views
-- and the 1.3 additions), calendar feeds and email in (Section 4.6.5):
--   * report sources, report_definitions with normalized fields and filters, report_runs and
--     report_schedules whose recipients are org members only
--   * dashboards per person or per team, with tiles and shared filters
--   * calendar_feeds with hashed tokens, revocable, serving only what the token owner may see
--   * inbound_addresses (project inboxes), inbound_messages and their attachments, and reply addresses
--     signed per person and thread

create type app.report_chart as enum ('Table', 'Bar', 'Line', 'Area', 'Pie', 'Number');
comment on type app.report_chart is 'Chart types of the report builder.';

create type app.report_aggregate as enum ('None', 'Count', 'Sum', 'Average', 'Minimum', 'Maximum');
comment on type app.report_aggregate is 'NULL-aware aggregates of the report builder: Sum of any NULL is NULL with an unpriced count beside it.';

create type app.run_status as enum ('Queued', 'Running', 'Succeeded', 'Failed');
comment on type app.run_status is 'Run status of a report run (a job status, ADR 0002).';

create type app.schedule_cadence as enum ('Daily', 'Weekly', 'Monthly');
comment on type app.schedule_cadence is 'How often a scheduled report is delivered.';

create type app.inbound_purpose as enum ('Project Inbox', 'Reply');
comment on type app.inbound_purpose is 'What an inbound message was sent to: a project''s inbox or a signed reply address.';

create type app.inbound_status as enum ('Received', 'Verified', 'Filed', 'Rejected');
comment on type app.inbound_status is 'Processing status of an inbound message (a sync status, ADR 0002).';

-- Report sources ---------------------------------------------------------------------------------------------

create table private.report_sources (
  code text primary key,
  read_capability text not null references app.capabilities (code),
  sort_order smallint not null unique,
  constraint report_sources_code_format check (code ~ '^[a-z][a-z_]*$')
);

create index report_sources_read_capability_idx on private.report_sources (read_capability);

comment on table private.report_sources is 'Data a report can be built on (Section 4.6.4) and the capability needed to read it. Reports run with the reader''s row level security and field masking.';
comment on column private.report_sources.code is 'Source code.';
comment on column private.report_sources.read_capability is 'Capability needed to build or run a report on the source.';
comment on column private.report_sources.sort_order is 'Display order.';

alter table private.report_sources enable row level security;
revoke all on private.report_sources from public, anon, authenticated;
grant select on private.report_sources to service_role;

insert into private.report_sources (code, read_capability, sort_order) values
  ('records', 'work.record.read', 1),
  ('finance', 'finance.budget.read', 2),
  ('crew', 'crew.shift.read', 3),
  ('procurement', 'procurement.po.read', 4),
  ('assets', 'assets.asset.read', 5),
  ('incidents', 'safety.incident.read', 6),
  ('custom_object', 'reports.report.read', 7);

create view app.report_sources as
select s.code, s.read_capability, s.sort_order from private.report_sources s;
comment on view app.report_sources is 'Data a report can be built on.';
comment on column app.report_sources.code is 'Source code.';
comment on column app.report_sources.read_capability is 'Capability needed to read it.';
comment on column app.report_sources.sort_order is 'Display order.';
revoke all on app.report_sources from public, anon;
grant select on app.report_sources to authenticated, service_role;

-- Report definitions ------------------------------------------------------------------------------------------

create table app.report_definitions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  membership_id uuid not null references app.memberships (id),
  name text not null,
  source_code text not null references private.report_sources (code),
  custom_object_type_id uuid references app.custom_object_types (id),
  chart app.report_chart not null default 'Table',
  group_by_field text,
  shared boolean not null default false,
  constraint report_definitions_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint report_definitions_custom_source check ((source_code = 'custom_object') = (custom_object_type_id is not null)),
  constraint report_definitions_group_field check (group_by_field is null or group_by_field ~ '^[a-z][a-z0-9_.]*$')
);

create index report_definitions_membership_idx on app.report_definitions (membership_id);
create index report_definitions_source_idx on app.report_definitions (source_code);
create index report_definitions_custom_type_idx on app.report_definitions (custom_object_type_id);

call private.install_domain_table('app.report_definitions', 'app.memberships', 'membership_id', array['app.custom_object_types', 'custom_object_type_id']);
call private.describe('app.report_definitions', 'Report builder definitions (Section 4.6.4): a source, fields with aggregates, filters, grouping and a chart. Shared reports are readable by members who may read the source.', array[
  'membership_id', 'Member who owns the report.',
  'name', 'Report name.',
  'source_code', 'Data source.',
  'custom_object_type_id', 'Custom object reported on, for the custom object source.',
  'chart', 'Chart type.',
  'group_by_field', 'Field rows are grouped by.',
  'shared', 'True when other members may use it.'
]);

create or replace function private.report_reader_orgs(p_source_code text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select private.orgs_with_capability('reports.report.read')
  intersect
  select private.orgs_with_capability(s.read_capability) from private.report_sources s where s.code = p_source_code;
$$;

comment on function private.report_reader_orgs(text) is 'Orgs where the signed-in person may read reports on a source: reports.report.read and the source''s read capability.';

call private.install_policies('app.report_definitions',
  $$membership_id in (select private.my_membership_ids())
    or (shared and org_id in (select private.report_reader_orgs(source_code)))$$,
  $$membership_id in (select private.my_membership_ids())
    and org_id in (select private.orgs_with_capability('reports.report.write'))
    and org_id in (select private.report_reader_orgs(source_code))$$);

create or replace function private.readable_report_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.id from app.report_definitions d
  where d.deleted_at is null
    and (d.membership_id in (select private.my_membership_ids())
         or (d.shared and d.org_id in (select private.report_reader_orgs(d.source_code))));
$$;

comment on function private.readable_report_ids() is 'Report definitions the signed-in person owns or may read as shared.';

create or replace function private.my_report_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.id from app.report_definitions d
  where d.deleted_at is null and d.membership_id in (select private.my_membership_ids())
    and d.org_id in (select private.orgs_with_capability('reports.report.write'));
$$;

comment on function private.my_report_ids() is 'Report definitions the signed-in person owns and may still edit.';

create table app.report_fields (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  report_definition_id uuid not null references app.report_definitions (id),
  field text not null,
  aggregate app.report_aggregate not null default 'None',
  position smallint not null,
  constraint report_fields_field_format check (field ~ '^[a-z][a-z0-9_.]*$'),
  constraint report_fields_position check (position between 1 and 100)
);

create index report_fields_definition_idx on app.report_fields (report_definition_id, position);

call private.install_domain_table('app.report_fields', 'app.report_definitions', 'report_definition_id');
call private.describe('app.report_fields', 'Columns of a report, in order, each with its aggregate.', array[
  'report_definition_id', 'Report.',
  'field', 'Source field.',
  'aggregate', 'Aggregate applied when grouping.',
  'position', 'Column order, 1 first.'
]);

create unique index report_fields_position_key on app.report_fields (report_definition_id, position) where deleted_at is null;

call private.install_policies('app.report_fields',
  $$report_definition_id in (select private.readable_report_ids())$$,
  $$report_definition_id in (select private.my_report_ids())$$);

create table app.report_filters (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  report_definition_id uuid not null references app.report_definitions (id),
  field text not null,
  operator app.filter_operator not null,
  value_text text,
  constraint report_filters_field_format check (field ~ '^[a-z][a-z0-9_.]*$'),
  constraint report_filters_value check (operator = 'is_null' or value_text is not null),
  constraint report_filters_value_length check (value_text is null or char_length(value_text) <= 1000)
);

create index report_filters_definition_idx on app.report_filters (report_definition_id);

call private.install_domain_table('app.report_filters', 'app.report_definitions', 'report_definition_id');
call private.describe('app.report_filters', 'Filters of a report, in the API filter grammar (ADR 0003).', array[
  'report_definition_id', 'Report.',
  'field', 'Field filtered on.',
  'operator', 'Operator.',
  'value_text', 'Value as the API receives it; null for is_null.'
]);

call private.install_policies('app.report_filters',
  $$report_definition_id in (select private.readable_report_ids())$$,
  $$report_definition_id in (select private.my_report_ids())$$);

create table app.report_runs (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  report_definition_id uuid not null references app.report_definitions (id),
  run_for_membership_id uuid not null references app.memberships (id),
  export_format app.export_format not null,
  run_status app.run_status not null default 'Queued',
  started_at timestamptz,
  finished_at timestamptz,
  row_count integer,
  unpriced_count integer,
  storage_object_path text,
  last_error text,
  constraint report_runs_finished check ((finished_at is not null) = (run_status in ('Succeeded', 'Failed'))),
  constraint report_runs_counts check ((row_count is null or row_count >= 0) and (unpriced_count is null or unpriced_count >= 0)),
  constraint report_runs_last_error_length check (last_error is null or char_length(last_error) <= 2000)
);

create index report_runs_definition_idx on app.report_runs (report_definition_id);
create index report_runs_membership_idx on app.report_runs (run_for_membership_id);

call private.install_domain_table('app.report_runs', 'app.report_definitions', 'report_definition_id', array['app.memberships', 'run_for_membership_id']);
call private.describe('app.report_runs', 'Runs of a report. A run executes with the row level security and masking of the member it runs for, never more.', array[
  'report_definition_id', 'Report run.',
  'run_for_membership_id', 'Member whose access the run uses and who receives the result.',
  'export_format', 'Result file format.',
  'run_status', 'Queued, Running, Succeeded or Failed.',
  'started_at', 'When the run started.',
  'finished_at', 'When it finished.',
  'row_count', 'Rows in the result.',
  'unpriced_count', 'Rows whose money was NULL (unpriced) and so left out of totals, shown beside them.',
  'storage_object_path', 'Result file once ready.',
  'last_error', 'Why the run failed.'
]);

call private.install_policies('app.report_runs',
  $$run_for_membership_id in (select private.my_membership_ids())$$);

create or replace function app.run_report(p_report_definition_id uuid, p_format app.export_format)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_def app.report_definitions;
  v_membership uuid;
  v_id uuid;
begin
  select * into v_def from app.report_definitions d where d.id = p_report_definition_id and d.deleted_at is null;
  if v_def.id is null or v_def.id not in (select private.readable_report_ids()) then
    raise exception using errcode = '42501', message = 'report not found';
  end if;
  select m.id into v_membership from app.memberships m
  where m.id in (select private.my_membership_ids()) and m.org_id = v_def.org_id limit 1;
  insert into app.report_runs (report_definition_id, run_for_membership_id, export_format)
  values (p_report_definition_id, v_membership, p_format) returning id into v_id;
  perform private.enqueue_job(v_def.org_id, 'report.run', v_id);
  return v_id;
end;
$$;

comment on function app.run_report(uuid, app.export_format) is 'Runs a report the signed-in person may read, for themselves, and queues the run job. Returns the run id.';

-- Schedules ------------------------------------------------------------------------------------------------------

create table app.report_schedules (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  report_definition_id uuid not null references app.report_definitions (id),
  cadence app.schedule_cadence not null,
  local_hour smallint not null,
  weekday smallint,
  month_day smallint,
  time_zone text not null,
  export_format app.export_format not null,
  next_run_at timestamptz not null,
  paused_at timestamptz,
  constraint report_schedules_hour check (local_hour between 0 and 23),
  constraint report_schedules_weekday check ((cadence = 'Weekly') = (weekday is not null) and (weekday is null or weekday between 1 and 7)),
  constraint report_schedules_month_day check ((cadence = 'Monthly') = (month_day is not null) and (month_day is null or month_day between 1 and 28))
);

create index report_schedules_definition_idx on app.report_schedules (report_definition_id);
create index report_schedules_due_idx on app.report_schedules (next_run_at) where paused_at is null;

call private.install_domain_table('app.report_schedules', 'app.report_definitions', 'report_definition_id');
call private.describe('app.report_schedules', 'Scheduled delivery of a report as PDF, CSV or .xlsx (Section 4.6.4), to org members only.', array[
  'report_definition_id', 'Report delivered.',
  'cadence', 'Daily, Weekly or Monthly.',
  'local_hour', 'Local hour of delivery in time_zone.',
  'weekday', 'ISO weekday (1 Monday) for weekly delivery.',
  'month_day', 'Day of the month (1 to 28) for monthly delivery.',
  'time_zone', 'IANA time zone the schedule is read in.',
  'export_format', 'Attached file format.',
  'next_run_at', 'Next delivery time, kept by the database.',
  'paused_at', 'When the schedule was paused.'
]);

create or replace function private.next_schedule_run(
  p_cadence app.schedule_cadence, p_hour smallint, p_weekday smallint, p_month_day smallint, p_time_zone text, p_after timestamptz
)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v_local timestamp := p_after at time zone p_time_zone;
  v_next timestamp := v_local::date + make_time(p_hour, 0, 0);
begin
  if p_cadence = 'Daily' then
    if v_next <= v_local then v_next := v_next + interval '1 day'; end if;
  elsif p_cadence = 'Weekly' then
    while extract(isodow from v_next) <> p_weekday or v_next <= v_local loop
      v_next := v_next + interval '1 day';
    end loop;
  else
    v_next := date_trunc('month', v_local) + make_interval(days => p_month_day - 1) + make_time(p_hour, 0, 0);
    if v_next <= v_local then v_next := v_next + interval '1 month'; end if;
  end if;
  return v_next at time zone p_time_zone;
end;
$$;

comment on function private.next_schedule_run(app.schedule_cadence, smallint, smallint, smallint, text, timestamptz) is 'Next delivery time of a schedule after a moment, read in the schedule''s time zone.';

create or replace function private.guard_report_schedule()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_time_zone(new.time_zone);
  new.next_run_at := private.next_schedule_run(new.cadence, new.local_hour, new.weekday, new.month_day, new.time_zone, now());
  return new;
end;
$$;

comment on function private.guard_report_schedule() is 'Report schedules: a known time zone, and next_run_at computed by the database from the cadence.';

create trigger t40_guard_report_schedule before insert or update of cadence, local_hour, weekday, month_day, time_zone on app.report_schedules
  for each row execute function private.guard_report_schedule();

call private.install_policies('app.report_schedules',
  $$report_definition_id in (select private.readable_report_ids())$$,
  $$report_definition_id in (select private.my_report_ids()) and org_id in (select private.orgs_with_capability('reports.schedule.write'))$$);

create table app.report_schedule_recipients (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  report_schedule_id uuid not null references app.report_schedules (id),
  membership_id uuid not null references app.memberships (id)
);

create index report_schedule_recipients_schedule_idx on app.report_schedule_recipients (report_schedule_id);
create index report_schedule_recipients_membership_idx on app.report_schedule_recipients (membership_id);

call private.install_domain_table('app.report_schedule_recipients', 'app.report_schedules', 'report_schedule_id', array['app.memberships', 'membership_id']);
call private.describe('app.report_schedule_recipients', 'Members a scheduled report goes to. Recipients are memberships of the same org, so a report never leaves the org (Section 4.6.4); each receives it run with their own access.', array[
  'report_schedule_id', 'Schedule.',
  'membership_id', 'Recipient member.'
]);

create unique index report_schedule_recipients_unique on app.report_schedule_recipients (report_schedule_id, membership_id) where deleted_at is null;

create or replace function private.my_schedule_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id from app.report_schedules s
  where s.deleted_at is null and s.report_definition_id in (select private.my_report_ids())
    and s.org_id in (select private.orgs_with_capability('reports.schedule.write'));
$$;

comment on function private.my_schedule_ids() is 'Schedules of reports the signed-in person owns and may schedule.';

call private.install_policies('app.report_schedule_recipients',
  $$report_schedule_id in (select private.my_schedule_ids()) or membership_id in (select private.my_membership_ids())$$,
  $$report_schedule_id in (select private.my_schedule_ids())$$);

-- Dashboards --------------------------------------------------------------------------------------------------------

create table app.dashboards (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  membership_id uuid references app.memberships (id),
  team_id uuid references app.teams (id),
  constraint dashboards_one_owner check (num_nonnulls(membership_id, team_id) = 1),
  constraint dashboards_name_length check (char_length(btrim(name)) between 1 and 100)
);

create index dashboards_membership_idx on app.dashboards (membership_id);
create index dashboards_team_idx on app.dashboards (team_id);

call private.install_domain_table('app.dashboards', null, null, array['app.memberships', 'membership_id', 'app.teams', 'team_id']);
call private.describe('app.dashboards', 'A grid of report tiles with shared filters (Section 4.6.4), saved for one member or one team.', array[
  'name', 'Dashboard name.',
  'membership_id', 'Member the dashboard belongs to.',
  'team_id', 'Team the dashboard belongs to.'
]);

create or replace function private.my_team_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select tm.team_id from app.team_members tm
  where tm.deleted_at is null and tm.membership_id in (select private.my_membership_ids());
$$;

comment on function private.my_team_ids() is 'Teams the signed-in person belongs to.';

call private.install_policies('app.dashboards',
  $$membership_id in (select private.my_membership_ids()) or team_id in (select private.my_team_ids())$$,
  $$(membership_id in (select private.my_membership_ids()) or team_id in (select private.my_team_ids()))
    and org_id in (select private.orgs_with_capability('home.dashboard.read'))$$);

create or replace function private.readable_dashboard_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.id from app.dashboards d
  where d.deleted_at is null and (d.membership_id in (select private.my_membership_ids()) or d.team_id in (select private.my_team_ids()));
$$;

comment on function private.readable_dashboard_ids() is 'Dashboards of the signed-in person or of their teams.';

create table app.dashboard_tiles (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  dashboard_id uuid not null references app.dashboards (id),
  report_definition_id uuid not null references app.report_definitions (id),
  grid_column smallint not null,
  grid_row smallint not null,
  column_span smallint not null,
  row_span smallint not null,
  constraint dashboard_tiles_grid check (grid_column between 1 and 12 and column_span between 1 and 12 and grid_column + column_span <= 13
    and grid_row >= 1 and row_span between 1 and 12)
);

create index dashboard_tiles_dashboard_idx on app.dashboard_tiles (dashboard_id);
create index dashboard_tiles_report_idx on app.dashboard_tiles (report_definition_id);

call private.install_domain_table('app.dashboard_tiles', 'app.dashboards', 'dashboard_id', array['app.report_definitions', 'report_definition_id']);
call private.describe('app.dashboard_tiles', 'A report placed on a dashboard''s 12-column grid. A tile shows its report only to viewers who may read the report.', array[
  'dashboard_id', 'Dashboard.',
  'report_definition_id', 'Report the tile shows.',
  'grid_column', 'Leftmost column, 1 to 12.',
  'grid_row', 'Top row, from 1.',
  'column_span', 'Columns the tile spans.',
  'row_span', 'Rows the tile spans.'
]);

call private.install_policies('app.dashboard_tiles',
  $$dashboard_id in (select private.readable_dashboard_ids())$$,
  $$dashboard_id in (select private.readable_dashboard_ids()) and report_definition_id in (select private.readable_report_ids())$$);

create table app.dashboard_filters (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  dashboard_id uuid not null references app.dashboards (id),
  field text not null,
  operator app.filter_operator not null,
  value_text text,
  constraint dashboard_filters_field_format check (field ~ '^[a-z][a-z0-9_.]*$'),
  constraint dashboard_filters_value check (operator = 'is_null' or value_text is not null)
);

create index dashboard_filters_dashboard_idx on app.dashboard_filters (dashboard_id);

call private.install_domain_table('app.dashboard_filters', 'app.dashboards', 'dashboard_id');
call private.describe('app.dashboard_filters', 'Filters a dashboard applies to every tile.', array[
  'dashboard_id', 'Dashboard.',
  'field', 'Field filtered on.',
  'operator', 'Operator.',
  'value_text', 'Value; null for is_null.'
]);

call private.install_policies('app.dashboard_filters',
  $$dashboard_id in (select private.readable_dashboard_ids())$$,
  $$dashboard_id in (select private.readable_dashboard_ids())$$);

-- Calendar feeds (Section 4.6.5) ---------------------------------------------------------------------------------------

create table app.calendar_feeds (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  membership_id uuid not null references app.memberships (id),
  project_id uuid references app.projects (id),
  token_hash bytea not null,
  token_hint text not null,
  last_accessed_at timestamptz,
  revoked_at timestamptz,
  constraint calendar_feeds_token_hash_length check (octet_length(token_hash) = 32),
  constraint calendar_feeds_token_hint check (token_hint ~ '^[0-9a-f]{4}$')
);

create unique index calendar_feeds_token_hash_key on app.calendar_feeds (token_hash);
create index calendar_feeds_membership_idx on app.calendar_feeds (membership_id);
create index calendar_feeds_project_idx on app.calendar_feeds (project_id);

call private.install_domain_table('app.calendar_feeds', 'app.memberships', 'membership_id', array['app.projects', 'project_id']);
call private.describe('app.calendar_feeds', 'iCalendar feeds of shifts, meetings, milestones and deadlines (Section 4.6.5), for one member or one of their projects. Only a SHA-256 hash of the secret token is kept; the token is shown once, can be revoked, and the feed shows only what the member may see.', array[
  'membership_id', 'Member who owns the feed; it shows what they may see.',
  'project_id', 'Project the feed covers, or null for the member''s own feed.',
  'token_hash', 'SHA-256 of the feed token.',
  'token_hint', 'Last four characters of the token, to tell feeds apart.',
  'last_accessed_at', 'Last time a calendar fetched the feed.',
  'revoked_at', 'When the feed was revoked; a revoked feed serves nothing.'
]);

revoke select on app.calendar_feeds from authenticated;
grant select (id, org_id, membership_id, project_id, token_hint, last_accessed_at, revoked_at, created_at, created_by, updated_at, updated_by, deleted_at)
  on app.calendar_feeds to authenticated;

call private.install_policies('app.calendar_feeds',
  $$membership_id in (select private.my_membership_ids())$$,
  null,
  $$membership_id in (select private.my_membership_ids())$$);
revoke update on app.calendar_feeds from authenticated;
grant update (revoked_at) on app.calendar_feeds to authenticated;

create or replace function app.create_calendar_feed(p_org_id uuid, p_project_id uuid default null)
returns table (calendar_feed_id uuid, feed_token text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_membership uuid;
  v_token text := 'xcal_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_id uuid;
begin
  select m.id into v_membership from app.memberships m
  where m.id in (select private.my_membership_ids()) and m.org_id = p_org_id limit 1;
  if v_membership is null or not private.has_capability(p_org_id, 'me.calendar_feeds.write', private.current_person_id()) then
    raise exception using errcode = '42501', message = 'organization not found';
  end if;
  if p_project_id is not null and p_project_id not in (select private.readable_project_ids()) then
    raise exception using errcode = '42501', message = 'project not found';
  end if;
  insert into app.calendar_feeds (membership_id, project_id, token_hash, token_hint)
  values (v_membership, p_project_id, extensions.digest(v_token, 'sha256'), right(v_token, 4))
  returning id into v_id;
  return query select v_id, v_token;
end;
$$;

comment on function app.create_calendar_feed(uuid, uuid) is 'Creates a calendar feed for the signed-in member, of their own schedule or of a project they can read, and returns its token once.';

create or replace function api_public.calendar_feed_events(p_token text)
returns table (uid uuid, summary text, starts_at timestamptz, ends_at timestamptz, time_zone text, event_kind text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_client text := coalesce(host(private.request_ip()), 'unknown');
  v_feed app.calendar_feeds;
  v_user uuid;
  v_claims text := current_setting('request.jwt.claims', true);
begin
  if private.rate_limit_exceeded('calendar_feed.failure', v_client, 20, interval '15 minutes') then
    return;
  end if;
  select * into v_feed from app.calendar_feeds f
  where f.token_hash = extensions.digest(coalesce(p_token, ''), 'sha256') and f.revoked_at is null and f.deleted_at is null;
  select p.user_id into v_user from app.memberships m join app.people p on p.id = m.person_id
  where m.id = v_feed.membership_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now());
  if v_feed.id is null or v_user is null then
    perform private.note_rate_event('calendar_feed.failure', v_client);
    return;
  end if;
  update app.calendar_feeds set last_accessed_at = now() where id = v_feed.id;
  perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  return query
  select s.id, coalesce(r.title, s.role_code), s.starts_at, s.ends_at, s.time_zone, 'shift'::text
  from app.shifts s left join app.records r on r.id = s.record_id
  where s.deleted_at is null and s.org_id = v_feed.org_id
    and (v_feed.project_id is null and s.membership_id = v_feed.membership_id
         or v_feed.project_id is not null and s.project_id = v_feed.project_id
            and (s.membership_id = v_feed.membership_id or s.project_id in (select private.project_ids_with('crew.shift.read'))))
  union all
  select r.id, r.title, coalesce(r.starts_at, r.due_at), coalesce(r.ends_at, r.due_at), r.time_zone, lower(r.record_kind)
  from app.records r
  where r.deleted_at is null and r.org_id = v_feed.org_id and coalesce(r.starts_at, r.due_at) is not null
    and r.record_kind in ('Meeting', 'Milestone', 'Deadline')
    and (v_feed.project_id is null and r.id in (select private.my_record_ids('work.record.read'))
         or v_feed.project_id is not null and r.project_id = v_feed.project_id
            and r.project_id in (select private.project_ids_with('work.record.read')));
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
end;
$$;

comment on function api_public.calendar_feed_events(text) is 'Named token RPC behind /ical (Section 4.6.5, invariants 7 and 8): resolves a live feed token and returns only the shifts, meetings, milestones and deadlines its owner may see right now, evaluated with the owner''s access. A revoked token, an ended membership or a wrong token returns nothing; failures are rate-limited per client.';

revoke all on function api_public.calendar_feed_events(text) from public;
grant execute on function api_public.calendar_feed_events(text) to anon, authenticated, service_role;

-- Email in (Section 4.6.5) -------------------------------------------------------------------------------------------------

create table app.inbound_addresses (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  local_part text not null,
  disabled_at timestamptz,
  constraint inbound_addresses_local_part check (local_part ~ '^[a-z0-9][a-z0-9-]{3,62}$')
);

create unique index inbound_addresses_local_part_key on app.inbound_addresses (local_part);
create index inbound_addresses_project_idx on app.inbound_addresses (project_id);

call private.install_domain_table('app.inbound_addresses', 'app.projects', 'project_id');
call private.describe('app.inbound_addresses', 'Project inboxes (Section 4.6.5): mail forwarded to the address lands as an inbound message with its attachments for a coordinator to file.', array[
  'project_id', 'Project the inbox belongs to.',
  'local_part', 'Part before the @ of the inbound domain, unique across the platform and unguessable.',
  'disabled_at', 'When the inbox stopped accepting mail.'
]);

create or replace function app.create_project_inbox(p_project_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := (select lower(p.project_key) from app.projects p where p.id = p_project_id);
  v_local text;
begin
  if v_key is null or not private.can_on_project(p_project_id, 'projects.settings.write') then
    raise exception using errcode = '42501', message = 'project not found';
  end if;
  v_local := v_key || '-' || encode(extensions.gen_random_bytes(5), 'hex');
  insert into app.inbound_addresses (project_id, local_part) values (p_project_id, v_local);
  return v_local;
end;
$$;

comment on function app.create_project_inbox(uuid) is 'Creates a project inbox address (project key plus random suffix). Needs projects.settings.write on the project. Returns the local part.';

call private.install_policies('app.inbound_addresses',
  $$project_id in (select private.readable_project_ids())$$,
  null,
  $$project_id in (select private.project_ids_with('projects.settings.write'))$$);

create table app.inbound_messages (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  purpose app.inbound_purpose not null,
  inbound_address_id uuid references app.inbound_addresses (id),
  reply_person_id uuid references app.people (id),
  reply_subject_table text,
  reply_subject_id uuid,
  from_address text not null,
  subject_line text,
  message_id_header text not null,
  dkim_verified boolean not null,
  body_text text,
  raw_object_path text not null,
  inbound_status app.inbound_status not null default 'Received',
  rejection_reason text,
  filed_document_id uuid references app.documents (id),
  received_at timestamptz not null default now(),
  constraint inbound_messages_purpose_target check (
    (purpose = 'Project Inbox' and inbound_address_id is not null and reply_person_id is null)
    or (purpose = 'Reply' and inbound_address_id is null and reply_person_id is not null and reply_subject_id is not null and reply_subject_table is not null)),
  constraint inbound_messages_rejected check ((inbound_status = 'Rejected') = (rejection_reason is not null)),
  constraint inbound_messages_from_length check (char_length(from_address) between 3 and 320),
  constraint inbound_messages_body_length check (body_text is null or char_length(body_text) <= 100000)
);

create unique index inbound_messages_message_id_key on app.inbound_messages (org_id, message_id_header);
create index inbound_messages_address_idx on app.inbound_messages (inbound_address_id);
create index inbound_messages_reply_person_idx on app.inbound_messages (reply_person_id);
create index inbound_messages_document_idx on app.inbound_messages (filed_document_id);

call private.install_domain_table('app.inbound_messages', null, null, array['app.inbound_addresses', 'inbound_address_id', 'app.documents', 'filed_document_id']);
call private.describe('app.inbound_messages', 'Mail received (Section 4.6.5): forwarded to a project inbox, or a reply to a notification email from a signed reply address. A reply is accepted only after DKIM verification and with quoted text stripped.', array[
  'purpose', 'Project Inbox or Reply.',
  'inbound_address_id', 'Project inbox the mail was sent to.',
  'reply_person_id', 'Person the signed reply address belongs to.',
  'reply_subject_table', 'Table of the thread the reply belongs to.',
  'reply_subject_id', 'Row of the thread the reply belongs to.',
  'from_address', 'Sender address from the envelope.',
  'subject_line', 'Subject header.',
  'message_id_header', 'Message-ID header, unique per org so a redelivery is not filed twice.',
  'dkim_verified', 'True when the sender''s DKIM signature verified.',
  'body_text', 'Plain-text body with quoted text stripped.',
  'raw_object_path', 'Storage path of the raw message.',
  'inbound_status', 'Received, Verified, Filed or Rejected.',
  'rejection_reason', 'Why the message was rejected.',
  'filed_document_id', 'Document record the coordinator filed the mail as.',
  'received_at', 'When the mail arrived. Set by the database.'
]);

create trigger t40_stamp_received_at before insert on app.inbound_messages
  for each row execute function private.stamp_received_now('received_at');

create or replace function private.readable_inbound_message_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id from app.inbound_messages m
  where m.deleted_at is null
    and (m.reply_person_id = private.current_person_id()
         or m.inbound_address_id in (select a.id from app.inbound_addresses a where a.project_id in (select private.project_ids_with('knowledge.document.write'))));
$$;

comment on function private.readable_inbound_message_ids() is 'Inbound messages the signed-in person may see: their own replies, and mail in inboxes of projects where they file documents.';

call private.install_policies('app.inbound_messages',
  $$reply_person_id = (select private.current_person_id())
    or inbound_address_id in (select a.id from app.inbound_addresses a where a.project_id in (select private.project_ids_with('knowledge.document.write')))$$,
  null,
  $$inbound_address_id in (select a.id from app.inbound_addresses a where a.project_id in (select private.project_ids_with('knowledge.document.write')))$$);

create or replace function private.guard_inbound_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and private.current_person_id() is not null then
    if (to_jsonb(new) - array['filed_document_id', 'inbound_status', 'updated_at', 'updated_by'])
       <> (to_jsonb(old) - array['filed_document_id', 'inbound_status', 'updated_at', 'updated_by']) then
      perform private.refuse('inbound_message_immutable', 'A coordinator only files inbound mail.');
    end if;
    if new.inbound_status is distinct from old.inbound_status and not (new.inbound_status = 'Filed' and new.filed_document_id is not null) then
      perform private.refuse('inbound_message_filing', 'Filing sets the document and the Filed status together.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_inbound_message() is 'Inbound messages: a person only files them, setting the document and the Filed status together.';

create trigger t40_guard_inbound_message before update on app.inbound_messages
  for each row execute function private.guard_inbound_message();

create table app.inbound_message_attachments (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  inbound_message_id uuid not null references app.inbound_messages (id),
  filename text not null,
  content_type text not null,
  size_bytes bigint not null,
  storage_object_path text not null,
  constraint inbound_message_attachments_size check (size_bytes between 0 and 52428800),
  constraint inbound_message_attachments_filename_length check (char_length(filename) between 1 and 255),
  constraint inbound_message_attachments_type_format check (content_type ~ '^[a-z]+/[a-z0-9.+-]+$')
);

create index inbound_message_attachments_message_idx on app.inbound_message_attachments (inbound_message_id);

call private.install_domain_table('app.inbound_message_attachments', 'app.inbound_messages', 'inbound_message_id', '{}', true);
call private.describe('app.inbound_message_attachments', 'Attachments of an inbound message, stored after MIME sniffing, size caps and virus scanning (Section 9).', array[
  'inbound_message_id', 'Message.',
  'filename', 'File name from the message.',
  'content_type', 'Sniffed MIME type.',
  'size_bytes', 'Size in bytes, at most 50 MiB.',
  'storage_object_path', 'Storage path of the attachment.'
]);

call private.install_policies('app.inbound_message_attachments',
  $$inbound_message_id in (select private.readable_inbound_message_ids())$$);

-- Signed reply addresses ------------------------------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from vault.secrets s where s.name = 'xos_inbound_reply_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'xos_inbound_reply_secret',
      'Signs reply-by-email addresses (Section 4.6.5). Generated per environment; rotating it invalidates open reply addresses.');
  end if;
end;
$$;

create or replace function private.reply_signature(p_person_id uuid, p_subject_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select left(encode(extensions.hmac(convert_to(p_person_id::text || '.' || p_subject_id::text, 'UTF8'),
    convert_to((select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'xos_inbound_reply_secret'), 'UTF8'), 'sha256'), 'hex'), 32);
$$;

comment on function private.reply_signature(uuid, uuid) is 'HMAC-SHA256 signature binding a reply address to one person and one thread, with the per-environment Vault secret.';

create or replace function private.reply_local_part(p_person_id uuid, p_subject_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select 'r-' || replace(p_subject_id::text, '-', '') || '-' || replace(p_person_id::text, '-', '') || '-' || private.reply_signature(p_person_id, p_subject_id);
$$;

comment on function private.reply_local_part(uuid, uuid) is 'Local part of the reply address of a notification email: thread, person and signature. The sender puts it in Reply-To.';

create or replace function app.receive_inbound_email(
  p_local_part text,
  p_from_address text,
  p_subject_line text,
  p_message_id_header text,
  p_dkim_verified boolean,
  p_body_text text,
  p_raw_object_path text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_address app.inbound_addresses;
  v_parts text[];
  v_subject uuid;
  v_person uuid;
  v_event app.domain_events;
  v_id uuid;
  v_sender_email text;
begin
  select * into v_address from app.inbound_addresses a where a.local_part = lower(p_local_part) and a.disabled_at is null and a.deleted_at is null;
  if v_address.id is not null then
    insert into app.inbound_messages (org_id, purpose, inbound_address_id, from_address, subject_line, message_id_header, dkim_verified,
      body_text, raw_object_path, inbound_status, rejection_reason)
    values (v_address.org_id, 'Project Inbox', v_address.id, lower(p_from_address), left(p_subject_line, 998), p_message_id_header,
      coalesce(p_dkim_verified, false), p_body_text, p_raw_object_path,
      case when coalesce(p_dkim_verified, false) then 'Verified' else 'Rejected' end::app.inbound_status,
      case when coalesce(p_dkim_verified, false) then null else 'The sender''s DKIM signature did not verify.' end)
    on conflict (org_id, message_id_header) do nothing
    returning id into v_id;
    return v_id;
  end if;
  v_parts := regexp_match(lower(p_local_part), '^r-([0-9a-f]{32})-([0-9a-f]{32})-([0-9a-f]{32})$');
  if v_parts is null then
    return null;
  end if;
  v_subject := v_parts[1]::uuid;
  v_person := v_parts[2]::uuid;
  if private.reply_signature(v_person, v_subject) <> v_parts[3] then
    return null;
  end if;
  select * into v_event from app.domain_events e where e.subject_id = v_subject order by e.occurred_at desc limit 1;
  select lower(u.email) into v_sender_email from auth.users u join app.people p on p.user_id = u.id where p.id = v_person;
  if v_event.id is null then
    return null;
  end if;
  insert into app.inbound_messages (org_id, purpose, reply_person_id, reply_subject_table, reply_subject_id, from_address, subject_line,
    message_id_header, dkim_verified, body_text, raw_object_path, inbound_status, rejection_reason)
  values (v_event.org_id, 'Reply', v_person, 'app.' || v_event.subject_table, v_subject, lower(p_from_address), left(p_subject_line, 998),
    p_message_id_header, coalesce(p_dkim_verified, false), p_body_text, p_raw_object_path,
    case when coalesce(p_dkim_verified, false) and lower(p_from_address) = v_sender_email
           and v_event.org_id in (select private.person_org_ids(v_person)) then 'Verified' else 'Rejected' end::app.inbound_status,
    case when not coalesce(p_dkim_verified, false) then 'The sender''s DKIM signature did not verify.'
         when lower(p_from_address) is distinct from v_sender_email then 'The reply did not come from the address the email was sent to.'
         when v_event.org_id not in (select private.person_org_ids(v_person)) then 'The person no longer belongs to the org.' end)
  on conflict (org_id, message_id_header) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.receive_inbound_email(text, text, text, text, boolean, text, text) is 'Inbound mail API (service role, called by the inbound-email Edge Function after parsing, DKIM checking and stripping quoted text): files mail to a project inbox, or accepts a reply whose address signature verifies, whose DKIM passed, which came from the person''s own address and whose person still belongs to the org. Anything else is rejected with a reason or ignored. Redeliveries are ignored.';

-- Default retention for later ranges ----------------------------------------------------------------------------------

create or replace procedure private.install_default_retention(p_table regclass, p_retention interval default interval '7 years')
language plpgsql
set search_path = ''
as $$
declare
  v_name text := p_table::text;
  v_ledger boolean := exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = p_table and t.tgname = 't95_append_only');
begin
  insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale)
  values (v_name,
    case when v_ledger then 'Age' else 'Soft Deleted' end::app.retention_basis,
    case when v_ledger then 'created_at' else 'deleted_at' end,
    p_retention, 'Delete',
    case when v_ledger then 'Append-only ledger kept as audit evidence.' else 'Soft-deleted business records kept for the stated period.' end)
  on conflict (table_name) do nothing;
end;
$$;

comment on procedure private.install_default_retention(regclass, interval) is 'Gives a table of a later range its retention policy (ADR 0002): ledgers by age of created_at, other tables by soft delete, 7 years unless stated. Ranges that need another period insert their own row.';

revoke all on procedure private.install_default_retention(regclass, interval) from public, anon, authenticated;

-- Retention ----------------------------------------------------------------------------------------------------------

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.report_definitions', 'Soft Deleted', 'deleted_at', interval '1 year', 'Delete', 'Deleted reports are recoverable from Trash for a year.'),
  ('app.report_fields', 'Soft Deleted', 'deleted_at', interval '1 year', 'Delete', 'Kept as long as their report.'),
  ('app.report_filters', 'Soft Deleted', 'deleted_at', interval '1 year', 'Delete', 'Kept as long as their report.'),
  ('app.report_runs', 'Age', 'created_at', interval '1 year', 'Delete', 'Run history kept a year; result files expire sooner.'),
  ('app.report_schedules', 'Soft Deleted', 'deleted_at', interval '1 year', 'Delete', 'Kept as long as their report.'),
  ('app.report_schedule_recipients', 'Soft Deleted', 'deleted_at', interval '1 year', 'Delete', 'Kept as long as their schedule.'),
  ('app.dashboards', 'Soft Deleted', 'deleted_at', interval '1 year', 'Delete', 'Deleted dashboards are recoverable for a year.'),
  ('app.dashboard_tiles', 'Soft Deleted', 'deleted_at', interval '1 year', 'Delete', 'Kept as long as their dashboard.'),
  ('app.dashboard_filters', 'Soft Deleted', 'deleted_at', interval '1 year', 'Delete', 'Kept as long as their dashboard.'),
  ('app.calendar_feeds', 'Soft Deleted', 'deleted_at', interval '90 days', 'Delete', 'Revoked feeds carry no history value.'),
  ('app.inbound_addresses', 'Soft Deleted', 'deleted_at', interval '1 year', 'Delete', 'Kept a year so late mail is recognized.'),
  ('app.inbound_messages', 'Age', 'received_at', interval '2 years', 'Delete', 'Unfiled mail kept two years; filed mail lives on as a document.'),
  ('app.inbound_message_attachments', 'Age', 'created_at', interval '2 years', 'Delete', 'Kept as long as their message.');

-- Privileges -------------------------------------------------------------------------------------------------------------

revoke all on function private.report_reader_orgs(text) from public, anon;
grant execute on function private.report_reader_orgs(text) to authenticated;
revoke all on function private.readable_report_ids() from public, anon;
grant execute on function private.readable_report_ids() to authenticated;
revoke all on function private.my_report_ids() from public, anon;
grant execute on function private.my_report_ids() to authenticated;
revoke all on function app.run_report(uuid, app.export_format) from public, anon;
grant execute on function app.run_report(uuid, app.export_format) to authenticated, service_role;
revoke all on function private.next_schedule_run(app.schedule_cadence, smallint, smallint, smallint, text, timestamptz) from public, anon, authenticated;
revoke all on function private.guard_report_schedule() from public, anon, authenticated;
revoke all on function private.my_schedule_ids() from public, anon;
grant execute on function private.my_schedule_ids() to authenticated;
revoke all on function private.my_team_ids() from public, anon;
grant execute on function private.my_team_ids() to authenticated;
revoke all on function private.readable_dashboard_ids() from public, anon;
grant execute on function private.readable_dashboard_ids() to authenticated;
revoke all on function app.create_calendar_feed(uuid, uuid) from public, anon;
grant execute on function app.create_calendar_feed(uuid, uuid) to authenticated, service_role;
revoke all on function app.create_project_inbox(uuid) from public, anon;
grant execute on function app.create_project_inbox(uuid) to authenticated, service_role;
revoke all on function private.readable_inbound_message_ids() from public, anon;
grant execute on function private.readable_inbound_message_ids() to authenticated;
revoke all on function private.guard_inbound_message() from public, anon, authenticated;
revoke all on function private.reply_signature(uuid, uuid) from public, anon, authenticated;
revoke all on function private.reply_local_part(uuid, uuid) from public, anon, authenticated;
grant execute on function private.reply_local_part(uuid, uuid) to service_role;
revoke all on function app.receive_inbound_email(text, text, text, text, boolean, text, text) from public, anon, authenticated;
grant execute on function app.receive_inbound_email(text, text, text, text, boolean, text, text) to service_role;
