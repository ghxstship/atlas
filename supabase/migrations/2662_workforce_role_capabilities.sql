-- 2662_workforce_role_capabilities.sql
-- R6a (RRR-185, ADR 0105; owner decision 5 of 2026-10-28, ADR 0102 decision 4). Allergies become Restricted under
-- data.restricted.read.medical (2663), and the people who need them on site read them by default: the catering lead
-- and on-site medical. Those are canon workforce roles (0150_xpms_canon_seed.sql:1028 and :1031), worked on a project
-- through app.role_assignments (0361), so the capability follows an Active assignment there.
--
--   * private.workforce_role_capabilities maps a canon role to a capability it adds on the project it is worked on.
--     Platform configuration, like private.project_role_capabilities (1110): two rows, both for medical reads.
--   * private.project_ids_with gains one branch, evaluated only for a capability the mapping names: an Active,
--     current assignment of the signed-in person to a mapped role on the project, in one of their orgs, within API-key
--     scopes. The reach is computed at read time and never stored. Every other branch is 1205's, unchanged.
--   * private.guard_role_assignment refuses sod_self_grant when a signed-in person makes their own assignment to a
--     mapped role Active (Section 8.2): someone else with people.role.write activates it.
--   * The org-wide capability still decides app.medical_encounters_masked (0353:440): a project holder never unmasks
--     incident treatment notes.
-- packages/schemas/capabilities.yaml notes this beside data.restricted.read.medical; 0203 stays the generator's output.

create table private.workforce_role_capabilities (
  role_code text not null references xpms.dim_role (role_code),
  capability_code text not null references app.capabilities (code),
  primary key (role_code, capability_code)
);

create index workforce_role_capabilities_capability_code_idx on private.workforce_role_capabilities (capability_code);

comment on table private.workforce_role_capabilities is 'Capabilities a canon workforce role adds on the project it is worked on (R6a, ADR 0105): the catering lead and on-site medical read allergies. Platform configuration; read by private.project_ids_with and private.guard_role_assignment.';
comment on column private.workforce_role_capabilities.role_code is 'Canon workforce role (xpms.dim_role) whose Active assignment on a project adds the capability there.';
comment on column private.workforce_role_capabilities.capability_code is 'Capability the person assigned may use on that project.';

alter table private.workforce_role_capabilities enable row level security;
revoke all on private.workforce_role_capabilities from public, anon, authenticated;
grant select on private.workforce_role_capabilities to service_role;

insert into private.workforce_role_capabilities (role_code, capability_code) values
  ('8000.51.01', 'data.restricted.read.medical'),
  ('7000.51.01', 'data.restricted.read.medical')
on conflict do nothing;

-- The canon roles reach the project they are worked on: 1205's project_ids_with plus one branch.
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
      or (p_capability in (select w.capability_code from private.workforce_role_capabilities w)
          and exists (
            select 1 from app.role_assignments ra
            join private.workforce_role_capabilities w on w.role_code = ra.role_code and w.capability_code = p_capability
            where ra.project_id = p.id and ra.person_id = private.current_person_id()
              and ra.assignment_state = 'Active' and ra.deleted_at is null
              and (ra.starts_on is null or ra.starts_on <= current_date)
              and (ra.ends_on is null or ra.ends_on >= current_date)
              and ra.org_id in (select private.my_org_ids())
              and (private.api_key_scopes() is null
                   or split_part(p_capability, '.', 1) = any (private.api_key_scopes()))))
    );
$$;

comment on function private.project_ids_with(text) is 'Invariant 2: projects on which the signed-in person may use a capability. True for active project members holding it at assigned or organization reach, for org-wide holders who also hold projects.members.manage org-wide (oversight), for grants scoped to the project, for any active project role on their assignment that adds it (private.project_role_capabilities over app.project_member_roles, 1204), for the project role a live share grants their org (1205), and for an Active, current assignment to a canon workforce role that adds it on that project (private.workforce_role_capabilities over app.role_assignments, R6a: the catering lead and on-site medical read allergies); project-role and workforce-role paths stay within API-key scopes. Policies use it as project_id in (select ...).';

-- Separation of duties: nobody activates their own mapped role -------------------------------------------------------

create or replace function private.guard_role_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role xpms.dim_role;
begin
  if tg_op = 'UPDATE' and (new.project_id <> old.project_id or new.person_id <> old.person_id or new.role_code <> old.role_code) then
    perform private.refuse('role_assignment_immutable', 'A role assignment keeps its project, person and role; end it and assign again.');
  end if;
  select r.* into v_role from xpms.dim_role r where r.role_code = new.role_code;
  if new.staffing_basis = 'Ratio' and v_role.staffing_ratio is null then
    perform private.refuse('role_assignment_basis', 'The canon role has no staffing ratio; plan it as Fixed or Declared.');
  end if;
  if new.staffing_basis = 'Fixed' and v_role.ratio_basis is distinct from 'fixed per tier' then
    perform private.refuse('role_assignment_basis', 'The canon role is not staffed as a fixed count per tier; plan it by Ratio or Declared.');
  end if;
  if new.scope_node_id is not null and not exists (
    select 1 from app.scope_nodes n where n.id = new.scope_node_id and n.project_id = new.project_id) then
    perform private.refuse('role_assignment_scope_project', 'A role assignment''s scope node belongs to its project.');
  end if;
  if new.requisition_id is not null and not exists (
    select 1 from app.requisitions r where r.id = new.requisition_id and r.project_id = new.project_id
      and r.requisition_state in ('Approved', 'Filled')) then
    perform private.refuse('role_assignment_requisition', 'A role assignment fills an Approved or Filled requisition of its own project.');
  end if;
  if tg_op = 'INSERT' and not exists (
      select 1 from app.memberships m
      where m.person_id = new.person_id and m.org_id = new.org_id and m.deleted_at is null
        and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
    perform private.refuse('role_assignment_person', 'Assign an active member of the org; external people work through engagements.');
  end if;
  -- A role that adds a capability (R6a: medical reads) is made Active by someone else (Section 8.2).
  if auth.uid() is not null and new.person_id = private.current_person_id()
     and exists (select 1 from private.workforce_role_capabilities w where w.role_code = new.role_code)
     and ((tg_op = 'INSERT' and new.assignment_state = 'Active')
          or (tg_op = 'UPDATE' and new.assignment_state = 'Active' and old.assignment_state is distinct from 'Active')) then
    perform private.refuse('sod_self_grant', 'A person cannot grant themselves a role or capability.');
  end if;
  return new;
end;
$$;

comment on function private.guard_role_assignment() is 'Role assignments: project, person and role fixed; the staffing basis agrees with canon; scope node and requisition from the same project; the person is an active member of the org; and nobody signed in makes their own assignment to a role that adds a capability (private.workforce_role_capabilities, R6a) Active, which is refused with sod_self_grant.';
revoke all on function private.guard_role_assignment() from public, anon, authenticated;
