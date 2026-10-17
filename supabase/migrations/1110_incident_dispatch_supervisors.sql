-- 1110_incident_dispatch_supervisors.sql
-- A42 Compass launch gaps, SIM-007. The Field system role held safety.incident.dispatch at assigned reach,
-- so every Field member read as a Field Supervisor in Compass (Section 4.5.7 supervisor mode) and could
-- dispatch responders. Owner decision 2026-10-17: dispatch belongs to Field Supervisors and the manager
-- band; Field keeps reporting incidents (safety.incident.write is untouched).
--   * The Field system role loses safety.incident.dispatch. Org copies of roles are not touched: an org
--     that gave its own role dispatch chose to.
--   * Owner, Admin and Manager hold it at organization reach (already true in 0203; asserted again here).
--   * Field Supervisor is a project role (0301), not a system role, so it never held a capability. The
--     project role now grants dispatch on its own project: private.project_role_capabilities lists what a
--     project role adds, and private.project_ids_with gains a branch for it. The branch honors API-key
--     scopes (A22-001) like the role path does.
--   * app.my_project_role_capabilities lets Compass show supervisor mode to a Field Supervisor without
--     restating the list in the client.
-- packages/schemas/capabilities.yaml still renders 0203 unchanged; it notes this override beside the code.

delete from app.role_capabilities rc
using app.roles r
where rc.role_id = r.id and r.org_id is null and r.code = 'field'
  and rc.capability_code = 'safety.incident.dispatch';

insert into app.role_capabilities (role_id, capability_code, reach)
select r.id, 'safety.incident.dispatch', 'organization'::app.capability_reach
from app.roles r
where r.org_id is null and r.code in ('owner', 'admin', 'manager')
  and not exists (
    select 1 from app.role_capabilities rc
    where rc.role_id = r.id and rc.capability_code = 'safety.incident.dispatch' and rc.deleted_at is null);

-- What a project role adds on its own project ----------------------------------------------------------------

create table private.project_role_capabilities (
  project_role app.project_role not null,
  capability_code text not null references app.capabilities (code),
  primary key (project_role, capability_code)
);

comment on table private.project_role_capabilities is 'Capabilities a project role adds on the project it is held on (SIM-007: Field Supervisor dispatches). Platform configuration; read by private.project_ids_with.';
comment on column private.project_role_capabilities.project_role is 'Project role that adds the capability.';
comment on column private.project_role_capabilities.capability_code is 'Capability the holder may use on that project.';

alter table private.project_role_capabilities enable row level security;
revoke all on private.project_role_capabilities from public, anon, authenticated;
grant select on private.project_role_capabilities to service_role;

insert into private.project_role_capabilities (project_role, capability_code)
values ('Field Supervisor', 'safety.incident.dispatch')
on conflict do nothing;

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
        join private.project_role_capabilities prc on prc.project_role = pm.project_role
        where pm.project_id = p.id and prc.capability_code = p_capability
          and pm.membership_id in (select private.my_membership_ids())
          and pm.deleted_at is null and pm.valid_from <= now() and (pm.valid_to is null or pm.valid_to > now())
          and (private.api_key_scopes() is null
               or split_part(p_capability, '.', 1) = any (private.api_key_scopes())))
    );
$$;

comment on function private.project_ids_with(text) is 'Invariant 2: projects on which the signed-in person may use a capability. True for active project members holding it at assigned or organization reach, for org-wide holders who also hold projects.members.manage org-wide (oversight), for grants scoped to the project, and for an active project role that adds it (private.project_role_capabilities, within API-key scopes). Policies use it as project_id in (select ...).';

create or replace function app.my_project_role_capabilities()
returns table (project_id uuid, project_role app.project_role, capability_code text)
language sql
stable
security definer
set search_path = ''
as $$
  select pm.project_id, pm.project_role, prc.capability_code
  from app.project_members pm
  join private.project_role_capabilities prc on prc.project_role = pm.project_role
  join app.projects p on p.id = pm.project_id and p.deleted_at is null
  where pm.membership_id in (select private.my_membership_ids())
    and pm.deleted_at is null and pm.valid_from <= now() and (pm.valid_to is null or pm.valid_to > now())
  order by pm.project_id, prc.capability_code;
$$;

comment on function app.my_project_role_capabilities() is 'Capabilities the signed-in person''s active project roles add, per project (SIM-007). Compass reads it to show supervisor mode to a Field Supervisor; row level security and the RPCs still decide every act.';
revoke all on function app.my_project_role_capabilities() from public, anon;
grant execute on function app.my_project_role_capabilities() to authenticated, service_role;
