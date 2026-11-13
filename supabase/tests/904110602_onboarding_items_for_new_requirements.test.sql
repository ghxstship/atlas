-- pgTAP: migration 904110602, a requirement added after an engagement exists reaches its onboarding. Ivy's crew engagement
-- on prj_a is in Onboarding when Northwind adds a blocking Crew requirement: Ivy now has its item and reads it, so she can
-- complete what blocks activation. A Vendor requirement leaves her alone, a Complete engagement gets nothing, a requirement
-- changed to apply to Crew reaches her then, and a restored requirement does not duplicate an item.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(8);

create function pg_temp.items(p_engagement text, p_requirement text) returns integer
language sql stable as $$
  select count(*)::int from app.onboarding_items i
  where i.engagement_id = pg_temp.id(p_engagement) and i.onboarding_requirement_id = pg_temp.id(p_requirement) and i.deleted_at is null
$$;

select pg_temp.as_user('carol');
with r as (insert into app.onboarding_requirements (org_id, name, item_kind, role_type, verification_method)
  values (pg_temp.id('org_a'), 'Working at Height Card', 'Document Upload', 'Crew', 'Reviewer') returning id)
  insert into world select 'req_height', id from r;
with r as (insert into app.onboarding_requirements (org_id, name, item_kind, role_type, verification_method)
  values (pg_temp.id('org_a'), 'Vehicle Insurance', 'Document Upload', 'Vendor', 'Reviewer') returning id)
  insert into world select 'req_vehicle', id from r;
select pg_temp.as_platform();

select is(pg_temp.items('eng_ivy_a', 'req_height'), 1, 'a requirement added later reaches an engagement it applies to');
select is(pg_temp.items('eng_ivy_a', 'req_vehicle'), 0, 'and no engagement of another role type');
select pg_temp.as_user('ivy');
select is((select count(*)::int from api_external.onboarding_items
  where engagement_id = pg_temp.id('eng_ivy_a') and name = 'Working at Height Card'), 1,
  'the worker reads the new item in their onboarding');
select pg_temp.as_user('carol');
select throws_like($$select app.transition_engagement((select id from world where key = 'eng_ivy_a'), 'Onboarding', 'Active', 'Go.')$$,
  '%Working at Height Card%', 'it blocks activation, and now the worker can see and complete it');

-- A changed requirement, a restored one, and a finished engagement.
select pg_temp.as_platform();
update app.onboarding_requirements set role_type = 'Crew' where id = pg_temp.id('req_vehicle');
select is(pg_temp.items('eng_ivy_a', 'req_vehicle'), 1, 'a requirement changed to apply to Crew reaches the engagement then');
update app.onboarding_requirements set deleted_at = now() where id = pg_temp.id('req_height');
update app.onboarding_requirements set deleted_at = null where id = pg_temp.id('req_height');
select is(pg_temp.items('eng_ivy_a', 'req_height'), 1, 'restoring a requirement never duplicates an item');
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Canceled');
with r as (insert into app.onboarding_requirements (org_id, name, item_kind, role_type, verification_method)
  values (pg_temp.id('org_a'), 'Late Briefing', 'Acknowledgment', 'Crew', 'Reviewer') returning id)
  insert into world select 'req_late', id from r;
select is(pg_temp.items('eng_ivy_a', 'req_late'), 0, 'a finished engagement gets no new item');
select is(pg_temp.items('eng_ivy_b', 'req_late'), 0, 'nor does another org''s engagement');

select * from finish();
rollback;
