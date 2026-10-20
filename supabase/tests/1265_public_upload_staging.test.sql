-- 1265 (A63, RRR-108, ADR 0034 amendment): a file for the public buckets profile-media and org-brand is
-- uploaded to the private upload-staging bucket first, under the target bucket's rules, and reaches the
-- public bucket only once it scans Clean. Nobody signed in writes a public bucket directly; an infected
-- staged file is never published and its verdict stays for the uploader.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(27);

-- Writes one object as the current role and answers 'stored' or the SQLSTATE that refused it.
create function pg_temp.put(p_bucket text, p_name text, p_owner text, p_type text, p_size bigint default 120)
returns text language plpgsql as $$
begin
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values (p_bucket, p_name, pg_temp.id(p_owner || '_user')::text, jsonb_build_object('mimetype', p_type, 'size', p_size));
  return 'stored';
exception when others then
  return sqlstate;
end $$;

create function pg_temp.avatar(p_file text) returns text
language sql stable as $$ select 'profile-media/' || pg_temp.id('nina') || '/' || p_file $$;
create function pg_temp.logo(p_file text) returns text
language sql stable as $$ select 'org-brand/' || pg_temp.id('org_a') || '/' || p_file $$;

-- The bucket -------------------------------------------------------------------------------------------------
select is((select public from storage.buckets where id = 'upload-staging'), false, 'upload-staging is private');
select ok(private.scanned_upload_bucket('upload-staging'), 'staged files are virus-scanned');
select is(private.staged_upload_bucket('org-brand/' || pg_temp.id('org_a') || '/logo.png'), 'org-brand', 'the first segment names the public bucket');
select is(private.staged_upload_object('org-brand/' || pg_temp.id('org_a') || '/logo.png'), pg_temp.id('org_a') || '/logo.png', 'the rest is the object name there');
select is(private.staged_upload_bucket('imports/' || pg_temp.id('org_a') || '/a.csv'), null, 'only the public buckets are staging targets');

-- Nobody signed in writes a public bucket directly -------------------------------------------------------
select pg_temp.as_user('nina');
select isnt(pg_temp.put('profile-media', pg_temp.id('nina') || '/avatar.png', 'nina', 'image/png'), 'stored',
  'a person cannot write their own profile-media folder directly');
select pg_temp.as_user('alice');
select isnt(pg_temp.put('org-brand', pg_temp.id('org_a') || '/logo.png', 'alice', 'image/png'), 'stored',
  'an Owner with white label cannot write org-brand directly');

-- Staging follows the target bucket's rules ------------------------------------------------------------------
select is(pg_temp.put('upload-staging', pg_temp.logo('logoLight-1.png'), 'alice', 'image/png'), 'stored',
  'an Owner stages a logo for the org');
select isnt(pg_temp.put('upload-staging', pg_temp.logo('brochure.pdf'), 'alice', 'application/pdf'), 'stored',
  'org-brand''s type allowlist applies: no PDF logo');
select isnt(pg_temp.put('upload-staging', pg_temp.logo('huge.png'), 'alice', 'image/png', 3145728), 'stored',
  'org-brand''s 2 MB limit applies');
select isnt(pg_temp.put('upload-staging', 'imports/' || pg_temp.id('org_a') || '/a.csv', 'alice', 'text/csv'), 'stored',
  'a file meant for a private bucket is not staged here');
select pg_temp.as_user('dave');
select isnt(pg_temp.put('upload-staging', pg_temp.logo('logoLight-2.png'), 'dave', 'image/png'), 'stored',
  'a Member without org.white_label.write cannot stage a logo');
select pg_temp.as_user('nina');
select is(pg_temp.put('upload-staging', pg_temp.avatar('avatar.png'), 'nina', 'image/png'), 'stored',
  'a person stages an avatar for their own folder');
select is(pg_temp.put('upload-staging', pg_temp.avatar('cv.pdf'), 'nina', 'application/pdf'), 'stored',
  'profile-media''s allowlist applies: a PDF is staged there');
select isnt(pg_temp.put('upload-staging', 'profile-media/' || pg_temp.id('alice') || '/avatar.png', 'nina', 'image/png'), 'stored',
  'nobody stages a file for someone else''s folder');
select isnt(pg_temp.put('upload-staging', pg_temp.avatar('avatar.svg'), 'nina', 'image/svg+xml'), 'stored',
  'active content is refused in staging too (A22-004)');

-- Only the uploader sees a staged file -----------------------------------------------------------------------
select is((select count(*)::integer from storage.objects where bucket_id = 'upload-staging' and name = pg_temp.avatar('avatar.png')), 1,
  'the uploader reads their staged file');
select pg_temp.as_user('alice');
select is((select count(*)::integer from storage.objects where bucket_id = 'upload-staging' and name = pg_temp.avatar('avatar.png')), 0,
  'nobody else reads it');

-- A Clean file is published ------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is((select scan_status from private.object_scans where bucket_id = 'upload-staging' and object_name = pg_temp.avatar('avatar.png')),
  'Scanning'::app.scan_status, 'a staged upload is queued for scanning');
select is((select count(*)::integer from app.claim_bucket_scans('upload-staging', 'upload-scan:test', 100)), 3,
  'the worker claims the three staged files');
-- The worker found the avatar Clean: it writes the public copy (as the service role), records the verdict and
-- removes the staged original.
insert into storage.objects (bucket_id, name, metadata)
values ('profile-media', pg_temp.id('nina') || '/avatar.png', jsonb_build_object('mimetype', 'image/png', 'size', 120));
select is((select scan_status::text || ' ' || owner_id from private.object_scans where bucket_id = 'profile-media' and object_name = pg_temp.id('nina') || '/avatar.png'),
  'Clean ' || pg_temp.id('nina_user')::text, 'the published copy is recorded Clean, for the staged uploader');
select is(app.record_object_scan((select id from private.object_scans where bucket_id = 'upload-staging' and object_name = pg_temp.avatar('avatar.png')), true),
  'Clean'::app.scan_status, 'the staged original is recorded Clean');
set local storage.allow_delete_query = 'true';
delete from storage.objects where bucket_id = 'upload-staging' and name = pg_temp.avatar('avatar.png');
select is((select count(*)::integer from private.object_scans where bucket_id = 'upload-staging' and object_name = pg_temp.avatar('avatar.png')), 0,
  'removing the staged original leaves no staging row');

-- An infected file is never published ----------------------------------------------------------------------------
select is(app.record_object_scan((select id from private.object_scans where bucket_id = 'upload-staging' and object_name = pg_temp.avatar('cv.pdf')), false, 'Eicar-Test-Signature'),
  'Infected'::app.scan_status, 'an infected staged file is recorded Infected');
delete from storage.objects where bucket_id = 'upload-staging' and name = pg_temp.avatar('cv.pdf');
select pg_temp.as_user('nina');
select is(app.my_upload_scan_status('upload-staging', pg_temp.avatar('cv.pdf')), 'Infected'::app.scan_status,
  'the uploader learns why their file was not published');
select pg_temp.as_user('alice');
select is(app.my_upload_scan_status('upload-staging', pg_temp.avatar('cv.pdf')), null,
  'nobody else does');
select pg_temp.as_platform();
select is((select count(*)::integer from storage.objects where bucket_id = 'profile-media' and name = pg_temp.id('nina') || '/cv.pdf'), 0,
  'the infected file never reached the public bucket');

select * from finish();
rollback;
