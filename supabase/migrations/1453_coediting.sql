-- 1453_coediting.sql
-- A88 (RRR-133, A65-006, ADR 0044). Live co-editing (Section 5: "Tiptap editor with Yjs; updates broadcast over
-- Supabase Realtime and persisted as snapshots in Postgres"; Section 7.3: doc_snapshots and doc_updates, presence
-- ephemeral in Realtime and never stored).
--
--   * app.doc_snapshots: one Yjs document per row and field (an SOP's procedure, a document's notes): the merged
--     state, the sequence it covers, a plain text projection, and a generation that changes when the document is
--     reseeded from its row.
--   * app.doc_updates: the Yjs updates since the snapshot, numbered per document. Editors broadcast each update over
--     a private Realtime channel for speed and append it here for recovery: a client that reconnects reads what it
--     missed, and a new client loads snapshot plus updates.
--   * Compaction folds updates into the snapshot. For a field with a column (sops.body) it also writes the text into
--     the row, through the row's own triggers, so readers, search and publishing see the current text.
--   * When the row's text changed outside the editor (a form, the API), opening the document reseeds it from the row
--     in a new generation; editors on the old generation are refused and reload, so nothing is merged into the wrong
--     base silently.
--   * Who may read or write a document follows the row it belongs to: its table's own read and update policies,
--     evaluated for the caller. The same checks authorize the Realtime channel `doc:<doc id>` (realtime.messages
--     policies), for broadcasts and presence alike.

-- Registry -----------------------------------------------------------------------------------------------------------

create table private.coedit_subjects (
  table_name text not null,
  doc_key text not null,
  text_column text,
  primary key (table_name, doc_key),
  constraint coedit_subjects_table_format check (table_name ~ '^app\.[a-z][a-z0-9_]*$'),
  constraint coedit_subjects_key_format check (doc_key ~ '^[a-z][a-z0-9_]{0,31}$'),
  constraint coedit_subjects_column_format check (text_column is null or text_column ~ '^[a-z][a-z0-9_]*$')
);

comment on table private.coedit_subjects is 'Fields edited together live (Section 5): a table and a document key, and the text column compaction writes back to, when the field has one.';
comment on column private.coedit_subjects.table_name is 'Schema-qualified table the edited rows belong to.';
comment on column private.coedit_subjects.doc_key is 'Which document of a row, for example body or notes.';
comment on column private.coedit_subjects.text_column is 'Column that holds the field''s text; NULL when the document lives only in its snapshots.';

alter table private.coedit_subjects enable row level security;
revoke all on private.coedit_subjects from public, anon, authenticated;
grant select on private.coedit_subjects to service_role;

insert into private.coedit_subjects (table_name, doc_key, text_column) values
  ('app.sops', 'body', 'body'),
  ('app.documents', 'notes', null);

-- Row access, from the row's own policies ------------------------------------------------------------------------------

create or replace function private.caller_writes_row(p_table text, p_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_relid oid := p_table::regclass;
  v_permissive text;
  v_restrictive text;
  v_found boolean;
begin
  select string_agg('(' || pg_catalog.pg_get_expr(p.polqual, p.polrelid) || ')', ' or ')
    filter (where p.polpermissive),
         string_agg('(' || pg_catalog.pg_get_expr(p.polqual, p.polrelid) || ')', ' and ')
    filter (where not p.polpermissive)
    into v_permissive, v_restrictive
  from pg_catalog.pg_policy p
  where p.polrelid = v_relid and p.polcmd in ('w', '*') and p.polqual is not null
    and (0::oid = any (p.polroles) or 'authenticated'::regrole = any (p.polroles));
  if v_permissive is null then
    return false;
  end if;
  execute format('select exists (select 1 from %s where id = $1 and deleted_at is null and (%s)%s)',
    v_relid::regclass, v_permissive, case when v_restrictive is null then '' else ' and (' || v_restrictive || ')' end)
    into v_found using p_id;
  return coalesce(v_found, false) and private.caller_reads_row(p_table, p_id);
end;
$$;

comment on function private.caller_writes_row(text, uuid) is 'Whether the signed-in caller may change one live row: the table''s update policies (USING) read from the catalog and evaluated for the caller, as row level security would, and its read policies.';
revoke all on function private.caller_writes_row(text, uuid) from public, anon, authenticated;

-- Tables -------------------------------------------------------------------------------------------------------------

create table app.doc_snapshots (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  subject_table text not null,
  subject_id uuid not null,
  doc_key text not null,
  generation integer not null default 1,
  state bytea,
  through_seq bigint not null default 0,
  last_seq bigint not null default 0,
  text_snapshot text,
  base_updated_at timestamptz,
  deleted_at timestamptz,
  constraint doc_snapshots_subject_fkey foreign key (subject_table, doc_key)
    references private.coedit_subjects (table_name, doc_key),
  constraint doc_snapshots_generation_positive check (generation > 0),
  constraint doc_snapshots_seq_order check (through_seq >= 0 and last_seq >= through_seq),
  constraint doc_snapshots_state_size check (state is null or octet_length(state) <= 8388608),
  constraint doc_snapshots_text_size check (text_snapshot is null or char_length(text_snapshot) <= 200000)
);

create unique index doc_snapshots_subject_key on app.doc_snapshots (subject_table, subject_id, doc_key);
create index doc_snapshots_field_idx on app.doc_snapshots (subject_table, doc_key);

call private.install_domain_table('app.doc_snapshots');
call private.describe('app.doc_snapshots', 'One live co-edited document per row and field (Section 5, Section 7.3): the merged Yjs state, the update sequence it covers and a plain text projection. Readable by whoever can read the row it belongs to; written only through app.open_doc, app.append_doc_update and app.compact_doc.', array[
  'subject_table', 'Table of the row the document belongs to.',
  'subject_id', 'Row the document belongs to.',
  'doc_key', 'Which document of the row, for example body.',
  'generation', 'Raised when the document is reseeded from its row after the row''s text changed outside the editor; updates of an older generation are refused.',
  'state', 'Merged Yjs state (an encoded update) covering every update up to through_seq; NULL before the first compaction.',
  'through_seq', 'Highest update sequence folded into state.',
  'last_seq', 'Highest update sequence issued for the document.',
  'text_snapshot', 'Plain text of the document at the last compaction, or the row''s text it was seeded from.',
  'base_updated_at', 'The row''s updated_at when the editor last wrote its text into the row or seeded from it.'
]);

create table app.doc_updates (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  doc_id uuid not null references app.doc_snapshots (id),
  generation integer not null,
  seq bigint not null,
  yjs_update bytea not null,
  deleted_at timestamptz,
  constraint doc_updates_size check (octet_length(yjs_update) between 1 and 1048576),
  constraint doc_updates_seq_positive check (seq > 0)
);

create unique index doc_updates_doc_seq_key on app.doc_updates (doc_id, seq);

call private.install_domain_table('app.doc_updates', 'app.doc_snapshots', 'doc_id');
call private.describe('app.doc_updates', 'Yjs updates to a co-edited document since its snapshot, numbered per document, kept for recovery: a reconnecting editor reads what it missed. Compaction folds them into the snapshot and removes them.', array[
  'doc_id', 'Document the update belongs to.',
  'generation', 'Document generation the update was made against.',
  'seq', 'Update number within the document, issued by app.append_doc_update.',
  'yjs_update', 'Encoded Yjs update.'
]);

create or replace function private.coedit_can_read(p_doc_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.doc_snapshots d
    where d.id = p_doc_id and d.deleted_at is null and private.caller_reads_row(d.subject_table, d.subject_id));
$$;

comment on function private.coedit_can_read(uuid) is 'Whether the caller can read a co-edited document: they can read the row it belongs to.';

create or replace function private.coedit_can_write(p_doc_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.doc_snapshots d
    where d.id = p_doc_id and d.deleted_at is null and private.caller_writes_row(d.subject_table, d.subject_id));
$$;

comment on function private.coedit_can_write(uuid) is 'Whether the caller may edit a co-edited document: they may change the row it belongs to.';

revoke all on function private.coedit_can_read(uuid) from public, anon;
revoke all on function private.coedit_can_write(uuid) from public, anon;
grant execute on function private.coedit_can_read(uuid) to authenticated, service_role;
grant execute on function private.coedit_can_write(uuid) to authenticated, service_role;

call private.install_policies('app.doc_snapshots', $$private.coedit_can_read(id)$$);
call private.install_policies('app.doc_updates', $$private.coedit_can_read(doc_id)$$);
revoke insert, update, delete on app.doc_snapshots from authenticated;
revoke insert, update, delete on app.doc_updates from authenticated;

call private.install_default_retention('app.doc_snapshots');
call private.install_default_retention('app.doc_updates');

-- RPCs ---------------------------------------------------------------------------------------------------------------

create or replace function app.open_doc(p_subject_table text, p_subject_id uuid, p_doc_key text, p_since bigint default 0)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_subject private.coedit_subjects;
  v_doc app.doc_snapshots;
  v_row jsonb;
  v_text text;
  v_updated timestamptz;
  v_org uuid;
begin
  perform private.require_person();
  select * into v_subject from private.coedit_subjects s where s.table_name = p_subject_table and s.doc_key = p_doc_key;
  if v_subject.table_name is null then
    perform private.refuse('coedit_unavailable', 'This field is not edited live.');
  end if;
  if p_subject_id is null or not private.caller_reads_row(p_subject_table, p_subject_id) then
    raise exception using errcode = '42501', message = 'the row is not available to you';
  end if;
  execute format('select to_jsonb(t) from %s t where t.id = $1', p_subject_table::regclass) into v_row using p_subject_id;
  v_org := (v_row ->> 'org_id')::uuid;
  v_updated := (v_row ->> 'updated_at')::timestamptz;
  v_text := case when v_subject.text_column is null then null else v_row ->> v_subject.text_column end;

  insert into app.doc_snapshots (org_id, subject_table, subject_id, doc_key, text_snapshot, base_updated_at)
  values (v_org, p_subject_table, p_subject_id, p_doc_key, v_text, v_updated)
  on conflict (subject_table, subject_id, doc_key) do nothing;
  select * into v_doc from app.doc_snapshots d
  where d.subject_table = p_subject_table and d.subject_id = p_subject_id and d.doc_key = p_doc_key
  for update;

  -- The row's text changed outside the editor: start a new generation from it.
  -- Compaction keeps the column equal to text_snapshot, so a difference is a change made elsewhere.
  if v_subject.text_column is not null and v_text is distinct from v_doc.text_snapshot then
    delete from app.doc_updates u where u.doc_id = v_doc.id;
    update app.doc_snapshots d
    set generation = d.generation + 1, state = null, through_seq = d.last_seq,
        text_snapshot = v_text, base_updated_at = v_updated
    where d.id = v_doc.id
    returning * into v_doc;
  end if;

  return jsonb_build_object(
    'doc_id', v_doc.id,
    'generation', v_doc.generation,
    'state', case when v_doc.state is null then null else encode(v_doc.state, 'base64') end,
    'through_seq', v_doc.through_seq,
    'last_seq', v_doc.last_seq,
    'seed_text', v_doc.text_snapshot,
    'can_edit', private.caller_writes_row(p_subject_table, p_subject_id),
    'updates', coalesce((
      select jsonb_agg(jsonb_build_object('seq', u.seq, 'update', encode(u.yjs_update, 'base64')) order by u.seq)
      from app.doc_updates u
      where u.doc_id = v_doc.id and u.generation = v_doc.generation
        and u.seq > greatest(coalesce(p_since, 0), v_doc.through_seq)
    ), '[]'::jsonb));
end;
$$;

comment on function app.open_doc(text, uuid, text, bigint) is 'Opens the live document of a row''s field for someone who can read the row (Section 5): its id, generation, snapshot, the updates after it (or after p_since, for a reconnecting editor), the text to seed an empty document from and whether the caller may edit. Creates the document on first open, and reseeds it in a new generation when the row''s text changed outside the editor.';

create or replace function app.append_doc_update(p_doc_id uuid, p_generation integer, p_update text)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_doc app.doc_snapshots;
  v_bytes bytea;
begin
  perform private.require_person();
  if p_doc_id is null or not private.coedit_can_write(p_doc_id) then
    raise exception using errcode = '42501', message = 'editing this document needs write access to its row';
  end if;
  begin
    v_bytes := decode(p_update, 'base64');
  exception when others then
    perform private.refuse('coedit_update_malformed', 'The update is not valid base64.');
  end;
  if v_bytes is null or octet_length(v_bytes) = 0 or octet_length(v_bytes) > 1048576 then
    perform private.refuse('coedit_update_size', 'An update holds between 1 byte and 1 MB.');
  end if;
  select * into v_doc from app.doc_snapshots d where d.id = p_doc_id for update;
  if v_doc.generation <> p_generation then
    perform private.refuse('coedit_generation_changed', 'The document was reloaded from its row; open it again.');
  end if;
  update app.doc_snapshots d set last_seq = d.last_seq + 1 where d.id = p_doc_id returning * into v_doc;
  insert into app.doc_updates (doc_id, generation, seq, yjs_update)
  values (p_doc_id, v_doc.generation, v_doc.last_seq, v_bytes);
  return v_doc.last_seq;
end;
$$;

comment on function app.append_doc_update(uuid, integer, text) is 'Appends one Yjs update (base64, at most 1 MB) to a live document for someone who may change its row, and returns its sequence number. Refused when the document moved to a new generation.';

create or replace function app.compact_doc(p_doc_id uuid, p_generation integer, p_state text, p_through bigint, p_text text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_doc app.doc_snapshots;
  v_subject private.coedit_subjects;
  v_state bytea;
  v_updated timestamptz;
begin
  perform private.require_person();
  if p_doc_id is null or not private.coedit_can_write(p_doc_id) then
    raise exception using errcode = '42501', message = 'editing this document needs write access to its row';
  end if;
  select * into v_doc from app.doc_snapshots d where d.id = p_doc_id for update;
  if v_doc.generation <> p_generation then
    perform private.refuse('coedit_generation_changed', 'The document was reloaded from its row; open it again.');
  end if;
  if p_through is null or p_through > v_doc.last_seq then
    perform private.refuse('coedit_through_unknown', 'The snapshot names an update the document never issued.');
  end if;
  if p_through <= v_doc.through_seq then
    -- Someone compacted further already; nothing to do.
    return jsonb_build_object('compacted', false, 'through_seq', v_doc.through_seq);
  end if;
  begin
    v_state := decode(p_state, 'base64');
  exception when others then
    perform private.refuse('coedit_update_malformed', 'The snapshot is not valid base64.');
  end;
  if p_text is not null and char_length(p_text) > 200000 then
    perform private.refuse('coedit_text_size', 'A live document holds at most 200,000 characters.');
  end if;

  select * into v_subject from private.coedit_subjects s
  where s.table_name = v_doc.subject_table and s.doc_key = v_doc.doc_key;
  v_updated := v_doc.base_updated_at;
  if v_subject.text_column is not null and p_text is not null then
    -- The row's own triggers and checks apply to the text, as they do to a save from a form.
    execute format('update %s set %I = $1 where id = $2 and %I is distinct from $1 returning updated_at',
      v_doc.subject_table::regclass, v_subject.text_column, v_subject.text_column)
      into v_updated using p_text, v_doc.subject_id;
    if v_updated is null then
      v_updated := v_doc.base_updated_at;
    end if;
  end if;

  update app.doc_snapshots d
  set state = v_state, through_seq = p_through, text_snapshot = coalesce(p_text, d.text_snapshot),
      base_updated_at = v_updated
  where d.id = p_doc_id;
  delete from app.doc_updates u where u.doc_id = p_doc_id and u.seq <= p_through;
  return jsonb_build_object('compacted', true, 'through_seq', p_through);
end;
$$;

comment on function app.compact_doc(uuid, integer, text, bigint, text) is 'Folds a live document''s updates up to p_through into a new snapshot (base64 Yjs state) for someone who may change its row, removes them, stores the plain text, and writes the text into the row''s column when the field has one (sops.body), through the row''s own triggers.';

revoke all on function app.open_doc(text, uuid, text, bigint) from public, anon;
revoke all on function app.append_doc_update(uuid, integer, text) from public, anon;
revoke all on function app.compact_doc(uuid, integer, text, bigint, text) from public, anon;
grant execute on function app.open_doc(text, uuid, text, bigint) to authenticated, service_role;
grant execute on function app.append_doc_update(uuid, integer, text) to authenticated, service_role;
grant execute on function app.compact_doc(uuid, integer, text, bigint, text) to authenticated, service_role;

-- Realtime authorization for the document channels ------------------------------------------------------------------
-- Editors join the private channel doc:<doc id>. Receiving broadcasts and presence needs read access to the row,
-- sending them needs write access (presence of a reader is sent too, so readers may track themselves). The
-- realtime.messages table belongs to Supabase Realtime; on a database without it there is nothing to authorize.

do $$
begin
  if to_regclass('realtime.messages') is null then
    return;
  end if;
  execute $policy$
    create policy xos_doc_channel_read on realtime.messages for select to authenticated
    using (
      realtime.messages.extension in ('broadcast', 'presence')
      and (select realtime.topic()) ~ '^doc:[0-9a-f-]{36}$'
      and private.coedit_can_read(substr((select realtime.topic()), 5)::uuid)
    )
  $policy$;
  execute $policy$
    create policy xos_doc_channel_write on realtime.messages for insert to authenticated
    with check (
      (select realtime.topic()) ~ '^doc:[0-9a-f-]{36}$'
      and (
        (realtime.messages.extension = 'broadcast' and private.coedit_can_write(substr((select realtime.topic()), 5)::uuid))
        or (realtime.messages.extension = 'presence' and private.coedit_can_read(substr((select realtime.topic()), 5)::uuid))
      )
    )
  $policy$;
end;
$$;
