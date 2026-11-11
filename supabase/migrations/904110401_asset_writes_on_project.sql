-- Release 4.11, crawl 4.9: Atlas offers a unit's custody moves and Report damage to whoever may make them on the unit's
-- project. app.record_asset_custody and app.apply_asset_scan take assets.custody.write org-wide or on the custody's
-- project, and app.asset_damage's insert policy takes assets.damage.write on the report's project, yet the unit peek
-- read only the org-wide set, so Field leads, Members and Collaborators (assigned reach) never saw Check out, Check in
-- or Report damage, even on their own project's units. The capability read the apps use now also answers those two.
-- Recreated from its latest definition (6524); only the two asset writes are added.

create or replace function app.my_capabilities_on_project(p_project_id uuid, p_capabilities text[])
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(c order by c), '{}')
  from unnest(p_capabilities) c
  where (c like 'credentials.%' or c like 'safety.%' or c like 'data.restricted.%' or c like 'advancing.%'
         or c in ('finance.budget.read', 'projects.gate.read', 'crew.shift.read', 'crew.timesheet.read',
           'finance.expense.read', 'finance.invoice.read', 'procurement.po.read',
           'assets.custody.write', 'assets.damage.write'))
    and private.can_on_project(p_project_id, c);
$$;
comment on function app.my_capabilities_on_project(uuid, text[]) is 'Which of the named credentials, safety, advancing and restricted-data capabilities, the budget, gate, shift, timesheet, expense, invoice and purchase order reads, and the asset custody and damage writes, the signed-in person may use on a project. Only shapes which controls the apps show and which merge fields a generated document can fill; row level security and the RPCs still decide every write.';
revoke all on function app.my_capabilities_on_project(uuid, text[]) from public, anon;
grant execute on function app.my_capabilities_on_project(uuid, text[]) to authenticated, service_role;
