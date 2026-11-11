-- 4.11 fix (crawl 4.9): incident dispatch leaves the Member and Collaborator system roles, as the owner decided for every
-- role below the manager band. Owner decision 2026-10-17, recorded in 1110 (SIM-007): "dispatch belongs to Field
-- Supervisors and the manager band; Field keeps reporting incidents". 1110 took safety.incident.dispatch from the Field
-- role only, so the 0203 seed's assigned-reach grants to Member and Collaborator stayed: a collaborator or member on a
-- project could dispatch responders (app.dispatch_responder), announce a crisis alert that tells everyone on the project
-- (app.crisis_alerts, 6800), call a weather hold (6257) and be notified as a dispatcher of every new incident (1394),
-- while a Field lead could not.
--   * Member and Collaborator lose safety.incident.dispatch, as Field did in 1110. They keep reporting incidents
--     (safety.incident.write) and reading them.
--   * Owner, Admin and Manager keep it at organization reach, and the Field Supervisor project role keeps it on its own
--     project (private.project_role_capabilities, 1110).
--   * The notices sent to a project's dispatchers now reach its Field Supervisors too (below), so a project keeps the
--     dispatchers it is told through.
--   * Org copies of roles are not touched: an org that gave its own role dispatch chose to, as in 1110.
-- packages/schemas/capabilities.yaml still renders 0203 unchanged; it notes this override beside the code.

delete from app.role_capabilities rc
using app.roles r
where rc.role_id = r.id and r.org_id is null and r.code in ('member', 'collaborator')
  and rc.capability_code = 'safety.incident.dispatch';

-- The project's dispatchers, as the notices name them ----------------------------------------------------------------
-- private.project_member_people_with (0806) names the people a new incident (1394), an occupancy level (0806), a weather
-- alert (6256) and a weather hold (6257) tell as the project's dispatchers. It read only org roles, so the Field
-- Supervisor, who dispatches on their project since 1110, was never told, and with Member and Collaborator gone only the
-- manager band would be. It now also names the project's active members whose project roles add the capability
-- (app.project_member_roles, 1204, through private.project_role_capabilities), as private.project_ids_with lets them use
-- it. Definition from 0806, the latest, with its security, comment and privileges restated.
create or replace function private.project_member_people_with(p_project_id uuid, p_capability text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct m.person_id
  from app.project_members pm
  join app.memberships m on m.id = pm.membership_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  join app.projects p on p.id = pm.project_id
  where pm.project_id = p_project_id and pm.deleted_at is null and pm.valid_from <= now() and (pm.valid_to is null or pm.valid_to > now())
    and private.person_capability_reach(m.person_id, p.org_id, p_capability, true) is not null
  union
  select m.person_id
  from app.project_members pm
  join app.memberships m on m.id = pm.membership_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  join app.project_member_roles pmr on pmr.project_member_id = pm.id and pmr.deleted_at is null
  join private.project_role_capabilities prc on prc.project_role = pmr.project_role and prc.capability_code = p_capability
  where pm.project_id = p_project_id and pm.deleted_at is null and pm.valid_from <= now() and (pm.valid_to is null or pm.valid_to > now())
  union
  select m.person_id
  from app.memberships m join app.projects p on p.id = p_project_id and p.org_id = m.org_id
  where m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    and private.person_capability_reach(m.person_id, p.org_id, p_capability, true) = 'organization';
$$;
comment on function private.project_member_people_with(uuid, text) is 'People who hold a capability on a project: its active members holding it at any reach or through a project role that adds it (a Field Supervisor dispatches, 1110, 904110301), and members holding it org-wide.';
revoke all on function private.project_member_people_with(uuid, text) from public, anon, authenticated;
