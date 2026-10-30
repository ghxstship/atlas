-- remove-demo-data.sql
-- RRR-109 (ADR 0033 decision 1, amendment of 2026-10-19). Removes the demo seed and everything that hangs
-- off it from the database being promoted to production, in one transaction, and proves the result.
--
-- Run it only through infra/production/remove-demo-data.sh, which picks the mode and the connection:
--   psql -v mode=dry-run   reports, per table, how many rows would be deleted; deletes nothing
--   psql -v mode=rehearse  deletes, verifies, prints the report and rolls back
--   psql -v mode=execute   deletes, verifies and commits only when every check passes
--
-- What counts as demo data is derived, never listed by hand:
--   1. Markers read out of the repository's test-data sources, supabase/seeds/*.sql and the load-test
--      fixtures in packages/testing/load/fixtures (the generated block below): every fixed id in the seed
--      namespace and the email domains they use (example.com and load.example.test, reserved domains).
--   2. Roots: rows whose id is a seed id, auth users whose id is a seed id or whose email is on a seed
--      domain, and the people of those users.
--   3. Closure, repeated until nothing new is found:
--        * every row whose org_id is a marked org
--        * every row that references a marked row through a foreign key that would block or cascade the
--          delete (ON DELETE NO ACTION, RESTRICT or CASCADE); SET NULL references are left to the database
--        * every org whose members are all demo people
--      so an org a demo user created, its contents, and every row a demo person created are included.
-- Outside the tables: the demo orgs' storage objects (through the Storage API, by the wrapper) and the Vault
-- secrets of their integration connections (xos_integration_<connection id>), the inbound webhook secrets of those
-- connections (xos_integration_inbound_<connection id>, 1400) and the bucket credentials of their warehouse
-- destinations (xos_warehouse_<destination id>, 1401) go too.
-- What stays: every row the closure does not reach. Canon (xpms), the plan, capability, role and settings
-- registries, reference data, storage buckets, cron jobs and the migration-created Vault keys carry no demo
-- org or person and are never touched. The script refuses to run when the closure reaches xpms or migration history, and
-- refuses to commit when it would delete a row of an org that is not itself being removed.
--
-- Guards. Tenant tables refuse hard deletes in several places (append-only ledgers, the audit ledger, the
-- sole-Owner rule, retained Canceled records). The schema's sanctioned path is the tenant purge of
-- migration 1270: private.begin_tenant_purge(org ids) marks this transaction as purging those orgs; the
-- guards then let deletes of their rows through and the audit trigger does not write audit rows for them. Nothing is disabled: every trigger and foreign key stays on, and the marker
-- ends with the transaction.
--
-- Storage objects cannot be deleted in SQL (storage.protect_objects_delete); the wrapper removes the
-- demo orgs' objects through the Storage API first, and this script verifies that none remain.

\set ON_ERROR_STOP on
\pset footer off

\if :{?mode}
\else
  \set mode missing
\endif
select set_config('xos.demo_removal_mode', :'mode', false) as mode \gset

do $$
begin
  if current_setting('xos.demo_removal_mode') not in ('dry-run', 'rehearse', 'execute') then
    raise exception 'Pass -v mode=dry-run, rehearse or execute (got %).', current_setting('xos.demo_removal_mode');
  end if;
end;
$$;

begin;
set local lock_timeout = '15s';
set local statement_timeout = 0;
set local search_path = pg_catalog, public;
set local client_min_messages = warning;

-- Markers ---------------------------------------------------------------------------------------------------

create temp table demo_seed_ids (id uuid primary key);
create temp table demo_email_domains (domain text primary key);
create temp table demo_seed_tables (table_name text primary key);

-- BEGIN GENERATED SEED MARKERS (infra/production/src/cli.ts generate)
-- Derived from 32 seed files: 244 fixed ids, 3 email domain(s), 242 seeded tables.
insert into pg_temp.demo_seed_ids (id) values
  ('01920000-0000-7000-8000-000000000001'::uuid),
  ('01920000-0000-7000-8000-000000000101'::uuid),
  ('01920000-0000-7000-8000-000000000102'::uuid),
  ('01920000-0000-7000-8000-000000000103'::uuid),
  ('01920000-0000-7000-8000-000000000104'::uuid),
  ('01920000-0000-7000-8000-000000000105'::uuid),
  ('01920000-0000-7000-8000-000000000106'::uuid),
  ('01920000-0000-7000-8000-000000000201'::uuid),
  ('01920000-0000-7000-8000-000000000301'::uuid),
  ('01920000-0000-7000-8000-000000000302'::uuid),
  ('01920000-0000-7000-8000-000000000401'::uuid),
  ('01920000-0000-7000-8000-000000000501'::uuid),
  ('01920000-0000-7000-8000-000000001001'::uuid),
  ('01920000-0000-7000-8000-00000000a101'::uuid),
  ('01920000-0000-7000-8000-00000000a102'::uuid),
  ('01920000-0000-7000-8000-00000000a103'::uuid),
  ('01920000-0000-7000-8000-00000000a104'::uuid),
  ('01920000-0000-7000-8000-00000000a105'::uuid),
  ('01920000-0000-7000-8000-00000000a106'::uuid),
  ('01920000-0000-7000-8000-00000000b301'::uuid),
  ('01920000-0000-7000-8000-000000010901'::uuid),
  ('01920000-0000-7000-8000-000000010902'::uuid),
  ('01920000-0000-7000-8000-000000010903'::uuid),
  ('01920000-0000-7000-8000-000000010911'::uuid),
  ('01920000-0000-7000-8000-000000010912'::uuid),
  ('01920000-0000-7000-8000-000000010913'::uuid),
  ('01920000-0000-7000-8000-000000010921'::uuid),
  ('01920000-0000-7000-8000-000000010922'::uuid),
  ('01920000-0000-7000-8000-000000010923'::uuid),
  ('01920000-0000-7000-8000-000000010924'::uuid),
  ('01920000-0000-7000-8000-000000010931'::uuid),
  ('01920000-0000-7000-8000-000000010941'::uuid),
  ('01920000-0000-7000-8000-000000010942'::uuid),
  ('01920000-0000-7000-8000-000000011001'::uuid),
  ('01920000-0000-7000-8000-000000011002'::uuid),
  ('01920000-0000-7000-8000-000000011011'::uuid),
  ('01920000-0000-7000-8000-000000011012'::uuid),
  ('01920000-0000-7000-8000-000000011013'::uuid),
  ('01920000-0000-7000-8000-000000011014'::uuid),
  ('01920000-0000-7000-8000-000000011021'::uuid),
  ('01920000-0000-7000-8000-000000011022'::uuid),
  ('01920000-0000-7000-8000-000000011031'::uuid),
  ('01920000-0000-7000-8000-000000011032'::uuid),
  ('01920000-0000-7000-8000-000000022501'::uuid),
  ('01920000-0000-7000-8000-000000022511'::uuid),
  ('01920000-0000-7000-8000-000000022512'::uuid),
  ('01920000-0000-7000-8000-000000022521'::uuid),
  ('01920000-0000-7000-8000-000000022522'::uuid),
  ('01920000-0000-7000-8000-000000022531'::uuid),
  ('01920000-0000-7000-8000-000000022541'::uuid),
  ('01920000-0000-7000-8000-000000022542'::uuid),
  ('01920000-0000-7000-8000-000000022543'::uuid),
  ('01920000-0000-7000-8000-000000022544'::uuid),
  ('01920000-0000-7000-8000-000000111001'::uuid),
  ('01920000-0000-7000-8000-000000111011'::uuid),
  ('01920000-0000-7000-8000-000000111012'::uuid),
  ('01920000-0000-7000-8000-000000111013'::uuid),
  ('01920000-0000-7000-8000-000000112001'::uuid),
  ('01920000-0000-7000-8000-000000112101'::uuid),
  ('01920000-0000-7000-8000-000000112102'::uuid),
  ('01920000-0000-7000-8000-000000112103'::uuid),
  ('01920000-0000-7000-8000-000000112104'::uuid),
  ('01920000-0000-7000-8000-000000112105'::uuid),
  ('01920000-0000-7000-8000-000000112201'::uuid),
  ('01920000-0000-7000-8000-000000112202'::uuid),
  ('01920000-0000-7000-8000-000000112203'::uuid),
  ('01920000-0000-7000-8000-000000112204'::uuid),
  ('01920000-0000-7000-8000-000000112205'::uuid),
  ('01920000-0000-7000-8000-000000112206'::uuid),
  ('01920000-0000-7000-8000-000000112207'::uuid),
  ('01920000-0000-7000-8000-000000112208'::uuid),
  ('01920000-0000-7000-8000-000000112210'::uuid),
  ('01920000-0000-7000-8000-000000112213'::uuid),
  ('01920000-0000-7000-8000-000000112214'::uuid),
  ('01920000-0000-7000-8000-000000112301'::uuid),
  ('01920000-0000-7000-8000-000000112302'::uuid),
  ('01920000-0000-7000-8000-000000112401'::uuid),
  ('01920000-0000-7000-8000-000000112402'::uuid),
  ('01920000-0000-7000-8000-000000112403'::uuid),
  ('01920000-0000-7000-8000-000000112404'::uuid),
  ('01920000-0000-7000-8000-000000114001'::uuid),
  ('01920000-0000-7000-8000-000000114011'::uuid),
  ('01920000-0000-7000-8000-000000114012'::uuid),
  ('01920000-0000-7000-8000-000000114013'::uuid),
  ('01920000-0000-7000-8000-000000114021'::uuid),
  ('01920000-0000-7000-8000-000000114022'::uuid),
  ('01920000-0000-7000-8000-000000114023'::uuid),
  ('01920000-0000-7000-8000-000000114024'::uuid),
  ('01920000-0000-7000-8000-000000114031'::uuid),
  ('01920000-0000-7000-8000-000000114032'::uuid),
  ('01920000-0000-7000-8000-000000114033'::uuid),
  ('01920000-0000-7000-8000-000000114041'::uuid),
  ('01920000-0000-7000-8000-000000114042'::uuid),
  ('01920000-0000-7000-8000-000000114043'::uuid),
  ('01920000-0000-7000-8000-000000115001'::uuid),
  ('01920000-0000-7000-8000-000000115002'::uuid),
  ('01920000-0000-7000-8000-000000115003'::uuid),
  ('01920000-0000-7000-8000-000000115011'::uuid),
  ('01920000-0000-7000-8000-000000115021'::uuid),
  ('01920000-0000-7000-8000-000000115022'::uuid),
  ('01920000-0000-7000-8000-000000115031'::uuid),
  ('01920000-0000-7000-8000-000000115032'::uuid),
  ('01920000-0000-7000-8000-000000115033'::uuid),
  ('01920000-0000-7000-8000-000000115041'::uuid),
  ('01920000-0000-7000-8000-000000115042'::uuid),
  ('01920000-0000-7000-8000-000000115051'::uuid),
  ('01920000-0000-7000-8000-000000115052'::uuid),
  ('01920000-0000-7000-8000-000000115061'::uuid),
  ('01920000-0000-7000-8000-000000115071'::uuid),
  ('01920000-0000-7000-8000-000000150001'::uuid),
  ('01920000-0000-7000-8000-000000150002'::uuid),
  ('01920000-0000-7000-8000-000000150020'::uuid),
  ('01920000-0000-7000-8000-000000150031'::uuid),
  ('01920000-0000-7000-8000-000000150032'::uuid),
  ('01920000-0000-7000-8000-000000217001'::uuid),
  ('01920000-0000-7000-8000-000000217011'::uuid),
  ('01920000-0000-7000-8000-000000217012'::uuid),
  ('01920000-0000-7000-8000-000000217013'::uuid),
  ('01920000-0000-7000-8000-000000217021'::uuid),
  ('01920000-0000-7000-8000-000000217031'::uuid),
  ('01920000-0000-7000-8000-000000217041'::uuid),
  ('01920000-0000-7000-8000-000000217051'::uuid),
  ('01920000-0000-7000-8000-000000217061'::uuid),
  ('01920000-0000-7000-8000-000000217062'::uuid),
  ('01920000-0000-7000-8000-000000217063'::uuid),
  ('01920000-0000-7000-8000-000000219001'::uuid),
  ('01920000-0000-7000-8000-000000219002'::uuid),
  ('01920000-0000-7000-8000-000000219003'::uuid),
  ('01920000-0000-7000-8000-000000219004'::uuid),
  ('01920000-0000-7000-8000-000000219005'::uuid),
  ('01920000-0000-7000-8000-000000219006'::uuid),
  ('01920000-0000-7000-8000-000000227001'::uuid),
  ('01920000-0000-7000-8000-000000227002'::uuid),
  ('01920000-0000-7000-8000-000000227101'::uuid),
  ('01920000-0000-7000-8000-000000227102'::uuid),
  ('01920000-0000-7000-8000-000000227103'::uuid),
  ('01920000-0000-7000-8000-000000227201'::uuid),
  ('01920000-0000-7000-8000-000000227211'::uuid),
  ('01920000-0000-7000-8000-000000227212'::uuid),
  ('01920000-0000-7000-8000-000000227301'::uuid),
  ('01920000-0000-7000-8000-000000228001'::uuid),
  ('01920000-0000-7000-8000-000000228101'::uuid),
  ('01920000-0000-7000-8000-000000228102'::uuid),
  ('01920000-0000-7000-8000-000000228201'::uuid),
  ('01920000-0000-7000-8000-000000228301'::uuid),
  ('01920000-0000-7000-8000-000000228401'::uuid),
  ('01920000-0000-7000-8000-000000228402'::uuid),
  ('01920000-0000-7000-8000-000000228501'::uuid),
  ('01920000-0000-7000-8000-000000228601'::uuid),
  ('01920000-0000-7000-8000-000000228701'::uuid),
  ('01920000-0000-7000-8000-000000228702'::uuid),
  ('01920000-0000-7000-8000-000000228801'::uuid),
  ('01920000-0000-7000-8000-000001340001'::uuid),
  ('01920000-0000-7000-8000-000001340002'::uuid),
  ('01920000-0000-7000-8000-000001340101'::uuid),
  ('01920000-0000-7000-8000-000001340102'::uuid),
  ('01920000-0000-7000-8000-000001340201'::uuid),
  ('01920000-0000-7000-8000-000001340301'::uuid),
  ('01920000-0000-7000-8000-000001340401'::uuid),
  ('01920000-0000-7000-8000-000002290001'::uuid),
  ('01920000-0000-7000-8000-000002290101'::uuid),
  ('01920000-0000-7000-8000-000002290102'::uuid),
  ('01920000-0000-7000-8000-000002310001'::uuid),
  ('01920000-0000-7000-8000-000002310002'::uuid),
  ('01920000-0000-7000-8000-000002310003'::uuid),
  ('01920000-0000-7000-8000-000002310011'::uuid),
  ('01920000-0000-7000-8000-000002310021'::uuid),
  ('01920000-0000-7000-8000-000002310031'::uuid),
  ('01920000-0000-7000-8000-000002310041'::uuid),
  ('01920000-0000-7000-8000-000002310051'::uuid),
  ('01920000-0000-7000-8000-000002310052'::uuid),
  ('01920000-0000-7000-8000-000002310061'::uuid),
  ('01920000-0000-7000-8000-000002310101'::uuid),
  ('01920000-0000-7000-8000-000002310102'::uuid),
  ('01920000-0000-7000-8000-000002310111'::uuid),
  ('01920000-0000-7000-8000-000002310121'::uuid),
  ('01920000-0000-7000-8000-000010300001'::uuid),
  ('01920000-0000-7000-8000-000010300101'::uuid),
  ('01920000-0000-7000-8000-000010300102'::uuid),
  ('01920000-0000-7000-8000-000010300111'::uuid),
  ('01920000-0000-7000-8000-000010300112'::uuid),
  ('01920000-0000-7000-8000-000010300201'::uuid),
  ('01920000-0000-7000-8000-000010600001'::uuid),
  ('01920000-0000-7000-8000-000010600101'::uuid),
  ('01920000-0000-7000-8000-000010600201'::uuid),
  ('01920000-0000-7000-8000-000010600301'::uuid),
  ('01920000-0000-7000-8000-000010800101'::uuid),
  ('01920000-0000-7000-8000-000010800102'::uuid),
  ('01920000-0000-7000-8000-000010800103'::uuid),
  ('01920000-0000-7000-8000-000010800104'::uuid),
  ('01920000-0000-7000-8000-000010800105'::uuid),
  ('01920000-0000-7000-8000-000010800106'::uuid),
  ('01920000-0000-7000-8000-000010800107'::uuid),
  ('01920000-0000-7000-8000-000010800108'::uuid),
  ('01920000-0000-7000-8000-000010800109'::uuid),
  ('01920000-0000-7000-8000-000010800110'::uuid),
  ('01920000-0000-7000-8000-000010800111'::uuid),
  ('01920000-0000-7000-8000-000010800112'::uuid),
  ('01920000-0000-7000-8000-000010800201'::uuid),
  ('01920000-0000-7000-8000-000010800202'::uuid),
  ('01920000-0000-7000-8000-000010800203'::uuid),
  ('01920000-0000-7000-8000-000010800204'::uuid),
  ('01920000-0000-7000-8000-000010800205'::uuid),
  ('01920000-0000-7000-8000-000010800206'::uuid),
  ('01920000-0000-7000-8000-000010800207'::uuid),
  ('01920000-0000-7000-8000-000010800208'::uuid),
  ('01920000-0000-7000-8000-000010800301'::uuid),
  ('01920000-0000-7000-8000-000010800302'::uuid),
  ('01920000-0000-7000-8000-000010800303'::uuid),
  ('01920000-0000-7000-8000-000010800304'::uuid),
  ('01920000-0000-7000-8000-000010800305'::uuid),
  ('01920000-0000-7000-8000-000010800306'::uuid),
  ('01920000-0000-7000-8000-000010800401'::uuid),
  ('01920000-0000-7000-8000-000010800402'::uuid),
  ('01920000-0000-7000-8000-000010800403'::uuid),
  ('01920000-0000-7000-8000-000010800404'::uuid),
  ('01920000-0000-7000-8000-000010800405'::uuid),
  ('01920000-0000-7000-8000-000010800406'::uuid),
  ('01920000-0000-7000-8000-000010800501'::uuid),
  ('01920000-0000-7000-8000-000010800502'::uuid),
  ('01920000-0000-7000-8000-000010800503'::uuid),
  ('01920000-0000-7000-8000-000010800601'::uuid),
  ('01920000-0000-7000-8000-000010800602'::uuid),
  ('01920000-0000-7000-8000-000010800701'::uuid),
  ('01920000-0000-7000-8000-000010800702'::uuid),
  ('01920000-0000-7000-8000-000010800703'::uuid),
  ('01920000-0000-7000-8000-000010800801'::uuid),
  ('01920000-0000-7000-8000-000010800901'::uuid),
  ('01920000-0000-7000-8000-000010800902'::uuid),
  ('01920000-0000-7000-8000-000010800903'::uuid),
  ('01920000-0000-7000-8000-000010800904'::uuid),
  ('01920000-0000-7000-8000-000010800905'::uuid),
  ('01920000-0000-7000-8000-000010800906'::uuid),
  ('01920000-0000-7000-8000-000010900001'::uuid),
  ('01920000-0000-7000-8000-000010900002'::uuid),
  ('01920000-0000-7000-8000-000010900003'::uuid),
  ('01920000-0000-7000-8000-000014900101'::uuid),
  ('01920000-0000-7000-8000-000014900701'::uuid),
  ('01920000-0000-7000-8000-000014900801'::uuid),
  ('01920000-0000-7000-8000-000014900811'::uuid),
  ('01920000-0000-7000-8000-000014900812'::uuid),
  ('01920000-0000-7000-8000-000014900813'::uuid),
  ('01920000-0000-7000-8000-000014900821'::uuid),
  ('01920000-0000-7000-8000-000014900822'::uuid);
insert into pg_temp.demo_email_domains (domain) values
  ('example.com'),
  ('group.calendar.example.com'),
  ('load.example.test');
insert into pg_temp.demo_seed_tables (table_name) values
  ('app.access_grid'),
  ('app.accommodation_assignments'),
  ('app.accommodation_blocks'),
  ('app.account_membership_roles'),
  ('app.account_memberships'),
  ('app.accounting_periods'),
  ('app.advance_packets'),
  ('app.advance_recipients'),
  ('app.advance_sections'),
  ('app.advance_submissions'),
  ('app.agreements'),
  ('app.ai_requests'),
  ('app.ai_settings'),
  ('app.ai_suggestion_fields'),
  ('app.ai_suggestions'),
  ('app.ai_usage'),
  ('app.application_answers'),
  ('app.applications'),
  ('app.approval_policies'),
  ('app.approval_steps'),
  ('app.asset_classes'),
  ('app.asset_custody'),
  ('app.asset_damage'),
  ('app.asset_identifiers'),
  ('app.asset_lots'),
  ('app.asset_maintenance'),
  ('app.asset_units'),
  ('app.availability_blocks'),
  ('app.availability_calendars'),
  ('app.beo_lines'),
  ('app.beos'),
  ('app.budget_lines'),
  ('app.budgets'),
  ('app.call_sheets'),
  ('app.canon_extension_proposals'),
  ('app.capability_documents'),
  ('app.capability_statements'),
  ('app.catalog_bindings'),
  ('app.certification_holders'),
  ('app.certifications'),
  ('app.change_order_lines'),
  ('app.change_orders'),
  ('app.consent_records'),
  ('app.contingency_draws'),
  ('app.cost_centers'),
  ('app.counterparties'),
  ('app.credential_categories'),
  ('app.credentials'),
  ('app.crisis_alerts'),
  ('app.cues'),
  ('app.custom_object_field_choices'),
  ('app.custom_object_fields'),
  ('app.custom_object_records'),
  ('app.custom_object_types'),
  ('app.custom_object_values'),
  ('app.day_sheets'),
  ('app.dock_slots'),
  ('app.document_versions'),
  ('app.documents'),
  ('app.earning_codes'),
  ('app.engagement_documents'),
  ('app.engagement_messages'),
  ('app.engagement_threads'),
  ('app.engagements'),
  ('app.entitlement_deliveries'),
  ('app.expenses'),
  ('app.favorites'),
  ('app.form_templates'),
  ('app.fulfillment_lines'),
  ('app.fulfillments'),
  ('app.fx_rates'),
  ('app.gate_evidence'),
  ('app.gate_queue'),
  ('app.geofences'),
  ('app.goods_receipts'),
  ('app.group_members'),
  ('app.groups'),
  ('app.guest_list_entries'),
  ('app.handbook_articles'),
  ('app.handbook_sections'),
  ('app.help_desk_team_members'),
  ('app.help_desk_teams'),
  ('app.inspection_items'),
  ('app.inspection_templates'),
  ('app.insurance_certificates'),
  ('app.integration_account_mappings'),
  ('app.integration_calendar_targets'),
  ('app.integration_channel_routes'),
  ('app.integration_connections'),
  ('app.invoice_lines'),
  ('app.invoices'),
  ('app.journal_entries'),
  ('app.journal_lines'),
  ('app.legal_acceptances'),
  ('app.marshalling_log'),
  ('app.membership_roles'),
  ('app.memberships'),
  ('app.offer_versions'),
  ('app.offers'),
  ('app.onboarding_requirements'),
  ('app.onboarding_verifications'),
  ('app.opportunities'),
  ('app.opportunity_invitations'),
  ('app.opportunity_positions'),
  ('app.opportunity_questions'),
  ('app.opportunity_requirements'),
  ('app.org_brands'),
  ('app.org_domains'),
  ('app.org_state_labels'),
  ('app.organization_case_studies'),
  ('app.organization_profile_capabilities'),
  ('app.organization_profile_members'),
  ('app.organization_profiles'),
  ('app.organization_service_regions'),
  ('app.organization_verifications'),
  ('app.organizations'),
  ('app.partner_agreements'),
  ('app.partner_default_brands'),
  ('app.party_messages'),
  ('app.party_threads'),
  ('app.pay_periods'),
  ('app.pay_rates'),
  ('app.payment_applications'),
  ('app.payments'),
  ('app.payroll_runs'),
  ('app.per_diems'),
  ('app.person_certifications'),
  ('app.person_emergency_contacts'),
  ('app.person_languages'),
  ('app.person_links'),
  ('app.person_loyalty_programs'),
  ('app.person_profiles'),
  ('app.person_skills'),
  ('app.person_work_details'),
  ('app.personal_setting_values'),
  ('app.po_lines'),
  ('app.pool_members'),
  ('app.portfolio_items'),
  ('app.prequalifications'),
  ('app.profile_section_visibility'),
  ('app.project_members'),
  ('app.projects'),
  ('app.purchase_orders'),
  ('app.radio_channels'),
  ('app.rate_card_lines'),
  ('app.rate_cards'),
  ('app.ratings'),
  ('app.receipt_lines'),
  ('app.record_assignments'),
  ('app.record_booking'),
  ('app.record_build'),
  ('app.record_checklist_items'),
  ('app.record_contract'),
  ('app.record_deadline'),
  ('app.record_dependencies'),
  ('app.record_document'),
  ('app.record_event'),
  ('app.record_inspection'),
  ('app.record_meeting'),
  ('app.record_milestone'),
  ('app.record_permit'),
  ('app.record_recurrences'),
  ('app.record_rehearsal'),
  ('app.record_risk'),
  ('app.record_shift'),
  ('app.record_strike'),
  ('app.record_task'),
  ('app.record_timeline'),
  ('app.records'),
  ('app.representation_scopes'),
  ('app.representations'),
  ('app.requisitions'),
  ('app.rfq_invitations'),
  ('app.rfq_response_lines'),
  ('app.rfq_responses'),
  ('app.rfqs'),
  ('app.rider_lines'),
  ('app.riders'),
  ('app.role_assignments'),
  ('app.run_of_show'),
  ('app.saved_searches'),
  ('app.saved_view_defaults'),
  ('app.saved_view_filters'),
  ('app.saved_view_shares'),
  ('app.saved_view_sorts'),
  ('app.saved_views'),
  ('app.schedule_baselines'),
  ('app.scope_nodes'),
  ('app.setting_values'),
  ('app.settlement_lines'),
  ('app.settlements'),
  ('app.shift_swaps'),
  ('app.shifts'),
  ('app.shipment_lines'),
  ('app.shipments'),
  ('app.shortlists'),
  ('app.site_plan_pins'),
  ('app.site_plans'),
  ('app.sop_acknowledgments'),
  ('app.sops'),
  ('app.spaces'),
  ('app.spend_authorities'),
  ('app.sponsor_assets'),
  ('app.sponsor_entitlements'),
  ('app.submittals'),
  ('app.support_ticket_diagnostics'),
  ('app.support_ticket_messages'),
  ('app.support_tickets'),
  ('app.talent_pools'),
  ('app.team_members'),
  ('app.teams'),
  ('app.template_items'),
  ('app.template_versions'),
  ('app.templates'),
  ('app.time_entries'),
  ('app.time_off_policies'),
  ('app.time_off_requests'),
  ('app.timesheets'),
  ('app.tip_dismissals'),
  ('app.tour_progress'),
  ('app.training_courses'),
  ('app.training_lessons'),
  ('app.training_quiz_keys'),
  ('app.training_quiz_questions'),
  ('app.travel_segments'),
  ('app.vendor_class_assignments'),
  ('app.vendor_classes'),
  ('app.vendor_products'),
  ('app.vendor_scorecards'),
  ('app.vendors'),
  ('app.venues'),
  ('app.verbiage_terms'),
  ('app.weather_thresholds'),
  ('app.work_detail_shares'),
  ('app.work_order_bids'),
  ('app.work_orders'),
  ('app.workforce_events'),
  ('app.workspace_members'),
  ('app.workspaces'),
  ('app.zones'),
  ('auth.identities'),
  ('auth.users');
-- END GENERATED SEED MARKERS

-- Scope -----------------------------------------------------------------------------------------------------
-- Tables the closure walks: the XOS schemas and the auth schema (identities, sessions and factors cascade
-- from auth.users). Storage is handled by the wrapper; cron and Vault hold no demo rows.

create temp table demo_scope as
select c.oid::regclass as rel, n.nspname::text as schema_name, c.relname::text as table_name,
  exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
          and a.atttypid = 'uuid'::regtype) as has_org,
  exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'id' and not a.attisdropped
          and a.atttypid = 'uuid'::regtype) as has_uuid_id
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p') and not c.relispartition
  and n.nspname in ('app', 'private', 'auth', 'xpms', 'api_public', 'api_external', 'supabase_migrations');

alter table demo_scope add primary key (rel);

-- Key expression of a table: its primary key as jsonb (ctid for the rare table without one).
create function pg_temp.demo_key(p_rel regclass, p_alias text)
returns text
language sql
stable
as $$
  select coalesce(
    (select 'jsonb_build_object(' || string_agg(format('%L, %I.%I', a.attname, p_alias, a.attname), ', '
       order by array_position(k.conkey, a.attnum)) || ')'
     from pg_constraint k
     join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
     where k.conrelid = p_rel and k.contype = 'p'),
    format('jsonb_build_object(''ctid'', %I.ctid::text)', p_alias));
$$;

create temp table demo_edges as
select k.conname::text as name, k.conrelid::regclass as child, k.confrelid::regclass as parent, k.confdeltype::text as on_delete,
  (select string_agg(format('c.%I = p.%I', ca.attname, pa.attname), ' and ' order by u.ord)
   from unnest(k.conkey, k.confkey) with ordinality as u (ck, pk, ord)
   join pg_attribute ca on ca.attrelid = k.conrelid and ca.attnum = u.ck
   join pg_attribute pa on pa.attrelid = k.confrelid and pa.attnum = u.pk) as join_condition
from pg_constraint k
where k.contype = 'f' and k.conparentid = 0
  and k.conrelid in (select rel from demo_scope) and k.confrelid in (select rel from demo_scope);

-- Marks: one row per row to delete, with its org when the table has one and the rule that reached it.
create temp table demo_marks (
  rel regclass not null,
  key jsonb not null,
  org_id uuid,
  reason text not null,
  primary key (rel, key)
);

create function pg_temp.demo_mark(p_rel regclass, p_where text, p_reason text)
returns bigint
language plpgsql
as $$
declare
  v_scope pg_temp.demo_scope;
  v_count bigint;
begin
  select * into v_scope from pg_temp.demo_scope s where s.rel = p_rel;
  execute format(
    'insert into pg_temp.demo_marks (rel, key, org_id, reason) select %L::regclass, %s, %s, %L from %s c where %s on conflict do nothing',
    p_rel, pg_temp.demo_key(p_rel, 'c'), case when v_scope.has_org then 'c.org_id' else 'null::uuid' end,
    p_reason, p_rel, p_where);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Closure: roots, then org_id and foreign keys until a pass adds nothing.
create function pg_temp.demo_close()
returns bigint
language plpgsql
as $$
declare
  v_scope pg_temp.demo_scope;
  v_edge pg_temp.demo_edges;
  v_pass bigint;
  v_total bigint := 0;
begin
  -- Roots.
  for v_scope in select * from pg_temp.demo_scope s where s.has_uuid_id loop
    v_total := v_total + pg_temp.demo_mark(v_scope.rel, 'c.id in (select id from pg_temp.demo_seed_ids)', 'seed id');
  end loop;
  v_total := v_total + pg_temp.demo_mark('auth.users',
    'lower(split_part(c.email, ''@'', 2)) in (select domain from pg_temp.demo_email_domains)', 'seed email domain');
  if to_regclass('auth.audit_log_entries') is not null and has_table_privilege('auth.audit_log_entries', 'delete') then
    perform 1 from pg_temp.demo_scope s where s.rel = 'auth.audit_log_entries'::regclass;
    if found then
      v_total := v_total + pg_temp.demo_mark('auth.audit_log_entries',
        'c.payload ->> ''actor_id'' in (select m.key ->> ''id'' from pg_temp.demo_marks m where m.rel = ''auth.users''::regclass)',
        'auth log of a demo user');
    end if;
  end if;

  loop
    v_pass := 0;
    -- People of demo sign-ins (app.people.user_id is ON DELETE SET NULL, so the edge walk skips it).
    v_pass := v_pass + pg_temp.demo_mark('app.people',
      'c.user_id in (select (m.key ->> ''id'')::uuid from pg_temp.demo_marks m where m.rel = ''auth.users''::regclass)',
      'person of a demo sign-in');
    -- Orgs whose every member is a demo person (for example the load fixtures' tenants, created by a SQL
    -- session so created_by is empty): at least one membership or external account membership, and none
    -- held by anyone else.
    v_pass := v_pass + pg_temp.demo_mark('app.organizations', $w$
      exists (select 1 from app.memberships x where x.org_id = c.id
              union all select 1 from app.account_memberships x where x.org_id = c.id)
      and not exists (
        select 1 from (select x.person_id from app.memberships x where x.org_id = c.id
                       union all select x.person_id from app.account_memberships x where x.org_id = c.id) x
        where x.person_id not in (select (m.key ->> 'id')::uuid from pg_temp.demo_marks m where m.rel = 'app.people'::regclass))
      $w$, 'every member is a demo person');
    -- Every row of a marked org.
    for v_scope in select * from pg_temp.demo_scope s where s.has_org loop
      v_pass := v_pass + pg_temp.demo_mark(v_scope.rel,
        'c.org_id in (select (m.key ->> ''id'')::uuid from pg_temp.demo_marks m where m.rel = ''app.organizations''::regclass)',
        'org_id');
    end loop;
    -- Every row that references a marked row and would block or follow its delete.
    for v_edge in
      select e.* from pg_temp.demo_edges e
      where e.on_delete in ('a', 'r', 'c') and exists (select 1 from pg_temp.demo_marks m where m.rel = e.parent)
    loop
      v_pass := v_pass + pg_temp.demo_mark(v_edge.child,
        format('exists (select 1 from %s p join pg_temp.demo_marks m on m.rel = %L::regclass and m.key = %s where %s)',
          v_edge.parent, v_edge.parent, pg_temp.demo_key(v_edge.parent, 'p'), v_edge.join_condition),
        'references ' || v_edge.parent::text);
    end loop;
    v_total := v_total + v_pass;
    exit when v_pass = 0;
  end loop;
  return v_total;
end;
$$;

select pg_temp.demo_close() as marked_rows \gset

-- Safety checks before anything is deleted --------------------------------------------------------------------

create temp table demo_orgs as
select (m.key ->> 'id')::uuid as org_id, o.slug, o.name, (m.key ->> 'id')::uuid in (select id from demo_seed_ids) as seeded
from demo_marks m join app.organizations o on o.id = (m.key ->> 'id')::uuid
where m.rel = 'app.organizations'::regclass;

create temp table demo_users as
select (m.key ->> 'id')::uuid as user_id, u.email, (m.key ->> 'id')::uuid in (select id from demo_seed_ids) as seeded
from demo_marks m join auth.users u on u.id = (m.key ->> 'id')::uuid
where m.rel = 'auth.users'::regclass;

create temp table demo_people as
select (m.key ->> 'id')::uuid as person_id from demo_marks m where m.rel = 'app.people'::regclass;

do $$
declare
  v_bad text;
begin
  select string_agg(distinct s.schema_name || '.' || s.table_name, ', ') into v_bad
  from pg_temp.demo_marks m join pg_temp.demo_scope s on s.rel = m.rel
  where s.schema_name in ('xpms', 'supabase_migrations');
  if v_bad is not null then
    raise exception 'The closure reached canon or migration history (%); nothing was deleted.', v_bad;
  end if;
  -- A marked row in an org that is not itself being removed would be collateral damage.
  select string_agg(distinct m.rel::text, ', ') into v_bad
  from pg_temp.demo_marks m
  where m.org_id is not null and m.org_id not in (select org_id from pg_temp.demo_orgs);
  if v_bad is not null and current_setting('xos.demo_removal_mode') = 'execute' then
    raise exception 'Rows of orgs that are not being removed were reached (%); see the dry-run report.', v_bad;
  end if;
end;
$$;

-- Report: what the run removes ---------------------------------------------------------------------------------

\echo
\echo '== Orgs to remove (seeded = fixed id from the seeds; otherwise created by or made up only of demo people)'
select slug, name, seeded from demo_orgs order by seeded desc, slug;

\echo
\echo '== Sign-ins to remove'
select count(*) as users, count(*) filter (where seeded) as seeded_ids,
  count(*) filter (where not seeded) as on_seed_domain_only
from demo_users;

\echo
\echo '== What stays: orgs and sign-ins the closure does not reach (review before executing)'
select 'org' as kind, o.slug as name, 1 as count
from app.organizations o where o.id not in (select org_id from demo_orgs)
union all
select 'sign-ins on ' || lower(split_part(u.email, '@', 2)), null, count(*)::int
from auth.users u where u.id not in (select user_id from demo_users)
group by lower(split_part(u.email, '@', 2))
order by 1, 2;

\echo
\echo '== Rows reached in orgs that are not being removed (must be empty to execute)'
select m.rel::text as table_name, count(*) as rows
from demo_marks m
where m.org_id is not null and m.org_id not in (select org_id from demo_orgs)
group by 1 order by 1;

create temp table demo_before as
select s.rel, s.schema_name, s.table_name,
  (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %s', s.rel), false, true, '')))[1]::text::bigint as rows
from demo_scope s;

\echo
\echo '== Rows to delete, per table'
select m.rel::text as table_name, count(*) as rows_to_delete, b.rows as rows_now,
  (m.rel::text in (select table_name from demo_seed_tables)) as seed_writes
from demo_marks m join demo_before b on b.rel = m.rel
group by m.rel, b.rows order by 1;

select count(distinct rel) as tables, count(*) as rows_to_delete from demo_marks;

\if :{?stop_after_report}
  rollback;
  \quit
\endif

-- Storage objects of the demo orgs and people -------------------------------------------------------------------
-- Object names start with an org id (attachments, org-brand, field-media, report-results) or a person id
-- (profile-media, imports, onboarding-uploads, support-screenshots); owner_id is the uploading sign-in.

create temp table demo_storage as
select o.bucket_id, o.name
from storage.objects o
where split_part(o.name, '/', 1) in (
    select org_id::text from demo_orgs
    union all select person_id::text from demo_people
    union all select user_id::text from demo_users)
  or o.owner_id in (select user_id::text from demo_users);

-- Vault secrets of the demo orgs' integration connections and warehouse destinations ---------------------------
-- app.store_integration_credential keeps each connection's secret in Vault as xos_integration_<connection id>,
-- linked from private.integration_credentials without a foreign key; app.store_integration_inbound_secret keeps a
-- connection's webhook secret as xos_integration_inbound_<connection id> (private.integration_inbound_secrets,
-- 1400); app.store_warehouse_credential keeps a destination's bucket credential as xos_warehouse_<destination id>
-- (private.warehouse_credentials, 1401). The migration-created keys stay.

create temp table demo_vault (id uuid primary key, name text);
insert into demo_vault (id, name)
select s.id, s.name from vault.secrets s
where s.name in (select 'xos_integration_' || (m.key ->> 'id') from demo_marks m
                 where m.rel = 'app.integration_connections'::regclass)
on conflict do nothing;
insert into demo_vault (id, name)
select s.id, s.name from vault.secrets s
join private.integration_credentials c on c.vault_secret_id = s.id
where c.integration_connection_id in (select (m.key ->> 'id')::uuid from demo_marks m
                                      where m.rel = 'app.integration_connections'::regclass)
on conflict do nothing;
insert into demo_vault (id, name)
select s.id, s.name from vault.secrets s
where s.name in (select 'xos_integration_inbound_' || (m.key ->> 'id') from demo_marks m
                 where m.rel = 'app.integration_connections'::regclass)
   or s.id in (select i.vault_secret_id from private.integration_inbound_secrets i
               where i.integration_connection_id in (select (m.key ->> 'id')::uuid from demo_marks m
                                                     where m.rel = 'app.integration_connections'::regclass))
on conflict do nothing;
insert into demo_vault (id, name)
select s.id, s.name from vault.secrets s
where s.name in (select 'xos_warehouse_' || (m.key ->> 'id') from demo_marks m
                 where m.rel = 'app.warehouse_destinations'::regclass)
   or s.id in (select w.vault_secret_id from private.warehouse_credentials w
               where w.warehouse_destination_id in (select (m.key ->> 'id')::uuid from demo_marks m
                                                    where m.rel = 'app.warehouse_destinations'::regclass))
on conflict do nothing;

\echo
\echo '== Vault secrets to remove (integration credentials, webhook secrets and warehouse credentials of the demo orgs)'
select count(*) as secrets from demo_vault;

\echo
\echo '== Storage objects to remove through the Storage API (the wrapper does this before the SQL run)'
select bucket_id, count(*) as objects from demo_storage group by 1 order by 1;

\if :{?storage_list}
  \set QUIET on
  \o :storage_list
  copy (select bucket_id, name from demo_storage order by 1, 2) to stdout with (format csv);
  \o
  \set QUIET off
\endif

select :'mode' = 'dry-run' as is_dry_run \gset
\if :is_dry_run
  \echo
  \echo 'Dry run: nothing was deleted.'
  rollback;
  \quit
\endif

-- Delete -------------------------------------------------------------------------------------------------------

-- Storage objects reference no table, so they never block the deletes; a commit still waits until they are gone.
do $$
begin
  if exists (select 1 from pg_temp.demo_storage) and current_setting('xos.demo_removal_mode') = 'execute' then
    raise exception 'Storage objects of the demo orgs remain (% objects); remove them through the Storage API first.',
      (select count(*) from pg_temp.demo_storage);
  end if;
end;
$$;

-- Order: children before parents (Kahn over the foreign keys between marked tables); a cycle, if any, goes
-- last and the retry passes below settle it.
create temp table demo_order (rel regclass primary key, ord integer not null, done boolean not null default false);

do $$
declare
  v_ord integer := 0;
  v_added integer;
begin
  loop
    insert into pg_temp.demo_order (rel, ord)
    select r.rel, v_ord
    from (select distinct m.rel from pg_temp.demo_marks m) r
    where r.rel not in (select rel from pg_temp.demo_order)
      and not exists (
        select 1 from pg_temp.demo_edges e
        where e.parent = r.rel and e.child <> r.rel
          and e.child in (select m.rel from pg_temp.demo_marks m)
          and e.child not in (select rel from pg_temp.demo_order));
    get diagnostics v_added = row_count;
    exit when v_added = 0;
    v_ord := v_ord + 1;
  end loop;
  insert into pg_temp.demo_order (rel, ord)
  select distinct m.rel, v_ord from pg_temp.demo_marks m
  where m.rel not in (select rel from pg_temp.demo_order);
end;
$$;

create temp table demo_deleted (rel regclass not null, pass integer not null, rows bigint not null);
create temp table demo_refusals (rel regclass not null, pass integer not null, message text not null);

-- The sanctioned purge mark (migration 1270): guards let deletes of these orgs' rows through, nothing else.
select private.begin_tenant_purge(array(select org_id from demo_orgs)) as orgs_marked_for_purge;

do $$
declare
  v_rel regclass;
  v_pass integer := 0;
  v_progress integer;
  v_rows bigint;
  v_sql text;
begin
  loop
    v_pass := v_pass + 1;
    v_progress := 0;
    for v_rel in select o.rel from pg_temp.demo_order o where not o.done order by o.ord, o.rel::text loop
      begin
        execute format('delete from %s t where %s in (select m.key from pg_temp.demo_marks m where m.rel = %L::regclass)',
          v_rel, pg_temp.demo_key(v_rel, 't'), v_rel);
        get diagnostics v_rows = row_count;
        insert into pg_temp.demo_deleted values (v_rel, v_pass, v_rows);
        update pg_temp.demo_order set done = true where rel = v_rel;
        v_progress := v_progress + 1;
      exception when others then
        insert into pg_temp.demo_refusals values (v_rel, v_pass, sqlerrm);
      end;
    end loop;
    exit when not exists (select 1 from pg_temp.demo_order where not done);
    if v_progress = 0 then
      -- A foreign key cycle (for example templates.current_version and template_versions.template_id) cannot be
      -- deleted one table at a time. Delete everything left in one statement: foreign keys are checked at its end.
      select 'with ' || string_agg(format('d%s as (delete from %s t where %s in (select m.key from pg_temp.demo_marks m where m.rel = %L::regclass) returning 1)',
               o.ord_no, o.rel, pg_temp.demo_key(o.rel, 't'), o.rel), ', ')
             || ' insert into pg_temp.demo_deleted (rel, pass, rows) '
             || string_agg(format('select %L::regclass, %s, (select count(*) from d%s)', o.rel, v_pass, o.ord_no), ' union all ')
        into v_sql
      from (select r.rel, row_number() over (order by r.ord, r.rel::text) as ord_no
            from pg_temp.demo_order r where not r.done) o;
      begin
        execute v_sql;
        update pg_temp.demo_order set done = true where not done;
      exception when others then
        raise exception 'The delete is stuck after % passes: %', v_pass,
          (select string_agg(r.rel::text || ': ' || r.message, E'\n') from pg_temp.demo_refusals r where r.pass = v_pass)
          || E'\nTogether: ' || sqlerrm;
      end;
    end if;
  end loop;
end;
$$;

select private.end_tenant_purge() as orgs_unmarked;

with gone as (delete from vault.secrets s where s.id in (select id from demo_vault) returning 1)
select count(*) as vault_secrets_deleted from gone;

-- Verify -------------------------------------------------------------------------------------------------------
-- 1. Every table lost exactly its marked rows: nothing else was deleted, and no trigger wrote new rows.
-- 2. A fresh closure from the seed markers finds nothing.
-- 3. No row anywhere still carries the org_id of a removed org.

create temp table demo_after as
select s.rel,
  (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %s', s.rel), false, true, '')))[1]::text::bigint as rows
from demo_scope s;

create temp table demo_result as
select b.rel, b.schema_name, b.table_name, b.rows as rows_before, a.rows as rows_after,
  coalesce(m.marked, 0) as marked, b.rows - a.rows as deleted
from demo_before b
join demo_after a on a.rel = b.rel
left join (select rel, count(*) as marked from demo_marks group by rel) m on m.rel = b.rel;

create temp table demo_marks_done as select * from demo_marks;
truncate demo_marks;
select pg_temp.demo_close() as rows_found_by_fresh_closure \gset

do $$
declare
  v_bad text;
  v_scope pg_temp.demo_scope;
  v_count bigint;
begin
  select string_agg(format('%s (before %s, after %s, marked %s)', r.rel, r.rows_before, r.rows_after, r.marked), ', ')
    into v_bad
  from pg_temp.demo_result r where r.deleted <> r.marked;
  if v_bad is not null then
    raise exception 'Verification failed: row counts moved by something other than the marked deletes: %', v_bad;
  end if;
  if (select count(*) from pg_temp.demo_marks) > 0 then
    raise exception 'Verification failed: a fresh closure still finds % demo rows (%).', (select count(*) from pg_temp.demo_marks),
      (select string_agg(distinct rel::text, ', ') from pg_temp.demo_marks);
  end if;
  for v_scope in select * from pg_temp.demo_scope s where s.has_org loop
    execute format('select count(*) from %s where org_id in (select org_id from pg_temp.demo_orgs)', v_scope.rel) into v_count;
    if v_count > 0 then
      raise exception 'Verification failed: % still holds % rows of removed orgs.', v_scope.rel, v_count;
    end if;
  end loop;
  if exists (select 1 from auth.users u where u.id in (select user_id from pg_temp.demo_users))
     or exists (select 1 from app.people p where p.id in (select person_id from pg_temp.demo_people)) then
    raise exception 'Verification failed: demo sign-ins or people remain.';
  end if;
  if exists (select 1 from vault.secrets s where s.id in (select id from pg_temp.demo_vault)) then
    raise exception 'Verification failed: integration credentials of removed orgs remain in Vault.';
  end if;
  if exists (select 1 from private.tenant_purge_scope s where s.xact_id = pg_current_xact_id()) then
    raise exception 'Verification failed: the tenant purge mark is still set.';
  end if;
end;
$$;

\echo
\echo '== Deleted, per table (rows before, after, deleted)'
select table_name_full as table_name, rows_before, rows_after, deleted
from (select schema_name || '.' || table_name as table_name_full, rows_before, rows_after, deleted from demo_result where deleted > 0) r
order by 1;

\echo
\echo '== Totals'
select count(*) filter (where deleted > 0) as tables_with_deletes, sum(deleted) as rows_deleted,
  count(*) filter (where deleted = 0) as tables_untouched,
  sum(rows_after) filter (where schema_name = 'xpms') as canon_rows_kept
from demo_result;

\echo
\echo 'Verification passed: every table lost exactly its marked rows, a fresh closure finds nothing, no row of a removed org remains.'

select :'mode' = 'execute' as is_execute \gset
\if :is_execute
  commit;
  \echo 'Committed.'
\else
  rollback;
  \echo 'Rehearsal: rolled back, nothing changed.'
\endif
