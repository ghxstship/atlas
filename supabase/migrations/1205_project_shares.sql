-- 1205_project_shares.sql
-- A52 settings features (RRR-97, ADR 0032 amendment). Section 8.5, cross-org project sharing: "a project can be shared with
-- a partner org (for example an agency and its client). A project_shares row maps the partner's roles onto project roles
-- and lists the shared scope nodes. Each org keeps ownership of its own records, and both audit ledgers record shared
-- access." Section 7.3 names project_shares. A50 retired projectShares because no table or behavior backed it.
--   * app.project_shares: the owning org (org.access_grants.manage) shares one of its projects with another organization,
--     naming the project role the partner's members hold on it and an optional end. Revoking is deleting the share.
--   * app.project_share_scope_nodes lists the scope nodes the share opens; a share without rows opens the whole scope tree.
--   * Enforcement: while a share is live, every active member of the partner org
--       - reads the share, and the project through app.shared_projects and its shared scope nodes through
--         app.shared_project_scope_nodes, projections that leave out the owner's internal columns (budget envelope,
--         client, workspace; Section 8.7 projections), so a share never opens the owner's records or internal fields;
--       - holds the share's project role on the project, so the capabilities project roles add
--         (private.project_role_capabilities) reach the shared project through private.project_ids_with.
--     The owner's records stay its own: nothing in the owner's tables becomes writable by the partner.
--   * Granting, changing and revoking a share is written to the owner's audit ledger (audit trail) and to the partner's
--     ledger, so both orgs see the shared access.

create table app.project_shares (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  partner_organization_id uuid not null references app.organizations (id),
  project_role app.project_role not null default 'Coordinator',
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  deleted_at timestamptz,
  constraint project_shares_valid_period check (valid_to is null or valid_to > valid_from),
  constraint project_shares_other_org check (partner_organization_id <> org_id)
);

create unique index project_shares_project_partner_key on app.project_shares (project_id, partner_organization_id)
  where deleted_at is null;
create index project_shares_partner_idx on app.project_shares (partner_organization_id, project_id);

call private.install_domain_table('app.project_shares', 'app.projects', 'project_id');
call private.describe('app.project_shares', 'A project shared with a partner org (Section 8.5). The partner''s members read the project and its shared scope nodes through projections without internal columns, and hold the share''s project role on it; each org keeps its own records. Revoked by deleting the share; both audit ledgers record it.', array[
  'project_id', 'Shared project, owned by org_id.',
  'partner_organization_id', 'Organization the project is shared with; never the owning org.',
  'project_role', 'Project role every active member of the partner org holds on the shared project.',
  'valid_from', 'When the share starts.',
  'valid_to', 'When the share ends on its own; NULL while open-ended.'
]);

call private.install_policies('app.project_shares',
  $$project_id in (select private.readable_project_ids())
    or org_id in (select private.oversight_org_ids('projects.project.read'))
    or partner_organization_id in (select private.my_org_ids())$$,
  $$org_id in (select private.orgs_with_capability('org.access_grants.manage'))$$);

revoke insert, update on app.project_shares from authenticated;
grant insert (project_id, partner_organization_id, project_role, valid_to) on app.project_shares to authenticated;
grant update (project_role, valid_to, deleted_at) on app.project_shares to authenticated;

call private.install_default_retention('app.project_shares');
call private.install_audit_trail('app.project_shares');

create table app.project_share_scope_nodes (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_share_id uuid not null references app.project_shares (id),
  scope_node_id uuid not null references app.scope_nodes (id),
  deleted_at timestamptz
);

create unique index project_share_scope_nodes_key on app.project_share_scope_nodes (project_share_id, scope_node_id)
  where deleted_at is null;
create index project_share_scope_nodes_scope_node_id_idx on app.project_share_scope_nodes (scope_node_id);

call private.install_domain_table('app.project_share_scope_nodes', 'app.project_shares', 'project_share_id',
  array['app.scope_nodes', 'scope_node_id']);
call private.describe('app.project_share_scope_nodes', 'Scope nodes a project share opens, with their descendants (Section 8.5). A share without rows opens the whole scope tree.', array[
  'project_share_id', 'Share the node belongs to.',
  'scope_node_id', 'Scope node opened to the partner, with everything under it. Belongs to the shared project.'
]);

call private.install_policies('app.project_share_scope_nodes',
  $$project_share_id in (select s.id from app.project_shares s)$$,
  $$org_id in (select private.orgs_with_capability('org.access_grants.manage'))$$);

revoke insert, update on app.project_share_scope_nodes from authenticated;
grant insert (project_share_id, scope_node_id) on app.project_share_scope_nodes to authenticated;
grant update (deleted_at) on app.project_share_scope_nodes to authenticated;

call private.install_default_retention('app.project_share_scope_nodes');
call private.install_audit_trail('app.project_share_scope_nodes');

-- Guards ------------------------------------------------------------------------------------------------------------------

create or replace function private.guard_project_share()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.project_id <> old.project_id or new.partner_organization_id <> old.partner_organization_id
       or new.valid_from <> old.valid_from then
      perform private.refuse('project_share_immutable', 'Share the project again instead of moving a share.');
    end if;
    if old.deleted_at is not null and new.deleted_at is null then
      perform private.refuse('project_share_revoked', 'A revoked share cannot be restored; share the project again.');
    end if;
    return new;
  end if;
  if new.partner_organization_id = new.org_id then
    perform private.refuse('project_share_own_org', 'A project is shared with another organization, never its own.');
  end if;
  if (select p.deleted_at from app.projects p where p.id = new.project_id) is not null then
    perform private.refuse('project_share_deleted_project', 'A deleted project cannot be shared.');
  end if;
  new.valid_from := now();
  return new;
end;
$$;

comment on function private.guard_project_share() is 'Project shares: shared with another organization, never moved, never restored once revoked; valid_from is the moment of sharing.';
revoke all on function private.guard_project_share() from public, anon, authenticated;

create trigger t41_guard_project_share before insert or update on app.project_shares
  for each row execute function private.guard_project_share();

create or replace function private.guard_project_share_scope_node()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.project_share_id <> old.project_share_id or new.scope_node_id <> old.scope_node_id
                           or (old.deleted_at is not null and new.deleted_at is null)) then
    perform private.refuse('project_share_scope_immutable', 'Remove the node and add another instead.');
  end if;
  if tg_op = 'INSERT' and (select n.project_id from app.scope_nodes n where n.id = new.scope_node_id)
       is distinct from (select s.project_id from app.project_shares s where s.id = new.project_share_id) then
    perform private.refuse('project_share_scope_project', 'A shared scope node belongs to the shared project.');
  end if;
  return new;
end;
$$;

comment on function private.guard_project_share_scope_node() is 'Shared scope nodes belong to the shared project and are never moved or restored.';
revoke all on function private.guard_project_share_scope_node() from public, anon, authenticated;

create trigger t41_guard_project_share_scope_node before insert or update on app.project_share_scope_nodes
  for each row execute function private.guard_project_share_scope_node();

-- The partner's audit ledger -------------------------------------------------------------------------------------------

create or replace function private.audit_project_share_for_partner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text := case
    when tg_op = 'INSERT' then 'project_shares.granted'
    when new.deleted_at is not null and old.deleted_at is null then 'project_shares.revoked'
    else 'project_shares.changed' end;
begin
  perform private.write_audit_event(new.partner_organization_id, v_action, 'app.project_shares', new.id,
    jsonb_build_object('owner_org_id', new.org_id, 'project_id', new.project_id, 'project_role', new.project_role,
      'valid_to', new.valid_to));
  return null;
end;
$$;

comment on function private.audit_project_share_for_partner() is 'After a share is granted, changed or revoked: writes the event to the partner org''s audit ledger too (Section 8.5: both ledgers record shared access).';
revoke all on function private.audit_project_share_for_partner() from public, anon, authenticated;

create trigger t86_audit_project_share_for_partner after insert or update on app.project_shares
  for each row execute function private.audit_project_share_for_partner();

-- Enforcement ---------------------------------------------------------------------------------------------------------------

create or replace function private.live_project_shares()
returns setof app.project_shares
language sql
stable
security definer
set search_path = ''
as $$
  select s.* from app.project_shares s
  join app.projects p on p.id = s.project_id and p.deleted_at is null
  where s.deleted_at is null and s.valid_from <= now() and (s.valid_to is null or s.valid_to > now())
    and s.partner_organization_id in (select private.my_org_ids());
$$;

comment on function private.live_project_shares() is 'Live shares of projects with any org the signed-in person is an active member of.';
revoke all on function private.live_project_shares() from public, anon, authenticated;

create or replace function app.shared_projects()
returns table (project_share_id uuid, project_id uuid, owner_org_id uuid, owner_org_name text, partner_organization_id uuid,
  project_key text, name text, project_state text, production_state text, current_phase_code text, starts_on date,
  ends_on date, time_zone text, project_role app.project_role, valid_to timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, p.id, p.org_id, o.name, s.partner_organization_id, p.project_key, p.name, p.project_state::text,
    p.production_state::text, p.current_phase_code, p.starts_on, p.ends_on, p.time_zone, s.project_role, s.valid_to
  from private.live_project_shares() s
  join app.projects p on p.id = s.project_id
  join app.organizations o on o.id = p.org_id
  order by o.name, p.name;
$$;

comment on function app.shared_projects() is 'Projects other orgs share with the signed-in person''s orgs (Section 8.5), as a projection without the owner''s internal columns (budget envelope, client, workspace): key, name, states, phase, dates and time zone, with the project role the share grants.';
revoke all on function app.shared_projects() from public, anon;
grant execute on function app.shared_projects() to authenticated, service_role;

create or replace function app.shared_project_scope_nodes(p_project_id uuid)
returns table (id uuid, project_id uuid, parent_id uuid, scope_kind text, scope_code text, name text)
language sql
stable
security definer
set search_path = ''
as $$
  with share as (select s.id from private.live_project_shares() s where s.project_id = p_project_id limit 1),
  roots as (
    select ssn.scope_node_id from app.project_share_scope_nodes ssn
    where ssn.project_share_id = (select id from share) and ssn.deleted_at is null)
  select n.id, n.project_id, n.parent_id, n.scope_kind::text, n.scope_code, n.name
  from app.scope_nodes n
  where n.project_id = p_project_id and n.deleted_at is null and exists (select 1 from share)
    and (not exists (select 1 from roots)
         or exists (select 1 from roots r join app.scope_nodes rn on rn.id = r.scope_node_id
                    where n.path operator(extensions.<@) rn.path))
  order by n.path;
$$;

comment on function app.shared_project_scope_nodes(uuid) is 'Scope nodes of a project shared with one of the signed-in person''s orgs: the nodes the share lists and everything under them, or the whole tree when it lists none. Empty when no live share applies.';
revoke all on function app.shared_project_scope_nodes(uuid) from public, anon;
grant execute on function app.shared_project_scope_nodes(uuid) to authenticated, service_role;

-- The share's project role reaches the shared project: 1204's project_ids_with plus one branch.
create or replace function private.project_ids_with(p_capability text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (select private.my_project_ids() as project_id)
  select p.id from app.projects p
  where p.deleted_at is null
    and (
      (p.org_id in (select private.orgs_with_capability(p_capability))
        and (p.org_id in (select private.orgs_with_capability('projects.members.manage'))
             or p.id in (select m.project_id from mine m)))
      or (p.id in (select m.project_id from mine m)
          and private.capability_reach(p.org_id, p_capability) = 'assigned')
      or exists (
        select 1 from app.user_capability_grants g
        where g.scope_kind = 'project' and g.scope_id = p.id and g.capability_code = p_capability
          and g.deleted_at is null and g.valid_from <= now() and (g.valid_to is null or g.valid_to > now())
          and g.membership_id in (select private.my_membership_ids()))
      or exists (
        select 1 from app.record_grants rg
        where rg.target_kind = 'project' and rg.target_id = p.id and rg.capability_code = p_capability
          and rg.deleted_at is null and rg.valid_from <= now() and rg.valid_to > now()
          and (rg.grantee_person_id = private.current_person_id()
               or rg.grantee_org_id in (select private.my_org_ids())))
      or exists (
        select 1 from app.project_members pm
        join app.project_member_roles pmr on pmr.project_member_id = pm.id and pmr.deleted_at is null
        join private.project_role_capabilities prc on prc.project_role = pmr.project_role
        where pm.project_id = p.id and prc.capability_code = p_capability
          and pm.membership_id in (select private.my_membership_ids())
          and pm.deleted_at is null and pm.valid_from <= now() and (pm.valid_to is null or pm.valid_to > now())
          and (private.api_key_scopes() is null
               or split_part(p_capability, '.', 1) = any (private.api_key_scopes())))
      or exists (
        select 1 from private.live_project_shares() s
        join private.project_role_capabilities prc on prc.project_role = s.project_role
        where s.project_id = p.id and prc.capability_code = p_capability
          and (private.api_key_scopes() is null
               or split_part(p_capability, '.', 1) = any (private.api_key_scopes())))
    );
$$;

comment on function private.project_ids_with(text) is 'Invariant 2: projects on which the signed-in person may use a capability. True for active project members holding it at assigned or organization reach, for org-wide holders who also hold projects.members.manage org-wide (oversight), for grants scoped to the project, for any active project role on their assignment that adds it (private.project_role_capabilities over app.project_member_roles, 1204), and for the project role a live share grants their org (1205); project-role paths stay within API-key scopes. Policies use it as project_id in (select ...).';
