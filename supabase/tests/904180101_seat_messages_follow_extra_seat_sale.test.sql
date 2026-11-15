-- pgTAP: migration 904180101 (RRR-243; ADR 0035, 2026-11-15 amendment). Extra seats are not on sale, so no database
-- message offers them: a seat refusal on a plan that prices extra seats names the upgrade and freeing a seat, and the
-- explanation of a read-only seat names the Owner's choice and the upgrade. The rules, the SQLSTATE and the refusal
-- codes are as migrations 1250 and 3070 left them.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(11);

select pg_temp.as_platform();

-- The seat refusal ------------------------------------------------------------------------------------------
update app.subscriptions set plan_code = 'core' where org_id = pg_temp.id('org_b');
select lives_ok($$select private.assert_within_plan_limit(pg_temp.id('org_b'), 'seats', 5)$$,
  'a Core org still fits its fifth seat');
select throws_ok($$select private.assert_within_plan_limit(pg_temp.id('org_b'), 'seats', 6)$$, 'XR001',
  'seat_limit_reached: All 5 seats are in use. Upgrade the plan in Billing and Plan, or remove a member to free a seat. If you are not an Owner, ask an Owner to upgrade.',
  'the sixth seat on a plan that prices extra seats refuses as seat_limit_reached, and names the upgrade and freeing a seat');
update app.subscriptions set plan_code = 'access' where org_id = pg_temp.id('org_b');
select throws_ok($$select private.assert_within_plan_limit(pg_temp.id('org_b'), 'seats', 2)$$, 'XR001',
  'seat_limit_upgrade: All 1 seats are in use, and the access plan sells no extra seats. Upgrade the plan to add seats.',
  'a plan that prices no extra seats refuses as seat_limit_upgrade, word for word as before');
select throws_ok($$select private.assert_within_plan_limit(pg_temp.id('org_b'), 'active_projects', 2)$$, 'XR001',
  'plan_limit_exceeded: The plan allows 1 active_projects; this change needs 2.',
  'every other limit refuses as plan_limit_exceeded, word for word as before');
select lives_ok($$select private.assert_within_plan_limit(pg_temp.id('org_a'), 'active_projects', 1000)$$,
  'an unlimited limit never refuses');

-- The read-only explanations --------------------------------------------------------------------------------
select alike(private.over_limit_refusal(pg_temp.id('org_b'), 'seats'),
  'Your seat is read-only: the Access plan includes 1 seat and % members hold one. An Owner can choose who keeps a seat in Settings, Billing and Plan, or upgrade the plan. No data is deleted.',
  'a read-only seat is told of the Owner''s choice and the upgrade');
select alike(private.over_limit_refusal(pg_temp.id('org_b'), 'active_projects'),
  'This project is read-only: the Access plan allows 1 active project and the organization has %. An Owner can choose which projects stay writable in Settings, Billing and Plan, archive a project or upgrade the plan. No data is deleted.',
  'a read-only project reads as before');
select alike(private.over_limit_refusal(pg_temp.id('org_b'), 'field_members'),
  'Your field seat is read-only: the Access plan includes Compass for 10 field members and the organization has %. An Owner can choose who keeps one in Settings, Billing and Plan or upgrade the plan. No data is deleted.',
  'a read-only field seat reads as before');

-- Nothing in either function offers a purchase ----------------------------------------------------------------
select is((select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private' and p.proname in ('assert_within_plan_limit', 'over_limit_refusal')
             and p.prosrc ~* 'buy extra seats'), 0::bigint,
  'neither function tells anyone to buy extra seats');
select ok(not has_function_privilege('authenticated', 'private.over_limit_refusal(uuid, app.plan_limit_code)', 'execute'),
  'replacing the explanation left it closed to signed-in people');
select ok(not has_function_privilege('authenticated', 'private.assert_within_plan_limit(uuid, app.plan_limit_code, bigint)', 'execute'),
  'and the limit check too');

select * from finish();
rollback;
