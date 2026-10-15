-- 0400_projects_home_activity.sql
-- A07 Projects, Home and Activity (ADR 0022 range 0400 to 0409). Builds on A03's scope schema
-- (0301) and A18's activity and audit ledgers (0501):
--   * app.create_project, which creates a project and its Engagement Root scope node in one
--     transaction, so no project ever exists without the root of its scope tree (Section 4.5.1)
--   * domain event types and triggers for the project changes 0301 does not emit (header edits,
--     archive and restore, scope nodes, evidence withdrawal, project members ending), so every
--     project change reaches the activity feed, the audit ledger and webhooks (Section 19.6)
--   * app.activity_feed, the one read path of the user-facing feed (Section 4.2 Activity). The
--     activity rows say who; the domain event says what. Domain events are readable only by
--     webhook managers, so the feed is a definer function that applies the feed rule itself:
--     activity.feed.read in the org, and for an event on a project, the right to read that project
--     (invariant 2). It takes its filters as arguments and never re-reads a table under RLS from a
--     security_invoker view (ADR 0016 rule 14).
-- Every function pins search_path to '' (invariant 6).

-- Domain event types ------------------------------------------------------------------------------

insert into private.domain_event_types (code, subject, description) values
  ('project.updated', 'projects', 'A project''s key, name, dates, place, jurisdiction, region, tier or time zone changed.'),
  ('project.archived', 'projects', 'A project was archived.'),
  ('project.restored', 'projects', 'An archived project was restored.'),
  ('project.member_ended', 'project_members', 'A member''s access to a project ended.'),
  ('scope_node.created', 'scope_nodes', 'A node was added to a project''s scope tree.'),
  ('scope_node.updated', 'scope_nodes', 'A scope node was renamed or moved to another venue.'),
  ('scope_node.removed', 'scope_nodes', 'A node was removed from a project''s scope tree.'),
  ('gate.evidence_withdrawn', 'gate_evidence', 'Evidence against a gate criterion was withdrawn and stopped counting.')
on conflict (code) do nothing;

-- Project creation ----------------------------------------------------------------------------------

create or replace function app.create_project(
  p_org_id uuid,
  p_project_key text,
  p_name text,
  p_time_zone text,
  p_jurisdiction_id text default null,
  p_region_code text default null,
  p_tier_code text default null,
  p_venue_id uuid default null,
  p_starts_on date default null,
  p_ends_on date default null
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_project uuid;
  v_key text := upper(btrim(p_project_key));
  v_name text := btrim(p_name);
begin
  insert into app.projects (org_id, project_key, name, time_zone, jurisdiction_id, region_code, tier_code,
    venue_id, starts_on, ends_on)
  values (p_org_id, v_key, v_name, p_time_zone, p_jurisdiction_id, p_region_code, p_tier_code,
    p_venue_id, p_starts_on, p_ends_on)
  returning id into v_project;
  insert into app.scope_nodes (project_id, scope_kind, scope_code, name, venue_id, path)
  values (v_project, 'Engagement Root', v_key || '-E01', v_name, p_venue_id, extensions.text2ltree(v_key || '_E01'));
  return v_project;
end;
$$;

comment on function app.create_project(uuid, text, text, text, text, text, text, uuid, date, date) is 'Creates a project in Proposed at Scope together with its Engagement Root scope node, coded {KEY}-E01, in one transaction. Runs as the caller, so row level security decides (projects.project.create, then projects.scope.write through project oversight) and the 0301 guards apply: key format and uniqueness, IANA time zone, venue in the same org and the active_projects plan limit. Returns the project id.';

-- Header edits, archive and restore -----------------------------------------------------------------

create or replace function private.emit_project_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed text[] := array[]::text[];
  v_data jsonb;
begin
  if new.archived_at is distinct from old.archived_at then
    perform private.emit_event(new.org_id,
      case when new.archived_at is null then 'project.restored' else 'project.archived' end,
      'projects', new.id, new.id, jsonb_build_object('project_key', new.project_key, 'name', new.name));
  end if;
  if new.project_key <> old.project_key then v_changed := array_append(v_changed, 'project_key'); end if;
  if new.name <> old.name then v_changed := array_append(v_changed, 'name'); end if;
  if new.starts_on is distinct from old.starts_on then v_changed := array_append(v_changed, 'starts_on'); end if;
  if new.ends_on is distinct from old.ends_on then v_changed := array_append(v_changed, 'ends_on'); end if;
  if new.venue_id is distinct from old.venue_id then v_changed := array_append(v_changed, 'venue_id'); end if;
  if new.jurisdiction_id is distinct from old.jurisdiction_id then v_changed := array_append(v_changed, 'jurisdiction_id'); end if;
  if new.region_code is distinct from old.region_code then v_changed := array_append(v_changed, 'region_code'); end if;
  if new.tier_code is distinct from old.tier_code then v_changed := array_append(v_changed, 'tier_code'); end if;
  if new.time_zone <> old.time_zone then v_changed := array_append(v_changed, 'time_zone'); end if;
  if cardinality(v_changed) > 0 then
    select jsonb_object_agg(c, to_jsonb(new) -> c) into v_data from unnest(v_changed) c;
    perform private.emit_event(new.org_id, 'project.updated', 'projects', new.id, new.id,
      jsonb_build_object('changed', to_jsonb(v_changed), 'values', v_data, 'project_key', new.project_key));
  end if;
  return null;
end;
$$;

comment on function private.emit_project_update() is 'After update trigger on app.projects: emits project.archived or project.restored, and project.updated naming the changed header columns with their new values. State and phase changes are emitted from their ledgers by 0301.';

create trigger t91_emit_project_update after update on app.projects
  for each row execute function private.emit_project_update();

-- Scope nodes ---------------------------------------------------------------------------------------------

create trigger t90_emit_scope_node_created after insert on app.scope_nodes
  for each row execute function private.emit_row_event('scope_node.created', 'project_id', 'scope_code', 'scope_kind', 'name');

create or replace function private.emit_scope_node_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    perform private.emit_event(new.org_id, 'scope_node.removed', 'scope_nodes', new.id, new.project_id,
      jsonb_build_object('scope_code', new.scope_code, 'name', new.name));
  elsif new.name <> old.name or new.venue_id is distinct from old.venue_id then
    perform private.emit_event(new.org_id, 'scope_node.updated', 'scope_nodes', new.id, new.project_id,
      jsonb_build_object('scope_code', new.scope_code, 'name', new.name, 'venue_id', new.venue_id));
  end if;
  return null;
end;
$$;

comment on function private.emit_scope_node_update() is 'After update trigger on app.scope_nodes: emits scope_node.removed on soft delete and scope_node.updated on a rename or venue change.';

create trigger t91_emit_scope_node_update after update on app.scope_nodes
  for each row execute function private.emit_scope_node_update();

-- Scope node removal guard: the root stays and a node with live children stays, so the tree never
-- holds an orphan (Section 4.5.1).
create or replace function private.guard_scope_node_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    if new.parent_id is null then
      perform private.refuse('scope_root_retained', 'The engagement root stays while the project exists.');
    end if;
    if exists (select 1 from app.scope_nodes c where c.parent_id = new.id and c.deleted_at is null) then
      perform private.refuse('scope_node_has_children', 'Remove the nodes beneath this node first.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_scope_node_removal() is 'Before update trigger on app.scope_nodes: refuses soft deleting the engagement root or a node that still has live children.';

create trigger t41_guard_scope_node_removal before update on app.scope_nodes
  for each row execute function private.guard_scope_node_removal();

-- Evidence withdrawal and members ending ---------------------------------------------------------------------

create or replace function private.emit_evidence_withdrawn()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    perform private.emit_event(new.org_id, 'gate.evidence_withdrawn', 'gate_evidence', new.id, new.project_id,
      jsonb_build_object('criterion_id', new.criterion_id, 'assertion_rank', new.assertion_rank));
  end if;
  return null;
end;
$$;

comment on function private.emit_evidence_withdrawn() is 'After update trigger on app.gate_evidence: emits gate.evidence_withdrawn when evidence is soft deleted.';

create trigger t91_emit_evidence_withdrawn after update on app.gate_evidence
  for each row execute function private.emit_evidence_withdrawn();

create or replace function private.emit_project_member_ended()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.valid_to is not null and old.valid_to is null) or (new.deleted_at is not null and old.deleted_at is null) then
    perform private.emit_event(new.org_id, 'project.member_ended', 'project_members', new.id, new.project_id,
      jsonb_build_object('membership_id', new.membership_id, 'project_role', new.project_role));
  end if;
  return null;
end;
$$;

comment on function private.emit_project_member_ended() is 'After update trigger on app.project_members: emits project.member_ended when a project membership is closed or soft deleted.';

create trigger t91_emit_project_member_ended after update on app.project_members
  for each row execute function private.emit_project_member_ended();

-- Activity feed ----------------------------------------------------------------------------------------------

create or replace function app.activity_feed(
  p_org_id uuid,
  p_project_id uuid default null,
  p_before timestamptz default null,
  p_limit integer default 50
)
returns table (
  id uuid,
  occurred_at timestamptz,
  event_type text,
  subject_table text,
  subject_id uuid,
  project_id uuid,
  project_key text,
  project_name text,
  actor_person_id uuid,
  actor_name text,
  record_key text,
  record_title text,
  data jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_reach text;
begin
  perform private.require_person();
  if p_org_id is null or p_org_id not in (select private.my_org_ids()) then
    raise exception using errcode = '42501', message = 'activity.feed.read is required in the org';
  end if;
  v_reach := private.capability_reach(p_org_id, 'activity.feed.read')::text;
  if v_reach is null then
    raise exception using errcode = '42501', message = 'activity.feed.read is required in the org';
  end if;
  return query
  select a.id, a.created_at, e.event_type, e.subject_table, e.subject_id, e.project_id,
    p.project_key, p.name, a.actor_person_id, ap.full_name,
    case when r.id is not null then p.project_key || '-' || r.record_number end,
    r.title,
    e.data
  from app.activity_events a
  join app.domain_events e on e.id = a.domain_event_id
  left join app.projects p on p.id = e.project_id
  left join app.people ap on ap.id = a.actor_person_id
  left join app.records r on e.subject_table = 'records' and r.id = e.subject_id
  where a.org_id = p_org_id
    and (p_project_id is null or e.project_id = p_project_id)
    and (p_before is null or a.created_at < p_before)
    and (
      (e.project_id is null and v_reach = 'organization')
      or e.project_id in (select private.my_project_ids())
      or (v_reach = 'organization' and e.project_id in (select private.readable_project_ids()))
    )
  order by a.created_at desc, a.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

comment on function app.activity_feed(uuid, uuid, timestamptz, integer) is 'The user-facing activity feed (Section 4.2 Activity), newest first, one row per domain event with the person who caused it. Needs activity.feed.read in the org. At organization reach it shows org events and events on projects the person may read; at assigned reach only events on projects they are a member of (invariant 2). Keyset paging by p_before; at most 200 rows.';

-- Privileges ------------------------------------------------------------------------------------------------------

revoke all on function app.create_project(uuid, text, text, text, text, text, text, uuid, date, date) from public, anon;
revoke all on function app.activity_feed(uuid, uuid, timestamptz, integer) from public, anon;
revoke all on function private.emit_project_update() from public, anon, authenticated;
revoke all on function private.emit_scope_node_update() from public, anon, authenticated;
revoke all on function private.guard_scope_node_removal() from public, anon, authenticated;
revoke all on function private.emit_evidence_withdrawn() from public, anon, authenticated;
revoke all on function private.emit_project_member_ended() from public, anon, authenticated;

grant execute on function app.create_project(uuid, text, text, text, text, text, text, uuid, date, date) to authenticated, service_role;
grant execute on function app.activity_feed(uuid, uuid, timestamptz, integer) to authenticated, service_role;
