-- pgTAP: migration 6163 (ADR 0164). A value from before consent was recorded gets no invented consent: it reads as absent, the
-- person is told once, consenting keeps it, and it is cleared after 30 days. The report shows consent state per field and
-- never a value, for data.request.manage holders only.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(15);

create function pg_temp.backlog(p_person text) returns void
language plpgsql as $$
begin
  -- A value from before 6160, written as a migration would: no signed-in person.
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
select ok(not exists (select 1 from information_schema.routines r where r.routine_name = 'sensitive_consent_report' and r.routine_definition ilike '%w.allergies%'),
  'and reads no value');
select pg_temp.as_user('carol');
select throws_ok($$select * from app.sensitive_consent_report(pg_temp.id('org_a'))$$, '42501', null, 'only for data.request.manage holders');

select * from finish();
rollback;
