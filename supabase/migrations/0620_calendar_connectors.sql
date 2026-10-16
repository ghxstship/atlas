-- 0620_calendar_connectors.sql
-- A19 Integrations. Calendar connectors (Section 17: Google Calendar and Microsoft 365, two-way for Meeting, Event
-- and Shift records):
--   * app.integration_calendar_targets: which provider calendar receives which kind of item, for the whole org or
--     one project, in which direction, and who wins when both sides changed
--   * app.integration_calendar_items: the Meeting and Event records and the shifts a target syncs, in one shape
--   * app.apply_calendar_change: the runner's write-back of a time change made in the provider calendar; a change
--     to a Scheduled or later record is logged as a replan with its reason (Section 3.10)

create type app.calendar_sync_kind as enum ('Meeting', 'Event', 'Shift');
comment on type app.calendar_sync_kind is 'Kinds of XOS items a calendar target syncs: Meeting and Event records, and crew shifts.';

create type app.calendar_conflict_policy as enum ('XOS Wins', 'Provider Wins', 'Latest Wins');
comment on type app.calendar_conflict_policy is 'Which side wins when an item changed in both XOS and the provider calendar since the last sync.';

create table app.integration_calendar_targets (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  integration_connection_id uuid not null references app.integration_connections (id),
  project_id uuid references app.projects (id),
  sync_kind app.calendar_sync_kind not null,
  external_calendar_id text not null,
  direction app.integration_sync_direction not null default 'Two Way',
  conflict_policy app.calendar_conflict_policy not null default 'Latest Wins',
  deleted_at timestamptz,
  constraint integration_calendar_targets_calendar_length check (char_length(btrim(external_calendar_id)) between 1 and 500)
);

create index integration_calendar_targets_connection_idx on app.integration_calendar_targets (integration_connection_id);
create index integration_calendar_targets_project_id_idx on app.integration_calendar_targets (project_id);
create unique index integration_calendar_targets_kind_key on app.integration_calendar_targets
  (integration_connection_id, coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), sync_kind) where deleted_at is null;

call private.install_domain_table('app.integration_calendar_targets', 'app.integration_connections', 'integration_connection_id',
  array['app.projects', 'project_id']);
call private.describe('app.integration_calendar_targets', 'Where a calendar connection syncs one kind of item: Meetings, Events or Shifts of the whole org (no project) or one project, into one provider calendar. Inbound changes move the XOS item''s times; the conflict policy decides when both sides changed.', array[
  'integration_connection_id', 'Calendar connection.',
  'project_id', 'Project whose items sync, or NULL for every project of the org.',
  'sync_kind', 'Meeting, Event or Shift.',
  'external_calendar_id', 'Provider calendar identifier.',
  'direction', 'Outbound (XOS to calendar), Inbound (calendar time changes into XOS) or Two Way.',
  'conflict_policy', 'XOS Wins, Provider Wins or Latest Wins when both sides changed.'
]);

call private.install_policies('app.integration_calendar_targets',
  $$org_id in (select private.orgs_with_capability('org.integrations.manage'))$$,
  $$org_id in (select private.orgs_with_capability('org.integrations.manage'))$$);

create trigger t40_guard_integration_calendar_target before insert or update of integration_connection_id on app.integration_calendar_targets
  for each row execute function private.guard_integration_category('Calendar');

create view app.integration_calendar_items with (security_invoker = true) as
select t.id as integration_calendar_target_id, t.integration_connection_id, t.org_id, t.sync_kind,
  'Record'::app.integration_entity as entity, r.id as local_id, r.project_id, r.title, r.starts_at,
  coalesce(r.ends_at, r.starts_at + interval '1 hour') as ends_at, coalesce(r.time_zone, p.time_zone) as time_zone,
  coalesce(m.location_text, v.name) as location_text, m.conferencing_uri,
  (r.record_state = 'Canceled' or r.deleted_at is not null) as canceled, r.updated_at
from app.integration_calendar_targets t
join app.records r on r.org_id = t.org_id and r.record_kind = t.sync_kind::text
  and (t.project_id is null or r.project_id = t.project_id)
join app.projects p on p.id = r.project_id
left join app.record_meeting m on m.record_id = r.id
left join app.record_event e on e.record_id = r.id
left join app.venues v on v.id = e.venue_id
where t.deleted_at is null and t.sync_kind in ('Meeting', 'Event') and r.starts_at is not null
union all
select t.id, t.integration_connection_id, t.org_id, t.sync_kind,
  'Shift'::app.integration_entity, s.id, s.project_id, p.name || ' · ' || coalesce(ro.job_title, 'Crew'), s.starts_at,
  s.ends_at, s.time_zone, v.name, null::text,
  s.deleted_at is not null, s.updated_at
from app.integration_calendar_targets t
join app.shifts s on s.org_id = t.org_id and (t.project_id is null or s.project_id = t.project_id)
join app.projects p on p.id = s.project_id
left join xpms.role ro on ro.role_code = s.role_code
left join app.venues v on v.id = p.venue_id
where t.deleted_at is null and t.sync_kind = 'Shift';

call private.describe('app.integration_calendar_items', 'Every item a calendar target syncs, in one shape: Meeting and Event records with a start, and shifts. Canceled and deleted items stay listed with canceled set, so the connector removes them from the provider calendar.', array[
  'integration_calendar_target_id', 'Target the item syncs through.',
  'integration_connection_id', 'Calendar connection.',
  'org_id', 'Org of the item.',
  'sync_kind', 'Meeting, Event or Shift.',
  'entity', 'Record or Shift, the kind of local row in the identifier map.',
  'local_id', 'Record or shift id.',
  'project_id', 'Project of the item.',
  'title', 'Record title, or project and role for a shift.',
  'starts_at', 'Start.',
  'ends_at', 'End; a record without an end lasts one hour on the calendar.',
  'time_zone', 'IANA zone the item was planned in.',
  'location_text', 'Meeting location or the venue.',
  'conferencing_uri', 'Video conferencing link of a meeting.',
  'canceled', 'True when the item was canceled or deleted and should leave the calendar.',
  'updated_at', 'When the item last changed in XOS, for conflict decisions.'
]);

revoke all on app.integration_calendar_items from public, anon;
grant select on app.integration_calendar_items to authenticated, service_role;

create or replace function app.apply_calendar_change(
  p_connection_id uuid,
  p_entity app.integration_entity,
  p_local_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_external_version text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_provider text;
  v_org uuid;
begin
  select c.display_name, c.org_id into v_provider, v_org from app.integration_connections c
  where c.id = p_connection_id and c.deleted_at is null and c.connection_state = 'Connected';
  if v_provider is null then
    perform private.refuse('integration_not_connected', 'Only a Connected connection can sync.');
  end if;
  if not exists (select 1 from app.integration_external_ids x where x.integration_connection_id = p_connection_id
      and x.entity = p_entity and x.local_id = p_local_id and x.deleted_at is null) then
    perform private.refuse('calendar_item_unmapped', 'Only items this connection placed on the calendar take changes from it.');
  end if;
  if p_starts_at is null or p_ends_at is null or p_ends_at < p_starts_at then
    perform private.refuse('calendar_window_invalid', 'A calendar change needs a start and an end that is not before it.');
  end if;
  if p_entity = 'Record' then
    update app.records
    set starts_at = p_starts_at, ends_at = p_ends_at,
        replan_reason = format('Moved in the calendar connection %s.', v_provider)
    where id = p_local_id and org_id = v_org and (starts_at is distinct from p_starts_at or ends_at is distinct from p_ends_at);
  elsif p_entity = 'Shift' then
    if p_ends_at = p_starts_at then
      perform private.refuse('calendar_window_invalid', 'A shift ends after it starts.');
    end if;
    update app.shifts set starts_at = p_starts_at, ends_at = p_ends_at
    where id = p_local_id and org_id = v_org and (starts_at is distinct from p_starts_at or ends_at is distinct from p_ends_at);
  else
    perform private.refuse('calendar_entity_unsupported', 'Calendar changes apply only to records and shifts.');
  end if;
  update app.integration_external_ids set external_version = p_external_version, last_synced_at = now()
  where integration_connection_id = p_connection_id and entity = p_entity and local_id = p_local_id and deleted_at is null;
  return found;
end;
$$;

comment on function app.apply_calendar_change(uuid, app.integration_entity, uuid, timestamptz, timestamptz, text) is 'Runner: moves a record or shift this connection placed on the calendar to the times changed in the provider calendar and records the provider version. A move of a Scheduled or later record is logged as a replan with the reason. Service role only.';

revoke all on function app.apply_calendar_change(uuid, app.integration_entity, uuid, timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function app.apply_calendar_change(uuid, app.integration_entity, uuid, timestamptz, timestamptz, text) to service_role;

call private.install_default_retention('app.integration_calendar_targets');
