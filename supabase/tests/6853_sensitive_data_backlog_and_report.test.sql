-- pgTAP: migration 6853 (ADR 0164). A value from before consent was recorded gets no invented consent: it reads as absent, the
-- person is told once, consenting keeps it, and it is cleared after 30 days. A notice that fails is tried again and starts no
-- clock, saving something else ends no wait, and a legal hold defers the clearing. The report shows consent state per field and
-- never a value, for data.request.manage holders only.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

create function pg_temp.backlog(p_person text) returns void
language plpgsql as $$
begin
  -- A value from before 6850, written as a migration would: no signed-in person.
  insert into app.person_work_details (person_id, allergies) values (pg_temp.id(p_person), 'Peanuts');
  update app.sensitive_field_records set awaiting_since = now(), entered_by = null
  where person_id = pg_temp.id(p_person) and field_code = 'allergies';
end $$;

create function pg_temp.notices(p_who text) returns integer
language sql as $$
  select count(*)::int from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_who) and n.kind = 'account.sensitive_consent_needed'
$$;

select pg_temp.as_platform();
select pg_temp.backlog('ivy');
select pg_temp.backlog('quinn');

select is((select count(*)::int from cron.job where jobname = 'xos_run_sensitive_data_job'), 1, 'the daily job is scheduled');
select is((select count(*)::int from app.sensitive_data_consents where person_id in (pg_temp.id('ivy'), pg_temp.id('quinn'))), 0, 'no consent is invented for a value already held');

select pg_temp.as_user('ivy');
select app.share_work_details(pg_temp.id('eng_ivy_a'), '{Dietary Needs}');
select pg_temp.as_user('alice');
select is(app.shared_work_details(pg_temp.id('eng_ivy_a')) #>> '{dietary,allergies_on_file}', 'false', 'it reads as absent to everyone else');
select pg_temp.as_platform();

-- The job tells each person once.
select private.run_sensitive_data_job();
select ok((select bool_and(awaiting_notified_at is not null) from app.sensitive_field_records where awaiting_since is not null), 'the job marks them told');
select is(pg_temp.notices('ivy'), 1, 'and tells her');
select private.run_sensitive_data_job();
select is(pg_temp.notices('ivy'), 1, 'only once');

-- Consenting keeps it.
select pg_temp.as_user('ivy');
select app.give_sensitive_consent('Dietary and Allergies', '2026-11-06', 'en-US', 'Gateway');
select pg_temp.as_platform();
select ok((select consent_id is not null and awaiting_since is null from app.sensitive_field_records where person_id = pg_temp.id('ivy')), 'consenting adopts the value');

-- Not consenting clears it after 30 days.
update app.sensitive_field_records set awaiting_since = now() - interval '40 days', awaiting_notified_at = now() - interval '29 days' where person_id = pg_temp.id('quinn');
select private.run_sensitive_data_job();
select is((select allergies from app.person_work_details where person_id = pg_temp.id('quinn')), 'Peanuts', '29 days after telling her it stays');
update app.sensitive_field_records set awaiting_notified_at = now() - interval '31 days' where person_id = pg_temp.id('quinn');
select private.run_sensitive_data_job();
select ok((select allergies is null from app.person_work_details where person_id = pg_temp.id('quinn')), '31 days after, it is cleared');
select ok((select cleared_at is not null from app.sensitive_field_records where person_id = pg_temp.id('quinn')), 'the field record shows it');
select is((select count(*)::int from app.work_detail_events where person_id = pg_temp.id('quinn') and action = 'sensitive_consent.values_cleared'), 1,
  'her access log says so');
select is((select allergies from app.person_work_details where person_id = pg_temp.id('ivy')), 'Peanuts', 'what was confirmed stays');

-- The report.
select pg_temp.as_user('alice');
select is((select standing::text from app.sensitive_consent_report(pg_temp.id('org_a')) where subject_id = pg_temp.id('ivy') and field_code = 'allergies'),
  'Consent Given', 'the report shows the consent state of a field');
select ok((select count(*) > 0 from app.sensitive_consent_report(pg_temp.id('org_a'))), 'the report has rows');
select ok(not exists (select 1 from app.sensitive_consent_report(pg_temp.id('org_a')) r where to_jsonb(r)::text ilike '%peanuts%'),
  'and none of them holds a value');
select is((select count(*)::int from app.sensitive_consent_report(pg_temp.id('org_a')) where subject_id = pg_temp.id('ivy') and field_code = 'dietary_notes'), 1,
  'it lists a field she holds nothing in, so it does not say what is held');
select is((select standing::text from app.sensitive_consent_report(pg_temp.id('org_a')) where subject_id = pg_temp.id('ivy') and field_code = 'meal_preference'),
  'Consent Given', 'and it covers the meal preference');
select pg_temp.as_user('carol');
select throws_ok($$select * from app.sensitive_consent_report(pg_temp.id('org_a'))$$, '42501', null, 'only for data.request.manage holders');


-- A notice that fails starts no clock ---------------------------------------------------------------------------------
select pg_temp.as_platform();
select pg_temp.new_user('rae', 'rae@freelance.test', 'Rae Solano');
select pg_temp.backlog('rae');
alter function private.notify_account(uuid, text, jsonb) rename to notify_account_real;
create function private.notify_account(p_user uuid, p_kind text, p_args jsonb) returns uuid
language plpgsql as $f$ begin raise exception 'the mail queue is down'; end $f$;
select private.run_sensitive_data_job();
select is((select awaiting_notified_at from app.sensitive_field_records where person_id = pg_temp.id('rae')), null, 'a failed notice leaves the row untold');
update app.sensitive_field_records set awaiting_since = now() - interval '40 days' where person_id = pg_temp.id('rae');
select private.run_sensitive_data_job();
select is((select allergies from app.person_work_details where person_id = pg_temp.id('rae')), 'Peanuts', 'and nothing is deleted without the notice, however long it waited');
drop function private.notify_account(uuid, text, jsonb);
alter function private.notify_account_real(uuid, text, jsonb) rename to notify_account;
select private.run_sensitive_data_job();
select ok((select awaiting_notified_at is not null from app.sensitive_field_records where person_id = pg_temp.id('rae')), 'the next run tells her');
select is((select allergies from app.person_work_details where person_id = pg_temp.id('rae')), 'Peanuts', 'and her 30 days start then');

-- Someone with no sign-in cannot be told, so their 30 days run from the wait.
select pg_temp.new_user('una_x', 'una.x@freelance.test', 'Una Xavier');
select pg_temp.backlog('una_x');
update app.people set user_id = null where id = pg_temp.id('una_x');
update app.sensitive_field_records set awaiting_since = now() - interval '31 days' where person_id = pg_temp.id('una_x');
select private.run_sensitive_data_job();
select ok((select allergies is null from app.person_work_details where person_id = pg_temp.id('una_x')), 'a person who cannot be told is cleared 30 days after the wait began');

-- A legal hold defers it ---------------------------------------------------------------------------------------------
select pg_temp.as_platform();
update app.person_work_details set accessibility_notes = 'Near an exit' where person_id = pg_temp.id('ivy');
update app.sensitive_field_records set awaiting_since = now() - interval '40 days', awaiting_notified_at = now() - interval '31 days'
where person_id = pg_temp.id('ivy') and field_code = 'accessibility_notes';
insert into app.legal_holds (org_id, matter) values (pg_temp.id('org_a'), 'Crew dispute 2026-30.');
select private.run_sensitive_data_job();
select is((select accessibility_notes from app.person_work_details where person_id = pg_temp.id('ivy')), 'Near an exit', 'a legal hold keeps a lapsed value');
update app.legal_holds set released_at = now() where org_id = pg_temp.id('org_a') and released_at is null;
select private.run_sensitive_data_job();
select ok((select accessibility_notes is null from app.person_work_details where person_id = pg_temp.id('ivy')), 'and it is cleared once the hold ends');
select is((select allergies from app.person_work_details where person_id = pg_temp.id('ivy')), 'Peanuts', 'with what she agreed to untouched');

-- Saving something else ends no wait -----------------------------------------------------------------------------------
select pg_temp.new_user('sol', 'sol@freelance.test', 'Sol Ibarra');
insert into app.supplier_diversity_certifications (person_id, diversity_kind, certifying_body)
values (pg_temp.id('sol'), 'Women-Owned', 'One Body'), (pg_temp.id('sol'), 'Veteran-Owned', 'Two Body');
select ok((select awaiting_since is not null and consent_id is null from app.sensitive_field_records where person_id = pg_temp.id('sol') and field_code = 'supplier_diversity_kind'),
  'a certification held with no grant waits');
update app.sensitive_field_records set awaiting_since = now() - interval '5 days' where person_id = pg_temp.id('sol');
update app.supplier_diversity_certifications set deleted_at = now() where person_id = pg_temp.id('sol') and diversity_kind = 'Women-Owned';
select ok((select awaiting_since < now() - interval '4 days' and cleared_at is null from app.sensitive_field_records where person_id = pg_temp.id('sol') and field_code = 'supplier_diversity_kind'),
  'removing one of two leaves the other waiting, on the same clock');

select * from finish();
rollback;
