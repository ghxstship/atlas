-- pgTAP: objects over the plan's limits become read-only (2070 and 2071, A107, S16-07, ADR 0081). Lantern Rigging
-- starts the 14-day Pro trial with three projects and three members besides its Owner; when the trial ends on the
-- Access plan (1 active project, 1 seat), the projects past the limit and the seats past it turn read-only with an
-- explanation, and nothing is deleted. The oldest stay writable unless the Owner chose others; archiving a project or
-- upgrading lifts the guard at once, and a later downgrade keeps the Owner's choice. The guard reaches a read-only
-- project's grandchildren too: lines of its budget and comments in its threads. Field seats are checked with the
-- Access field limit lowered to 1 inside this transaction, so the fixture stays small. A console limit override lifts
-- the guard while it lasts. Share links count as writes to their file. The hourly refresh is checked by moving dates
-- back with the recompute triggers held off, since nothing writes when a date passes.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(99);

create function pg_temp.project(p_key text) returns uuid language sql stable as $$
  select p.id from app.projects p where p.org_id = pg_temp.id('lim_org') and p.project_key = p_key $$;
create function pg_temp.read_only(p_key text) returns boolean language sql stable as $$
  select exists (select 1 from app.over_limit_objects x where x.project_id = pg_temp.project(p_key)) $$;
create function pg_temp.seat_read_only(p_member text) returns boolean language sql stable as $$
  select exists (select 1 from app.over_limit_objects x where x.membership_id = pg_temp.id(p_member || '@lim_org')) $$;
-- A file on one of Lantern's projects whose version scanned clean, as 1380 makes one.
create function pg_temp.clean_file(p_user text, p_project text, p_name text) returns uuid
language plpgsql as $$
declare
  v_version uuid;
  v_object text;
begin
  perform pg_temp.as_user(p_user);
  select u.attachment_version_id, u.object_name into v_version, v_object
  from app.begin_attachment_upload('app.projects', pg_temp.project(p_project), p_name, 'application/pdf', 1200) u;
  insert into storage.objects (bucket_id, name, metadata) values ('attachments', v_object, '{"size": 1200}');
  perform app.complete_attachment_upload(v_version, repeat('ab', 32));
  perform pg_temp.as_platform();
  perform app.record_attachment_scan(v_version, true);
  insert into world select p_name, v.attachment_id from app.attachment_versions v where v.id = v_version;
  return v_version;
end $$;
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
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.project('LRA'), 'Spring Tour Budget', 'USD') returning id)
insert into world select 'lra_budget', id from x;
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.project('LRB'), 'Summer Fair Budget', 'USD') returning id)
insert into world select 'lrb_budget', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, xyz, xyz_basis)
  values (pg_temp.id('lrb_budget'), 1, 'Truss rental.', '0000.01.01', 1, 'X', 'Declared') returning id)
insert into world select 'lrb_line', id from x;
select app.post_comment('app.projects', pg_temp.project('LRB'), 'Load-in moves to 07:00.');
select pg_temp.join_org('nina', 'lim_org', 'omar', 'admin');
select pg_temp.join_org('nina', 'lim_org', 'pia', 'member');
select pg_temp.join_org('nina', 'lim_org', 'quinn', 'field');
select pg_temp.join_org('nina', 'lim_org', 'rosa', 'field');
select pg_temp.clean_file('nina', 'LRA', 'tour-rider.pdf');
select pg_temp.clean_file('nina', 'LRB', 'fair-rider.pdf');
select pg_temp.as_user('nina');
insert into world select 'fair_link', l.share_link_id
from app.create_share_link(pg_temp.id('fair-rider.pdf'), now() + interval '7 days') l;
select pg_temp.as_user('omar');
insert into world select 'omar_link', l.share_link_id
from app.create_share_link(pg_temp.id('tour-rider.pdf'), now() + interval '7 days') l;
select pg_temp.as_platform();

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
select throws_like($$insert into app.budget_lines (budget_id, line_number, description, urid, quantity, xyz, xyz_basis)
  values (pg_temp.id('lrb_budget'), 2, 'Sound package.', '0000.01.01', 1, 'X', 'Declared')$$,
  'plan_limit_read_only: This project is read-only:%', 'a new line on a read-only project''s budget is refused');
select throws_ok($$update app.budget_lines set description = 'Truss and motors.' where id = pg_temp.id('lrb_line')$$,
  'XR001', null, 'so is editing a line of its budget');
select throws_like($$select app.post_comment('app.projects', pg_temp.project('LRB'), 'Doors at 18:00.')$$,
  'plan_limit_read_only:%', 'commenting in a read-only project''s thread is refused');
select throws_like($$select app.post_comment('app.projects', pg_temp.project('LRB'), 'Check the rider.', null, 'rider')$$,
  'plan_limit_read_only:%', 'and so is starting a new thread on it');
select lives_ok($$insert into app.budget_lines (budget_id, line_number, description, urid, quantity, xyz, xyz_basis)
  values (pg_temp.id('lra_budget'), 1, 'Stage deck rental.', '0000.01.01', 1, 'X', 'Declared')$$,
  'the writable project''s budget takes new lines');
select throws_like($$insert into app.record_grants (target_kind, target_id, capability_code, grantee_person_id, valid_to, reason)
  values ('project', pg_temp.project('LRB'), 'projects.project.read', pg_temp.id('rosa'), now() + interval '7 days', 'Covering the fair.')$$,
  'plan_limit_read_only: This project is read-only:%', 'sharing a read-only project through an access grant is refused');
select lives_ok($$insert into app.record_grants (target_kind, target_id, capability_code, grantee_person_id, valid_to, reason)
  values ('project', pg_temp.project('LRA'), 'projects.project.read', pg_temp.id('rosa'), now() + interval '7 days', 'Covering the tour.')$$,
  'the writable project can still be shared');
select throws_like($$select * from app.create_share_link(pg_temp.id('fair-rider.pdf'), now() + interval '7 days')$$,
  'plan_limit_read_only: This project is read-only:%', 'a read-only project''s file is not sent out by share link');
select lives_ok($$select * from app.create_share_link(pg_temp.id('tour-rider.pdf'), now() + interval '7 days')$$,
  'the writable project''s files still are');
select lives_ok($$select app.revoke_share_link(pg_temp.id('fair_link'))$$,
  'a link made to the read-only project''s file before is still revoked, which withdraws access');

select pg_temp.as_user('omar');
select throws_like($$insert into app.workspaces (org_id, slug, name) values (pg_temp.id('lim_org'), 'north', 'North')$$,
  'plan_limit_read_only: Your seat is read-only: the Access plan includes 1 seat and 3 members hold one.%',
  'a member whose seat is read-only cannot write, and the refusal names the seat limit');
select throws_like($$select * from app.create_share_link(pg_temp.id('tour-rider.pdf'), now() + interval '7 days')$$,
  'plan_limit_read_only: Your seat is read-only:%', 'nor make a share link, even to the writable project''s file');
select lives_ok($$select app.revoke_share_link(pg_temp.id('omar_link'))$$, 'but still revokes a link it made');
select throws_ok($$update app.projects set name = 'Spring Tour' where id = pg_temp.project('LRA')$$,
  'XR001', null, 'not even to the writable project');
select lives_ok($$insert into app.favorites (org_id, person_id, node_id) values (pg_temp.id('lim_org'), pg_temp.id('omar'), 'projects')$$,
  'a read-only seat keeps the personal tables: favorites');
select ok(app.record_recent_view(pg_temp.id('lim_org'), 'projects', pg_temp.project('LRB')),
  'and its recents, which no read-only state guards: opening a read-only project is still noted');
select throws_like($$update app.membership_roles set deleted_at = now() where membership_id = pg_temp.id('pia@lim_org')$$,
  'plan_limit_read_only: Your seat is read-only:%',
  'an Admin whose seat is read-only cannot change another member''s roles, so cannot free a seat past the Owner''s choice');
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
select app.transition_project(pg_temp.project('LRA'), 'Proposed', 'Active', 'Load-in confirmed.');
select lives_ok($$select app.transition_project(pg_temp.project('LRA'), 'Active', 'Complete', 'Tour wrapped.')$$,
  'the Owner completes the writable project');
select lives_ok($$update app.projects set archived_at = null where id = pg_temp.project('LRC')$$,
  'with it complete, restoring the archived project fits the limit');
select throws_like($$select app.transition_project(pg_temp.project('LRA'), 'Complete', 'Active', 'One more date.')$$,
  'plan_limit_exceeded:%', 'reopening a completed project past the limit is refused');
select throws_like($$update app.projects set project_state = 'Active' where id = pg_temp.project('LRA')$$,
  'plan_limit_exceeded:%', 'and the project guard counts a reopen however it is written');

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
select lives_ok($$select app.transition_project(pg_temp.project('LRA'), 'Complete', 'Active', 'One more date.')$$,
  'and reopens the completed one');

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
select pg_temp.as_user('pia');
select lives_ok($$select app.leave_organization(pg_temp.id('lim_org'))$$,
  'a member whose seat is read-only still leaves the org');
select pg_temp.as_platform();
select ok(exists (select 1 from app.offboardings o where o.membership_id = pg_temp.id('pia@lim_org') and o.deleted_at is null)
  and not pg_temp.seat_read_only('pia'), 'leaving opens their offboarding and frees the seat');

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
select pg_temp.as_user('nina');
select lives_ok($$update app.projects set deleted_at = now() where id = pg_temp.project('LRB')$$,
  'deleting a read-only project stays allowed, its budget and comments with it');
select ok(not pg_temp.read_only('LRB') and pg_temp.read_only('LRA'), 'a deleted project is no longer counted');
select pg_temp.as_platform();

-- The hourly refresh -----------------------------------------------------------------------------------------------------
-- Every membership here began in this transaction, inside the refresh's two-hour window; they are moved a day back
-- first, so each case below shows the branch of private.refresh_over_limit that picks the org up.
alter table app.memberships disable trigger t93_recompute_over_limit;
update app.memberships set valid_from = valid_from - interval '1 day' where org_id = pg_temp.id('lim_org');
update app.memberships set valid_to = now() where id = pg_temp.id('quinn@lim_org');
select ok(pg_temp.seat_read_only('quinn'), 'a membership that reaches its end writes nothing, so its seat stays in the read-only set');
select cmp_ok(private.refresh_over_limit(), '>', 0, 'the hourly refresh picks up an org with read-only objects');
select ok(not pg_temp.seat_read_only('quinn'), 'and frees the seat on time');
insert into app.plan_overrides (org_id, override_kind, limit_code, limit_value, reason, starts_at, expires_at) values
  (pg_temp.id('lim_org'), 'Limit', 'active_projects', 2, 'Both remaining projects through the season.',
   now() - interval '1 day', now() + interval '14 days');
select is((select count(*)::int from app.over_limit_objects where org_id = pg_temp.id('lim_org')), 0,
  'with a limit override for both projects nothing in the org is read-only');
-- Sven is added ahead while a seat override has room for him; the override then ends before he begins.
insert into app.plan_overrides (org_id, override_kind, limit_code, limit_value, reason, starts_at, expires_at) values
  (pg_temp.id('lim_org'), 'Limit', 'seats', 2, 'A second seat for the crew chief.', now() - interval '1 day', now() + interval '14 days');
select pg_temp.new_user('sven', 'sven@lantern.test', 'Sven Okafor');
with x as (insert into app.memberships (org_id, person_id, valid_from)
  values (pg_temp.id('lim_org'), pg_temp.id('sven'), now() + interval '1 day') returning id)
insert into world select 'sven@lim_org', id from x;
insert into app.membership_roles (org_id, membership_id, role_id)
  values (pg_temp.id('lim_org'), pg_temp.id('sven@lim_org'), pg_temp.system_role('member'));
update app.plan_overrides set ended_at = now(), end_reason = 'The crew chief starts on Access.'
where org_id = pg_temp.id('lim_org') and limit_code = 'seats' and ended_at is null;
select ok(not pg_temp.seat_read_only('sven'), 'a membership dated ahead holds no seat before it begins');
update app.memberships set valid_from = now() - interval '30 minutes' where id = pg_temp.id('sven@lim_org');
select private.refresh_over_limit(now() + interval '3 hours');
select ok(not pg_temp.seat_read_only('sven'), 'once it begins, a refresh whose two hours have passed does not pick the org up');
select cmp_ok(private.refresh_over_limit(), '>', 0, 'the hourly refresh does pick up a membership that began in the last two hours');
select ok(pg_temp.seat_read_only('sven'), 'and the seat it takes past the limit is read-only');
alter table app.memberships enable trigger t93_recompute_over_limit;
update app.memberships set deleted_at = now() where id = pg_temp.id('sven@lim_org');
select is((select count(*)::int from app.over_limit_objects where org_id = pg_temp.id('lim_org')), 0,
  'removing the membership frees the seat at once');
alter table app.plan_overrides disable trigger t40_guard_plan_override;
update app.plan_overrides set starts_at = now() - interval '14 days', expires_at = now() - interval '30 minutes'
where org_id = pg_temp.id('lim_org') and ended_at is null;
alter table app.plan_overrides enable trigger t40_guard_plan_override;
select ok(not pg_temp.read_only('LRA'), 'an override that expires by itself writes nothing, so the set still reflects it');
select cmp_ok(private.refresh_over_limit(), '>', 0,
  'the hourly refresh picks up an override that expired in the last two hours, in an org with nothing read-only');
select ok(pg_temp.read_only('LRA') and not pg_temp.read_only('LRC'), 'and applies it, keeping the Owner''s choice');

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
