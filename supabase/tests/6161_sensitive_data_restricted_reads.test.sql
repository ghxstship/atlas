-- pgTAP: migration 6161 (ADR 0164, extends ADR 0105). Dietary and accessibility values are Restricted: never selectable, read
-- by the person through app.my_work_detail_needs, by the Owner and the medical roles through the logged roster read, locked
-- for hospitality readers and always for the company, absent for anyone while consent does not stand, and refused in any
-- export. A supplier diversity kind is Restricted as well.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(19);

create function pg_temp.read(p_who text, p_engagement text) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_user(p_who);
  v := app.shared_work_details(pg_temp.id(p_engagement));
  perform pg_temp.as_platform();
  return v;
end $$;

select is_empty($$
  select c.column_name from private.column_classifications c
  where c.table_name = 'app.person_work_details' and c.column_name in ('dietary_needs', 'dietary_notes', 'allergies', 'accessibility_needs', 'accessibility_notes')
    and (c.classification <> 'Restricted' or c.read_capability <> 'data.restricted.read.medical')
$$, 'dietary, allergy and accessibility columns are Restricted under the medical capability');
select ok(not has_column_privilege('authenticated', 'app.person_work_details', 'dietary_needs', 'SELECT')
  and not has_column_privilege('authenticated', 'app.person_work_details', 'accessibility_notes', 'SELECT'), 'and never directly selectable');
select ok(not has_column_privilege('authenticated', 'app.supplier_diversity_certifications', 'diversity_kind', 'SELECT'),
  'nor is a supplier diversity kind');

select pg_temp.as_user('ivy');
select app.ensure_my_work_details();
select app.give_sensitive_consent('Dietary and Allergies', '2026-11-06', 'en-US', 'Atlas');
select app.give_sensitive_consent('Accessibility', '2026-11-06', 'en-US', 'Atlas');
update app.person_work_details set dietary_needs = '{Vegan}', dietary_notes = 'No pork', allergies = 'Peanuts',
  accessibility_needs = '{Seating}', accessibility_notes = 'Near an exit' where person_id = pg_temp.id('ivy');
select app.share_work_details(pg_temp.id('eng_ivy_a'), '{Dietary Needs,Accessibility Needs}');
select results_eq($$select dietary_notes, accessibility_notes from app.my_work_detail_needs()$$,
  $$values ('No pork'::text, 'Near an exit'::text)$$, 'she reads her own');
select throws_ok($$select dietary_needs from app.person_work_details$$, '42501', null, 'and not directly');
select throws_ok($$select app.request_export(pg_temp.id('org_a'), 'CSV', 'Dietary', array['app.person_work_details.dietary_needs'])$$, '42501', null,
  'a person outside the org exports nothing');
select pg_temp.as_platform();

-- Bob reads hospitality and holds no medical capability; Alice is the Owner.
select is(pg_temp.read('bob', 'eng_ivy_a') #>> '{dietary,dietary_masked}', 'true', 'a hospitality reader sees dietary needs locked');
select is(pg_temp.read('bob', 'eng_ivy_a') #>> '{dietary,dietary_needs}', '[]', 'with nothing in them');
select is(pg_temp.read('bob', 'eng_ivy_a') #>> '{accessibility,accessibility_masked}', 'true', 'and accessibility needs locked');
select ok(pg_temp.read('bob', 'eng_ivy_a') #> '{accessibility,accessibility_notes}' = 'null'::jsonb, 'with no notes');

create temporary table before_owner as select count(*)::int as views from app.work_detail_events
  where person_id = pg_temp.id('ivy') and action = 'dietary_needs.viewed';
select is(pg_temp.read('alice', 'eng_ivy_a') #>> '{dietary,dietary_needs,0}', 'Vegan', 'the Owner reads them');
select is(pg_temp.read('alice', 'eng_ivy_a') #>> '{accessibility,accessibility_notes}', 'Near an exit', 'and the accessibility notes');
select is(pg_temp.read('alice', 'eng_ivy_a') #>> '{medical,dietary_notes}', 'No pork', 'in the medical block too');
select is((select count(*)::int from app.work_detail_events where person_id = pg_temp.id('ivy') and action = 'dietary_needs.viewed') - (select views from before_owner), 3,
  'every unmasked read is logged');

-- Exports refuse them for everyone.
select pg_temp.as_user('alice');
select throws_like($$select app.request_export(pg_temp.id('org_a'), 'CSV', 'Dietary', array['app.person_work_details.dietary_needs'])$$,
  'export_medical_excluded:%', 'even the Owner exports no dietary column');
select throws_like($$select app.request_export(pg_temp.id('org_a'), 'CSV', 'Accessibility', array['app.person_work_details.accessibility_notes'])$$,
  'export_medical_excluded:%', 'and no accessibility column');
select pg_temp.as_platform();

-- No consent, nothing leaves.
select pg_temp.as_user('ivy');
select app.withdraw_sensitive_consent('Accessibility');
select pg_temp.as_platform();
select ok(pg_temp.read('alice', 'eng_ivy_a') -> 'accessibility' = 'null'::jsonb, 'once withdrawn the category is off the share');
update app.sensitive_data_consents set withdrawn_at = now() where person_id = pg_temp.id('ivy') and category = 'Dietary and Allergies';
select is(pg_temp.read('alice', 'eng_ivy_a') #>> '{dietary,dietary_needs}', '[]', 'with no standing consent nothing reads, even for the Owner');
select ok(pg_temp.read('alice', 'eng_ivy_a') #> '{dietary,allergies}' = 'null'::jsonb, 'allergies included');

select * from finish();
rollback;
