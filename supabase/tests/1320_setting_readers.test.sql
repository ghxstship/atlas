-- pgTAP: migration 1320, the typed setting readers for database rules (A76, RRR-121, A65-001). private.setting_value
-- follows Section 4.5.6 precedence for an org, workspace, project and person: Personal (this org over every org),
-- Project, Workspace, Organization, platform default, with a locked Organization value winning over every lower
-- scope. Cleared values fall back. The project readers take the org and workspace from the project. None of the
-- readers is executable by anon or authenticated.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(18);

select pg_temp.as_platform();
update app.projects set workspace_id = pg_temp.id('ws_a') where id = pg_temp.id('prj_a');

-- Defaults ---------------------------------------------------------------------------------------------------
select is(private.setting_boolean(pg_temp.id('org_a'), 'time.geofence_required'), true, 'an unset Boolean setting reads its platform default');
select is(private.setting_text(pg_temp.id('org_a'), 'time.rounding_minutes'), '0', 'an unset Choice setting reads its platform default');
select is(private.setting_integer(pg_temp.id('org_a'), 'communication.message_retention_days'), 730::bigint, 'an unset Integer setting reads its platform default');
select is((select count(*)::int from private.setting_value(pg_temp.id('org_a'), 'no.such_setting')), 0, 'an unknown key returns no row');

-- Organization, workspace, project ---------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'time.rounding_minutes', 'Organization', pg_temp.id('org_a'), p_value_text => '5');
select pg_temp.as_platform();
select is(private.setting_text(pg_temp.id('org_a'), 'time.rounding_minutes'), '5', 'an org value replaces the default');
select is(private.setting_text(pg_temp.id('org_b'), 'time.rounding_minutes'), '0', 'and stays in its org');

select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'time.rounding_minutes', 'Workspace', pg_temp.id('ws_a'), p_value_text => '6');
select pg_temp.as_platform();
select is(private.setting_text(pg_temp.id('org_a'), 'time.rounding_minutes', pg_temp.id('ws_a')), '6', 'a workspace value overrides the org value inside the workspace');
select is(private.setting_text(pg_temp.id('org_a'), 'time.rounding_minutes'), '5', 'and nowhere else');
select is(private.project_setting_text(pg_temp.id('prj_a'), 'time.rounding_minutes'), '6', 'a project in the workspace inherits the workspace value');
select is(private.project_setting_text(pg_temp.id('prj_a2'), 'time.rounding_minutes'), '5', 'a project outside it inherits the org value');

select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'time.rounding_minutes', 'Project', pg_temp.id('prj_a'), p_value_text => '15');
select pg_temp.as_platform();
select is(private.project_setting_text(pg_temp.id('prj_a'), 'time.rounding_minutes'), '15', 'a project value overrides the workspace value');

-- Lock ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'time.photo_on_punch', 'Project', pg_temp.id('prj_a'), p_value_boolean => false);
select app.set_setting(pg_temp.id('org_a'), 'time.photo_on_punch', 'Organization', pg_temp.id('org_a'), p_value_boolean => true, p_locked => true);
select pg_temp.as_platform();
select is(private.project_setting_boolean(pg_temp.id('prj_a'), 'time.photo_on_punch'), true, 'a locked org value wins over a project value set before the lock');

-- Personal --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select app.set_personal_setting('payroll.week_start', null, p_value_text => 'monday');
select pg_temp.as_platform();
select is(private.setting_text(pg_temp.id('org_a'), 'payroll.week_start', null, null, pg_temp.id('frank')), 'monday', 'a person''s own value wins over the default');
select is(private.setting_text(pg_temp.id('org_a'), 'payroll.week_start'), 'sunday', 'and applies only to that person');
select pg_temp.as_user('frank');
select app.set_personal_setting('payroll.week_start', pg_temp.id('org_a'), p_value_text => 'sunday');
select pg_temp.as_platform();
select is(private.setting_text(pg_temp.id('org_a'), 'payroll.week_start', null, null, pg_temp.id('frank')), 'sunday', 'a value kept for this org wins over one kept for every org');

-- Cleared values ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.clear_setting(pg_temp.id('org_a'), 'time.rounding_minutes', 'Project', pg_temp.id('prj_a'));
select pg_temp.as_platform();
select is(private.project_setting_text(pg_temp.id('prj_a'), 'time.rounding_minutes'), '6', 'a cleared project value falls back to the workspace');

-- Privileges --------------------------------------------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'private.setting_value(uuid, text, uuid, uuid, uuid)', 'EXECUTE'),
  'authenticated cannot call the reader directly');
select ok(not has_function_privilege('anon', 'private.project_setting_boolean(uuid, text)', 'EXECUTE'),
  'anon cannot call the project reader');

select * from finish();
rollback;
