-- pgTAP: migration 2742 (R11), credential.revoked and R7's cascades. A credential revoked by hand tells its holder. Inside
-- the engagement_close and roster_entry_close cascades R7 already sends allocation.withdrawn, so no credential.revoked
-- goes on top of it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql

select no_plan();

create function pg_temp.told(p_who text, p_subject text) returns integer
language sql as $$
  select count(*)::int from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_who) and n.kind = 'credential.revoked' and n.subject_id = pg_temp.id(p_subject)
$$;

-- By hand -------------------------------------------------------------------------------------------------------------------------
insert into world select 'kai_badge', pg_temp.alloc('assign', 'carol', 'e_kai', 'category', 'cat_crew', 1);
select pg_temp.as_user('carol');
select app.issue_allocation('01920000-0000-7000-8742-000000000001', pg_temp.id('kai_badge'), '[{}]');
insert into world select 'cred_kai', c.id from app.credentials c where c.allocation_id = pg_temp.id('kai_badge');
update app.credentials set revoked_at = now() where id = pg_temp.id('cred_kai');
select pg_temp.as_platform();
select is(pg_temp.told('kai', 'cred_kai'), 1, 'a badge revoked by hand tells its holder');

-- A roster entry withdrawn ----------------------------------------------------------------------------------------------------------
insert into world select 'mo_badge', pg_temp.alloc('assign', 'carol', 'e_mo', 'category', 'cat_crew', 1);
select pg_temp.as_user('carol');
select app.issue_allocation('01920000-0000-7000-8742-000000000002', pg_temp.id('mo_badge'), '[{}]');
insert into world select 'cred_mo', c.id from app.credentials c where c.allocation_id = pg_temp.id('mo_badge');
select pg_temp.as_user('victor');
select app.withdraw_roster_entry(pg_temp.id('e_mo'), 'Mo moved to another tour.');
select pg_temp.as_platform();
select isnt((select revoked_at from app.credentials where id = pg_temp.id('cred_mo')), null::timestamptz,
  'withdrawing the entry revokes its badge');
select is(pg_temp.told('mo', 'cred_mo'), 0, 'inside roster_entry_close no credential.revoked is sent');

-- An engagement ended ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with c as (insert into app.credentials (credential_category_id, holder_person_id, engagement_id)
  values (pg_temp.id('cat_crew'), pg_temp.id('ivy'), pg_temp.id('eng_ivy_a')) returning id)
insert into world select 'cred_ivy', id from c;
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.move_engagement('eng_ivy_a', 'Active', 'Canceled');
select isnt((select revoked_at from app.credentials where id = pg_temp.id('cred_ivy')), null::timestamptz,
  'ending the engagement revokes its credential');
select is(pg_temp.told('ivy', 'cred_ivy'), 0, 'inside engagement_close no credential.revoked is sent');

select * from finish();
rollback;
