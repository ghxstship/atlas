-- A22-004 (Medium): the public buckets org-brand and profile-media accept image/svg+xml, and nothing
-- in the repository sanitizes SVG. Section 9 requires SVG sanitization and says active content is
-- never served inline from public buckets. Any signed-in person can upload an SVG with script to
-- their own profile-media folder and share its public URL, which the storage origin serves inline.
--
-- Regression test from the attacker's side: fixed in migration 0938 (RRR-41). This file failed on
-- main d36918a and must keep passing.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(3);

select is(
  (select coalesce(string_agg(b.id, ', ' order by b.id), '') from storage.buckets b
   where b.public and b.allowed_mime_types && array['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml']),
  '',
  'A22-004: no public bucket admits SVG, HTML or XML');

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
  'A22-004: an SVG cannot be stored in the public profile-media bucket');

select * from finish();
rollback;
