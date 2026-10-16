-- 0630_communication_connectors.sql
-- A19 Integrations. Communication connectors (Section 17: Slack and Microsoft Teams; notifications, record unfurls,
-- slash commands):
--   * app.integration_channel_routes: which domain events post to which channel, for the org or one project
--   * app.integration_route_events: domain events matched to their routes, read by the runner after its cursor
--   * app.find_chat_connection and app.resolve_chat_member: the chat handler finds the connection for a workspace
--     and the XOS person behind a chat user (mapped through app.integration_external_ids as a Membership), so
--     unfurls and slash commands run as that person under row level security and never as the platform
-- Domain event payloads already carry only named, non-restricted columns (ADR 0016 item 12).

create table app.integration_channel_routes (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  integration_connection_id uuid not null references app.integration_connections (id),
  project_id uuid references app.projects (id),
  event_type text not null references private.domain_event_types (code),
  external_channel_id text not null,
  deleted_at timestamptz,
  constraint integration_channel_routes_channel_length check (char_length(btrim(external_channel_id)) between 1 and 255)
);

create index integration_channel_routes_connection_idx on app.integration_channel_routes (integration_connection_id);
create index integration_channel_routes_project_id_idx on app.integration_channel_routes (project_id);
create index integration_channel_routes_event_type_idx on app.integration_channel_routes (event_type);
create unique index integration_channel_routes_key on app.integration_channel_routes
  (integration_connection_id, coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), event_type, external_channel_id)
  where deleted_at is null;

call private.install_domain_table('app.integration_channel_routes', 'app.integration_connections', 'integration_connection_id',
  array['app.projects', 'project_id']);
call private.describe('app.integration_channel_routes', 'Notification routes of a chat connection: each domain event type of the org or one project posts to one channel. Payloads carry only the event''s named, non-restricted fields.', array[
  'integration_connection_id', 'Slack or Teams connection.',
  'project_id', 'Project whose events post, or NULL for every project of the org.',
  'event_type', 'Domain event type from the webhook catalog.',
  'external_channel_id', 'Channel identifier (Slack channel id, or Teams team and channel ids joined by a slash).'
]);

call private.install_policies('app.integration_channel_routes',
  $$org_id in (select private.orgs_with_capability('org.integrations.manage'))$$,
  $$org_id in (select private.orgs_with_capability('org.integrations.manage'))$$);

create trigger t40_guard_integration_channel_route before insert or update of integration_connection_id on app.integration_channel_routes
  for each row execute function private.guard_integration_category('Communication');

create view app.integration_route_events with (security_invoker = true) as
select r.id as integration_channel_route_id, r.integration_connection_id, r.org_id, r.external_channel_id,
  e.id as domain_event_id, e.event_type, e.subject_table, e.subject_id, e.project_id, p.name as project_name, e.data, e.occurred_at
from app.integration_channel_routes r
join app.integration_connections c on c.id = r.integration_connection_id and c.connection_state = 'Connected' and c.deleted_at is null
join app.domain_events e on e.org_id = r.org_id and e.event_type = r.event_type
  and (r.project_id is null or e.project_id = r.project_id)
left join app.projects p on p.id = e.project_id
where r.deleted_at is null;

call private.describe('app.integration_route_events', 'Domain events matched to the channel routes of Connected chat connections. The runner reads events after its cursor (domain event ids are time ordered) and posts each one once.', array[
  'integration_channel_route_id', 'Route that matched.',
  'integration_connection_id', 'Chat connection.',
  'org_id', 'Org of the event.',
  'external_channel_id', 'Channel to post to.',
  'domain_event_id', 'Domain event, time-ordered UUID v7.',
  'event_type', 'Event type.',
  'subject_table', 'Table of the subject.',
  'subject_id', 'Subject row.',
  'project_id', 'Project of the event.',
  'project_name', 'Project name, for the message.',
  'data', 'Event payload: named, non-restricted fields only.',
  'occurred_at', 'When the event happened.'
]);

revoke all on app.integration_route_events from public, anon;
grant select on app.integration_route_events to authenticated, service_role;

-- Chat identity --------------------------------------------------------------------------------------------------------

create or replace function app.find_chat_connection(p_provider_code text, p_external_account_id text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id from app.integration_connections c
  join private.integration_providers p on p.provider_code = c.provider_code and p.category = 'Communication'
  where c.provider_code = p_provider_code and c.external_account_id = p_external_account_id
    and c.connection_state = 'Connected' and c.deleted_at is null;
$$;

comment on function app.find_chat_connection(text, text) is 'Chat handler: the Connected Slack or Teams connection of a workspace or tenant id, or NULL. Service role only.';

create or replace function app.resolve_chat_member(p_connection_id uuid, p_external_user_id text)
returns table (person_id uuid, user_id uuid, org_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.user_id, m.org_id
  from app.integration_external_ids x
  join app.memberships m on m.id = x.local_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  join app.people p on p.id = m.person_id
  join app.integration_connections c on c.id = x.integration_connection_id and c.org_id = m.org_id
  where x.integration_connection_id = p_connection_id and x.entity = 'Membership'
    and x.external_id = p_external_user_id and x.deleted_at is null
    and c.connection_state = 'Connected' and c.deleted_at is null;
$$;

comment on function app.resolve_chat_member(uuid, text) is 'Chat handler: the person and auth user behind a chat user id, through the connection''s Membership mapping, only while the membership is current. The handler then acts as that user under row level security. Service role only.';

revoke all on function app.find_chat_connection(text, text) from public, anon, authenticated;
revoke all on function app.resolve_chat_member(uuid, text) from public, anon, authenticated;
grant execute on function app.find_chat_connection(text, text) to service_role;
grant execute on function app.resolve_chat_member(uuid, text) to service_role;

call private.install_default_retention('app.integration_channel_routes');
