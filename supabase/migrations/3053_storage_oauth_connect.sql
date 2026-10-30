-- 3053_storage_oauth_connect.sql
-- B16 (RRR-240), parity gap G-274, Section 17 storage (S17-04), ADR 0155 D5: Google Drive and OneDrive/SharePoint
-- connect through OAuth 2.0 authorization code with PKCE S256 and refresh tokens, and their files are linked in place
-- on a document.
--   * app.begin_integration_oauth draws the state and the PKCE verifier for one person and one connection (10
--     minutes, single use); Atlas's callback reads them back with app.finish_integration_oauth, exchanges the code with
--     the provider and stores the refresh token in Vault as the connection's JSON credential
--     (app.store_integration_credential, 0600). Unknown states count against the person (10 in 15 minutes), and the
--     answer is a status row rather than an error, so the count is never rolled back (A69-001).
--   * The connection is one Admin's provider account. An Admin chooses a linking folder (provider_settings.link_root_id,
--     and drive_id for OneDrive), and only connections that have one are offered for linking: storage-browse lists only
--     that folder and what is inside it, so a document writer never browses the Admin's own files.
--   * app.authorize_storage_link is the check storage-browse runs as the person before any credential is read: write
--     access to the document (the 0625 rule) and a Connected, linkable connection of the document's org.
--   * Readers cannot see integration_connections (org.integrations.manage, 0600), so app.document_file_links lists a
--     document's linked files with their provider for anyone who can read the document.

-- OAuth states ------------------------------------------------------------------------------------------------------

create table private.integration_oauth_states (
  state_hash bytea primary key,
  integration_connection_id uuid not null references app.integration_connections (id),
  person_id uuid not null references app.people (id),
  code_verifier text not null,
  redirect_uri text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint integration_oauth_states_hash_length check (octet_length(state_hash) = 32),
  constraint integration_oauth_states_verifier check (code_verifier ~ '^[A-Za-z0-9._~-]{43,128}$'),
  constraint integration_oauth_states_redirect check (char_length(redirect_uri) <= 2000 and redirect_uri !~ '#')
);

create index integration_oauth_states_connection_idx on private.integration_oauth_states (integration_connection_id);
create index integration_oauth_states_person_idx on private.integration_oauth_states (person_id);

alter table private.integration_oauth_states enable row level security;
revoke all on private.integration_oauth_states from public, anon, authenticated;
-- The read-only backup login reads it like every relation (1650): a verifier is single-use, expires in 10 minutes and
-- is worthless without the provider's code, which never reaches the database.

comment on table private.integration_oauth_states is 'Pending OAuth authorizations of storage connections (3053, ADR 0155 D5): the state Atlas sent the provider, by hash, with the PKCE verifier and redirect URI, bound to one person and one connection, valid 10 minutes and used once. Read only through app.finish_integration_oauth; a row a day past its expiry is deleted when the next authorization starts.';
comment on column private.integration_oauth_states.state_hash is 'SHA-256 of the state parameter; the state itself is never stored.';
comment on column private.integration_oauth_states.integration_connection_id is 'Storage connection being connected.';
comment on column private.integration_oauth_states.person_id is 'Admin who started it and alone may finish it.';
comment on column private.integration_oauth_states.code_verifier is 'PKCE verifier (RFC 7636) sent with the code exchange; its S256 challenge went to the provider.';
comment on column private.integration_oauth_states.redirect_uri is 'Redirect URI the authorization used, sent again with the code exchange.';
comment on column private.integration_oauth_states.expires_at is 'Ten minutes after it was drawn.';
comment on column private.integration_oauth_states.used_at is 'When the callback used it; a used state never works again.';
comment on column private.integration_oauth_states.created_at is 'When it was drawn.';

create or replace function private.base64url(p_bytes bytea)
returns text
language sql
immutable
set search_path = ''
as $$
  select rtrim(translate(encode(p_bytes, 'base64'), E'+/\n', '-_'), '=');
$$;

comment on function private.base64url(bytea) is 'Base64url without padding (RFC 4648 section 5), as OAuth states and PKCE use it.';
revoke all on function private.base64url(bytea) from public, anon, authenticated;

create or replace function app.begin_integration_oauth(p_connection_id uuid, p_redirect_uri text)
returns table (state text, code_challenge text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_connection app.integration_connections;
  v_state text := private.base64url(extensions.gen_random_bytes(32));
  v_verifier text := private.base64url(extensions.gen_random_bytes(32));
begin
  perform private.require_read_write();
  select * into v_connection from app.integration_connections c where c.id = p_connection_id and c.deleted_at is null;
  perform private.authorize_integration_manage(v_connection.org_id);
  if private.api_key_scopes() is not null then
    raise exception using errcode = '42501', message = 'a storage account is connected from the person''s own session';
  end if;
  if v_connection.provider_code not in ('google_drive', 'onedrive_sharepoint') then
    perform private.refuse('integration_oauth_unsupported', 'This provider connects with a pasted credential, not with a sign-in.');
  end if;
  if v_connection.connection_state = 'Disconnected' then
    perform private.refuse('integration_disconnected', 'A disconnected connection is kept for its history and cannot change.');
  end if;
  if p_redirect_uri is null or char_length(p_redirect_uri) > 2000 or p_redirect_uri ~ '#'
     or not (p_redirect_uri ~ '^https://[^/?#\s]+/' or p_redirect_uri ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]+)?/') then
    perform private.refuse('integration_oauth_redirect', 'The callback is an https address of this XOS.');
  end if;
  -- The person's earlier state for the connection, and anyone's a day past its expiry, go.
  delete from private.integration_oauth_states s
  where (s.integration_connection_id = p_connection_id and s.person_id = v_me) or s.expires_at < now() - interval '1 day';
  insert into private.integration_oauth_states (state_hash, integration_connection_id, person_id, code_verifier, redirect_uri, expires_at)
  values (pg_catalog.sha256(convert_to(v_state, 'UTF8')), p_connection_id, v_me, v_verifier, p_redirect_uri, now() + interval '10 minutes');
  return query select v_state, private.base64url(pg_catalog.sha256(convert_to(v_verifier, 'UTF8')));
end;
$$;

comment on function app.begin_integration_oauth(uuid, text) is 'Starts connecting a Google Drive or OneDrive connection (3053): needs org.integrations.manage from the person''s own session, a provider that signs in (integration_oauth_unsupported otherwise), a connection that is not Disconnected and an https callback. Replaces the person''s earlier state for the connection and returns a new state and the PKCE S256 challenge of a verifier only the callback reads back. The state lives 10 minutes.';
revoke all on function app.begin_integration_oauth(uuid, text) from public, anon;
grant execute on function app.begin_integration_oauth(uuid, text) to authenticated;

create or replace function app.finish_integration_oauth(p_state text)
returns table (status text, connection_id uuid, provider_code text, code_verifier text, redirect_uri text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_row private.integration_oauth_states;
  v_provider text;
begin
  perform private.require_read_write();
  if private.rate_limit_exceeded('integration_oauth.failure', v_me::text, 10, interval '15 minutes') then
    return query select 'rate_limited'::text, null::uuid, null::text, null::text, null::text;
    return;
  end if;
  select * into v_row from private.integration_oauth_states s
  where s.state_hash = pg_catalog.sha256(convert_to(coalesce(p_state, ''), 'UTF8')) for update;
  if v_row.state_hash is null or v_row.person_id <> v_me or v_row.used_at is not null or v_row.expires_at <= now() then
    perform private.note_rate_event('integration_oauth.failure', v_me::text);
    return query select 'invalid'::text, null::uuid, null::text, null::text, null::text;
    return;
  end if;
  select c.provider_code into v_provider from app.integration_connections c
  where c.id = v_row.integration_connection_id and c.deleted_at is null;
  perform private.authorize_integration_manage((select c.org_id from app.integration_connections c where c.id = v_row.integration_connection_id));
  update private.integration_oauth_states set used_at = now() where state_hash = v_row.state_hash;
  return query select 'ok'::text, v_row.integration_connection_id, v_provider, v_row.code_verifier, v_row.redirect_uri;
end;
$$;

comment on function app.finish_integration_oauth(text) is 'The OAuth callback of a storage connection (3053): the person who started it, while it is unused and unexpired, uses the state once and gets back the connection, its provider, the PKCE verifier and the redirect URI. Answers status invalid for an unknown, used, expired or another person''s state, counting it (10 per person in 15 minutes, then rate_limited), as a row rather than an error so the count holds. Refuses a read-only transaction first.';
revoke all on function app.finish_integration_oauth(text) from public, anon;
grant execute on function app.finish_integration_oauth(text) to authenticated;

-- Linking -----------------------------------------------------------------------------------------------------------

create or replace function private.storage_connection_linkable(p_connection app.integration_connections)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_connection.id is not null and p_connection.deleted_at is null and p_connection.connection_state = 'Connected'
    and p_connection.provider_code in ('google_drive', 'onedrive_sharepoint')
    and coalesce(p_connection.provider_settings ->> 'link_root_id', '') <> ''
    and (p_connection.provider_code <> 'onedrive_sharepoint' or coalesce(p_connection.provider_settings ->> 'drive_id', '') <> '');
$$;

comment on function private.storage_connection_linkable(app.integration_connections) is 'Whether document writers may link files from a connection: a Connected Google Drive or OneDrive connection whose Admin chose a linking folder (provider_settings.link_root_id, and drive_id for OneDrive).';
revoke all on function private.storage_connection_linkable(app.integration_connections) from public, anon, authenticated;

create or replace function private.can_write_document(p_document_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.documents d
    where d.id = p_document_id and d.deleted_at is null
      and ((d.project_id is null and d.org_id in (select private.orgs_with_capability('knowledge.document.write')))
        or d.project_id in (select private.project_ids_with('knowledge.document.write'))));
$$;

comment on function private.can_write_document(uuid) is 'Whether the caller may write a document, by the rule of app.integration_file_links'' write policy (0625): knowledge.document.write in the org for an org document, or in its project.';
revoke all on function private.can_write_document(uuid) from public, anon, authenticated;

create or replace function app.storage_connections_for_linking(p_org_id uuid)
returns table (connection_id uuid, provider_code text, display_name text, external_account_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.provider_code, c.display_name, c.external_account_name
  from app.integration_connections c
  where c.org_id = p_org_id and private.storage_connection_linkable(c)
    and (p_org_id in (select private.orgs_with_capability('knowledge.document.write'))
      or exists (select 1 from app.projects p where p.org_id = p_org_id
                 and p.id in (select private.project_ids_with('knowledge.document.write'))))
  order by c.display_name;
$$;

comment on function app.storage_connections_for_linking(uuid) is 'The storage connections a document writer may link files from (the Link a file drawer, 3053): Connected Google Drive and OneDrive connections with a linking folder, for a caller who holds knowledge.document.write in the org or in one of its projects. Names only, never settings or credentials.';
revoke all on function app.storage_connections_for_linking(uuid) from public, anon;
grant execute on function app.storage_connections_for_linking(uuid) to authenticated;

create or replace function app.authorize_storage_link(p_connection_id uuid, p_document_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_connection app.integration_connections;
begin
  if not private.can_write_document(p_document_id) then
    raise exception using errcode = '42501', message = 'knowledge.document.write on the document is required';
  end if;
  select * into v_connection from app.integration_connections c where c.id = p_connection_id and c.deleted_at is null;
  if v_connection.id is null or v_connection.org_id <> (select d.org_id from app.documents d where d.id = p_document_id) then
    raise exception using errcode = '42501', message = 'the connection is not in the document''s organization';
  end if;
  if v_connection.provider_code not in ('google_drive', 'onedrive_sharepoint') then
    perform private.refuse('integration_oauth_unsupported', 'Files are linked in place from Google Drive or OneDrive.');
  end if;
  if v_connection.connection_state <> 'Connected' then
    perform private.refuse('integration_not_connected', 'Link files from a Connected storage connection.');
  end if;
  if not private.storage_connection_linkable(v_connection) then
    perform private.refuse('storage_link_folder_missing', 'An Admin has not chosen the folder files are linked from. Ask one to choose it in Settings, Integrations.');
  end if;
end;
$$;

comment on function app.authorize_storage_link(uuid, uuid) is 'The check storage-browse runs as the person before it reads any credential (3053): the caller can write the document (42501 otherwise), and the connection is in the document''s org (42501), a Google Drive or OneDrive connection (integration_oauth_unsupported), Connected (integration_not_connected) and has a linking folder (storage_link_folder_missing).';
revoke all on function app.authorize_storage_link(uuid, uuid) from public, anon;
grant execute on function app.authorize_storage_link(uuid, uuid) to authenticated;

create or replace function app.authorize_storage_admin(p_connection_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_connection app.integration_connections;
begin
  select * into v_connection from app.integration_connections c where c.id = p_connection_id and c.deleted_at is null;
  if v_connection.id is null or private.current_person_id() is null
     or not private.has_capability(v_connection.org_id, 'org.integrations.manage') then
    raise exception using errcode = '42501', message = 'org.integrations.manage is required';
  end if;
  if v_connection.provider_code not in ('google_drive', 'onedrive_sharepoint') then
    perform private.refuse('integration_oauth_unsupported', 'Files are linked in place from Google Drive or OneDrive.');
  end if;
  if v_connection.connection_state <> 'Connected' then
    perform private.refuse('integration_not_connected', 'Link files from a Connected storage connection.');
  end if;
end;
$$;

comment on function app.authorize_storage_admin(uuid) is 'The check storage-browse runs before an Admin browses a connection''s whole account to choose its linking folder (3053): org.integrations.manage in the connection''s org (42501 otherwise) on a Connected Google Drive or OneDrive connection.';
revoke all on function app.authorize_storage_admin(uuid) from public, anon;
grant execute on function app.authorize_storage_admin(uuid) to authenticated;

create or replace function app.document_file_links(p_document_id uuid)
returns table (
  link_id uuid,
  provider_code text,
  link_mode app.file_link_mode,
  file_name text,
  mime_type text,
  size_bytes bigint,
  web_url text,
  external_modified_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select l.id, c.provider_code, l.link_mode, l.file_name, l.mime_type, l.size_bytes, l.web_url, l.external_modified_at, l.created_at
  from app.integration_file_links l
  join app.integration_connections c on c.id = l.integration_connection_id
  join app.documents d on d.id = l.document_id and d.deleted_at is null
  where l.document_id = p_document_id and l.deleted_at is null
    and ((d.project_id is null and d.org_id in (select private.orgs_with_capability('knowledge.document.read')))
      or d.project_id in (select private.project_ids_with('knowledge.document.read')))
  order by l.created_at;
$$;

comment on function app.document_file_links(uuid) is 'A document''s linked provider files for anyone who can read the document (the 0625 read rule): name, type, size, link, provider modified time and the provider code for its icon, which readers could not read from app.integration_connections.';
revoke all on function app.document_file_links(uuid) from public, anon;
grant execute on function app.document_file_links(uuid) to authenticated;
