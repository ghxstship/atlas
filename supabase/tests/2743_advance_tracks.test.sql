-- pgTAP: migration 2743 (R11, G-176), status tracks with sign-off. Existing sections default to General and the track
-- changes after send. track_state goes Not Started, In Progress, Ready for Sign-off, Signed Off, and a new answer or a
-- Returned review makes it Reopened. Sign-off refuses advance_track_empty, advance_track_incomplete,
-- advance_track_signed_off and 42501 without advancing.submission.review; revoking needs a reason. Direct writes are
-- denied. api_external.advance_track_progress follows Section 8.7 and names no signer. xos_backup reads nothing; the
-- table is kept out of Trash and is in the realtime publication.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql

select no_plan();

create function pg_temp.state(p_recipient text, p_track text) returns text
language plpgsql as $$
declare v text;
begin
  perform pg_temp.as_user('carol');
  select t.track_state into v from app.advance_track_progress t
  where t.advance_recipient_id = pg_temp.id(p_recipient) and t.track = p_track::app.advance_track;
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.answer(p_section text, p_body text) returns uuid
language sql as $$
  insert into app.advance_submissions (advance_section_id, advance_recipient_id, body)
  values (pg_temp.id(p_section), pg_temp.id('rcp_v'), p_body) returning id
$$;

create function pg_temp.review(p_answer uuid, p_outcome text, p_reason text default null) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user('alice');
  update app.advance_submissions set review_outcome = p_outcome::app.advance_review_outcome, return_reason = p_reason,
    reviewed_at = now(), reviewed_by = pg_temp.id('alice')
  where id = p_answer;
  perform pg_temp.as_platform();
end $$;

select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select pg_temp.as_user('alice');
with p as (insert into app.advance_packets (project_id, title) values (pg_temp.id('prj_a'), 'Production Advance') returning id)
insert into world select 'pkt', id from p;
with s as (insert into app.advance_sections (advance_packet_id, position, title) values (pg_temp.id('pkt'), 1, 'Hotel') returning id)
insert into world select 's_hotel', id from s;
with s as (insert into app.advance_sections (advance_packet_id, position, title) values (pg_temp.id('pkt'), 2, 'Green room') returning id)
insert into world select 's_green', id from s;
with s as (insert into app.advance_sections (advance_packet_id, position, title) values (pg_temp.id('pkt'), 3, 'Power') returning id)
insert into world select 's_power', id from s;
with r as (insert into app.advance_recipients (advance_packet_id, counterparty_id, engagement_id)
  values (pg_temp.id('pkt'), pg_temp.id('cp_v_a'), pg_temp.id('eng_vendor_a')) returning id)
insert into world select 'rcp_v', id from r;
select pg_temp.as_platform();

select is((select track::text from app.advance_sections where id = pg_temp.id('s_hotel')), 'General', 'a section is on the General track by default');

select pg_temp.as_user('alice');
select app.send_advance_packet(pg_temp.id('pkt'));
select lives_ok(format($$update app.advance_sections set track = 'Hospitality' where id in (%L, %L)$$, pg_temp.id('s_hotel'), pg_temp.id('s_green')),
  'the track changes after send');
update app.advance_sections set track = 'Technical' where id = pg_temp.id('s_power');
select pg_temp.as_platform();

-- States -----------------------------------------------------------------------------------------------------------------------
select is(pg_temp.state('rcp_v', 'Hospitality'), 'Not Started', 'nothing answered is Not Started');
select is(pg_temp.state('rcp_v', 'General'), null, 'a track with no section has no row');
insert into world select 'a_hotel', pg_temp.answer('s_hotel', 'Twelve rooms, three nights.');
select is(pg_temp.state('rcp_v', 'Hospitality'), 'In Progress', 'one answer is In Progress');
select pg_temp.review(pg_temp.id('a_hotel'), 'Accepted');
insert into world select 'a_green', pg_temp.answer('s_green', 'Two green rooms.');
select pg_temp.review(pg_temp.id('a_green'), 'Accepted');
select is(pg_temp.state('rcp_v', 'Hospitality'), 'Ready for Sign-off', 'every section accepted is Ready for Sign-off');
select pg_temp.as_user('carol');
select is((select sections_done || '/' || sections_total from app.advance_track_progress where advance_recipient_id = pg_temp.id('rcp_v')
  and track = 'Hospitality'), '2/2', 'with its counts');
select pg_temp.as_platform();

-- Signing off ---------------------------------------------------------------------------------------------------------------
select pg_temp.producer('watcher', 'advancing.packet.read');
select pg_temp.as_user('watcher');
select throws_ok(format($$select app.sign_off_advance_track(%L, 'Hospitality')$$, pg_temp.id('rcp_v')), '42501', null,
  'signing off needs advancing.submission.review');
select pg_temp.as_user('carol');
select throws_ok(format($$select app.sign_off_advance_track(%L, 'Finance')$$, pg_temp.id('rcp_v')), 'XR001',
  'advance_track_empty: No section of the packet is on this track.', 'a track with no section is refused');
select throws_ok(format($$select app.sign_off_advance_track(%L, 'Technical')$$, pg_temp.id('rcp_v')), 'XR001',
  'advance_track_incomplete: Every section on the track must be accepted, complete or not applicable first.', 'an incomplete track is refused');
insert into world select 'signoff', app.sign_off_advance_track(pg_temp.id('rcp_v'), 'Hospitality');
select throws_ok(format($$select app.sign_off_advance_track(%L, 'Hospitality')$$, pg_temp.id('rcp_v')), 'XR001',
  'advance_track_signed_off: This track is signed off already; revoke the sign-off to sign it again.', 'a second sign-off is refused');
select pg_temp.as_platform();
select is(pg_temp.state('rcp_v', 'Hospitality'), 'Signed Off', 'signed off');
select pg_temp.as_user('carol');
select is((select signed_off_by_name from app.advance_track_progress where advance_recipient_id = pg_temp.id('rcp_v') and track = 'Hospitality'),
  'Carol Nguyen', 'naming the signer to the producing org');
select pg_temp.as_platform();
select is((select created_by from app.advance_track_signoffs where id = pg_temp.id('signoff')), pg_temp.id('carol'), 'the signer is created_by');

-- Direct writes ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok(format($$insert into app.advance_track_signoffs (advance_recipient_id, track) values (%L, 'Technical')$$, pg_temp.id('rcp_v')),
  '42501', null, 'a sign-off is never inserted directly');
select pg_temp.as_platform();
select throws_ok(format($$insert into app.advance_track_signoffs (advance_recipient_id, track) values (%L, 'Technical')$$, pg_temp.id('rcp_v')),
  'XR001', null, 'not even by the platform, outside the RPC');

-- Gateway ------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('victor');
select is((select track_state from api_external.advance_track_progress where advance_recipient_id = pg_temp.id('rcp_v') and track = 'Hospitality'),
  'Signed Off', 'the account''s Owner reads its own track');
select ok((select signed_off_at is not null from api_external.advance_track_progress where advance_recipient_id = pg_temp.id('rcp_v')
  and track = 'Hospitality'), 'with when it was signed off');
select pg_temp.as_user('pia');
select is((select count(*)::int from api_external.advance_track_progress where advance_recipient_id = pg_temp.id('rcp_v')), 2,
  'the Advancing Lead reads it too');
select pg_temp.as_user('kai');
select is((select count(*)::int from api_external.advance_track_progress), 0, 'an unassigned Account Member reads none');
select pg_temp.as_user('ivy');
select is((select count(*)::int from api_external.advance_track_progress), 0, 'nor does another party');
select pg_temp.as_platform();
select hasnt_column('api_external', 'advance_track_progress', 'signed_off_by_name', 'Gateway never names the signer');
select is((select count(*)::int from information_schema.columns where table_schema = 'api_external' and table_name = 'advance_track_progress'),
  7, 'seven columns');

-- Reopened -----------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok(format($$select app.revoke_advance_track_signoff(%L, '  ')$$, pg_temp.id('signoff')), 'XR001',
  'advance_track_revoke_reason: Say why the sign-off is revoked, in 1 to 500 characters.', 'revoking needs a reason');
select pg_temp.as_platform();

-- An accepted section takes no new answer (R1), so the power section moves onto the signed-off track and is answered there.
select pg_temp.as_user('alice');
update app.advance_sections set track = 'Hospitality' where id = pg_temp.id('s_power');
select pg_temp.as_platform();
select is(pg_temp.state('rcp_v', 'Hospitality'), 'Reopened', 'a section no longer done on a signed-off track is Reopened');
insert into world select 'a_power', pg_temp.answer('s_power', 'Two 63 A feeds.');
select pg_temp.review(pg_temp.id('a_power'), 'Returned', 'Which stage?');
select is(pg_temp.state('rcp_v', 'Hospitality'), 'Reopened', 'a Returned review keeps it Reopened');
insert into world select 'a_power2', pg_temp.answer('s_power', 'Two 63 A feeds at the main stage.');
select pg_temp.review(pg_temp.id('a_power2'), 'Accepted');
select is(pg_temp.state('rcp_v', 'Hospitality'), 'Reopened', 'an answer newer than the sign-off keeps it Reopened even once accepted');

select pg_temp.as_user('carol');
select lives_ok(format($$select app.revoke_advance_track_signoff(%L, 'The power answer came in after sign-off.')$$, pg_temp.id('signoff')),
  'a reviewer revokes it with a reason');
select pg_temp.as_platform();
select is((select revoke_reason from app.advance_track_signoffs where id = pg_temp.id('signoff')), 'The power answer came in after sign-off.',
  'the row keeps its reason');
select is(pg_temp.state('rcp_v', 'Hospitality'), 'Ready for Sign-off', 'revoked, the done track is Ready again');
select pg_temp.as_user('carol');
select lives_ok(format($$select app.sign_off_advance_track(%L, 'Hospitality')$$, pg_temp.id('rcp_v')), 'and is signed off again');
select pg_temp.as_platform();
select is(pg_temp.state('rcp_v', 'Hospitality'), 'Signed Off', 'Signed Off once more');

-- Catalog ------------------------------------------------------------------------------------------------------------------------
select ok(not has_table_privilege('xos_backup', 'app.advance_track_progress', 'select'), 'xos_backup cannot select app.advance_track_progress');
select ok(exists (select 1 from private.trash_excluded_tables where table_name = 'advance_track_signoffs'), 'sign-offs are kept out of Trash');
select ok(exists (select 1 from pg_catalog.pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'app'
  and tablename = 'advance_track_signoffs'), 'and are in the realtime publication');
select ok(exists (select 1 from private.domain_event_types where code = 'advance_track.signed_off'), 'a sign-off is a domain event');

select * from finish();
rollback;
