-- pgTAP: departments and disciplines in use (A86, RRR-131, finding A65-004, Section 4.5.6 org settings item 8).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(17);

-- Who chooses -------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select app.set_departments_in_use(pg_temp.id('org_a'), array['5000'], array[]::text[])$$, '42501', null,
  'a member without org.departments.write cannot choose departments in use');
select throws_ok($$insert into app.org_departments_in_use (org_id, dept_code) values (pg_temp.id('org_a'), '5000')$$, '42501', null,
  'nor write the table directly');

select pg_temp.as_user('bob');
select lives_ok($$select app.set_departments_in_use(pg_temp.id('org_a'), array['5000', '6000', '5000'], array['5000.01'])$$,
  'an admin chooses two departments and a discipline (duplicates collapse)');
select is((select string_agg(dept_code, ',' order by dept_code) from app.org_departments_in_use
           where org_id = pg_temp.id('org_a') and deleted_at is null), '5000,6000', 'one row per department');
select is((select string_agg(disc_code, ',' order by disc_code) from app.org_disciplines_in_use
           where org_id = pg_temp.id('org_a') and deleted_at is null), '5000.01', 'one row per discipline');

-- Replacing the lists -----------------------------------------------------------------------------------------------
select lives_ok($$select app.set_departments_in_use(pg_temp.id('org_a'), array['5000', '6000'], array['5000.01'])$$,
  'saving the same lists again is idempotent');
select is((select count(*)::integer from app.org_departments_in_use where org_id = pg_temp.id('org_a')), 2,
  'no duplicate rows after an identical save');
select lives_ok($$select app.set_departments_in_use(pg_temp.id('org_a'), array['6000'], array[]::text[])$$,
  'removing a department and its discipline');
select is((select string_agg(dept_code, ',') from app.org_departments_in_use
           where org_id = pg_temp.id('org_a') and deleted_at is null), '6000', 'the removed department is no longer in use');
select is((select count(*)::integer from app.org_disciplines_in_use
           where org_id = pg_temp.id('org_a') and deleted_at is null), 0, 'nor its discipline');

-- Refusals ----------------------------------------------------------------------------------------------------------
select throws_ok($$select app.set_departments_in_use(pg_temp.id('org_a'), array['5500'], array[]::text[])$$, 'XR001',
  'department_unknown: 5500 is not a canon department.', 'a code that is not a canon department is refused');
select throws_ok($$select app.set_departments_in_use(pg_temp.id('org_a'), array['6000'], array['9999.99'])$$, 'XR001',
  'discipline_unknown: 9999.99 is not a canon discipline.', 'a code that is not a canon discipline is refused');
select throws_ok($$select app.set_departments_in_use(pg_temp.id('org_a'), array['6000'], array['5000.01'])$$, 'XR001',
  'discipline_department_not_in_use: Choose the department of 5000.01 first.', 'a discipline needs its department in the list');

-- Audit and tenancy -------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select ok((select count(*) from app.audit_events where org_id = pg_temp.id('org_a')
           and action in ('org_departments_in_use.insert', 'org_departments_in_use.update')) >= 3,
  'adding and removing departments is audited');

select pg_temp.as_user('dave');
select is((select count(*)::integer from app.org_departments_in_use where deleted_at is null), 1,
  'every member reads the departments in use of their org');

select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.org_departments_in_use), 0, 'no cross-tenant reads');
select throws_ok($$select app.set_departments_in_use(pg_temp.id('org_a'), array['5000'], array[]::text[])$$, '42501', null,
  'an owner of another org cannot choose for this one');

select * from finish();
rollback;
