-- pgTAP: field media (requested by A17). Inspection findings carry a photo path; the private field-media
-- bucket takes incident and inspection media under <org_id>/<kind>/<subject_id>/, writable by those who
-- write the subject on its project and readable by those who read it; never across orgs or to anon.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(14);

select pg_temp.as_user('carol');
with x as (insert into app.incidents (project_id, title, severity_enum_id, occurred_at) values (pg_temp.id('prj_a'), 'Truss Edge Laceration', 'ENM-097', now()) returning id) insert into world select 'inc', id from x;
with x as (insert into app.inspection_templates (org_id, name) values (pg_temp.id('org_a'), 'Rigging Daily Check') returning id) insert into world select 'tmpl', id from x;
with x as (insert into app.inspection_items (inspection_template_id, position, prompt, is_critical) values (pg_temp.id('tmpl'), 1, 'Shackles moused.', true) returning id) insert into world select 'item', id from x;
with x as (insert into app.inspections (project_id, inspection_template_id) values (pg_temp.id('prj_a'), pg_temp.id('tmpl')) returning id) insert into world select 'insp', id from x;
select pg_temp.as_user('xavier');
with x as (insert into app.incidents (project_id, title, severity_enum_id, occurred_at) values (pg_temp.id('prj_b'), 'Dock Slip', 'ENM-097', now()) returning id) insert into world select 'inc_b', id from x;
select pg_temp.as_platform();

create function pg_temp.path(p_org text, p_kind text, p_subject text, p_file text) returns text
language sql stable as $$ select format('%s/%s/%s/%s', pg_temp.id(p_org), p_kind, pg_temp.id(p_subject), p_file) $$;

-- Inspection photo path ----------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select lives_ok(format($$insert into app.inspection_results (inspection_id, inspection_item_id, result_enum_id, photo_uri) values (%L, %L, 'ENM-082', %L)$$,
  pg_temp.id('insp'), pg_temp.id('item'), pg_temp.path('org_a', 'inspections', 'insp', 'shackle.jpg')), 'a finding records its photo path');
select throws_ok(format($$update app.inspection_results set photo_uri = 'photos/shackle.jpg' where inspection_id = %L$$, pg_temp.id('insp')),
  '23514', null, 'the photo path follows the field-media layout');

-- Uploads ----------------------------------------------------------------------------------------------------
select lives_ok(format($$insert into storage.objects (bucket_id, name) values ('field-media', %L)$$, pg_temp.path('org_a', 'incidents', 'inc', 'cut.jpg')),
  'an incident writer uploads incident media');
select lives_ok(format($$insert into storage.objects (bucket_id, name) values ('field-media', %L)$$, pg_temp.path('org_a', 'inspections', 'insp', 'shackle.jpg')),
  'an inspection writer uploads inspection media');
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('field-media', %L)$$, pg_temp.path('org_a', 'incidents', 'inc_b', 'cross.jpg')),
  '42501', null, 'a subject of another org under one''s own org path is refused');
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('field-media', %L)$$, format('%s/receipts/%s/x.jpg', pg_temp.id('org_a'), pg_temp.id('inc'))),
  '42501', null, 'only incident and inspection folders exist');
select pg_temp.as_user('gina');
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('field-media', %L)$$, pg_temp.path('org_a', 'incidents', 'inc', 'viewer.jpg')),
  '42501', null, 'a person who cannot write the incident cannot upload to it');
select pg_temp.as_user('xavier');
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('field-media', %L)$$, pg_temp.path('org_a', 'incidents', 'inc', 'x.jpg')),
  '42501', null, 'another org cannot upload to the incident');
select lives_ok(format($$insert into storage.objects (bucket_id, name) values ('field-media', %L)$$, pg_temp.path('org_b', 'incidents', 'inc_b', 'slip.jpg')),
  'Harbor Lights uploads to its own incident');

-- Reads -----------------------------------------------------------------------------------------------------------
-- The scanner reports every file Clean first: only the uploader reads an unscanned file (A22-011, 1041).
select pg_temp.as_platform();
update private.object_scans set scan_status = 'Clean', scanned_at = now() where bucket_id = 'field-media';
select pg_temp.as_user('xavier');
select is((select count(*)::int from storage.objects where bucket_id = 'field-media'), 1, 'another org reads only its own media');
select pg_temp.as_user('carol');
select is((select count(*)::int from storage.objects where bucket_id = 'field-media'), 2, 'an incident and inspection reader reads both files of the project');
select pg_temp.as_user('gina');
select is((select count(*)::int from storage.objects where bucket_id = 'field-media'), 0, 'a Viewer outside the project reads none');
select pg_temp.as_anon();
select is((select count(*)::int from storage.objects where bucket_id = 'field-media'), 0, 'anon reads none');
select pg_temp.as_platform();
select is((select public from storage.buckets where id = 'field-media'), false, 'the bucket is private');

select * from finish();
rollback;
