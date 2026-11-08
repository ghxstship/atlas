-- pgTAP: migration 6852 (ADR 0164). A guest's needs are optional and need the keeper's attestation, recorded with who gave it,
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
select ok((select values_saved = false and person_id = pg_temp.id('quinn') from app.sensitive_data_consents where guest_list_entry_id = pg_temp.id('guest_a') and withdrawn_at is null),
  'the attestation stands and records that nothing was saved under it');
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.work_detail_events where person_id = pg_temp.id('quinn') and action = 'sensitive_consent.attestation_not_saved'), 1, 'her access log shows it');
select is((select count(*)::int from app.sensitive_entries_about_me()), 0, 'with nothing to remove, it is not listed as an entry');
select pg_temp.as_user('alice');
select is((select count(*)::int from app.work_detail_events where person_id = pg_temp.id('quinn') and action like 'sensitive_consent.%'), 0,
  'the org''s Owner, an audit reader, does not read that row');
select is((select count(*)::int from app.work_detail_events where person_id = pg_temp.id('quinn') and action like 'guest_needs.%'), 0,
  'nor the row that links a guest to an account');
select pg_temp.as_platform();
select ok((select count(*) > 0 from app.work_detail_events where person_id = pg_temp.id('quinn') and action = 'guest_needs.viewed' and org_id = pg_temp.id('org_a')),
  'though the row names the org, so she sees who read it');
select pg_temp.as_user('carol');
select is((select categories::text from app.guest_care_needs_states(pg_temp.id('prj_a'))), '{"Dietary and Allergies"}', 'the keeper sees what she would see for anyone');
select ok((select has_email from app.guest_care_needs_states(pg_temp.id('prj_a'))), 'including that an email is on file, though no row holds it');
-- Neither the keeper who attested nor anyone else reads who it names, or who withdrew it.
select throws_ok($$select person_id from app.sensitive_data_consents$$, '42501', null, 'the keeper cannot read whom her attestation names');
select throws_ok($$select withdrawn_by from app.sensitive_data_consents$$, '42501', null, 'or who withdrew one');
select throws_ok($$select captured_ip from app.sensitive_data_consents$$, '42501', null, 'or an IP address');
select throws_ok($$select values_saved from app.sensitive_data_consents$$, '42501', null, 'or whether anything was saved');
select throws_ok($$select * from app.sensitive_data_consents$$, '42501', null, 'or the whole row');
select ok((select count(*) > 0 from app.sensitive_data_consents where category = 'Dietary and Allergies' and withdrawn_at is null), 'but she reads her attestation''s category and when');
select pg_temp.as_user('quinn');
select throws_ok($$select captured_ip from app.sensitive_data_consents$$, '42501', null, 'the person it is about does not read the attester''s IP address either');
-- A routine save with the email left blank, as the form always shows it, is still about her.
select pg_temp.as_user('carol');
select is(app.set_guest_care_needs(pg_temp.id('guest_a'), '{Halal}', null, null, '{}', null, null, true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas'),
  pg_temp.id('guest_a'), 'a blank email gets the same answer');
select pg_temp.as_platform();
select is((select count(*)::int from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_a')), 0, 'and does not get round her withdrawal');
select is((select person_id from app.sensitive_data_consents where guest_list_entry_id = pg_temp.id('guest_a') and withdrawn_at is null), pg_temp.id('quinn'),
  'the attestation still names her');
select pg_temp.as_user('carol');
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
select pg_temp.as_platform();
insert into world select 'rae_old', c.id from app.sensitive_data_consents c where c.person_id = pg_temp.id('rae') and c.guest_list_entry_id = pg_temp.id('guest_r') limit 1;
select pg_temp.as_user('rae');
select is((select count(*)::int from app.sensitive_entries_about_me()), 0, 'correcting the email: the first person no longer reads the guest''s values');
select throws_like(format($$select app.remove_sensitive_entry(%L)$$, pg_temp.id('rae_old')),
  'sensitive_entry_not_yours:%', 'and cannot delete them');
select pg_temp.as_platform();
select is(pg_temp.told('tam'), 1, 'the second person is told');
select is((select person_id from app.sensitive_field_records where guest_list_entry_id = pg_temp.id('guest_r') and field_code = 'guest_dietary_needs'), pg_temp.id('tam'),
  'and the field record names her');
select is((select count(*)::int from app.work_detail_events where person_id = pg_temp.id('rae') and action = 'sensitive_consent.entry_unlinked'), 1,
  'the first person''s access log says the entry no longer names her');

select pg_temp.as_user('alice');
select app.set_guest_care_needs(pg_temp.id('guest_r'), '{Kosher}', null, null, '{}', null, 'tam@freelance.test', true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
select pg_temp.as_platform();
select is((select given_by from app.sensitive_data_consents where guest_list_entry_id = pg_temp.id('guest_r') and withdrawn_at is null), pg_temp.id('alice'),
  'another keeper entering values is recorded as who attested');
select is((select count(*)::int from app.sensitive_data_consents where guest_list_entry_id = pg_temp.id('guest_r') and withdrawn_at is not null and withdrawn_by = pg_temp.id('tam')), 0,
  'and what she replaced does not read as a withdrawal by the person');

-- The keeper corrects an allergy: the email never comes back to the form, so it stays blank there.
select pg_temp.as_user('carol');
select is((select has_email from app.guest_care_needs_states(pg_temp.id('prj_a')) where guest_list_entry_id = pg_temp.id('guest_r')), true, 'the form knows an email is on file');
select app.set_guest_care_needs(pg_temp.id('guest_r'), '{Halal}', 'Sesame', null, '{}', null, null, true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
select pg_temp.as_user('tam');
select is((select count(*)::int from app.sensitive_entries_about_me()), 1, 'a blank email leaves the person named: she still sees it');
select is((select details ->> 'allergies' from app.sensitive_entries_about_me()), 'Sesame', 'with the correction');
select pg_temp.as_platform();
select is((select guest_email from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_r')), 'tam@freelance.test', 'the email stays on file');
select is((select person_id from app.sensitive_field_records where guest_list_entry_id = pg_temp.id('guest_r') and field_code = 'guest_allergies'), pg_temp.id('tam'), 'and the field record names her');

-- Removing one entry reaches that entry and no further.
select pg_temp.as_user('tam');
select app.remove_sensitive_entry((select consent_id from app.sensitive_entries_about_me()));
select pg_temp.as_user('carol');
select is(app.set_guest_care_needs(pg_temp.id('guest_r'), '{Halal}', 'Sesame', null, '{}', null, null, true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas'),
  pg_temp.id('guest_r'), 'a blank save on the entry she removed gets the same answer');
select pg_temp.as_platform();
select is((select count(*)::int from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_r')), 0, 'and does not put it back');
-- Whoever entered it does not enter it for her again in that organization, as Work Details tells her.
select pg_temp.as_user('carol');
with x as (insert into app.guest_list_entries (project_id, guest_name) values (pg_temp.id('prj_a'), 'Tam At Another Show') returning id)
  insert into world select 'guest_t2', id from x;
select is(app.set_guest_care_needs(pg_temp.id('guest_t2'), '{Vegan}', 'Peanuts, severe', null, '{}', null, 'tam@freelance.test', true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas'),
  pg_temp.id('guest_t2'), 'whoever entered what she removed gets the same answer on another entry of that organization');
select pg_temp.as_platform();
select is((select count(*)::int from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_t2')), 0, 'and does not enter it for her there again');
select pg_temp.as_user('alice');
select app.set_guest_care_needs(pg_temp.id('guest_t2'), '{Vegan}', 'Peanuts, severe', null, '{}', null, 'tam@freelance.test', true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
select pg_temp.as_platform();
select is((select allergies from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_t2')), 'Peanuts, severe',
  'removing one entry does not silently drop what someone else enters elsewhere');
select pg_temp.as_user('tam');
select app.give_sensitive_consent('Dietary and Allergies', '2026-11-06', 'en-US', 'Gateway');
select pg_temp.as_user('carol');
select app.set_guest_care_needs(pg_temp.id('guest_r'), '{Halal}', null, null, '{}', null, null, true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
select pg_temp.as_platform();
select is((select cardinality(dietary_needs) from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_r')), 1, 'her own consent lifts it');
select is((select guest_person_id from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_r')), pg_temp.id('tam'), 'and the entry still names her, from the attestation');

-- Taking the email off is explicit.
select pg_temp.as_user('alice');
select app.set_guest_care_needs(pg_temp.id('guest_r'), '{Kosher}', null, null, '{}', null, null, true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas', null, true);
select pg_temp.as_platform();
select ok((select guest_email is null and guest_person_id is null from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_r')), 'an explicit clear removes the email');
select is((select count(*)::int from app.work_detail_events where person_id = pg_temp.id('tam') and action = 'sensitive_consent.entry_unlinked'), 1, 'and says so in her access log');
select pg_temp.as_user('alice');
select is((select has_email from app.guest_care_needs_states(pg_temp.id('prj_a')) where guest_list_entry_id = pg_temp.id('guest_r')), false, 'and the form no longer says one is on file');
select is((select count(*)::int from app.sensitive_consent_report(pg_temp.id('org_a')) where subject_id = pg_temp.id('guest_r') and field_code = 'guest_dietary_needs'), 1,
  'the report lists a guest once, however many people an email named, so it does not show who had an account');
select app.set_guest_care_needs(pg_temp.id('guest_r'), '{Kosher}', null, null, '{}', null, 'tam@freelance.test', true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
select pg_temp.as_platform();

-- An entry the person removed stays theirs while it names nobody else ----------------------------------------------------
select pg_temp.new_user('uma', 'uma@freelance.test', 'Uma Reyes');
select pg_temp.as_user('carol');
with x as (insert into app.guest_list_entries (project_id, guest_name) values (pg_temp.id('prj_a'), 'Uma Reyes') returning id)
  insert into world select 'guest_u', id from x;
select app.set_guest_care_needs(pg_temp.id('guest_u'), '{Vegan}', 'Sesame', null, '{}', null, 'uma@freelance.test', true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
select pg_temp.as_user('uma');
select app.remove_sensitive_entry((select consent_id from app.sensitive_entries_about_me()));
select pg_temp.as_user('alice');
select is(app.set_guest_care_needs(pg_temp.id('guest_u'), '{Halal}', 'Sesame', null, '{}', null, null, true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas', null, true),
  pg_temp.id('guest_u'), 'taking the email off an entry the person removed gets the same answer');
select pg_temp.as_platform();
select is((select count(*)::int from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_u')), 0, 'and does not get round her removal');
select is((select count(*)::int from app.work_detail_events where person_id = pg_temp.id('uma') and action = 'sensitive_consent.attestation_not_saved'), 1,
  'her access log shows it');
select pg_temp.as_user('alice');
select app.set_guest_care_needs(pg_temp.id('guest_u'), '{Halal}', 'Sesame', null, '{}', null, 'u.reyes@elsewhere.test', true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
select pg_temp.as_platform();
select is((select allergies from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_u')), 'Sesame', 'another address says the guest is someone else, and saves');

-- A wrong match: the person an email named says the guest is someone else ------------------------------------------------
select pg_temp.new_user('wes', 'wes@freelance.test', 'Wes Arden');
select pg_temp.join_org('alice', 'org_a', 'wes', 'member');
select pg_temp.as_user('carol');
with x as (insert into app.guest_list_entries (project_id, guest_name) values (pg_temp.id('prj_a'), 'Wesley Arden Jr') returning id)
  insert into world select 'guest_w', id from x;
select app.set_guest_care_needs(pg_temp.id('guest_w'), '{Vegan}', 'Shellfish', null, '{Seating}', null, 'wes@freelance.test', true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
select throws_like($$select app.disown_sensitive_entry((select c.id from app.sensitive_data_consents c where c.guest_list_entry_id = pg_temp.id('guest_w') limit 1))$$,
  'sensitive_entry_not_yours:%', 'whoever entered it does not say it is someone else');
select pg_temp.as_platform();
select is(pg_temp.told('wes'), 2, 'the person the email matched is told');
select pg_temp.as_user('wes');
select is((select count(*)::int from app.sensitive_entries_about_me()), 2, 'and sees the entry');
select lives_ok($$select app.disown_sensitive_entry((select consent_id from app.sensitive_entries_about_me() where category = 'Dietary and Allergies'))$$,
  'and says the guest is someone else');
select is((select count(*)::int from app.sensitive_entries_about_me()), 0, 'the entry no longer shows to him, in either category');
select pg_temp.as_platform();
select ok((select guest_email is null and guest_person_id is null from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_w')),
  'his email and name come off the entry');
select is((select allergies from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_w')), 'Shellfish', 'the guest''s needs stay');
select is((select count(*)::int from app.sensitive_data_consents where guest_list_entry_id = pg_temp.id('guest_w') and withdrawn_at is null), 2,
  'and so does the keeper''s attestation for the guest');
select is((select count(*)::int from app.sensitive_data_consents where guest_list_entry_id = pg_temp.id('guest_w') and person_id = pg_temp.id('wes')), 0,
  'which no longer names him');
select is((select count(*)::int from app.sensitive_field_records where guest_list_entry_id = pg_temp.id('guest_w') and person_id = pg_temp.id('wes')), 0,
  'nor do the field records');
select is((select count(*)::int from app.work_detail_events where person_id = pg_temp.id('wes') and action = 'sensitive_consent.entry_unlinked'), 1,
  'his access log says the entry no longer names him');
select is((select count(*)::int from app.audit_events where org_id = pg_temp.id('org_a') and action = 'guest_needs.email_removed'
    and subject_id = pg_temp.id('guest_w')), 1, 'and the org''s audit log that the email came off, as for a removal');
select pg_temp.as_user('carol');
select is((select has_email from app.guest_care_needs_states(pg_temp.id('prj_a')) where guest_list_entry_id = pg_temp.id('guest_w')), false,
  'the keeper sees that no email is on file');
select app.set_guest_care_needs(pg_temp.id('guest_w'), '{Vegan}', 'Shellfish, severe', null, '{Seating}', null, null, true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
select pg_temp.as_platform();
select is((select allergies from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_w')), 'Shellfish, severe',
  'a later save with the email blank saves the guest''s needs, not his removal rules');
select pg_temp.as_user('carol');
select app.set_guest_care_needs(pg_temp.id('guest_w'), '{Vegan}', 'Shellfish, severe, carries an EpiPen', null, '{Seating}', null, 'wes@freelance.test',
  true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
select pg_temp.as_platform();
select is((select allergies from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_w')), 'Shellfish, severe, carries an EpiPen',
  'typing his email again still saves');
select ok((select guest_email is null and guest_person_id is null from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_w')),
  'and does not name him or keep his email on that entry');
select is(pg_temp.told('wes'), 2, 'nor tell him again');
select private.run_sensitive_data_job();
select is((select guest_person_id from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_w')), null, 'the daily job does not link him back');
-- His own rules still stand: withdrawing reaches what is about him, not the guest he said is someone else.
select pg_temp.as_user('wes');
select app.give_sensitive_consent('Dietary and Allergies', '2026-11-06', 'en-US', 'Gateway');
select app.withdraw_sensitive_consent('Dietary and Allergies');
select pg_temp.as_platform();
select is((select allergies from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_w')), 'Shellfish, severe, carries an EpiPen',
  'his withdrawal does not delete the other guest''s needs');
select pg_temp.as_user('carol');
with x as (insert into app.guest_list_entries (project_id, guest_name) values (pg_temp.id('prj_a'), 'Wes Arden') returning id)
  insert into world select 'guest_w2', id from x;
select app.set_guest_care_needs(pg_temp.id('guest_w2'), '{Vegan}', null, null, '{}', null, 'wes@freelance.test', true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
select pg_temp.as_platform();
select is((select count(*)::int from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_w2')), 0,
  'and on an entry that is about him, his withdrawal still means nobody attests him back in');
select ok(has_function_privilege('authenticated', 'app.disown_sensitive_entry(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'app.disown_sensitive_entry(uuid)', 'EXECUTE'), 'saying it is someone else needs a sign-in');

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
update app.projects set starts_on = null, ends_on = (now() - interval '92 days')::date where id = pg_temp.id('prj_a');
insert into app.legal_holds (org_id, table_name, matter) values (pg_temp.id('org_a'), 'app.guest_care_needs', 'Guest dispute 2026-23.');
select private.run_sensitive_data_job();
select is((select count(*)::int from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_e')), 1, 'a hold defers the 90 days after the project ends');
select ok((select bool_and(withdrawn_at is not null) from app.sensitive_data_consents where guest_list_entry_id = pg_temp.id('guest_e')), 'but use stops: the attestation closes');
select pg_temp.as_user('alice');
select is((select count(*)::int from app.read_guest_care_needs(pg_temp.id('prj_a')) where guest_list_entry_id = pg_temp.id('guest_e')), 0, 'and nothing reads the values past that date');
select pg_temp.as_platform();
update app.legal_holds set released_at = now() where org_id = pg_temp.id('org_a') and table_name = 'app.guest_care_needs' and released_at is null;
select private.run_sensitive_data_job();
select is((select count(*)::int from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_e')), 0, 'and then it runs');

-- A project that stops before its end date stops the clock then, and the days are the project's own.
create function pg_temp.guest_on_project(p_key text) returns void language plpgsql as $f$
begin
  perform pg_temp.as_user('carol');
  with x as (insert into app.guest_list_entries (project_id, guest_name) values (pg_temp.id('prj_a'), p_key) returning id)
    insert into world select p_key, id from x;
  perform app.set_guest_care_needs(pg_temp.id(p_key), '{Vegan}', null, null, '{}', null, null, true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas');
  perform pg_temp.as_platform();
end $f$;
update app.projects set ends_on = (now() + interval '2 years')::date where id = pg_temp.id('prj_a');
select pg_temp.guest_on_project('guest_arch');
update app.projects set archived_at = now() - interval '91 days' where id = pg_temp.id('prj_a');
select private.run_sensitive_data_job();
select is((select count(*)::int from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_arch')), 0,
  'a project archived before its end date ends when it was archived');
update app.projects set archived_at = null, time_zone = 'Pacific/Pago_Pago', ends_on = ((now() at time zone 'Pacific/Kiritimati') - interval '91 days')::date where id = pg_temp.id('prj_a');
select pg_temp.guest_on_project('guest_tz');
select private.run_sensitive_data_job();
select is((select count(*)::int from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_tz')), 1,
  'the 90 days are counted in the project''s time zone');
update app.projects set time_zone = 'Pacific/Kiritimati' where id = pg_temp.id('prj_a');
select private.run_sensitive_data_job();
select is((select count(*)::int from app.guest_care_needs where guest_list_entry_id = pg_temp.id('guest_tz')), 0, 'so a day later there, they are up');

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
with x as (insert into app.guest_list_entries (project_id, guest_name, note) values (pg_temp.id('prj_a'), 'Older Guest', 'Wheelchair user') returning id)
  insert into world select 'guest_old', id from x;
select pg_temp.as_user('carol');
select lives_ok($$update app.guest_list_entries set plus_ones = 2, note = 'Wheelchair user' where id = pg_temp.id('guest_old')$$,
  'an older guest''s other details still change, with the note sent back unchanged');
select throws_like($$update app.guest_list_entries set note = 'Vegan' where id = pg_temp.id('guest_old')$$,
  'guest_note_sensitive:%', 'and a change to the note is checked');

-- A declined guest takes no needs.
with x as (insert into app.guest_list_entries (project_id, guest_name) values (pg_temp.id('prj_a'), 'Declined Guest') returning id)
  insert into world select 'guest_dec', id from x;
select pg_temp.as_user('alice');
update app.guest_list_entries set entry_state = 'Declined' where id = pg_temp.id('guest_dec');
select pg_temp.as_user('carol');
select throws_like($$select app.set_guest_care_needs(pg_temp.id('guest_dec'), '{Vegan}', null, null, '{}', null, null, true, true, '2026-11-06', '2026-11-06', 'en-US', 'Atlas')$$,
  'guest_needs_declined:%', 'needs on a declined guest are refused, which the exit trigger would never clear');
select lives_ok($$select app.clear_guest_care_needs(pg_temp.id('guest_dec'))$$, 'and clearing them stays possible');
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
select throws_like($$update app.import_job_columns set header = 'Dietary needs' where import_job_id = pg_temp.id('job_g') and header = 'Guest name'$$,
  'import_sensitive_column:%', 'renaming a mapped column does not get round it');
select throws_like($$insert into app.import_job_columns (import_job_id, sheet_name, column_index, header, field_name)
    values (pg_temp.id('job_g'), 'Sheet1', 2, 'Allergies', 'note')$$,
  'import_sensitive_column:%', 'nor does inserting one already mapped');
select is((select count(*)::int from private.ai_excluded_tables where table_name = 'app.guest_care_needs'), 1, 'and no AI feature reads guest needs');

select * from finish();
rollback;
