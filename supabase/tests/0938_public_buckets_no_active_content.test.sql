-- Security finding A22-004 (regression): public buckets admit no SVG, HTML or XML, by bucket
-- allowlist and by write policy; passive images still upload.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(5);

select is(
  (select coalesce(string_agg(b.id, ', ' order by b.id), '') from storage.buckets b
   where b.public and b.allowed_mime_types && array['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml']),
  '',
  'no public bucket admits SVG, HTML or XML');

select is(
  (select coalesce(string_agg(b.id, ', ' order by b.id), '') from storage.buckets b
   where b.public and b.allowed_mime_types is null),
  '',
  'control: every public bucket declares an allowlist of types');

-- Nina, who belongs to no organization, writes a script-bearing SVG into her own public folder.
select pg_temp.as_user('nina');
create function pg_temp.upload_svg() returns text
language plpgsql as $$
begin
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values ('profile-media', pg_temp.id('nina') || '/avatar.svg', pg_temp.id('nina_user')::text,
          jsonb_build_object('mimetype', 'image/svg+xml', 'size', 120));
  return 'stored';
exception when others then
  return sqlstate;
end $$;
select isnt(pg_temp.upload_svg(), 'stored',
  'an SVG cannot be stored in the public profile-media bucket');

-- Since 1265 a file for a public bucket is uploaded to upload-staging first, under the same rules.
create function pg_temp.upload(p_name text, p_type text) returns text
language plpgsql as $$
begin
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values ('upload-staging', 'profile-media/' || pg_temp.id('nina') || '/' || p_name, pg_temp.id('nina_user')::text,
          jsonb_build_object('mimetype', p_type, 'size', 120));
  return 'stored';
exception when others then
  return sqlstate;
end $$;
select isnt(pg_temp.upload('page.html', 'image/png'), 'stored',
  'an HTML file name is refused even when its declared type is an image');
select is(pg_temp.upload('avatar.png', 'image/png'), 'stored',
  'a PNG avatar is staged for the person''s own folder');

select * from finish();
rollback;
