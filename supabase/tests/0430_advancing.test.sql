-- pgTAP: A10 Advancing (0430). Sending through app.send_advance_packet only, once, with sections and
-- recipients; fixed sections after send; answers only to sent packets from recipients of the same
-- packet, immutable, reviewed once as Accepted or Returned with a reason by someone other than the
-- submitter (sod_advance_submitter); token links with hashed token and access code, lock after 5 wrong
-- codes, expiry, revocation by reissue, anon preview and submit, claim by verified email (journey 50);
-- token hashes unreadable; cross-tenant and anon denials; domain events for every act.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

create temporary table links (key text primary key, token text, code text, token_id uuid);
grant select, insert, update on links to public;

select plan(55);

-- Draft packets and sending ----------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$insert into app.advance_packets (project_id, title, sent_at) values ((select id from world where key = 'prj_a'), 'Sent Already', now())$$,
  'XR001', 'advance_packet_send: A packet is created as a draft and sent with app.send_advance_packet.', 'a packet is created as a draft');
with x as (insert into app.advance_packets (project_id, title, due_at) values (pg_temp.id('prj_a'), 'Headliner Advance', now() + interval '14 days') returning id) insert into world select 'pkt', id from x;
with x as (insert into app.advance_packets (project_id, title) values (pg_temp.id('prj_a'), 'Vendor Advance') returning id) insert into world select 'pkt2', id from x;
select throws_ok($$update app.advance_packets set sent_at = now() where id = (select id from world where key = 'pkt')$$,
  'XR001', 'advance_packet_send: Send a packet with app.send_advance_packet.', 'sent_at is never set directly');
select throws_ok($$select app.send_advance_packet((select id from world where key = 'pkt'))$$,
  'XR001', 'advance_packet_no_sections: Add a section before sending.', 'a packet without sections is not sent');
with x as (insert into app.advance_sections (advance_packet_id, position, title, prompt) values (pg_temp.id('pkt'), 1, 'Arrival', 'When does the party arrive, and how many travel?') returning id) insert into world select 'sec1', id from x;
with x as (insert into app.advance_sections (advance_packet_id, position, title) values (pg_temp.id('pkt'), 2, 'Backline') returning id) insert into world select 'sec2', id from x;
with x as (insert into app.advance_sections (advance_packet_id, position, title) values (pg_temp.id('pkt2'), 1, 'Power') returning id) insert into world select 'sec_other', id from x;
select throws_ok($$select app.send_advance_packet((select id from world where key = 'pkt'))$$,
  'XR001', 'advance_packet_no_recipients: Add a recipient before sending.', 'a packet without recipients is not sent');
with x as (insert into app.advance_recipients (advance_packet_id, person_id) values (pg_temp.id('pkt'), pg_temp.id('mia')) returning id) insert into world select 'rcp', id from x;
with x as (insert into app.advance_recipients (advance_packet_id, person_id) values (pg_temp.id('pkt2'), pg_temp.id('mia')) returning id) insert into world select 'rcp_other', id from x;
select throws_ok($$insert into app.advance_submissions (advance_section_id, advance_recipient_id, body) values ((select id from world where key = 'sec1'), (select id from world where key = 'rcp'), 'Early.')$$,
  'XR001', 'advance_packet_unsent: A packet takes answers once it is sent.', 'a draft packet takes no answers');
select pg_temp.as_user('erin');
select throws_ok($$select app.send_advance_packet((select id from world where key = 'pkt'))$$,
  'XR001', 'advance_send_authority: Sending a packet needs advancing.packet.send on its project.', 'a Collaborator who edits packets cannot send them');
select pg_temp.as_user('xavier');
select throws_ok($$select app.send_advance_packet((select id from world where key = 'pkt'))$$, '42501', null, 'another org cannot send the packet');
select pg_temp.as_user('dave');
select lives_ok($$select app.send_advance_packet((select id from world where key = 'pkt'))$$, 'a Member with send authority on the project sends the packet');
select ok((select sent_at is not null from app.advance_packets where id = pg_temp.id('pkt')), 'the packet is stamped sent');
select throws_ok($$select app.send_advance_packet((select id from world where key = 'pkt'))$$,
  'XR001', 'advance_packet_sent: This packet was already sent.', 'a packet is sent once');
select throws_ok($$update app.advance_packets set sent_at = null where id = (select id from world where key = 'pkt')$$,
  'XR001', 'advance_packet_sent: A sent packet stays sent.', 'a sent packet stays sent');
select throws_ok($$insert into app.advance_sections (advance_packet_id, position, title) values ((select id from world where key = 'pkt'), 3, 'Late Section')$$,
  'XR001', null, 'no section is added to a sent packet');
select throws_ok($$update app.advance_sections set deleted_at = now() where id = (select id from world where key = 'sec2')$$,
  'XR001', null, 'no section is removed from a sent packet');
select lives_ok($$update app.advance_sections set title = 'Backline and Instruments' where id = (select id from world where key = 'sec2')$$, 'section wording may be corrected after send');
select lives_ok($$select app.send_advance_packet((select id from world where key = 'pkt2'))$$, 'the second packet is sent');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'advance_packet.sent' and subject_id = pg_temp.id('pkt')), 1, 'sending emits advance_packet.sent once');
select is((select count(*)::int from app.domain_events where event_type = 'advance_packet.created' and subject_id = pg_temp.id('pkt')), 1, 'creating emits advance_packet.created');

-- Token links ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('erin');
select throws_ok($$select * from app.issue_advance_token((select id from world where key = 'rcp'), 'mia@northwind.test')$$,
  'XR001', null, 'a Collaborator cannot issue advance links');
select pg_temp.as_user('dave');
select throws_ok($$select * from app.issue_advance_token((select id from world where key = 'rcp'), 'not an email')$$,
  'XR001', 'advance_token_email: An advance link goes to a valid email address.', 'a link goes to a valid email');
select throws_ok($$select * from app.issue_advance_token((select id from world where key = 'rcp'), 'mia@northwind.test', interval '120 days')$$,
  'XR001', 'advance_token_validity: An advance link is valid for 1 hour to 90 days.', 'a link is valid for at most 90 days');
insert into links select 'first', i.token, i.access_code, i.token_id from app.issue_advance_token(pg_temp.id('rcp'), 'Mia@Northwind.test') i;
select matches((select token from links where key = 'first'), '^xadv_[0-9a-f]{64}$', 'the token is 256 random bits');
select matches((select code from links where key = 'first'), '^[0-9]{6}$', 'the access code has 6 digits');
select is((select recipient_email from app.advance_recipient_tokens where id = (select token_id from links where key = 'first')), 'mia@northwind.test', 'the email is stored in lower case');
select throws_ok($$select token_hash from app.advance_recipient_tokens$$, '42501', null, 'the token hash is unreadable even to the issuer');
select throws_ok($$insert into app.advance_recipient_tokens (advance_recipient_id, recipient_email, token_hash, access_code_hash, expires_at) values ((select id from world where key = 'rcp'), 'x@example.com', '\x00', '\x00', now())$$,
  '42501', null, 'tokens are written only by the RPCs');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.advance_recipient_tokens), 0, 'another org reads no tokens');

-- Anon preview and submit -----------------------------------------------------------------------------------------
select pg_temp.as_anon();
select throws_ok('select 1 from app.advance_submissions', '42501', null, 'anon cannot read submissions');
select is((select reason from api_public.preview_advance('xadv_nothing', '000000')), 'advance_token_invalid', 'an unknown token is refused');
select is((select reason from api_public.preview_advance((select token from links where key = 'first'), 'wrong!')), 'advance_access_code', 'a wrong access code is refused');
select is((select count(*)::int from api_public.preview_advance((select token from links where key = 'first'), (select code from links where key = 'first'))), 2,
  'with the access code the form shows each section');
select is((select string_agg(section_title, ', ' order by section_position) from api_public.preview_advance((select token from links where key = 'first'), (select code from links where key = 'first'))),
  'Arrival, Backline and Instruments', 'in packet order');
select is((select reason from api_public.submit_advance((select token from links where key = 'first'), (select code from links where key = 'first'), (select id from world where key = 'sec_other'), 'Wrong packet.')),
  'advance_section_open', 'a token answers only its own packet');
select is((select reason from api_public.submit_advance((select token from links where key = 'first'), (select code from links where key = 'first'), (select id from world where key = 'sec1'), '   ')),
  'advance_answer_length', 'a blank answer is refused');
select isnt((select submission_id from api_public.submit_advance((select token from links where key = 'first'), (select code from links where key = 'first'), (select id from world where key = 'sec1'), 'Party of 8 lands 14:20 on June 4.')),
  null, 'the recipient answers without an account');
select pg_temp.as_platform();
insert into world select 'sub_token', id from app.advance_submissions where advance_recipient_token_id = (select token_id from links where key = 'first');
select is((select failed_attempts::int from app.advance_recipient_tokens where id = (select token_id from links where key = 'first')), 1, 'the wrong code was counted');
select ok((select used_at is not null from app.advance_recipient_tokens where id = (select token_id from links where key = 'first')), 'the link is marked used');
select is((select count(*)::int from app.domain_events where event_type = 'advance_submission.received' and subject_id = pg_temp.id('sub_token')), 1, 'the answer emits advance_submission.received');
select is((select answer_body from api_public.preview_advance((select token from links where key = 'first'), (select code from links where key = 'first')) where section_title = 'Arrival'),
  'Party of 8 lands 14:20 on June 4.', 'the form shows the latest answer');

-- Answers are immutable and reviewed once by someone else -------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$insert into app.advance_submissions (advance_section_id, advance_recipient_id, advance_recipient_token_id, body) values ((select id from world where key = 'sec1'), (select id from world where key = 'rcp'), (select token_id from links where key = 'first'), 'Forged.')$$,
  'XR001', null, 'token answers arrive only through submit_advance');
select throws_ok($$insert into app.advance_submissions (advance_section_id, advance_recipient_id, body) values ((select id from world where key = 'sec1'), (select id from world where key = 'rcp_other'), 'Cross.')$$,
  'XR001', 'advance_recipient_packet: Only a recipient of the same packet answers its sections.', 'only a recipient of the same packet answers');
select throws_ok($$update app.advance_submissions set body = 'Edited.' where id = (select id from world where key = 'sub_token')$$,
  'XR001', 'advance_submission_immutable: An answer never changes after it arrives; the recipient answers again instead.', 'an answer never changes');
select throws_ok($$update app.advance_submissions set reviewed_at = now(), reviewed_by = (select id from world where key = 'dave'), review_outcome = 'Returned' where id = (select id from world where key = 'sub_token')$$,
  '23514', null, 'a returned answer needs a reason');
select lives_ok($$update app.advance_submissions set reviewed_at = now(), reviewed_by = (select id from world where key = 'dave'), review_outcome = 'Returned', return_reason = 'Please add the flight number.' where id = (select id from world where key = 'sub_token')$$,
  'a reviewer returns the answer with a reason');
select throws_ok($$update app.advance_submissions set review_outcome = 'Accepted', return_reason = null where id = (select id from world where key = 'sub_token')$$,
  'XR001', 'advance_submission_reviewed: An answer is reviewed once.', 'an answer is reviewed once');
with x as (insert into app.advance_submissions (advance_section_id, advance_recipient_id, body) values (pg_temp.id('sec2'), pg_temp.id('rcp'), 'Drum riser 8 ft x 8 ft, per phone call.') returning id) insert into world select 'sub_phone', id from x;
select throws_ok($$update app.advance_submissions set reviewed_at = now(), reviewed_by = (select id from world where key = 'dave'), review_outcome = 'Accepted' where id = (select id from world where key = 'sub_phone')$$,
  'XR001', 'sod_advance_submitter: The person who submitted an advance answer cannot review it.', 'the submitter cannot review their own answer');
select pg_temp.as_user('alice');
update app.advance_submissions set reviewed_at = '2000-01-01', reviewed_by = pg_temp.id('mia'), review_outcome = 'Accepted' where id = pg_temp.id('sub_phone');
select is((select reviewed_by from app.advance_submissions where id = pg_temp.id('sub_phone')), pg_temp.id('alice'), 'the review is stamped with the reviewer');
select ok((select reviewed_at > '2020-01-01' from app.advance_submissions where id = pg_temp.id('sub_phone')), 'and the database time');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'advance_submission.reviewed' and subject_id in (pg_temp.id('sub_token'), pg_temp.id('sub_phone'))), 2, 'each review emits advance_submission.reviewed');

-- Lock, reissue, expiry ------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select api_public.preview_advance((select token from links where key = 'first'), 'nope') from generate_series(1, 4);
select is((select reason from api_public.preview_advance((select token from links where key = 'first'), (select code from links where key = 'first'))),
  'advance_token_locked', 'five wrong codes lock the link, even for the right code');
select pg_temp.as_user('dave');
insert into links select 'second', i.token, i.access_code, i.token_id from app.issue_advance_token(pg_temp.id('rcp'), 'mia@northwind.test', interval '2 hours') i;
select ok((select revoked_at is not null from app.advance_recipient_tokens where id = (select token_id from links where key = 'first')), 'a new link revokes the earlier one');
select pg_temp.as_platform();
update app.advance_recipient_tokens set expires_at = now() - interval '1 minute' where id = (select token_id from links where key = 'second');
select pg_temp.as_anon();
select is((select reason from api_public.preview_advance((select token from links where key = 'second'), (select code from links where key = 'second'))),
  'advance_token_expired', 'an expired link is refused');

-- Claim by verified email (journey 50) --------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is((select reason from app.claim_advance_token((select token from links where key = 'second'))), 'advance_claim_email', 'another email cannot claim the link');
select pg_temp.as_user('mia');
select is((select claimed_tokens from app.claim_advance_token((select token from links where key = 'second'))), 2,
  'the verified email claims the link and every earlier link sent to it');
select is((select count(*)::int from app.my_advance_submissions()), 1, 'the earlier token answer appears under the account');
select pg_temp.as_platform();
select is((select count(*)::int from app.domain_events where event_type = 'advance_token.claimed' and subject_id in (select token_id from links)), 2, 'each claim emits advance_token.claimed');

select * from finish();
rollback;
