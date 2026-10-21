-- 1440_global_search.sql
-- A87 (RRR-132), finding A65-005, Section 11.7 Search, Section 11.10 item 1, Section 5 (pgvector over documents and
-- SOPs). One search over records, incidents, people, documents, SOPs and handbook articles, the last 50 records each
-- person viewed, and semantic search over documents and SOPs blended into the same results.
--
--   * app.global_search(org, query, embedding, limit, min_similarity): SECURITY INVOKER, so every row is read
--     under the caller's own row level security and nothing widens what they may see. The query is the structured
--     request @xos/data builds from the operator grammar (packages/data/src/search-query.ts), never raw text:
--     words (each also a prefix) and quoted phrases, minus exclusions, and the filters type (result type or
--     record kind), project, assignee, status, phase, urid, dept, is, before, after and due. Dates arrive as a
--     calendar date or days from today and resolve on the org's calendar (its locale.time_zone, A71), never UTC.
--     Ranking: text relevance (ts_rank_cd over a 'simple' tsvector, title weighted above body) times a recency
--     factor (45-day decay on the date the item last changed); a record or incident key such as NWL-12 ranks
--     first. With an embedding and the org's search.semantic_enabled on, the nearest documents, SOPs and handbook
--     articles above the similarity floor join the lexical ones and their scores blend.
--   * GIN indexes on exactly the expressions the search reads, and a newest-first records index for filter-only
--     queries, so a search uses index scans on every table it touches (EXPLAIN on the seed in the A87 report).
--   * app.recent_views: the records, incidents, documents, SOPs and handbook articles a person opened, once each,
--     newest first. app.record_recent_view (invoker: only something the person can read is recorded) keeps at most
--     50 per person and org; rows go after 90 days, and all of a person's rows go when the person is deleted.
--     app.recent_items lists them before anything is typed, again under the caller's row level security.
--   * app.search_embeddings: one pgvector embedding (1024 dimensions) per published document, SOP and handbook
--     article of an org with search.semantic_enabled on. The worker (packages/data/src/search-embeddings.ts, the
--     search-embed Edge Function) fills it through the embedding provider seam in @xos/ai with the service role:
--     app.search_embedding_backlog hands it the text to embed, built only from columns no classification marks
--     Restricted and never from a table excluded from AI features; app.store_search_embedding stores a vector only
--     while the text it was made from is still current and the org still has semantic search on;
--     app.retire_search_embeddings deletes the vectors of sources that are gone, unpublished or in an org that
--     turned semantic search off. A person reads an embedding only when they can read its source.
--   * search.semantic_enabled (packages/schemas/settings/a87.yaml): off by default, set by an Admin on Settings,
--     AI features. Choosing the embedding provider is an owner decision (a new subprocessor).

select private.define_setting('search.semantic_enabled', 'Boolean', 'org.ai.write', array['organization'], false, p_default_boolean => false);

-- Lexical indexes ---------------------------------------------------------------------------------------------------
-- The search builds one 'simple' tsquery, so every searched text is indexed with the 'simple' configuration: no
-- stemming, so a typed prefix (instal) matches the stored word (installation) in every language the org writes in.

create index if not exists records_title_search_idx on app.records using gin (to_tsvector('simple', title));
create index if not exists records_org_updated_idx on app.records (org_id, updated_at desc) where deleted_at is null;
create index if not exists incidents_title_search_idx on app.incidents using gin (to_tsvector('simple', title));
create index if not exists incidents_org_occurred_idx on app.incidents (org_id, occurred_at desc) where deleted_at is null;
create index if not exists people_name_search_idx on app.people using gin (to_tsvector('simple', coalesce(full_name, '')));
create index if not exists documents_title_search_idx on app.documents using gin (to_tsvector('simple', title));
create index if not exists sops_search_idx on app.sops using gin (
  (setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('simple', body), 'D')));
create index if not exists handbook_article_versions_search_idx on app.handbook_article_versions using gin (
  (setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('simple', body), 'D')));

-- Search context ----------------------------------------------------------------------------------------------------

create or replace function app.search_context(p_org_id uuid)
returns table (person_id uuid, time_zone text, org_today date, semantic_enabled boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_membership_in(p_org_id);
  return query select private.current_person_id(), private.org_time_zone(p_org_id), private.org_today(p_org_id),
    coalesce(private.org_boolean_setting(p_org_id, 'search.semantic_enabled'), false);
end;
$$;

comment on function app.search_context(uuid) is 'What a search needs to know about the signed-in member of an org (A87): their person id, the org''s time zone and today''s date on its calendar (A71), and whether the org has semantic search on (search.semantic_enabled). Refuses anyone who is not an active member.';
revoke all on function app.search_context(uuid) from public, anon;
grant execute on function app.search_context(uuid) to authenticated, service_role;

-- Recent views --------------------------------------------------------------------------------------------------------

create table app.recent_views (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  person_id uuid not null references app.people (id),
  subject_table text not null,
  subject_id uuid not null,
  viewed_at timestamptz not null default now(),
  constraint recent_views_subject_table check (subject_table in ('records', 'incidents', 'documents', 'sops', 'handbook_articles'))
);

insert into private.read_only_exempt_tables (table_name, rationale) values
  ('app.recent_views', 'Opening a record of a canceled, read-only org still lists it among the person''s own recent items.');

call private.install_domain_table('app.recent_views');
create unique index recent_views_subject_key on app.recent_views (person_id, org_id, subject_table, subject_id) where deleted_at is null;
create index recent_views_person_viewed_idx on app.recent_views (person_id, org_id, viewed_at desc) where deleted_at is null;

call private.describe('app.recent_views', 'What a person opened (Section 11.7: the last 50 records each person viewed appear before they type): each record, incident, document, SOP or handbook article once, with when they last opened it. At most 50 per person and org; rows go after 90 days and when the person is deleted. Only the person reads or writes their own rows.', array[
  'person_id', 'Person who opened it; always the signed-in person.',
  'subject_table', 'Table of what was opened: records, incidents, documents, sops or handbook_articles.',
  'subject_id', 'Row that was opened.',
  'viewed_at', 'When the person last opened it, set by the database.'
]);

create or replace function private.guard_recent_view()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.current_person_id();
begin
  if auth.uid() is not null then
    if v_person is null or new.org_id not in (select private.my_org_ids()) then
      raise exception using errcode = '42501', message = 'only a member records what they opened in an org';
    end if;
    new.person_id := v_person;
  end if;
  if tg_op = 'UPDATE' and (new.person_id <> old.person_id or new.org_id <> old.org_id
      or new.subject_table <> old.subject_table or new.subject_id <> old.subject_id) then
    perform private.refuse('recent_view_immutable', 'A recent view keeps what was opened and by whom; only the time changes.');
  end if;
  -- The clock, not the transaction time, so views recorded in one transaction keep their order.
  new.viewed_at := clock_timestamp();
  return new;
end;
$$;

comment on function private.guard_recent_view() is 'Recent views: written for the signed-in person only, in an org they belong to, at database time; what was opened never changes.';
revoke all on function private.guard_recent_view() from public, anon, authenticated;

create trigger t05_guard_recent_view before insert or update on app.recent_views
  for each row execute function private.guard_recent_view();

create or replace function private.trim_recent_views()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from app.recent_views v
  where v.id in (
    select r.id from app.recent_views r
    where r.person_id = new.person_id and r.org_id = new.org_id and r.deleted_at is null
    order by r.viewed_at desc, r.id desc
    offset 50);
  return null;
end;
$$;

comment on function private.trim_recent_views() is 'Keeps a person''s 50 most recent views in an org and deletes the rest (Section 11.7: the last 50).';
revoke all on function private.trim_recent_views() from public, anon, authenticated;

create trigger t90_trim_recent_views after insert on app.recent_views
  for each row execute function private.trim_recent_views();

create or replace function private.forget_recent_views()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from app.recent_views v where v.person_id = new.id;
  return null;
end;
$$;

comment on function private.forget_recent_views() is 'Deletes everything a person opened when the person is deleted (app.delete_my_account soft-deletes app.people), so no history of their views outlives them.';
revoke all on function private.forget_recent_views() from public, anon, authenticated;

create trigger t91_forget_recent_views after update of deleted_at on app.people
  for each row when (new.deleted_at is not null and old.deleted_at is null)
  execute function private.forget_recent_views();

call private.install_policies('app.recent_views',
  $$person_id = (select private.current_person_id()) and org_id in (select private.my_org_ids())$$,
  $$person_id = (select private.current_person_id()) and org_id in (select private.my_org_ids())$$);

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.recent_views', 'Age', 'viewed_at', interval '90 days', 'Delete', 'A convenience list of what a person opened recently; it has no use after three months.');

create or replace function app.record_recent_view(p_org_id uuid, p_subject_table text, p_subject_id uuid)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_found boolean;
begin
  if auth.uid() is null or p_org_id is null or p_subject_id is null
     or p_subject_table is null or p_subject_table not in ('records', 'incidents', 'documents', 'sops', 'handbook_articles') then
    return false;
  end if;
  -- Read with the caller's own row level security: something they cannot read is never recorded.
  execute format('select true from app.%I s where s.id = $1 and s.org_id = $2 and s.deleted_at is null', p_subject_table)
    into v_found using p_subject_id, p_org_id;
  if v_found is null then
    return false;
  end if;
  insert into app.recent_views (org_id, person_id, subject_table, subject_id)
  values (p_org_id, (select s.person_id from app.search_context(p_org_id) s), p_subject_table, p_subject_id)
  on conflict (person_id, org_id, subject_table, subject_id) where deleted_at is null
  do update set viewed_at = clock_timestamp();
  return true;
end;
$$;

comment on function app.record_recent_view(uuid, text, uuid) is 'Records that the signed-in person opened a record, incident, document, SOP or handbook article (Section 11.7 recents). Runs as the caller: something they cannot read is not recorded and the call returns false. Opening it again moves it to the top; at most 50 are kept per person and org.';
revoke all on function app.record_recent_view(uuid, text, uuid) from public, anon;
grant execute on function app.record_recent_view(uuid, text, uuid) to authenticated, service_role;

-- Embeddings ------------------------------------------------------------------------------------------------------------

create table app.search_embeddings (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  source_table text not null,
  source_id uuid not null,
  content_sha256 text not null,
  provider text not null,
  model text not null,
  embedding extensions.vector(1024) not null,
  embedded_at timestamptz not null default now(),
  constraint search_embeddings_source_table check (source_table in ('documents', 'sops', 'handbook_articles')),
  constraint search_embeddings_checksum_format check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint search_embeddings_provider_format check (provider ~ '^[a-z][a-z0-9_-]{1,30}$'),
  constraint search_embeddings_model_length check (char_length(btrim(model)) between 1 and 100)
);

call private.install_domain_table('app.search_embeddings');
create unique index search_embeddings_source_key on app.search_embeddings (source_table, source_id) where deleted_at is null;
create index search_embeddings_embedding_idx on app.search_embeddings using hnsw (embedding extensions.vector_cosine_ops);

call private.describe('app.search_embeddings', 'Semantic search index (Section 5, A87): one embedding per published document, SOP and handbook article of an org with search.semantic_enabled on, written by the embedding worker with the service role and replaced when the text changes. Readable only by people who can read the source.', array[
  'source_table', 'Table of the source: documents, sops or handbook_articles.',
  'source_id', 'Source row.',
  'content_sha256', 'SHA-256 of the text that was embedded, lowercase hex; a different hash means the source changed.',
  'provider', 'Embedding provider, for example local-hash in tests.',
  'model', 'Provider model that made the vector; vectors of another model are never compared.',
  'embedding', 'The vector, 1024 dimensions, compared by cosine distance.',
  'embedded_at', 'When the vector was made.'
]);

call private.install_policies('app.search_embeddings', $$
  (source_table = 'sops' and exists (select 1 from app.sops s where s.id = source_id and s.deleted_at is null))
  or (source_table = 'documents' and exists (select 1 from app.documents d where d.id = source_id and d.deleted_at is null))
  or (source_table = 'handbook_articles' and exists (
    select 1 from app.handbook_articles a where a.id = source_id and a.deleted_at is null and a.article_state = 'Published'))
$$);

insert into private.retention_policies (table_name, basis, time_column, retention, purge_method, rationale) values
  ('app.search_embeddings', 'Soft Deleted', 'deleted_at', interval '30 days', 'Delete', 'A derived index rebuilt from its source; it is kept no longer than the source.');

-- Text that may be embedded: a column is left out when any classification marks it Restricted, and nothing is taken
-- from a table excluded from AI features (Section 4.7, Section 14.3).
create or replace function private.search_embedding_text(p_table text, p_parts text[])
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_out text := '';
  i integer := 1;
begin
  if exists (select 1 from private.ai_excluded_tables e where e.table_name = p_table) then
    return null;
  end if;
  while i < coalesce(array_length(p_parts, 1), 0) loop
    if p_parts[i + 1] is not null and btrim(p_parts[i + 1]) <> '' and not exists (
        select 1 from private.column_classifications c
        where c.table_name = p_table and c.column_name = p_parts[i] and c.classification = 'Restricted') then
      v_out := v_out || case when v_out = '' then '' else E'\n\n' end || btrim(p_parts[i + 1]);
    end if;
    i := i + 2;
  end loop;
  return nullif(left(v_out, 8000), '');
end;
$$;

comment on function private.search_embedding_text(text, text[]) is 'The text of a search source that may go to the embedding provider: the named columns'' values (pairs of column name and value) joined, without any column classified Restricted and nothing from a table excluded from AI features; at most 8,000 characters.';
revoke all on function private.search_embedding_text(text, text[]) from public, anon, authenticated;

create or replace function private.search_embedding_sources(p_source_table text default null, p_source_id uuid default null)
returns table (org_id uuid, source_table text, source_id uuid, content text)
language sql
stable
security definer
set search_path = ''
as $$
  with enabled as (
    select o.id from app.organizations o
    where o.deleted_at is null and coalesce(private.org_boolean_setting(o.id, 'search.semantic_enabled'), false)
  ),
  found as (
    select s.org_id, 'sops'::text as source_table, s.id as source_id,
      private.search_embedding_text('app.sops', array['title', s.title, 'body', s.body]) as content
    from app.sops s
    where s.deleted_at is null and s.published_at is not null and s.org_id in (select e.id from enabled e)
      and (p_source_table is null or p_source_table = 'sops') and (p_source_id is null or s.id = p_source_id)
    union all
    select a.org_id, 'handbook_articles', a.id,
      private.search_embedding_text('app.handbook_article_versions', array['title', v.title, 'body', v.body])
    from app.handbook_articles a
    join app.handbook_article_versions v on v.handbook_article_id = a.id and v.version = a.published_version
    where a.deleted_at is null and a.article_state = 'Published' and a.org_id in (select e.id from enabled e)
      and (p_source_table is null or p_source_table = 'handbook_articles') and (p_source_id is null or a.id = p_source_id)
    union all
    select d.org_id, 'documents', d.id, private.search_embedding_text('app.documents', array['title', d.title])
    from app.documents d
    where d.deleted_at is null and d.org_id in (select e.id from enabled e)
      and (p_source_table is null or p_source_table = 'documents') and (p_source_id is null or d.id = p_source_id)
  )
  select f.org_id, f.source_table, f.source_id, f.content from found f where f.content is not null;
$$;

comment on function private.search_embedding_sources(text, uuid) is 'Every source the semantic index covers, with the text that may be embedded: published SOPs, the published version of each published handbook article and document titles, only in orgs with search.semantic_enabled on. Optionally one table or one row.';
revoke all on function private.search_embedding_sources(text, uuid) from public, anon, authenticated;

create or replace function app.search_embedding_backlog(p_provider text, p_model text, p_limit integer default 32)
returns table (org_id uuid, source_table text, source_id uuid, content text, content_sha256 text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.org_id, s.source_table, s.source_id, s.content, encode(extensions.digest(s.content, 'sha256'), 'hex')
  from private.search_embedding_sources() s
  where not exists (
    select 1 from app.search_embeddings e
    where e.source_table = s.source_table and e.source_id = s.source_id and e.deleted_at is null
      and e.provider = p_provider and e.model = p_model
      and e.content_sha256 = encode(extensions.digest(s.content, 'sha256'), 'hex'))
  order by s.org_id, s.source_table, s.source_id
  limit least(greatest(coalesce(p_limit, 32), 1), 256);
$$;

comment on function app.search_embedding_backlog(text, text, integer) is 'Embedding worker API (service role): sources whose text has no current vector from this provider and model, with the text to embed and its SHA-256. Only orgs with search.semantic_enabled on; no column classified Restricted is ever in the text.';
revoke all on function app.search_embedding_backlog(text, text, integer) from public, anon, authenticated;
grant execute on function app.search_embedding_backlog(text, text, integer) to service_role;

create or replace function app.store_search_embedding(
  p_source_table text,
  p_source_id uuid,
  p_content_sha256 text,
  p_provider text,
  p_model text,
  p_embedding extensions.vector
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_source record;
  v_id uuid;
begin
  select s.org_id, s.content into v_source from private.search_embedding_sources(p_source_table, p_source_id) s;
  if v_source.org_id is null then
    perform private.refuse('search_source_unavailable', 'The source is gone, unpublished, or its org has semantic search off.');
  end if;
  if encode(extensions.digest(v_source.content, 'sha256'), 'hex') is distinct from p_content_sha256 then
    perform private.refuse('search_source_changed', 'The source changed after its text was read; embed the current text.');
  end if;
  if extensions.vector_dims(p_embedding) <> 1024 then
    perform private.refuse('search_embedding_dimensions', 'Embeddings have 1024 dimensions.');
  end if;
  insert into app.search_embeddings (org_id, source_table, source_id, content_sha256, provider, model, embedding, embedded_at)
  values (v_source.org_id, p_source_table, p_source_id, p_content_sha256, p_provider, p_model, p_embedding, now())
  on conflict (source_table, source_id) where deleted_at is null do update
    set content_sha256 = excluded.content_sha256, provider = excluded.provider, model = excluded.model,
        embedding = excluded.embedding, embedded_at = now()
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.store_search_embedding(text, uuid, text, text, text, extensions.vector) is 'Embedding worker API (service role): stores the vector of a source''s text, replacing the previous one. Refused when the source is gone or unpublished, its org has semantic search off, the text changed since the backlog read it, or the vector does not have 1024 dimensions.';
revoke all on function app.store_search_embedding(text, uuid, text, text, text, extensions.vector) from public, anon, authenticated;
grant execute on function app.store_search_embedding(text, uuid, text, text, text, extensions.vector) to service_role;

create or replace function app.retire_search_embeddings()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from app.search_embeddings e
  where (e.source_table, e.source_id) not in (select s.source_table, s.source_id from private.search_embedding_sources() s);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function app.retire_search_embeddings() is 'Embedding worker API (service role): deletes the vectors of sources that are gone or unpublished, or whose org turned semantic search off, and returns how many.';
revoke all on function app.retire_search_embeddings() from public, anon, authenticated;
grant execute on function app.retire_search_embeddings() to service_role;

-- The search -----------------------------------------------------------------------------------------------------------

create or replace function app.global_search(
  p_org_id uuid,
  p_query jsonb,
  p_embedding extensions.vector default null,
  p_limit integer default 20,
  p_min_similarity real default 0.35
)
returns table (
  result_type text,
  result_id uuid,
  result_key text,
  title text,
  record_kind text,
  state text,
  project_key text,
  dated_at timestamptz,
  rank real,
  matched text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_ctx record;
  v_zone text;
  v_today date;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_query jsonb := case when jsonb_typeof(p_query) = 'object' then p_query else '{}'::jsonb end;
  v_terms text[];
  v_phrases text[];
  v_exclude_terms text[];
  v_exclude_phrases text[];
  v_types text[];
  v_exclude_types text[];
  v_kinds text[];
  v_exclude_kinds text[];
  v_projects text[];
  v_exclude_projects text[];
  v_assignees text[];
  v_exclude_assignees text[];
  v_statuses text[];
  v_exclude_statuses text[];
  v_phases text[];
  v_urids text[];
  v_depts text[];
  v_is text[];
  v_keys text[] := '{}';
  v_text tsquery;
  v_not tsquery;
  v_part text;
  v_term text;
  v_allowed text[] := array['record', 'incident', 'person', 'document', 'sop', 'article'];
  v_project_ids uuid[];
  v_exclude_project_ids uuid[];
  v_assignee_ids uuid[];
  v_exclude_assignee_ids uuid[];
  v_phase_codes text[];
  v_urid_prefixes text[];
  v_after timestamptz;
  v_before timestamptz;
  v_due_after timestamptz;
  v_due_before timestamptz;
  v_today_start timestamptz;
  v_semantic boolean;
  v_model text := nullif(btrim(v_query->>'model'), '');
  v_has_text boolean;
begin
  select * into v_ctx from app.search_context(p_org_id);
  v_zone := v_ctx.time_zone;
  v_today := v_ctx.org_today;

  select
    array(select jsonb_array_elements_text(case when jsonb_typeof(v_query->'terms') = 'array' then v_query->'terms' else '[]' end)),
    array(select jsonb_array_elements_text(case when jsonb_typeof(v_query->'phrases') = 'array' then v_query->'phrases' else '[]' end)),
    array(select jsonb_array_elements_text(case when jsonb_typeof(v_query->'exclude_terms') = 'array' then v_query->'exclude_terms' else '[]' end)),
    array(select jsonb_array_elements_text(case when jsonb_typeof(v_query->'exclude_phrases') = 'array' then v_query->'exclude_phrases' else '[]' end)),
    array(select lower(x) from jsonb_array_elements_text(case when jsonb_typeof(v_query->'types') = 'array' then v_query->'types' else '[]' end) x),
    array(select lower(x) from jsonb_array_elements_text(case when jsonb_typeof(v_query->'exclude_types') = 'array' then v_query->'exclude_types' else '[]' end) x),
    array(select lower(x) from jsonb_array_elements_text(case when jsonb_typeof(v_query->'kinds') = 'array' then v_query->'kinds' else '[]' end) x),
    array(select lower(x) from jsonb_array_elements_text(case when jsonb_typeof(v_query->'exclude_kinds') = 'array' then v_query->'exclude_kinds' else '[]' end) x),
    array(select jsonb_array_elements_text(case when jsonb_typeof(v_query->'projects') = 'array' then v_query->'projects' else '[]' end)),
    array(select jsonb_array_elements_text(case when jsonb_typeof(v_query->'exclude_projects') = 'array' then v_query->'exclude_projects' else '[]' end)),
    array(select jsonb_array_elements_text(case when jsonb_typeof(v_query->'assignees') = 'array' then v_query->'assignees' else '[]' end)),
    array(select jsonb_array_elements_text(case when jsonb_typeof(v_query->'exclude_assignees') = 'array' then v_query->'exclude_assignees' else '[]' end)),
    array(select lower(regexp_replace(x, '[^[:alnum:]]', '', 'g')) from jsonb_array_elements_text(case when jsonb_typeof(v_query->'statuses') = 'array' then v_query->'statuses' else '[]' end) x),
    array(select lower(regexp_replace(x, '[^[:alnum:]]', '', 'g')) from jsonb_array_elements_text(case when jsonb_typeof(v_query->'exclude_statuses') = 'array' then v_query->'exclude_statuses' else '[]' end) x),
    array(select jsonb_array_elements_text(case when jsonb_typeof(v_query->'phases') = 'array' then v_query->'phases' else '[]' end)),
    array(select jsonb_array_elements_text(case when jsonb_typeof(v_query->'urids') = 'array' then v_query->'urids' else '[]' end)),
    array(select jsonb_array_elements_text(case when jsonb_typeof(v_query->'depts') = 'array' then v_query->'depts' else '[]' end)),
    array(select lower(x) from jsonb_array_elements_text(case when jsonb_typeof(v_query->'is') = 'array' then v_query->'is' else '[]' end) x)
  into v_terms, v_phrases, v_exclude_terms, v_exclude_phrases, v_types, v_exclude_types, v_kinds, v_exclude_kinds,
    v_projects, v_exclude_projects, v_assignees, v_exclude_assignees, v_statuses, v_exclude_statuses, v_phases,
    v_urids, v_depts, v_is;

  -- Words: a key (NWL-12) is looked up exactly; every other word matches as a prefix. Lexemes come from the text
  -- search parser, so punctuation never reaches the tsquery syntax.
  foreach v_term in array v_terms[1:12] loop
    if v_term ~* '^[a-z][a-z0-9]{1,9}-[0-9]{1,7}$' then
      v_keys := v_keys || upper(v_term);
      continue;
    end if;
    select string_agg(format('%L', l.word) || ':*', ' & ') into v_part
    from (select regexp_replace(t.lexeme, '[''\\:&|!()<>*]', '', 'g') as word from unnest(to_tsvector('simple', v_term)) t) l
    where l.word <> '';
    if v_part is not null then
      v_text := case when v_text is null then v_part::tsquery else v_text && v_part::tsquery end;
    end if;
  end loop;
  foreach v_term in array v_phrases[1:4] loop
    if numnode(phraseto_tsquery('simple', v_term)) > 0 then
      v_text := case when v_text is null then phraseto_tsquery('simple', v_term) else v_text && phraseto_tsquery('simple', v_term) end;
    end if;
  end loop;
  foreach v_term in array v_exclude_terms[1:12] loop
    if numnode(plainto_tsquery('simple', v_term)) > 0 then
      v_not := case when v_not is null then plainto_tsquery('simple', v_term) else v_not || plainto_tsquery('simple', v_term) end;
    end if;
  end loop;
  foreach v_term in array v_exclude_phrases[1:4] loop
    if numnode(phraseto_tsquery('simple', v_term)) > 0 then
      v_not := case when v_not is null then phraseto_tsquery('simple', v_term) else v_not || phraseto_tsquery('simple', v_term) end;
    end if;
  end loop;
  v_has_text := v_text is not null or cardinality(v_keys) > 0;

  -- Result types: the requested ones, less the excluded ones, less any type a filter does not apply to.
  if cardinality(v_types) > 0 then
    v_allowed := array(select t from unnest(v_allowed) t where t = any (v_types));
  end if;
  v_allowed := array(select t from unnest(v_allowed) t where not (t = any (v_exclude_types)));
  if cardinality(v_kinds) + cardinality(v_exclude_kinds) + cardinality(v_assignees) + cardinality(v_exclude_assignees)
     + cardinality(v_phases) + cardinality(v_urids) + cardinality(v_depts) > 0
     or v_query->>'due_after' is not null or v_query->>'due_before' is not null
     or v_is && array['blocked', 'overdue', 'mine'] then
    v_allowed := array(select t from unnest(v_allowed) t where t = 'record');
  end if;
  if cardinality(v_statuses) + cardinality(v_exclude_statuses) > 0 or v_is && array['open', 'closed'] then
    v_allowed := array(select t from unnest(v_allowed) t where t in ('record', 'incident'));
  end if;
  if cardinality(v_projects) + cardinality(v_exclude_projects) > 0 then
    v_allowed := array(select t from unnest(v_allowed) t where t in ('record', 'incident', 'document'));
  end if;
  if v_query->>'after' is not null or v_query->>'before' is not null then
    v_allowed := array(select t from unnest(v_allowed) t where t <> 'person');
  end if;
  if not v_has_text and cardinality(v_types) + cardinality(v_exclude_types) + cardinality(v_kinds) + cardinality(v_exclude_kinds)
       + cardinality(v_projects) + cardinality(v_exclude_projects) + cardinality(v_assignees) + cardinality(v_exclude_assignees)
       + cardinality(v_statuses) + cardinality(v_exclude_statuses) + cardinality(v_phases) + cardinality(v_urids)
       + cardinality(v_depts) + cardinality(v_is) = 0
     and coalesce(v_query->>'after', v_query->>'before', v_query->>'due_after', v_query->>'due_before') is null then
    -- Nothing to search for: the command menu shows recent items instead.
    return;
  end if;

  -- Days on the org's calendar: a date, or days from today. after: is from the start of the next day; before: is
  -- before the start of the day.
  begin
    v_today_start := v_today::timestamp at time zone v_zone;
    v_after := case
      when v_query->>'after' ~ '^\d{4}-\d{2}-\d{2}$' then ((v_query->>'after')::date + 1)::timestamp at time zone v_zone
      when v_query->>'after' ~ '^[+-]?\d{1,5}$' then (v_today + (v_query->>'after')::integer + 1)::timestamp at time zone v_zone end;
    v_before := case
      when v_query->>'before' ~ '^\d{4}-\d{2}-\d{2}$' then ((v_query->>'before')::date)::timestamp at time zone v_zone
      when v_query->>'before' ~ '^[+-]?\d{1,5}$' then (v_today + (v_query->>'before')::integer)::timestamp at time zone v_zone end;
    v_due_after := case
      when v_query->>'due_after' ~ '^\d{4}-\d{2}-\d{2}$' then ((v_query->>'due_after')::date + 1)::timestamp at time zone v_zone
      when v_query->>'due_after' ~ '^[+-]?\d{1,5}$' then (v_today + (v_query->>'due_after')::integer + 1)::timestamp at time zone v_zone end;
    v_due_before := case
      when v_query->>'due_before' ~ '^\d{4}-\d{2}-\d{2}$' then ((v_query->>'due_before')::date)::timestamp at time zone v_zone
      when v_query->>'due_before' ~ '^[+-]?\d{1,5}$' then (v_today + (v_query->>'due_before')::integer)::timestamp at time zone v_zone end;
  exception when invalid_datetime_format or datetime_field_overflow or invalid_parameter_value then
    raise exception using errcode = 'XR001', hint = 'search_date_invalid', message = 'search_date_invalid: A search date is not a calendar date.';
  end;

  -- Filters resolved once, each read with the caller's row level security.
  if cardinality(v_projects) > 0 then
    v_project_ids := array(select p.id from app.projects p
      where p.org_id = p_org_id and p.deleted_at is null
        and (upper(p.project_key) = any (array(select upper(x) from unnest(v_projects) x))
             or p.name ilike any (array(select replace(replace(replace(x, '\', '\\'), '%', '\%'), '_', '\_') || '%' from unnest(v_projects) x))));
  end if;
  if cardinality(v_exclude_projects) > 0 then
    v_exclude_project_ids := array(select p.id from app.projects p
      where p.org_id = p_org_id
        and (upper(p.project_key) = any (array(select upper(x) from unnest(v_exclude_projects) x))
             or p.name ilike any (array(select replace(replace(replace(x, '\', '\\'), '%', '\%'), '_', '\_') || '%' from unnest(v_exclude_projects) x))));
  end if;
  if cardinality(v_assignees) > 0 or 'mine' = any (v_is) then
    v_assignee_ids := array(
      select v_ctx.person_id where 'me' = any (v_assignees) or 'mine' = any (v_is)
      union
      select m.person_id from app.memberships m join app.people pe on pe.id = m.person_id
      where m.org_id = p_org_id and m.deleted_at is null
        and pe.full_name ilike any (array(select '%' || replace(replace(replace(x, '\', '\\'), '%', '\%'), '_', '\_') || '%'
                                          from unnest(v_assignees) x where x <> 'me')));
  end if;
  if cardinality(v_exclude_assignees) > 0 then
    v_exclude_assignee_ids := array(
      select v_ctx.person_id where 'me' = any (v_exclude_assignees)
      union
      select m.person_id from app.memberships m join app.people pe on pe.id = m.person_id
      where m.org_id = p_org_id
        and pe.full_name ilike any (array(select '%' || replace(replace(replace(x, '\', '\\'), '%', '\%'), '_', '\_') || '%'
                                          from unnest(v_exclude_assignees) x where x <> 'me')));
  end if;
  if cardinality(v_phases) > 0 then
    v_phase_codes := array(select ph.phase_code::text from xpms.dim_phase ph
      where upper(ph.phase_code::text) = any (array(select upper(x) from unnest(v_phases) x))
         or ph.phase::text ilike any (array(select replace(replace(x, '%', ''), '_', '') || '%' from unnest(v_phases) x)));
  end if;
  if cardinality(v_urids) + cardinality(v_depts) > 0 then
    v_urid_prefixes := array(
      select x from unnest(v_urids) x where x ~ '^[0-9]{1,4}(\.[0-9]{0,2}){0,2}$'
      union
      select d.dept_code::text from xpms.dim_department d
      where d.dept_code::text = any (v_depts)
         or d.department::text ilike any (array(select replace(replace(x, '%', ''), '_', '') || '%' from unnest(v_depts) x))
      union
      select di.disc_code::text from xpms.dim_discipline di
      where di.disc_code::text = any (v_depts)
         or di.discipline::text ilike any (array(select replace(replace(x, '%', ''), '_', '') || '%' from unnest(v_depts) x)));
  end if;
  v_semantic := p_embedding is not null and v_ctx.semantic_enabled and extensions.vector_dims(p_embedding) = 1024
    and v_allowed && array['document', 'sop', 'article'];

  return query
  with
  key_hits as (
    select r.id, r.record_number, p.project_key, p.id as project_id
    from unnest(v_keys) k
    join app.projects p on p.org_id = p_org_id and p.deleted_at is null and upper(p.project_key) = split_part(k, '-', 1)
    join app.records r on r.project_id = p.id and r.record_number = split_part(k, '-', 2)::bigint
  ),
  record_hits as (
    select 'record'::text as result_type, r.id, p.project_key || '-' || r.record_number::text as result_key, r.title,
      r.record_kind::text as record_kind, r.record_state::text as state, p.project_key::text as project_key,
      r.updated_at as dated_at,
      case when r.id in (select kh.id from key_hits kh) then 1.0
           when v_text is null then 0.5
           else least(1.0, ts_rank_cd(to_tsvector('simple', r.title), v_text, 32) * 4) end::real as relevance,
      case when r.id in (select kh.id from key_hits kh) then 'key' when v_text is null then 'filter' else 'text' end as matched
    from app.records r
    left join app.projects p on p.id = r.project_id
    where 'record' = any (v_allowed) and r.org_id = p_org_id and r.deleted_at is null
      and (
        (v_text is not null and to_tsvector('simple', r.title) @@ v_text)
        or r.id in (select kh.id from key_hits kh)
        or (not v_has_text))
      and (v_not is null or not (to_tsvector('simple', r.title) @@ v_not))
      and (cardinality(v_kinds) = 0 or lower(r.record_kind) = any (v_kinds))
      and not (lower(r.record_kind) = any (v_exclude_kinds))
      and (v_project_ids is null or r.project_id = any (v_project_ids))
      and (v_exclude_project_ids is null or not (r.project_id = any (v_exclude_project_ids)))
      and (cardinality(v_statuses) = 0
           or lower(replace(r.record_state, ' ', '')) = any (v_statuses)
           or ('open' = any (v_statuses) and r.record_state not in ('Complete', 'Canceled'))
           or ('closed' = any (v_statuses) and r.record_state in ('Complete', 'Canceled')))
      and not (lower(replace(r.record_state, ' ', '')) = any (v_exclude_statuses))
      and not ('open' = any (v_exclude_statuses) and r.record_state not in ('Complete', 'Canceled'))
      and not ('closed' = any (v_exclude_statuses) and r.record_state in ('Complete', 'Canceled'))
      and (not ('blocked' = any (v_is)) or r.record_state = 'Blocked')
      and (not ('open' = any (v_is)) or r.record_state not in ('Complete', 'Canceled'))
      and (not ('closed' = any (v_is)) or r.record_state in ('Complete', 'Canceled'))
      and (not ('overdue' = any (v_is)) or (r.due_at < v_today_start and r.record_state not in ('Complete', 'Canceled')))
      and (v_assignee_ids is null or r.owner_party_id = any (v_assignee_ids) or r.accountable_party_id = any (v_assignee_ids)
           or exists (select 1 from app.record_assignments ra join app.memberships m on m.id = ra.membership_id
                      where ra.record_id = r.id and ra.deleted_at is null and m.person_id = any (v_assignee_ids)))
      and (v_exclude_assignee_ids is null or not (
           coalesce(r.owner_party_id = any (v_exclude_assignee_ids), false) or coalesce(r.accountable_party_id = any (v_exclude_assignee_ids), false)
           or exists (select 1 from app.record_assignments ra join app.memberships m on m.id = ra.membership_id
                      where ra.record_id = r.id and ra.deleted_at is null and m.person_id = any (v_exclude_assignee_ids))))
      and (v_phase_codes is null or r.phase_code = any (v_phase_codes))
      and (v_urid_prefixes is null or exists (select 1 from unnest(v_urid_prefixes) u where r.urid like u || '%'))
      and (v_after is null or r.updated_at >= v_after)
      and (v_before is null or r.updated_at < v_before)
      and (v_due_after is null or r.due_at >= v_due_after)
      and (v_due_before is null or r.due_at < v_due_before)
    order by relevance desc, r.updated_at desc
    limit v_limit
  ),
  incident_hits as (
    select 'incident'::text, i.id, p.project_key || '-' || i.incident_number::text, i.title, null::text,
      i.incident_state::text, p.project_key::text, i.occurred_at,
      case when ik.is_key then 1.0
           when v_text is null then 0.5
           else least(1.0, ts_rank_cd(to_tsvector('simple', i.title), v_text, 32) * 4) end::real,
      case when ik.is_key then 'key' when v_text is null then 'filter' else 'text' end
    from app.incidents i
    left join app.projects p on p.id = i.project_id
    cross join lateral (
      select exists (select 1 from unnest(v_keys) k where upper(p.project_key) = split_part(k, '-', 1)
                                                      and i.incident_number = split_part(k, '-', 2)::bigint) as is_key) ik
    where 'incident' = any (v_allowed) and i.org_id = p_org_id and i.deleted_at is null
      and (
        (v_text is not null and to_tsvector('simple', i.title) @@ v_text)
        or ik.is_key
        or (not v_has_text))
      and (v_not is null or not (to_tsvector('simple', i.title) @@ v_not))
      and (v_project_ids is null or i.project_id = any (v_project_ids))
      and (v_exclude_project_ids is null or not (i.project_id = any (v_exclude_project_ids)))
      and (cardinality(v_statuses) = 0
           or lower(i.incident_state::text) = any (v_statuses)
           or ('open' = any (v_statuses) and i.incident_state <> 'Closed')
           or ('closed' = any (v_statuses) and i.incident_state = 'Closed'))
      and not (lower(i.incident_state::text) = any (v_exclude_statuses))
      and not ('open' = any (v_exclude_statuses) and i.incident_state <> 'Closed')
      and not ('closed' = any (v_exclude_statuses) and i.incident_state = 'Closed')
      and (not ('open' = any (v_is)) or i.incident_state <> 'Closed')
      and (not ('closed' = any (v_is)) or i.incident_state = 'Closed')
      and (v_after is null or i.occurred_at >= v_after)
      and (v_before is null or i.occurred_at < v_before)
    order by 9 desc, i.occurred_at desc
    limit v_limit
  ),
  people_hits as (
    select 'person'::text, pe.id, null::text, pe.full_name, null::text, null::text, null::text, null::timestamptz,
      case when v_text is null then 0.5 else least(1.0, ts_rank_cd(to_tsvector('simple', coalesce(pe.full_name, '')), v_text, 32) * 4) end::real,
      case when v_text is null then 'filter' else 'text' end
    from app.memberships m
    join app.people pe on pe.id = m.person_id
    where 'person' = any (v_allowed) and v_text is not null and m.org_id = p_org_id and m.deleted_at is null
      and pe.deleted_at is null and pe.full_name is not null
      and to_tsvector('simple', coalesce(pe.full_name, '')) @@ v_text
      and (v_not is null or not (to_tsvector('simple', coalesce(pe.full_name, '')) @@ v_not))
    order by 9 desc, pe.full_name
    limit v_limit
  ),
  semantic as (
    select e.source_table, e.source_id,
      (1 - (e.embedding operator(extensions.<=>) p_embedding))::real as similarity
    from app.search_embeddings e
    where v_semantic and e.org_id = p_org_id and e.deleted_at is null and (v_model is null or e.model = v_model)
    order by e.embedding operator(extensions.<=>) p_embedding
    limit 24
  ),
  close_enough as (
    select s.source_table, s.source_id, s.similarity from semantic s where s.similarity >= coalesce(p_min_similarity, 0.35)
  ),
  knowledge as (
    select 'sop'::text as result_type, s.id, s.code::text as result_key, s.title, null::text as record_kind,
      case when s.published_at is null then 'Draft' else 'Published' end as state, null::text as project_key,
      coalesce(s.published_at, s.updated_at) as dated_at,
      case when v_text is not null and (setweight(to_tsvector('simple', s.title), 'A') || setweight(to_tsvector('simple', s.body), 'D')) @@ v_text
           then least(1.0, ts_rank_cd(setweight(to_tsvector('simple', s.title), 'A') || setweight(to_tsvector('simple', s.body), 'D'), v_text, 33) * 4)
           end::real as lexical,
      (select c.similarity from close_enough c where c.source_table = 'sops' and c.source_id = s.id) as similarity
    from app.sops s
    where 'sop' = any (v_allowed) and s.org_id = p_org_id and s.deleted_at is null
      and (
        (v_text is not null and (setweight(to_tsvector('simple', s.title), 'A') || setweight(to_tsvector('simple', s.body), 'D')) @@ v_text)
        or s.id in (select c.source_id from close_enough c where c.source_table = 'sops')
        or (not v_has_text and not v_semantic))
      and (v_not is null or not ((setweight(to_tsvector('simple', s.title), 'A') || setweight(to_tsvector('simple', s.body), 'D')) @@ v_not))
      and (v_after is null or coalesce(s.published_at, s.updated_at) >= v_after)
      and (v_before is null or coalesce(s.published_at, s.updated_at) < v_before)
    union all
    select 'article', a.id, null, v.title, null, 'Published', null, a.published_at,
      case when v_text is not null and (setweight(to_tsvector('simple', v.title), 'A') || setweight(to_tsvector('simple', v.body), 'D')) @@ v_text
           then least(1.0, ts_rank_cd(setweight(to_tsvector('simple', v.title), 'A') || setweight(to_tsvector('simple', v.body), 'D'), v_text, 33) * 4)
           end::real,
      (select c.similarity from close_enough c where c.source_table = 'handbook_articles' and c.source_id = a.id)
    from app.handbook_articles a
    join app.handbook_article_versions v on v.handbook_article_id = a.id and v.version = a.published_version
    where 'article' = any (v_allowed) and a.org_id = p_org_id and a.deleted_at is null and a.article_state = 'Published'
      and (
        (v_text is not null and (setweight(to_tsvector('simple', v.title), 'A') || setweight(to_tsvector('simple', v.body), 'D')) @@ v_text)
        or a.id in (select c.source_id from close_enough c where c.source_table = 'handbook_articles')
        or (not v_has_text and not v_semantic))
      and (v_not is null or not ((setweight(to_tsvector('simple', v.title), 'A') || setweight(to_tsvector('simple', v.body), 'D')) @@ v_not))
      and (v_after is null or a.published_at >= v_after)
      and (v_before is null or a.published_at < v_before)
    union all
    select 'document', d.id, null, d.title, null, null, p.project_key::text, d.updated_at,
      case when v_text is not null and to_tsvector('simple', d.title) @@ v_text
           then least(1.0, ts_rank_cd(to_tsvector('simple', d.title), v_text, 32) * 4) end::real,
      (select c.similarity from close_enough c where c.source_table = 'documents' and c.source_id = d.id)
    from app.documents d
    left join app.projects p on p.id = d.project_id
    where 'document' = any (v_allowed) and d.org_id = p_org_id and d.deleted_at is null
      and (
        (v_text is not null and to_tsvector('simple', d.title) @@ v_text)
        or d.id in (select c.source_id from close_enough c where c.source_table = 'documents')
        or (not v_has_text and not v_semantic))
      and (v_not is null or not (to_tsvector('simple', d.title) @@ v_not))
      and (v_project_ids is null or d.project_id = any (v_project_ids))
      and (v_exclude_project_ids is null or d.project_id is null or not (d.project_id = any (v_exclude_project_ids)))
      and (v_after is null or d.updated_at >= v_after)
      and (v_before is null or d.updated_at < v_before)
  ),
  knowledge_ranked as (
    select k.result_type, k.id, k.result_key, k.title, k.record_kind, k.state, k.project_key, k.dated_at,
      (case
        when k.lexical is not null and k.similarity is not null
          then greatest(k.lexical, k.similarity * 0.9) + 0.15 * least(k.lexical, k.similarity * 0.9)
        when k.lexical is not null then k.lexical
        when k.similarity is not null then k.similarity * 0.9
        else 0.5 end)::real as relevance,
      case when k.lexical is not null and k.similarity is not null then 'both'
           when k.similarity is not null then 'semantic'
           when k.lexical is not null then 'text' else 'filter' end as matched
    from knowledge k
    order by 9 desc, k.dated_at desc nulls last
    limit v_limit * 3
  ),
  everything as (
    select * from record_hits
    union all select * from incident_hits
    union all select * from people_hits
    union all select * from knowledge_ranked
  )
  select e.result_type, e.id, e.result_key, e.title, e.record_kind, e.state, e.project_key, e.dated_at,
    (e.relevance * (0.7 + 0.3 * exp(-greatest(0, extract(epoch from (now() - coalesce(e.dated_at, now()))) / 86400.0) / 45.0)))::real,
    e.matched
  from everything e
  order by 9 desc, e.dated_at desc nulls last, e.title;
end;
$$;

comment on function app.global_search(uuid, jsonb, extensions.vector, integer, real) is 'Global search (Section 11.7, Section 11.10 item 1, A87): records, incidents, people, documents, SOPs and handbook articles of an org, read with the caller''s own row level security (SECURITY INVOKER). p_query is the request @xos/data builds from the operator grammar: terms (prefix words), phrases, exclude_terms, exclude_phrases, types, exclude_types, kinds, exclude_kinds, projects, exclude_projects, assignees (me or a name), exclude_assignees, statuses (a state, open or closed), exclude_statuses, phases, urids, depts, is (blocked, open, closed, overdue, mine), after, before, due_after and due_before (a date or days from today on the org''s calendar) and model (the embedding model of p_embedding). Ranked by text relevance times recency; with p_embedding and search.semantic_enabled on, the nearest documents, SOPs and articles at or above p_min_similarity blend in. Up to p_limit results of each type (at most 50).';
revoke all on function app.global_search(uuid, jsonb, extensions.vector, integer, real) from public, anon;
grant execute on function app.global_search(uuid, jsonb, extensions.vector, integer, real) to authenticated, service_role;

create or replace function app.recent_items(p_org_id uuid, p_limit integer default 50)
returns table (
  result_type text,
  result_id uuid,
  result_key text,
  title text,
  record_kind text,
  state text,
  project_key text,
  viewed_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select x.result_type, x.result_id, x.result_key, x.title, x.record_kind, x.state, x.project_key, x.viewed_at
  from (
    select 'record'::text as result_type, r.id as result_id, p.project_key || '-' || r.record_number::text as result_key,
      r.title, r.record_kind::text as record_kind, r.record_state::text as state, p.project_key::text as project_key, v.viewed_at
    from app.recent_views v
    join app.records r on r.id = v.subject_id and r.deleted_at is null
    left join app.projects p on p.id = r.project_id
    where v.subject_table = 'records' and v.org_id = p_org_id and v.deleted_at is null
    union all
    select 'incident', i.id, p.project_key || '-' || i.incident_number::text, i.title, null, i.incident_state::text,
      p.project_key::text, v.viewed_at
    from app.recent_views v
    join app.incidents i on i.id = v.subject_id and i.deleted_at is null
    left join app.projects p on p.id = i.project_id
    where v.subject_table = 'incidents' and v.org_id = p_org_id and v.deleted_at is null
    union all
    select 'document', d.id, null, d.title, null, null, p.project_key::text, v.viewed_at
    from app.recent_views v
    join app.documents d on d.id = v.subject_id and d.deleted_at is null
    left join app.projects p on p.id = d.project_id
    where v.subject_table = 'documents' and v.org_id = p_org_id and v.deleted_at is null
    union all
    select 'sop', s.id, s.code::text, s.title, null, case when s.published_at is null then 'Draft' else 'Published' end, null, v.viewed_at
    from app.recent_views v
    join app.sops s on s.id = v.subject_id and s.deleted_at is null
    where v.subject_table = 'sops' and v.org_id = p_org_id and v.deleted_at is null
    union all
    select 'article', a.id, null, a.title, null, a.article_state::text, null, v.viewed_at
    from app.recent_views v
    join app.handbook_articles a on a.id = v.subject_id and a.deleted_at is null
    where v.subject_table = 'handbook_articles' and v.org_id = p_org_id and v.deleted_at is null
  ) x
  order by x.viewed_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 50);
$$;

comment on function app.recent_items(uuid, integer) is 'The signed-in person''s recently opened records, incidents, documents, SOPs and handbook articles in an org, newest first, at most 50 (Section 11.7: shown before they type). Read with their own row level security, so anything they can no longer read drops out.';
revoke all on function app.recent_items(uuid, integer) from public, anon;
grant execute on function app.recent_items(uuid, integer) to authenticated, service_role;
