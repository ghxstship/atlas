-- pgTAP: migration 1130, additional insureds on certificates of insurance (finding A38-001, journey 43). Insureds a
-- certificate names and those an org requires, the derived checks, the reviewer's verification step (Passed only when
-- every required insured is named on a current certificate, Failed naming who is missing, refused for a non-vendor,
-- an org with no requirement, a Member and the engaged party), and the vendor's view. Same-tenant allow,
-- cross-tenant deny, anon deny and role bands.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(35);

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

-- Fixture: Bayside Audio as Northwind's vendor with a current certificate; a vendor engagement with a reviewer item --
select pg_temp.as_user('alice');
with v as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_v_a')) returning id) insert into world select 'ven', id from v;
with c as (insert into app.insurance_certificates (vendor_id, insurer, policy_identifier, coverage_type, coverage_limit_minor, currency_code, valid_from, valid_to)
  values (pg_temp.id('ven'), 'Fictional Mutual', 'GL-1130', 'General Liability', 100000000, 'USD', current_date - 30, current_date + 335) returning id)
  insert into world select 'coi', id from c;
with c as (insert into app.insurance_certificates (vendor_id, insurer, policy_identifier, coverage_type, valid_from, valid_to)
  values (pg_temp.id('ven'), 'Fictional Mutual', 'GL-1129', 'General Liability', current_date - 400, current_date - 35) returning id)
  insert into world select 'coi_old', id from c;
with r as (insert into app.onboarding_requirements (org_id, name, item_kind, role_type, verification_method)
  values (pg_temp.id('org_a'), 'Certificate of Insurance with additional insureds', 'Document Upload', 'Vendor', 'Reviewer') returning id)
  insert into world select 'req', id from r;
with e as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification, pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('sam'), pg_temp.id('cp_v_a'), 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement', '2027-06-03') returning id)
  insert into world select 'eng', id from e;
insert into world select 'item', i.id from app.onboarding_items i where i.engagement_id = pg_temp.id('eng') and i.onboarding_requirement_id = pg_temp.id('req');
with r as (insert into app.onboarding_requirements (org_id, name, item_kind, verification_method, is_blocking)
  values (pg_temp.id('org_a'), 'Site induction', 'Acknowledgment', 'Reviewer', false) returning id) insert into world select 'req_any', id from r;
with i as (insert into app.onboarding_items (engagement_id, onboarding_requirement_id) values (pg_temp.id('eng_ivy_a'), pg_temp.id('req_any')) returning id)
  insert into world select 'item_crew', id from i;
select pg_temp.as_platform();

-- Insureds a certificate names --------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select lives_ok($$insert into app.insurance_certificate_insureds (certificate_id, insured_name) values
  ((select id from world where key = 'coi'), 'Northwind Live LLC'), ((select id from world where key = 'coi_old'), 'Pier Pavilion Owner LLC')$$,
  'a Manager records the insureds a certificate names');
select is((select org_id from app.insurance_certificate_insureds where insured_name = 'Northwind Live LLC'), pg_temp.id('org_a'), 'the org comes from the certificate');
select is((select endorsement_kind::text from app.insurance_certificate_insureds where insured_name = 'Northwind Live LLC'), 'Additional Insured', 'the endorsement defaults to Additional Insured');
select throws_ok($$insert into app.insurance_certificate_insureds (certificate_id, insured_name) values ((select id from world where key = 'coi'), '  northwind   live llc ')$$,
  '23505', null, 'a name appears once per endorsement, ignoring case and spacing');
select lives_ok($$insert into app.insurance_certificate_insureds (certificate_id, insured_name, endorsement_kind) values ((select id from world where key = 'coi'), 'Northwind Live LLC', 'Waiver of Subrogation')$$,
  'the same name with another endorsement is its own row');
select throws_ok($$insert into app.insurance_certificate_insureds (certificate_id, insured_name) values ((select id from world where key = 'coi'), '  ')$$,
  '23514', null, 'a blank name is refused');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.insurance_certificate_insureds), 3, 'a Member with vendor read reads the insureds');
select throws_ok($$insert into app.insurance_certificate_insureds (certificate_id, insured_name) values ((select id from world where key = 'coi'), 'Member try')$$,
  '42501', null, 'a Member cannot record insureds');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.insurance_certificate_insureds), 0, 'cross-tenant: another org reads none');
select throws_ok($$insert into app.insurance_certificate_insureds (certificate_id, insured_name) values ((select id from world where key = 'coi'), 'Cross')$$,
  '42501', null, 'cross-tenant: another org cannot name insureds on it');
select pg_temp.as_anon();
select throws_ok('select 1 from app.insurance_certificate_insureds', '42501', null, 'anon reads no insureds');
select throws_ok('select 1 from app.required_additional_insureds', '42501', null, 'anon reads no requirements');

-- Requirements -------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select lives_ok($$insert into app.required_additional_insureds (org_id, insured_name) values ((select id from world where key = 'org_a'), 'Northwind Live LLC')$$,
  'a Manager requires an org-wide insured');
select throws_ok($$insert into app.required_additional_insureds (org_id, insured_name) values ((select id from world where key = 'org_a'), 'NORTHWIND LIVE LLC')$$,
  '23505', null, 'an org-wide requirement is stated once');
select throws_ok($$insert into app.required_additional_insureds (org_id, project_id, insured_name) values ((select id from world where key = 'org_a'), (select id from world where key = 'prj_b'), 'Elsewhere')$$,
  'XR001', null, 'a project of another org is refused');
select pg_temp.as_user('dave');
select throws_ok($$insert into app.required_additional_insureds (org_id, insured_name) values ((select id from world where key = 'org_a'), 'Member try')$$,
  '42501', null, 'a Member cannot state requirements');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.required_additional_insureds), 0, 'cross-tenant: another org reads no requirements');

-- Checks ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select ok((select insureds_verified from app.insurance_certificate_checks where certificate_id = pg_temp.id('coi')), 'the current certificate names every org-wide insured');
select ok(not (select insureds_verified from app.insurance_certificate_checks where certificate_id = pg_temp.id('coi_old')), 'the expired one misses it');
select is((select named_on_certificate_id from app.engagement_insured_checks where engagement_id = pg_temp.id('eng')), pg_temp.id('coi'),
  'the engagement check points at the current certificate naming the insured');
insert into app.required_additional_insureds (org_id, project_id, insured_name) values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Pier Pavilion Owner LLC');
select is((select count(*)::int from app.engagement_insured_checks where engagement_id = pg_temp.id('eng')), 2, 'a project requirement adds to the org-wide one');
select ok((select named_on_certificate_id is null from app.engagement_insured_checks where engagement_id = pg_temp.id('eng') and project_specific),
  'a party named only on an expired certificate is missing');

-- The verification step -----------------------------------------------------------------------------------------------
select is((app.verify_onboarding_insureds(pg_temp.id('item')) ->> 'outcome'), 'Failed', 'with an insured missing the step records Failed');
select is((select latest_outcome::text from app.onboarding_item_status where onboarding_item_id = pg_temp.id('item')), 'Failed', 'the item shows Failed');
select pg_temp.as_platform();
select is((select note from app.onboarding_verifications where onboarding_item_id = pg_temp.id('item') order by verified_at desc, id desc limit 1),
  'Missing additional insureds: Pier Pavilion Owner LLC (Additional Insured).', 'the note names who is missing');
select pg_temp.as_user('carol');
insert into app.insurance_certificate_insureds (certificate_id, insured_name) values (pg_temp.id('coi'), 'pier pavilion owner llc');
select is((app.verify_onboarding_insureds(pg_temp.id('item')) -> 'missing'), '[]'::jsonb, 'once a current certificate names everyone nothing is missing');
select ok((select passes from app.onboarding_item_status where onboarding_item_id = pg_temp.id('item')), 'and the item passes');
select is((select verified_by from app.onboarding_verifications where onboarding_item_id = pg_temp.id('item') order by verified_at desc, id desc limit 1),
  pg_temp.id('carol'), 'the reviewer is stamped from the session');
select throws_ok(format($$select app.verify_onboarding_insureds('%s')$$, pg_temp.id('item_crew')), 'XR001', null,
  'a party that is not a vendor of the org is refused');
select pg_temp.as_user('dave');
select throws_ok(format($$select app.verify_onboarding_insureds('%s')$$, pg_temp.id('item')), '42501', null, 'a Member without onboarding write is refused');
select pg_temp.as_user('xavier');
select throws_ok(format($$select app.verify_onboarding_insureds('%s')$$, pg_temp.id('item')), '42501', null, 'cross-tenant: another org is refused');
select pg_temp.as_user('victor');
select throws_ok(format($$select app.verify_onboarding_insureds('%s')$$, pg_temp.id('item')), '42501', null, 'the engaged account never verifies itself');
select pg_temp.as_platform();
update app.required_additional_insureds set deleted_at = now() where org_id = pg_temp.id('org_a');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.verify_onboarding_insureds('%s')$$, pg_temp.id('item')), 'XR001',
  'insureds_none_required: The org requires no additional insureds for this project. Add them under Vendors, Insurance certificates first.',
  'with nothing required the step refuses rather than passing');

-- The vendor's view ----------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select pg_temp.move_engagement('eng', 'Onboarding', 'Active');
select is(pg_temp.n('victor', 'select 1 from api_external.vendor_certificate_insureds'), 4, 'the account reads the insureds on its certificates');
select is(pg_temp.n('ivy', 'select 1 from api_external.vendor_certificate_insureds'), 0, 'another party reads none');

select * from finish();
rollback;
