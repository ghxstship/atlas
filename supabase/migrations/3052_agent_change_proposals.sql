-- 3052_agent_change_proposals.sql
-- B16 (RRR-240), parity gap G-248, Sections 10.2 and 4.7, ADR 0155 D1 and D2: hosted MCP connectors for Claude and
-- ChatGPT, and the queue of changes they propose.
--   * A connector is a per-org OAuth app (app.oauth_apps, 0638; a public PKCE client mirrored into Supabase Auth, 1563)
--     that an Admin registers from a preset (app.register_mcp_connector), with the capability groups it gets when the
--     assistant asks for none (app.mcp_connectors.default_scopes, read by app.oauth_default_scopes). Dynamic client
--     registration stays off (ADR 0055 decision 15).
--   * Every hosted write is a proposal: app.propose_agent_change stores an Answered ai_requests row (feature
--     assistant, model external-agent, oauth_app_id set, no ai_usage row, so the Aurora allowance never counts it) and
--     an ai_suggestions row with the operation, its request (path, If-Match) and its fields, as Aurora's proposals
--     (0650). The person confirms each one in Atlas with their own session, so nothing is written with more than they
--     may do. A proposal never names a Restricted capability group (data, org, audit).
--   * A connector's token is still a full credential for /v1 and PostgREST within its grant, so the database enforces
--     the rule: private.refuse_read_only_org (t15, from 3051) and private.guard_share_link (from 3051) refuse any write
--     of a connector session outside the trusted operation agent_proposal (agent_write_needs_review). Tables exempt from
--     t15 rely on their row level security; this extends ADR 0033 decision 55. Other OAuth apps are unchanged.
--   * t14_agent_needs_person, before a suggestion's state changes: an app session or an API key never confirms or
--     applies an agent proposal (ai_suggestion_needs_person); a connector session may withdraw its own app's proposal
--     (Rejected), which runs inside agent_proposal. It is a trigger rather than a redefinition of
--     app.transition_ai_suggestion, which P6 (2830) also redefines, and it sorts before t15 so its rule is the one a
--     connector hears.
--   * A grant that ends (revoked, or its app removed) expires the person's open proposals from that app at once
--     (t91_expire_agent_proposals); a re-consent (the oauth_regrant trusted operation) does not.
--   * An agent states values without a model confidence, so ai_suggestion_fields lets a value carry a null confidence.
--   * app.console_platform_metrics (from 2300) counts only Aurora's own requests, never a connector's proposals.

-- Connectors -------------------------------------------------------------------------------------------------------

create type app.mcp_client_kind as enum ('Claude', 'ChatGPT', 'Other');
comment on type app.mcp_client_kind is 'The assistant an MCP connector app was registered for: Claude, ChatGPT, or another MCP client with its own HTTPS callback.';

create table app.mcp_connectors (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  oauth_app_id uuid not null references app.oauth_apps (id),
  client_kind app.mcp_client_kind not null,
  default_scopes text[] not null,
  constraint mcp_connectors_default_scopes check (
    cardinality(default_scopes) between 1 and 40
    and array_to_string(default_scopes, ' ') ~ '^[a-z][a-z0-9_]*( [a-z][a-z0-9_]*)*$')
);

call private.install_domain_table('app.mcp_connectors', 'app.oauth_apps', 'oauth_app_id');
create unique index mcp_connectors_oauth_app_key on app.mcp_connectors (oauth_app_id);
call private.describe('app.mcp_connectors', 'OAuth apps an Admin registered as hosted MCP connectors (Section 10.2, ADR 0155 D1): the assistant they are for and the capability groups an authorization gets when it asks for none. Every write such an app''s session makes is a proposal the person confirms in XOS (3052). Written only by app.register_mcp_connector; removing the app removes the connector.', array[
  'oauth_app_id', 'The registered OAuth app (app.oauth_apps) the assistant signs in with.',
  'client_kind', 'Claude, ChatGPT or Other.',
  'default_scopes', 'Capability groups an authorization gets when the assistant sends no scope; never a Restricted group.'
]);

call private.install_policies('app.mcp_connectors', $$org_id in (select private.orgs_with_capability('org.settings.read'))$$);
revoke insert, update, delete on app.mcp_connectors from authenticated;
call private.install_audit_trail('app.mcp_connectors');
call private.install_default_retention('app.mcp_connectors');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('mcp_connectors', 'Removing the OAuth app ends the connector; it is registered again from a preset, never restored.')
on conflict (table_name) do nothing;

create or replace function private.mcp_connector_session_app()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case when private.oauth_client_id() is null then null else (
    select c.oauth_app_id from private.oauth_app_clients c
    join app.oauth_apps a on a.id = c.oauth_app_id and a.deleted_at is null
    join app.mcp_connectors m on m.oauth_app_id = a.id and m.deleted_at is null
    where c.auth_client_id = private.oauth_client_id()) end;
$$;

comment on function private.mcp_connector_session_app() is 'For an MCP connector''s session (a JWT whose client_id is a connector app''s Supabase Auth client), the registered app; null for every other session, read without a lookup when the session carries no client_id.';
revoke all on function private.mcp_connector_session_app() from public, anon, authenticated;

create or replace function private.refuse_agent_write()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.oauth_client_id() is not null and not private.in_trusted_operation('agent_proposal')
     and private.mcp_connector_session_app() is not null then
    perform private.refuse('agent_write_needs_review', 'A connected assistant''s changes wait for the person to confirm them in XOS, Personal settings, Connected apps.');
  end if;
end;
$$;

comment on function private.refuse_agent_write() is 'Refuses agent_write_needs_review for an MCP connector session''s write outside the trusted operation agent_proposal (ADR 0155 D2): its changes are proposals. Costs nothing for a session without client_id.';
revoke all on function private.refuse_agent_write() from public, anon, authenticated;

create or replace function app.register_mcp_connector(
  p_org_id uuid,
  p_kind app.mcp_client_kind,
  p_name text,
  p_redirect_uri text,
  p_default_scopes text[]
)
returns table (oauth_app_id uuid, client_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_scopes text[] := (select array_agg(distinct lower(btrim(s)) order by lower(btrim(s)))
                      from unnest(p_default_scopes) s where btrim(s) <> '');
  v_unknown text;
  v_app uuid;
  v_client uuid;
begin
  perform private.require_person();
  if private.api_key_scopes() is not null or not private.has_capability(p_org_id, 'org.integrations.manage') then
    raise exception using errcode = '42501', message = 'org.integrations.manage is required, from the person''s own session';
  end if;
  if p_kind is null then
    perform private.refuse('mcp_client_kind_required', 'Choose Claude, ChatGPT or Other.');
  end if;
  if p_redirect_uri is null or p_redirect_uri !~ '^https://[^/?#\s]+' or p_redirect_uri ~ '#' or char_length(p_redirect_uri) > 2000 then
    perform private.refuse('mcp_redirect_uri_invalid', 'The assistant''s callback is an https address without a fragment.');
  end if;
  if v_scopes is null or cardinality(v_scopes) not between 1 and 40 then
    perform private.refuse('oauth_scope_missing', 'Choose at least one capability group, and at most 40.');
  end if;
  select s into v_unknown from unnest(v_scopes) s
  where not exists (select 1 from app.capabilities c where c.module_code = s) limit 1;
  if v_unknown is not null then
    perform private.refuse('oauth_scope_unknown', format('%s is not a capability group.', v_unknown));
  end if;
  select s into v_unknown from unnest(v_scopes) s where private.oauth_scope_restricted(s) limit 1;
  if v_unknown is not null then
    perform private.refuse('mcp_scope_restricted', format('An assistant connector never gets %s by default: it reaches Restricted data or the org''s control.', v_unknown));
  end if;

  insert into app.oauth_apps (org_id, name, redirect_uri)
  values (p_org_id, coalesce(nullif(btrim(coalesce(p_name, '')), ''), p_kind::text), p_redirect_uri)
  returning id into v_app;
  insert into app.mcp_connectors (oauth_app_id, client_kind, default_scopes) values (v_app, p_kind, v_scopes);
  select c.auth_client_id into v_client from private.oauth_app_clients c where c.oauth_app_id = v_app;
  return query select v_app, v_client;
end;
$$;

comment on function app.register_mcp_connector(uuid, app.mcp_client_kind, text, text, text[]) is 'Registers a hosted MCP connector for the org (org.integrations.manage, from the person''s own session; ADR 0155 D1): an OAuth app (named for the assistant unless p_name is given) with the assistant''s https callback, mirrored into Supabase Auth as a public PKCE client, and its default capability groups. Refuses unknown groups (oauth_scope_unknown) and Restricted ones (mcp_scope_restricted). Returns the app and the Supabase Auth client id the Admin pastes into the assistant''s connector settings.';
revoke all on function app.register_mcp_connector(uuid, app.mcp_client_kind, text, text, text[]) from public, anon;
grant execute on function app.register_mcp_connector(uuid, app.mcp_client_kind, text, text, text[]) to authenticated;

create or replace function app.oauth_default_scopes(p_client_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select m.default_scopes
  from private.oauth_app_clients c
  join app.oauth_apps a on a.id = c.oauth_app_id and a.deleted_at is null
  join app.mcp_connectors m on m.oauth_app_id = a.id and m.deleted_at is null
  where c.auth_client_id = p_client_id and private.is_member(a.org_id);
$$;

comment on function app.oauth_default_scopes(uuid) is 'The capability groups an MCP connector''s authorization gets when the assistant sends no scope (Atlas''s /oauth/authorize), for a signed-in member of the org that registered it; null for any other client or caller.';
revoke all on function app.oauth_default_scopes(uuid) from public, anon;
grant execute on function app.oauth_default_scopes(uuid) to authenticated;

-- Redefined from 1563 (its only definition): removing an app also removes its connector row.
create or replace function private.sync_oauth_client()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client uuid;
begin
  if tg_op = 'INSERT' then
    v_client := gen_random_uuid();
    -- A public client exactly as Supabase Auth's admin API writes one: an empty secret hash, no secret.
    insert into auth.oauth_clients (id, client_secret_hash, registration_type, redirect_uris, grant_types, client_name,
      client_type, token_endpoint_auth_method)
    values (v_client, '', 'manual', new.redirect_uri, 'authorization_code,refresh_token', btrim(new.name), 'public', 'none');
    insert into private.oauth_app_clients (oauth_app_id, auth_client_id) values (new.id, v_client);
    return new;
  end if;
  select c.auth_client_id into v_client from private.oauth_app_clients c where c.oauth_app_id = new.id;
  if v_client is null then
    return new;
  end if;
  if new.deleted_at is not null and old.deleted_at is null then
    -- Removing the app ends it everywhere: its consents, its sessions, its connector and the client itself. Ending the
    -- grants expires the proposals waiting from the app (t91_expire_agent_proposals).
    update app.oauth_grants set deleted_at = now() where oauth_app_id = new.id and deleted_at is null;
    update auth.oauth_consents set revoked_at = now() where client_id = v_client and revoked_at is null;
    delete from auth.sessions where oauth_client_id = v_client;
    update auth.oauth_clients set deleted_at = now(), updated_at = now() where id = v_client;
    update app.mcp_connectors set deleted_at = now() where oauth_app_id = new.id and deleted_at is null;
  elsif new.name is distinct from old.name or new.redirect_uri is distinct from old.redirect_uri then
    update auth.oauth_clients set client_name = btrim(new.name), redirect_uris = new.redirect_uri, updated_at = now()
    where id = v_client;
  end if;
  return new;
end;
$$;

comment on function private.sync_oauth_client() is 'Keeps the Supabase Auth OAuth client of a registered app in step (ADR 0055): created with the app as a public PKCE client, renamed and re-pointed with it, and on removal its grants, consents, sessions, its MCP connector (3052) and the client end.';
revoke all on function private.sync_oauth_client() from public, anon, authenticated;

-- Proposals ---------------------------------------------------------------------------------------------------------

alter table app.ai_requests add column oauth_app_id uuid references app.oauth_apps (id);
create index ai_requests_oauth_app_id_idx on app.ai_requests (oauth_app_id);
comment on column app.ai_requests.oauth_app_id is 'Connected app that proposed the change; null for Aurora.';
-- The tenant guards again, now with the app among the references that must belong to the row's org.
call private.install_tenant_guards('app.ai_requests', null, null, array['app.oauth_apps', 'oauth_app_id']);

alter table app.ai_suggestions add column operation_request jsonb;
alter table app.ai_suggestions add constraint ai_suggestions_operation_request_shape check (
  operation_request is null or (
    jsonb_typeof(operation_request) = 'object'
    and (operation_request - array['path', 'if_match', 'idempotency_key']) = '{}'::jsonb
    and (not operation_request ? 'path' or jsonb_typeof(operation_request -> 'path') = 'object')
    and (not operation_request ? 'if_match' or (jsonb_typeof(operation_request -> 'if_match') = 'string'
                                                and char_length(operation_request ->> 'if_match') <= 200))
    and (not operation_request ? 'idempotency_key' or (jsonb_typeof(operation_request -> 'idempotency_key') = 'string'
                                                       and char_length(operation_request ->> 'idempotency_key') between 8 and 255))));
comment on column app.ai_suggestions.operation_request is 'For a connected app''s proposal (3052): how to call the operation, as path (its path values), if_match (the etag the app read, so a stale proposal fails) and idempotency_key. Null for Aurora''s.';

alter table app.ai_suggestion_fields drop constraint ai_suggestion_fields_value_or_refusal;
alter table app.ai_suggestion_fields add constraint ai_suggestion_fields_value_or_refusal check (
  (refusal is null and proposed_value is not null and missing is null)
  or (refusal is not null and proposed_value is null and confidence is null and missing is not null));
comment on column app.ai_suggestion_fields.confidence is 'Confidence from 0 to 1; null when NO_ANSWER or when an agent proposed the value without a score.';

comment on table app.ai_usage is 'Aurora AI metering (ADR 0020): one row per authorized request. The monthly allowance aurora_requests_per_month counts these rows by metered_at in UTC months. Token counts arrive when the request completes. Kept for billing after request content is purged. A connected app''s proposals (3052) are not Aurora model calls and are never metered.';

create or replace function app.propose_agent_change(
  p_operation_id text,
  p_operation_scopes text[],
  p_target_id uuid,
  p_summary text,
  p_path jsonb,
  p_if_match text,
  p_fields jsonb
)
returns table (suggestion_id uuid, expires_at timestamptz, org_slug text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
  v_session record;
  v_app_name text;
  v_scope text;
  v_request uuid;
  v_suggestion app.ai_suggestions;
  v_field jsonb;
  v_position smallint := 0;
  v_request_shape jsonb;
begin
  select s.oauth_app_id, s.org_id, s.scopes into v_session from private.oauth_session() s;
  if v_me is null or v_session.oauth_app_id is null or cardinality(v_session.scopes) = 0 then
    perform private.refuse('agent_session_required', 'Only a connected app''s session proposes a change, while the person''s grant to it is live.');
  end if;
  if not private.is_member(v_session.org_id) then
    raise exception using errcode = '42501', message = 'proposals need an active membership in the app''s org';
  end if;
  if p_operation_id is null or p_operation_id !~ '^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$'
     or p_operation_id like 'ai%' or p_operation_id like 'aurora%' then
    perform private.refuse('agent_operation_not_allowed', 'A connected app cannot propose this operation.');
  end if;
  if p_operation_scopes is null or cardinality(p_operation_scopes) = 0 or not (p_operation_scopes <@ v_session.scopes) then
    perform private.refuse('agent_outside_grant', 'This operation is outside the capability groups the person granted the app.');
  end if;
  select s into v_scope from unnest(p_operation_scopes) s where private.oauth_scope_restricted(s) limit 1;
  if v_scope is not null then
    perform private.refuse('agent_operation_restricted', 'A connected app cannot propose a change that reaches Restricted data or the org''s control.');
  end if;
  if (select count(*) from app.ai_suggestions s join app.ai_requests r on r.id = s.request_id
      where r.person_id = v_me and r.oauth_app_id = v_session.oauth_app_id and s.suggestion_state = 'Proposed'
        and s.expires_at > now() and s.deleted_at is null) >= 100 then
    perform private.refuse('agent_proposals_limit', 'This app already has 100 changes waiting for you. Review them in Connected apps first.');
  end if;
  if jsonb_typeof(coalesce(p_fields, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_fields, '[]'::jsonb)) > 100 then
    perform private.refuse('ai_suggestion_fields_shape', 'Fields come as a list of at most 100.');
  end if;
  if p_path is not null and jsonb_typeof(p_path) <> 'object' then
    perform private.refuse('agent_path_shape', 'Path values come as an object.');
  end if;
  v_request_shape := jsonb_strip_nulls(jsonb_build_object('path', p_path, 'if_match', p_if_match));

  perform private.begin_trusted_operation('agent_proposal');
  insert into app.ai_requests (org_id, person_id, feature, model, outcome, completed_at, oauth_app_id)
  values (v_session.org_id, v_me, 'assistant', 'external-agent', 'Answered', now(), v_session.oauth_app_id)
  returning id into v_request;
  insert into app.ai_suggestions (request_id, operation_id, target_id, summary, operation_request)
  values (v_request, p_operation_id, p_target_id, private.ai_redact(btrim(coalesce(p_summary, ''))),
    case when v_request_shape = '{}'::jsonb then null else v_request_shape end)
  returning * into v_suggestion;
  for v_field in select value from jsonb_array_elements(coalesce(p_fields, '[]'::jsonb)) loop
    -- A JSON null is a value (clearing the field), stored as 'null'::jsonb, never as SQL null.
    insert into app.ai_suggestion_fields (suggestion_id, field_path, proposed_value, position)
    values (v_suggestion.id, v_field ->> 'field_path', coalesce(v_field -> 'value', 'null'::jsonb), v_position);
    v_position := v_position + 1;
  end loop;

  perform private.emit_event(v_session.org_id, 'ai_suggestion.proposed', 'ai_suggestions', v_suggestion.id, null,
    jsonb_build_object('operation_id', p_operation_id, 'feature', 'assistant', 'oauth_app_id', v_session.oauth_app_id));
  -- One unread notice per person and app is enough: the panel lists every proposal waiting.
  select a.name into v_app_name from app.oauth_apps a where a.id = v_session.oauth_app_id;
  if not exists (select 1 from app.notifications n
                 where n.recipient_person_id = v_me and n.kind = 'agent.change_proposed' and n.read_at is null
                   and n.archived_at is null and n.message_args ->> 'appId' = v_session.oauth_app_id::text) then
    perform private.notify(v_session.org_id, v_me, 'agent.change_proposed', 'app.ai_suggestions', v_suggestion.id, null,
      jsonb_build_object('app', v_app_name, 'appId', v_session.oauth_app_id, 'operation', p_operation_id));
  end if;
  perform private.end_trusted_operation('agent_proposal');

  return query select v_suggestion.id, v_suggestion.expires_at, (select o.slug from app.organizations o where o.id = v_session.org_id);
end;
$$;

comment on function app.propose_agent_change(text, text[], uuid, text, jsonb, text, jsonb) is 'A connected app proposes a change for its person to confirm (hosted MCP, ADR 0155 D2): only from an app''s session with a live grant (agent_session_required), for an active member of the app''s org (42501). The operation id may not be Aurora''s own (agent_operation_not_allowed), its capability groups must lie within the grant (agent_outside_grant) and never be Restricted (agent_operation_restricted), and at most 100 wait per person and app (agent_proposals_limit). Stores an Answered ai_requests row (feature assistant, model external-agent, oauth_app_id; no ai_usage row) and the suggestion with its request (path, If-Match), its summary redacted and its fields (no confidence; a JSON null clears a field), and tells the person (agent.change_proposed, once while unread per app). The read-only guard still applies, so a paused org or a read-only seat refuses it. Nothing is written to the target until the person confirms. Returns the suggestion, its expiry (7 days) and the org slug for the review link.';
revoke all on function app.propose_agent_change(text, text[], uuid, text, jsonb, text, jsonb) from public, anon;
grant execute on function app.propose_agent_change(text, text[], uuid, text, jsonb, text, jsonb) to authenticated;

create or replace function app.my_agent_proposals(p_org_id uuid)
returns table (
  suggestion_id uuid,
  oauth_app_id uuid,
  app_name text,
  operation_id text,
  summary text,
  target_id uuid,
  fields jsonb,
  operation_request jsonb,
  created_at timestamptz,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, a.id, a.name, s.operation_id, s.summary, s.target_id,
         coalesce((select jsonb_agg(jsonb_build_object('field_path', f.field_path, 'value', f.proposed_value) order by f.position)
                   from app.ai_suggestion_fields f where f.suggestion_id = s.id and f.deleted_at is null), '[]'::jsonb),
         s.operation_request, s.created_at, s.expires_at
  from app.ai_suggestions s
  join app.ai_requests r on r.id = s.request_id
  join app.oauth_apps a on a.id = r.oauth_app_id and a.deleted_at is null
  where s.org_id = p_org_id and r.person_id = private.current_person_id() and s.suggestion_state = 'Proposed'
    and s.expires_at > now() and s.deleted_at is null and private.is_member(p_org_id)
  order by s.created_at desc;
$$;

comment on function app.my_agent_proposals(uuid) is 'The changes connected apps proposed for the caller in an org that still wait for them (Personal settings, Connected apps; 3052): each Proposed, unexpired agent suggestion of a live app with the app, the operation, the record, the app''s note, the fields (path and value) and how to call the operation. Only the caller''s own.';
revoke all on function app.my_agent_proposals(uuid) from public, anon;
grant execute on function app.my_agent_proposals(uuid) to authenticated;

create or replace function app.agent_proposal_for_apply(p_suggestion_id uuid)
returns table (
  suggestion_id uuid,
  org_id uuid,
  operation_id text,
  target_id uuid,
  operation_request jsonb,
  fields jsonb,
  grant_scopes text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_suggestion app.ai_suggestions;
  v_request app.ai_requests;
  v_scopes text[];
begin
  select * into v_suggestion from app.ai_suggestions s where s.id = p_suggestion_id and s.deleted_at is null;
  select * into v_request from app.ai_requests r where r.id = v_suggestion.request_id;
  if v_suggestion.id is null or v_request.person_id is distinct from private.current_person_id()
     or v_request.oauth_app_id is null then
    raise exception using errcode = '42501', message = 'only the person an app proposed a change to confirms it';
  end if;
  if private.api_key_scopes() is not null then
    perform private.refuse('ai_suggestion_needs_person', 'A connected app cannot confirm its own change; confirm it in Atlas.');
  end if;
  if v_suggestion.suggestion_state <> 'Proposed' then
    perform private.refuse('ai_suggestion_not_proposed', 'This change was already confirmed, rejected or expired.');
  end if;
  if v_suggestion.expires_at <= now() then
    perform private.refuse('ai_suggestion_expired', 'This suggestion has expired. Ask again to get a fresh one.');
  end if;
  select g.scopes into v_scopes from app.oauth_grants g
  join app.oauth_apps a on a.id = g.oauth_app_id and a.deleted_at is null
  where g.oauth_app_id = v_request.oauth_app_id and g.person_id = v_request.person_id and g.deleted_at is null
  order by g.granted_at desc limit 1;
  if v_scopes is null then
    perform private.refuse('agent_grant_revoked', 'You no longer let this app act for you, so its changes cannot be confirmed.');
  end if;
  return query select v_suggestion.id, v_suggestion.org_id, v_suggestion.operation_id, v_suggestion.target_id,
    v_suggestion.operation_request,
    coalesce((select jsonb_agg(jsonb_build_object('field_path', f.field_path, 'value', f.proposed_value) order by f.position)
              from app.ai_suggestion_fields f where f.suggestion_id = v_suggestion.id and f.deleted_at is null), '[]'::jsonb),
    v_scopes;
end;
$$;

comment on function app.agent_proposal_for_apply(uuid) is 'What Atlas needs to confirm a connected app''s proposal with the person''s own session: the operation, its request, the fields and the capability groups of the person''s live grant to the app, which Atlas checks the operation against. Refuses another person''s or an Aurora suggestion (42501), an app session or API key (ai_suggestion_needs_person), one no longer Proposed (ai_suggestion_not_proposed), an expired one (ai_suggestion_expired) and one whose grant ended (agent_grant_revoked).';
revoke all on function app.agent_proposal_for_apply(uuid) from public, anon;
grant execute on function app.agent_proposal_for_apply(uuid) to authenticated;

-- Confirming needs the person ---------------------------------------------------------------------------------------

create or replace function private.guard_agent_proposal_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app uuid;
begin
  if new.suggestion_state is not distinct from old.suggestion_state then
    return new;
  end if;
  select r.oauth_app_id into v_app from app.ai_requests r where r.id = new.request_id;
  if v_app is null or private.api_key_scopes() is null then
    return new;
  end if;
  if new.suggestion_state in ('Confirmed', 'Applied') then
    perform private.refuse('ai_suggestion_needs_person', 'A connected app cannot confirm its own change; confirm it in Atlas.');
  end if;
  -- A connector withdraws its own app's proposal inside agent_proposal; the ledger row closes it (t90 below).
  if new.suggestion_state = 'Rejected' and private.mcp_connector_session_app() = v_app then
    perform private.begin_trusted_operation('agent_proposal');
  end if;
  return new;
end;
$$;

comment on function private.guard_agent_proposal_state() is 'Before a suggestion''s state changes (t14_agent_needs_person, 3052): an app session or an API key never confirms or applies a connected app''s proposal (ai_suggestion_needs_person); a connector session withdrawing its own app''s proposal (Rejected) does it inside the trusted operation agent_proposal, which the transition''s ledger row ends.';
revoke all on function private.guard_agent_proposal_state() from public, anon, authenticated;

create trigger t14_agent_needs_person before update of suggestion_state on app.ai_suggestions
  for each row execute function private.guard_agent_proposal_state();

create or replace function private.end_agent_withdrawal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.to_state = 'Rejected' and private.in_trusted_operation('agent_proposal') then
    perform private.end_trusted_operation('agent_proposal');
  end if;
  return null;
end;
$$;

comment on function private.end_agent_withdrawal() is 'Ends the agent_proposal trusted operation a connector''s withdrawal opened (private.guard_agent_proposal_state), once the transition''s ledger row is written.';
revoke all on function private.end_agent_withdrawal() from public, anon, authenticated;

create trigger t90_end_agent_withdrawal after insert on app.ai_suggestion_state_transitions
  for each row execute function private.end_agent_withdrawal();

-- A grant that ends expires its proposals -----------------------------------------------------------------------------

create or replace function private.expire_agent_proposals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row app.oauth_grants := case when tg_op = 'DELETE' then old else new end;
  v_id uuid;
begin
  if (tg_op = 'UPDATE' and not (new.deleted_at is not null and old.deleted_at is null))
     or private.in_trusted_operation('oauth_regrant') then
    return null;
  end if;
  perform private.begin_trusted_operation('agent_proposal');
  for v_id in
    select s.id from app.ai_suggestions s join app.ai_requests r on r.id = s.request_id
    where r.oauth_app_id = v_row.oauth_app_id and r.person_id = v_row.person_id
      and s.suggestion_state = 'Proposed' and s.deleted_at is null
  loop
    perform private.transition_lifecycle('ai_suggestion', 'app.ai_suggestions', 'suggestion_state',
      'app.ai_suggestion_state_transitions', 'suggestion_id', v_id, 'Proposed', 'Expired', 'The grant to the app ended.');
  end loop;
  perform private.end_trusted_operation('agent_proposal');
  return null;
end;
$$;

comment on function private.expire_agent_proposals() is 'When a person''s grant to an app ends (revoked, or the app removed; not replaced by a new consent, oauth_regrant), expires that person''s Proposed suggestions from the app at once (3052, ADR 0155 D2).';
revoke all on function private.expire_agent_proposals() from public, anon, authenticated;

create trigger t91_expire_agent_proposals after update or delete on app.oauth_grants
  for each row execute function private.expire_agent_proposals();


-- The guards: a connector's writes are proposals ------------------------------------------------------------------

-- Redefined from 3051 (its latest definition): a connector session's write is refused first.
create or replace function private.refuse_read_only_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := ((case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> 'org_id')::uuid;
  v_reason text;
  v_table text;
  v_old jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_new jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
begin
  if private.current_person_id() is null or v_org is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  perform private.refuse_agent_write();
  v_reason := private.org_read_only_reason(v_org);
  if v_reason in ('deletion', 'canceled', 'dunning') then
    perform private.refuse('org_read_only', private.read_only_refusal(v_reason));
  end if;
  if v_reason = 'paused' or exists (select 1 from app.over_limit_objects x where x.org_id = v_org) then
    -- On a partitioned table the trigger runs on the month partition; the guard asks about the table it was declared on.
    v_table := coalesce((select i.inhparent::regclass::text from pg_catalog.pg_inherits i
                         join pg_catalog.pg_class c on c.oid = i.inhrelid
                         where i.inhrelid = tg_relid and c.relispartition), tg_relid::regclass::text);
  end if;
  -- A paused org keeps the personal tables (ADR 0081), and a member may leave: the offboarding row that leaving opens
  -- (t81_open_offboarding) is about their own membership, which has just ended.
  if v_reason = 'paused'
     and not private.personal_write_allowed(v_table, v_old, v_new)
     and not (tg_op = 'INSERT' and v_table = 'app.offboardings'
              and exists (select 1 from app.memberships m
                          where m.id = private.as_uuid(v_new ->> 'membership_id')
                            and m.person_id = private.current_person_id()
                            and m.valid_to is not null and m.valid_to <= now())) then
    perform private.refuse('org_read_only', private.read_only_refusal(v_reason));
  end if;
  if exists (select 1 from app.over_limit_objects x where x.org_id = v_org) then
    perform private.refuse_over_limit_write(v_org, v_table, v_old, v_new);
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

comment on function private.refuse_read_only_org() is 'Refuses an MCP connector session''s write outside its proposals (agent_write_needs_review, private.refuse_agent_write, 3052), then refuses a person''s write to a row of a read-only org, with the sentence of its reason (private.read_only_refusal): canceled, waiting for deletion (Section 14.7), past day 21 of dunning (Section 16) or paused (3051); and a write to what a plan limit made read-only (Section 16, 2070). While paused the personal tables stay writable under A107''s own-row rules (private.personal_write_allowed) and a member may leave. Workers, billing and retention (no person) still write.';
revoke all on function private.refuse_read_only_org() from public, anon, authenticated;

-- Redefined from 3051 (its latest definition): a connector session neither makes nor changes a share link.
create or replace function private.guard_share_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.current_person_id();
  v_attachment app.attachments;
  v_version app.attachment_versions;
  v_token text := 'xshr_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_code text;
  v_limit interval;
  v_reason text;
begin
  -- A connector session neither makes nor changes a link (3052): its changes are proposals.
  perform private.refuse_agent_write();
  if tg_op = 'UPDATE' then
    if not private.in_trusted_operation('share_link_service') then
      perform private.refuse('share_link_immutable', 'A share link changes only when it is opened or revoked.');
    end if;
    return new;
  end if;

  if v_person is null then
    perform private.refuse('share_link_person', 'A share link is made by a signed-in person.');
  end if;
  select * into v_attachment from app.attachments a where a.id = new.attachment_id and a.deleted_at is null;
  select * into v_version from app.attachment_versions v
  where v.attachment_id = new.attachment_id and v.scan_status = 'Clean' and v.deleted_at is null
  order by v.version_number desc limit 1;
  if v_attachment.id is null or v_version.id is null then
    perform private.refuse('share_link_file', 'Only a file with a version that scanned clean can be shared.');
  end if;
  if not private.is_member(v_attachment.org_id) then
    raise exception using errcode = '42501', message = 'file not found';
  end if;
  v_reason := private.org_read_only_reason(v_attachment.org_id);
  if v_reason is not null then
    perform private.refuse('org_read_only', private.read_only_refusal(v_reason));
  end if;
  -- Making a link is a write to its file for the plan limits: refused to a read-only seat and for a read-only project.
  if exists (select 1 from app.over_limit_objects x where x.org_id = v_attachment.org_id) then
    perform private.refuse_over_limit_write(v_attachment.org_id, 'app.attachments', null, to_jsonb(v_attachment));
  end if;

  new.org_id := v_attachment.org_id;
  new.attachment_version_id := v_version.id;
  new.classification := v_attachment.classification;
  new.recipient_email := nullif(lower(btrim(coalesce(new.recipient_email, ''))), '');
  new.note := nullif(btrim(coalesce(new.note, '')), '');
  new.failed_attempts := 0;
  new.open_count := 0;
  new.last_opened_at := null;
  new.revoked_at := null;
  new.revoked_by := null;

  if new.classification = 'Restricted' then
    perform private.refuse('share_link_restricted', 'A Restricted file is never shared by link (Section 8.6).');
  end if;
  if new.classification = 'Confidential' then
    if not private.has_capability(new.org_id, 'data.export.confidential') then
      perform private.refuse('share_link_confidential', 'Sharing a Confidential file needs the export capability for Confidential data.');
    end if;
    if new.recipient_email is null then
      perform private.refuse('share_link_recipient', 'A link to a Confidential file names who it is for; the watermark carries that address.');
    end if;
    if private.watermark_required(new.classification, v_version.content_type)
       and not private.watermarkable_content_type(v_version.content_type) then
      perform private.refuse('share_link_watermark_unsupported', 'A Confidential image other than a PNG or JPEG cannot carry the viewer watermark, so it cannot be shared by link.');
    end if;
    new.access_code_required := true;
  end if;
  if new.expires_at is null and new.classification <> 'Public' then
    perform private.refuse('share_link_expiry', 'A link to an Internal or Confidential file needs an expiry date.');
  end if;
  v_limit := case when new.classification = 'Confidential' then interval '30 days' else interval '90 days' end;
  if new.expires_at is not null and (new.expires_at <= now() or new.expires_at > now() + v_limit) then
    perform private.refuse('share_link_expiry_range', format('A link expires after now and within %s.', v_limit));
  end if;
  if new.recipient_email is not null and new.recipient_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform private.refuse('share_link_recipient_format', 'Enter the recipient''s email address.');
  end if;

  if new.access_code_required then
    v_code := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
    new.access_code_hash := private.share_code_hash(v_token, v_code);
  else
    new.access_code_hash := null;
  end if;
  new.token_hash := private.share_token_hash(v_token);
  perform pg_catalog.set_config('xos.share_link_secret',
    jsonb_build_object('token', v_token, 'access_code', v_code)::text, true);

  insert into app.file_access_log (org_id, person_id, bucket_id, object_path, action, classification, watermarked)
  values (new.org_id, v_person, 'attachments', v_version.object_name, 'Share Link Created', new.classification, false);
  return new;
end;
$$;

comment on function private.guard_share_link() is 'Share links: the database copies the file''s org, classification and current Clean version, applies the Section 8.6 rules (no Restricted file; Internal needs an expiry; Confidential needs data.export.confidential, an expiry within 30 days, an access code, the recipient''s email and a type the watermark can carry: a PDF, PNG or JPEG since 2040), draws the token and the code, stores only their hashes and logs Share Link Created. A read-only org makes no link, refused with the sentence of its reason (private.read_only_refusal, 3051). Making a link counts as a write to its file for the plan limits (2070, ADR 0081): a person whose own seat is read-only, or a file of a read-only project, gets plan_limit_read_only. An MCP connector session neither makes nor changes a link (agent_write_needs_review, 3052). Afterwards a link changes only inside the open and revoke RPCs, so revoking stays open.';
revoke all on function private.guard_share_link() from public, anon, authenticated;

-- The operator console counts Aurora's own requests ---------------------------------------------------------------

-- Redefined from 2300 (its only definition): a connected app's proposals are not Aurora requests.
create or replace function app.console_platform_metrics(p_weeks integer default 12)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_weeks integer := least(greatest(coalesce(p_weeks, 12), 1), 52);
  v_this_week date := date_trunc('week', now() at time zone 'UTC')::date;
  v_first_week date;
  v_first_instant timestamptz;
  v_month date := date_trunc('month', now() at time zone 'UTC')::date;
  v_result jsonb;
begin
  perform private.require_platform_operator('tenants.read');
  v_first_week := v_this_week - (v_weeks - 1) * 7;
  v_first_instant := v_first_week::timestamp at time zone 'UTC';

  with weeks as (
    select (v_first_week + i * 7) as week_start from generate_series(0, v_weeks - 1) i
  ),
  new_orgs as (
    select date_trunc('week', o.created_at at time zone 'UTC')::date as week_start, count(*) as n
    from app.organizations o
    where o.created_at >= v_first_instant
    group by 1
  ),
  sign_ups as (
    select date_trunc('week', u.created_at at time zone 'UTC')::date as week_start, count(*) as n
    from auth.users u
    join app.people p on p.user_id = u.id and p.deleted_at is null
    where u.created_at >= v_first_instant
    group by 1
  ),
  aurora as (
    select date_trunc('week', r.created_at at time zone 'UTC')::date as week_start, count(*) as n
    from app.ai_requests r
    where r.created_at >= v_first_instant and r.deleted_at is null and r.oauth_app_id is null
    group by 1
  ),
  activity as (
    select greatest(u.last_sign_in_at, d.last_seen_at) as last_active_at
    from app.people p
    join auth.users u on u.id = p.user_id
    left join lateral (
      select max(x.last_seen_at) as last_seen_at from private.session_devices x where x.user_id = u.id
    ) d on true
    where p.deleted_at is null
  ),
  live_subscriptions as (
    select s.plan_code, s.subscription_state, s.trial_ends_at
    from app.subscriptions s
    join app.organizations o on o.id = s.org_id and o.deleted_at is null
    where s.subscription_state <> 'canceled' and s.deleted_at is null
  ),
  job_rows as (
    select j.job_kind, j.job_status, j.run_after, j.locked_at, j.finished_at
    from app.job_queue j
    where j.deleted_at is null
      and (j.job_status in ('Queued', 'Running') or j.finished_at >= now() - interval '24 hours')
  ),
  deliveries as (
    select d.channel, d.message_status
    from app.notification_deliveries d
    where d.notification_created_at >= now() - interval '7 days' and d.deleted_at is null
  )
  select jsonb_build_object(
    'generated_at', now(),
    'weeks', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'week_start', w.week_start,
        'new_orgs', coalesce(no.n, 0),
        'sign_ups', coalesce(su.n, 0),
        'aurora_requests', coalesce(au.n, 0)) order by w.week_start), '[]'::jsonb)
      from weeks w
      left join new_orgs no on no.week_start = w.week_start
      left join sign_ups su on su.week_start = w.week_start
      left join aurora au on au.week_start = w.week_start),
    'orgs', (
      select jsonb_build_object(
        'live', count(*),
        'clients', count(*) filter (where o.parent_org_id is not null),
        'without_subscription', count(*) filter (where not exists (
          select 1 from app.subscriptions s
          where s.org_id = o.id and s.subscription_state <> 'canceled' and s.deleted_at is null)))
      from app.organizations o
      where o.deleted_at is null),
    'people', (
      select jsonb_build_object(
        'with_account', count(*),
        'active_1d', count(*) filter (where a.last_active_at >= now() - interval '1 day'),
        'active_7d', count(*) filter (where a.last_active_at >= now() - interval '7 days'),
        'active_30d', count(*) filter (where a.last_active_at >= now() - interval '30 days'))
      from activity a),
    'plans', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'plan_code', pl.code,
        'orgs', coalesce(m.orgs, 0),
        'trialing', coalesce(m.trialing, 0),
        'active', coalesce(m.active, 0),
        'past_due', coalesce(m.past_due, 0),
        'read_only', coalesce(m.read_only, 0)) order by pl.sort_order), '[]'::jsonb)
      from app.plans pl
      left join (
        select ls.plan_code, count(*) as orgs,
          count(*) filter (where ls.subscription_state = 'trialing') as trialing,
          count(*) filter (where ls.subscription_state = 'active') as active,
          count(*) filter (where ls.subscription_state = 'past_due') as past_due,
          count(*) filter (where ls.subscription_state = 'read_only') as read_only
        from live_subscriptions ls
        group by ls.plan_code
      ) m on m.plan_code = pl.code),
    'trials', (
      select jsonb_build_object(
        'trialing', count(*),
        'ending_7d', count(*) filter (where ls.trial_ends_at < now() + interval '7 days'))
      from live_subscriptions ls
      where ls.subscription_state = 'trialing'),
    'usage', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'period_start', u.period_start,
        'meter_code', u.meter_code,
        'unit', u.unit,
        'quantity', u.quantity,
        'orgs', u.orgs) order by u.period_start desc, u.sort_order), '[]'::jsonb)
      from (
        select r.period_start, r.meter_code, um.unit, um.sort_order, sum(r.quantity) as quantity,
          count(distinct r.org_id) as orgs
        from app.usage_rollups r
        join private.usage_meters um on um.code = r.meter_code
        where r.period_start >= (v_month - interval '3 months')::date and r.deleted_at is null
        group by r.period_start, r.meter_code, um.unit, um.sort_order
      ) u),
    'aurora', (
      select jsonb_build_object(
        'requests_30d', (select count(*) from app.ai_requests r
          where r.created_at >= now() - interval '30 days' and r.deleted_at is null and r.oauth_app_id is null),
        'outcomes', (
          select coalesce(jsonb_agg(jsonb_build_object('outcome', x.outcome, 'requests', x.n) order by x.outcome), '[]'::jsonb)
          from (select r.outcome, count(*) as n from app.ai_requests r
                where r.created_at >= now() - interval '30 days' and r.deleted_at is null and r.oauth_app_id is null
                group by r.outcome) x),
        'features', (
          select coalesce(jsonb_agg(jsonb_build_object('feature', x.feature, 'requests', x.n) order by x.feature), '[]'::jsonb)
          from (select r.feature, count(*) as n from app.ai_requests r
                where r.created_at >= now() - interval '30 days' and r.deleted_at is null and r.oauth_app_id is null
                group by r.feature) x),
        'input_tokens_30d', (select coalesce(sum(u.input_tokens), 0) from app.ai_usage u
          where u.metered_at >= now() - interval '30 days' and u.deleted_at is null),
        'output_tokens_30d', (select coalesce(sum(u.output_tokens), 0) from app.ai_usage u
          where u.metered_at >= now() - interval '30 days' and u.deleted_at is null))),
    'jobs', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'job_kind', k.job_kind,
        'ready', k.ready,
        'scheduled', k.scheduled,
        'running', k.running,
        'stalled', k.stalled,
        'failed_24h', k.failed_24h,
        'succeeded_24h', k.succeeded_24h,
        'oldest_ready_at', k.oldest_ready_at) order by k.job_kind), '[]'::jsonb)
      from (
        select j.job_kind,
          count(*) filter (where j.job_status = 'Queued' and j.run_after <= now()) as ready,
          count(*) filter (where j.job_status = 'Queued' and j.run_after > now()) as scheduled,
          count(*) filter (where j.job_status = 'Running') as running,
          count(*) filter (where j.job_status = 'Running' and j.locked_at < now() - interval '30 minutes') as stalled,
          count(*) filter (where j.job_status = 'Failed') as failed_24h,
          count(*) filter (where j.job_status = 'Succeeded') as succeeded_24h,
          min(j.run_after) filter (where j.job_status = 'Queued' and j.run_after <= now()) as oldest_ready_at
        from job_rows j
        group by j.job_kind
      ) k),
    'notifications', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'channel', n.channel,
        'total', n.total,
        'sent', n.sent,
        'pending', n.pending,
        'failed', n.failed,
        'bounced', n.bounced,
        'suppressed', n.suppressed) order by n.channel), '[]'::jsonb)
      from (
        select c.channel,
          count(d.message_status) as total,
          count(*) filter (where d.message_status in ('Sent', 'Delivered')) as sent,
          count(*) filter (where d.message_status in ('Queued', 'Deferred', 'Digest')) as pending,
          count(*) filter (where d.message_status = 'Failed') as failed,
          count(*) filter (where d.message_status = 'Bounced') as bounced,
          count(*) filter (where d.message_status = 'Suppressed') as suppressed
        from unnest(enum_range(null::app.notification_channel)) c (channel)
        left join deliveries d on d.channel = c.channel
        where c.channel <> 'In App'
        group by c.channel
      ) n)
  ) into v_result;
  return v_result;
end;
$$;
comment on function app.console_platform_metrics(integer) is 'Platform-wide metrics for the operator console (A137, tenants.read): new orgs, sign-ups and Aurora requests by UTC week for the last p_weeks weeks (1 to 52, default 12); people with an account and those active (signed in or seen on a session) in 1, 7 and 30 days; the plan mix of live subscriptions by state, and trials; closed usage_rollups totals per meter for the last three months; Aurora outcomes, features and tokens over 30 days, counting only Aurora''s own requests, never a connected assistant''s proposals (3052); job queue health per job kind; notification deliveries per channel over 7 days. Aggregates only, never an org, person, record or error text. Read from the database itself (ADR 0046).';
revoke all on function app.console_platform_metrics(integer) from public, anon;
grant execute on function app.console_platform_metrics(integer) to authenticated;

comment on function app.console_platform_metrics(integer) is 'Platform-wide metrics for the operator console (A137, tenants.read): new orgs, sign-ups and Aurora requests by UTC week for the last p_weeks weeks (1 to 52, default 12); people with an account and those active (signed in or seen on a session) in 1, 7 and 30 days; the plan mix of live subscriptions by state, and trials; closed usage_rollups totals per meter for the last three months; Aurora outcomes, features and tokens over 30 days, counting only Aurora''s own requests, never a connected app''s proposals (3052); job queue health per job kind; notification deliveries per channel over 7 days. Aggregates only, never an org, person, record or error text. Read from the database itself (ADR 0046).';
revoke all on function app.console_platform_metrics(integer) from public, anon;
grant execute on function app.console_platform_metrics(integer) to authenticated;

select private.sync_trash_tables();
