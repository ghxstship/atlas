-- pgTAP: migration 6160 (ADR 0164). A new dietary, allergy, accessibility or supplier diversity value needs a recorded
-- consent; clearing never does, and nothing else on the row needs it. A consent records the text version, the language,
-- the surface, the person and the time; it changes only by a one-time withdrawal. Withdrawing stops use and clears the
-- values and the shares, unless a legal hold reaches the person. A company declares only under its Owner's or Admin's
-- attestation, and withdrawing de-identifies its certifications. The field record never holds a value.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(38);

create function pg_temp.fields(p_person text) returns text[]
language sql as $$
  select coalesce(array_agg(r.field_code order by r.field_code), '{}') from app.sensitive_field_records r
  where r.person_id = pg_temp.id(p_person) and r.cleared_at is null
$$;

-- Schema --------------------------------------------------------------------------------------------------------------
select is_empty($$
  select c.column_name from information_schema.columns c
  where c.table_schema = 'app' and c.table_name = 'sensitive_field_records'
    and c.column_name in ('value', 'dietary_needs', 'allergies', 'dietary_notes', 'accessibility_needs', 'accessibility_notes')
$$, 'the field record has no column for a value');
select is_empty($$
  select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('app', 'private') and p.proname in ('give_sensitive_consent', 'withdraw_sensitive_consent', 'my_sensitive_consents',
    'guard_sensitive_data_consent', 'sensitive_consent_id', 'sensitive_consent_stands', 'sensitive_account_consent_id',
    'record_sensitive_field', 'erase_sensitive_category', 'erase_supplier_diversity_values', 'person_on_legal_hold',
    'remove_work_detail_share_category', 'erase_sensitive_consents', 'assert_sensitive_notice', 'close_sensitive_consent')
    and obj_description(p.oid, 'pg_proc') is null
$$, 'every function has a comment');
select ok(not has_table_privilege('authenticated', 'app.sensitive_data_consents', 'INSERT')
  and not has_table_privilege('authenticated', 'app.sensitive_data_consents', 'UPDATE'), 'nobody signed in writes a consent directly');
select ok(not has_table_privilege('authenticated', 'app.sensitive_field_records', 'INSERT')
  and not has_table_privilege('authenticated', 'app.sensitive_field_records', 'UPDATE'), 'or a field record');

-- No consent ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select app.ensure_my_work_details();
select throws_like($$update app.person_work_details set allergies = 'Peanuts' where person_id = pg_temp.id('ivy')$$,
  'sensitive_consent_required:%', 'an allergy is refused without consent');
select throws_like($$update app.person_work_details set dietary_needs = '{Vegan}' where person_id = pg_temp.id('ivy')$$,
  'sensitive_consent_required:%', 'a dietary need too');
select throws_like($$update app.person_work_details set accessibility_notes = 'Step-free route' where person_id = pg_temp.id('ivy')$$,
  'sensitive_consent_required:%', 'an accessibility note too');
select lives_ok($$update app.person_work_details set passport_issuing_country = 'IT' where person_id = pg_temp.id('ivy')$$,
  'everything else on the row still saves');
select is((select count(*)::int from app.sensitive_field_records where person_id = pg_temp.id('ivy')), 0, 'no field record yet');

-- Giving --------------------------------------------------------------------------------------------------------------
select throws_like($$select app.give_sensitive_consent('Dietary and Allergies', '1999-01-01', 'en-US', 'Gateway')$$,
  'sensitive_notice_version:%', 'an unknown wording version is refused');
select throws_like($$select app.give_sensitive_consent('Dietary and Allergies', '2026-11-06', 'nonsense', 'Gateway')$$,
  'sensitive_notice_locale:%', 'and a consent with no language');
select lives_ok($$select app.give_sensitive_consent('Dietary and Allergies', '2026-11-06', 'es-US', 'Compass')$$, 'she consents');
select is((select app.give_sensitive_consent('Dietary and Allergies', '2026-11-06', 'es-US', 'Compass')),
  (select id from app.sensitive_data_consents where person_id = pg_temp.id('ivy') and category = 'Dietary and Allergies'),
  'consenting again returns the same grant');
select results_eq($$select notice_version, locale, surface::text, basis::text, given_by, withdrawn_at is null
    from app.sensitive_data_consents where person_id = pg_temp.id('ivy') and category = 'Dietary and Allergies'$$,
  $$values ('2026-11-06'::text, 'es-US'::text, 'Compass'::text, 'Own Consent'::text, pg_temp.id('ivy'), true)$$,
  'the record holds the text version, the language, the surface, the person and that it stands');
select is((select count(*)::int from app.my_sensitive_consents()), 1, 'she reads her standing consent');
select throws_ok($$insert into app.sensitive_data_consents (category, basis, person_id, notice_version, locale, surface, given_by)
  values ('Accessibility', 'Own Consent', pg_temp.id('ivy'), '2026-11-06', 'en-US', 'API', pg_temp.id('ivy'))$$, '42501', null,
  'and never writes one directly');

select lives_ok($$update app.person_work_details set allergies = 'Peanuts', dietary_needs = '{Vegan}' where person_id = pg_temp.id('ivy')$$,
  'with consent the values save');
select throws_like($$update app.person_work_details set accessibility_needs = '{Seating}' where person_id = pg_temp.id('ivy')$$,
  'sensitive_consent_required:%', 'consent is specific: dietary consent does not cover accessibility');
select is(pg_temp.fields('ivy'), array['allergies', 'dietary_needs'], 'the field record names the fields held, field by field');
select ok((select bool_and(consent_id = (select id from app.sensitive_data_consents where person_id = pg_temp.id('ivy') and category = 'Dietary and Allergies'))
  from app.sensitive_field_records where person_id = pg_temp.id('ivy')), 'each stands on the consent');
select is((select count(*)::int from app.work_detail_events where person_id = pg_temp.id('ivy') and action = 'sensitive_consent.given'), 1,
  'her access log shows it');

-- It is evidence ------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select throws_like($$update app.sensitive_data_consents set notice_version = '2026-11-06.1' where person_id = pg_temp.id('ivy')$$,
  'consent_immutable:%', 'a consent never changes');

-- Withdrawing ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('ivy');
select app.share_work_details(pg_temp.id('eng_ivy_a'), '{Dietary Needs,Emergency Contacts}');
select ok((select app.withdraw_sensitive_consent('Dietary and Allergies')), 'she withdraws in one call');
select pg_temp.as_platform();
select results_eq($$select allergies, dietary_notes, cardinality(dietary_needs) from app.person_work_details where person_id = pg_temp.id('ivy')$$,
  $$values (null::text, null::text, 0)$$, 'the values are cleared');
select ok((select withdrawn_at is not null and withdrawn_by = pg_temp.id('ivy') from app.sensitive_data_consents
  where person_id = pg_temp.id('ivy') and category = 'Dietary and Allergies'), 'the withdrawal is recorded, with who');
select is(pg_temp.fields('ivy'), '{}'::text[], 'the field record shows them cleared');
select is((select categories::text from app.work_detail_shares where person_id = pg_temp.id('ivy') and revoked_at is null),
  '{"Emergency Contacts"}', 'the category leaves her shares');
select pg_temp.as_user('ivy');
select throws_like($$update app.person_work_details set allergies = 'Peanuts' where person_id = pg_temp.id('ivy')$$,
  'sensitive_consent_required:%', 'and a new value needs consent again');
select lives_ok($$select app.give_sensitive_consent('Dietary and Allergies', '2026-11-06', 'en-US', 'Gateway')$$, 'a new grant opens a new row');
select is((select count(*)::int from app.sensitive_data_consents where person_id = pg_temp.id('ivy')), 2, 'the old one stays as evidence');

-- A legal hold keeps the values, hidden -------------------------------------------------------------------------------
update app.person_work_details set allergies = 'Peanuts' where person_id = pg_temp.id('ivy');
select pg_temp.as_platform();
insert into app.legal_holds (org_id, matter) values (pg_temp.id('org_a'), 'Crew dispute 2026-14.');
select pg_temp.as_user('ivy');
select ok(not (select app.withdraw_sensitive_consent('Dietary and Allergies')), 'under a legal hold the withdrawal says the values stay');
select pg_temp.as_platform();
select is((select allergies from app.person_work_details where person_id = pg_temp.id('ivy')), 'Peanuts', 'they stay');
select ok(not private.sensitive_consent_stands(pg_temp.id('ivy'), 'Dietary and Allergies'), 'but the consent is gone, so use has stopped');
update app.legal_holds set released_at = now() where org_id = pg_temp.id('org_a') and released_at is null;

-- A company -----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('victor');
select throws_like($$select app.add_supplier_diversity_certification('Minority-Owned', 'NMSDC', p_account_id => pg_temp.id('acct_v'))$$,
  'sensitive_consent_required:%', 'a company declares nothing without an attestation');
select throws_like($$select app.give_sensitive_consent('Supplier Diversity', '2026-11-06', 'en-US', 'Gateway', pg_temp.id('acct_v'))$$,
  'sensitive_attestation_required:%', 'and the attestation names both statements');
select lives_ok($$select app.give_sensitive_consent('Supplier Diversity', '2026-11-06', 'en-US', 'Gateway', pg_temp.id('acct_v'), true, true)$$,
  'the Owner attests');
select app.add_supplier_diversity_certification('Minority-Owned', 'NMSDC', p_account_id => pg_temp.id('acct_v'), p_certificate_number => 'NM-12345');
select lives_ok($$select app.withdraw_sensitive_consent('Supplier Diversity', pg_temp.id('acct_v'))$$, 'the Owner withdraws');
select pg_temp.as_platform();
select results_eq($$select diversity_kind::text, certifying_body, certificate_number is null, deleted_at is not null
    from app.supplier_diversity_certifications where account_id = pg_temp.id('acct_v')$$,
  $$values ('Other'::text, 'Removed'::text, true, true)$$, 'the certification is de-identified and removed');

select * from finish();
rollback;
