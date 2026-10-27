-- pgTAP: objects over the plan's limits become read-only (2070 and 2071, A107, S16-07, ADR 0081). Lantern Rigging
-- starts the 14-day Pro trial with three projects and three members besides its Owner; when the trial ends on the
-- Access plan (1 active project, 1 seat), the projects past the limit and the seats past it turn read-only with an
-- explanation, and nothing is deleted. The oldest stay writable unless the Owner chose others; archiving a project or
-- upgrading lifts the guard at once, and a later downgrade keeps the Owner's choice. Field seats are checked with the
-- Access field limit lowered to 1 inside this transaction, so the fixture stays small. A console limit override lifts
-- the guard while it lasts.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(64);

create function pg_temp.project(p_key text) returns uuid language sql stable as $$
  select p.id from app.projects p where p.org_id = pg_temp.id('lim_org') and p.project_key = p_key $$;
create function pg_temp.read_only(p_key text) returns boolean language sql stable as $$
  select exists (select 1 from app.over_limit_objects x where x.project_id = pg_temp.project(p_key)) $$;
create function pg_temp.seat_read_only(p_member text) returns boolean language sql stable as $$
  select exists (select 1 from app.over_limit_objects x where x.membership_id = pg_temp.id(p_member || '@lim_org')) $$;
create function pg_temp.trial_end() returns timestamptz language sql stable as $$
  select s.trial_ends_at from app.subscriptions s where s.org_id = pg_temp.id('lim_org') and s.deleted_at is null
    and s.subscription_state <> 'canceled' $$;

select pg_temp.new_user('omar', 'omar@lantern.test', 'Omar Haddad');
select pg_temp.new_user('pia', 'pia@lantern.test', 'Pia Lindgren');
select pg_temp.new_user('quinn', 'quinn@lantern.test', 'Quinn Mbeki');
select pg_temp.new_user('rosa', 'rosa@lantern.test', 'Rosa Ferreira');

-- During the trial ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('nina');
insert into world values ('lim_org', app.create_organization('Lantern Rigging', 'lantern-rigging'));
insert into world select 'nina@lim_org', m.id from app.memberships m where m.org_id = pg_temp.id('lim_org');
insert into app.projects (org_id, project_key, name, time_zone) values
  (pg_temp.id('lim_org'), 'LRA', 'Lantern Spring Tour', 'America/Chicago');
insert into app.projects (org_id, project_key, name, time_zone) values
  (pg_temp.id('lim_org'), 'LRB', 'Lantern Summer Fair', 'America/Chicago');
insert into app.projects (org_id, project_key, name, time_zone) values
  (pg_temp.id('lim_org'), 'LRC', 'Lantern Winter Gala', 'America/Chicago');
insert into app.scope_nodes (project_id, scope_kind, scope_code, name) values
  (pg_temp.project('LRB'), 'Engagement Root', 'LRB', 'Lantern Summer Fair');
select pg_temp.join_org('nina', 'lim_org', 'omar', 'admin');
select pg_temp.join_org('nina', 'lim_org', 'pia', 'member');
select pg_temp.join_org('nina', 'lim_org', 'quinn', 'field');
select pg_temp.join_org('nina', 'lim_org', 'rosa', 'field');

select is((select count(*)::int from app.over_limit_objects where org_id = pg_temp.id('lim_org')), 0,
  'on the Pro trial nothing is over a limit');

-- The trial ends on Access -------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select private.run_trials(pg_temp.trial_end() + interval '1 hour');
select is((select plan_code from app.subscriptions where org_id = pg_temp.id('lim_org') and subscription_state <> 'canceled'),
  'access', 'the trial ended on the Access plan');
select ok(not pg_temp.read_only('LRA'), 'the oldest project stays writable');
select ok(pg_temp.read_only('LRB') and pg_temp.read_only('LRC'), 'the projects past the Access limit of 1 are read-only');
select ok(not pg_temp.seat_read_only('nina'), 'the Owner''s seat is never read-only');
select ok(pg_temp.seat_read_only('omar') and pg_temp.seat_read_only('pia'), 'the seats past the Access limit of 1 are read-only');
select ok(not pg_temp.seat_read_only('quinn') and not pg_temp.seat_read_only('rosa'), 'field seats within the Access limit of 10 stay writable');
select is((select count(*)::int from app.projects where org_id = pg_temp.id('lim_org') and deleted_at is null), 3,
  'no project is deleted');
select is((select count(*)::int from app.memberships where org_id = pg_temp.id('lim_org') and deleted_at is null and valid_to is null), 5,
  'no membership ends');

-- The guard ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('nina');
select lives_ok($$update app.projects set name = 'Lantern Spring Tour 2027' where id = pg_temp.project('LRA')$$,
  'the Owner edits the writable project');
select throws_ok($$update app.projects set name = 'Lantern Summer Fair 2027' where id = pg_temp.project('LRB')$$,
  'XR001', null, 'the Owner cannot edit a read-only project');
select throws_like($$update app.projects set name = 'Lantern Summer Fair 2027' where id = pg_temp.project('LRB')$$,
  'plan_limit_read_only: This project is read-only: the Access plan allows 1 active project and the organization has 3.%',
  'the refusal names the plan, the limit and the count');
select throws_like($$update app.projects set name = 'Lantern Summer Fair 2027' where id = pg_temp.project('LRB')$$,
  '%choose which projects stay writable in Settings, Billing and Plan, archive a project or upgrade the plan. No data is deleted.',
  'and says how to lift it');
select throws_ok($$insert into app.scope_nodes (project_id, parent_id, scope_kind, scope_code, name)
  values (pg_temp.project('LRB'), (select id from app.scope_nodes where scope_code = 'LRB'), 'Show', 'LRB-E01', 'Opening Day')$$,
  'XR001', null, 'adding to a read-only project is refused');
select throws_ok($$update app.scope_nodes set name = 'Summer Fair' where scope_code = 'LRB'$$,
  'XR001', null, 'editing anything of a read-only project is refused');
select lives_ok($$insert into app.scope_nodes (project_id, scope_kind, scope_code, name)
  values (pg_temp.project('LRA'), 'Engagement Root', 'LRA', 'Lantern Spring Tour')$$,
  'the writable project takes new work');

select pg_temp.as_user('omar');
select throws_like($$insert into app.workspaces (org_id, slug, name) values (pg_temp.id('lim_org'), 'north', 'North')$$,
  'plan_limit_read_only: Your seat is read-only: the Access plan includes 1 seat and 3 members hold one.%',
  'a member whose seat is read-only cannot write, and the refusal names the seat limit');
select throws_ok($$update app.projects set name = 'Spring Tour' where id = pg_temp.project('LRA')$$,
  'XR001', null, 'not even to the writable project');
select lives_ok($$insert into app.favorites (org_id, person_id, node_id) values (pg_temp.id('lim_org'), pg_temp.id('omar'), 'projects')$$,
  'a read-only seat keeps the personal tables: favorites');
select is((select count(*)::int from app.projects where org_id = pg_temp.id('lim_org')), 3, 'and still reads every project');

select pg_temp.as_platform();
select lives_ok($$update app.projects set description = 'Kept by billing.' where id = pg_temp.project('LRB')$$,
  'workers and billing (no person) still write');

-- What Atlas shows ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('nina');
select results_eq($$select over_limit_plan, read_only_projects, read_only_seats, read_only_field_seats, own_seat_read_only
  from app.org_banner_status(pg_temp.id('lim_org'))$$,
  $$values ('access'::text, 2, 2, 0, null::text)$$, 'the Owner''s banner status counts what is read-only');
select results_eq($$select limit_code, plan_code, limit_value, in_use, read_only from app.plan_limit_usage(pg_temp.id('lim_org'))$$,
  $$values ('active_projects'::text, 'access'::text, 1::bigint, 3::bigint, 2::bigint),
           ('seats', 'access', 1, 3, 2), ('field_members', 'access', 10, 2, 0)$$,
  'usage per object limit: the limit, the count and the read-only');
select results_eq($$select label, project_key, chosen, locked, read_only
  from app.plan_limit_candidates(pg_temp.id('lim_org'), 'active_projects')$$,
  $$values ('Lantern Spring Tour 2027'::text, 'LRA'::text, false, false, false),
           ('Lantern Summer Fair', 'LRB', false, false, true), ('Lantern Winter Gala', 'LRC', false, false, true)$$,
  'the Owner''s panel lists the projects in the order of the selection rule');
select results_eq($$select label, role_code, locked, read_only from app.plan_limit_candidates(pg_temp.id('lim_org'), 'seats')$$,
  $$values ('Nina Halvorsen'::text, 'owner'::text, true, false), ('Omar Haddad', 'admin', false, true),
           ('Pia Lindgren', 'member', false, true)$$,
  'and the seats, the Owner''s locked first');
select pg_temp.as_user('pia');
select results_eq($$select read_only_projects, own_seat_read_only from app.org_banner_status(pg_temp.id('lim_org'))$$,
  $$values (2, 'seats'::text)$$, 'a member learns their own seat is read-only');
select throws_ok($$select * from app.plan_limit_candidates(pg_temp.id('lim_org'), 'seats')$$, '42501', null,
  'only billing readers list the candidates');
select throws_ok($$select app.choose_plan_limit_keeps(pg_temp.id('lim_org'), 'active_projects', array[pg_temp.project('LRC')])$$,
  '42501', null, 'only the Owner chooses');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.plan_limit_usage(pg_temp.id('lim_org'))$$, '42501', null, 'outsiders read no usage');
select is_empty($$select * from app.over_limit_objects where org_id = pg_temp.id('lim_org')$$, 'nor which objects are read-only');

-- The Owner's choice -----------------------------------------------------------------------------------------------------
select pg_temp.as_user('nina');
select is(app.choose_plan_limit_keeps(pg_temp.id('lim_org'), 'active_projects', array[pg_temp.project('LRC')]), 2,
  'the Owner keeps the newest project writable instead');
select ok(not pg_temp.read_only('LRC') and pg_temp.read_only('LRA') and pg_temp.read_only('LRB'),
  'the chosen project is writable and the oldest turns read-only');
select lives_ok($$update app.projects set name = 'Lantern Winter Gala 2027' where id = pg_temp.project('LRC')$$,
  'the chosen project takes edits at once');
select throws_ok($$update app.projects set name = 'Spring Tour' where id = pg_temp.project('LRA')$$,
  'XR001', null, 'and the oldest refuses them');
select throws_like($$select app.choose_plan_limit_keeps(pg_temp.id('lim_org'), 'active_projects', array[pg_temp.project('LRA'), pg_temp.project('LRC')])$$,
  'plan_limit_choice_too_many:%choose at most 1%', 'the choice holds at most the limit');
select throws_like($$select app.choose_plan_limit_keeps(pg_temp.id('lim_org'), 'seats', array[pg_temp.id('omar@lim_org')])$$,
  'plan_limit_choice_too_many:%Owners hold 1, so choose at most 0%', 'Owners'' seats count first');
select throws_like($$select app.choose_plan_limit_keeps(pg_temp.id('lim_org'), 'active_projects', array[pg_temp.id('omar@lim_org')])$$,
  'plan_limit_choice_unknown:%', 'only the org''s own active projects can be chosen');
select is((select count(*)::int from app.plan_limit_choices where org_id = pg_temp.id('lim_org') and deleted_at is null), 1,
  'a refused choice changes nothing');

-- Archiving lifts the guard ------------------------------------------------------------------------------------------------
select lives_ok($$update app.projects set archived_at = now() where id = pg_temp.project('LRB')$$,
  'archiving a read-only project stays allowed');
select ok(not pg_temp.read_only('LRB') and pg_temp.read_only('LRA'), 'an archived project is no longer counted');
select lives_ok($$update app.projects set archived_at = now() where id = pg_temp.project('LRC')$$,
  'the Owner archives the writable project too');
select ok(not pg_temp.read_only('LRA'), 'back within the limit, the last project is writable at once');
select lives_ok($$update app.projects set name = 'Lantern Spring Tour' where id = pg_temp.project('LRA')$$,
  'and takes edits');
select throws_like($$update app.projects set archived_at = null where id = pg_temp.project('LRC')$$,
  'plan_limit_exceeded:%', 'restoring a project past the limit is refused, so it never turns another read-only');

-- Upgrading lifts the guard ------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select app.sync_subscription_from_stripe(pg_temp.id('lim_org'), 'cus_A107Lantern', 'sub_A107Lantern', 'core', 'Monthly',
  'active', now() + interval '30 days', false);
select is((select count(*)::int from app.over_limit_objects where org_id = pg_temp.id('lim_org')), 0,
  'on Core (unlimited projects, 5 seats) nothing is read-only');
select pg_temp.as_user('omar');
select lives_ok($$insert into app.workspaces (org_id, slug, name) values (pg_temp.id('lim_org'), 'north', 'North')$$,
  'a member whose seat was read-only writes again');
select pg_temp.as_user('nina');
select lives_ok($$update app.projects set archived_at = null where id in (pg_temp.project('LRB'), pg_temp.project('LRC'))$$,
  'and the Owner restores both projects');

-- A later downgrade keeps the choice ---------------------------------------------------------------------------------------
select pg_temp.as_platform();
select app.sync_subscription_from_stripe(pg_temp.id('lim_org'), 'cus_A107Lantern', 'sub_A107Lantern', 'core', 'Monthly',
  'canceled', now(), false);
select ok(not pg_temp.read_only('LRC') and pg_temp.read_only('LRA') and pg_temp.read_only('LRB'),
  'back on Access after a cancellation, the project the Owner chose is the one that stays writable');
select is((select count(*)::int from app.projects where org_id = pg_temp.id('lim_org') and deleted_at is null), 3,
  'and still nothing is deleted');

-- Field seats -----------------------------------------------------------------------------------------------------------
update private.plan_limits set limit_value = 1 where plan_code = 'access' and limit_code = 'field_members';
select ok(not pg_temp.seat_read_only('quinn') and pg_temp.seat_read_only('rosa'),
  'a lower plan limit takes effect at once: the newer field seat is read-only');
select pg_temp.claims('rosa');
select throws_like($$insert into app.workspaces (org_id, slug, name) values (pg_temp.id('lim_org'), 'south', 'South')$$,
  'plan_limit_read_only: Your field seat is read-only: the Access plan includes Compass for 1 field member and the organization has 2.%',
  'a read-only field seat refuses the person''s writes, naming the field limit');
select pg_temp.as_user('nina');
select is(app.choose_plan_limit_keeps(pg_temp.id('lim_org'), 'field_members', array[pg_temp.id('rosa@lim_org')]), 1,
  'the Owner chooses who keeps the field seat');
select ok(pg_temp.seat_read_only('quinn') and not pg_temp.seat_read_only('rosa'), 'and the choice is respected');

-- Memberships -----------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
update app.memberships set valid_to = now() where id = pg_temp.id('omar@lim_org');
select ok(not pg_temp.seat_read_only('omar') and pg_temp.seat_read_only('pia'), 'an ended membership leaves the read-only set');

-- A console override --------------------------------------------------------------------------------------------------------
insert into app.plan_overrides (org_id, override_kind, limit_code, limit_value, reason, expires_at) values
  (pg_temp.id('lim_org'), 'Limit', 'active_projects', 3, 'Room for the spring season while the Owner decides.', now() + interval '14 days');
select ok(not pg_temp.read_only('LRA') and not pg_temp.read_only('LRB') and not pg_temp.read_only('LRC'),
  'a console limit override lifts the guard at once');
update app.plan_overrides set ended_at = now(), end_reason = 'The Owner chose what to keep.'
where org_id = pg_temp.id('lim_org') and ended_at is null;
select ok(not pg_temp.read_only('LRC') and pg_temp.read_only('LRA') and pg_temp.read_only('LRB'),
  'ending it early brings the read-only set back, with the Owner''s choice');
select is(private.recompute_over_limit(pg_temp.id('lim_org')), 0, 'recomputing again changes nothing, so the set never drifts');

-- Machinery ---------------------------------------------------------------------------------------------------------------
select is((select coalesce(string_agg(t.table_name, ', '), '') from private.over_limit_personal_tables t
  where to_regclass(t.table_name) is null), '', 'every personal table exists');
select is((select coalesce(string_agg(c.relname, ', '), '') from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app' and format('app.%s', c.relname) in (select table_name from private.over_limit_personal_tables)
    and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 't15_refuse_read_only_org')), '',
  'every personal table carries the guard the list exempts it from');
select ok(exists (select 1 from pg_trigger t where t.tgrelid = 'app.scope_nodes'::regclass and t.tgname = 't15_refuse_read_only_org'),
  'the guard sits on project children');
select is((select count(*)::int from pg_trigger t where t.tgname = 't93_recompute_over_limit'
  and t.tgrelid in ('app.subscriptions'::regclass, 'app.projects'::regclass, 'app.memberships'::regclass,
                    'app.membership_roles'::regclass, 'app.plan_overrides'::regclass, 'private.plan_limits'::regclass)), 6,
  'plan changes, overrides, archives, deletes, role and membership changes and plan limits recompute in the database');
select ok(pg_get_functiondef('private.run_org_lifecycle(timestamptz)'::regprocedure) like '%private.refresh_over_limit(p_now)%',
  'the hourly lifecycle job refreshes read-only objects');
select ok(not has_function_privilege('authenticated', 'private.recompute_over_limit(uuid)', 'execute'),
  'no client recomputes read-only objects');
select ok(not has_table_privilege('authenticated', 'app.over_limit_objects', 'insert')
  and not has_table_privilege('authenticated', 'app.plan_limit_choices', 'insert'),
  'no client writes the read-only set or the choice directly');

select * from finish();
rollback;
