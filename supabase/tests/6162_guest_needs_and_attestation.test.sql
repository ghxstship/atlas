-- pgTAP: migration 6162 (ADR 0164). A guest's needs are optional and need the keeper's attestation, recorded with who gave it,
-- and another keeper or another matched person is a new attestation. The guest with an account is told, sees it and removes
-- it, also when it only names their verified email so far. Only medical readers read the values, per category, each read
-- logged. A person who withdrew cannot be attested back in, and the caller cannot tell. Account deletion closes it, a legal
-- hold defers every deletion, and a project with no end date still lets it go. The door note, travel notes, an import column,
-- a custom field and questions to fill in refuse sensitive words. A meal preference needs the person's consent, or the
-- company's attestation.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

-- A guest on Alice's project, kept by Carol (advancing.rider.write).
select pg_temp.as_user('carol');
with x as (insert into app.guest_list_entries (project_id, guest_name) values (pg_temp.id('prj_a'), 'Jordan Vale') returning id)
  insert into world select 'guest_a', id from x;

select throws_like($$select app.set_guest_care_needs(pg_temp.id('guest_a'), '{Vegan}')$$,
  'sensitive_attestation_required:%', 'needs are refused without the two statements');
select throws_like($$select app.set_guest_care_needs(pg_temp.id('guest_a'), '{Vegan}', p_authority_confirmed => true)$$,
  'sensitive_attestation_required:%', 'one is not enough');
select throws_like($$select app.set_guest_care_needs(pg_temp.id('guest_a'), '{Vegan}', p_authority_confirmed => true, p_notice_confirmed => true,
    p_dietary_notice_version => 'old', p_locale => 'en-US')$$,
  'sensitive_notice_version:%', 'and with a wording that is not current');
select is((select app.set_guest_care_needs(pg_temp.id('guest_a'))), null, 'nothing given asks for nothing: not one field is required');

select lives_ok($$select app.set_guest_care_needs(pg_temp.id('guest_a'), '{Vegan,Kosher,Vegan}', 'Peanuts, severe', null, '{Seating}', null,
    'quinn@freelance.test', true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas')$$, 'with the statements the keeper sets them');
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
-- Nobody attests her back in, and whoever types her email cannot tell an account or a withdrawal from a stranger's address.
create temporary table answers as select app.set_guest_care_needs(pg_temp.id('guest_a'), '{Vegan}', null, null, '{}', null, 'quinn@freelance.test', true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas') as withdrew;
select is((select withdrew from answers), pg_temp.id('guest_a'), 'typing the email of someone who withdrew is not refused');
select pg_temp.as_platform();
select is((select count(*)::int from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_a')), 0, 'and saves none of it');
select is((select count(*)::int from app.sensitive_data_consents where guest_list_entry_id = pg_temp.id('guest_a') and withdrawn_at is null and person_id is null), 1,
  'the attestation stands, naming nobody');
select is((select count(*)::int from app.work_detail_events where person_id = pg_temp.id('quinn') and action = 'sensitive_consent.attestation_not_saved'), 1, 'only her access log shows it');
select pg_temp.as_user('carol');
select is((select categories::text from app.guest_care_needs_states(pg_temp.id('prj_a'))), '{"Dietary and Allergies"}', 'the keeper sees what she would see for anyone');
select is(app.set_guest_care_needs(pg_temp.id('guest_a'), '{Vegan}', null, null, '{}', null, 'nobody-here@elsewhere.test', true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas'),
  pg_temp.id('guest_a'), 'an address with no account gets the same answer');
select lives_ok($$select app.clear_guest_care_needs(pg_temp.id('guest_a'))$$, 'and the keeper clears it');

-- A changed email or another keeper is a new attestation ------------------------------------------------------------------
select pg_temp.as_platform();
select pg_temp.new_user('rae', 'rae@freelance.test', 'Rae Solano');
select pg_temp.new_user('tam', 'tam@freelance.test', 'Tam Okafor');
select pg_temp.join_org('alice', 'org_a', 'rae', 'member');
select pg_temp.join_org('alice', 'org_a', 'tam', 'member');
select pg_temp.as_platform();
create function pg_temp.told(p_who text) returns integer
language sql as $$
  select count(*)::int from app.notifications n where n.recipient_person_id = pg_temp.id(p_who) and n.kind = 'account.sensitive_data_attested'
$$;
select pg_temp.as_user('carol');
with x as (insert into app.guest_list_entries (project_id, guest_name) values (pg_temp.id('prj_a'), 'Rae Solano') returning id)
  insert into world select 'guest_r', id from x;
select app.set_guest_care_needs(pg_temp.id('guest_r'), '{Vegan}', null, null, '{}', null, null, true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
select pg_temp.as_platform();
select is((select person_id from app.sensitive_data_consents where guest_list_entry_id = pg_temp.id('guest_r') and withdrawn_at is null), null, 'no email names nobody');
select pg_temp.as_user('carol');
select app.set_guest_care_needs(pg_temp.id('guest_r'), '{Vegan}', null, null, '{}', null, 'rae@freelance.test', true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
select pg_temp.as_platform();
select is((select person_id from app.sensitive_data_consents where guest_list_entry_id = pg_temp.id('guest_r') and withdrawn_at is null), pg_temp.id('rae'), 'an email added later names her');
select is(pg_temp.told('rae'), 1, 'and she is told');
select pg_temp.as_user('carol');
select app.set_guest_care_needs(pg_temp.id('guest_r'), '{Halal}', null, null, '{}', null, 'tam@freelance.test', true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
select pg_temp.as_user('rae');
select is((select count(*)::int from app.sensitive_entries_about_me()), 0, 'correcting the email: the first person no longer reads the guest''s values');
select throws_like(format($$select app.remove_sensitive_entry(%L)$$, (select c.id from app.sensitive_data_consents c where c.person_id = pg_temp.id('rae') and c.guest_list_entry_id = pg_temp.id('guest_r') limit 1)),
  'sensitive_entry_not_yours:%', 'and cannot delete them');
select pg_temp.as_platform();
select is(pg_temp.told('tam'), 1, 'the second person is told');
select is((select person_id from app.sensitive_field_records where guest_list_entry_id = pg_temp.id('guest_r') and field_code = 'guest_dietary_needs'), pg_temp.id('tam'),
  'and the field record names her');
select pg_temp.as_user('alice');
select app.set_guest_care_needs(pg_temp.id('guest_r'), '{Kosher}', null, null, '{}', null, 'tam@freelance.test', true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
select pg_temp.as_platform();
select is((select given_by from app.sensitive_data_consents where guest_list_entry_id = pg_temp.id('guest_r') and withdrawn_at is null), pg_temp.id('alice'),
  'another keeper entering values is recorded as who attested');
select is((select count(*)::int from app.sensitive_data_consents where guest_list_entry_id = pg_temp.id('guest_r') and withdrawn_at is not null and withdrawn_by = pg_temp.id('tam')), 0,
  'and what she replaced does not read as a withdrawal by the person');

-- A category read stands on its own attestation ---------------------------------------------------------------------------
insert into app.legal_holds (org_id, table_name, matter) values (pg_temp.id('org_a'), 'app.guest_care_needs', 'Guest dispute 2026-22.');
select pg_temp.as_user('carol');
with x as (insert into app.guest_list_entries (project_id, guest_name) values (pg_temp.id('prj_a'), 'Held Guest') returning id)
  insert into world select 'guest_h', id from x;
select app.set_guest_care_needs(pg_temp.id('guest_h'), '{Vegan}', 'Sesame', null, '{Seating}', null, null, true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
select app.set_guest_care_needs(pg_temp.id('guest_h'), '{Vegan}', 'Sesame', null, '{}', null, null, true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
select pg_temp.as_platform();
select is((select cardinality(accessibility_needs) from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_h')), 1, 'a hold keeps a removed category''s values');
select pg_temp.as_user('alice');
select is((select cardinality(accessibility_needs) from app.read_guest_care_needs(pg_temp.id('prj_a')) where guest_list_entry_id = pg_temp.id('guest_h')), 0,
  'and it reads as absent though the other category stands');
select is((select allergies from app.read_guest_care_needs(pg_temp.id('prj_a')) where guest_list_entry_id = pg_temp.id('guest_h')), 'Sesame', 'the other category still reads');
select pg_temp.as_user('carol');
update app.guest_list_entries set deleted_at = now() where id = pg_temp.id('guest_h');
select pg_temp.as_platform();
select is((select allergies from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_h')), 'Sesame', 'removing the guest under a hold keeps the values');
select ok((select bool_and(withdrawn_at is not null) from app.sensitive_data_consents where guest_list_entry_id = pg_temp.id('guest_h')), 'and closes the attestation');
select private.run_sensitive_data_job();
select is((select allergies from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_h')), 'Sesame', 'the job leaves them while the hold stands');
update app.legal_holds set released_at = now() where org_id = pg_temp.id('org_a') and table_name = 'app.guest_care_needs';
select private.run_sensitive_data_job();
select is((select count(*)::int from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_h')), 0, 'and deletes them when it ends');

-- An account opened later -------------------------------------------------------------------------------------------------
select pg_temp.new_user('lee', 'lee@freelance.test', 'Lee Quiroga');
select pg_temp.join_org('alice', 'org_a', 'lee', 'member');
select pg_temp.as_platform();
update auth.users set email_confirmed_at = null where id = (select user_id from app.people where id = pg_temp.id('lee'));
select pg_temp.as_user('carol');
with x as (insert into app.guest_list_entries (project_id, guest_name) values (pg_temp.id('prj_a'), 'Lee Quiroga') returning id)
  insert into world select 'guest_l', id from x;
select app.set_guest_care_needs(pg_temp.id('guest_l'), '{Vegan}', null, null, '{Seating}', null, 'lee@freelance.test', true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
select pg_temp.as_platform();
select is((select guest_person_id from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_l')), null, 'an unconfirmed address names nobody');
update auth.users set email_confirmed_at = now() where id = (select user_id from app.people where id = pg_temp.id('lee'));
select private.run_sensitive_data_job();
select is((select guest_person_id from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_l')), pg_temp.id('lee'), 'once confirmed the job links it');
select is(pg_temp.told('lee'), 2, 'and tells her, once per category');
-- Before the job has run, withdrawing finds it by the verified email.
select pg_temp.new_user('nia', 'nia@freelance.test', 'Nia Bello');
update auth.users set email_confirmed_at = null where id = (select user_id from app.people where id = pg_temp.id('nia'));
select pg_temp.as_user('carol');
with x as (insert into app.guest_list_entries (project_id, guest_name) values (pg_temp.id('prj_a'), 'Nia Bello') returning id)
  insert into world select 'guest_n', id from x;
select app.set_guest_care_needs(pg_temp.id('guest_n'), '{Vegan}', null, null, '{}', null, 'nia@freelance.test', true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
select pg_temp.as_platform();
update auth.users set email_confirmed_at = now() where id = (select user_id from app.people where id = pg_temp.id('nia'));
select pg_temp.as_user('nia');
select is((select count(*)::int from app.sensitive_entries_about_me()), 1, 'she already sees it by her email');
select app.withdraw_sensitive_consent('Dietary and Allergies');
select pg_temp.as_platform();
select is((select count(*)::int from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_n')), 0, 'and withdrawing clears it');

-- Account deletion --------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.guest_list_entries (project_id, guest_name) values (pg_temp.id('prj_a'), 'Lee Again') returning id)
  insert into world select 'guest_l2', id from x;
select pg_temp.as_platform();
update auth.users set email_confirmed_at = null where id = (select user_id from app.people where id = pg_temp.id('lee'));
select pg_temp.as_user('carol');
select app.set_guest_care_needs(pg_temp.id('guest_l2'), '{Halal}', null, null, '{}', null, 'lee@freelance.test', true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
select pg_temp.as_platform();
update auth.users set email_confirmed_at = now() where id = (select user_id from app.people where id = pg_temp.id('lee'));
update app.people set deleted_at = now() where id = pg_temp.id('lee');
select is((select count(*)::int from app.guest_care_needs where guest_list_entry_id in (pg_temp.id('guest_l'), pg_temp.id('guest_l2'))), 0,
  'deleting the account deletes what a guest list holds about her, under her person or only her email');
select ok((select bool_and(withdrawn_at is not null) from app.sensitive_data_consents where guest_list_entry_id in (pg_temp.id('guest_l'), pg_temp.id('guest_l2'))),
  'and closes those attestations');

-- Open-ended and ended projects ---------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.guest_list_entries (project_id, guest_name) values (pg_temp.id('prj_a'), 'Open Ended') returning id)
  insert into world select 'guest_o', id from x;
select app.set_guest_care_needs(pg_temp.id('guest_o'), '{Vegan}', null, null, '{}', null, null, true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
select pg_temp.as_platform();
update app.projects set ends_on = null where id = pg_temp.id('prj_a');
select private.run_sensitive_data_job();
select is((select count(*)::int from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_o')), 1, 'a project with no end date keeps them for now');
alter table app.guest_care_needs disable trigger user;
update app.guest_care_needs set updated_at = now() - interval '13 months' where guest_list_entry_id = pg_temp.id('guest_o');
alter table app.guest_care_needs enable trigger user;
alter table app.sensitive_data_consents disable trigger user;
update app.sensitive_data_consents set given_at = now() - interval '13 months' where guest_list_entry_id = pg_temp.id('guest_o');
alter table app.sensitive_data_consents enable trigger user;
select private.run_sensitive_data_job();
select is((select count(*)::int from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_o')), 0, 'and deletes them a year after they last changed');
select pg_temp.as_user('carol');
with x as (insert into app.guest_list_entries (project_id, guest_name) values (pg_temp.id('prj_a'), 'Ended') returning id)
  insert into world select 'guest_e', id from x;
select app.set_guest_care_needs(pg_temp.id('guest_e'), '{Vegan}', null, null, '{}', null, null, true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
select pg_temp.as_platform();
update app.projects set starts_on = null, ends_on = (now() - interval '91 days')::date where id = pg_temp.id('prj_a');
insert into app.legal_holds (org_id, table_name, matter) values (pg_temp.id('org_a'), 'app.guest_care_needs', 'Guest dispute 2026-23.');
select private.run_sensitive_data_job();
select is((select count(*)::int from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_e')), 1, 'a hold defers the 90 days after the project ends');
update app.legal_holds set released_at = now() where org_id = pg_temp.id('org_a') and table_name = 'app.guest_care_needs' and released_at is null;
select private.run_sensitive_data_job();
select is((select count(*)::int from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_e')), 0, 'and then it runs');
update app.projects set ends_on = null where id = pg_temp.id('prj_a');
select pg_temp.as_user('carol');

-- The guest goes, the needs go ------------------------------------------------------------------------------------------
select app.set_guest_care_needs(pg_temp.id('guest_a'), '{Halal}', null, null, '{}', null, null, true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
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
select ok(has_function_privilege('authenticated', 'app.attest_roster_meal_preference(uuid, text, text, app.sensitive_consent_surface, boolean, boolean, inet)', 'EXECUTE')
  and not has_function_privilege('anon', 'app.attest_roster_meal_preference(uuid, text, text, app.sensitive_consent_surface, boolean, boolean, inet)', 'EXECUTE'),
  'the company attests through an RPC');

-- Custom fields and imports ---------------------------------------------------------------------------------------------
select table_name as v_target from private.custom_field_targets limit 1 \gset
select pg_temp.as_user('alice');
select throws_like(format($$insert into app.custom_field_definitions (org_id, target_table, field_key, label, data_type, sort_order)
  values (%L, %L, 'dietary', 'Dietary restrictions', 'Text', 1)$$, pg_temp.id('org_a'), :'v_target'),
  'custom_field_sensitive:%', 'a custom field cannot be a dietary field');
select pg_temp.as_platform();

-- Questions, travel notes and imports ---------------------------------------------------------------------------------------
select ok(private.question_looks_sensitive('Any allergies?') and private.question_looks_sensitive('¿Tienes alergias?')
    and private.question_looks_sensitive('Do you need wheelchair access?') and private.question_looks_sensitive('Dietary restrictions'),
  'a question asking about a person is caught, in both languages');
select ok(not private.question_looks_sensitive('Accessible routes clear?') and not private.question_looks_sensitive('Allergen awareness certificate')
    and not private.question_looks_sensitive('Years rigging?') and not private.question_looks_sensitive('Are you a certified interpreter?'),
  'a question about the work is not');
select pg_temp.as_user('carol');
select throws_like($$insert into app.form_templates (org_id, name, record_kind, record_subtype, fields)
    values (pg_temp.id('org_a'), 'Guest intake', 'Inspection', 'Safety', '[{"key": "a", "label": "Any allergies?", "kind": "text"}]')$$,
  'question_sensitive:%', 'a no-code form refuses it');
select lives_ok($$insert into app.form_templates (org_id, name, record_kind, record_subtype, fields)
    values (pg_temp.id('org_a'), 'Venue walk', 'Inspection', 'Safety', '[{"key": "a", "label": "Accessible routes clear?", "kind": "yes_no"}]')$$,
  'and takes a venue checklist');
select pg_temp.as_user('alice');
with t as (insert into app.application_question_templates (org_id, name) values (pg_temp.id('org_a'), 'Crew basics') returning id)
  insert into world select 'q_tmpl', id from t;
select throws_like($$insert into app.application_template_questions (application_question_template_id, prompt, sort_order)
    values (pg_temp.id('q_tmpl'), 'Do you have any dietary restrictions?', 1)$$,
  'question_sensitive:%', 'an application question refuses it');
select lives_ok($$insert into app.application_template_questions (application_question_template_id, prompt, sort_order)
    values (pg_temp.id('q_tmpl'), 'Years rigging?', 1)$$, 'and takes one about the work');
select pg_temp.as_platform();
select is((select count(*)::int from pg_trigger where tgname = 't42_refuse_sensitive_question' and not tgisinternal), 3,
  'application questions, their templates and surveys carry the same guard');

-- A mapped import column.
select pg_temp.as_user('alice');
with j as (insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, project_id)
  values (pg_temp.id('org_a'), 'guest_list_entries', 'CSV', 'guests.csv', pg_temp.id('alice') || '/' || gen_random_uuid() || '.csv', pg_temp.id('prj_a')) returning id)
  insert into world select 'job_g', id from j;
select pg_temp.as_platform();
update app.import_jobs set import_status = 'Detected' where id = pg_temp.id('job_g');
insert into app.import_job_columns (import_job_id, sheet_name, column_index, header, suggested_field_name)
  values (pg_temp.id('job_g'), 'Sheet1', 0, 'Guest name', 'guest_name'), (pg_temp.id('job_g'), 'Sheet1', 1, 'Dietary needs', null);
select throws_like($$update app.import_job_columns set field_name = 'note' where import_job_id = pg_temp.id('job_g') and header = 'Dietary needs'$$,
  'import_sensitive_column:%', 'an import column naming it cannot be mapped');
select lives_ok($$update app.import_job_columns set field_name = 'guest_name' where import_job_id = pg_temp.id('job_g') and header = 'Guest name'$$,
  'and the rest of the sheet still maps');
select is((select count(*)::int from private.ai_excluded_tables where table_name = 'app.guest_care_needs'), 1, 'and no AI feature reads guest needs');

select * from finish();
rollback;
