-- 2252_shift_planning_projects.sql
--
-- The projects a planner may staff (ADR 0022, 2250-2259), A132, RRR-194, ADR 0063. The schedule's drag board offers
-- open shifts to drop crew on. crew.shift.write can reach some of an org's projects and not others (assigned reach,
-- a project grant or a project role), and the board's capability check only says the viewer holds it somewhere. A
-- shift on a project they only read would fail to rank (42501) and come back not found on assigning, so the board
-- offers only shifts on the projects this lists:
--   * app.my_shift_planning_projects(org) is the org's live projects on which the signed-in person holds
--     crew.shift.write, by invariant 2 (private.project_ids_with), the rule the shift policies and
--     app.rank_shift_candidates apply. It shows controls only; the policies and RPCs still decide every write.

create or replace function app.my_shift_planning_projects(p_org_id uuid)
returns table (project_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from app.projects p
  where p.org_id = p_org_id and p.deleted_at is null
    and p.org_id in (select private.my_org_ids())
    and p.id in (select private.project_ids_with('crew.shift.write'))
  order by p.id;
$$;

comment on function app.my_shift_planning_projects(uuid) is 'The org''s live projects on which the signed-in person may plan and assign shifts (crew.shift.write by invariant 2), for the schedule''s drag board (A132, ADR 0063). For showing controls only; the policies and RPCs still decide every write.';

revoke all on function app.my_shift_planning_projects(uuid) from public, anon;
grant execute on function app.my_shift_planning_projects(uuid) to authenticated, service_role;
