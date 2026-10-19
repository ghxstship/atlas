-- 1204_project_member_roles.sql
-- A52 settings features (RRR-97, ADR 0032 amendment). Section 4.8.1: a Project Assignment holds "project roles (many)", and
-- "a person can hold several internal roles in one org and several project roles on one project"; capabilities are the
-- union of every role held in that scope, and separation of duties is checked against the person, never the role. Project
-- assignments are app.project_members (0301), one row per membership and project with one project_role, so A50 retired
-- projectAssignmentRoles.
--   * app.project_member_roles holds every project role an assignment carries. project_members.project_role stays as the
--     assignment's lead role (shown first and used where one role is displayed); the lead role always has its row here,
--     added when the assignment is created and moved when the lead role changes, and its row cannot be removed directly.
--   * A role is added or removed with projects.members.manage on the project. A person never adds a role to their own
--     assignment (Section 8.2, sod_self_grant), and an ended assignment takes no roles.
--   * Capabilities that project roles add (private.project_role_capabilities, 1110) now follow every role on the
--     assignment: private.project_ids_with and app.my_project_role_capabilities read app.project_member_roles.

create table app.project_member_roles (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_member_id uuid not null references app.project_members (id),
  project_role app.project_role not null,
  deleted_at timestamptz
);

create unique index project_member_roles_member_role_key on app.project_member_roles (project_member_id, project_role)
  where deleted_at is null;
create index project_member_roles_role_idx on app.project_member_roles (project_role, project_member_id) where deleted_at is null;

call private.install_domain_table('app.project_member_roles', 'app.project_members', 'project_member_id');
call private.describe('app.project_member_roles', 'Every project role a project assignment holds (Section 4.8.1: project roles, many). The assignment''s lead role (project_members.project_role) always has its row. Capabilities project roles add are the union over these rows.', array[
  'project_member_id', 'Project assignment (app.project_members) holding the role.',
  'project_role', 'Project role held: Producer, Department Head, Coordinator, Field Supervisor or Field. Once per assignment among live rows.'
]);

call private.install_policies('app.project_member_roles',
  $$project_member_id in (select pm.id from app.project_members pm
                          where pm.project_id in (select private.readable_project_ids())
                             or pm.membership_id in (select private.my_membership_ids()))$$,
  $$project_member_id in (select pm.id from app.project_members pm
                          where pm.project_id in (select private.project_ids_with('projects.members.manage')))$$);

revoke insert, update on app.project_member_roles from authenticated;
grant insert (project_member_id, project_role) on app.project_member_roles to authenticated;
grant update (deleted_at) on app.project_member_roles to authenticated;

call private.install_default_retention('app.project_member_roles');
call private.install_audit_trail('app.project_member_roles');

-- Guard --------------------------------------------------------------------------------------------------------------------

create or replace function private.guard_project_member_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member app.project_members;
begin
  select * into v_member from app.project_members pm where pm.id = new.project_member_id;
  if tg_op = 'UPDATE' then
    if new.project_member_id <> old.project_member_id or new.project_role <> old.project_role then
      perform private.refuse('project_role_immutable', 'Remove the role and add another instead of changing it.');
    end if;
    if old.deleted_at is not null and new.deleted_at is null then
      perform private.refuse('project_role_immutable', 'Add a removed project role again with a new row.');
    end if;
    if new.deleted_at is not null and old.deleted_at is null and v_member.deleted_at is null
       and v_member.project_role = old.project_role and not private.in_trusted_operation('project_lead_role') then
      perform private.refuse('project_role_lead', 'Change the assignment''s lead role before removing it.');
    end if;
    return new;
  end if;
  if v_member.deleted_at is not null or (v_member.valid_to is not null and v_member.valid_to <= now()) then
    perform private.refuse('project_member_ended', 'Roles cannot be added to an ended project assignment.');
  end if;
  if auth.uid() is not null and not private.in_trusted_operation('project_lead_role')
     and (select m.person_id from app.memberships m where m.id = v_member.membership_id) = private.current_person_id() then
    perform private.refuse('sod_self_grant', 'A person cannot grant themselves a role or capability.');
  end if;
  return new;
end;
$$;

comment on function private.guard_project_member_role() is 'Project roles on an assignment: never moved or restored, added only to a live assignment and never by the person who holds it (Section 8.2); the lead role''s row is removed only by changing the lead role.';
revoke all on function private.guard_project_member_role() from public, anon, authenticated;

create trigger t40_guard_project_member_role before insert or update on app.project_member_roles
  for each row execute function private.guard_project_member_role();

-- The lead role keeps its row ---------------------------------------------------------------------------------------------

create or replace function private.sync_project_lead_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.begin_trusted_operation('project_lead_role');
  if tg_op = 'UPDATE' and new.deleted_at is not null and old.deleted_at is null then
    update app.project_member_roles r set deleted_at = now() where r.project_member_id = new.id and r.deleted_at is null;
  elsif new.deleted_at is null then
    if tg_op = 'UPDATE' and new.project_role <> old.project_role then
      update app.project_member_roles r set deleted_at = now()
      where r.project_member_id = new.id and r.project_role = old.project_role and r.deleted_at is null;
    end if;
    insert into app.project_member_roles (project_member_id, project_role)
    select new.id, new.project_role
    where not exists (select 1 from app.project_member_roles r
                      where r.project_member_id = new.id and r.project_role = new.project_role and r.deleted_at is null);
  end if;
  perform private.end_trusted_operation('project_lead_role');
  return null;
end;
$$;

comment on function private.sync_project_lead_role() is 'After a project assignment is created or changed: its lead role has a row in app.project_member_roles; changing the lead role replaces that row, and ending the assignment ends its roles.';
revoke all on function private.sync_project_lead_role() from public, anon, authenticated;

create trigger t80_sync_project_lead_role after insert or update of project_role, deleted_at on app.project_members
  for each row execute function private.sync_project_lead_role();

-- Every live assignment gets its lead role's row.
insert into app.project_member_roles (project_member_id, project_role)
select pm.id, pm.project_role from app.project_members pm where pm.deleted_at is null
on conflict do nothing;

-- Capabilities follow every role on the assignment ----------------------------------------------------------------------

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
    );
$$;

comment on function private.project_ids_with(text) is 'Invariant 2: projects on which the signed-in person may use a capability. True for active project members holding it at assigned or organization reach, for org-wide holders who also hold projects.members.manage org-wide (oversight), for grants scoped to the project, and for any active project role on their assignment that adds it (private.project_role_capabilities over app.project_member_roles, within API-key scopes). Policies use it as project_id in (select ...).';

create or replace function app.my_project_role_capabilities()
returns table (project_id uuid, project_role app.project_role, capability_code text)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct pm.project_id, pmr.project_role, prc.capability_code
  from app.project_members pm
  join app.project_member_roles pmr on pmr.project_member_id = pm.id and pmr.deleted_at is null
  join private.project_role_capabilities prc on prc.project_role = pmr.project_role
  join app.projects p on p.id = pm.project_id and p.deleted_at is null
  where pm.membership_id in (select private.my_membership_ids())
    and pm.deleted_at is null and pm.valid_from <= now() and (pm.valid_to is null or pm.valid_to > now())
  order by pm.project_id, prc.capability_code;
$$;

comment on function app.my_project_role_capabilities() is 'Capabilities the signed-in person''s active project roles add, per project and role, over every role on each assignment (1204). Compass reads it to show supervisor mode to a Field Supervisor; row level security and the RPCs still decide every act.';
