-- pgTAP: migration 2712 (R9), party uploads. Insert is allowed only for the recipient side of a File section of a sent
-- packet while the engagement is open, and for the sponsor's Owner or Admin under its entitlement; nobody but the
-- uploader reads an object before it scans Clean, then org readers do; the object_scans row is queued; the
-- register_party_upload refusals; a File answer takes the registered documents once; scanned_upload_bucket includes
-- party-uploads; app.party_file_object serves only readers.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql

select no_plan();

create function pg_temp.adv(p_file text) returns text
language sql stable as $$ select pg_temp.id('org_a') || '/advance/' || pg_temp.id('rcp') || '/' || pg_temp.id('s_file') || '/' || p_file $$;
create function pg_temp.spon(p_file text) returns text
language sql stable as $$ select pg_temp.id('org_a') || '/sponsor-asset/' || pg_temp.id('ent') || '/' || p_file $$;
create function pg_temp.upload(p_who text, p_name text) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user(p_who);
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values ('party-uploads', p_name, pg_temp.id(p_who || '_user')::text, jsonb_build_object('mimetype', 'application/pdf', 'size', 2048));
end $$;
create function pg_temp.visible(p_who text, p_name text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  select count(*)::integer into v from storage.objects o where o.bucket_id = 'party-uploads' and o.name = p_name;
  perform pg_temp.as_platform();
  return v;
end $$;

select ok(private.scanned_upload_bucket('party-uploads'), 'party uploads are virus-scanned');
select is((select public from storage.buckets where id = 'party-uploads'), false, 'the bucket is private');
select is((select file_size_limit from storage.buckets where id = 'party-uploads'), 26214400::bigint, 'and takes files up to 25 MB');

-- Fixture: a File section sent to Bayside Audio; Brightwave Drinks sponsors prj_a ----------------------------------------------
select pg_temp.as_user('dave');
with x as (insert into app.advance_packets (project_id, title) values (pg_temp.id('prj_a'), 'Vendor Advance') returning id)
insert into world select 'pkt', id from x;
with x as (insert into app.advance_sections (advance_packet_id, position, title, section_kind, max_lines)
  values (pg_temp.id('pkt'), 1, 'Stage plot', 'File', 2) returning id) insert into world select 's_file', id from x;
with x as (insert into app.advance_sections (advance_packet_id, position, title) values (pg_temp.id('pkt'), 2, 'Notes') returning id)
insert into world select 's_text', id from x;
with x as (insert into app.advance_recipients (advance_packet_id, counterparty_id, engagement_id)
  values (pg_temp.id('pkt'), pg_temp.id('cp_v_a'), pg_temp.id('eng_vendor_a')) returning id) insert into world select 'rcp', id from x;

select throws_ok($$select pg_temp.upload('victor', pg_temp.adv('early.pdf'))$$, '42501', null, 'nothing is uploaded before the packet is sent');
select pg_temp.as_user('dave');
select app.send_advance_packet(pg_temp.id('pkt'));

select pg_temp.new_user('sol', 'sol@brightwave-drinks.test', 'Sol Ferreira');
select pg_temp.as_user('sol');
insert into world values ('acct_s', app.create_external_account('Brightwave Drinks', 'brightwave-drinks'));
select pg_temp.as_user('alice');
insert into world values ('cp_s_a', app.create_counterparty(pg_temp.id('org_a'), null, null, pg_temp.id('acct_s')));
with e as (insert into app.engagements (project_id, person_id, counterparty_id, role_type, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('sol'), pg_temp.id('cp_s_a'), 'Sponsor', '2027-06-01') returning id) insert into world select 'eng_sponsor', id from e;
select pg_temp.as_user('carol');
with s as (insert into app.sponsor_entitlements (project_id, counterparty_id, description, quantity)
  values (pg_temp.id('prj_a'), pg_temp.id('cp_s_a'), 'Main stage banner placement', 2) returning id) insert into world select 'ent', id from s;
select pg_temp.move_engagement('eng_sponsor', 'Onboarding', 'Active');

-- Who uploads ----------------------------------------------------------------------------------------------------------------------
select lives_ok($$select pg_temp.upload('victor', pg_temp.adv('stage-plot.pdf'))$$, 'the recipient account''s Owner uploads to a File section');
select throws_ok($$select pg_temp.upload('quinn', pg_temp.adv('intruder.pdf'))$$, '42501', null, 'another party cannot upload there');
select throws_ok($$select pg_temp.upload('kai', pg_temp.adv('kai.pdf'))$$, '42501', null, 'nor an Account Member nobody assigned');
select throws_ok($$select pg_temp.upload('victor', pg_temp.id('org_a') || '/advance/' || pg_temp.id('rcp') || '/' || pg_temp.id('s_text') || '/x.pdf')$$,
  '42501', null, 'a Text section takes no uploads');
select throws_ok($$select pg_temp.upload('victor', pg_temp.id('org_a') || '/stage-plot.pdf')$$, '42501', null, 'a name outside the folders is refused');
select lives_ok($$select pg_temp.upload('sol', pg_temp.spon('logo.pdf'))$$, 'the sponsor''s Owner uploads under its entitlement');
select throws_ok($$select pg_temp.upload('victor', pg_temp.spon('not-mine.pdf'))$$, '42501', null, 'another party cannot upload a sponsor asset');
select pg_temp.as_platform();
select is((select scan_status::text from private.object_scans where bucket_id = 'party-uploads' and object_name = pg_temp.adv('stage-plot.pdf')),
  'Scanning', 'the upload is queued for scanning');

-- Reading waits for a Clean scan ---------------------------------------------------------------------------------------------------
select is(pg_temp.visible('victor', pg_temp.adv('stage-plot.pdf')), 1, 'the uploader reads their file while it is scanned');
select is(pg_temp.visible('carol', pg_temp.adv('stage-plot.pdf')), 0, 'an org reader cannot read it before it scans Clean');
select is(app.record_object_scan((select id from private.object_scans where bucket_id = 'party-uploads' and object_name = pg_temp.adv('stage-plot.pdf')), true),
  'Clean'::app.scan_status, 'the worker records it Clean');
select is(pg_temp.visible('carol', pg_temp.adv('stage-plot.pdf')), 1, 'then the org reader reads it');
select is(pg_temp.visible('xavier', pg_temp.adv('stage-plot.pdf')), 0, 'another tenant never reads it');
select is(pg_temp.visible('gina', pg_temp.adv('stage-plot.pdf')), 0, 'nor a Viewer outside the project');

-- Registering ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('victor');
select throws_ok($$select app.register_party_upload(pg_temp.adv('missing.pdf'), 'Missing', repeat('a', 64))$$,
  'XR001', 'party_upload_missing: Upload the file before registering it.', 'an object that was never uploaded is not registered');
select throws_ok($$select app.register_party_upload(pg_temp.adv('stage-plot.pdf'), 'Stage plot', 'ABC')$$,
  'XR001', 'party_upload_checksum: The file checksum must be a SHA-256 in lowercase hex.', 'the checksum is a lowercase SHA-256');
select pg_temp.as_user('quinn');
select throws_ok($$select app.register_party_upload(pg_temp.adv('stage-plot.pdf'), 'Stage plot', repeat('a', 64))$$,
  '42501', null, 'another party cannot register it');
select pg_temp.as_user('victor');
insert into world values ('doc', app.register_party_upload(pg_temp.adv('stage-plot.pdf'), 'Stage plot', repeat('a', 64)));
select pg_temp.as_platform();
select is((select project_id from app.documents where id = pg_temp.id('doc')), pg_temp.id('prj_a'), 'the file becomes a document of the packet''s project');
select is((select storage_uri from app.document_versions where document_id = pg_temp.id('doc')), 'storage://party-uploads/' || pg_temp.adv('stage-plot.pdf'),
  'with its first version in party-uploads');

-- A File answer ----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('victor');
select throws_ok($$select app.submit_advance_answer((select id from world where key = 'rcp'), (select id from world where key = 's_file'), null, null, '[]', '{}')$$,
  'XR001', 'advance_file_document: Attach 1 to 2 files.', 'a File answer attaches at least one file');
insert into world values ('a_file', app.submit_advance_answer(pg_temp.id('rcp'), pg_temp.id('s_file'), null, 'Revision B.', '[]', array[pg_temp.id('doc')]));
select pg_temp.as_platform();
select is((select body from app.advance_submissions where id = pg_temp.id('a_file')), 'FILES Stage plot', 'the body names the files');
select is((select count(*)::int from app.advance_submission_files where advance_submission_id = pg_temp.id('a_file')), 1, 'the file is attached to the answer');
select pg_temp.as_user('victor');
select is((select scan_status from api_external.advance_submission_files where advance_submission_id = pg_temp.id('a_file')), 'Clean',
  'the party sees the file with its scan state');
select pg_temp.as_user('carol');
update app.advance_submissions set review_outcome = 'Returned', return_reason = 'Show the risers.' where id = pg_temp.id('a_file');
select pg_temp.as_user('victor');
select throws_ok($$select app.submit_advance_answer((select id from world where key = 'rcp'), (select id from world where key = 's_file'), null, null, '[]',
  array[(select id from world where key = 'doc')])$$,
  'XR001', 'advance_file_document: Each file is uploaded for this recipient and section and attached once.', 'a document is attached once');

-- Serving --------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into world select 'ver', id from app.document_versions where document_id = pg_temp.id('doc');
select pg_temp.as_user('carol');
select is((select object_name from app.party_file_object(pg_temp.id('ver'))), pg_temp.adv('stage-plot.pdf'), 'an org reader learns which object a version is');
select is((select content_type from app.party_file_object(pg_temp.id('ver'))), 'application/pdf', 'with its content type');
select pg_temp.as_user('quinn');
select is((select count(*)::int from app.party_file_object(pg_temp.id('ver'))), 0, 'another party learns nothing');

select * from finish();
rollback;
