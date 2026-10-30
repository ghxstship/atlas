-- pgTAP: connecting Google Drive and OneDrive with OAuth, and linking their files in place (B16, 3053; Section 17,
-- ADR 0155 D5). The state is bound to the person and the connection, lives 10 minutes and works once; unknown states
-- are counted and rate limited; only connections with a linking folder are offered; a person who cannot write the
-- document is refused before any credential is read; readers see a document's linked files with their provider.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(31);

create temporary table k (key text primary key, id uuid, txt text);
grant select, insert, update on k to public;

select pg_temp.as_user('bob');
with c as (insert into app.integration_connections (org_id, provider_code, display_name) values (pg_temp.id('org_a'), 'google_drive', 'Production Drive') returning id)
  insert into k (key, id) select 'drive', id from c;
with c as (insert into app.integration_connections (org_id, provider_code, display_name, provider_settings)
           values (pg_temp.id('org_a'), 'onedrive_sharepoint', 'Office OneDrive', '{"link_root_id": "root-1"}') returning id)
  insert into k (key, id) select 'onedrive', id from c;
with c as (insert into app.integration_connections (org_id, provider_code, display_name) values (pg_temp.id('org_a'), 'dropbox', 'Dropbox') returning id)
  insert into k (key, id) select 'dropbox', id from c;
select pg_temp.as_user('alice');
with x as (insert into app.documents (org_id, project_id, title) values (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Stage Plot') returning id)
  insert into k (key, id) select 'doc', id from x;
with x as (insert into app.documents (org_id, project_id, title) values (pg_temp.id('org_a'), pg_temp.id('prj_a2'), 'Gala Floor Plan') returning id)
  insert into k (key, id) select 'doc_gala', id from x;

-- Starting a sign-in ---------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$select * from app.begin_integration_oauth((select id from k where key = 'drive'), 'https://atlas.example.test/oauth/integrations/callback')$$,
  '42501', null, 'only an integrations Admin starts a sign-in');
select pg_temp.as_user('bob');
select throws_ok($$select * from app.begin_integration_oauth((select id from k where key = 'dropbox'), 'https://atlas.example.test/oauth/integrations/callback')$$,
  'XR001', 'integration_oauth_unsupported: This provider connects with a pasted credential, not with a sign-in.', 'Dropbox stays on pasted tokens');
select throws_like($$select * from app.begin_integration_oauth((select id from k where key = 'drive'), 'javascript:alert(1)')$$,
  'integration_oauth_redirect:%', 'the callback is an https address');
insert into k (key, txt) select 'state', b.state || ' ' || b.code_challenge
from app.begin_integration_oauth((select id from k where key = 'drive'), 'https://atlas.example.test/oauth/integrations/callback') b;
select ok(split_part((select txt from k where key = 'state'), ' ', 1) ~ '^[A-Za-z0-9_-]{43}$', 'the state is 32 random bytes, base64url');
select pg_temp.as_platform();
select is((select count(*)::integer from private.integration_oauth_states), 1, 'one state is stored');
select ok((select state_hash = sha256(convert_to(split_part((select txt from k where key = 'state'), ' ', 1), 'UTF8'))
           from private.integration_oauth_states), 'by its hash, never the state itself');
select is((select private.base64url(sha256(convert_to(code_verifier, 'UTF8'))) from private.integration_oauth_states),
  split_part((select txt from k where key = 'state'), ' ', 2), 'the challenge is the S256 of the stored verifier');
select ok((select expires_at = now() + interval '10 minutes' from private.integration_oauth_states), 'it lives 10 minutes');
select ok(not has_table_privilege('xos_backup', 'private.integration_oauth_states', 'select'),
  'the backup login never reads the verifiers');
select pg_temp.as_user('bob');
insert into k (key, txt) select 'state2', b.state
from app.begin_integration_oauth((select id from k where key = 'drive'), 'https://atlas.example.test/oauth/integrations/callback') b;
select pg_temp.as_platform();
select is((select count(*)::integer from private.integration_oauth_states), 1, 'starting again replaces the person''s earlier state');

-- Finishing ---------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select is((select status from app.finish_integration_oauth((select txt from k where key = 'state2'))), 'invalid',
  'another person''s state is invalid');
select pg_temp.as_user('bob');
select is((select status from app.finish_integration_oauth(split_part((select txt from k where key = 'state'), ' ', 1))), 'invalid',
  'the replaced state no longer works');
select results_eq($$select status, connection_id, provider_code, redirect_uri from app.finish_integration_oauth((select txt from k where key = 'state2'))$$,
  $$values ('ok'::text, (select id from k where key = 'drive'), 'google_drive'::text, 'https://atlas.example.test/oauth/integrations/callback'::text)$$,
  'the person who started it gets the connection, provider and redirect back');
select is((select status from app.finish_integration_oauth((select txt from k where key = 'state2'))), 'invalid',
  'and only once: a used state is invalid');
select pg_temp.as_platform();
update private.integration_oauth_states set used_at = null, expires_at = now() - interval '1 second';
select pg_temp.as_user('bob');
select is((select status from app.finish_integration_oauth((select txt from k where key = 'state2'))), 'invalid', 'an expired state is invalid');
select is((select count(*)::integer from (select app.finish_integration_oauth('guess-' || g) from generate_series(1, 7) g) x), 7,
  'unknown states keep answering');
select is((select status from app.finish_integration_oauth('guess-last')), 'rate_limited', 'until the tenth failure in 15 minutes');
select pg_temp.as_platform();
select is((select count(*)::integer from private.rate_limit_events where bucket = 'integration_oauth.failure'), 11,
  'every failure was counted (Bob''s ten and Carol''s one), none rolled back');

-- Linking -----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select app.store_integration_credential((select id from k where key = 'drive'), '{"access_token":"a","refresh_token":"r"}', 'OAuth Token');
select app.transition_integration_connection((select id from k where key = 'drive'), 'Pending', 'Connected', 'Signed in with Google.');
select app.store_integration_credential((select id from k where key = 'onedrive'), '{"access_token":"a","refresh_token":"r"}', 'OAuth Token');
select app.transition_integration_connection((select id from k where key = 'onedrive'), 'Pending', 'Connected', 'Signed in with Microsoft.');
select pg_temp.as_user('carol');
select is((select count(*)::integer from app.storage_connections_for_linking(pg_temp.id('org_a'))), 0,
  'a connection without a linking folder is not offered');
select throws_like($$select app.authorize_storage_link((select id from k where key = 'drive'), (select id from k where key = 'doc'))$$,
  'storage_link_folder_missing:%', 'and cannot be browsed');
select throws_like($$select app.authorize_storage_link((select id from k where key = 'onedrive'), (select id from k where key = 'doc'))$$,
  'storage_link_folder_missing:%', 'a OneDrive connection also needs its drive');
select pg_temp.as_user('bob');
update app.integration_connections set provider_settings = '{"link_root_id": "fld-crew"}' where id = (select id from k where key = 'drive');
select pg_temp.as_user('carol');
select results_eq($$select connection_id, provider_code, display_name from app.storage_connections_for_linking(pg_temp.id('org_a'))$$,
  $$values ((select id from k where key = 'drive'), 'google_drive'::text, 'Production Drive'::text)$$,
  'a document writer is offered the Drive connection once it has a linking folder');
select lives_ok($$select app.authorize_storage_link((select id from k where key = 'drive'), (select id from k where key = 'doc'))$$,
  'and may browse it for a document they write');
select pg_temp.as_user('dave');
select throws_ok($$select app.authorize_storage_link((select id from k where key = 'drive'), (select id from k where key = 'doc_gala'))$$,
  '42501', null, 'a person who cannot write the document is refused before any credential is read');
select pg_temp.as_user('gina');
select is((select count(*)::integer from app.storage_connections_for_linking(pg_temp.id('org_a'))), 0, 'a Viewer is offered nothing');
select pg_temp.as_user('xavier');
select throws_ok($$select app.authorize_storage_link((select id from k where key = 'drive'), (select id from k where key = 'doc'))$$,
  '42501', null, 'another org cannot use the connection');
select pg_temp.as_user('carol');
select throws_ok($$select app.authorize_storage_admin((select id from k where key = 'drive'))$$, '42501', null,
  'only an integrations Admin browses the whole account to choose the folder');
select pg_temp.as_user('bob');
select lives_ok($$select app.authorize_storage_admin((select id from k where key = 'drive'))$$, 'which the Admin may');

-- Linked files for readers ------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
insert into app.integration_file_links (integration_connection_id, document_id, external_file_id, file_name, web_url, mime_type)
values ((select id from k where key = 'drive'), (select id from k where key = 'doc'), 'drv-1', 'Stage Plot.pdf', 'https://drive.google.com/file/d/drv-1', 'application/pdf');
select pg_temp.as_user('dave');
select results_eq($$select provider_code, file_name, web_url from app.document_file_links((select id from k where key = 'doc'))$$,
  $$values ('google_drive'::text, 'Stage Plot.pdf'::text, 'https://drive.google.com/file/d/drv-1'::text)$$,
  'a reader of the document sees its linked files with their provider');
select is((select count(*)::integer from app.integration_connections), 0, 'though the reader cannot read the connections');
select pg_temp.as_user('gina');
select is((select count(*)::integer from app.document_file_links((select id from k where key = 'doc'))), 0,
  'someone who cannot read the document sees none');

select * from finish();
rollback;
