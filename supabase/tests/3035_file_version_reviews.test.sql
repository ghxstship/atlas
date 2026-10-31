-- pgTAP: file version reviews (3035, B14 G-268; ADR 0153 D6). A writer of the subject reviews a Clean version of a file
-- on a submittal or a record; the uploader cannot (sod_file_review_uploader), a version still scanning cannot be
-- reviewed and asking for changes needs a note. Each version keeps its own history and a new one starts unreviewed. A
-- submittal is not Approved while a current file stands at Changes Requested, and is once a newer version is approved
-- or the file is removed. The vendor reads each Clean version's decision and note, never who reviewed, and another
-- vendor account reads nothing.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(22);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- A version of a file on a subject, uploaded by a user; Clean unless asked otherwise.
create function pg_temp.upload(p_user text, p_table text, p_subject text, p_name text, p_clean boolean default true,
  p_attachment uuid default null) returns uuid
language plpgsql as $$
declare
  v_version uuid;
  v_object text;
begin
  perform pg_temp.as_user(p_user);
  select u.attachment_version_id, u.object_name into v_version, v_object
  from app.begin_attachment_upload(p_table, pg_temp.id(p_subject), p_name, 'application/pdf', 1200, p_attachment) u;
  insert into storage.objects (bucket_id, name, metadata) values ('attachments', v_object, '{"size": 1200}');
  perform app.complete_attachment_upload(v_version, repeat('ab', 32));
  perform pg_temp.as_platform();
  if p_clean then
    perform app.record_attachment_scan(v_version, true);
  end if;
  insert into k values (p_name, v_version);
  return v_version;
end $$;
create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

select has_table('app', 'attachment_version_reviews', 'app.attachment_version_reviews exists');
select is((select description from private.separation_of_duties_rules where code = 'sod_file_review_uploader'),
  'The person who uploaded a file version cannot review it.', 'the new separation-of-duties rule is registered');

-- Fixture: a submittal of Bayside Audio on prj_a, created by carol; dave uploads its rigging plan.
select pg_temp.as_user('carol');
with v as (insert into app.vendors (counterparty_id) values (pg_temp.id('cp_v_a')) returning id) insert into world select 'ven', id from v;
with x as (insert into app.submittals (project_id, vendor_id, submittal_kind, title)
  values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'Shop Drawing', 'Delay tower rigging plan') returning id)
  insert into world select 'sub', id from x;
select app.transition_submittal(pg_temp.id('sub'), 'Proposed', 'Submitted', 'Sent for review.');
select pg_temp.upload('dave', 'app.submittals', 'sub', 'rigging-v1.pdf');
select pg_temp.upload('dave', 'app.submittals', 'sub', 'rigging-scan.pdf', false);

-- Who reviews.
select pg_temp.as_user('dave');
select throws_ok(format($$select app.review_attachment_version(%L, 'Approved')$$, (select id from k where key = 'rigging-v1.pdf')),
  '42501', 'procurement.po.write is required on the project', 'a reviewer needs the subject''s write capability');
select pg_temp.upload('bob', 'app.submittals', 'sub', 'rigging-notes.pdf');
select pg_temp.as_user('bob');
select throws_ok(format($$select app.review_attachment_version(%L, 'Approved')$$, (select id from k where key = 'rigging-notes.pdf')),
  'XR001', 'sod_file_review_uploader: The person who uploaded a file version cannot review it.', 'the uploader cannot review it');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.review_attachment_version(%L, 'Approved')$$, (select id from k where key = 'rigging-scan.pdf')),
  'XR001', 'file_review_not_clean: Only a file that passed its virus scan is reviewed.', 'a version that is not Clean is not reviewed');
select throws_ok(format($$select app.review_attachment_version(%L, 'Changes Requested')$$, (select id from k where key = 'rigging-v1.pdf')),
  'XR001', 'file_review_note_required: Say what to change in up to 1,000 characters.', 'asking for changes needs a note');
select lives_ok(format($$select app.review_attachment_version(%L, 'Changes Requested', 'Show the bridle angles.')$$,
  (select id from k where key = 'rigging-v1.pdf')), 'carol asks for changes on version 1');
select is((select row(decision, note, reviewer_person_id, is_current)::text from app.attachment_review_status
           where attachment_version_id = (select id from k where key = 'rigging-v1.pdf')),
  row('Changes Requested', 'Show the bridle angles.', pg_temp.id('carol'), true)::text, 'the status view shows the latest review');
select throws_ok(format($$update app.attachment_version_reviews set note = 'Edited.' where attachment_version_id = %L$$,
  (select id from k where key = 'rigging-v1.pdf')), '42501', null, 'reviews are not edited');

-- The submittal waits for its file.
select pg_temp.as_user('bob');
select throws_ok(format($$select app.transition_submittal(%L, 'Submitted', 'Approved', 'Looks good.')$$, pg_temp.id('sub')),
  'XR001', 'submittal_files_changes_requested: A file of this submittal needs changes; review its newest version first.',
  'a submittal is not Approved while its current file stands at Changes Requested');

-- Version 2 of the same file starts unreviewed; approved, it lets the submittal through.
select pg_temp.upload('dave', 'app.submittals', 'sub', 'rigging-v2.pdf', true,
  (select v.attachment_id from app.attachment_versions v where v.id = (select id from k where key = 'rigging-v1.pdf')));
select pg_temp.as_user('carol');
select is((select row(version_number, decision, is_current)::text from app.attachment_review_status
           where attachment_version_id = (select id from k where key = 'rigging-v2.pdf')),
  row(2, null::app.file_review_decision, true)::text, 'a new version starts unreviewed and becomes current');
select app.review_attachment_version((select id from k where key = 'rigging-v2.pdf'), 'Approved');
select is((select string_agg(version_number || ':' || decision, ', ' order by version_number) from app.attachment_review_status
           where attachment_id = (select v.attachment_id from app.attachment_versions v where v.id = (select id from k where key = 'rigging-v1.pdf'))),
  '1:Changes Requested, 2:Approved', 'each version keeps its own history');
select pg_temp.as_user('bob');
select lives_ok(format($$select app.transition_submittal(%L, 'Submitted', 'Approved', 'Looks good.')$$, pg_temp.id('sub')),
  'once the newer version is approved the submittal is Approved');

-- Removing a file that needs changes (only the person who attached it does) also lets a submittal through; the latest review is a version's decision.
select pg_temp.as_user('carol');
with x as (insert into app.submittals (project_id, vendor_id, submittal_kind, title)
  values (pg_temp.id('prj_a'), pg_temp.id('ven'), 'Product Data', 'Line array cut sheets') returning id)
  insert into world select 'sub2', id from x;
select app.transition_submittal(pg_temp.id('sub2'), 'Proposed', 'Submitted', 'Sent for review.');
select pg_temp.upload('dave', 'app.submittals', 'sub2', 'cut-sheets-a.pdf');
select pg_temp.upload('dave', 'app.submittals', 'sub2', 'cut-sheets-b.pdf');
select pg_temp.upload('dave', 'app.submittals', 'sub2', 'cut-sheets-old.pdf');
select pg_temp.as_user('carol');
select app.review_attachment_version((select id from k where key = 'cut-sheets-a.pdf'), 'Changes Requested', 'Add the rigging points.');
select app.review_attachment_version((select id from k where key = 'cut-sheets-a.pdf'), 'Approved', 'Points added.');
select app.review_attachment_version((select id from k where key = 'cut-sheets-b.pdf'), 'Approved');
select app.review_attachment_version((select id from k where key = 'cut-sheets-old.pdf'), 'Changes Requested', 'Superseded.');
select is((select decision::text from app.attachment_review_status where attachment_version_id = (select id from k where key = 'cut-sheets-a.pdf')),
  'Approved', 'the latest review of a version is its decision');
select pg_temp.as_user('bob');
select throws_ok(format($$select app.transition_submittal(%L, 'Submitted', 'Approved', 'Looks good.')$$, pg_temp.id('sub2')),
  'XR001', null, 'one file needing changes still holds the submittal');
select pg_temp.as_user('dave');
update app.attachments set deleted_at = now()
where id = (select v.attachment_id from app.attachment_versions v where v.id = (select id from k where key = 'cut-sheets-old.pdf'));
select pg_temp.as_user('bob');
select lives_ok(format($$select app.transition_submittal(%L, 'Submitted', 'Approved', 'All files approved.')$$, pg_temp.id('sub2')),
  'once that file is removed the submittal is Approved');

-- A record's files are reviewed with work.record.write.
select pg_temp.as_user('carol');
with x as (insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id('prj_a'), 'Task', 'Execute', 'Rig the follow spots', 'Y', 'Declared') returning id) insert into world select 't1', id from x;
select pg_temp.upload('dave', 'app.records', 't1', 'spot-plot.pdf');
select pg_temp.as_user('erin');
select lives_ok(format($$select app.review_attachment_version(%L, 'Approved')$$, (select id from k where key = 'spot-plot.pdf')),
  'a Coordinator of the project reviews a record''s file');

-- Files on another subject are not reviewed.
select pg_temp.upload('carol', 'app.projects', 'prj_a', 'site-photo.pdf');
select pg_temp.as_user('bob');
select throws_ok(format($$select app.review_attachment_version(%L, 'Approved')$$, (select id from k where key = 'site-photo.pdf')),
  'XR001', 'file_review_subject: Files are reviewed on submittals and records.', 'only submittal and record files are reviewed');

-- The vendor's view.
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select is(pg_temp.n('victor', $$select 1 from api_external.submittal_files where submittal_id = '$$ || pg_temp.id('sub2') || $$'$$), 2,
  'the vendor''s Account Owner reads each Clean version of its submittal''s files');
select is(pg_temp.n('victor', $$select 1 from api_external.submittal_files where submittal_id = '$$ || pg_temp.id('sub2')
  || $$' and title = 'cut-sheets-a.pdf' and review_decision = 'Approved' and review_comment = 'Points added.' and reviewed_at is not null$$), 1, 'with the latest decision and the comment meant for the vendor');
select hasnt_column('api_external', 'submittal_files', 'reviewer_person_id', 'the reviewer never appears');
select is(pg_temp.n('xavier', 'select 1 from api_external.submittal_files'), 0, 'another account reads nothing');

select * from finish();
rollback;
