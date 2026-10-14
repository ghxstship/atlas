-- 0441_operations_access.sql
-- A11 Logistics and Hospitality: which logistics and hospitality capabilities the signed-in person
-- may use on which projects of an org, so Atlas shows only the controls the database will accept
-- (Section 5, rule 1). Reach comes from private.project_ids_with, the same rule the policies use, so
-- assigned-reach roles (Member, Collaborator, Field) see their controls only on their projects.

create or replace function app.operations_project_capabilities(p_org_id uuid)
returns table (project_id uuid, capability_code text)
language sql
stable
security definer
set search_path = ''
as $$
  select x.project_id, c.code
  from (values
    ('logistics.shipment.read'), ('logistics.shipment.write'), ('logistics.dock_slot.write'),
    ('logistics.yard.write'), ('logistics.release.approve'),
    ('hospitality.fulfillment.read'), ('hospitality.fulfillment.write'), ('hospitality.beo.write'),
    ('hospitality.beo.approve'), ('hospitality.accommodation.write')
  ) as c (code)
  cross join lateral (select p as project_id from private.project_ids_with(c.code) p) x
  join app.projects pr on pr.id = x.project_id
  where pr.org_id = p_org_id and pr.org_id in (select private.my_org_ids())
  order by x.project_id, c.code;
$$;

comment on function app.operations_project_capabilities(uuid) is 'Pairs of project and logistics or hospitality capability the signed-in person may use in the org, by the invariant 2 rule the policies apply. For showing controls only; the policies still decide every write.';
revoke all on function app.operations_project_capabilities(uuid) from public, anon;
grant execute on function app.operations_project_capabilities(uuid) to authenticated, service_role;
