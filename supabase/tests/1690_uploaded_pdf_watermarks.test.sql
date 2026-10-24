-- pgTAP: migration 1690, A103 (RRR-148), finding A65-016 part 2. Uploaded PDFs carry the Section 8.6 watermark: a
-- Confidential PDF may be shared by link and opens with the watermark naming the recipient, an in-app download of a
-- Confidential or Restricted PDF must carry it, an image the watermark cannot carry is refused (never sent unmarked)
-- for links and downloads alike, and Restricted files still never get a link.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(20);

create temporary table k (key text primary key, id uuid, val text);
grant select, insert, update on k to public;

-- A clean file on prj_a, uploaded by dave.
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

-- Opens a link as an anonymous caller and answers the reason, or 'ok:<watermark>:<recipient>'.
create function pg_temp.open(p_token text, p_code text) returns text
language plpgsql as $$
declare
  v_row record;
begin
  perform pg_temp.as_anon();
  perform set_config('request.headers', json_build_object('x-forwarded-for', '198.51.100.40')::text, true);
  select * into v_row from api_public.open_share_link(p_token, p_code) limit 1;
  perform pg_temp.as_platform();
  if v_row.reason is not null then
    return v_row.reason;
  end if;
  return 'ok:' || v_row.watermark::text || ':' || coalesce(v_row.recipient_email, '-');
end $$;

-- Answers the rule of the refusal a statement raises, or 'none'.
create function pg_temp.rule_of(p_sql text) returns text
language plpgsql as $$
declare
  v_hint text;
begin
  execute p_sql;
  return 'none';
exception when sqlstate 'XR001' then
  get stacked diagnostics v_hint = pg_exception_hint;
  return v_hint;
end $$;

select pg_temp.clean_file('dave', 'rider.pdf', 'application/pdf');
select pg_temp.clean_file('dave', 'stage.webp', 'image/webp');
select pg_temp.clean_file('dave', 'payroll.pdf', 'application/pdf');
insert into k select 'bob_email', null, u.email::text from auth.users u where u.id = pg_temp.id('bob_user');

-- Types the watermark can carry ------------------------------------------------------------------------------------
select ok(private.watermarkable_content_type('application/pdf'), 'a PDF can carry the watermark (1690)');
select ok(private.watermarkable_content_type('IMAGE/PNG') and private.watermarkable_content_type('image/jpeg'),
  'PNG and JPEG images still can');
select ok(not private.watermarkable_content_type('image/webp') and not private.watermarkable_content_type('image/heic')
  and not private.watermarkable_content_type('image/gif'), 'WebP, HEIC and GIF images cannot');

-- A Confidential PDF is shared by link, and opens with the watermark --------------------------------------------------
select pg_temp.as_user('dave');
update app.attachments set classification = 'Confidential' where id in (select id from k where key in ('rider.pdf', 'stage.webp'));
select pg_temp.as_user('bob');
select is(pg_temp.rule_of($$select * from app.create_share_link((select id from k where key = 'rider.pdf'), now() + interval '7 days')$$),
  'share_link_recipient', 'a Confidential PDF link still names its recipient');
select is(pg_temp.rule_of($$select * from app.create_share_link((select id from k where key = 'rider.pdf'), now() + interval '45 days', true, 'ana@venue.test')$$),
  'share_link_expiry_range', 'and still expires within 30 days');
insert into k select 'pdf_link', l.share_link_id, l.token || ' ' || l.access_code
from app.create_share_link((select id from k where key = 'rider.pdf'), now() + interval '7 days', false, 'Ana@Venue.test') l;
select results_eq($$select classification::text, access_code_required, recipient_email from app.share_links where id = (select id from k where key = 'pdf_link')$$,
  $$values ('Confidential'::text, true, 'ana@venue.test'::text)$$,
  'a Confidential PDF gets a link with an access code for its recipient');
select matches((select split_part(val, ' ', 2) from k where key = 'pdf_link'), '^[0-9]{6}$', 'the code is returned once');
select is(pg_temp.open((select split_part(val, ' ', 1) from k where key = 'pdf_link'), null), 'share_link_access_code_required',
  'the link asks for its code');
select is(pg_temp.open((select split_part(val, ' ', 1) from k where key = 'pdf_link'), (select split_part(val, ' ', 2) from k where key = 'pdf_link')),
  'ok:true:ana@venue.test', 'the right code opens it, and the copy must carry the watermark naming the recipient');
select is((select count(*)::int from app.file_access_log where action = 'Share Link Opened' and watermarked
           and object_path = (select val from k where key = 'rider.pdf')), 1, 'the open is logged as watermarked');

-- An image the watermark cannot carry is never shared or downloaded --------------------------------------------------
select pg_temp.as_user('bob');
select is(pg_temp.rule_of($$select * from app.create_share_link((select id from k where key = 'stage.webp'), now() + interval '7 days', true, 'ana@venue.test')$$),
  'share_link_watermark_unsupported', 'a Confidential WebP image cannot carry the watermark, so it is not shared by link');
select is(pg_temp.rule_of($$select * from app.record_file_download((select id from k where key = 'stage.webp:version'))$$),
  'download_watermark_unsupported', 'nor downloaded in the app, where it would leave unmarked');
select pg_temp.as_platform();
select is((select count(*)::int from app.file_access_log where action = 'Download' and object_path = (select val from k where key = 'stage.webp')),
  0, 'a refused download is not logged as one');
select pg_temp.as_user('dave');
select results_eq($$select classification::text, watermark from app.record_file_download((select id from k where key = 'payroll.pdf:version'))$$,
  $$values ('Internal'::text, false)$$, 'an Internal PDF downloads as stored');

-- In-app downloads of Confidential and Restricted PDFs must carry the watermark ------------------------------------
select pg_temp.as_user('dave');
select is(pg_temp.rule_of($$select * from app.record_file_download((select id from k where key = 'rider.pdf:version'))$$),
  'download_confidential', 'the export capability is still checked first');
select pg_temp.as_user('bob');
select results_eq($$select classification::text, watermark, viewer_email from app.record_file_download((select id from k where key = 'rider.pdf:version'))$$,
  $$select 'Confidential'::text, true, (select val from k where key = 'bob_email')$$,
  'a Confidential PDF download must carry the watermark with the viewer''s email');
select pg_temp.as_platform();
select is((select count(*)::int from app.file_access_log where action = 'Download' and watermarked
           and object_path = (select val from k where key = 'rider.pdf')), 1, 'the download is logged as watermarked');

select pg_temp.as_user('alice');
update app.attachments set classification = 'Restricted' where id = (select id from k where key = 'payroll.pdf');
select is(pg_temp.rule_of($$select * from app.create_share_link((select id from k where key = 'payroll.pdf'), now() + interval '7 days', true, 'ana@venue.test')$$),
  'share_link_restricted', 'a Restricted PDF never gets a share link');
select is(pg_temp.rule_of($$select * from app.record_file_download((select id from k where key = 'payroll.pdf:version'))$$),
  'step_up_required', 'downloading a Restricted PDF needs step-up');
select pg_temp.as_user_stepped_up('alice');
select results_eq($$select classification::text, watermark from app.record_file_download((select id from k where key = 'payroll.pdf:version'))$$,
  $$values ('Restricted'::text, true)$$, 'after step-up a Restricted PDF download must carry the watermark');

select * from finish();
rollback;
