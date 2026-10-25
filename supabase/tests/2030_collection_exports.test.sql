-- pgTAP: export from every collection (A102, RRR-146; Section 4.6.4, Section 8.6). app.request_export records the
-- columns, headers and filters of an export of one table or view, classifies a view's column as the column it
-- shows (a masked Restricted rate asks for step-up), never lets medical encounter data out through any view, and
-- queues the render job. Only the worker claims, reads and finishes a render: it reads as the requester (their
-- row level security), and an export becomes Ready with its own file and a 7-day expiry, or retries then fails
-- with its reason. Only the requester downloads the file, while the classification allows it, and each download
-- is logged. A report run answers its classification and viewer for the report PDF watermark.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(67);

create temporary table k (key text primary key, id uuid);
grant select, insert, update on k to public;

create function pg_temp.as_worker() returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  perform set_config('role', 'service_role', true);
end $$;

-- World: a rate card line of org_a with its Restricted rate, a second venue of org_a, one deleted.
select pg_temp.as_user('carol');
with x as (insert into app.rate_cards (org_id, name, currency_code, effective_from)
  values (pg_temp.id('org_a'), '2027 Crew Rates', 'USD', '2027-01-01') returning id)
  insert into k select 'rc', id from x;
insert into app.rate_card_lines (rate_card_id, role_code, worker_classification, pay_basis, arrangement, canon_rate_card_id, overtime_rule_id, rate_minor)
values ((select id from k where key = 'rc'), '0000.50.01', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Retainer', 'LRC-001', 'OTR-002', 85000);
select pg_temp.as_user('alice');
insert into app.venues (org_id, name, locality, jurisdiction_id, time_zone) values
  (pg_temp.id('org_a'), 'Seaside Amphitheater 100% Live', 'Key West', 'US-FL-MIAMI-DADE', 'America/New_York'),
  (pg_temp.id('org_a'), 'Closed Warehouse', 'Hialeah', 'US-FL-MIAMI-DADE', 'America/New_York');
update app.venues set deleted_at = now() where name = 'Closed Warehouse';

-- Storage --------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is((select public from storage.buckets where id = 'export-files'), false, 'the export-files bucket is private');
select is((select allowed_mime_types from storage.buckets where id = 'export-files'),
  array['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/pdf'],
  'it takes CSV, .xlsx and PDF files');
select is(private.export_file_job('00000000-0000-0000-0000-000000000001/0190a8b2-0000-7000-8000-000000000001.xlsx'),
  '0190a8b2-0000-7000-8000-000000000001'::uuid, 'a file name names its export');
select is(private.export_file_job('elsewhere/file.csv'), null::uuid, 'any other name names no export');

-- Requesting -----------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into k values ('venues', app.request_export(pg_temp.id('org_a'), 'CSV', 'Venues',
  array['app.venues.name', 'app.venues.locality'], array['Venue', 'City'],
  '[{"operator":"search","value":"100%"},{"operator":"eq","column":"time_zone","value":"America/New_York"},{"operator":"in","column":"locality","value":"Key West, Miami"}]'::jsonb));
select is((select classification::text || ':' || watermark::text || ':' || export_status::text from app.export_jobs where id = (select id from k where key = 'venues')),
  'Internal:false:Queued', 'a member exports Internal columns, queued and unmarked');
select results_eq($$select column_name, column_position::int, header_label from app.export_job_columns
  where export_job_id = (select id from k where key = 'venues') order by column_position$$,
  $$values ('name'::text, 1, 'Venue'::text), ('locality', 2, 'City')$$, 'the columns keep their order and headers');
select results_eq($$select coalesce(column_name, '-'), filter_operator::text, value_text from app.export_job_filters
  where export_job_id = (select id from k where key = 'venues') order by filter_operator$$,
  $$values ('time_zone'::text, 'eq'::text, 'America/New_York'::text), ('locality', 'in', 'Key West, Miami'), ('-', 'search', '100%')$$, 'the filters are recorded');
select throws_ok($$insert into app.export_job_filters (export_job_id, filter_operator, value_text) values ((select id from k where key = 'venues'), 'search', 'x')$$,
  '42501', null, 'a person never writes an export''s filters directly');
select throws_ok($$update app.export_job_columns set column_name = 'tax_identifier' where export_job_id = (select id from k where key = 'venues')$$,
  '42501', null, 'nor changes its columns');

select throws_ok($$select app.request_export(pg_temp.id('org_a'), 'CSV', 'Mixed', array['app.venues.name', 'app.projects.name'], null, null)$$,
  'XR001', 'export_one_source: An export reads its columns from one table or view.', 'an export reads one table or view');
select throws_ok($$select app.request_export(pg_temp.id('org_a'), 'CSV', 'Venues', array['app.venues.nickname'], null, null)$$,
  'XR001', 'export_column_unknown: app.venues has no column nickname.', 'every column exists');
select throws_ok($$select app.request_export(pg_temp.id('org_a'), 'CSV', 'Venues', array['app.venues.name', 'app.venues.name'], null, null)$$,
  'XR001', 'export_column_duplicate: An export names each column once.', 'each column once');
select throws_ok($$select app.request_export(pg_temp.id('org_a'), 'CSV', 'Venues', array['app.venues.name'], array['A', 'B'], null)$$,
  'XR001', null, 'one header for each column');
select throws_ok($$select app.request_export(pg_temp.id('org_a'), 'CSV', 'Venues', array['app.venues.name'], null, '[{"operator":"eq","column":"secret","value":"x"}]')$$,
  'XR001', 'export_filter_column: app.venues has no column secret to filter on.', 'a filter names a column of the source');
select throws_ok($$select app.request_export(pg_temp.id('org_a'), 'CSV', 'Venues', array['app.venues.name'], null, '[{"operator":"lt","column":"name","value":"x"}]')$$,
  'XR001', null, 'a filter is eq or search');
select ok(app.request_export(pg_temp.id('org_a'), 'PDF', 'Roles', array['xpms.dim_role.role_code', 'xpms.dim_role.job_title'], null, null) is not null,
  'canon exports read the xpms schema');
select ok(app.request_export(pg_temp.id('org_a'), 'CSV', 'Venues', array['app.venues.name']) is not null,
  'the API''s four-argument call still requests an export');
insert into k values ('lines', app.request_export(pg_temp.id('org_a'), 'XLSX', 'Rate card lines',
  array['app.rate_card_lines_masked.role_code', 'app.rate_card_lines_masked.is_masked'], null, null));

-- Medical encounter data never leaves, through any view (Section 14.3).
select throws_ok($$select app.request_export(pg_temp.id('org_a'), 'CSV', 'Clinic', array['app.medical_encounters_masked.disposition'], null, null)$$,
  'XR001', 'export_medical_excluded: Medical encounter data is excluded from exports (Section 14.3).', 'a view over medical encounters is refused');
select throws_ok($$select app.request_export(pg_temp.id('org_a'), 'CSV', 'Clinic', array['app.medical_encounters.patient_description'])$$,
  'XR001', 'export_medical_excluded: Medical encounter data is excluded from exports (Section 14.3).', 'and so is every column of the table');
select pg_temp.as_user_stepped_up('alice');
select throws_ok($$select app.request_export(pg_temp.id('org_a'), 'PDF', 'Clinic', array['app.medical_encounters_masked.treatment_notes'], null, null)$$,
  'XR001', null, 'even an Owner after step-up exports no treatment notes');

-- A masked view's Restricted rate is Restricted: the capability, then step-up (aal2).
select pg_temp.as_platform();
select is(private.export_column_classification('app.rate_card_lines_masked', 'rate_minor')::text, 'Restricted', 'a masked view''s rate is classified as the rate');
select is(private.export_column_classification('app.payroll_line_amounts', 'amount_minor')::text, 'Restricted', 'an amount computed from the rate is too');
select is(private.export_column_classification('app.rate_card_lines_masked', 'role_code')::text, 'Internal', 'the other columns stay Internal');
select pg_temp.as_user('carol');
select throws_ok($$select app.request_export(pg_temp.id('org_a'), 'CSV', 'Rates', array['app.rate_card_lines_masked.role_code', 'app.rate_card_lines_masked.rate_minor'], null, null)$$,
  'XR001', 'export_restricted: Exporting Restricted columns needs the restricted export capability.', 'a Manager without the restricted export capability is refused');
select pg_temp.as_user('alice');
select throws_ok($$select app.request_export(pg_temp.id('org_a'), 'CSV', 'Rates', array['app.rate_card_lines_masked.role_code', 'app.rate_card_lines_masked.rate_minor'], null, null)$$,
  'XR001', 'step_up_required: Exporting Restricted columns needs step-up authentication.', 'the Owner needs step-up (aal2) for the Restricted rate');
select throws_ok($$select app.request_export(pg_temp.id('org_a'), 'CSV', 'Rates', array['app.rate_card_lines_masked.role_code'], null, '[{"operator":"eq","column":"rate_minor","value":"85000"}]')$$,
  'XR001', 'step_up_required: Exporting Restricted columns needs step-up authentication.', 'filtering on the Restricted rate discloses it, so it asks for step-up too');
select pg_temp.as_user_stepped_up('alice');
insert into k values ('rates', app.request_export(pg_temp.id('org_a'), 'PDF', 'Rate cards',
  array['app.rate_card_lines_masked.role_code', 'app.rate_card_lines_masked.rate_minor'], array['Role', 'Rate'],
  jsonb_build_array(jsonb_build_object('operator', 'eq', 'column', 'rate_card_id', 'value', (select id from k where key = 'rc')))));
select is((select classification::text || ':' || watermark::text from app.export_jobs where id = (select id from k where key = 'rates')),
  'Restricted:true', 'after step-up the Restricted export is allowed and watermarked');

-- The worker API ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select throws_ok($$select * from app.claim_export_renders('x', 5)$$, '42501', null, 'a person cannot claim renders');
select throws_ok($$select * from app.export_job_rows((select id from k where key = 'venues'), 10)$$, '42501', null, 'nor read rows through the worker API');
select throws_ok($$select app.finish_export_render(gen_random_uuid(), true, 'x', 0)$$, '42501', null, 'nor finish a render');
select throws_ok($$select * from app.expired_export_files(5)$$, '42501', null, 'nor list expired files');
select pg_temp.as_anon();
select throws_ok($$select * from app.claim_export_renders('x', 5)$$, '42501', null, 'anon cannot claim renders');

select pg_temp.as_worker();
select throws_ok($$select * from app.export_job_rows((select id from k where key = 'venues'), 10)$$, 'XR001',
  'export_not_rendering: Rows are read only for an export being rendered.', 'rows are read only while an export renders');
-- A job whose export is gone is finished at once and never handed out.
select pg_temp.as_platform();
select private.enqueue_job(pg_temp.id('org_a'), 'export.render', gen_random_uuid());
select pg_temp.as_worker();
create temporary table claimed as select * from app.claim_export_renders('worker-1', 20);
grant select on claimed to public;
select is((select count(*)::int from claimed), 5, 'the worker claims the five queued exports and skips the orphan job');
select is((select count(*)::int from app.job_queue where job_kind = 'export.render' and job_status = 'Succeeded'), 1, 'the orphan job is finished');
select is((select export_status::text from app.export_jobs where id = (select id from k where key = 'venues')), 'Rendering', 'a claimed export is Rendering');
select results_eq($$select requester_email, locale, time_zone from claimed where export_job_id = (select id from k where key = 'rates')$$,
  $$values ('alice@northwind.test'::text, 'en-US'::text, 'UTC'::text)$$, 'a claim answers the requester''s email, language and time zone for the file');
select is((select count(*)::int from app.claim_export_renders('worker-2', 20)), 0, 'a second worker gets nothing more');

-- Rows read as the requester: their org, live rows, the filters and the search, in column order.
select results_eq($$select r from app.export_job_rows((select id from k where key = 'venues'), 10) r$$,
  $$values ('{"name": "Seaside Amphitheater 100% Live", "locality": "Key West"}'::jsonb)$$,
  'rows are the requester''s, live, filtered (eq and in) and searched (with % taken literally)');
select results_eq($$select r ->> 'rate_minor' from app.export_job_rows((select id from k where key = 'rates'), 10) r$$,
  $$values ('85000'::text)$$, 'the Owner''s rows carry the rate they may read');
-- Every row the Member reads is masked; since 2002 the org's Standard Library copies can add identical rows.
select results_eq($$select distinct r from app.export_job_rows((select id from k where key = 'lines'), 10) r$$,
  $$values ('{"role_code": "0000.50.01", "is_masked": true}'::jsonb)$$, 'a Member''s export reads the view as the Member, with the rate masked');
select is(current_user::text, 'service_role', 'the worker gets its own role back after reading');

-- Finishing.
select throws_ok(format('select app.finish_export_render(%L, true, %L, 1)', (select job_id from claimed where export_job_id = (select id from k where key = 'venues')), 'elsewhere/file.csv'),
  'XR001', 'export_file_path: A finished export names its own file.', 'a finished export names its own file');
select is(app.finish_export_render((select job_id from claimed where export_job_id = (select id from k where key = 'venues')), true,
  private.export_file_path(pg_temp.id('org_a'), (select id from k where key = 'venues'), 'CSV'), 1)::text, 'Ready', 'success makes the export Ready');
select ok((select expires_at between now() + interval '6 days 23 hours' and now() + interval '7 days 1 hour' and row_count = 1
  from app.export_jobs where id = (select id from k where key = 'venues')), 'for 7 days, with its row count');
select is(app.finish_export_render((select job_id from claimed where export_job_id = (select id from k where key = 'rates')), false, null, null, 'permission denied for view rate_card_lines_masked')::text,
  'Queued', 'a failed attempt goes back to Queued while the job has attempts left');
select is((select last_error from app.export_jobs where id = (select id from k where key = 'rates')), 'permission denied for view rate_card_lines_masked', 'with the reason for the requester');
select pg_temp.as_platform();
update app.job_queue set run_after = now(), attempts = 5 where subject_id = (select id from k where key = 'rates');
select pg_temp.as_worker();
insert into k select 'rates_job', job_id from app.claim_export_renders('worker-3', 20) where export_job_id = (select id from k where key = 'rates');
select is(app.finish_export_render((select id from k where key = 'rates_job'), false, null, null, 'still denied')::text, 'Failed', 'after the last attempt the export is Failed');

-- Downloading ------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into storage.objects (bucket_id, name)
select 'export-files', private.export_file_path(e.org_id, e.id, e.export_format) from app.export_jobs e
where e.id in ((select id from k where key = 'venues'), (select id from k where key = 'rates'));
select pg_temp.as_user('dave');
select results_eq($$select storage_object_path, export_format::text, source_label from app.record_export_download((select id from k where key = 'venues'))$$,
  format($$values (%L::text, 'CSV'::text, 'Venues'::text)$$, pg_temp.id('org_a')::text || '/' || (select id from k where key = 'venues')::text || '.csv'),
  'the requester downloads their Ready export');
select is((select count(*)::int from app.file_access_log where bucket_id = 'export-files' and action = 'Download' and person_id = pg_temp.id('dave')), 1, 'and the download is logged');
select is((select count(*)::int from storage.objects where bucket_id = 'export-files'), 1,
  'the storage policy lets the requester read their Ready file, and no other');
select pg_temp.as_user('alice');
select throws_ok($$select * from app.record_export_download((select id from k where key = 'venues'))$$, '42501', null, 'nobody else downloads it, not even the Owner');
select is((select count(*)::int from storage.objects where bucket_id = 'export-files'), 0, 'nor reads the file');
-- A Restricted export downloads only on an aal2 session.
select pg_temp.as_platform();
update app.export_jobs set export_status = 'Ready', last_error = null,
  storage_object_path = private.export_file_path(org_id, id, export_format), expires_at = now() + interval '1 day'
where id = (select id from k where key = 'rates');
select pg_temp.as_user('alice');
select throws_ok($$select * from app.record_export_download((select id from k where key = 'rates'))$$, 'XR001',
  'step_up_required: Downloading a Restricted export needs step-up authentication.', 'a Restricted export downloads only after step-up');
select is((select count(*)::int from storage.objects where bucket_id = 'export-files'), 0, 'and the storage policy agrees');
select pg_temp.as_user_stepped_up('alice');
select is((select count(*)::int from app.record_export_download((select id from k where key = 'rates'))), 1, 'after step-up it downloads');
select is((select count(*)::int from storage.objects where bucket_id = 'export-files'), 1, 'and reads the file');
select is((select watermarked from app.file_access_log where bucket_id = 'export-files' and person_id = pg_temp.id('alice')), true, 'logged as a watermarked copy');

-- Expiry.
select pg_temp.as_platform();
update app.export_jobs set expires_at = now() - interval '1 minute' where id = (select id from k where key = 'venues');
select pg_temp.as_user('dave');
select throws_ok($$select * from app.record_export_download((select id from k where key = 'venues'))$$, 'XR001', null, 'an expired download is refused');
select pg_temp.as_worker();
select results_eq($$select export_job_id from app.expired_export_files(10)$$, $$select id from k where key = 'venues'$$, 'the worker lists the expired file');
select app.mark_export_expired((select id from k where key = 'venues'));
select is((select export_status::text || ':' || coalesce(storage_object_path, '-') from app.export_jobs where id = (select id from k where key = 'venues')),
  'Expired:-', 'once removed, the export is Expired and forgets its file');

-- Report PDFs ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.report_definitions (membership_id, name, source_code) values (pg_temp.id('carol@org_a'), 'Truss Work', 'records');
insert into k select 'rep', id from app.report_definitions where name = 'Truss Work';
select pg_temp.as_platform();
insert into app.report_runs (report_definition_id, run_for_membership_id, export_format)
values ((select id from k where key = 'rep'), pg_temp.id('dave@org_a'), 'PDF');
insert into k select 'run', id from app.report_runs where report_definition_id = (select id from k where key = 'rep');
insert into private.column_classifications (table_name, column_name, classification, read_capability)
values ('app.records', 'description', 'Confidential', null);
select pg_temp.as_worker();
select results_eq($$select classification::text, viewer_email from app.report_run_classification((select id from k where key = 'run'), array['title'])$$,
  $$values ('Internal'::text, 'dave@northwind.test'::text)$$, 'a report reading Internal columns is Internal, for its viewer');
select is((select classification::text from app.report_run_classification((select id from k where key = 'run'), array['title', 'description'])),
  'Confidential', 'a Confidential column makes the report PDF Confidential');

-- Scheduling and drift ------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select lives_ok($$select private.request_export_render()$$, 'without the Vault secrets the scheduler waits quietly');
select is((select schedule from cron.job where jobname = 'xos_export_render'), '* * * * *', 'pg_cron runs the export step every minute');
-- Every app view reading a classified column shows it under the same name, classified as high, or names its source.
select is_empty($$
  select v.oid::regclass::text || '.' || a.attname
  from private.column_classifications c
  join pg_attribute b on b.attrelid = to_regclass(c.table_name) and b.attname = c.column_name
  join pg_depend d on d.refclassid = 'pg_class'::regclass and d.refobjid = b.attrelid and d.refobjsubid = b.attnum and d.classid = 'pg_rewrite'::regclass
  join pg_rewrite r on r.oid = d.objid
  join pg_class v on v.oid = r.ev_class and v.oid <> b.attrelid
  join pg_namespace n on n.oid = v.relnamespace and n.nspname = 'app'
  join pg_attribute a on a.attrelid = v.oid and a.attname = c.column_name and not a.attisdropped
  where c.classification in ('Confidential', 'Restricted')
    and private.export_column_classification(v.oid::regclass, a.attname::text) < c.classification
$$, 'every view column of a classified column''s name is classified at least as high');
select is_empty($$
  select distinct v.oid::regclass::text
  from private.column_classifications c
  join pg_attribute b on b.attrelid = to_regclass(c.table_name) and b.attname = c.column_name
  join pg_depend d on d.refclassid = 'pg_class'::regclass and d.refobjid = b.attrelid and d.refobjsubid = b.attnum and d.classid = 'pg_rewrite'::regclass
  join pg_rewrite r on r.oid = d.objid
  join pg_class v on v.oid = r.ev_class and v.oid <> b.attrelid
  join pg_namespace n on n.oid = v.relnamespace and n.nspname = 'app'
  where c.classification in ('Confidential', 'Restricted')
    and not exists (select 1 from pg_attribute a where a.attrelid = v.oid and a.attname = c.column_name and not a.attisdropped)
    and not exists (select 1 from private.view_column_sources s where s.view_name = v.oid::regclass::text
                    and s.source_table = c.table_name and s.source_column = c.column_name)
$$, 'a view showing a classified column under another name names it in private.view_column_sources');

select * from finish();
rollback;
