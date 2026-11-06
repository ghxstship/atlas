-- 6501_live_link_payloads.sql
-- B2 (RRR-226, ADR 0141). A refactor of P1's live link reads (2781) with no change in behavior, so a stakeholder pack
-- (6502) can show a live link's rows without its token. Three helpers come out of the 2781 functions:
--   * private.live_link_owner_reason: whether the link's creator is still a member of the org who holds the
--     collection's read capability on the project. It checks under the creator's claims and restores the caller's
--     before it returns, so it never leaves the claims switched.
--   * private.live_view_payload and private.live_display_payload: the bodies of api_public.live_view and
--     api_public.live_display after the reader. Each switches the claims to the creator itself, reads exactly as
--     2781 did (removed, unsupported, rows or cues, channel and meta) and restores the caller's claims before it
--     returns.
-- private.live_link_reader keeps its signature and checks and now calls private.live_link_owner_reason; the claims
-- stay the caller's. api_public.live_view and api_public.live_display keep their signatures, grants and comments and
-- answer what they answered before; P1's pgTAP 2781 passes unchanged. A later package that touches
-- private.live_link_reader, api_public.live_view or api_public.live_display (B3's portal) starts from this migration.
-- The payloads carry 6125's rule: a time to be confirmed sends start_tbc, and a cue to be confirmed sends no planned_at.
-- Each function below starts from its latest definition (2781).

create or replace function private.live_link_owner_reason(p_link app.live_links, p_collection private.live_view_collections)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claims text := current_setting('request.jwt.claims', true);
  v_user uuid;
  v_allowed boolean;
begin
  select p.user_id into v_user from app.people p where p.id = p_link.created_by and p.deleted_at is null;
  if v_user is null then
    return 'live_link_owner_access';
  end if;
  -- Checked as the creator: the helpers the row level security policies use decide access.
  perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  v_allowed := private.is_member(p_link.org_id) and private.can_on_project(p_link.project_id, p_collection.read_capability);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return case when coalesce(v_allowed, false) then null else 'live_link_owner_access' end;
end;
$$;

comment on function private.live_link_owner_reason(app.live_links, private.live_view_collections) is 'Null when a live link''s creator is still a member of its org who holds the collection''s read capability on the project, checked under the creator''s claims; else live_link_owner_access. Restores the caller''s claims before it returns (6501).';
revoke all on function private.live_link_owner_reason(app.live_links, private.live_view_collections) from public, anon, authenticated;

-- The claims a payload reads under: the link's creator, as 1410 reads a feed as its owner.
create or replace function private.live_link_creator_claims(p_link app.live_links)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select json_build_object('sub', p.user_id, 'role', 'authenticated')::text
  from app.people p where p.id = p_link.created_by and p.deleted_at is null and p.user_id is not null;
$$;

comment on function private.live_link_creator_claims(app.live_links) is 'request.jwt.claims of a live link''s creator, which a live link payload reads under (6501); null when the creator has no sign-in.';
revoke all on function private.live_link_creator_claims(app.live_links) from public, anon, authenticated;

create or replace function private.live_link_reader(
  p_token text,
  p_grant text,
  p_client_address text,
  p_kind app.live_link_kind,
  out o_link app.live_links,
  out o_collection private.live_view_collections,
  out o_reason text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_subjects record;
  v_hash bytea;
  v_grant_hash bytea;
  v_granted boolean;
begin
  select * into v_subjects from private.live_link_subjects(p_client_address);
  if p_token is not null and p_token ~ (case p_kind when 'View' then '^xshv_[0-9a-f]{64}$' else '^xscr_[0-9a-f]{64}$' end) then
    v_hash := private.share_token_hash(p_token);
    select * into o_link from app.live_links l where l.token_hash = v_hash and l.link_kind = p_kind;
  end if;
  v_grant_hash := case when p_grant ~ '^xlgr_[0-9a-f]{64}$' then private.share_token_hash(p_grant) end;
  v_granted := o_link.id is not null and v_grant_hash is not null and exists (
    select 1 from private.live_link_grants g
    where g.grant_hash = v_grant_hash and g.live_link_id = o_link.id and g.expires_at > now()
  );
  -- The address failure limits stop guessing, so they apply only to a fetch without a valid grant: a device that
  -- already proved the code keeps reading, and nobody sharing its address (a venue's network, or the Atlas server's
  -- own egress) can blank its screen by spending that address's failures.
  if not v_granted and private.live_link_rate_limited(v_subjects.o_hop, v_subjects.o_subject) then
    o_reason := 'live_link_rate_limited';
    return;
  end if;
  if o_link.id is null then
    if v_hash is null or not exists (select 1 from private.retired_live_link_tokens r where r.token_hash = v_hash) then
      perform private.note_live_link_failure(v_subjects.o_hop, v_subjects.o_subject);
    end if;
    o_reason := 'live_link_invalid';
    return;
  end if;
  if o_link.revoked_at is not null or o_link.deleted_at is not null then
    o_reason := 'live_link_invalid';
  elsif o_link.expires_at <= now() then
    o_reason := 'live_link_expired';
  end if;
  -- A link locked by wrong codes keeps serving the devices that already proved the code: the lock stops guessing, and
  -- must not let anyone holding the address blank every screen.
  if o_reason is not null then
    return;
  end if;

  if not v_granted then
    o_reason := 'live_link_grant';
    return;
  end if;
  -- Per grant, so one screen cannot exhaust its neighbors; per link, a ceiling for the link as a whole.
  if private.rate_limit_exceeded('live_link.fetch', encode(v_grant_hash, 'hex'), 1200, interval '1 hour')
     or private.rate_limit_exceeded('live_link.link_fetch', o_link.id::text, 60000, interval '1 hour') then
    o_reason := 'live_link_rate_limited';
    return;
  end if;
  perform private.note_rate_event('live_link.fetch', encode(v_grant_hash, 'hex'));
  perform private.note_rate_event('live_link.link_fetch', o_link.id::text);

  select * into o_collection from private.live_view_collections c
  where c.collection_key = private.live_link_collection_key(o_link.link_kind, o_link.saved_view_id);
  if o_collection.collection_key is null then
    o_reason := 'live_link_view_unsupported';
    return;
  end if;
  if exists (
    select 1 from private.live_view_fields f
    cross join lateral unnest(f.source_columns) as col (name)
    join private.column_classifications cc on cc.table_name = f.source_table and cc.column_name = col.name
    where f.collection_key = o_collection.collection_key and cc.classification in ('Confidential', 'Restricted')
  ) then
    o_reason := 'live_link_reclassified';
    return;
  end if;

  o_reason := private.live_link_owner_reason(o_link, o_collection);
end;
$$;

comment on function private.live_link_reader(text, text, text, app.live_link_kind) is 'Checks a live link read: the address failure limits (only without a valid device grant, so a proven screen is never blanked by its address''s failures), the token (live_link_invalid, live_link_expired), the device grant (live_link_grant), 1200 fetches an hour per grant and 60000 per link (live_link_rate_limited), the allowlist''s classification (live_link_reclassified), and that the creator is still a member who holds the collection''s read capability on the project (live_link_owner_access, private.live_link_owner_reason). The claims stay the caller''s; the payload helpers read as the creator (6501).';
revoke all on function private.live_link_reader(text, text, text, app.live_link_kind) from public, anon, authenticated;

create or replace function private.live_view_payload(p_link app.live_links, p_collection private.live_view_collections)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claims text := current_setting('request.jwt.claims', true);
  v_creator text := private.live_link_creator_claims(p_link);
  v_view app.saved_views;
  v_filters jsonb;
  v_sorts jsonb;
  v_rows jsonb;
  v_arranged record;
  v_channel text;
  v_truncated boolean := false;
begin
  if v_creator is null then
    return private.live_link_refusal('live_link_owner_access');
  end if;
  -- From here the payload reads as the link's creator: the helpers the row level security policies use decide access.
  perform set_config('request.jwt.claims', v_creator, true);

  select * into v_view from app.saved_views v
  where v.id = p_link.saved_view_id and v.deleted_at is null and v.id in (select private.readable_saved_view_ids());
  if v_view.id is null then
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    return private.live_link_refusal('live_link_view_removed');
  end if;
  if not private.live_view_supported(v_view.id, p_link.project_id) then
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    return private.live_link_refusal('live_link_view_unsupported');
  end if;
  v_filters := private.live_view_filters(v_view.id, p_link.project_id);
  select coalesce(jsonb_agg(jsonb_build_object('key', s.field, 'descending', s.direction = 'Descending') order by s.position), '[]'::jsonb)
  into v_sorts
  from app.saved_view_sorts s where s.saved_view_id = v_view.id and s.deleted_at is null;

  if p_collection.collection_key = 'project/schedule' then
    -- The Schedule page's dated records (datedOnly): a start, an end or a due date.
    select coalesce(jsonb_agg(jsonb_build_object(
        'o', jsonb_build_object('key', p.project_key || '-' || r.record_number::text, 'title', r.title, 'kind', r.record_kind,
          'subtype', r.record_subtype, 'state', r.record_state, 'phase', r.phase_code, 'starts_at', r.starts_at, 'start_tbc', r.start_tbc,
          'ends_at', r.ends_at, 'due_at', r.due_at, 'time_zone', r.time_zone, 'scope_node', n.name),
        's', jsonb_build_object('id', r.id::text, 'key', lpad(r.record_number::text, 20, '0'), 'title', lower(r.title),
          'state', lpad(coalesce(st.ordinal, 9999)::text, 4, '0'),
          'next', private.live_view_instant_key(coalesce(r.starts_at, r.due_at))),
        't', r.title)), '[]'::jsonb)
    into v_rows
    from app.records r
    join app.projects p on p.id = r.project_id
    left join app.scope_nodes n on n.id = r.scope_node_id and n.deleted_at is null
    left join xpms.dim_record_state st on st.record_state = r.record_state
    where r.project_id = p_link.project_id and r.deleted_at is null
      and r.project_id in (select private.project_ids_with('work.record.read'))
      and (r.starts_at is not null or r.ends_at is not null or r.due_at is not null);
    select * into v_arranged from private.live_view_arrange(v_rows, v_filters, v_view.search_text, v_sorts, array['key'], p_collection.max_rows);
    v_rows := v_arranged.o_rows;
    v_truncated := v_arranged.o_truncated;

  elsif p_collection.collection_key in ('project/show', 'show/run_of_show') then
    select coalesce(jsonb_agg(jsonb_build_object(
        'o', jsonb_build_object('id', r.id, 'name', r.name, 'show_date', r.show_date),
        's', jsonb_build_object('id', r.id::text, 'name', lower(r.name), 'show_date', to_char(r.show_date, 'YYYY-MM-DD')),
        't', r.name)), '[]'::jsonb)
    into v_rows
    from app.run_of_show r
    where r.project_id = p_link.project_id and r.deleted_at is null
      and r.project_id in (select private.project_ids_with('show.run_of_show.read'));
    select * into v_arranged from private.live_view_arrange(v_rows, v_filters, v_view.search_text, v_sorts, array['show_date', 'name'],
      p_collection.max_rows);
    v_truncated := v_arranged.o_truncated;
    -- Cues of the kept running orders, in order: at most 300 each and 3000 in all.
    with runs as (
      select (e ->> 'id')::uuid as id, n, e - 'id' as o
      from jsonb_array_elements(v_arranged.o_rows) with ordinality as x (e, n)
    ),
    ranked as (
      select c.run_of_show_id, c.position, jsonb_build_object('position', c.position, 'label', c.label, 'segment', c.segment,
          'planned_at', case when c.start_tbc then null else c.planned_at end, 'start_tbc', c.start_tbc, 'duration_seconds', floor(extract(epoch from c.duration))::bigint, 'called_at', c.called_at) as o,
        row_number() over (partition by c.run_of_show_id order by c.position) as in_run,
        row_number() over (order by runs.n, c.position) as overall
      from runs join app.cues c on c.run_of_show_id = runs.id and c.deleted_at is null
    ),
    kept as (
      select * from ranked where in_run <= coalesce(p_collection.max_cues, 300) and overall <= 3000
    )
    select coalesce(jsonb_agg(runs.o || jsonb_build_object('cues', coalesce((
        select jsonb_agg(k.o order by k.position) from kept k where k.run_of_show_id = runs.id), '[]'::jsonb))
        order by runs.n), '[]'::jsonb),
      v_truncated or exists (select 1 from ranked where in_run > coalesce(p_collection.max_cues, 300) or overall > 3000)
    into v_rows, v_truncated
    from runs;

  elsif p_collection.collection_key = 'show/day_sheets' then
    -- Published day sheets only; the body is plain text to the page.
    select coalesce(jsonb_agg(jsonb_build_object(
        'o', jsonb_build_object('day', d.day, 'body', d.body, 'published_at', d.published_at),
        's', jsonb_build_object('id', d.id::text, 'day', to_char(d.day, 'YYYY-MM-DD')),
        't', to_char(d.day, 'YYYY-MM-DD') || ' ' || d.body)), '[]'::jsonb)
    into v_rows
    from app.day_sheets d
    where d.project_id = p_link.project_id and d.deleted_at is null and d.published_at is not null
      and d.project_id in (select private.project_ids_with('show.run_of_show.read'));
    select * into v_arranged from private.live_view_arrange(v_rows, v_filters, v_view.search_text, v_sorts, array['day'], p_collection.max_rows);
    v_rows := v_arranged.o_rows;
    v_truncated := v_arranged.o_truncated;
  end if;

  select 'xlink:' || c.channel_key into v_channel from private.live_link_channels c where c.live_link_id = p_link.id;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return jsonb_build_object(
    'status', 'ok',
    'meta', private.live_link_meta(p_link) || jsonb_build_object('collection_key', p_collection.collection_key,
      'view_name', v_view.name, 'view_type', v_view.view_type, 'group_by_field', v_view.group_by_field),
    'channel', v_channel,
    'server_now', now(),
    'rows', v_rows,
    'truncated', v_truncated);
end;
$$;

comment on function private.live_view_payload(app.live_links, private.live_view_collections) is 'What a saved view live link shows, read as its creator (6501, the body of api_public.live_view): live_link_view_removed when the saved view is deleted or no longer readable by the creator, live_link_view_unsupported when it now filters, sorts or groups outside the allowlist; else meta, the Realtime channel, server_now and the allowlisted rows, filtered, searched, sorted and capped with a truncated flag. Switches the claims to the creator and restores the caller''s before it returns. Read by api_public.live_view and api_public.stakeholder_pack_item.';
revoke all on function private.live_view_payload(app.live_links, private.live_view_collections) from public, anon, authenticated;

create or replace function private.live_display_payload(p_link app.live_links, p_collection private.live_view_collections)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claims text := current_setting('request.jwt.claims', true);
  v_creator text := private.live_link_creator_claims(p_link);
  v_run app.run_of_show;
  v_cues jsonb;
  v_channel text;
begin
  if v_creator is null then
    return private.live_link_refusal('live_link_owner_access');
  end if;
  perform set_config('request.jwt.claims', v_creator, true);

  select * into v_run from app.run_of_show r
  where r.id = p_link.run_of_show_id and r.deleted_at is null
    and r.project_id in (select private.project_ids_with('show.run_of_show.read'));
  if v_run.id is null then
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    return private.live_link_refusal('live_link_view_removed');
  end if;

  select coalesce(jsonb_agg(x.o order by x.position), '[]'::jsonb) into v_cues
  from (
    select c.position, jsonb_build_object('position', c.position, 'label', c.label, 'segment', c.segment,
      'planned_at', case when c.start_tbc then null else c.planned_at end, 'start_tbc', c.start_tbc, 'duration_seconds', floor(extract(epoch from c.duration))::bigint, 'called_at', c.called_at) as o
    from app.cues c
    where c.run_of_show_id = v_run.id and c.deleted_at is null
    order by c.position
    limit coalesce(p_collection.max_cues, 300)
  ) x;

  select 'xlink:' || c.channel_key into v_channel from private.live_link_channels c where c.live_link_id = p_link.id;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return jsonb_build_object(
    'status', 'ok',
    'meta', private.live_link_meta(p_link) || jsonb_build_object('name', v_run.name, 'show_date', v_run.show_date,
      'default_mode', p_link.default_mode),
    'channel', v_channel,
    'server_now', now(),
    'cues', v_cues);
end;
$$;

comment on function private.live_display_payload(app.live_links, private.live_view_collections) is 'What a display screen link shows, read as its creator (6501, the body of api_public.live_display): live_link_view_removed when the running order is deleted; else meta, the Realtime channel, server_now and at most 300 cues in order. Switches the claims to the creator and restores the caller''s before it returns. Read by api_public.live_display and api_public.stakeholder_pack_item.';
revoke all on function private.live_display_payload(app.live_links, private.live_view_collections) from public, anon, authenticated;

create or replace function api_public.live_view(p_token text, p_grant text, p_client_address text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_read record;
begin
  select * into v_read from private.live_link_reader(p_token, p_grant, p_client_address, 'View');
  if v_read.o_reason is not null then
    return private.live_link_refusal(v_read.o_reason);
  end if;
  return private.live_view_payload(v_read.o_link, v_read.o_collection);
end;
$$;

comment on function api_public.live_view(text, text, text) is 'Reads a saved view live link with its device grant (ADR 0130; Section 7.5 invariant 8), acting as the link''s creator. Refuses as private.live_link_reader does, and live_link_view_removed when the saved view is deleted or no longer readable by the creator, live_link_view_unsupported when it now filters, sorts or groups by a field outside the allowlist. Answers JSON: meta (brand, project name and zone, view name, type and grouping, expiry), the Realtime channel, server_now, and rows built from allowlisted columns only, filtered, searched, sorted and capped with a truncated flag. Writes only rate events.';
revoke all on function api_public.live_view(text, text, text) from public;
grant execute on function api_public.live_view(text, text, text) to anon, authenticated, service_role;

create or replace function api_public.live_display(p_token text, p_grant text, p_client_address text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_read record;
begin
  select * into v_read from private.live_link_reader(p_token, p_grant, p_client_address, 'Display');
  if v_read.o_reason is not null then
    return private.live_link_refusal(v_read.o_reason);
  end if;
  return private.live_display_payload(v_read.o_link, v_read.o_collection);
end;
$$;

comment on function api_public.live_display(text, text, text) is 'Reads a display screen link with its device grant (ADR 0130; Section 7.5 invariant 8), acting as the link''s creator. Refuses as private.live_link_reader does, and live_link_view_removed when the running order is deleted. Answers JSON: meta (brand, project name and zone, running order name and show day, default mode, expiry), the Realtime channel, server_now and the cues in order (position, label, segment, planned_at, duration_seconds, called_at; never who called a cue, its description or its cue calls), at most 300.';
revoke all on function api_public.live_display(text, text, text) from public;
grant execute on function api_public.live_display(text, text, text) to anon, authenticated, service_role;
