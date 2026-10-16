-- pgTAP: a Viewer made group Owner does not edit other people's memberships (A29, 0810).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(5);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

select pg_temp.as_user('bob');
with g as (insert into app.groups (org_id, name, group_kind) values (pg_temp.id('org_a'), 'Viewer Owned', 'Custom') returning id)
insert into k select 'g', id from g;
insert into app.group_members (group_id, membership_id, group_role) values
  ((select id from k where key = 'g'), pg_temp.id('gina@org_a'), 'Owner'),
  ((select id from k where key = 'g'), pg_temp.id('dave@org_a'), 'Owner'),
  ((select id from k where key = 'g'), pg_temp.id('frank@org_a'), 'Member');

select pg_temp.as_user('gina');
update app.group_members set deleted_at = now()
  where group_id = (select id from k where key = 'g') and membership_id = pg_temp.id('frank@org_a');
select pg_temp.as_platform();
select is((select count(*)::integer from app.group_members where group_id = (select id from k where key = 'g')
  and membership_id = pg_temp.id('frank@org_a') and deleted_at is null), 1, 'a Viewer Owner cannot remove a member');
select pg_temp.as_user('gina');
select throws_ok($$insert into app.group_members (group_id, membership_id) values ((select id from k where key = 'g'), pg_temp.id('erin@org_a'))$$,
  '42501', null, 'a Viewer Owner cannot add members');
update app.group_members set group_role = 'Owner'
  where group_id = (select id from k where key = 'g') and membership_id = pg_temp.id('frank@org_a');
select pg_temp.as_platform();
select is((select group_role::text from app.group_members where group_id = (select id from k where key = 'g')
  and membership_id = pg_temp.id('frank@org_a')), 'Member', 'a Viewer Owner cannot change another member''s row');

select pg_temp.as_user('dave');
select lives_ok($$insert into app.group_members (group_id, membership_id) values ((select id from k where key = 'g'), pg_temp.id('erin@org_a'))$$,
  'a Member Owner still adds members');
select pg_temp.as_user('gina');
select ok(exists (select 1 from app.group_members where group_id = (select id from k where key = 'g')),
  'the Viewer still reads the group''s members');

select * from finish();
rollback;
