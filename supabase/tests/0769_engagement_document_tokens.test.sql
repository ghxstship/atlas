-- pgTAP: migration 0769, signing links for engagement documents (Section 4.4.6). Issue (authority, state, validity,
-- email), hashes never readable, the anon page and signing with every refusal (wrong code counted, lock at 5,
-- expiry, revoked, not awaiting signature, missing name), the Engagement-Document transition with the signer named
-- in the ledger, claiming by confirmed email, and RLS on the token table.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select * from no_plan();

create temporary table tok (key text primary key, token_id uuid, token text, access_code text);
grant select, insert, update on tok to public;

select pg_temp.as_user('carol');
with d as (insert into app.engagement_documents (engagement_id, document_kind, title) values (pg_temp.id('eng_ivy_a'), 'Agreement', 'Crew Agreement') returning id)
  insert into world select 'doc', id from d;
with d as (insert into app.engagement_documents (engagement_id, document_kind, title) values (pg_temp.id('eng_ivy_a'), 'Non-Disclosure Agreement', 'Show NDA') returning id)
  insert into world select 'doc2', id from d;

-- Issuing -------------------------------------------------------------------------------------------------------------------
select throws_ok(format($$select * from app.issue_engagement_document_token('%s', 'ivy@freelance.test')$$, pg_temp.id('doc')),
  'XR001', null, 'a link is issued only for a Sent document');
select app.transition_engagement_document(pg_temp.id('doc'), 'Proposed', 'Sent', 'Sent for signature.');
select app.transition_engagement_document(pg_temp.id('doc2'), 'Proposed', 'Sent', 'Sent for signature.');
select throws_ok(format($$select * from app.issue_engagement_document_token('%s', 'not-an-email')$$, pg_temp.id('doc')),
  'XR001', null, 'a link goes to a valid email');
select throws_ok(format($$select * from app.issue_engagement_document_token('%s', 'ivy@freelance.test', interval '1 minute')$$, pg_temp.id('doc')),
  'XR001', null, 'a link lasts at least an hour');
insert into tok select 'a', t.token_id, t.token, t.access_code from app.issue_engagement_document_token(pg_temp.id('doc'), 'Ivy@Freelance.test') t;
insert into tok select 'b', t.token_id, t.token, t.access_code from app.issue_engagement_document_token(pg_temp.id('doc2'), 'ivy@freelance.test') t;
select pg_temp.as_user('gina');
select throws_ok(format($$select * from app.issue_engagement_document_token('%s', 'ivy@freelance.test')$$, pg_temp.id('doc')),
  '42501', null, 'role band: a Viewer cannot issue links');
select pg_temp.as_user('xavier');
select throws_ok(format($$select * from app.issue_engagement_document_token('%s', 'ivy@freelance.test')$$, pg_temp.id('doc')),
  '42501', null, 'cross tenant: another org cannot issue links');
select pg_temp.as_user('carol');
select throws_ok('select token_hash from app.engagement_document_tokens', '42501', null, 'token hashes are never readable');
select is((select recipient_email from app.engagement_document_tokens where id = (select token_id from tok where key = 'a')), 'ivy@freelance.test',
  'the email is stored lower case');
select pg_temp.as_platform();
select is((select count(*)::int from app.engagement_document_tokens where token_hash = extensions.digest((select token from tok where key = 'a'), 'sha256')), 1,
  'only the hash of the token is stored');
select is((select count(*)::int from app.engagement_document_tokens t, tok where t.token_hash = convert_to(tok.token, 'UTF8')), 0, 'never the token itself');

-- RLS on the token table -----------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select count(*)::int from app.engagement_document_tokens), 2, 'same tenant: the engagement writer lists links');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.engagement_document_tokens), 0, 'cross tenant: none');
select pg_temp.as_user('ivy');
select is((select count(*)::int from app.engagement_document_tokens), 0, 'the recipient never reads the link table');
select pg_temp.as_anon();
select throws_ok('select 1 from app.engagement_document_tokens', '42501', null, 'anon deny on the table');

-- The anon page ---------------------------------------------------------------------------------------------------------------
select is((select reason from api_public.token_document((select token from tok where key = 'a'), '000000x')), 'document_access_code', 'a wrong code is refused');
select is((select reason from api_public.token_document('xdoc_nothing', '123456')), 'document_token_invalid', 'an unknown token is refused');
select is((select title from api_public.token_document((select token from tok where key = 'a'), (select access_code from tok where key = 'a'))), 'Crew Agreement',
  'the link and code open the document');
select is((select reason from api_public.token_sign_document((select token from tok where key = 'a'), (select access_code from tok where key = 'a'), '  ')),
  'document_signer_name', 'signing needs the signer''s name');
select ok((select signed_at is not null and refusal is null from api_public.token_sign_document((select token from tok where key = 'a'),
  (select access_code from tok where key = 'a'), 'Ivy Marchetti')), 'the holder signs with their name');
select is((select reason from api_public.token_sign_document((select token from tok where key = 'a'), (select access_code from tok where key = 'a'), 'Ivy Marchetti')),
  'document_not_awaiting_signature', 'a signed document is not signed twice');
select pg_temp.as_platform();
select is((select engagement_document_state::text from app.engagement_documents where id = pg_temp.id('doc')), 'Signed', 'the document is Signed');
select is((select reason from app.engagement_document_state_transitions where engagement_document_id = pg_temp.id('doc') and to_state = 'Signed'),
  'Signed by Ivy Marchetti through a signing link.', 'the ledger names the signer');
select ok(exists (select 1 from app.domain_events where event_type = 'engagement_document.token_signed' and subject_id = pg_temp.id('doc')), 'the signature emits an event');

-- Lock, expiry and revocation ---------------------------------------------------------------------------------------------------
select pg_temp.as_anon();
select api_public.token_document((select token from tok where key = 'b'), '111111') from generate_series(1, 4);
select is((select reason from api_public.token_document((select token from tok where key = 'b'), '111111')), 'document_token_locked', 'the fifth wrong code locks the link');
select is((select reason from api_public.token_document((select token from tok where key = 'b'), (select access_code from tok where key = 'b'))), 'document_token_locked',
  'a locked link stays locked even with the right code');
select pg_temp.as_user('carol');
insert into tok select 'c', t.token_id, t.token, t.access_code from app.issue_engagement_document_token(pg_temp.id('doc2'), 'ivy@freelance.test') t;
select pg_temp.as_platform();
update app.engagement_document_tokens set expires_at = now() - interval '1 minute' where id = (select token_id from tok where key = 'c');
select pg_temp.as_anon();
select is((select reason from api_public.token_document((select token from tok where key = 'c'), (select access_code from tok where key = 'c'))), 'document_token_expired',
  'an expired link is refused');
select pg_temp.as_user('carol');
insert into tok select 'd', t.token_id, t.token, t.access_code from app.issue_engagement_document_token(pg_temp.id('doc2'), 'ivy@freelance.test') t;
select app.revoke_engagement_document_token((select token_id from tok where key = 'd'));
select pg_temp.as_anon();
select is((select reason from api_public.token_document((select token from tok where key = 'd'), (select access_code from tok where key = 'd'))), 'document_token_invalid',
  'a revoked link is refused');
select pg_temp.as_platform();

-- Claiming ------------------------------------------------------------------------------------------------------------------------
update auth.users set email_confirmed_at = null where id = pg_temp.id('quinn_user');
select pg_temp.as_user('quinn');
select throws_ok('select * from app.claim_token_submissions()', 'XR001', null, 'an unconfirmed email cannot claim');
select pg_temp.as_user('sam');
select is((select claimed_documents from app.claim_token_submissions()), 0, 'another email claims nothing');
select pg_temp.as_user('ivy');
select is((select claimed_documents from app.claim_token_submissions()), 4, 'ivy claims every link sent to her email');
select is((select count(*)::int from api_external.my_token_documents where signed_at is not null), 1, 'the signed document appears under her account');
select is((select claimed_documents from app.claim_token_submissions()), 0, 'claiming twice claims nothing new');
select pg_temp.as_platform();
select is((select count(*)::int from api_external.my_token_documents), 0, 'the platform role has no claimed links');
select pg_temp.as_anon();
select throws_ok('select * from app.claim_token_submissions()', '42501', null, 'anon cannot claim');
select pg_temp.as_platform();

select * from finish();
rollback;
