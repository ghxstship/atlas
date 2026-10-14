-- pgTAP: settings persistence (RRR-73): legal acceptances, the settings registry with scope precedence and the
-- org lock, personal settings, brand, domains, module switches, favorites and the public brand lookups.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(80);

create function pg_temp.as_service() returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
end $$;

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- Test settings, declared the way contributor migrations declare theirs.
select private.define_setting('test.org_text', 'Text', 'org.general.write', array['organization', 'workspace'], true,
  p_default_text => 'Platform', p_max_length => 20);
select private.define_setting('test.choice', 'Choice', 'org.localization.write', array['organization', 'personal'], true,
  p_default_text => 'Comfortable', p_choices => array['Compact', 'Comfortable']);
select private.define_setting('test.count', 'Integer', 'org.general.write', array['organization', 'project'], false,
  p_default_integer => 5, p_min_integer => 1, p_max_integer => 10);
select private.define_setting('test.personal_only', 'Boolean', 'me.preferences.write', array['personal'], false,
  p_default_boolean => false);
select throws_ok($$select private.define_setting('test.bad', 'Choice', 'org.general.write', array['organization'])$$,
  '22023', null, 'a choice setting needs its choices');
select throws_ok($$select private.define_setting('test.bad', 'Text', 'org.general.write', array['galaxy'])$$,
  '22023', null, 'scopes come from the closed list');

-- Legal acceptances ---------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select is(app.record_legal_acceptances(pg_temp.id('org_a'), array['terms-of-service', 'data-processing-agreement'],
  array['1.0.0', '1.0.0'], '203.0.113.7'), 2, 'an Owner records the signup acceptances for the org');
select is((select count(*)::integer from app.legal_acceptances where org_id = pg_temp.id('org_a') and ip = '203.0.113.7'::inet
  and user_id = pg_temp.id('alice_user') and person_id = pg_temp.id('alice')), 2, 'each acceptance keeps person, sign-in and IP');
select ok((select bool_and(accepted_at = now()) from app.legal_acceptances), 'acceptance time is the database time');
select throws_ok($$select app.record_legal_acceptances(pg_temp.id('org_a'), array['terms-of-service'], array['1.0.0', '1.0.1'])$$,
  'XR001', null, 'each document needs exactly one version');
select throws_ok($$select app.record_legal_acceptances(pg_temp.id('org_a'), array['terms-of-service'], array['version one'])$$,
  '23514', null, 'versions are semantic versions');
select pg_temp.as_user('dave');
select throws_ok($$select app.record_legal_acceptances(pg_temp.id('org_a'), array['terms-of-service'], array['1.0.0'])$$,
  '42501', null, 'a Member cannot accept on behalf of the org');
select is(app.record_legal_acceptances(null, array['worker-terms'], array['1.0.0']), 1, 'anyone records a personal acceptance');
select throws_ok($$insert into app.legal_acceptances (person_id, user_id, document_slug, document_version)
  values (pg_temp.id('dave'), pg_temp.id('dave_user'), 'terms-of-service', '9.9.9')$$, '42501', null,
  'acceptances are written only through the RPC');
select is((select count(*)::integer from app.legal_acceptances), 1, 'a Member reads only their own acceptances');
select pg_temp.as_user('bob');
select is((select count(*)::integer from app.legal_acceptances), 0, 'an Admin does not read the org''s legal acceptances');
select pg_temp.as_user('alice');
select is((select count(*)::integer from app.legal_acceptances), 2, 'the Owner reads the org''s acceptances, not a member''s personal ones');
select is((select document_version from app.current_legal_acceptances where document_slug = 'terms-of-service'), '1.0.0',
  'the current acceptance view gives the latest version');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.legal_acceptances), 0, 'another org''s Owner reads none');
select pg_temp.as_platform();
select throws_ok($$update app.legal_acceptances set document_version = '2.0.0'$$, 'XR001', null, 'acceptances are append-only');
select throws_ok($$delete from app.legal_acceptances$$, 'XR001', null, 'acceptances are never deleted');
select is((select count(*)::integer from app.domain_events where event_type = 'legal.accepted' and org_id = pg_temp.id('org_a')), 2,
  'org acceptances emit legal.accepted');
select pg_temp.as_anon();
select throws_ok($$select app.record_legal_acceptances(null, array['worker-terms'], array['1.0.0'])$$, '42501', null,
  'anon cannot record acceptances');

-- Shared-scope settings -------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select lives_ok($$select app.set_setting(pg_temp.id('org_a'), 'test.org_text', 'Organization', null, p_value_text => 'Northwind')$$,
  'an Admin sets an org setting');
select is((select value_text from app.setting_values where setting_key = 'test.org_text'), 'Northwind', 'the value is stored');
select lives_ok($$select app.set_setting(pg_temp.id('org_a'), 'test.org_text', 'Organization', null, p_value_text => 'Northwind Live')$$,
  'setting again updates the value in place');
select is((select count(*)::integer from app.setting_values where setting_key = 'test.org_text'), 1, 'one live value per scope');
select throws_ok($$select app.set_setting(pg_temp.id('org_a'), 'test.org_text', 'Organization', null, p_value_boolean => true)$$,
  'XR001', null, 'a value goes in the column of its type');
select throws_ok($$select app.set_setting(pg_temp.id('org_a'), 'test.org_text', 'Organization', null, p_value_text => repeat('x', 21))$$,
  'XR001', null, 'text values respect the length limit');
select throws_ok($$select app.set_setting(pg_temp.id('org_a'), 'test.choice', 'Organization', null, p_value_text => 'Spacious')$$,
  'XR001', null, 'a choice value must be listed');
select throws_ok($$select app.set_setting(pg_temp.id('org_a'), 'test.count', 'Organization', null, p_value_integer => 11)$$,
  'XR001', null, 'integer values respect the range');
select throws_ok($$select app.set_setting(pg_temp.id('org_a'), 'test.org_text', 'Team', pg_temp.id('team_a'), p_value_text => 'Crew')$$,
  'XR001', null, 'a setting is stored only at the scopes it allows');
select throws_ok($$select app.set_setting(pg_temp.id('org_a'), 'test.personal_only', 'Organization', null, p_value_boolean => true)$$,
  '42501', null, 'a personal-only setting has no org value the Admin can write');
select throws_ok($$select app.set_setting(pg_temp.id('org_a'), 'test.org_text', 'Workspace', pg_temp.id('ws_b'), p_value_text => 'Harbor')$$,
  'XR001', null, 'a scope from another org is refused');
select throws_ok($$select app.set_setting(pg_temp.id('org_a'), 'test.count', 'Organization', null, p_value_integer => 3, p_locked => true)$$,
  'XR001', null, 'only lockable settings lock');
select throws_ok($$insert into app.setting_values (org_id, setting_key, scope_kind, scope_id, value_text)
  values (pg_temp.id('org_a'), 'test.unknown', 'Organization', pg_temp.id('org_a'), 'x')$$, 'XR001', null,
  'an unregistered setting is refused');
select lives_ok($$select app.set_setting(pg_temp.id('org_a'), 'test.org_text', 'Workspace', pg_temp.id('ws_a'), p_value_text => 'East')$$,
  'a workspace overrides an unlocked org value');
select is((select value_text || '/' || source from app.resolve_settings(pg_temp.id('org_a'), p_workspace_id => pg_temp.id('ws_a'))
  where setting_key = 'test.org_text'), 'East/Workspace', 'the workspace value wins inside the workspace');
select is((select value_text || '/' || source from app.resolve_settings(pg_temp.id('org_a')) where setting_key = 'test.org_text'),
  'Northwind Live/Organization', 'outside the workspace the org value applies');
select is((select value_integer || '/' || source from app.resolve_settings(pg_temp.id('org_a')) where setting_key = 'test.count'),
  '5/Default', 'an unset setting resolves to the platform default');
select lives_ok($$select app.set_setting(pg_temp.id('org_a'), 'test.org_text', 'Organization', null, p_value_text => 'Locked', p_locked => true)$$,
  'the org locks a lockable value');
select is((select value_text || '/' || source || '/' || locked from app.resolve_settings(pg_temp.id('org_a'), p_workspace_id => pg_temp.id('ws_a'))
  where setting_key = 'test.org_text'), 'Locked/Organization/true', 'a locked org value wins over the workspace');
select throws_ok($$select app.set_setting(pg_temp.id('org_a'), 'test.org_text', 'Workspace', pg_temp.id('ws_a'), p_value_text => 'Again')$$,
  'XR001', null, 'a locked value refuses lower-scope overrides');
select pg_temp.as_user('dave');
select throws_ok($$select app.set_setting(pg_temp.id('org_a'), 'test.org_text', 'Organization', null, p_value_text => 'Mine')$$,
  '42501', null, 'a Member without the capability cannot set org settings');
select is((select count(*)::integer from app.setting_values), 2, 'members read the org''s setting values');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.setting_values), 0, 'another org reads none of them');
select throws_ok($$select app.set_setting(pg_temp.id('org_a'), 'test.org_text', 'Organization', null, p_value_text => 'Harbor')$$,
  '42501', null, 'another org cannot write them');
select pg_temp.as_user('bob');
select ok(app.clear_setting(pg_temp.id('org_a'), 'test.org_text', 'Workspace', pg_temp.id('ws_a')), 'clearing a value returns true');
select pg_temp.as_platform();
select is((select count(*)::integer from app.domain_events where event_type = 'setting.changed' and org_id = pg_temp.id('org_a')), 5,
  'each set, lock and clear emits setting.changed');
select ok((select count(*) from app.audit_events where org_id = pg_temp.id('org_a') and subject_table in ('setting_values', 'app.setting_values')) >= 5,
  'setting changes land in the audit ledger');
select pg_temp.as_anon();
select throws_ok($$select * from app.resolve_settings(pg_temp.id('org_a'))$$, '42501', null, 'anon cannot resolve settings');

-- Personal settings -------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select lives_ok($$select app.set_personal_setting('test.choice', p_value_text => 'Compact')$$, 'a person sets their own setting');
select is((select value_text || '/' || source from app.resolve_settings(pg_temp.id('org_a')) where setting_key = 'test.choice'),
  'Compact/Personal', 'the personal value wins over the default');
select throws_ok($$select app.set_personal_setting('test.count', p_value_integer => 2)$$, 'XR001', null,
  'settings that do not allow personal values are refused');
select throws_ok($$select app.set_personal_setting('test.choice', pg_temp.id('org_b'), 'Compact')$$, 'XR001', null,
  'a per-org value needs a membership there');
select lives_ok($$select app.set_personal_setting('test.personal_only', p_value_boolean => true)$$, 'personal-only settings are set per person');
select pg_temp.as_user('gina');
select is((select count(*)::integer from app.personal_setting_values), 0, 'nobody else reads a person''s settings');
select throws_ok($$insert into app.personal_setting_values (person_id, setting_key, value_boolean)
  values (pg_temp.id('dave'), 'test.personal_only', false)$$, '42501', null, 'nobody else writes them');
select pg_temp.as_user('bob');
select lives_ok($$select app.set_setting(pg_temp.id('org_a'), 'test.choice', 'Organization', null, p_value_text => 'Comfortable', p_locked => true)$$,
  'the org locks the choice');
select pg_temp.as_user('dave');
select is((select value_text || '/' || source from app.resolve_settings(pg_temp.id('org_a')) where setting_key = 'test.choice'),
  'Comfortable/Organization', 'a locked org value wins over the personal value');
select throws_ok($$select app.set_personal_setting('test.choice', pg_temp.id('org_a'), 'Compact')$$, 'XR001', null,
  'a locked org value refuses a per-org personal value');

-- Brand -----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$insert into app.org_brands (org_id, accent_hex) values (pg_temp.id('org_a'), '#2F6FEB')$$, '42501', null,
  'a Member cannot edit the brand');
select pg_temp.as_user('bob');
select lives_ok($$insert into app.org_brands (org_id, display_name, accent_hex, suppress_powered_by, logo_light_path)
  values (pg_temp.id('org_a'), 'Northwind', '#2F6FEB', true, pg_temp.id('org_a') || '/logo-light.svg')$$,
  'an Admin on the Team plan saves a brand that hides Powered by XOS');
select throws_ok($$update app.org_brands set accent_hex = '#2f6feb'$$, '23514', null, 'accents are stored as uppercase hex');
select pg_temp.as_user('xavier');
select throws_ok($$insert into app.org_brands (org_id, suppress_powered_by) values (pg_temp.id('org_b'), true)$$, 'XR001', null,
  'hiding Powered by XOS needs the white label plan feature');
select pg_temp.as_anon();
select is((select name || '/' || accent_hex || '/' || suppress_powered_by from api_public.org_brand_for_slug('northwind-live')),
  'Northwind/#2F6FEB/true', 'anon reads the public brand by slug');
select is((select name || '/' || suppress_powered_by from api_public.org_brand_for_slug('harbor-lights')),
  'Harbor Lights Productions/false', 'an org without a brand falls back to its name');
select pg_temp.as_platform();
update app.subscriptions set plan_code = 'core' where org_id = pg_temp.id('org_a');
select pg_temp.as_anon();
select is((select suppress_powered_by from api_public.org_brand_for_slug('northwind-live')), false,
  'after a downgrade below white label Powered by XOS shows again');
select pg_temp.as_platform();
update app.subscriptions set plan_code = 'team' where org_id = pg_temp.id('org_a');

-- Domains ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
insert into app.org_domains (org_id, hostname, purpose, verification_state, verified_at)
values (pg_temp.id('org_a'), 'gateway.northwind.test', 'Gateway', 'Verified', now());
insert into k select 'domain', id from app.org_domains where hostname = 'gateway.northwind.test';
select is((select verification_state::text from app.org_domains where id = (select id from k where key = 'domain')), 'Pending',
  'a new domain starts Pending whatever the caller sends');
select throws_ok($$update app.org_domains set verification_state = 'Verified', verified_at = now()$$, 'XR001', null,
  'only the verification service records verification');
select throws_ok($$insert into app.org_domains (org_id, hostname, purpose, auto_join_role_id)
  values (pg_temp.id('org_a'), 'northwind.test', 'Verified Domain', pg_temp.system_role('admin'))$$, 'XR001', null,
  'automatic join never grants Admin');
select pg_temp.as_user('xavier');
select throws_ok($$insert into app.org_domains (org_id, hostname, purpose) values (pg_temp.id('org_b'), 'gateway.harbor.test', 'Gateway')$$,
  'XR001', null, 'custom domains need the custom domain plan feature');
select pg_temp.as_user('bob');
select throws_ok($$select app.record_domain_verification((select id from k where key = 'domain'), true)$$, '42501', null,
  'members cannot call the verification service');
select pg_temp.as_anon();
select is((select count(*)::integer from api_public.org_brand_for_host('gateway.northwind.test')), 0,
  'an unverified host serves no brand');
select pg_temp.as_service();
select is(app.record_domain_verification((select id from k where key = 'domain'), true)::text, 'Verified',
  'the verification service verifies the domain');
select pg_temp.as_anon();
select is((select org_slug || '/' || surface from api_public.org_brand_for_host('Gateway.Northwind.test')), 'northwind-live/Gateway',
  'a verified host resolves to the org brand and surface');
select pg_temp.as_platform();
select is((select count(*)::integer from app.domain_events where event_type in ('organization.domain_added', 'organization.domain_verified')
  and org_id = pg_temp.id('org_a')), 2, 'adding and verifying a domain emit events');

-- Modules and favorites -------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select lives_ok($$select app.set_module_enabled(pg_temp.id('org_a'), 'hospitality', false)$$, 'an Admin turns Hospitality off');
select throws_ok($$select app.set_module_enabled(pg_temp.id('org_a'), 'home', false)$$, 'XR001', null, 'Home cannot be turned off');
select pg_temp.as_user('dave');
select is((select enabled from app.org_module_states where module_code = 'hospitality'), false, 'members read module switches');
select throws_ok($$select app.set_module_enabled(pg_temp.id('org_a'), 'hospitality', true)$$, '42501', null,
  'a Member cannot switch modules');
insert into app.favorites (org_id, person_id, node_id) values (pg_temp.id('org_a'), pg_temp.id('dave'), 'finance.budgets');
select pg_temp.as_user('gina');
select is((select count(*)::integer from app.favorites), 0, 'favorites are private to their person');
select pg_temp.as_platform();
insert into app.favorites (org_id, person_id, node_id, sort_order)
select pg_temp.id('org_a'), pg_temp.id('dave'), 'records.r' || g, g from generate_series(1, 49) g;
select pg_temp.as_user('dave');
select throws_ok($$insert into app.favorites (org_id, person_id, node_id) values (pg_temp.id('org_a'), pg_temp.id('dave'), 'schedule')$$,
  'XR001', null, 'a person keeps at most 50 favorites per org');

select pg_temp.as_platform();
select is((select count(*)::integer from private.retention_policies where table_name in ('app.legal_acceptances', 'app.setting_values',
  'app.personal_setting_values', 'app.org_brands', 'app.org_domains', 'app.org_module_states', 'app.favorites')), 7,
  'every new table has a retention policy');

select * from finish();
rollback;
