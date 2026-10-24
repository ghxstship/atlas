-- pgTAP: migration 1592, the platform support refusal for the Access plan without the community forum (RRR-125; ADR
-- 0033 decision 73). An Access org's admin is refused with the same rule and a message that names the help center alone;
-- app.open_support_ticket keeps 0643's security definer, empty search_path and grants. The 0643 suite covers the rest of
-- the function against this definition.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(5);

select pg_temp.as_user('xavier');
select throws_ok($$select app.open_support_ticket(pg_temp.id('org_b'), 'Platform', 'Question', 'Plans', 'Which plan fits us?')$$,
  'XR001', 'support_plan_no_channel: The Access plan includes the help center; upgrade to contact platform support.',
  'an Access org is refused platform support with a message that names the help center only');
select lives_ok($$select app.open_support_ticket(pg_temp.id('org_b'), 'Organization', 'Question', 'Plans', 'Which plan fits us?')$$,
  'an Access org still asks its own admins');

select pg_temp.as_platform();
select ok((select prosrc not like '%forum%' and prosrc not like '%chat%' from pg_proc
  where oid = 'app.open_support_ticket(uuid, app.support_queue, app.support_category, text, text, app.support_severity, jsonb)'::regprocedure),
  'app.open_support_ticket offers neither the community forum nor in-app chat');
select ok((select prosecdef and proconfig = array['search_path=""'] from pg_proc
  where oid = 'app.open_support_ticket(uuid, app.support_queue, app.support_category, text, text, app.support_severity, jsonb)'::regprocedure),
  'app.open_support_ticket stays security definer with an empty search_path');
select ok(
  not has_function_privilege('anon', 'app.open_support_ticket(uuid, app.support_queue, app.support_category, text, text, app.support_severity, jsonb)', 'execute')
  and has_function_privilege('authenticated', 'app.open_support_ticket(uuid, app.support_queue, app.support_category, text, text, app.support_severity, jsonb)', 'execute')
  and has_function_privilege('service_role', 'app.open_support_ticket(uuid, app.support_queue, app.support_category, text, text, app.support_severity, jsonb)', 'execute'),
  'app.open_support_ticket keeps its grants: signed-in callers and the service role, never anon');

select * from finish();
rollback;
