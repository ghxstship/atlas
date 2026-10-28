-- pgTAP: A22 security catalog checks (RRR-41, Section 9, ADR 0002, ADR 0016, ADR 0019).
-- Every assertion is generated from the system catalog, so a new table, view, function or policy
-- is checked the moment its migration lands. An allowlist names every reviewed exception; adding
-- to it is a security review decision recorded in legal/security/threat-model.md.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(17);

-- Tables without RLS --------------------------------------------------------------------------------------------
select is_empty($$
  select c.oid::regclass::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('app', 'private', 'xpms', 'api_public', 'api_external')
    and c.relkind in ('r', 'p') and not c.relrowsecurity
$$, 'every table in app, private, xpms, api_public and api_external has row level security on');

select is_empty($$
  select c.oid::regclass::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app' and c.relkind in ('r', 'p') and not c.relispartition
    and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
$$, 'every app table has at least one policy, so RLS never fails open by accident of grants');

-- Policies -------------------------------------------------------------------------------------------------------
select set_eq($$
  select tablename::text from pg_policies
  where schemaname in ('app', 'private') and (qual = 'true' or with_check = 'true')
$$, $$values ('capabilities'), ('capability_modules'), ('plans'), ('subscription_state_transition_rules')$$,
  'only the four global reference tables in app carry a policy of plain true');

select is_empty($$
  select schemaname || '.' || tablename || ' ' || policyname from pg_policies
  where schemaname in ('app', 'private', 'xpms', 'api_public', 'api_external')
    and (roles @> '{anon}' or roles @> '{public}')
$$, 'no policy on a tenant, canon or projection table applies to anon or public');

select is_empty($$
  select schemaname || '.' || tablename || ' ' || policyname from pg_policies
  where schemaname = 'xpms' and cmd <> 'SELECT'
$$, 'canon is read-only to every signed-in role: xpms has only SELECT policies');

-- Schema and object privileges -------------------------------------------------------------------------------------
select is_empty($$
  select n.nspname || ' ' || r.rolname from pg_namespace n cross join pg_roles r
  where r.rolname = 'anon' and n.nspname in ('app', 'private', 'xpms', 'api_external', 'vault')
    and has_schema_privilege(r.oid, n.oid, 'USAGE')
$$, 'anon has no USAGE on app, private, xpms, api_external or vault');

select is_empty($$
  select n.nspname || ' ' || r.rolname from pg_namespace n cross join pg_roles r
  where r.rolname = 'authenticated' and n.nspname in ('private', 'vault')
    and has_schema_privilege(r.oid, n.oid, 'USAGE')
$$, 'authenticated has no USAGE on private or vault');

select is_empty($$
  select table_schema || '.' || table_name || ' ' || grantee || ' ' || privilege_type
  from information_schema.role_table_grants
  where table_schema = 'private' and grantee in ('anon', 'authenticated', 'PUBLIC')
$$, 'no table or view in private is granted to anon, authenticated or public');

-- SECURITY DEFINER functions ----------------------------------------------------------------------------------------
select is_empty($$
  select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('app', 'private', 'xpms', 'api_public', 'api_external')
    and p.prokind in ('f', 'p')
    and not coalesce('search_path=""' = any(p.proconfig) or 'search_path=' = any(p.proconfig), false)
$$, 'every function in our schemas pins search_path to empty (ADR 0002)');

select set_eq($$
  select p.proname::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where p.prosecdef and n.nspname in ('app', 'private', 'xpms', 'api_public', 'api_external', 'public')
    and has_function_privilege('anon', p.oid, 'EXECUTE')
    and has_schema_privilege('anon', n.oid, 'USAGE')
$$, $$values ('active_system_banners'), ('calendar_feed'), ('client_minimum_version'), ('confirm_subprocessor_notices'), ('org_brand_for_host'), ('org_brand_for_slug'), ('open_share_link'),
  ('organization_profile'), ('organization_profile_details'), ('person_profile'), ('person_profile_certifications'), ('person_profile_languages'),
  ('person_profile_links'), ('person_profile_organizations'), ('person_profile_portfolio'), ('person_profile_references'),
  ('person_profile_skills'), ('preview_advance'), ('read_agreement'), ('record_cookie_consent'), ('sign_agreement'),
  ('invite_token_open'),
  ('submit_advance'), ('subscribe_subprocessor_notices'), ('token_document'), ('token_sign_document'),
  ('unsubscribe_subprocessor_notices'), ('verify_certification')$$,
  'anon reaches exactly the reviewed api_public token, profile and consent RPCs');

select is_empty($$
  select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'api_public' and not p.prosecdef
$$, 'every api_public RPC is SECURITY DEFINER, so anon never needs a grant on an app table');

select is_empty($$
  select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'app' and p.proname in ('exchange_api_key', 'read_integration_credential', 'read_integration_inbound_secret',
      'read_warehouse_credential', 'warehouse_table_rows')
    and (has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE'))
$$, 'the key exchange, the Vault credential and webhook secret readers and the warehouse row reader run only for the service role (ADR 0024, 1400, 1401)');

-- Views ------------------------------------------------------------------------------------------------------------
select set_eq($$
  select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('v', 'm') and n.nspname = 'app'
    and not coalesce(c.reloptions::text[] && array['security_invoker=true', 'security_invoker=on'], false)
$$, $$values ('ai_never_send'), ('application_board'), ('bid_totals'), ('brand_fonts'), ('column_classifications'),
  ('comment_subjects'), ('consent_purposes'), ('currencies'), ('custom_field_targets'), ('domain_event_catalog'), ('email_templates'),
  ('employment_statuses'), ('engagement_board'), ('engagement_resolved'), ('expense_budget_lines'), ('feature_flags'), ('flsa_statuses'),
  ('import_target_fields'), ('import_targets'), ('integration_providers'), ('lifecycle_transition_rules'),
  ('measurement_metric_tags'), ('measurement_metrics'), ('measurement_units'), ('medical_encounters_masked'), ('notification_categories'), ('notification_templates'), ('offboarding_open_records'),
  ('onboarding_item_status'), ('opportunity_position_counts'), ('org_legal_entities_masked'), ('pay_rates_masked'), ('pay_transparency_rules'),
  ('payroll_line_amounts'), ('rate_card_lines_masked'), ('report_sources'), ('retention_policies'), ('roster_entry_people'),
  ('separation_of_duties_rules'), ('setting_choices'), ('setting_definitions'), ('shared_certifications'),
  ('sync_rpcs'), ('vendor_bank_accounts_masked'), ('warehouse_providers')$$,
  'every owner-rights view in app is a reviewed reference, masking or self-filtering view');

select is_empty($$
  select c.oid::regclass::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('v', 'm') and n.nspname in ('api_external', 'app', 'xpms')
    and has_table_privilege('anon', c.oid, 'SELECT')
$$, 'anon can select no view in app, xpms or api_external');

select is_empty($$
  select c.oid::regclass::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('v', 'm') and n.nspname = 'api_external'
    and (has_table_privilege('authenticated', c.oid, 'INSERT') or has_table_privilege('authenticated', c.oid, 'UPDATE')
      or has_table_privilege('authenticated', c.oid, 'DELETE'))
$$, 'api_external projections are read-only (ADR 0019)');

-- Field masking -----------------------------------------------------------------------------------------------------
select is_empty($$
  select c.table_name || '.' || c.column_name from private.column_classifications c
  where c.classification = 'Restricted'
    and has_column_privilege('authenticated', c.table_name::regclass, c.column_name, 'SELECT')
$$, 'no Restricted column is directly selectable by authenticated (Section 8.3, ADR 0016 item 10)');

-- Refusal SQLSTATE -------------------------------------------------------------------------------------------------
select is_empty($$
  select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('app', 'private', 'api_public', 'api_external', 'xpms')
    and p.prosrc ~* 'raise\s+exception\s+''' and p.prosrc !~* 'errcode'
$$, 'no function raises a bare exception: refusals use XR001 through private.refuse, authorization uses 42501');

select * from finish();
rollback;
