-- pgTAP: migration 1691, A103 (RRR-148), finding A65-016 part 2. No Confidential or Restricted PDF or image reaches
-- anyone unmarked: nobody reads one straight from Storage (except the org export holder with step-up, Section 14.7),
-- an in-app download of one comes with a single-use ticket, and the file-download function's ticket consumption hands
-- one over only to a caller that marks it (the Atlas web shell, proven by the handover secret). Files that carry no
-- watermark keep the 1380 rules.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(29);

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

-- How many rows of the file's object the current caller can read from Storage.
create function pg_temp.readable(p_name text) returns int
language sql as $$
  select count(*)::int from storage.objects where bucket_id = 'attachments' and name = (select val from k where key = p_name);
$$;

-- Consumes a ticket as the file-download function (service role) and answers 'object:watermark', or 'none'.
create function pg_temp.consume(p_ticket text, p_watermarks boolean) returns text
language plpgsql as $$
declare
  v_row record;
begin
  perform pg_temp.as_platform();
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
  select * into v_row from app.consume_file_download_ticket(p_ticket, p_watermarks) limit 1;
  perform pg_temp.as_platform();
  if v_row.object_name is null then
    return 'none';
  end if;
  return v_row.object_name || ':' || v_row.watermark::text;
end $$;

-- Opens a link as an anonymous caller and keeps its ticket under p_key.
create function pg_temp.open_ticket(p_key text, p_link text) returns text
language plpgsql as $$
declare
  v_row record;
begin
  perform pg_temp.as_anon();
  perform set_config('request.headers', json_build_object('x-forwarded-for', '198.51.100.41')::text, true);
  select * into v_row from api_public.open_share_link(
    (select split_part(val, ' ', 1) from k where key = p_link),
    nullif((select split_part(val, ' ', 2) from k where key = p_link), '')) limit 1;
  perform pg_temp.as_platform();
  insert into k values (p_key, null, v_row.ticket);
  return coalesce(v_row.ticket, v_row.reason);
end $$;

select pg_temp.clean_file('dave', 'rider.pdf', 'application/pdf');
select pg_temp.clean_file('dave', 'crew.csv', 'text/csv');
select pg_temp.clean_file('dave', 'stage.png', 'image/png');
select pg_temp.clean_file('dave', 'notes.pdf', 'application/pdf');
select pg_temp.as_user('dave');
update app.attachments set classification = 'Confidential' where id in (select id from k where key in ('rider.pdf', 'crew.csv', 'stage.png'));

-- The handover's shape ------------------------------------------------------------------------------------------------
select has_function('app', 'consume_file_download_ticket', array['text', 'boolean'],
  'tickets are consumed with whether the caller marks the copy');
select hasnt_function('app', 'consume_file_download_ticket', array['text'], 'the one-argument form is gone');
select function_privs_are('app', 'consume_file_download_ticket', array['text', 'boolean'], 'authenticated', array[]::text[],
  'signed-in callers never consume tickets');
select function_privs_are('app', 'consume_file_download_ticket', array['text', 'boolean'], 'anon', array[]::text[],
  'nor do anonymous callers');

-- Storage: an object that must carry the watermark is never read directly --------------------------------------------
select pg_temp.as_user('bob');
select is(pg_temp.readable('rider.pdf'), 0, 'an admin holding data.export.confidential cannot read a Confidential PDF from Storage');
select is(pg_temp.readable('stage.png'), 0, 'nor a Confidential PNG');
select is(pg_temp.readable('crew.csv'), 1, 'a Confidential CSV, which carries no watermark, still downloads under the 1380 capability rule');
select pg_temp.as_user('dave');
select is(pg_temp.readable('crew.csv'), 0, 'and still not without the capability');
select is(pg_temp.readable('notes.pdf'), 1, 'an Internal PDF is read as before');
select pg_temp.as_user('alice');
select is(pg_temp.readable('rider.pdf'), 0, 'the Owner needs step-up to read the original');
select pg_temp.as_user_stepped_up('alice');
select is(pg_temp.readable('rider.pdf'), 1, 'the Owner with step-up reads the original, for the full export (Section 14.7)');

-- In-app downloads: a copy that must carry the watermark comes with a ticket -----------------------------------------
select pg_temp.as_user('bob');
insert into k select 'bob_ticket', null, d.ticket
from app.record_file_download((select id from k where key = 'rider.pdf:version')) d;
select matches((select val from k where key = 'bob_ticket'), '^xdlt_[0-9a-f]{64}$', 'a Confidential PDF download answers a ticket');
select pg_temp.as_platform();
select results_eq($$select t.share_link_id is null, t.person_id = pg_temp.id('bob'), t.expires_at <= now() + interval '2 minutes'
  from private.file_download_tickets t where t.ticket_hash = private.share_token_hash((select val from k where key = 'bob_ticket'))$$,
  $$values (true, true, true)$$, 'the ticket names the member, not a link, and lasts 2 minutes');
select pg_temp.as_user('bob');
select is((select d.ticket from app.record_file_download((select id from k where key = 'crew.csv:version')) d), null,
  'a Confidential CSV download needs no ticket');
select pg_temp.as_user('dave');
select results_eq($$select watermark, ticket from app.record_file_download((select id from k where key = 'notes.pdf:version'))$$,
  $$values (false, null::text)$$, 'nor does an Internal PDF');

select is(pg_temp.consume((select val from k where key = 'bob_ticket'), false), 'none',
  'without the handover the ticket of a copy that must carry the watermark answers nothing');
select ok((select t.used_at is null from private.file_download_tickets t
           where t.ticket_hash = private.share_token_hash((select val from k where key = 'bob_ticket'))),
  'and stays unused');
select is(pg_temp.consume((select val from k where key = 'bob_ticket'), true), (select val from k where key = 'rider.pdf') || ':true',
  'the web shell that marks it receives the object, and is told it must carry the watermark');
select is(pg_temp.consume((select val from k where key = 'bob_ticket'), true), 'none', 'a ticket still works once');

select pg_temp.as_user_stepped_up('alice');
update app.attachments set classification = 'Restricted' where id = (select id from k where key = 'stage.png');
select matches((select d.ticket from app.record_file_download((select id from k where key = 'stage.png:version')) d),
  '^xdlt_[0-9a-f]{64}$', 'a Restricted image download after step-up answers a ticket too');
select pg_temp.as_platform();
select throws_ok($$insert into private.file_download_tickets (ticket_hash, attachment_version_id, expires_at)
  values (extensions.digest('x', 'sha256'), (select id from k where key = 'rider.pdf:version'), now())$$,
  '23514', null, 'a ticket comes from a share link or a member, never neither');

-- Share links: the recipient who calls the open RPC and the function directly gets nothing ---------------------------
select pg_temp.as_user('bob');
insert into k select 'pdf_link', l.share_link_id, l.token || ' ' || l.access_code
from app.create_share_link((select id from k where key = 'rider.pdf'), now() + interval '7 days', true, 'ana@venue.test') l;
select pg_temp.as_user('dave');
insert into k select 'notes_link', l.share_link_id, l.token || ' '
from app.create_share_link((select id from k where key = 'notes.pdf'), now() + interval '7 days') l;
select matches(pg_temp.open_ticket('pdf_ticket', 'pdf_link'), '^xdlt_', 'the right code opens the Confidential PDF link');
select is(pg_temp.consume((select val from k where key = 'pdf_ticket'), false), 'none',
  'a recipient presenting that ticket to the function without the handover gets nothing');
select is(pg_temp.consume((select val from k where key = 'pdf_ticket'), true), (select val from k where key = 'rider.pdf') || ':true',
  'the web shell receives it to mark it');

select matches(pg_temp.open_ticket('notes_ticket', 'notes_link'), '^xdlt_', 'an Internal link opens');
select pg_temp.as_user('dave');
update app.attachments set classification = 'Confidential' where id = (select id from k where key = 'notes.pdf');
select is(pg_temp.consume((select val from k where key = 'notes_ticket'), false), 'none',
  'a file raised to Confidential after the open follows its rule now: no handover, nothing');
select is(pg_temp.consume((select val from k where key = 'notes_ticket'), true), (select val from k where key = 'notes.pdf') || ':true',
  'and the web shell is told the copy must now carry the watermark');

select pg_temp.as_user('bob');
insert into k select 'pdf_link2', l.share_link_id, l.token || ' ' || l.access_code
from app.create_share_link((select id from k where key = 'rider.pdf'), now() + interval '7 days', true, 'ana@venue.test') l;
select matches(pg_temp.open_ticket('pdf_ticket2', 'pdf_link2'), '^xdlt_', 'a second link opens');
select pg_temp.as_user('alice');
update app.attachments set classification = 'Restricted' where id = (select id from k where key = 'rider.pdf');
select is(pg_temp.consume((select val from k where key = 'pdf_ticket2'), true), 'none',
  'a link ticket whose file was raised to Restricted since answers nothing, even to the web shell');

select * from finish();
rollback;
