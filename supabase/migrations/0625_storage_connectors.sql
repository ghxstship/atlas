-- 0625_storage_connectors.sql
-- A19 Integrations. Storage connectors (Section 17: Google Drive, Microsoft OneDrive and SharePoint, Dropbox; document
-- links and import):
--   * app.integration_file_links: a provider file linked to an XOS document, either as a live link or imported
--   * imports go through A18's attachments (0590): the runner starts an attachment upload on the document, stores the
--     bytes at the issued object name and completes the upload, so every imported file is virus-scanned and becomes a
--     document version only once it scans Clean (Section 9 file uploads)
-- Who may link follows the document: write access to the document (knowledge.document.write, invariant 2).

create type app.file_link_mode as enum ('Link', 'Import');
comment on type app.file_link_mode is 'How a provider file is attached to a document: a live link to the provider, or imported as document versions.';

create table app.integration_file_links (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  integration_connection_id uuid not null references app.integration_connections (id),
  document_id uuid not null references app.documents (id),
  link_mode app.file_link_mode not null default 'Link',
  external_file_id text not null,
  file_name text not null,
  mime_type text,
  size_bytes bigint,
  web_url text,
  external_version text,
  external_modified_at timestamptz,
  attachment_id uuid references app.attachments (id),
  last_attachment_version_id uuid references app.attachment_versions (id),
  imported_version text,
  last_imported_at timestamptz,
  deleted_at timestamptz,
  constraint integration_file_links_external_length check (char_length(external_file_id) between 1 and 500),
  constraint integration_file_links_name_length check (char_length(btrim(file_name)) between 1 and 255),
  constraint integration_file_links_size check (size_bytes is null or size_bytes >= 0),
  constraint integration_file_links_url check (web_url is null or web_url ~ '^https://'),
  constraint integration_file_links_import_pair check ((imported_version is null) = (last_imported_at is null))
);

create index integration_file_links_connection_idx on app.integration_file_links (integration_connection_id);
create index integration_file_links_document_id_idx on app.integration_file_links (document_id);
create index integration_file_links_attachment_id_idx on app.integration_file_links (attachment_id);
create index integration_file_links_attachment_version_idx on app.integration_file_links (last_attachment_version_id);
create unique index integration_file_links_file_key on app.integration_file_links (integration_connection_id, external_file_id, document_id)
  where deleted_at is null;

call private.install_domain_table('app.integration_file_links', 'app.integration_connections', 'integration_connection_id',
  array['app.documents', 'document_id', 'app.attachments', 'attachment_id', 'app.attachment_versions', 'last_attachment_version_id']);
call private.describe('app.integration_file_links', 'Provider files attached to XOS documents (Section 17 storage: document links and import). A Link keeps the provider''s URL and metadata current; an Import also copies the file into the document through the scanned attachment pipeline whenever the provider version changes.', array[
  'integration_connection_id', 'Storage connection the file lives in.',
  'document_id', 'XOS document the file is attached to.',
  'link_mode', 'Link or Import.',
  'external_file_id', 'Provider file identifier.',
  'file_name', 'File name as the provider reports it.',
  'mime_type', 'MIME type as the provider reports it.',
  'size_bytes', 'Size in bytes as the provider reports it.',
  'web_url', 'HTTPS link that opens the file at the provider.',
  'external_version', 'Provider revision, ETag or content hash last seen.',
  'external_modified_at', 'When the provider last changed the file.',
  'attachment_id', 'Attachment on the document that imported versions belong to. Set by the runner.',
  'last_attachment_version_id', 'Attachment version of the latest import, which becomes a document version once it scans Clean.',
  'imported_version', 'Provider revision of the latest import.',
  'last_imported_at', 'When the latest import was handed to scanning.'
]);

call private.install_policies('app.integration_file_links',
  $$document_id in (select d.id from app.documents d where (d.project_id is null and d.org_id in (select private.orgs_with_capability('knowledge.document.read')))
    or d.project_id in (select private.project_ids_with('knowledge.document.read')))$$,
  $$document_id in (select d.id from app.documents d where (d.project_id is null and d.org_id in (select private.orgs_with_capability('knowledge.document.write')))
    or d.project_id in (select private.project_ids_with('knowledge.document.write')))$$);

create or replace function private.guard_integration_file_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if (select c.connection_state from app.integration_connections c where c.id = new.integration_connection_id) <> 'Connected' then
      perform private.refuse('integration_not_connected', 'Link files from a Connected storage connection.');
    end if;
    if not private.in_trusted_operation('integration_file_import') then
      new.attachment_id := null;
      new.last_attachment_version_id := null;
      new.imported_version := null;
      new.last_imported_at := null;
    end if;
    return new;
  end if;
  if new.external_file_id <> old.external_file_id or new.document_id <> old.document_id then
    perform private.refuse('file_link_fixed', 'A file link keeps its file and document; link the other file separately.');
  end if;
  if not private.in_trusted_operation('integration_file_import')
     and (new.attachment_id is distinct from old.attachment_id
       or new.last_attachment_version_id is distinct from old.last_attachment_version_id
       or new.imported_version is distinct from old.imported_version
       or new.last_imported_at is distinct from old.last_imported_at) then
    perform private.refuse('file_import_runner_only', 'Import details are written only by the integration runner.');
  end if;
  return new;
end;
$$;

comment on function private.guard_integration_file_link() is 'File links: created only on a Connected connection, keep their file and document, and only the runner writes import details.';

create trigger t40_guard_integration_file_link before insert or update on app.integration_file_links
  for each row execute function private.guard_integration_file_link();
create trigger t41_guard_integration_file_link_category before insert or update of integration_connection_id on app.integration_file_links
  for each row execute function private.guard_integration_category('Storage');

-- Runner RPCs ----------------------------------------------------------------------------------------------------------

create or replace function app.refresh_file_link(
  p_link_id uuid,
  p_file_name text,
  p_mime_type text,
  p_size_bytes bigint,
  p_web_url text,
  p_external_version text,
  p_external_modified_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update app.integration_file_links
  set file_name = left(btrim(p_file_name), 255), mime_type = p_mime_type, size_bytes = p_size_bytes, web_url = p_web_url,
      external_version = p_external_version, external_modified_at = p_external_modified_at
  where id = p_link_id and deleted_at is null;
  if not found then
    perform private.refuse('file_link_unknown', 'The file link does not exist or was removed.');
  end if;
end;
$$;

comment on function app.refresh_file_link(uuid, text, text, bigint, text, text, timestamptz) is 'Runner: refreshes a file link''s name, type, size, URL and provider revision. Service role only.';

create or replace function app.begin_file_import(p_link_id uuid)
returns table (attachment_id uuid, attachment_version_id uuid, object_name text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_link app.integration_file_links;
  v_started record;
begin
  select * into v_link from app.integration_file_links l where l.id = p_link_id and l.deleted_at is null for update;
  if v_link.id is null then
    perform private.refuse('file_link_unknown', 'The file link does not exist or was removed.');
  end if;
  if v_link.link_mode <> 'Import' then
    perform private.refuse('file_link_not_import', 'Only an Import link copies the file into XOS.');
  end if;
  if v_link.mime_type is null or v_link.size_bytes is null then
    perform private.refuse('file_import_metadata', 'Refresh the link so its type and size are known before importing.');
  end if;
  select * into v_started
  from app.begin_attachment_upload('app.documents', v_link.document_id, v_link.file_name, v_link.mime_type, v_link.size_bytes, v_link.attachment_id);
  perform private.begin_trusted_operation('integration_file_import');
  update app.integration_file_links set attachment_id = v_started.attachment_id, last_attachment_version_id = v_started.attachment_version_id
  where id = p_link_id;
  perform private.end_trusted_operation('integration_file_import');
  return query select v_started.attachment_id, v_started.attachment_version_id, v_started.object_name;
end;
$$;

comment on function app.begin_file_import(uuid) is 'Runner: starts importing an Import link''s file as a new version of the document''s attachment (A18 attachments checks type and size) and returns the object name to store the bytes at. Service role only.';

create or replace function app.finish_file_import(p_link_id uuid, p_checksum_sha256 text, p_imported_version text)
returns app.scan_status
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_link app.integration_file_links;
  v_status app.scan_status;
begin
  select * into v_link from app.integration_file_links l where l.id = p_link_id and l.deleted_at is null for update;
  if v_link.last_attachment_version_id is null then
    perform private.refuse('file_import_not_started', 'Start the import before finishing it.');
  end if;
  v_status := app.complete_attachment_upload(v_link.last_attachment_version_id, p_checksum_sha256);
  perform private.begin_trusted_operation('integration_file_import');
  update app.integration_file_links set imported_version = coalesce(p_imported_version, external_version, p_checksum_sha256), last_imported_at = now()
  where id = p_link_id;
  perform private.end_trusted_operation('integration_file_import');
  return v_status;
end;
$$;

comment on function app.finish_file_import(uuid, text, text) is 'Runner: completes the attachment upload of an import (the stored object must match the declared size), which queues the virus scan, and records the imported provider revision. Service role only.';

revoke all on function private.guard_integration_file_link() from public, anon, authenticated;
revoke all on function app.refresh_file_link(uuid, text, text, bigint, text, text, timestamptz) from public, anon, authenticated;
revoke all on function app.begin_file_import(uuid) from public, anon, authenticated;
revoke all on function app.finish_file_import(uuid, text, text) from public, anon, authenticated;
grant execute on function app.refresh_file_link(uuid, text, text, bigint, text, text, timestamptz) to service_role;
grant execute on function app.begin_file_import(uuid) to service_role;
grant execute on function app.finish_file_import(uuid, text, text) to service_role;

call private.install_default_retention('app.integration_file_links');
