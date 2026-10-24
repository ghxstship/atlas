-- pgTAP: migration 1380, finding A65-016 (RRR-127). Share links follow Section 8.6 per classification (Public without
-- an expiry, Internal with one, Confidential with an expiry, an access code and the recipient, Restricted never); the
-- open RPC is hardened like the A69 advance links (read-only refused, row lock, 5-code lockout, per-address limit);
-- tickets work once; classified files need the export capability to download; the column registry holds Public
-- columns and an export of a Public and an unlisted column is Internal.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(45);

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update on k to public;

-- A clean file on prj_a, uploaded by dave: one PDF and one PNG.
create function pg_temp.clean_file(p_user text, p_name text, p_type text) returns uuid
language plpgsql as $$
declare
  v_version uuid;
  v_object text;
begin
  perform pg_temp.as_user(p_user);
  select u.attachment_version_id, u.object_name into v_version, v_object
  from app.begin_attachment_upload('app.projects', pg_temp.id('prj_a'), p_name, p_type, 1200) u;
  insert into storage.objects (bucket_id, name, metadata) values ('attachments', v_object, '{"size": 1200}');
  perform app.complete_attachment_upload(v_version, repeat('ab', 32));
  perform pg_temp.as_platform();
  perform app.record_attachment_scan(v_version, true);
  insert into k values (p_name || ':version', v_version, v_object);
  insert into k select p_name, v.attachment_id, v_object from app.attachment_versions v where v.id = v_version;
  return v_version;
end $$;

-- Opens a link as an anonymous caller from one address and answers the reason, or 'ok:<watermark>' with the ticket kept.
create function pg_temp.open(p_token text, p_code text, p_ip text default '198.51.100.7') returns text
language plpgsql as $$
declare
  v_row record;
begin
  perform pg_temp.as_anon();
  perform set_config('request.headers', json_build_object('x-forwarded-for', p_ip)::text, true);
  select * into v_row from api_public.open_share_link(p_token, p_code) limit 1;
  perform pg_temp.as_platform();
  if v_row.reason is not null then
    return v_row.reason;
  end if;
  insert into k values ('ticket', null, v_row.ticket) on conflict (key) do update set val = excluded.val;
  return 'ok:' || v_row.watermark::text || ':' || coalesce(v_row.recipient_email, '-');
end $$;

select pg_temp.clean_file('dave', 'rider.pdf', 'application/pdf');
select pg_temp.clean_file('dave', 'stage.png', 'image/png');

-- The registry holds Public columns, and an export counts unlisted columns as Internal ----------------------------
select cmp_ok((select count(*)::int from app.column_classifications where classification = 'Public'), '>=', 20,
  'the column registry classifies the Public columns (Section 8.3)');
select is((select classification::text from app.column_classifications where table_name = 'app.org_brands' and column_name = 'display_name'),
  'Public', 'the org brand name is Public: it is shown to anyone on the sign-in pages');
select pg_temp.as_user('alice');
insert into k values ('export_public', app.request_export(pg_temp.id('org_a'), 'CSV', 'Listings',
  array['app.opportunities.title', 'app.opportunities.pay_min_minor']), null);
insert into k values ('export_mixed', app.request_export(pg_temp.id('org_a'), 'CSV', 'Listings',
  array['app.opportunities.title', 'app.opportunities.venue_id']), null);
select is((select classification::text from app.export_jobs where id = (select id from k where key = 'export_public')), 'Public',
  'an export of only Public columns is Public');
select is((select classification::text from app.export_jobs where id = (select id from k where key = 'export_mixed')), 'Internal',
  'an unlisted column counts as Internal, so a Public column beside it does not make the export Public');

-- Classification of files -------------------------------------------------------------------------------------------
select is((select classification::text from app.attachments where id = (select id from k where key = 'rider.pdf')), 'Internal',
  'a file is Internal until someone classifies it');
select pg_temp.as_user('erin');
select lives_ok($$update app.attachments set classification = 'Confidential' where id = (select id from k where key = 'stage.png')$$,
  'anyone who can read a file may raise its classification');
select throws_ok($$update app.attachments set classification = 'Internal' where id = (select id from k where key = 'stage.png')$$,
  'XR001', null, 'lowering a file someone else added needs data.classification.write');
with u as (update app.attachments set title = 'renamed.png' where id = (select id from k where key = 'stage.png') returning 1)
select is((select count(*)::int from u), 0, 'a reader who did not add the file changes only its classification');
select pg_temp.as_user('dave');
select is((select count(*)::int from storage.objects where bucket_id = 'attachments' and name = (select val from k where key = 'stage.png')),
  0, 'a Confidential file cannot be downloaded without data.export.confidential (Section 8.6)');
select throws_ok($$select * from app.record_file_download((select id from k where key = 'stage.png:version'))$$, 'XR001', null,
  'the download log refuses the same caller');
select pg_temp.as_user('bob');
select is((select count(*)::int from storage.objects where bucket_id = 'attachments' and name = (select val from k where key = 'stage.png')),
  1, 'an admin holding data.export.confidential can download it');
select results_eq($$select classification::text, watermark from app.record_file_download((select id from k where key = 'stage.png:version'))$$,
  $$values ('Confidential'::text, true)$$, 'a Confidential image download is logged and must carry the watermark');
select pg_temp.as_platform();
select is((select count(*)::int from app.file_access_log where action = 'Download' and watermarked and object_path = (select val from k where key = 'stage.png')),
  1, 'the download is in the file access log, marked watermarked');

-- Internal links ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select * from app.create_share_link((select id from k where key = 'rider.pdf'))$$, 'XR001', null,
  'a link to an Internal file needs an expiry');
select throws_ok($$select * from app.create_share_link((select id from k where key = 'rider.pdf'), now() + interval '120 days')$$, 'XR001', null,
  'a link expires within 90 days');
insert into k select 'internal', l.share_link_id, l.token
from app.create_share_link((select id from k where key = 'rider.pdf'), now() + interval '7 days', false, null, 'For the venue') l;
select matches((select val from k where key = 'internal'), '^xshr_[0-9a-f]{64}$', 'the token is returned once, 32 random bytes');
select results_eq($$select classification::text, access_code_required, attachment_version_id from app.share_links where id = (select id from k where key = 'internal')$$,
  $$values ('Internal'::text, false, (select id from k where key = 'rider.pdf:version'))$$,
  'the database copies the classification and the current clean version');
select throws_ok($$select token_hash from app.share_links where id = (select id from k where key = 'internal')$$, '42501', null,
  'the token hash is never readable by signed-in callers');
select throws_ok($$update app.share_links set expires_at = now() + interval '80 days' where id = (select id from k where key = 'internal')$$,
  '42501', null, 'a link is never edited directly');
select pg_temp.as_platform();
select ok((select token_hash = extensions.digest((select val from k where key = 'internal'), 'sha256') from app.share_links where id = (select id from k where key = 'internal')),
  'only the SHA-256 of the token is stored');
select is((select count(*)::int from app.file_access_log where action = 'Share Link Created' and object_path = (select val from k where key = 'rider.pdf')),
  1, 'making a link is logged');

select is(pg_temp.open((select val from k where key = 'internal'), null), 'ok:false:-', 'an Internal link opens without a code or a watermark');
select results_eq($$select open_count, last_opened_at is not null from app.share_links where id = (select id from k where key = 'internal')$$,
  $$values (1, true)$$, 'an open is counted');
select is((select count(*)::int from app.file_access_log where action = 'Share Link Opened' and person_id is null), 1, 'an open is logged');

-- Tickets: once, briefly, only for the service role
select pg_temp.as_anon();
select throws_ok($$select * from app.consume_file_download_ticket((select val from k where key = 'ticket'))$$, '42501', null,
  'only the file-download Edge Function (service role) consumes tickets');
select pg_temp.as_platform();
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('role', 'service_role', true);
select is((select object_name from app.consume_file_download_ticket((select val from k where key = 'ticket'))),
  (select val from k where key = 'rider.pdf'), 'a ticket hands over the shared object');
select is((select count(*)::int from app.consume_file_download_ticket((select val from k where key = 'ticket'))), 0, 'a ticket works once');
select pg_temp.as_platform();

-- A read-only (GET) call is refused before anything is looked up
select pg_temp.as_anon();
select set_config('transaction_read_only', 'off', true);
create function pg_temp.read_only_open() returns text
language plpgsql as $$
begin
  begin
    perform set_config('transaction_read_only', 'on', true);
    perform * from api_public.open_share_link((select val from k where key = 'internal'), null);
    raise exception using errcode = 'ZZ001', message = 'no error';
  exception
    when sqlstate 'ZZ001' then return 'none';
    when others then return sqlstate;
  end;
end $$;
select is(pg_temp.read_only_open(), '25006', 'a GET call of open_share_link is refused (A69-001)');
select pg_temp.as_platform();

-- Raising the file closes links that no longer meet its rules
select pg_temp.as_user('dave');
update app.attachments set classification = 'Confidential' where id = (select id from k where key = 'rider.pdf');
select is(pg_temp.open((select val from k where key = 'internal'), null), 'share_link_reclassified',
  'a link without a code stops opening once its file is Confidential');

-- Confidential links ------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select * from app.create_share_link((select id from k where key = 'stage.png'), now() + interval '7 days', true, 'ana@venue.test')$$,
  'XR001', null, 'sharing a Confidential file needs data.export.confidential');
select pg_temp.as_user('bob');
select throws_ok($$select * from app.create_share_link((select id from k where key = 'stage.png'), now() + interval '7 days')$$, 'XR001', null,
  'a Confidential link names its recipient');
select throws_ok($$select * from app.create_share_link((select id from k where key = 'stage.png'), now() + interval '45 days', false, 'ana@venue.test')$$,
  'XR001', null, 'a Confidential link expires within 30 days');
select lives_ok($$select * from app.create_share_link((select id from k where key = 'rider.pdf'), now() + interval '7 days', true, 'ana@venue.test')$$,
  'a Confidential PDF carries the watermark on every page since 1690, so it may be shared by link');
insert into k select 'conf', l.share_link_id, l.token || ' ' || l.access_code
from app.create_share_link((select id from k where key = 'stage.png'), now() + interval '7 days', false, 'Ana@Venue.test') l;
select matches((select split_part(val, ' ', 2) from k where key = 'conf'), '^[0-9]{6}$',
  'a Confidential link always gets a 6-digit access code, asked for or not');

select is(pg_temp.open((select split_part(val, ' ', 1) from k where key = 'conf'), null), 'share_link_access_code_required',
  'a Confidential link asks for its code');
select is(pg_temp.open((select split_part(val, ' ', 1) from k where key = 'conf'), (select split_part(val, ' ', 2) from k where key = 'conf')),
  'ok:true:ana@venue.test', 'the right code opens it, with the watermark naming the recipient');

-- Five wrong codes lock a link, for the right code too
select pg_temp.as_user('bob');
insert into k select 'locked', l.share_link_id, l.token || ' ' || l.access_code
from app.create_share_link((select id from k where key = 'stage.png'), now() + interval '7 days', true, 'ana@venue.test') l;
select is(pg_temp.open(split_part((select val from k where key = 'locked'), ' ', 1), '000000', '198.51.100.20'), 'share_link_access_code',
  'a wrong code is refused and counted');
select pg_temp.open(split_part((select val from k where key = 'locked'), ' ', 1), '000000', '198.51.100.21');
select pg_temp.open(split_part((select val from k where key = 'locked'), ' ', 1), '000000', '198.51.100.22');
select pg_temp.open(split_part((select val from k where key = 'locked'), ' ', 1), '000000', '198.51.100.23');
select is(pg_temp.open(split_part((select val from k where key = 'locked'), ' ', 1), '000000', '198.51.100.24'), 'share_link_locked',
  'the fifth wrong code locks the link, whatever address it comes from');
select is(pg_temp.open(split_part((select val from k where key = 'locked'), ' ', 1), split_part((select val from k where key = 'locked'), ' ', 2), '198.51.100.25'),
  'share_link_locked', 'a locked link refuses the right code too');

-- Revocation
select pg_temp.as_user('dave');
select throws_ok($$select app.revoke_share_link((select id from k where key = 'conf'))$$, '42501', null,
  'someone who neither made the link nor holds data.export.confidential cannot revoke it');
select pg_temp.as_user('bob');
select ok(app.revoke_share_link((select id from k where key = 'conf')) is not null, 'the person who made a link revokes it');
select is(pg_temp.open((select split_part(val, ' ', 1) from k where key = 'conf'), (select split_part(val, ' ', 2) from k where key = 'conf')),
  'share_link_invalid', 'a revoked link never opens again');

-- Restricted files are never shared
select pg_temp.as_user('alice');
update app.attachments set classification = 'Restricted' where id = (select id from k where key = 'stage.png');
select throws_ok($$select * from app.create_share_link((select id from k where key = 'stage.png'), now() + interval '7 days', true, 'ana@venue.test')$$,
  'XR001', null, 'a Restricted file never gets a share link (Section 8.6)');

-- Failed lookups count against the caller's address
create function pg_temp.guess(p_count integer) returns text
language plpgsql as $$
declare
  v_last text;
begin
  for i in 1..p_count loop
    v_last := pg_temp.open('xshr_' || md5(i::text), null, '203.0.113.99');
  end loop;
  return v_last;
end $$;
select is(pg_temp.guess(20), 'share_link_invalid', 'twenty unknown tokens are refused one by one');
select is(pg_temp.open((select val from k where key = 'internal'), null, '203.0.113.99'), 'share_link_rate_limited',
  'after twenty failures in ten minutes the address is refused before any lookup');

select * from finish();
rollback;
