-- pgTAP: migration 1471, tenant search, plan overrides and feature flags in the operator console (A90, RRR-135,
-- finding A65-009). Operators find orgs by name, slug, Owner email and plan and read one org's billing facts; an
-- Administrator's plan overrides (plan, feature, limit) drive every limit and feature check until they expire or
-- end, with a reason; Support sets per-org flag overrides with an expiry; the kill switch wins over all of it.
-- Every change lands in the console ledger and, with the operator as the actor, in the tenant's audit ledger.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(37);

create function pg_temp.as_op(p_key text) returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.id(p_key || '_user'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

select pg_temp.new_user('olga', 'olga@platform.test', 'Olga Brandt');
select pg_temp.new_user('omar', 'omar@platform.test', 'Omar Haddad');
select pg_temp.as_platform();
select private.grant_platform_operator('olga@platform.test', 'Administrator', 'First platform administrator.');
select private.grant_platform_operator('omar@platform.test', 'Support', 'Support on call.');

-- Tenant search ---------------------------------------------------------------------------------------------------------
select pg_temp.as_op('nina');
select throws_ok($$select * from app.console_search_orgs('northwind')$$, '42501', null, 'search is for the platform team');
select pg_temp.as_op('omar');
select is((select slug || ' ' || plan_code || ' ' || owner_email from app.console_search_orgs('Northwind')), 'northwind-live team alice@northwind.test',
  'Support finds an org by name, with its plan in force and its Owner');
select is((select slug from app.console_search_orgs('xavier@harbor')), 'harbor-lights', 'by its Owner''s email');
select is((select slug from app.console_search_orgs('tidewater-ev')), 'tidewater-events', 'by its slug');
select ok((select bool_and(plan_code = 'access') and count(*) > 0 from app.console_search_orgs(null, 'access')),
  'and filters by the plan in force');
select is((select count(*)::int from app.console_search_orgs('%')), 0, 'a percent sign is matched literally, never as a wildcard');
select throws_ok($$select * from app.console_search_orgs(null, 'platinum')$$, 'XR001', null, 'an unknown plan is refused');
select ok((select count(*) >= 5 from app.platform_operator_actions where action = 'organization.searched'
  and operator_person_id = pg_temp.id('omar')), 'each search is logged with the operator');

-- Org detail -----------------------------------------------------------------------------------------------------------
select is((select app.console_org_detail(pg_temp.id('org_a')) #>> '{plan,plan_code}'), 'team', 'the detail names the plan in force');
select is((select app.console_org_detail(pg_temp.id('org_a')) #>> '{owners,0,email}'), 'alice@northwind.test', 'and the Owners');
select ok((select jsonb_array_length(app.console_org_detail(pg_temp.id('org_a')) -> 'flags') >= 6), 'and every flag');
select is((select (app.console_org_detail(pg_temp.id('org_a')) #>> '{usage,seats}')::int > 0), true, 'and seat usage');
select is((select count(*)::int from app.platform_operator_actions where action = 'organization.viewed'
  and target_org_id = pg_temp.id('org_a')), 4, 'each view is logged against the org');
select throws_ok(format('select app.console_org_detail(%L)', gen_random_uuid()), '42501', null, 'an unknown org is not found');

-- Plan overrides --------------------------------------------------------------------------------------------------------
select throws_ok(format($$select app.console_set_plan_override(%L, 'Plan', 'pro', null, null, null, null, 'Pilot.', now() + interval '30 days')$$,
  pg_temp.id('org_b')), '42501', null, 'Support cannot override a plan');
select pg_temp.as_op('olga');
select isnt(app.console_set_plan_override(pg_temp.id('org_b'), 'Plan', 'pro', null, null, null, null,
  'Pilot of the Pro plan for the festival season.', now() + interval '30 days'), null, 'an Administrator holds an org to Pro');
select pg_temp.as_platform();
select is((select distinct plan_code from private.org_plan_limits where org_id = pg_temp.id('org_b')), 'pro',
  'the plan in force follows the override');
select is(private.org_has_feature(pg_temp.id('org_b'), 'api_keys'), true, 'and so do the plan''s features');
select is(private.plan_limit(pg_temp.id('org_b'), 'seats'), 15::bigint, 'and its limits');
select pg_temp.as_op('olga');
select isnt(app.console_set_plan_override(pg_temp.id('org_b'), 'Feature', null, 'api_keys', false, null, null,
  'API keys stay off until the security review.', now() + interval '30 days'), null, 'a Feature override turns one feature off');
select isnt(app.console_set_plan_override(pg_temp.id('org_b'), 'Limit', null, null, null, 'active_projects', 50,
  'Fifty projects for the festival season.', now() + interval '30 days'), null, 'a Limit override sets one limit');
select pg_temp.as_platform();
select is(private.org_has_feature(pg_temp.id('org_b'), 'api_keys'), false, 'the Feature override wins over the plan');
select is(private.plan_limit(pg_temp.id('org_b'), 'active_projects'), 50::bigint, 'and the Limit override replaces the limit');
select pg_temp.as_op('olga');
select app.console_set_plan_override(pg_temp.id('org_b'), 'Plan', 'team', null, null, null, null, 'Team for the tour.',
  now() + interval '60 days');
select pg_temp.as_platform();
insert into world select 'team_override', id from app.plan_overrides
  where org_id = pg_temp.id('org_b') and override_kind = 'Plan' and ended_at is null;
select is((select count(*)::int from app.plan_overrides where org_id = pg_temp.id('org_b') and override_kind = 'Plan'
  and ended_at is null), 1, 'a newer Plan override replaces the live one');
select is((select end_reason from app.plan_overrides where org_id = pg_temp.id('org_b') and plan_code = 'pro'),
  'Replaced by a newer override.', 'and says so');
select pg_temp.as_op('olga');
select throws_ok(format($$select app.console_set_plan_override(%L, 'Plan', 'pro', null, null, null, null, 'Two years.', now() + interval '2 years')$$,
  pg_temp.id('org_b')), 'XR001', 'plan_override_expiry: An override ends within a year: choose an expiry after now and at most a year away.',
  'an override ends within a year');
select throws_ok(format($$select app.console_set_plan_override(%L, 'Plan', 'pro', null, null, null, null, ' ', now() + interval '2 days')$$,
  pg_temp.id('org_b')), 'XR001', null, 'and has a reason');
select lives_ok(format('select app.console_end_plan_override(%L, %L)', pg_temp.id('team_override'), 'The tour was canceled.'),
  'an Administrator ends an override early');
select pg_temp.as_platform();
select is((select distinct plan_code from private.org_plan_limits where org_id = pg_temp.id('org_b')), 'access',
  'and the subscription''s plan applies again');
select throws_ok(format($$update app.plan_overrides set reason = 'Edited.' where org_id = %L$$, pg_temp.id('org_b')),
  'XR001', null, 'an override keeps its reason (plan_override_immutable)');
select is((select count(*)::int from app.audit_events where org_id = pg_temp.id('org_b') and action = 'plan_overrides.insert'
  and actor_person_id = pg_temp.id('olga')), 4, 'each override lands in the tenant''s audit ledger with the operator');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.plan_overrides), 4, 'the org''s Owner reads its overrides');
select pg_temp.as_user('mia');
select is((select count(*)::int from app.plan_overrides), 0, 'a Viewer does not');

-- Feature flags ----------------------------------------------------------------------------------------------------------
select pg_temp.as_op('omar');
select throws_ok(format($$select app.console_set_flag_override(%L, 'imports.ai_mapping', true, 'Pilot.', null)$$, pg_temp.id('org_a')),
  'XR001', null, 'a flag override needs an expiry (flag_override_expiry)');
select app.console_set_flag_override(pg_temp.id('org_a'), 'imports.ai_mapping', true, 'Pilot of AI mapping.', now() + interval '14 days');
select pg_temp.as_platform();
select is(private.flag_enabled(pg_temp.id('org_a'), 'imports.ai_mapping'), true, 'Support turns a flag on for one org');
select pg_temp.as_op('omar');
select throws_ok($$select app.console_set_kill_switch('imports.ai_mapping', true, 'Incident.')$$, '42501', null,
  'only an Administrator holds the kill switch');
select pg_temp.as_op('olga');
select app.console_set_kill_switch('imports.ai_mapping', true, 'Mapping suggestions were wrong; off everywhere.');
select pg_temp.as_platform();
select is(private.flag_enabled(pg_temp.id('org_a'), 'imports.ai_mapping'), false, 'the kill switch wins over the override');

select * from finish();
rollback;
