-- pgTAP: assets and credentials (Section 7.4). Same-tenant allow, cross-tenant deny, anon deny, role
-- bands, the nine-value asset lifecycle (allowed and refused moves), the append-only custody ledger,
-- canon enumerations, invariant 21 (no self-issued credentials or certifications; public
-- verification only with the holder's consent), revocation, and scans decided by the database.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(39);

-- Assets --------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.asset_classes (org_id, element_id, name) values (pg_temp.id('org_a'), '0000.01.01-XOS-001', 'Stage Deck 4x8') returning id) insert into world select 'acls', id from x;
with x as (insert into app.asset_units (asset_class_id, asset_tag, condition_enum_id) values (pg_temp.id('acls'), 'NWL-DECK-001', 'ENM-017') returning id) insert into world select 'unit', id from x;
select throws_ok($$insert into app.asset_units (asset_class_id, asset_tag, condition_enum_id) values ((select id from world where key = 'acls'), 'NWL-DECK-002', 'ENM-036')$$,
  'XR001', null, 'an asset condition comes from the Asset Condition enumeration');
select throws_ok($$insert into app.asset_units (asset_class_id, asset_tag) values ((select id from world where key = 'acls'), 'NWL-DECK-001')$$, '23505', null, 'an asset tag is unique within the org');
select is((select asset_state::text from app.asset_units where id = pg_temp.id('unit')), 'Proposed', 'a new asset is Proposed');
select is((select count(*)::int from app.lifecycle_transition_rules where lifecycle = 'asset'), 17, 'the asset lifecycle declares seventeen moves');
select is((select count(*)::int from unnest(enum_range(null::app.asset_state))), 9, 'the asset lifecycle has nine values');
select throws_ok($$update app.asset_units set asset_state = 'Available' where id = (select id from world where key = 'unit')$$, 'XR001', null, 'the asset state changes only through its RPC');
select throws_ok($$select app.transition_asset((select id from world where key = 'unit'), 'Proposed', 'Deployed', 'Skip.')$$, 'XR001', 'asset_transition_not_allowed: A asset cannot move from Proposed to Deployed.', 'a Proposed asset cannot jump to Deployed');
select lives_ok($$select app.transition_asset((select id from world where key = 'unit'), 'Proposed', 'Received', 'Delivered.')$$, 'Proposed to Received');
select lives_ok($$select app.transition_asset((select id from world where key = 'unit'), 'Received', 'Available', 'Checked in.')$$, 'Received to Available');
select lives_ok($$select app.transition_asset((select id from world where key = 'unit'), 'Available', 'Deployed', 'Out to the Pier.')$$, 'Available to Deployed');
select lives_ok($$select app.transition_asset((select id from world where key = 'unit'), 'Deployed', 'Damaged', 'Cracked panel.')$$, 'Deployed to Damaged');
select lives_ok($$select app.transition_asset((select id from world where key = 'unit'), 'Damaged', 'Retired', 'Written off.')$$, 'Damaged to Retired');
select throws_ok($$select app.transition_asset((select id from world where key = 'unit'), 'Retired', 'Available', 'Back.')$$, 'XR001', 'asset_transition_not_allowed: A asset cannot move from Retired to Available.', 'Retired is terminal');
select lives_ok($$insert into app.asset_custody (asset_unit_id, custodian_membership_id, project_id) values ((select id from world where key = 'unit'), (select id from world where key = 'frank@org_a'), (select id from world where key = 'prj_a'))$$, 'custody is handed to a member');
select throws_ok($$update app.asset_custody set note = 'Edited.'$$, '42501', null, 'the custody ledger is append-only for signed-in callers');
select throws_ok($$insert into app.asset_identifiers (asset_unit_id, identifier_class, scheme, value) values ((select id from world where key = 'unit'), 'code', 'serial', 'X1')$$,
  '23514', null, 'asset identifiers are externally issued values only');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.asset_units), 1, 'a Member reads the org''s assets');
select throws_ok($$select app.transition_asset((select id from world where key = 'unit'), 'Retired', 'Lost', 'x')$$, '42501', null, 'a Member cannot move assets org-wide');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.asset_custody), 1, 'a custodian reads their custody entry');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.asset_units where org_id = pg_temp.id('org_a')), 0, 'another org reads no assets');
select pg_temp.as_anon();
select throws_ok('select 1 from app.asset_units', '42501', null, 'anon cannot read assets');
select throws_ok('select 1 from app.credentials', '42501', null, 'anon cannot read credentials');
select pg_temp.as_platform();
select throws_ok($$update app.asset_custody set note = 'Edited.'$$, 'XR001', null, 'and for the platform');

-- Credentials (invariant 21) --------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'BOH', 'Back of House') returning id) insert into world select 'zone', id from x;
with x as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'CREW', 'Crew') returning id) insert into world select 'cat', id from x;
insert into app.access_grid (credential_category_id, zone_id, access_level_enum_id, window_starts_at, window_ends_at)
values (pg_temp.id('cat'), pg_temp.id('zone'), 'ENM-036', now() - interval '1 day', now() + interval '1 day');
select throws_ok($$insert into app.access_grid (credential_category_id, zone_id, access_level_enum_id, window_starts_at, window_ends_at) values ((select id from world where key = 'cat'), (select id from world where key = 'zone'), 'ENM-015', now(), now() + interval '1 hour')$$,
  'XR001', null, 'an access level comes from the Access Level enumeration');
select throws_ok($$insert into app.credentials (credential_category_id, holder_person_id) values ((select id from world where key = 'cat'), (select id from world where key = 'carol'))$$,
  'XR001', 'credential_self_issue: A person never issues their own credential or certification.', 'inv_21_no_self_issue: a person cannot issue their own credential (invariant 21)');
with x as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat'), pg_temp.id('frank')) returning id) insert into world select 'cred', id from x;
select is((select issued_by from app.credentials where id = pg_temp.id('cred')), pg_temp.id('carol'), 'the issuer is the session person');
select ok((select credential_number like 'CR-%' from app.credentials where id = pg_temp.id('cred')), 'the credential number is issued by the database');
insert into app.access_scans (credential_id, zone_id, result) values (pg_temp.id('cred'), pg_temp.id('zone'), 'Denied');
select is((select result::text from app.access_scans where credential_id = pg_temp.id('cred') order by scanned_at desc limit 1), 'Granted', 'the database grants a scan the grid allows, whatever the scanner sent');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.credentials), 1, 'a holder reads their credential');
select throws_ok($$insert into app.credentials (credential_category_id, holder_person_id) values ((select id from world where key = 'cat'), (select id from world where key = 'dave'))$$, '42501', null, 'a Field member cannot issue credentials');
select pg_temp.as_user('dave');
select lives_ok($$update app.credentials set revoked_at = now() where id = (select id from world where key = 'cred')$$, 'a Member with revoke reach on the project revokes it');
select throws_ok($$update app.credentials set revoked_at = null where id = (select id from world where key = 'cred')$$, 'XR001', null, 'a revoked credential stays revoked');
select pg_temp.as_user('carol');
insert into app.access_scans (credential_id, zone_id) values (pg_temp.id('cred'), pg_temp.id('zone'));
select is((select count(*)::int from app.access_scans where credential_id = pg_temp.id('cred') and result = 'Denied'), 1, 'a revoked credential is denied');
select pg_temp.as_platform();

-- Certifications (invariant 21) --------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.certifications (org_id, name, issuing_body) values (pg_temp.id('org_a'), 'Rigging Level 2', 'ETCP') returning id) insert into world select 'cert', id from x;
select throws_ok($$insert into app.certification_holders (certification_id, person_id, issued_on) values ((select id from world where key = 'cert'), (select id from world where key = 'carol'), '2027-01-01')$$,
  'XR001', null, 'inv_21_no_self_issue: a person cannot record their own certification (invariant 21)');
with x as (insert into app.certification_holders (certification_id, person_id, issued_on, public_verification_consented) values (pg_temp.id('cert'), pg_temp.id('frank'), '2027-01-01', true) returning id) insert into world select 'holder', id from x;
select is((select public_verification_consented from app.certification_holders where id = pg_temp.id('holder')), false, 'consent starts withheld whatever the recorder sends');
select throws_ok($$update app.certification_holders set public_verification_consented = true where id = (select id from world where key = 'holder')$$,
  'XR001', 'certification_consent_holder_only: Only the holder consents to public verification.', 'only the holder consents');
select pg_temp.as_platform();
create temporary table code as select verification_code from app.certification_holders where id = pg_temp.id('holder');
grant select on code to public;
select pg_temp.as_anon();
select is((select count(*)::int from api_public.verify_certification((select verification_code from code))), 0, 'inv_21_no_self_issue: without consent the certificate does not verify publicly');
select pg_temp.as_user('frank');
select lives_ok($$update app.certification_holders set public_verification_consented = true where id = (select id from world where key = 'holder')$$, 'the holder consents');
select pg_temp.as_anon();
select is((select holder_name from api_public.verify_certification((select verification_code from code))), 'Frank Adeyemi', 'inv_21_no_self_issue: with consent it verifies publicly, showing only the rendered fields');
select pg_temp.as_platform();

select * from finish();
rollback;
