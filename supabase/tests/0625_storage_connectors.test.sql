-- pgTAP: storage connectors (Section 17: document links and import). File links follow the document's read and write
-- access (invariant 2), need a Connected storage connection, keep their file and document, and only the runner writes
-- import details. Imports run through A18's scanned attachment pipeline and become document versions only when Clean.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

select pg_temp.as_user('bob');
with c as (insert into app.integration_connections (org_id, provider_code, display_name) values (pg_temp.id('org_a'), 'google_drive', 'Production Drive') returning id)
  insert into world select 'drive', id from c;
with c as (insert into app.integration_connections (org_id, provider_code, display_name) values (pg_temp.id('org_a'), 'dropbox', 'Dropbox') returning id)
  insert into world select 'dropbox', id from c;
with c as (insert into app.integration_connections (org_id, provider_code, display_name) values (pg_temp.id('org_a'), 'slack', 'Slack') returning id)
  insert into world select 'slack', id from c;
select app.store_integration_credential(pg_temp.id('drive'), 'fixture-token', 'OAuth Token');
select app.transition_integration_connection(pg_temp.id('drive'), 'Pending', 'Connected', 'Authorized.');
select app.store_integration_credential(pg_temp.id('slack'), 'fixture-token', 'OAuth Token');
select app.transition_integration_connection(pg_temp.id('slack'), 'Pending', 'Connected', 'Authorized.');
select pg_temp.as_user('alice');
with x as (insert into app.documents (org_id, project_id, title) values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Stage Plot') returning id) insert into world select 'doc', id from x;
with x as (insert into app.documents (org_id, project_id, title) values (pg_temp.id('org_a'), pg_temp.id('prj_a2'), 'Gala Floor Plan') returning id) insert into world select 'doc_gala', id from x;

-- Links ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.integration_file_links (integration_connection_id, document_id, external_file_id, file_name, web_url) values (pg_temp.id('drive'), pg_temp.id('doc'), 'drv-1', 'Stage Plot.pdf', 'https://drive.google.com/file/d/drv-1') returning id)
  insert into world select 'link', id from x;
select ok(pg_temp.id('link') is not null, 'a Manager who writes the document links a Drive file to it');
select is((select org_id from app.integration_file_links where id = pg_temp.id('link')), pg_temp.id('org_a'), 'the org comes from the connection');
select throws_ok($$insert into app.integration_file_links (integration_connection_id, document_id, external_file_id, file_name) values ((select id from world where key = 'drive'), (select id from world where key = 'doc'), 'drv-1', 'Again.pdf')$$,
  '23505', null, 'a file links to a document once per connection');
select throws_ok($$insert into app.integration_file_links (integration_connection_id, document_id, external_file_id, file_name) values ((select id from world where key = 'dropbox'), (select id from world where key = 'doc'), 'dbx-1', 'Plot.pdf')$$,
  'XR001', 'integration_not_connected: Link files from a Connected storage connection.', 'a Pending connection links nothing');
select throws_ok($$insert into app.integration_file_links (integration_connection_id, document_id, external_file_id, file_name) values ((select id from world where key = 'slack'), (select id from world where key = 'doc'), 'F1', 'Plot.pdf')$$,
  'XR001', 'integration_category_mismatch: integration_file_links rows belong to a Storage connection, not a Communication connection.', 'only storage connections link files');
select throws_ok($$insert into app.integration_file_links (integration_connection_id, document_id, external_file_id, file_name, web_url) values ((select id from world where key = 'drive'), (select id from world where key = 'doc'), 'drv-2', 'Plot.pdf', 'http://insecure.example.com')$$,
  '23514', null, 'links open over HTTPS only');
select throws_ok($$update app.integration_file_links set imported_version = 'r9', last_imported_at = now() where id = (select id from world where key = 'link')$$,
  'XR001', 'file_import_runner_only: Import details are written only by the integration runner.', 'import details are runner-only');
select throws_ok($$update app.integration_file_links set document_id = (select id from world where key = 'doc_gala') where id = (select id from world where key = 'link')$$,
  'XR001', 'file_link_fixed: A file link keeps its file and document; link the other file separately.', 'a link keeps its document');
select lives_ok($$update app.integration_file_links set link_mode = 'Import' where id = (select id from world where key = 'link')$$, 'the writer switches the link to Import');
select pg_temp.as_user('dave');
select is((select count(*)::int from app.integration_file_links), 1, 'a project Member reads the link through the document');
select throws_ok($$insert into app.integration_file_links (integration_connection_id, document_id, external_file_id, file_name) values ((select id from world where key = 'drive'), (select id from world where key = 'doc_gala'), 'drv-3', 'Plot.pdf')$$,
  '42501', null, 'a Member cannot link to a document of a project they are not on');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.integration_file_links), 0, 'a Viewer outside the project reads none (invariant 2)');
select throws_ok($$insert into app.integration_file_links (integration_connection_id, document_id, external_file_id, file_name) values ((select id from world where key = 'drive'), (select id from world where key = 'doc'), 'drv-4', 'Plot.pdf')$$,
  '42501', null, 'a Viewer cannot link');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.integration_file_links), 0, 'another org reads none');
select pg_temp.as_anon();
select throws_ok('select 1 from app.integration_file_links', '42501', null, 'anon cannot read file links');

-- Import through the scanned pipeline -------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$select app.begin_file_import((select id from world where key = 'link'))$$, '42501', null, 'signed-in callers cannot run imports');
select pg_temp.as_platform();
select throws_ok($$select app.begin_file_import((select id from world where key = 'link'))$$,
  'XR001', 'file_import_metadata: Refresh the link so its type and size are known before importing.', 'an import needs the file''s type and size');
select lives_ok($$select app.refresh_file_link((select id from world where key = 'link'), 'Stage Plot.pdf', 'application/pdf', 2048, 'https://drive.google.com/file/d/drv-1', 'rev-2', '2027-05-01 10:00+00')$$,
  'the runner refreshes the link metadata');
create temporary table k (key text primary key, val text);
insert into k select 'object', object_name from app.begin_file_import(pg_temp.id('link'));
select ok((select last_attachment_version_id is not null and attachment_id is not null from app.integration_file_links where id = pg_temp.id('link')), 'the import opens an attachment version on the document');
select is((select a.subject_id from app.attachments a join app.integration_file_links l on l.attachment_id = a.id where l.id = pg_temp.id('link')), pg_temp.id('doc'), 'attached to the linked document');
select throws_ok($$select app.finish_file_import((select id from world where key = 'link'), repeat('a', 64), 'rev-2')$$,
  'XR001', 'attachment_upload_missing: Upload the file before completing the upload.', 'the bytes must be stored first');
insert into storage.objects (bucket_id, name, metadata) values ('attachments', (select val from k where key = 'object'), '{"size": 2048}');
select is(app.finish_file_import(pg_temp.id('link'), repeat('a', 64), 'rev-2'), 'Scanning'::app.scan_status, 'finishing hands the file to the virus scan');
select is((select imported_version from app.integration_file_links where id = pg_temp.id('link')), 'rev-2', 'the imported revision is recorded');
select is((select count(*)::int from app.document_versions where document_id = pg_temp.id('doc')), 0, 'no document version before the scan');
select app.record_attachment_scan((select last_attachment_version_id from app.integration_file_links where id = pg_temp.id('link')), true);
select is((select count(*)::int from app.document_versions where document_id = pg_temp.id('doc')), 1, 'a Clean scan makes the import a document version');
select is((select count(*)::int from app.job_queue where job_kind = 'attachment.scan'), 1, 'the scan ran through the job queue');

-- A second revision becomes version two of the same attachment
select app.refresh_file_link(pg_temp.id('link'), 'Stage Plot.pdf', 'application/pdf', 4096, 'https://drive.google.com/file/d/drv-1', 'rev-3', '2027-05-02 10:00+00');
insert into k select 'object2', object_name from app.begin_file_import(pg_temp.id('link'));
select is((select count(*)::int from app.attachments where subject_id = pg_temp.id('doc')), 1, 'a new revision reuses the attachment');
select is((select count(*)::int from app.attachment_versions v join app.integration_file_links l on l.attachment_id = v.attachment_id where l.id = pg_temp.id('link')), 2, 'as its next version');

-- Refusals
select pg_temp.as_user('carol');
update app.integration_file_links set link_mode = 'Link' where id = pg_temp.id('link');
select pg_temp.as_platform();
select throws_ok($$select app.begin_file_import((select id from world where key = 'link'))$$,
  'XR001', 'file_link_not_import: Only an Import link copies the file into XOS.', 'a plain link is never imported');
select throws_ok($$select app.refresh_file_link(gen_random_uuid(), 'x', null, null, null, null, null)$$,
  'XR001', 'file_link_unknown: The file link does not exist or was removed.', 'refreshing an unknown link is refused');
select pg_temp.as_user('alice');
with x as (insert into app.integration_file_links (integration_connection_id, document_id, external_file_id, file_name, link_mode) values (pg_temp.id('drive'), pg_temp.id('doc'), 'drv-svg', 'Logo.svg', 'Import') returning id) insert into world select 'svg', id from x;
select pg_temp.as_platform();
select app.refresh_file_link(pg_temp.id('svg'), 'Logo.svg', 'image/svg+xml', 10, null, 'r1', null);
select throws_ok($$select app.begin_file_import((select id from world where key = 'svg'))$$, 'XR001', null, 'active content such as SVG is never imported');
select throws_ok($$select app.finish_file_import((select id from world where key = 'svg'), repeat('a', 64), 'r1')$$,
  'XR001', 'file_import_not_started: Start the import before finishing it.', 'an import cannot finish before it starts');

select * from finish();
rollback;
