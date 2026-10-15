-- pgTAP: sync scopes for PowerSync (late slot, requested by A17). The scopes equal what row level
-- security lets each person read: projects through the projects read policy, orgs and memberships through
-- the membership helpers, engagements through the Section 8.7 operational area while Active or Closing.
-- Triggers keep them current; only the service role reads the table.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(24);

create temporary table seen (who text, scope_key text, scope_value text);
grant select, insert, delete on seen to public;

-- What a person reads: projects through RLS under their own session, then the helpers RLS calls, under
-- their claims.
create function pg_temp.record_rls(p_who text) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user(p_who);
  delete from seen where who = p_who;
  insert into seen select p_who, 'readableProjectIds', p.id::text from app.projects p;
  perform pg_temp.claims(p_who);
  insert into seen select p_who, 'orgIds', o::text from private.my_org_ids() o;
  insert into seen select p_who, 'membershipIds', m::text from private.my_membership_ids() m;
  insert into seen select p_who, 'engagementIds', e::text from private.my_engagement_ids('operational') e
    where (select g.engagement_state from app.engagements g where g.id = e) in ('Active', 'Closing');
  perform pg_temp.as_platform();
end $$;

create function pg_temp.scopes(p_who text, p_key text) returns setof text
language sql as $$
  select g.scope_value from private.sync_scope_grants g
  where g.person_user_id = pg_temp.id(p_who || '_user') and g.scope_key = p_key order by 1
$$;

create function pg_temp.rls(p_who text, p_key text) returns setof text
language sql as $$ select s.scope_value from seen s where s.who = p_who and s.scope_key = p_key order by 1 $$;

select pg_temp.move_engagement('eng_ivy_a', 'Onboarding', 'Active');
select pg_temp.record_rls(w) from unnest(array['alice', 'carol', 'dave', 'frank', 'gina', 'xavier', 'ivy', 'quinn']) w;

-- Scopes match RLS --------------------------------------------------------------------------------------------
select set_eq($$select pg_temp.scopes('alice', 'readableProjectIds')$$, $$select pg_temp.rls('alice', 'readableProjectIds')$$, 'an Owner''s project scope equals the projects they read');
select set_eq($$select pg_temp.scopes('carol', 'readableProjectIds')$$, $$select pg_temp.rls('carol', 'readableProjectIds')$$, 'a Manager''s too');
select set_eq($$select pg_temp.scopes('dave', 'readableProjectIds')$$, $$select pg_temp.rls('dave', 'readableProjectIds')$$, 'a Member''s project scope stops at their projects (invariant 2)');
select set_eq($$select pg_temp.scopes('frank', 'readableProjectIds')$$, $$select pg_temp.rls('frank', 'readableProjectIds')$$, 'a Field member''s too');
select set_eq($$select pg_temp.scopes('gina', 'readableProjectIds')$$, $$select pg_temp.rls('gina', 'readableProjectIds')$$, 'a Viewer outside every project syncs no project');
select set_eq($$select pg_temp.scopes('xavier', 'readableProjectIds')$$, $$select pg_temp.rls('xavier', 'readableProjectIds')$$, 'another org''s Owner syncs only their own projects');
select set_eq($$select pg_temp.scopes('dave', 'orgIds')$$, $$select pg_temp.rls('dave', 'orgIds')$$, 'org scopes equal the person''s orgs');
select set_eq($$select pg_temp.scopes('dave', 'membershipIds')$$, $$select pg_temp.rls('dave', 'membershipIds')$$, 'membership scopes equal the person''s memberships');
select set_eq($$select pg_temp.scopes('ivy', 'engagementIds')$$, $$select pg_temp.rls('ivy', 'engagementIds')$$, 'an external''s engagement scope equals their open operational engagements');
select set_eq($$select pg_temp.scopes('quinn', 'engagementIds')$$, $$select pg_temp.rls('quinn', 'engagementIds')$$, 'an Onboarding engagement syncs nothing');
select is((select count(*)::int from private.sync_scope_grants where person_user_id = pg_temp.id('ivy_user') and scope_key in ('orgIds', 'membershipIds', 'readableProjectIds')), 0, 'an external person gets no internal scopes');
select is((select audience from private.sync_scope_grants where person_user_id = pg_temp.id('ivy_user') and scope_key = 'engagedProjectIds' and scope_value = pg_temp.id('prj_a')::text), 'Crew', 'an external scope carries the engagement''s role type');
select is((select scope_value from private.sync_scope_grants where person_user_id = pg_temp.id('dave_user') and scope_key = 'personIds'), pg_temp.id('dave')::text, 'every person syncs their own person id');

-- Triggers keep scopes current ------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.project_members (project_id, membership_id, project_role) values (pg_temp.id('prj_a2'), pg_temp.id('dave@org_a'), 'Coordinator');
select pg_temp.record_rls('dave');
select ok(pg_temp.id('prj_a2')::text in (select pg_temp.scopes('dave', 'readableProjectIds')), 'joining a project adds it to the scope');
select set_eq($$select pg_temp.scopes('dave', 'readableProjectIds')$$, $$select pg_temp.rls('dave', 'readableProjectIds')$$, 'and the scope still equals RLS');
select pg_temp.as_user('carol');
update app.project_members set deleted_at = now() where project_id = pg_temp.id('prj_a2') and membership_id = pg_temp.id('dave@org_a');
select pg_temp.as_platform();
select ok(pg_temp.id('prj_a2')::text not in (select pg_temp.scopes('dave', 'readableProjectIds')), 'leaving a project removes it (invariant 3)');
select pg_temp.as_user('carol');
with x as (insert into app.shifts (project_id, membership_id, starts_at, ends_at, time_zone) values (pg_temp.id('prj_a2'), pg_temp.id('mia@org_a'), '2027-07-01 08:00+00', '2027-07-01 16:00+00', 'America/New_York') returning id) insert into world select 'sh_mia', id from x;
select pg_temp.record_rls('mia');
select set_eq($$select pg_temp.scopes('mia', 'readableProjectIds')$$, $$select pg_temp.rls('mia', 'readableProjectIds')$$, 'a shift on another project extends the scope as RLS does');
select pg_temp.move_engagement('eng_ivy_a', 'Active', 'Closing');
select is((select count(*)::int from private.sync_scope_grants where person_user_id = pg_temp.id('ivy_user') and scope_key = 'engagementIds'), 1, 'a Closing engagement stays in scope');
select pg_temp.move_engagement('eng_ivy_a', 'Closing', 'Complete');
select is((select count(*)::int from private.sync_scope_grants where person_user_id = pg_temp.id('ivy_user') and scope_key in ('engagementIds', 'engagedProjectIds')), 0, 'leaving Active or Closing deletes the engagement scopes');
select pg_temp.as_platform();
update app.memberships set valid_to = now() where id = pg_temp.id('gina@org_a');
select is((select count(*)::int from private.sync_scope_grants where person_user_id = pg_temp.id('gina_user') and scope_key = 'orgIds'), 0, 'leaving an org removes its scopes immediately (invariant 3)');
select is(private.refresh_all_sync_scope_grants() > 0, true, 'the nightly refresh recomputes every user');
select is((select count(*)::int from cron.job where jobname = 'xos_nightly_sync_scope_refresh'), 1, 'and is scheduled');

-- Access ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok('select 1 from private.sync_scope_grants', '42501', null, 'signed-in callers cannot read sync scopes');
select pg_temp.as_anon();
select throws_ok('select 1 from private.sync_scope_grants', '42501', null, 'nor can anon');
select pg_temp.as_platform();

select * from finish();
rollback;
