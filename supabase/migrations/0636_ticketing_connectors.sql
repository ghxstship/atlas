-- 0636_ticketing_connectors.sql
-- A19 Integrations. Ticketing data (Section 17: CSV and API import of attendance used by gate 8 measurement):
--   * app.attendance_counts: tickets sold, scanned and comped per project, show, day and ticket class, from one
--     ticketing connection; gross is money in minor units and NULL when the source does not price it
--   * app.record_attendance: the runner's upsert of a batch of rows (a newer import of the same day and class
--     replaces the older one), refused when a row names another org's project or show
--   * app.project_attendance_totals: NULL-aware totals per project and show for the gate 8 measurement
-- Read with projects.gate.read on the project (invariant 2); hand corrections need projects.gate.evidence.write.

create table app.attendance_counts (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  scope_node_id uuid references app.scope_nodes (id),
  integration_connection_id uuid not null references app.integration_connections (id),
  integration_sync_run_id uuid references app.integration_sync_runs (id),
  counted_on date not null,
  ticket_class text not null,
  tickets_sold integer not null,
  tickets_scanned integer,
  comps integer,
  gross_minor bigint,
  currency_code char(3) references private.currencies (currency_code),
  deleted_at timestamptz,
  constraint attendance_counts_class_length check (char_length(btrim(ticket_class)) between 1 and 100),
  constraint attendance_counts_counts check (tickets_sold >= 0 and coalesce(tickets_scanned, 0) >= 0 and coalesce(comps, 0) >= 0),
  constraint attendance_counts_gross check (gross_minor is null or (gross_minor >= 0 and currency_code is not null))
);

create index attendance_counts_project_idx on app.attendance_counts (project_id, counted_on);
create index attendance_counts_scope_node_id_idx on app.attendance_counts (scope_node_id);
create index attendance_counts_connection_idx on app.attendance_counts (integration_connection_id);
create index attendance_counts_sync_run_idx on app.attendance_counts (integration_sync_run_id);
create index attendance_counts_currency_idx on app.attendance_counts (currency_code);
create unique index attendance_counts_day_key on app.attendance_counts
  (integration_connection_id, project_id, coalesce(scope_node_id, '00000000-0000-0000-0000-000000000000'::uuid), counted_on, ticket_class)
  where deleted_at is null;

call private.install_domain_table('app.attendance_counts', 'app.projects', 'project_id',
  array['app.scope_nodes', 'scope_node_id', 'app.integration_connections', 'integration_connection_id', 'app.integration_sync_runs', 'integration_sync_run_id']);
call private.describe('app.attendance_counts', 'Attendance imported from a ticketing source (Section 17) for the gate 8 measurement: tickets sold, scanned and comped per project, show, day and ticket class. A newer import of the same day and class replaces the older figures. Gross is NULL when the source does not price it, never zero.', array[
  'project_id', 'Project measured.',
  'scope_node_id', 'Show or other scope node of the project, when the source names one.',
  'integration_connection_id', 'Ticketing connection the figures came from.',
  'integration_sync_run_id', 'Sync run that imported the figures, or NULL for a hand correction.',
  'counted_on', 'Day the figures cover.',
  'ticket_class', 'Ticket class as the source names it.',
  'tickets_sold', 'Tickets sold.',
  'tickets_scanned', 'Tickets scanned at the gate, when the source reports it.',
  'comps', 'Complimentary tickets issued, when the source reports it.',
  'gross_minor', 'Gross ticket revenue in minor units of currency_code; NULL when unpriced.',
  'currency_code', 'ISO 4217 currency of gross_minor.'
]);

call private.install_policies('app.attendance_counts',
  $$project_id = any (array(select private.project_ids_with('projects.gate.read')))$$,
  $$project_id = any (array(select private.project_ids_with('projects.gate.evidence.write')))$$);

create trigger t40_guard_attendance_category before insert or update of integration_connection_id on app.attendance_counts
  for each row execute function private.guard_integration_category('Ticketing');
create trigger t41_assert_attendance_project before insert or update on app.attendance_counts
  for each row execute function private.assert_same_project('app.scope_nodes', 'scope_node_id');

create or replace function app.record_attendance(p_run_id uuid, p_rows jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.integration_sync_runs;
  v_row jsonb;
  v_written integer := 0;
  v_project uuid;
  v_node uuid;
begin
  select * into v_run from app.integration_sync_runs r where r.id = p_run_id and r.deleted_at is null;
  if v_run.id is null or v_run.sync_scope <> 'Attendance Import' then
    perform private.refuse('attendance_run_unknown', 'Attendance is recorded only by an Attendance Import run.');
  end if;
  if v_run.sync_run_state <> 'Running' then
    perform private.refuse('integration_sync_not_running', 'Attendance is recorded only while the run is Running.');
  end if;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    perform private.refuse('attendance_rows_malformed', 'Attendance rows arrive as a list.');
  end if;
  for v_row in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_project := coalesce((v_row ->> 'project_id')::uuid, v_run.project_id);
    v_node := (v_row ->> 'scope_node_id')::uuid;
    if v_project is null or not exists (select 1 from app.projects p where p.id = v_project and p.org_id = v_run.org_id and p.deleted_at is null) then
      perform private.refuse('attendance_project_unknown', 'An attendance row names a project this org does not have.');
    end if;
    update app.attendance_counts
    set tickets_sold = (v_row ->> 'tickets_sold')::integer, tickets_scanned = (v_row ->> 'tickets_scanned')::integer,
        comps = (v_row ->> 'comps')::integer, gross_minor = (v_row ->> 'gross_minor')::bigint, currency_code = v_row ->> 'currency_code',
        integration_sync_run_id = p_run_id
    where integration_connection_id = v_run.integration_connection_id and project_id = v_project
      and scope_node_id is not distinct from v_node and counted_on = (v_row ->> 'counted_on')::date
      and ticket_class = btrim(v_row ->> 'ticket_class') and deleted_at is null;
    if not found then
      insert into app.attendance_counts (project_id, scope_node_id, integration_connection_id, integration_sync_run_id, counted_on, ticket_class,
        tickets_sold, tickets_scanned, comps, gross_minor, currency_code)
      values (v_project, v_node, v_run.integration_connection_id, p_run_id, (v_row ->> 'counted_on')::date, btrim(v_row ->> 'ticket_class'),
        (v_row ->> 'tickets_sold')::integer, (v_row ->> 'tickets_scanned')::integer, (v_row ->> 'comps')::integer,
        (v_row ->> 'gross_minor')::bigint, v_row ->> 'currency_code');
    end if;
    v_written := v_written + 1;
  end loop;
  return v_written;
end;
$$;

comment on function app.record_attendance(uuid, jsonb) is 'Runner: upserts a batch of attendance rows (a provider payload list of project_id, scope_node_id, counted_on, ticket_class, tickets_sold, tickets_scanned, comps, gross_minor and currency_code) for a Running Attendance Import run; a row without a project takes the run''s. Every check of the table applies. Service role only.';

revoke all on function app.record_attendance(uuid, jsonb) from public, anon, authenticated;
grant execute on function app.record_attendance(uuid, jsonb) to service_role;

create view app.project_attendance_totals with (security_invoker = true) as
select a.project_id, a.scope_node_id, a.org_id,
  sum(a.tickets_sold)::bigint as tickets_sold,
  sum(a.tickets_scanned)::bigint as tickets_scanned,
  count(*) filter (where a.tickets_scanned is null) as scans_unreported_count,
  sum(a.comps)::bigint as comps,
  case when count(*) filter (where a.gross_minor is null) = 0 and count(distinct a.currency_code) = 1 then sum(a.gross_minor)::bigint end as gross_minor,
  case when count(distinct a.currency_code) = 1 then min(a.currency_code) end as currency_code,
  count(*) filter (where a.gross_minor is null) as unpriced_count,
  min(a.counted_on) as first_day,
  max(a.counted_on) as last_day
from app.attendance_counts a
where a.deleted_at is null
group by a.project_id, a.scope_node_id, a.org_id;

call private.describe('app.project_attendance_totals', 'Attendance totals per project and show for the gate 8 measurement. Gross is NULL when any row is unpriced or currencies differ, with the unpriced count beside it; scans not reported are counted, never treated as zero.', array[
  'project_id', 'Project.',
  'scope_node_id', 'Show or scope node, or NULL for figures without one.',
  'org_id', 'Org.',
  'tickets_sold', 'Tickets sold.',
  'tickets_scanned', 'Tickets scanned, over the rows that report scans.',
  'scans_unreported_count', 'Rows whose source reported no scans.',
  'comps', 'Complimentary tickets, over the rows that report them.',
  'gross_minor', 'Gross revenue in minor units, or NULL when any row is unpriced or currencies differ.',
  'currency_code', 'Currency of gross_minor, when there is one.',
  'unpriced_count', 'Rows without a gross.',
  'first_day', 'First day counted.',
  'last_day', 'Last day counted.'
]);

revoke all on app.project_attendance_totals from public, anon;
grant select on app.project_attendance_totals to authenticated, service_role;

call private.install_default_retention('app.attendance_counts');
