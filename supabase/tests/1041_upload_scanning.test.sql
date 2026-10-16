-- A22-011: uploads to the four buckets without an attachment record get a scan state. In the private
-- buckets only the uploader reads an object before it scans Clean; the worker API claims, records and
-- retries scans; public buckets are scanned too (the worker removes what is not clean).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(27);

-- Catalog -------------------------------------------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'private.object_scans'::regclass), 'object_scans has RLS on');
select ok(not has_table_privilege('authenticated', 'private.object_scans', 'select'), 'signed-in callers cannot read scan rows');
select ok(not has_function_privilege('authenticated', 'app.claim_object_scans(text, integer)', 'execute')
  and not has_function_privilege('authenticated', 'app.record_object_scan(uuid, boolean, text)', 'execute')
  and not has_function_privilege('authenticated', 'app.release_object_scan(uuid, text)', 'execute')
  and not has_function_privilege('anon', 'app.record_object_scan(uuid, boolean, text)', 'execute'),
  'only the service role claims, records or releases scans');
select ok(not has_function_privilege('authenticated', 'app.record_attachment_scan(uuid, boolean, text)', 'execute'),
  'control: only the service role records attachment scans');

-- Dave (member of org A) uploads a form photo to field-media under his own folder.
create function pg_temp.form_photo(p_file text) returns text
language sql stable as $$ select pg_temp.id('org_a') || '/forms/' || pg_temp.id('dave') || '/' || p_file $$;

select pg_temp.as_user('dave');
insert into storage.objects (bucket_id, name, owner_id, metadata)
values ('field-media', pg_temp.form_photo('crack.jpg'), pg_temp.id('dave_user')::text,
        jsonb_build_object('mimetype', 'image/jpeg', 'size', 2048));

select pg_temp.as_platform();
select is((select scan_status from private.object_scans where bucket_id = 'field-media' and object_name = pg_temp.form_photo('crack.jpg')),
  'Scanning'::app.scan_status, 'a new field-media object is queued for scanning');

create function pg_temp.visible(p_name text) returns integer
language sql stable as $$ select count(*)::integer from storage.objects o where o.bucket_id = 'field-media' and o.name = p_name $$;

select pg_temp.as_user('dave');
select is(pg_temp.visible(pg_temp.form_photo('crack.jpg')), 1, 'the uploader reads their own file while it is scanned');
select pg_temp.as_user('alice');
select is(pg_temp.visible(pg_temp.form_photo('crack.jpg')), 0, 'a form publisher cannot read the file before it scans Clean');
select pg_temp.as_user('xavier');
select is(pg_temp.visible(pg_temp.form_photo('crack.jpg')), 0, 'cross-tenant: another org never reads it');
select pg_temp.as_anon();
select is(pg_temp.visible(pg_temp.form_photo('crack.jpg')), 0, 'anon never reads it');

-- The worker claims it; a second worker gets nothing.
select pg_temp.as_platform();
create temporary table claimed as select * from app.claim_object_scans('scanner-1', 10)
  where object_name = pg_temp.form_photo('crack.jpg');
select is((select count(*)::integer from claimed), 1, 'a worker claims the due scan');
select is((select content_type from claimed), 'image/jpeg', 'the claim carries the declared type');
select is((select size_bytes from claimed), 2048::bigint, 'the claim carries the stored size');
select is((select count(*)::integer from app.claim_object_scans('scanner-2', 10) where object_name = pg_temp.form_photo('crack.jpg')),
  0, 'a second worker does not claim a scan another holds');

select is(app.record_object_scan((select object_scan_id from claimed), true), 'Clean'::app.scan_status, 'the worker records Clean');
select pg_temp.as_user('alice');
select is(pg_temp.visible(pg_temp.form_photo('crack.jpg')), 1, 'once Clean, the form publisher reads the file');
select pg_temp.as_user('xavier');
select is(pg_temp.visible(pg_temp.form_photo('crack.jpg')), 0, 'cross-tenant: Clean does not open the file to another org');

select pg_temp.as_platform();
select throws_ok(format('select app.record_object_scan(%L, false)', (select object_scan_id from claimed)), 'XR001', null,
  'a finished scan takes no second verdict');

-- Replacing the file queues it again and closes it until the new content scans.
update storage.objects set version = 'v2', metadata = jsonb_build_object('mimetype', 'image/jpeg', 'size', 4096)
where bucket_id = 'field-media' and name = pg_temp.form_photo('crack.jpg');
select is((select scan_status from private.object_scans where object_name = pg_temp.form_photo('crack.jpg')),
  'Scanning'::app.scan_status, 'replaced content is scanned again');
select pg_temp.as_user('alice');
select is(pg_temp.visible(pg_temp.form_photo('crack.jpg')), 0, 'replaced content is closed until it scans Clean');

-- An infected upload stays closed.
select pg_temp.as_user('dave');
insert into storage.objects (bucket_id, name, owner_id, metadata)
values ('field-media', pg_temp.form_photo('eicar.jpg'), pg_temp.id('dave_user')::text,
        jsonb_build_object('mimetype', 'image/jpeg', 'size', 68));
select pg_temp.as_platform();
select is(app.record_object_scan((select id from private.object_scans where object_name = pg_temp.form_photo('eicar.jpg')), false, 'Eicar-Signature'),
  'Infected'::app.scan_status, 'the worker records Infected');
select pg_temp.as_user('alice');
select is(pg_temp.visible(pg_temp.form_photo('eicar.jpg')), 0, 'an infected file is never served to others');

-- Retry with backoff, then Scan Failed after five attempts.
select pg_temp.as_platform();
update private.object_scans set attempts = 1, locked_by = 'scanner-1', locked_at = now()
where object_name = pg_temp.form_photo('crack.jpg');
select is(app.release_object_scan((select id from private.object_scans where object_name = pg_temp.form_photo('crack.jpg')), 'clamd unreachable'),
  'Scanning'::app.scan_status, 'a scanner failure is retried');
select ok((select run_after > now() from private.object_scans where object_name = pg_temp.form_photo('crack.jpg')),
  'the retry waits before the next claim');
update private.object_scans set attempts = 5 where object_name = pg_temp.form_photo('crack.jpg');
select is(app.release_object_scan((select id from private.object_scans where object_name = pg_temp.form_photo('crack.jpg')), 'clamd unreachable'),
  'Scan Failed'::app.scan_status, 'after five attempts the scan fails and the file stays closed');

-- Public buckets are scanned too.
select pg_temp.as_user('nina');
insert into storage.objects (bucket_id, name, owner_id, metadata)
values ('profile-media', pg_temp.id('nina') || '/avatar.png', pg_temp.id('nina_user')::text,
        jsonb_build_object('mimetype', 'image/png', 'size', 120));
select pg_temp.as_platform();
select is((select scan_status from private.object_scans where bucket_id = 'profile-media' and object_name = pg_temp.id('nina') || '/avatar.png'),
  'Scanning'::app.scan_status, 'a profile-media upload is queued for scanning');

-- Other buckets are not tracked here; attachments keep their own per-version state.
insert into storage.objects (bucket_id, name, metadata)
values ('attachments', pg_temp.id('org_a') || '/x/y/z.pdf', jsonb_build_object('mimetype', 'application/pdf', 'size', 10));
select is((select count(*)::integer from private.object_scans where bucket_id = 'attachments'), 0,
  'attachments are scanned through attachment_versions, not object_scans');

-- Deleting the object (as the Storage API does) drops its scan state.
set local storage.allow_delete_query = 'true';
delete from storage.objects where bucket_id = 'profile-media' and name = pg_temp.id('nina') || '/avatar.png';
select is((select count(*)::integer from private.object_scans where object_name = pg_temp.id('nina') || '/avatar.png'), 0,
  'a deleted object leaves no scan row');

select * from finish();
rollback;
