-- pgTAP: migration 6162 (ADR 0164). A guest's needs are optional and need the keeper's attestation, recorded with who gave it.
-- The guest with an account is told, sees it and removes it. Only medical readers read the values, each read logged. A person
-- who withdrew cannot be attested back in. The door note, an import column and a custom field refuse sensitive words. A meal
-- preference needs the person's consent, or the company's attestation.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(34);

-- A guest on Alice's project, kept by Carol (advancing.rider.write).
select pg_temp.as_user('carol');
with x as (insert into app.guest_list_entries (project_id, guest_name) values (pg_temp.id('prj_a'), 'Jordan Vale') returning id)
  insert into world select 'guest_a', id from x;

select throws_like($$select app.set_guest_care_needs(pg_temp.id('guest_a'), '{Vegan}')$$,
  'sensitive_attestation_required:%', 'needs are refused without the two statements');
select throws_like($$select app.set_guest_care_needs(pg_temp.id('guest_a'), '{Vegan}', p_authority_confirmed => true)$$,
  'sensitive_attestation_required:%', 'one is not enough');
select throws_like($$select app.set_guest_care_needs(pg_temp.id('guest_a'), '{Vegan}', p_authority_confirmed => true, p_notice_confirmed => true,
    p_notice_version => 'old', p_locale => 'en-US')$$,
  'sensitive_notice_version:%', 'and with a wording that is not current');
select is((select app.set_guest_care_needs(pg_temp.id('guest_a'))), null, 'nothing given asks for nothing: not one field is required');

select lives_ok($$select app.set_guest_care_needs(pg_temp.id('guest_a'), '{Vegan,Kosher,Vegan}', 'Peanuts, severe', null, '{Seating}', null,
    'quinn@freelance.test', true, true, '2026-11-06', 'en-US', 'Atlas')$$, 'with the statements the keeper sets them');
select pg_temp.as_platform();
select results_eq($$select basis::text, authority_confirmed, notice_confirmed, given_by, surface::text, org_id
    from app.sensitive_data_consents where guest_list_entry_id = pg_temp.id('guest_a') order by category$$,
  $$values ('Attested Authority'::text, true, true, pg_temp.id('carol'), 'Atlas'::text, pg_temp.id('org_a')),
           ('Attested Authority'::text, true, true, pg_temp.id('carol'), 'Atlas'::text, pg_temp.id('org_a'))$$,
  'the attestation is recorded per category, with who gave it');
select is((select person_id from app.sensitive_data_consents where guest_list_entry_id = pg_temp.id('guest_a') limit 1), pg_temp.id('quinn'),
  'an email matching a verified sign-in names that person');
select is((select count(*)::int from app.sensitive_field_records where guest_list_entry_id = pg_temp.id('guest_a') and cleared_at is null), 3,
  'the field record names each field held');
select is((select dietary_needs::text from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_a')), '{Vegan,Kosher}', 'kept once each');

-- Who reads ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select count(*)::int from app.guest_care_needs_states(pg_temp.id('prj_a'))), 1, 'the keeper sees that needs are on file');
select throws_ok($$select allergies from app.guest_care_needs$$, '42501', null, 'never the column');
select throws_ok($$select * from app.read_guest_care_needs(pg_temp.id('prj_a'))$$, '42501', null, 'and cannot read the values back');
select pg_temp.as_user('alice');
select is((select allergies from app.read_guest_care_needs(pg_temp.id('prj_a'))), 'Peanuts, severe', 'the Owner reads them');
select ok(app.can_read_guest_care_needs(pg_temp.id('prj_a')), 'the page knows she may');
select pg_temp.as_platform();
select is((select count(*)::int from app.audit_events where org_id = pg_temp.id('org_a') and action = 'guest_needs.viewed'), 1, 'the read is audited');
select is((select count(*)::int from app.work_detail_events where person_id = pg_temp.id('quinn') and action = 'guest_needs.viewed'), 1,
  'and in the access log of the guest with an account');

-- The person with an account -------------------------------------------------------------------------------------------
select is((select count(*)::int from app.notifications n where n.recipient_person_id = pg_temp.id('quinn') and n.kind = 'account.sensitive_data_attested'), 2,
  'the guest is told, once per category');
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.sensitive_entries_about_me()), 2, 'the guest sees each attestation');
select is((select given_by_name from app.sensitive_entries_about_me() limit 1), 'Carol Nguyen', 'and who gave it');
select lives_ok($$select app.remove_sensitive_entry((select consent_id from app.sensitive_entries_about_me() where category = 'Accessibility'))$$, 'and removes one');
select pg_temp.as_platform();
select is((select cardinality(accessibility_needs) from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_a')), 0, 'those values go');
select is((select allergies from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_a')), 'Peanuts, severe', 'the other category stays');

select pg_temp.as_user('quinn');
select app.give_sensitive_consent('Dietary and Allergies', '2026-11-06', 'en-US', 'Gateway');
select app.withdraw_sensitive_consent('Dietary and Allergies');
select pg_temp.as_platform();
select is((select count(*)::int from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_a')), 0, 'withdrawing clears what was attested about her');
select pg_temp.as_user('carol');
select throws_like($$select app.set_guest_care_needs(pg_temp.id('guest_a'), '{Vegan}', null, null, '{}', null, 'quinn@freelance.test', true, true, '2026-11-06', 'en-US', 'Atlas')$$,
  'sensitive_person_withdrew:%', 'and nobody attests her back in');

-- The guest goes, the needs go ------------------------------------------------------------------------------------------
select app.set_guest_care_needs(pg_temp.id('guest_a'), '{Halal}', null, null, '{}', null, null, true, true, '2026-11-06', 'en-US', 'Atlas');
update app.guest_list_entries set deleted_at = now() where id = pg_temp.id('guest_a');
select pg_temp.as_platform();
select is((select count(*)::int from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_a')), 0, 'removing the guest deletes the needs');
select ok((select bool_and(withdrawn_at is not null) from app.sensitive_data_consents where guest_list_entry_id = pg_temp.id('guest_a')), 'and closes the attestation');

-- Free text with no consent step ----------------------------------------------------------------------------------------
select ok(private.looks_sensitive('Nut allergy') and private.looks_sensitive('silla de ruedas') and not private.looks_sensitive('Side stage, press'),
  'the backstop knows the common words, in both languages, and leaves a door note alone');
select pg_temp.as_user('carol');
select throws_like($$insert into app.guest_list_entries (project_id, guest_name, note) values (pg_temp.id('prj_a'), 'Sam Reed', 'Vegan, nut allergy')$$,
  'guest_note_sensitive:%', 'a door note refuses it');
select lives_ok($$insert into app.guest_list_entries (project_id, guest_name, note) values (pg_temp.id('prj_a'), 'Sam Reed', 'Side stage')$$,
  'and takes anything else');
select pg_temp.as_platform();

-- A meal preference ---------------------------------------------------------------------------------------------------
select ok(exists (select 1 from private.sensitive_fields where code = 'meal_preference'), 'a meal preference is a sensitive field');
select ok(has_function_privilege('authenticated', 'app.attest_roster_meal_preference(uuid, text, text, app.sensitive_consent_surface, boolean, boolean)', 'EXECUTE')
  and not has_function_privilege('anon', 'app.attest_roster_meal_preference(uuid, text, text, app.sensitive_consent_surface, boolean, boolean)', 'EXECUTE'),
  'the company attests through an RPC');

-- Custom fields and imports ---------------------------------------------------------------------------------------------
select table_name as v_target from private.custom_field_targets limit 1 \gset
select pg_temp.as_user('alice');
select throws_like(format($$insert into app.custom_field_definitions (org_id, target_table, field_key, label, data_type, sort_order)
  values (%L, %L, 'dietary', 'Dietary restrictions', 'Text', 1)$$, pg_temp.id('org_a'), :'v_target'),
  'custom_field_sensitive:%', 'a custom field cannot be a dietary field');
select pg_temp.as_platform();

select ok(exists (select 1 from pg_trigger where tgname = 't42_refuse_sensitive_import_column'), 'an import column naming it is refused');
select is((select count(*)::int from private.ai_excluded_tables where table_name = 'app.guest_care_needs'), 1, 'and no AI feature reads guest needs');

select * from finish();
rollback;
