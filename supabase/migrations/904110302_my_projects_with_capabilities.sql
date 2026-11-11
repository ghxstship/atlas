-- 4.11 fix (crawl 4.9): which projects grant the signed-in person each module capability, in one read. Atlas's org-level
-- Safety and Credentials pages (no project chosen) offered a control only for a capability held org-wide, from the org
-- context, so a Field lead, Collaborator or Member who may report an incident on their own project saw no Report
-- incident, no crisis alert form and no hint that choosing a project would show them. app.my_capabilities_on_project
-- (6524) answers for one project; asking it once per project of the org costs a round trip each on every page view.
--
-- app.my_projects_with_capabilities answers the same question for every live project of an org at once: the
-- (project, capability) pairs, for the named capabilities that app.my_capabilities_on_project would also answer (the
-- same list, from 6524), where private.project_ids_with (1110) says the person may use it. It only decides which
-- controls and project choices Atlas offers; row level security and the RPCs still decide every read and write.

create function app.my_projects_with_capabilities(p_org_id uuid, p_capabilities text[])
returns table (project_id uuid, capability_code text)
language sql
stable
security definer
set search_path = ''
as $$
  select x.project_id, c.capability_code
  from (select distinct u.c as capability_code from unnest(p_capabilities) u(c)) c
  cross join lateral private.project_ids_with(c.capability_code) x(project_id)
  join app.projects p on p.id = x.project_id and p.org_id = p_org_id and p.deleted_at is null
  where c.capability_code like 'credentials.%' or c.capability_code like 'safety.%'
    or c.capability_code like 'data.restricted.%' or c.capability_code like 'advancing.%'
    or c.capability_code in ('finance.budget.read', 'projects.gate.read', 'crew.shift.read', 'crew.timesheet.read',
      'finance.expense.read', 'finance.invoice.read', 'procurement.po.read')
  order by x.project_id, c.capability_code;
$$;
comment on function app.my_projects_with_capabilities(uuid, text[]) is 'For each live project of the org, which of the named capabilities the signed-in person may use on it (the list app.my_capabilities_on_project answers, by private.project_ids_with): Atlas''s org-level module pages offer a control, and the projects to choose for it, when at least one project grants it (crawl 4.9). Only shapes which controls the apps show; row level security and the RPCs still decide every write.';
revoke all on function app.my_projects_with_capabilities(uuid, text[]) from public, anon;
grant execute on function app.my_projects_with_capabilities(uuid, text[]) to authenticated, service_role;
