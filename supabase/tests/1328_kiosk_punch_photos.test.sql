-- pgTAP: migration 1328, kiosk punch photos in the field-media bucket (A76, RRR-121, A65-001). A kiosk run by
-- someone with org.time_attendance.write stores the photo time.photo_on_punch asks for under
-- <org_id>/kiosk-punches/<project_id>/; a field member cannot write there, another org cannot, and a project of
-- another org under one's own org path is refused. Supervisors who read the project's time read the photo; anon
-- reads nothing. The stored name is the photo a kiosk punch then carries.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(9);

create function pg_temp.kiosk_path(p_org text, p_project text, p_file text) returns text
language sql stable as $$ select format('%s/kiosk-punches/%s/%s', pg_temp.id(p_org), pg_temp.id(p_project), p_file) $$;

select pg_temp.as_platform();
select results_eq(format($$select kind, project_id from private.field_media_subject(%L)$$, pg_temp.kiosk_path('org_a', 'prj_a', 'erin-in.jpg')),
  format($$values ('kiosk-punches'::text, %L::uuid)$$, pg_temp.id('prj_a')), 'a kiosk punch photo belongs to its project');

select pg_temp.as_user('alice');
select lives_ok(format($$insert into storage.objects (bucket_id, name) values ('field-media', %L)$$, pg_temp.kiosk_path('org_a', 'prj_a', 'erin-in.jpg')),
  'the person running the kiosk (org.time_attendance.write) stores the photo');
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('field-media', %L)$$, pg_temp.kiosk_path('org_a', 'prj_b', 'cross.jpg')),
  '42501', null, 'a project of another org under one''s own org path is refused');
select pg_temp.as_user('frank');
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('field-media', %L)$$, pg_temp.kiosk_path('org_a', 'prj_a', 'frank.jpg')),
  '42501', null, 'a field member cannot store kiosk photos');
select pg_temp.as_user('xavier');
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('field-media', %L)$$, pg_temp.kiosk_path('org_a', 'prj_a', 'x.jpg')),
  '42501', null, 'another org cannot store photos for the project');

-- Reads, once the scanner reports the file Clean (1041).
select pg_temp.as_platform();
update private.object_scans set scan_status = 'Clean', scanned_at = now() where bucket_id = 'field-media';
select pg_temp.as_user('carol');
select is((select count(*)::int from storage.objects where bucket_id = 'field-media'), 1, 'a supervisor who reads the project''s time sees the photo');
select pg_temp.as_user('xavier');
select is((select count(*)::int from storage.objects where bucket_id = 'field-media'), 0, 'another org reads none');
select pg_temp.as_anon();
select is((select count(*)::int from storage.objects where bucket_id = 'field-media'), 0, 'anon reads none');

-- The punch carries the stored photo.
select pg_temp.as_user('bob');
create temporary table kiosk_key as select * from app.register_kiosk_device(pg_temp.id('org_a'), 'Pavilion Kiosk', pg_temp.id('prj_a'));
grant select on kiosk_key to public;
select app.set_kiosk_pin(pg_temp.id('erin@org_a'), '2468');
select app.set_setting(pg_temp.id('org_a'), 'time.kiosk_enabled', 'Organization', pg_temp.id('org_a'), p_value_boolean => true);
select app.set_setting(pg_temp.id('org_a'), 'time.photo_on_punch', 'Organization', pg_temp.id('org_a'), p_value_boolean => true);
select pg_temp.as_platform();
select is((select refusal from app.kiosk_punch((select device_key from kiosk_key), pg_temp.id('erin@org_a'), '2468', private.uuid_v7(), 'In', now(),
  null, 'storage://field-media/' || pg_temp.kiosk_path('org_a', 'prj_a', 'erin-in.jpg'))),
  null, 'a kiosk punch with the stored photo is recorded');

select * from finish();
rollback;
