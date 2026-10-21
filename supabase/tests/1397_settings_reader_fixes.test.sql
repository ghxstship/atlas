-- pgTAP: migration 1397, settings readers agree with the rules the database applies (RRR-121, audit of A76).
-- app.resolve_settings inside a project applies the project's workspace values as private.project_setting_* do;
-- and Gateway Explore counts only the opportunities gateway.marketplace_visibility still lets everyone open.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(8);

-- A workspace value reaches a project-only resolve ----------------------------------------------------------------------
select pg_temp.as_platform();
update app.projects set workspace_id = pg_temp.id('ws_a') where id = pg_temp.id('prj_a');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'time.photo_on_punch', 'Workspace', pg_temp.id('ws_a'), p_value_boolean => true);
select pg_temp.as_user('dave');
select is((select value_boolean::text || '/' || source from app.resolve_settings(pg_temp.id('org_a'), pg_temp.id('prj_a')) where setting_key = 'time.photo_on_punch'),
  'true/Workspace', 'inside a project, its workspace''s value applies without naming the workspace');
select pg_temp.claims('dave');
select is((select value_boolean from app.resolve_settings(pg_temp.id('org_a'), pg_temp.id('prj_a')) where setting_key = 'time.photo_on_punch'),
  private.project_setting_boolean(pg_temp.id('prj_a'), 'time.photo_on_punch'), 'the same value the kiosk and punch rules apply');
select pg_temp.as_user('dave');
select is((select value_boolean::text || '/' || source from app.resolve_settings(pg_temp.id('org_a'), pg_temp.id('prj_a2')) where setting_key = 'time.photo_on_punch'),
  'false/Default', 'a project outside the workspace keeps the default');
select is((select value_boolean::text || '/' || source from app.resolve_settings(pg_temp.id('org_a')) where setting_key = 'time.photo_on_punch'),
  'false/Default', 'and so does the org without a project');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'time.photo_on_punch', 'Project', pg_temp.id('prj_a'), p_value_boolean => false);
select pg_temp.as_user('dave');
select is((select value_boolean::text || '/' || source from app.resolve_settings(pg_temp.id('org_a'), pg_temp.id('prj_a')) where setting_key = 'time.photo_on_punch'),
  'false/Project', 'a project value still wins over its workspace');

-- Gateway Explore counts what everyone can open ----------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into app.organization_profiles (org_id, handle)
select pg_temp.id('org_a'), 'northwind-live-1397'
where not exists (select 1 from app.organization_profiles p where p.org_id = pg_temp.id('org_a') and p.deleted_at is null);
update app.organization_profiles set visibility = 'Public' where org_id = pg_temp.id('org_a');
select app.set_setting(pg_temp.id('org_a'), 'gateway.marketplace_visibility', 'Organization', pg_temp.id('org_a'), p_value_text => 'public');
select pg_temp.as_user('carol');
with x as (insert into app.opportunities (project_id, role_type, title, visibility, rate_type, deadline_at, starts_on, ends_on)
  values (pg_temp.id('prj_a'), 'Vendor', 'Summer Series lighting', 'Public', 'Bid', now() + interval '7 days',
    (now() + interval '30 days')::date, (now() + interval '32 days')::date) returning id)
insert into world select 'opp_public', id from x;
select app.transition_opportunity(pg_temp.id('opp_public'), 'Draft', 'Pending Approval', 'Ready for approval.');
select app.transition_opportunity(pg_temp.id('opp_public'), 'Pending Approval', 'Published', 'Approved.');
select pg_temp.as_user('ivy');
select is((select open_opportunities from app.explore_organizations() e where e.name = 'Northwind Live'), 1,
  'a Public listing counts while the org lists publicly');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'gateway.marketplace_visibility', 'Organization', pg_temp.id('org_a'), p_value_text => 'private');
select pg_temp.as_user('ivy');
select is((select open_opportunities from app.explore_organizations() e where e.name = 'Northwind Live'), 0,
  'turning the org private takes it out of the count at once');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'gateway.marketplace_visibility', 'Organization', pg_temp.id('org_a'), p_value_text => 'network');
select pg_temp.as_user('ivy');
select is((select open_opportunities from app.explore_organizations() e where e.name = 'Northwind Live'), 0,
  'and so does network, which caps the listing to the org''s network');

select * from finish();
rollback;
