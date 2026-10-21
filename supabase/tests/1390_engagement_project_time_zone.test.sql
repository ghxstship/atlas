-- pgTAP: 1390, api_external.engagements carries the engagement's project time zone for Gateway's "today" (RRR-116).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(5);

select has_column('api_external', 'engagements', 'project_time_zone', 'the engagements projection names the project''s time zone');
select isnt(
  col_description('api_external.engagements'::regclass,
    (select attnum from pg_attribute where attrelid = 'api_external.engagements'::regclass and attname = 'project_time_zone')),
  null, 'project_time_zone is documented');

-- Two projects on calendars that never share a date with UTC at the same hour.
select pg_temp.as_platform();
update app.projects set time_zone = 'Pacific/Kiritimati' where id = pg_temp.id('prj_a');
update app.projects set time_zone = 'Pacific/Pago_Pago' where id = pg_temp.id('prj_b');

select pg_temp.as_user('ivy');
select is((select project_time_zone from api_external.engagements where id = pg_temp.id('eng_ivy_a')), 'Pacific/Kiritimati',
  'an engagement reads its own project''s zone');
select is((select project_time_zone from api_external.engagements where id = pg_temp.id('eng_ivy_b')), 'Pacific/Pago_Pago',
  'gate 33: each of a person''s engagements follows its own project''s calendar');
select is((select count(*)::int from api_external.engagements where id = pg_temp.id('eng_quinn_b')), 0,
  'the row filter is unchanged: another party''s engagement stays hidden');
select pg_temp.as_platform();

select * from finish();
rollback;
