-- 2190_gateway_search.sql
--
-- A126 (RRR-171), Section 11.10 item 1 (trace S11.10-02): search first in Gateway. The command menu (Cmd or Ctrl+K)
-- and the search field on the phone Home find the person's own engagements, opportunities, documents and messages, the
-- way Atlas's command menu finds an org's records (A87, ADR 0043). Gateway has no org to search inside: an external
-- party works with several orgs at once, so the search is scoped to the person, not to an org (ADR 0086).
--   * app.gateway_search(query, org, limit): SECURITY DEFINER, because the rows it reads (engagements, their
--     documents and threads, org-level conversations, opportunities) are reached by external parties only through the
--     owner-rights api_external projections (Section 8.7), never through row level security on the app tables. It
--     applies the same Section 8.7 helpers those projections apply, so it returns exactly what the person reads in
--     Gateway: engagements in their engagement area (private.my_engagement_ids('engagement')), the documents of
--     engagements whose documents area is open, the threads of their engagements and the org-level conversations they
--     are the party of (private.party_side_open), and opportunities they applied to or that are open to them in an org
--     they already work with, have applied to or talk to. Nothing from an org they have no relationship with, and
--     nothing for a caller who is not signed in. On an org's custom domain Gateway passes that org, and only its rows
--     come back (Section 4.4.7).
--   * The query is the structured request @xos/data builds (packages/data/src/search-query.ts): terms (each also a
--     prefix), quoted phrases, exclusions and types (engagement, opportunity, document, message). Raw text never
--     reaches the tsquery syntax. Ranking follows A87: ts_rank_cd over a 'simple' tsvector, the title weighted above
--     the body, times a recency factor with a 45-day decay on the date the item last changed.
--   * A message result is its thread, once, carrying the best-matching message's text, so the menu opens the
--     conversation at /messages/THR-...

-- 1. The words of a structured search request -----------------------------------------------------------------------

create or replace function private.search_request_tsquery(p_query jsonb)
returns tsquery
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_query jsonb := case when jsonb_typeof(p_query) = 'object' then p_query else '{}'::jsonb end;
  v_text tsquery;
  v_part text;
  v_term text;
begin
  -- Each word matches as a prefix. Lexemes come from the text search parser, so punctuation never reaches the tsquery
  -- syntax; at most 12 words and 4 phrases, as app.global_search reads them.
  foreach v_term in array (array(select jsonb_array_elements_text(
      case when jsonb_typeof(v_query->'terms') = 'array' then v_query->'terms' else '[]' end)))[1:12] loop
    select string_agg(format('%L', l.word) || ':*', ' & ') into v_part
    from (select regexp_replace(t.lexeme, '[''\\:&|!()<>*]', '', 'g') as word from unnest(to_tsvector('simple', v_term)) t) l
    where l.word <> '';
    if v_part is not null then
      v_text := case when v_text is null then v_part::tsquery else v_text && v_part::tsquery end;
    end if;
  end loop;
  foreach v_term in array (array(select jsonb_array_elements_text(
      case when jsonb_typeof(v_query->'phrases') = 'array' then v_query->'phrases' else '[]' end)))[1:4] loop
    if numnode(phraseto_tsquery('simple', v_term)) > 0 then
      v_text := case when v_text is null then phraseto_tsquery('simple', v_term) else v_text && phraseto_tsquery('simple', v_term) end;
    end if;
  end loop;
  return v_text;
end;
$$;

comment on function private.search_request_tsquery(jsonb) is 'The words of a structured search request (@xos/data search-query) as one ''simple'' tsquery: every term as a prefix and every quoted phrase, all required; null when the request has no words. At most 12 terms and 4 phrases (A126, as app.global_search reads them).';
revoke all on function private.search_request_tsquery(jsonb) from public, anon;
grant execute on function private.search_request_tsquery(jsonb) to authenticated, service_role;

create or replace function private.search_request_exclusions(p_query jsonb)
returns tsquery
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_query jsonb := case when jsonb_typeof(p_query) = 'object' then p_query else '{}'::jsonb end;
  v_not tsquery;
  v_term text;
begin
  foreach v_term in array (array(select jsonb_array_elements_text(
      case when jsonb_typeof(v_query->'exclude_terms') = 'array' then v_query->'exclude_terms' else '[]' end)))[1:12] loop
    if numnode(plainto_tsquery('simple', v_term)) > 0 then
      v_not := case when v_not is null then plainto_tsquery('simple', v_term) else v_not || plainto_tsquery('simple', v_term) end;
    end if;
  end loop;
  foreach v_term in array (array(select jsonb_array_elements_text(
      case when jsonb_typeof(v_query->'exclude_phrases') = 'array' then v_query->'exclude_phrases' else '[]' end)))[1:4] loop
    if numnode(phraseto_tsquery('simple', v_term)) > 0 then
      v_not := case when v_not is null then phraseto_tsquery('simple', v_term) else v_not || phraseto_tsquery('simple', v_term) end;
    end if;
  end loop;
  return v_not;
end;
$$;

comment on function private.search_request_exclusions(jsonb) is 'The excluded words and phrases of a structured search request as one ''simple'' tsquery that matches when any of them appears; null when nothing is excluded (A126).';
revoke all on function private.search_request_exclusions(jsonb) from public, anon;
grant execute on function private.search_request_exclusions(jsonb) to authenticated, service_role;

-- 2. The search --------------------------------------------------------------------------------------------------------

create or replace function app.gateway_search(p_query jsonb, p_org_id uuid default null, p_limit integer default 8)
returns table (
  result_type text,
  result_id uuid,
  parent_id uuid,
  kind text,
  title text,
  detail text,
  org_id uuid,
  org_name text,
  dated_at timestamptz,
  rank real
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_query jsonb := case when jsonb_typeof(p_query) = 'object' then p_query else '{}'::jsonb end;
  v_limit integer := least(greatest(coalesce(p_limit, 8), 1), 25);
  v_text tsquery;
  v_not tsquery;
  v_types text[];
  v_allowed text[] := array['engagement', 'opportunity', 'document', 'message'];
begin
  if auth.uid() is null or private.current_person_id() is null then
    return;
  end if;
  v_text := private.search_request_tsquery(v_query);
  if v_text is null then
    -- Nothing to search for: the menu lists pages and actions instead.
    return;
  end if;
  v_not := private.search_request_exclusions(v_query);
  v_types := array(select lower(x) from jsonb_array_elements_text(
    case when jsonb_typeof(v_query->'types') = 'array' then v_query->'types' else '[]' end) x);
  if cardinality(v_types) > 0 then
    v_allowed := array(select t from unnest(v_allowed) t where t = any (v_types));
  end if;
  v_allowed := array(select t from unnest(v_allowed) t where not (t = any (array(select lower(x) from jsonb_array_elements_text(
    case when jsonb_typeof(v_query->'exclude_types') = 'array' then v_query->'exclude_types' else '[]' end) x))));

  return query
  with
  my_engagements as (
    select e.id, e.org_id from app.engagements e
    where e.id in (select private.my_engagement_ids('engagement')) and (p_org_id is null or e.org_id = p_org_id)
  ),
  my_threads as (
    select t.id, 'engagement'::text as kind, t.subject, e.org_id, t.updated_at
    from app.engagement_threads t join my_engagements e on e.id = t.engagement_id
    where t.deleted_at is null
    union all
    select t.id, 'party', t.subject, t.org_id, t.updated_at
    from app.party_threads t
    where t.deleted_at is null and (p_org_id is null or t.org_id = p_org_id)
      and private.party_side_open(t.org_id, t.party_person_id, t.party_organization_id)
  ),
  my_applications as (
    select a.opportunity_id, a.org_id from app.applications a where a.id in (select private.my_application_ids())
  ),
  -- The orgs the person works with, has applied to or talks to: the only orgs whose open opportunities they search.
  related_orgs as (
    select e.org_id from my_engagements e
    union select t.org_id from my_threads t
    union select a.org_id from my_applications a
  ),
  engagement_hits as (
    select 'engagement'::text as result_type, e.id, null::uuid as parent_id, e.role_type::text as kind,
      r.job_title::text as title, p.name::text as detail, e.org_id, o.name::text as org_name, e.updated_at as dated_at,
      least(1.0, ts_rank_cd(v.doc, v_text, 33) * 4)::real as relevance
    from app.engagements e
    join my_engagements m on m.id = e.id
    join app.organizations o on o.id = e.org_id
    join app.projects p on p.id = e.project_id
    left join xpms.role r on r.role_code = e.role_code
    cross join lateral (select setweight(to_tsvector('simple', coalesce(r.job_title, '') || ' ' || p.name), 'A')
      || setweight(to_tsvector('simple', e.role_type::text || ' ' || o.name), 'D') as doc) v
    where 'engagement' = any (v_allowed) and v.doc @@ v_text and (v_not is null or not (v.doc @@ v_not))
    order by relevance desc, e.updated_at desc
    limit v_limit
  ),
  document_hits as (
    select 'document'::text, d.id, d.engagement_id, d.document_kind::text, d.title::text, p.name::text, e.org_id,
      o.name::text, d.updated_at,
      least(1.0, ts_rank_cd(to_tsvector('simple', d.title), v_text, 32) * 4)::real
    from app.engagement_documents d
    join app.engagements e on e.id = d.engagement_id
    join app.organizations o on o.id = e.org_id
    join app.projects p on p.id = e.project_id
    where 'document' = any (v_allowed) and d.deleted_at is null
      and d.engagement_id in (select private.my_engagement_ids('documents'))
      and (p_org_id is null or e.org_id = p_org_id)
      and to_tsvector('simple', d.title) @@ v_text
      and (v_not is null or not (to_tsvector('simple', d.title) @@ v_not))
    order by 10 desc, d.updated_at desc
    limit v_limit
  ),
  -- Every message of the person's threads, and each thread's subject alone (a thread whose subject matches).
  thread_texts as (
    select t.id as thread_id, t.kind, t.subject, t.org_id, m.body, m.sent_at as at
    from my_threads t join app.engagement_messages m on m.engagement_thread_id = t.id
    where t.kind = 'engagement'
    union all
    select t.id, t.kind, t.subject, t.org_id, m.body, m.sent_at
    from my_threads t join app.party_messages m on m.party_thread_id = t.id
    where t.kind = 'party'
    union all
    select t.id, t.kind, t.subject, t.org_id, null, t.updated_at from my_threads t
  ),
  message_matches as (
    select distinct on (x.thread_id) x.thread_id, x.kind, x.subject, x.org_id, x.body, x.at,
      least(1.0, ts_rank_cd(x.doc, v_text, 33) * 4)::real as relevance
    from (
      select tt.*, setweight(to_tsvector('simple', tt.subject), 'A') || setweight(to_tsvector('simple', coalesce(tt.body, '')), 'D') as doc
      from thread_texts tt
    ) x
    where 'message' = any (v_allowed) and x.doc @@ v_text and (v_not is null or not (x.doc @@ v_not))
    order by x.thread_id, ts_rank_cd(x.doc, v_text, 33) desc, x.at desc
  ),
  message_hits as (
    select 'message'::text, mm.thread_id, null::uuid, mm.kind, mm.subject::text,
      case when mm.body is null then null else left(regexp_replace(mm.body, '\s+', ' ', 'g'), 140) end, mm.org_id,
      o.name::text, mm.at, mm.relevance
    from message_matches mm join app.organizations o on o.id = mm.org_id
    order by mm.relevance desc, mm.at desc
    limit v_limit
  ),
  opportunity_hits as (
    select 'opportunity'::text, op.id, null::uuid, op.role_type::text, op.title::text, null::text, op.org_id,
      o.name::text, op.updated_at,
      least(1.0, ts_rank_cd(setweight(to_tsvector('simple', op.title), 'A') || setweight(to_tsvector('simple', coalesce(op.description, '')), 'D'), v_text, 33) * 4)::real
    from app.opportunities op
    join app.organizations o on o.id = op.org_id
    where 'opportunity' = any (v_allowed) and op.deleted_at is null and (p_org_id is null or op.org_id = p_org_id)
      and (op.id in (select a.opportunity_id from my_applications a)
        or (op.org_id in (select r.org_id from related_orgs r) and op.id in (select private.visible_opportunity_ids())))
      and (setweight(to_tsvector('simple', op.title), 'A') || setweight(to_tsvector('simple', coalesce(op.description, '')), 'D')) @@ v_text
      and (v_not is null or not ((setweight(to_tsvector('simple', op.title), 'A') || setweight(to_tsvector('simple', coalesce(op.description, '')), 'D')) @@ v_not))
    order by 10 desc, op.updated_at desc
    limit v_limit
  ),
  everything as (
    select * from engagement_hits
    union all select * from document_hits
    union all select * from message_hits
    union all select * from opportunity_hits
  )
  select e.result_type, e.id, e.parent_id, e.kind, e.title, e.detail, e.org_id, e.org_name, e.dated_at,
    (e.relevance * (0.7 + 0.3 * exp(-greatest(0, extract(epoch from (now() - coalesce(e.dated_at, now()))) / 86400.0) / 45.0)))::real
  from everything e
  order by 10 desc, e.dated_at desc nulls last, e.title;
end;
$$;

comment on function app.gateway_search(jsonb, uuid, integer) is 'Gateway search (Section 11.10 item 1, A126, ADR 0086): the signed-in person''s own engagements, engagement documents, conversations (engagement threads and org-level threads, one result per thread with the best-matching message) and opportunities (those they applied to, and those open to them in an org they work with, applied to or talk to). SECURITY DEFINER with the Section 8.7 helpers the api_external projections apply, so it returns only what the person reads in Gateway and nothing for a caller who is not signed in. p_query is the request @xos/data builds: terms (prefix words), phrases, exclude_terms, exclude_phrases, types and exclude_types (engagement, opportunity, document, message). p_org_id, on an org''s custom domain, keeps that org''s rows only. Ranked by text relevance (title above body) times recency (45-day decay), up to p_limit results of each type (at most 25).';
revoke all on function app.gateway_search(jsonb, uuid, integer) from public, anon;
grant execute on function app.gateway_search(jsonb, uuid, integer) to authenticated, service_role;
