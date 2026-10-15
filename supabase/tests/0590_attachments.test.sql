-- pgTAP: attachments keyed by subject, the private attachments bucket and its storage policies, type and
-- size limits, the virus-scan state that gates downloads, and document versions (Section 7.3, Section 9).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(30);

create temporary table k (key text primary key, id uuid, val text);
grant select, insert on k to public;

select is((select public::text || ':' || file_size_limit::text from storage.buckets where id = 'attachments'), 'false:52428800',
  'the attachments bucket is private and capped at 50 MiB');
select ok((select not ('image/svg+xml' = any (allowed_mime_types)) from storage.buckets where id = 'attachments'),
  'active content such as SVG is not accepted');

-- Starting an upload ----------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into k select 'v1', attachment_version_id, object_name from app.begin_attachment_upload('app.projects', pg_temp.id('prj_a'), 'rider.pdf', 'application/pdf', 1200);
insert into k select 'a1', attachment_id from app.attachment_versions where id = (select id from k where key = 'v1');
select is((select val from k where key = 'v1'),
  pg_temp.id('org_a')::text || '/' || (select id from k where key = 'a1')::text || '/' || (select id from k where key = 'v1')::text || '/rider.pdf',
  'the database issues the object name under the org');
select results_eq($$select version_number, scan_status::text, uploaded_by from app.attachment_versions where id = (select id from k where key = 'v1')$$,
  $$values (1, 'Pending Upload'::text, pg_temp.id('dave'))$$, 'a new version waits for its file, numbered and owned by the uploader');
select throws_ok($$select app.begin_attachment_upload('app.projects', pg_temp.id('prj_a'), 'logo.svg', 'image/svg+xml', 10)$$, 'XR001', null,
  'types outside the bucket list are refused');
select throws_ok($$select app.begin_attachment_upload('app.projects', pg_temp.id('prj_a'), 'huge.mp4', 'video/mp4', 60000000)$$, 'XR001', null,
  'files over the cap are refused');
select throws_ok($$select app.begin_attachment_upload('app.projects', pg_temp.id('prj_a'), '../etc/passwd', 'text/plain', 10)$$, '23514', null,
  'file names cannot carry paths');
select throws_ok($$select app.begin_attachment_upload('app.projects', pg_temp.id('prj_a2'), 'x.pdf', 'application/pdf', 10)$$, '42501', null,
  'nobody attaches to a subject they cannot read');
select pg_temp.as_user('gina');
select throws_ok($$select app.begin_attachment_upload('app.projects', pg_temp.id('prj_a'), 'x.pdf', 'application/pdf', 10)$$, '42501', null,
  'a member who cannot read the project cannot attach to it (invariant 2)');

-- Storage policies --------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select lives_ok($$insert into storage.objects (bucket_id, name, metadata) values ('attachments', (select val from k where key = 'v1'), '{"size": 1200}')$$,
  'the uploader writes the issued object name');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('attachments', pg_temp.id('org_a')::text || '/elsewhere/x.pdf')$$, '42501', null,
  'no other object name is writable');
select pg_temp.as_user('erin');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('attachments', (select val from k where key = 'v1') || '2')$$, '42501', null,
  'nobody writes into someone else''s upload');

-- Completing and scanning -------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select app.complete_attachment_upload((select id from k where key = 'v1'), 'not-a-checksum')$$, 'XR001', null, 'the checksum is a SHA-256');
select is(app.complete_attachment_upload((select id from k where key = 'v1'), repeat('ab', 32)), 'Scanning'::app.scan_status, 'a finished upload goes to the scanner');
select throws_ok($$select app.complete_attachment_upload((select id from k where key = 'v1'), repeat('ab', 32))$$, 'XR001', null, 'an upload completes once');
select throws_ok($$update app.attachment_versions set filename = 'other.pdf' where id = (select id from k where key = 'v1')$$, 'XR001', null,
  'a version is never edited directly');
select pg_temp.as_user('erin');
select is((select count(*)::integer from storage.objects where bucket_id = 'attachments'), 0, 'an unscanned file cannot be downloaded');
select pg_temp.as_platform();
select is((select count(*)::integer from app.job_queue where job_kind = 'attachment.scan'), 1, 'the virus scan is queued');
select is(app.record_attachment_scan((select id from k where key = 'v1'), true), 'Clean'::app.scan_status, 'the scanner marks the file clean');
select is((select count(*)::integer from app.domain_events where event_type = 'attachment.added'), 1, 'a clean file emits attachment.added');
select pg_temp.as_user('erin');
select is((select count(*)::integer from storage.objects where bucket_id = 'attachments'), 1, 'a reader of the subject downloads a clean file');
select is((select count(*)::integer from app.attachments), 1, 'and sees the attachment');
select pg_temp.as_user('gina');
select is((select count(*)::integer from storage.objects where bucket_id = 'attachments') + (select count(*)::integer from app.attachments), 0,
  'a member who cannot read the subject sees neither the file nor the attachment');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from storage.objects where bucket_id = 'attachments'), 0, 'no cross-tenant downloads');

-- Versions and infected files ---------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into k select 'v2', attachment_version_id, object_name
from app.begin_attachment_upload('app.projects', pg_temp.id('prj_a'), 'rider-v2.pdf', 'application/pdf', 1300, (select id from k where key = 'a1'));
select is((select version_number from app.attachment_versions where id = (select id from k where key = 'v2')), 2, 'a new file is a new version');
insert into storage.objects (bucket_id, name, metadata) values ('attachments', (select val from k where key = 'v2'), '{"size": 1300}');
select app.complete_attachment_upload((select id from k where key = 'v2'), repeat('cd', 32));
select pg_temp.as_platform();
select is(app.record_attachment_scan((select id from k where key = 'v2'), false, 'EICAR test signature'), 'Infected'::app.scan_status, 'an infected file is recorded');
select pg_temp.as_user('erin');
select is((select count(*)::integer from storage.objects where bucket_id = 'attachments' and name = (select val from k where key = 'v2')), 0,
  'an infected file is never downloadable');

-- Documents ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
with x as (insert into app.documents (org_id, project_id, title) values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Stage Plot') returning id)
insert into k (key, id) select 'doc', id from x;
insert into k select 'dv', attachment_version_id, object_name from app.begin_attachment_upload('app.documents', (select id from k where key = 'doc'), 'stage-plot.pdf', 'application/pdf', 900);
insert into storage.objects (bucket_id, name, metadata) values ('attachments', (select val from k where key = 'dv'), '{"size": 900}');
select app.complete_attachment_upload((select id from k where key = 'dv'), repeat('ef', 32));
select pg_temp.as_platform();
select app.record_attachment_scan((select id from k where key = 'dv'), true);
select results_eq($$select dv.storage_uri, dv.checksum_sha256 from app.attachment_versions v join app.document_versions dv on dv.id = v.document_version_id
  where v.id = (select id from k where key = 'dv')$$,
  $$values ('storage://attachments/' || (select val from k where key = 'dv'), repeat('ef', 32))$$, 'a clean file on a document becomes a document version');

-- Removal ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('erin');
with u as (update app.attachments set deleted_at = now() where id = (select id from k where key = 'a1') returning 1)
select is((select count(*)::integer from u), 0, 'only the person who attached a file removes it');
select pg_temp.as_user('dave');
update app.attachments set deleted_at = now() where id = (select id from k where key = 'a1');
select pg_temp.as_platform();
select is((select count(*)::integer from app.domain_events where event_type = 'attachment.removed'), 1, 'a removal is soft and emits attachment.removed');

select * from finish();
rollback;
