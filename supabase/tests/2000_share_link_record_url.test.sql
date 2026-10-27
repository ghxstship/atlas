-- pgTAP: migration 2000, finding A69-013 (RRR-114). api_public.open_share_link answers the opened file version, so a
-- watermarked copy links to /files/{version} for members of the org instead of printing the bearer link; a refusal
-- answers no version, and the recreated function keeps 1380's grants, comment and read-only refusal.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(8);

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update on k to public;

-- A clean PNG on prj_a, uploaded by dave.
select pg_temp.as_user('dave');
insert into k select 'upload', u.attachment_version_id, u.object_name
from app.begin_attachment_upload('app.projects', pg_temp.id('prj_a'), 'stage.png', 'image/png', 1200) u;
insert into storage.objects (bucket_id, name, metadata) select 'attachments', val, '{"size": 1200}' from k where key = 'upload';
select app.complete_attachment_upload((select id from k where key = 'upload'), repeat('ab', 32));
select pg_temp.as_platform();
select app.record_attachment_scan((select id from k where key = 'upload'), true);
insert into k select 'file', v.attachment_id, null from app.attachment_versions v where v.id = (select id from k where key = 'upload');

select pg_temp.as_user('dave');
insert into k select 'link', l.share_link_id, l.token
from app.create_share_link((select id from k where key = 'file'), now() + interval '7 days', false, null, 'For the venue') l;

-- Opens the link as an anonymous caller and keeps the answered row.
create function pg_temp.open(p_token text) returns record
language plpgsql as $$
declare
  v_row record;
begin
  perform pg_temp.as_anon();
  perform set_config('request.headers', json_build_object('x-forwarded-for', '198.51.100.9')::text, true);
  select * into v_row from api_public.open_share_link(p_token, null) limit 1;
  perform pg_temp.as_platform();
  return v_row;
end $$;

select pg_temp.as_platform();
select is(
  (select r.attachment_version_id from pg_temp.open((select val from k where key = 'link')) as r(
    refusal text, reason text, ticket text, org_name text, filename text, content_type text, size_bytes bigint,
    classification app.data_classification, watermark boolean, recipient_email text, expires_at timestamptz,
    attachment_version_id uuid)),
  (select id from k where key = 'upload'),
  'an open answers the opened file version, which the copy links to instead of the share link');
select is(
  (select r.reason || ':' || coalesce(r.attachment_version_id::text, 'none') from pg_temp.open('xshr_' || repeat('0', 64)) as r(
    refusal text, reason text, ticket text, org_name text, filename text, content_type text, size_bytes bigint,
    classification app.data_classification, watermark boolean, recipient_email text, expires_at timestamptz,
    attachment_version_id uuid)),
  'share_link_invalid:none', 'a refusal answers no version');

-- The recreated function keeps its signature, result columns, grants and comment.
select is(
  (select pg_get_function_result(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'api_public' and p.proname = 'open_share_link'),
  'TABLE(refusal text, reason text, ticket text, org_name text, filename text, content_type text, size_bytes bigint, classification app.data_classification, watermark boolean, recipient_email text, expires_at timestamp with time zone, attachment_version_id uuid)',
  'the result keeps 1380''s columns in order and adds the version last');
select ok(has_function_privilege('anon', 'api_public.open_share_link(text, text)', 'execute'), 'anonymous visitors may open a link');
select ok(has_function_privilege('authenticated', 'api_public.open_share_link(text, text)', 'execute'), 'signed-in visitors may open a link');
select ok(not has_function_privilege('public', 'api_public.open_share_link(text, text)', 'execute'), 'nobody else is granted it');
select matches(obj_description('api_public.open_share_link(text, text)'::regprocedure, 'pg_proc'), 'A69-013',
  'the comment says why the version is answered');

-- A read-only (GET) call is still refused before anything is looked up (A69-001).
select pg_temp.as_anon();
create function pg_temp.read_only_open() returns text
language plpgsql as $$
begin
  begin
    perform set_config('transaction_read_only', 'on', true);
    perform * from api_public.open_share_link((select val from k where key = 'link'), null);
    raise exception using errcode = 'ZZ001', message = 'no error';
  exception
    when sqlstate 'ZZ001' then return 'none';
    when others then return sqlstate;
  end;
end $$;
select is(pg_temp.read_only_open(), '25006', 'a GET call of open_share_link is still refused');
select pg_temp.as_platform();

select * from finish();
rollback;
