-- pgTAP: migrations 2730 and 2731 (R10), token advance parity. Every new api_public RPC refuses a read-only transaction;
-- a wrong code is counted, the link locks at 5 and an expired link is refused. preview_advance keeps its old columns in
-- order and appends the new ones. A typed answer through the link creates lines and Requested allocations with no
-- created_by, one open answer per section. Upload tickets: single use, 15 minutes, another token's ticket refused, a
-- mismatched section or path refused, anon writes and reads only the ticket's object, finish refuses a missing object
-- and a bad checksum, the upload is queued for scanning and the File answer takes it; an unattached upload holds the
-- section only while its ticket's 15 minutes run. Guests through the link: the cap and a closed engagement. Roster: an
-- invite makes a Draft entry, the rate limit holds, the invitee accepts, submit works and masking holds. After the claim
-- the claimer cannot approve the allocation their token answer created nor review the entry they invited, with no
-- column written at claim; the status rows agree with the requester rule, and a link invitee's account role is granted
-- by the claimer.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql
\ir 2691_allocation_world.psql

select no_plan();

-- Calls an api_public function with NULL for every argument as anon in a read-only subtransaction; the error it raised.
create function pg_temp.read_only_outcome(p_fn regprocedure) returns text
language plpgsql as $$
declare
  v_args text;
  v_name text := (select proname from pg_proc where oid = p_fn);
  v_outcome text := '';
begin
  select coalesce(string_agg(format('null::%s', t::regtype), ', ' order by o), '') into v_args
  from pg_proc p, unnest(p.proargtypes::oid[]) with ordinality as a (t, o)
  where p.oid = p_fn;
  begin
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('role', 'anon', true);
    perform set_config('transaction_read_only', 'on', true);
    execute format('select * from api_public.%I(%s)', v_name, v_args);
    raise exception using errcode = 'ZZ001', message = 'no error';
  exception
    when sqlstate 'ZZ001' then v_outcome := '';
    when others then v_outcome := sqlstate;
  end;
  return v_outcome;
end $$;

-- Runs a query as anon and answers its one text value; the query reads world keys before the role changes.
create function pg_temp.anon(p_sql text) returns text
language plpgsql as $$
declare v text;
begin
  perform pg_temp.as_anon();
  execute p_sql into v;
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.typed(p_token text, p_section text, p_lines jsonb, p_text text default null, p_docs uuid[] default '{}')
returns text
language plpgsql as $$
declare
  v_section uuid := pg_temp.id(p_section);
  v_reason text;
  v_id uuid;
begin
  perform pg_temp.as_anon();
  select coalesce(t.reason, t.submission_id::text) into v_reason
  from api_public.submit_advance_typed(p_token, '424242', v_section, p_text, null, p_lines, p_docs) t;
  perform pg_temp.as_platform();
  return v_reason;
end $$;

create function pg_temp.begin_upload(p_token text, p_section text, p_name text, p_type text default 'application/pdf',
  p_size integer default 2048) returns text
language plpgsql as $$
declare
  v_section uuid := pg_temp.id(p_section);
  v text;
begin
  perform pg_temp.as_anon();
  select coalesce(b.reason, b.ticket_id::text) into v
  from api_public.begin_advance_upload(p_token, '424242', v_section, p_name, p_type, p_size) b;
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.anon_store(p_name text) returns void
language plpgsql as $$
begin
  perform pg_temp.as_anon();
  insert into storage.objects (bucket_id, name, metadata)
  values ('party-uploads', p_name, jsonb_build_object('mimetype', 'application/pdf', 'size', 2048));
  perform pg_temp.as_platform();
end $$;

create function pg_temp.finish(p_token text, p_ticket uuid, p_checksum text default repeat('a', 64)) returns text
language plpgsql as $$
declare v text;
begin
  perform pg_temp.as_anon();
  select coalesce(f.reason, f.document_id::text) into v
  from api_public.finish_advance_upload(p_token, '424242', p_ticket, 'Rider', p_checksum) f;
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.ticket_name(p_ticket uuid) returns text
language sql security definer as $$ select k.object_name from private.advance_upload_tickets k where k.id = p_ticket $$;

-- Fixture: a packet of every kind for Bayside Audio, and one for art; a link to each ------------------------------------------
select pg_temp.as_user('alice');
insert into app.offering_rules (org_id, project_id, offering, offering_mode, cap_per_engagement)
values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Guest List', 'Provided', 3);
select pg_temp.as_user('dave');
with x as (insert into app.advance_packets (project_id, title) values (pg_temp.id('prj_a'), 'Token Advance') returning id)
insert into world select 'pkt', id from x;
with x as (insert into app.advance_sections (advance_packet_id, position, title, section_kind, max_lines, per_person)
  values (pg_temp.id('pkt'), 1, 'Rider', 'File', 2, false) returning id) insert into world select 's_file', id from x;
with x as (insert into app.advance_sections (advance_packet_id, position, title, section_kind, max_lines, per_person)
  values (pg_temp.id('pkt'), 2, 'Radios', 'Item Request', 3, false) returning id) insert into world select 's_items', id from x;
with x as (insert into app.advance_sections (advance_packet_id, position, title, section_kind)
  values (pg_temp.id('pkt'), 3, 'Guests', 'Guest List') returning id) insert into world select 's_guests', id from x;
with x as (insert into app.advance_sections (advance_packet_id, position, title, section_kind)
  values (pg_temp.id('pkt'), 4, 'Crew', 'Crew Roster') returning id) insert into world select 's_roster', id from x;
with x as (insert into app.advance_sections (advance_packet_id, position, title, prompt)
  values (pg_temp.id('pkt'), 5, 'Notes', 'Anything else?') returning id) insert into world select 's_text', id from x;
insert into app.advance_section_choices (advance_section_id, asset_class_id) values (pg_temp.id('s_items'), pg_temp.id('cls_radio'));
with x as (insert into app.advance_recipients (advance_packet_id, counterparty_id, engagement_id)
  values (pg_temp.id('pkt'), pg_temp.id('cp_v_a'), pg_temp.id('eng_vendor_a')) returning id) insert into world select 'rcp', id from x;
with x as (insert into app.advance_recipients (advance_packet_id, person_id, engagement_id)
  values (pg_temp.id('pkt'), pg_temp.id('art'), pg_temp.id('eng_art_a')) returning id) insert into world select 'rcp_art', id from x;
select app.send_advance_packet(pg_temp.id('pkt'));
select pg_temp.as_platform();
-- carol, who reviews advances, receives the vendor's link at her own address and later claims it.
insert into app.advance_recipient_tokens (advance_recipient_id, recipient_email, token_hash, access_code_hash, expires_at)
values (pg_temp.id('rcp'), 'carol@northwind.test', private.advance_token_hash('xadv_r10vendor'),
  private.advance_code_hash('xadv_r10vendor', '424242'), now() + interval '7 days'),
  (pg_temp.id('rcp_art'), 'art@performer.test', private.advance_token_hash('xadv_r10artist'),
  private.advance_code_hash('xadv_r10artist', '424242'), now() + interval '7 days'),
  (pg_temp.id('rcp'), 'victor@bayside-audio.test', private.advance_token_hash('xadv_r10locks'),
  private.advance_code_hash('xadv_r10locks', '424242'), now() + interval '7 days'),
  (pg_temp.id('rcp_art'), 'art@performer.test', private.advance_token_hash('xadv_r10old'),
  private.advance_code_hash('xadv_r10old', '424242'), now() - interval '1 minute');
insert into world select 'tok', id from app.advance_recipient_tokens where token_hash = private.advance_token_hash('xadv_r10vendor');
insert into world select 'tok_art', id from app.advance_recipient_tokens where token_hash = private.advance_token_hash('xadv_r10artist');

-- Reads need a write transaction ------------------------------------------------------------------------------------------------
select is(pg_temp.read_only_outcome(f::regprocedure), '25006', f || ' refuses a read-only (GET) call')
from unnest(array[
  'api_public.preview_advance(text, text)',
  'api_public.submit_advance_typed(text, text, uuid, text, text, jsonb, uuid[])',
  'api_public.begin_advance_upload(text, text, uuid, text, text, integer)',
  'api_public.finish_advance_upload(text, text, uuid, text, text)',
  'api_public.request_advance_guest(text, text, uuid, text, integer, text)',
  'api_public.advance_roster(text, text, uuid)',
  'api_public.invite_advance_roster_member(text, text, uuid, text, text, timestamptz, timestamptz, text)',
  'api_public.submit_advance_roster(text, text, uuid)']) f;

-- Wrong codes lock the link; an expired link is refused ------------------------------------------------------------------------
select is(pg_temp.anon($$select reason from api_public.submit_advance_typed('xadv_r10locks', '000001',
  (select id from world where key = 's_text'), 'x', null, '[]', '{}')$$), 'advance_access_code', 'a wrong code is refused');
select is((select failed_attempts from app.advance_recipient_tokens where token_hash = private.advance_token_hash('xadv_r10locks')),
  1::smallint, 'and counted');
create function pg_temp.wrong_codes(p_times integer) returns text
language plpgsql as $$
declare
  v_section uuid := pg_temp.id('s_roster');
  v_out text[] := '{}';
  v text;
begin
  perform pg_temp.as_anon();
  for i in 1 .. p_times loop
    select r.reason into v from api_public.advance_roster('xadv_r10locks', lpad((i + 1)::text, 6, '0'), v_section) r;
    v_out := v_out || v;
  end loop;
  perform pg_temp.as_platform();
  return array_to_string(v_out, ',');
end $$;
select is(pg_temp.wrong_codes(4), 'advance_access_code,advance_access_code,advance_access_code,advance_token_locked',
  'the fifth wrong code locks the link');
select is(pg_temp.begin_upload('xadv_r10locks', 's_file', 'rider.pdf'), 'advance_token_locked', 'a locked link refuses the right code');
select is(pg_temp.anon($$select reason from api_public.request_advance_guest('xadv_r10old', '424242',
  (select id from world where key = 's_guests'), 'Sasha Bell', 0, null)$$), 'advance_token_expired', 'an expired link is refused');

-- The preview keeps its columns and appends the new ones ---------------------------------------------------------------------------
select is((select (proargnames[3:17])::text from pg_proc where oid = 'api_public.preview_advance(text, text)'::regprocedure),
  '{refusal,reason,org_name,packet_title,due_at,recipient_email,expires_at,section_id,section_position,section_title,section_prompt,answer_body,answered_at,review_outcome,return_reason}',
  'preview_advance keeps its 0430 columns in order');
select is((select (proargnames[18:])::text from pg_proc where oid = 'api_public.preview_advance(text, text)'::regprocedure),
  '{section_kind,window_kind,max_lines,per_person,choices,answer_id,answer_note,answer_lines,answer_files,can_answer,guest_cap,guests_used,roster_summary,project_time_zone,roster_people}',
  'and appends the typed section columns');
select pg_temp.as_anon();
create temporary table pv on commit drop as select * from api_public.preview_advance('xadv_r10vendor', '424242');
select pg_temp.as_platform();
select is((select count(*)::int from pv), 5, 'one row per section');
select is((select string_agg(section_kind::text, ',' order by section_position) from pv),
  'File,Item Request,Guest List,Crew Roster,Text', 'with each section''s kind');
select is((select choices -> 0 ->> 'asset_class_id' from pv where section_id = pg_temp.id('s_items')), pg_temp.id('cls_radio')::text,
  'an Item Request lists its asset classes');
select ok((select choices -> 0 ->> 'class_name' from pv where section_id = pg_temp.id('s_items')) is not null, 'by name');
select is((select can_answer from pv where section_id = pg_temp.id('s_roster')), false, 'a Crew Roster section takes no answer');
select is((select can_answer from pv where section_id = pg_temp.id('s_items')), true, 'an unanswered section does');
select is((select guest_cap from pv where section_id = pg_temp.id('s_guests')), 3, 'the guest list shows its cap');
select is((select guests_used from pv where section_id = pg_temp.id('s_guests')), 0, 'and the guests used');
select ok((select (roster_summary ->> 'Accepted')::int >= 2 from pv where section_id = pg_temp.id('s_roster')),
  'the crew roster counts entries by state');
select is((select project_time_zone from pv limit 1), (select time_zone from app.projects where id = pg_temp.id('prj_a')),
  'with the project''s time zone');
select ok((select jsonb_array_length(roster_people) >= 2 from pv where section_id = pg_temp.id('s_items')),
  'and the roster people a line may name');

-- A typed answer through the link ------------------------------------------------------------------------------------------------------
select is(pg_temp.typed('xadv_r10vendor', 's_roster', '[]'), 'advance_section_derived', 'the Crew Roster section takes no answer');
select is(pg_temp.anon($$select reason from api_public.submit_advance_typed('xadv_r10vendor', '424242', gen_random_uuid(),
  'x', null, '[]', '{}')$$), 'advance_section_open', 'a section of another packet is refused');
select is(pg_temp.typed('xadv_r10vendor', 's_items', jsonb_build_array(jsonb_build_object('asset_class_id', pg_temp.id('cls_cable'), 'quantity', 2))),
  'advance_line_kind', 'an item that is not a choice is refused');
insert into world select 'a_items', pg_temp.typed('xadv_r10vendor', 's_items',
  jsonb_build_array(jsonb_build_object('asset_class_id', pg_temp.id('cls_radio'), 'quantity', 2)))::uuid;
select is((select advance_recipient_token_id from app.advance_submissions where id = pg_temp.id('a_items')), pg_temp.id('tok'),
  'the answer is recorded through the link');
select is((select count(*)::int from app.advance_submission_lines where advance_submission_id = pg_temp.id('a_items')), 1, 'with its line');
insert into world select 'alloc', a.id from app.advance_allocations a
  join app.advance_submission_lines l on l.id = a.advance_submission_line_id where l.advance_submission_id = pg_temp.id('a_items');
select is(pg_temp.state_of(pg_temp.id('alloc')), 'Requested', 'the line is a Requested allocation');
select is((select created_by from app.advance_allocations where id = pg_temp.id('alloc')), null::uuid, 'with no created_by');
select is(private.allocation_requester(pg_temp.id('alloc')), null::uuid, 'and no requester until the link is claimed');
select is(pg_temp.typed('xadv_r10vendor', 's_items', jsonb_build_array(jsonb_build_object('asset_class_id', pg_temp.id('cls_radio'), 'quantity', 1))),
  'advance_answer_pending', 'one open answer per section');
select ok((select used_at is not null from app.advance_recipient_tokens where id = pg_temp.id('tok')), 'the link is marked used');
select is(pg_temp.anon($$select can_answer::text from api_public.preview_advance('xadv_r10vendor', '424242')
  where section_id = (select id from world where key = 's_items')$$), 'false', 'and the preview shows the section answered');
select ok(pg_temp.anon($$select (answer_lines -> 0 ->> 'quantity') from api_public.preview_advance('xadv_r10vendor', '424242')
  where section_id = (select id from world where key = 's_items')$$) = '2', 'with its lines');

-- Upload tickets ------------------------------------------------------------------------------------------------------------------------------
select is(pg_temp.begin_upload('xadv_r10vendor', 's_text', 'rider.pdf'), 'advance_section_open', 'a Text section takes no upload');
select is(pg_temp.begin_upload('xadv_r10vendor', 's_file', 'rider.exe', 'application/x-msdownload'), 'advance_upload_type',
  'a type party-uploads does not take is refused');
select is(pg_temp.begin_upload('xadv_r10vendor', 's_file', 'rider.pdf', 'application/pdf', 26214401), 'advance_upload_size',
  'a file over 25 MB is refused');
insert into world select 't1', pg_temp.begin_upload('xadv_r10vendor', 's_file', 'Tour Rider (v2).pdf')::uuid;
select is(pg_temp.ticket_name(pg_temp.id('t1')),
  pg_temp.id('org_a') || '/advance-token/' || pg_temp.id('t1') || '/Tour-Rider-v2-.pdf', 'the ticket names one object, the file name cleaned');
select is((select expires_at - created_at from private.advance_upload_tickets where id = pg_temp.id('t1')), interval '15 minutes',
  'and closes after 15 minutes');
insert into world select 't2', pg_temp.begin_upload('xadv_r10vendor', 's_file', 'plot.pdf')::uuid;
select is(pg_temp.begin_upload('xadv_r10vendor', 's_file', 'third.pdf'), 'advance_upload_limit', 'open tickets count toward the section''s files');

select lives_ok(format($$select pg_temp.anon_store(%L)$$, pg_temp.ticket_name(pg_temp.id('t1'))), 'anon stores the ticket''s object');
select is((select scan_status::text from private.object_scans where bucket_id = 'party-uploads'
  and object_name = pg_temp.ticket_name(pg_temp.id('t1'))), 'Scanning', 'the upload is queued for scanning');
select throws_ok(format($$select pg_temp.anon_store(%L)$$, pg_temp.id('org_a') || '/advance-token/' || gen_random_uuid() || '/x.pdf'),
  '42501', null, 'anon cannot store outside a ticket''s path');
select throws_ok(format($$select pg_temp.anon_store(%L)$$, pg_temp.ticket_name(pg_temp.id('t2')) || '.extra'),
  '42501', null, 'nor a name that differs from the ticket''s');
insert into storage.objects (bucket_id, name, metadata)
values ('party-uploads', pg_temp.id('org_a') || '/advance/' || pg_temp.id('rcp') || '/' || pg_temp.id('s_file') || '/signed-in.pdf', '{}');
select is(pg_temp.anon($$select count(*)::text from storage.objects where bucket_id = 'party-uploads'$$), '1',
  'anon reads only the open ticket''s object');
select is((select roles::text from pg_policies where schemaname = 'storage' and tablename = 'objects'
  and policyname = 'party_uploads_token_read'), '{anon}', 'only anon reads through a ticket');

select is(pg_temp.finish('xadv_r10artist', pg_temp.id('t1')), 'advance_upload_ticket', 'another link''s ticket is refused');
select is(pg_temp.finish('xadv_r10vendor', pg_temp.id('t2')), 'party_upload_missing', 'finish refuses a missing object');
select is(pg_temp.finish('xadv_r10vendor', pg_temp.id('t1'), 'NOT-A-SHA'), 'party_upload_checksum', 'and a bad checksum');
insert into world select 'doc1', pg_temp.finish('xadv_r10vendor', pg_temp.id('t1'))::uuid;
select is((select storage_uri from app.document_versions where document_id = pg_temp.id('doc1')),
  'storage://party-uploads/' || pg_temp.ticket_name(pg_temp.id('t1')), 'finish registers a document of the object');
select is(pg_temp.finish('xadv_r10vendor', pg_temp.id('t1')), 'advance_upload_ticket', 'a ticket is used once');
select ok(not api_public.advance_upload_ticket_open(pg_temp.ticket_name(pg_temp.id('t1'))), 'a used ticket no longer opens its object');
select is(pg_temp.anon($$select count(*)::text from storage.objects where bucket_id = 'party-uploads'$$), '0',
  'and anon reads nothing once it is used');
update private.advance_upload_tickets set expires_at = now() - interval '1 second' where id = pg_temp.id('t2');
select throws_ok(format($$select pg_temp.anon_store(%L)$$, pg_temp.ticket_name(pg_temp.id('t2'))),
  '42501', null, 'an expired ticket opens nothing');
insert into world select 't3', pg_temp.begin_upload('xadv_r10vendor', 's_file', 'plot.pdf')::uuid;
select is(pg_temp.begin_upload('xadv_r10vendor', 's_file', 'third.pdf'), 'advance_upload_limit',
  'a finished file in no answer counts while its ticket''s 15 minutes run');
-- Only t1's window closes; t3 stays open. t1 is finished and in no answer, so it held the section for good before.
update private.advance_upload_tickets set expires_at = now() - interval '1 second' where id = pg_temp.id('t1');
select ok(pg_temp.begin_upload('xadv_r10vendor', 's_file', 'retry.pdf') ~ '^[0-9a-f-]{36}$',
  'once its window closes an unattached file no longer holds the section, so a failed answer can be sent again');
select is(pg_temp.begin_upload('xadv_r10vendor', 's_file', 'third.pdf'), 'advance_upload_limit',
  'the open ticket and the new one fill the section again');

select is(pg_temp.typed('xadv_r10artist', 's_file', '[]', null, array[pg_temp.id('doc1')]), 'advance_file_document',
  'another link cannot attach the file');
select ok(pg_temp.typed('xadv_r10vendor', 's_file', '[]', null, array[pg_temp.id('doc1')]) ~ '^[0-9a-f-]{36}$',
  'the File answer takes the uploaded document');
select is(pg_temp.begin_upload('xadv_r10vendor', 's_file', 'late.pdf'), 'advance_answer_pending', 'no upload while the answer is open');
select pg_temp.claims('dave');
select ok(private.party_upload_readable(pg_temp.ticket_name(pg_temp.id('t1'))), 'an org reader of the packet may read the token upload');
select pg_temp.claims('quinn');
select ok(not private.party_upload_readable(pg_temp.ticket_name(pg_temp.id('t1'))), 'another party may not');
select pg_temp.as_platform();
insert into private.rate_limit_events (bucket, subject_hash)
select 'advance_token_upload', extensions.digest(pg_temp.id('tok_art')::text, 'sha256') from generate_series(1, 20);
select is(pg_temp.begin_upload('xadv_r10artist', 's_file', 'rider.pdf'), 'advance_upload_rate', 'uploads are limited per link per hour');

-- Guests through the link -----------------------------------------------------------------------------------------------------------------------
create function pg_temp.guest(p_token text, p_name text, p_plus integer) returns text
language plpgsql as $$
declare
  v_section uuid := pg_temp.id('s_guests');
  v text;
begin
  perform pg_temp.as_anon();
  select coalesce(g.reason, g.guest_entry_id::text) into v
  from api_public.request_advance_guest(p_token, '424242', v_section, p_name, p_plus, null) g;
  perform pg_temp.as_platform();
  return v;
end $$;
select is(pg_temp.guest('xadv_r10artist', 'Sasha Bell', 0), 'guest_list_closed', 'an engagement that is not Active takes no guest');
insert into world select 'g1', pg_temp.guest('xadv_r10vendor', 'Sasha Bell', 1)::uuid;
select is((select entry_state::text || ' ' || engagement_id::text from app.guest_list_entries where id = pg_temp.id('g1')),
  'Requested ' || pg_temp.id('eng_vendor_a'), 'a guest is Requested on the recipient''s engagement');
select is(pg_temp.guest('xadv_r10vendor', 'Rowan Hale', 1),
  'guest_list_cap', 'the cap counts plus-ones');
select is(pg_temp.guest('xadv_r10vendor', '', 0), 'guest_name_length', 'a guest has a name');
insert into private.rate_limit_events (bucket, subject_hash)
select 'advance_token_guest', extensions.digest(pg_temp.id('tok')::text, 'sha256') from generate_series(1, 50);
select is(pg_temp.guest('xadv_r10vendor', 'Jo Park', 0), 'advance_guest_rate', 'guests are limited per link per day');

-- The crew roster through the link -----------------------------------------------------------------------------------------------------------
create function pg_temp.invite(p_token text, p_email text) returns text
language plpgsql as $$
declare
  v_section uuid := pg_temp.id('s_roster');
  v text;
begin
  perform pg_temp.as_anon();
  select coalesce(i.reason, i.roster_entry_id::text) into v
  from api_public.invite_advance_roster_member(p_token, '424242', v_section, p_email, null, null, null, null) i;
  perform pg_temp.as_platform();
  return v;
end $$;
select is(pg_temp.anon($$select reason from api_public.advance_roster('xadv_r10vendor', '424242',
  (select id from world where key = 's_items'))$$), 'advance_section_open', 'only a Crew Roster section shows the roster');
select is(pg_temp.invite('xadv_r10vendor', 'not an address'), 'invitation_email', 'an invite needs one address');
insert into world select 'e_new', pg_temp.invite('xadv_r10vendor', 'Nova.Crew@Bayside-Audio.test')::uuid;
select is((select entry_state::text || ' ' || (person_id is null)::text from app.engagement_roster_entries where id = pg_temp.id('e_new')),
  'Draft true', 'an invite makes a Draft entry with no person yet');
select is((select advance_recipient_token_id::text || ' ' || (invited_by is null)::text from app.roster_invitations
  where roster_entry_id = pg_temp.id('e_new')), pg_temp.id('tok') || ' true', 'the invitation is sent through the link');
select is((select count(*)::int from private.platform_emails where template = 'party_invitation' and to_email = 'nova.crew@bayside-audio.test'),
  1, 'with one email queued');
select is(pg_temp.invite('xadv_r10vendor', 'nova.crew@bayside-audio.test'), 'roster_person_duplicate', 'an address is invited once');
select is(pg_temp.anon(format($$select display_name || ' ' || entry_state || ' ' || invitation_state
  from api_public.advance_roster('xadv_r10vendor', '424242', %L) where roster_entry_id = %L$$, pg_temp.id('s_roster'), pg_temp.id('e_new'))),
  'n***@bayside-audio.test Draft Pending', 'the roster masks an invited address');
select is(pg_temp.anon(format($$select display_name from api_public.advance_roster('xadv_r10vendor', '424242', %L)
  where roster_entry_id = %L$$, pg_temp.id('s_roster'), pg_temp.id('e_kai'))),
  (select full_name from app.people where id = pg_temp.id('kai')), 'and names a person who accepted');

select pg_temp.new_user('nova', 'nova.crew@bayside-audio.test', 'Nova Reyes');
select pg_temp.as_user('nova');
select is((select inviter_name from app.my_pending_invitations() where invitation_kind = 'roster'), 'Bayside Audio',
  'the invitee sees the party as the inviter');
select lives_ok($$select app.respond_party_invitation('roster',
  (select invitation_id from app.my_pending_invitations() where invitation_kind = 'roster'), true)$$, 'and accepts the entry');
select pg_temp.as_platform();
select is(pg_temp.anon(format($$select display_name from api_public.advance_roster('xadv_r10vendor', '424242', %L)
  where roster_entry_id = %L$$, pg_temp.id('s_roster'), pg_temp.id('e_new'))), 'Nova Reyes', 'once accepted the roster names them');
select ok(pg_temp.anon(format($$select coalesce(reason, submitted::text)
  from api_public.submit_advance_roster('xadv_r10vendor', '424242', %L)$$, pg_temp.id('s_roster'))) ~ '^[1-9][0-9]*$',
  'submit through the link moves the roster''s named Drafts to Submitted');
select is((select entry_state::text from app.engagement_roster_entries where id = pg_temp.id('e_new')), 'Submitted', 'for review');
insert into private.rate_limit_events (bucket, subject_hash)
select 'advance_token_roster', extensions.digest(pg_temp.id('tok')::text, 'sha256') from generate_series(1, 50);
select is(pg_temp.invite('xadv_r10vendor', 'another@bayside-audio.test'), 'advance_roster_rate', 'invites are limited per link per day');

-- The claim: nothing is written, and the claimer is the requester ---------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select claimed_tokens from app.claim_advance_token('xadv_r10vendor')), 1, 'carol claims her link');
select pg_temp.as_platform();
select is((select created_by from app.advance_allocations where id = pg_temp.id('alloc')), null::uuid, 'no column is written at claim');
select is(private.allocation_requester(pg_temp.id('alloc')), pg_temp.id('carol'), 'the claimer is the allocation''s requester');
select is(private.roster_entry_creator(pg_temp.id('e_new')), pg_temp.id('carol'), 'and the creator of the entry she invited');
select pg_temp.as_user('carol');
select is((select requested_by from app.advance_allocation_status where allocation_id = pg_temp.id('alloc')), pg_temp.id('carol'),
  'the allocation status names her as requester');
select throws_like($$select app.decide_allocation((select id from world where key = 'alloc'), 'Approved', null, null)$$,
  '%sod_allocation_requester%', 'the claimer cannot approve the allocation her token answer created');
select throws_like($$select app.review_roster_entry((select id from world where key = 'e_new'), 'Accepted')$$,
  '%sod_roster_reviewer%', 'nor review the entry she invited');
select is((select count(*)::int from app.my_advance_submissions() where submission_id in (pg_temp.id('a_items'))), 1,
  'her token answers are hers');
insert into world select 'alloc_signed_in', pg_temp.alloc('assign', 'carol', 'e_kai', 'class', 'cls_radio', 1);
select pg_temp.as_platform();
select is((select count(*)::int from private.advance_allocation_status_rows s
  where s.requested_by is distinct from private.allocation_requester(s.allocation_id)), 0,
  'the status rows and the separation rule agree on every allocation''s requester');
select ok(exists (select 1 from private.advance_allocation_status_rows s
    join app.advance_allocations a on a.id = s.allocation_id where a.created_by is not null)
  and exists (select 1 from private.advance_allocation_status_rows s
    join app.advance_allocations a on a.id = s.allocation_id where a.created_by is null and s.requested_by is not null),
  'over allocations made signed in and through a claimed link');

select is((select r.granted_by from app.account_membership_roles r join app.account_memberships m on m.id = r.account_membership_id
  where m.person_id = pg_temp.id('nova') and r.account_role = 'Account Member' and r.deleted_at is null), null::uuid,
  'a link invitee who accepted before the claim holds a role no one granted yet');
delete from private.rate_limit_events where bucket = 'advance_token_roster';
insert into world select 'e_ash', pg_temp.invite('xadv_r10vendor', 'ash.crew@bayside-audio.test')::uuid;
select pg_temp.new_user('ash', 'ash.crew@bayside-audio.test', 'Ash Moreno');
select pg_temp.as_user('ash');
select lives_ok($$select app.respond_party_invitation('roster',
  (select invitation_id from app.my_pending_invitations() where invitation_kind = 'roster'), true)$$,
  'a person invited through the link after its claim accepts');
select pg_temp.as_platform();
select is((select r.granted_by from app.account_membership_roles r join app.account_memberships m on m.id = r.account_membership_id
  where m.person_id = pg_temp.id('ash') and r.account_role = 'Account Member' and r.deleted_at is null), pg_temp.id('carol'),
  'and holds the Account Member role granted by the person who claimed the link');

select * from finish();
rollback;
