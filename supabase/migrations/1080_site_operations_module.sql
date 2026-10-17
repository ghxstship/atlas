-- 1080_site_operations_module.sql
-- A38 (RRR-82), finding A24-003: Site Operations (sitemap item site-ops, module `workforce`) is listed in
-- Settings, Modules like every other module item, but `workforce` was missing from app.capability_modules, so
-- private.guard_org_module_state refused its switch with module_not_switchable and a save that wrote every
-- listed module failed for every org. Site Operations sits in the Operations navigation group (Section 4.2)
-- and is org-level, so it becomes switchable like Places and Safety. No capability moves: workforce
-- capabilities keep their modules, and turning Site Operations off hides its navigation, search and command
-- menu entries the way any other module switch does.

insert into app.capability_modules (code, nav_group, project_scoped, sort_order)
values ('workforce', 'operations', false, 29)
on conflict (code) do nothing;
