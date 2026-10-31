-- 2781_live_link_reads.sql
-- P1 (RRR-215, ADR 0130). The anonymous side of live links (2780): token RPCs in the sense of Section 7.5 invariant
-- 8, as ADR 0033 decision 56 words it. Each needs the token and, to open, the access code; links expire; failures are
-- rate limited; and each answers only the fields the page renders. Execute is granted to anon.
--   * api_public.open_live_link checks a link the way 1380's open_share_link does: a read-only (GET) call is refused
--     first, then the per-address failure limit (20 in 10 minutes, keyed by the address the Atlas route relays under
--     the address that reached PostgREST, as 1410), and a hop limit (2000 in 15 minutes), then the link row is locked
--     before the code is compared and 5 wrong codes lock the link. A correct code earns a device grant (xlgr_), kept
--     by the page in an HttpOnly cookie, so later reads need no code (as 1380's download ticket carries a download).
--   * api_public.live_view and api_public.live_display read the link with its grant. Each grant may fetch 1200 times
--     an hour and each link 60000 times, so many screens on one link never lock each other out. The read acts as the
--     link's creator (request.jwt.claims, as 1410 does) and stops when the creator is no longer a member of the org
--     or no longer holds the collection's read capability on the project (live_link_owner_access). The function
--     runs as its definer, which bypasses row level security, so every query applies its table's read predicate
--     explicitly: the project, the read capability, deleted_at, and for day sheets publication.
--   * A view whose saved view is deleted, or no longer readable by its creator, answers live_link_view_removed; one
--     that now filters, sorts or groups by a field outside the allowlist answers live_link_view_unsupported, so it
--     never silently widens; one whose fields were classified Confidential or Restricted answers
--     live_link_reclassified. A display whose running order is deleted answers live_link_view_removed.
--   * Rows are built with jsonb_build_object from allowlisted columns only, filtered by the saved view's filters,
--     searched by its search text (records by title, running orders by name, day sheets by day and body, all ILIKE),
--     sorted by its sorts and capped with a truncated flag: 500 records, 120 day sheets, 200 running orders with at
--     most 300 cues each and 3000 in all. A display screen gets at most 300 cues.
--   * Nothing is written except rate events, the open count and grants.

-- Shared helpers -------------------------------------------------------------------------------------------------------

-- Sort keys are text that sorts like the value: instants in UTC ISO form, numbers zero-padded, text lowercased.
create or replace function private.live_view_instant_key(p_at timestamptz)
returns text
language sql
immutable
set search_path = ''
as $$
  select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US');
$$;

comment on function private.live_view_instant_key(timestamptz) is 'An instant as text that sorts in time order (UTC, ISO 8601, microseconds), for live link sort keys.';
revoke all on function private.live_view_instant_key(timestamptz) from public, anon, authenticated;

-- Whether one row passes the saved view's filters (private.live_view_filters), on the shown value. eq, ne, contains
-- and is_null compare the shown text ignoring case, as the Add filter control's matchesShown does; lt, lte, gt and gte
-- compare numbers, dates and instants by their type; in is a page parameter's comma-separated list.
create or replace function private.live_view_row_matches(p_row jsonb, p_filters jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_filter jsonb;
  v_shown text;
  v_wanted text;
  v_cmp integer;
begin
  for v_filter in select f from jsonb_array_elements(coalesce(p_filters, '[]'::jsonb)) f loop
    v_shown := p_row ->> (v_filter ->> 'key');
    v_wanted := v_filter ->> 'value';
    case v_filter ->> 'operator'
      when 'in' then
        if v_shown is null or not (v_shown = any (array(
          select btrim(x) from unnest(string_to_array(v_wanted, ',')) x where btrim(x) <> ''))) then
          return false;
        end if;
      when 'eq' then
        if lower(btrim(coalesce(v_shown, ''))) <> lower(btrim(v_wanted)) then return false; end if;
      when 'ne' then
        if lower(btrim(coalesce(v_shown, ''))) = lower(btrim(v_wanted)) then return false; end if;
      when 'contains' then
        if strpos(lower(coalesce(v_shown, '')), lower(btrim(v_wanted))) = 0 then return false; end if;
      when 'is_null' then
        if (coalesce(btrim(v_shown), '') = '') <> (lower(btrim(v_wanted)) <> 'false') then return false; end if;
      else
        if v_shown is null or btrim(v_shown) = '' then
          return false;
        end if;
        begin
          v_cmp := case v_filter ->> 'type'
            when 'number' then sign(v_shown::numeric - v_wanted::numeric)::integer
            when 'date' then sign(v_shown::date - v_wanted::date)::integer
            when 'instant' then sign(extract(epoch from v_shown::timestamptz - v_wanted::timestamptz))::integer
            else case when lower(v_shown) < lower(v_wanted) then -1 when lower(v_shown) > lower(v_wanted) then 1 else 0 end
          end;
        exception when others then
          return false;
        end;
        if not (case v_filter ->> 'operator'
          when 'lt' then v_cmp < 0 when 'lte' then v_cmp <= 0 when 'gt' then v_cmp > 0 when 'gte' then v_cmp >= 0 else false
        end) then
          return false;
        end if;
    end case;
  end loop;
  return true;
end;
$$;

comment on function private.live_view_row_matches(jsonb, jsonb) is 'True when a live link row passes every filter of its saved view: eq, ne, contains and is_null on the shown text ignoring case; lt, lte, gt and gte by the field''s type (number, date, instant, else text); in for a page parameter''s comma-separated list. A value that does not parse as the type never matches.';
revoke all on function private.live_view_row_matches(jsonb, jsonb) from public, anon, authenticated;

-- Filters, searches, sorts and caps a list of {o, s, t} rows (o the row, s its sort keys, t its search text).
-- p_sorts is a list of {key, descending}; every key was checked sortable. The default sort follows them.
create or replace function private.live_view_arrange(
  p_rows jsonb,
  p_filters jsonb,
  p_search text,
  p_sorts jsonb,
  p_default_sorts text[],
  p_limit integer,
  out o_rows jsonb,
  out o_truncated boolean
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_order text := '';
  v_sort jsonb;
  v_key text;
  v_like text := case when nullif(btrim(coalesce(p_search, '')), '') is null then null
    else '%' || regexp_replace(btrim(p_search), '([%_\\])', '\\\1', 'g') || '%' end;
  v_count integer;
begin
  for v_sort in select s from jsonb_array_elements(coalesce(p_sorts, '[]'::jsonb)) s loop
    v_order := v_order || format('e -> ''s'' ->> %L %s nulls last, ', v_sort ->> 'key',
      case when (v_sort ->> 'descending')::boolean then 'desc' else 'asc' end);
  end loop;
  foreach v_key in array coalesce(p_default_sorts, '{}'::text[]) loop
    v_order := v_order || format('e -> ''s'' ->> %L asc nulls last, ', v_key);
  end loop;
  v_order := v_order || 'e -> ''s'' ->> ''id'' asc';
  execute format(
    'select coalesce(jsonb_agg(x.e -> ''o'' order by x.n), ''[]''::jsonb), count(*)::integer from (
       select e, row_number() over (order by %s) as n from jsonb_array_elements($1) e
       where private.live_view_row_matches(e -> ''o'', $2) and ($3::text is null or (e ->> ''t'') ilike $3)
       order by %s limit $4) x', v_order, v_order)
  into o_rows, v_count
  using coalesce(p_rows, '[]'::jsonb), p_filters, v_like, p_limit + 1;
  o_truncated := v_count > p_limit;
  if o_truncated then
    o_rows := o_rows - p_limit;
  end if;
end;
$$;

comment on function private.live_view_arrange(jsonb, jsonb, text, jsonb, text[], integer) is 'Arranges a live link''s rows: keeps those passing the saved view''s filters and matching its search text (ILIKE), orders them by its sorts then the collection''s default sort, and caps them, saying whether rows were cut.';
revoke all on function private.live_view_arrange(jsonb, jsonb, text, jsonb, text[], integer) from public, anon, authenticated;

-- The page heading every link carries: the org brand's Public columns, the project's name and zone.
create or replace function private.live_link_meta(p_link app.live_links)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'project_name', p.name,
    'time_zone', coalesce(nullif(btrim(p.time_zone), ''), private.calendar_feed_setting(p_link.org_id, null, 'locale.time_zone'), 'UTC'),
    'brand_name', coalesce(b.display_name, o.name),
    'brand_logo_light_path', b.logo_light_path,
    'brand_logo_dark_path', b.logo_dark_path,
    'brand_accent_hex', b.accent_hex,
    'brand_suppress_powered_by', coalesce(b.suppress_powered_by, false),
    'expires_at', p_link.expires_at,
    'link_kind', p_link.link_kind)
  from app.projects p
  join app.organizations o on o.id = p_link.org_id
  left join app.org_brands b on b.org_id = p_link.org_id and b.deleted_at is null
  where p.id = p_link.project_id;
$$;

comment on function private.live_link_meta(app.live_links) is 'Heading of a live link page: the project''s name and zone (else the org''s locale.time_zone, else UTC), the org brand''s Public columns (name, logos, accent, whether Powered by XOS is suppressed), the expiry and the kind. Never the link''s note.';
revoke all on function private.live_link_meta(app.live_links) from public, anon, authenticated;

-- The address subjects failed lookups count against: the relayed client address under the address that reached
-- PostgREST, and the reaching address itself (1410).
create or replace function private.live_link_subjects(p_client_address text, out o_hop text, out o_subject text)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_client text;
begin
  o_hop := coalesce(host(private.request_ip()), 'unknown');
  begin
    v_client := host(nullif(btrim(left(coalesce(p_client_address, ''), 64)), '')::inet);
  exception when invalid_text_representation then
    v_client := null;
  end;
  o_subject := o_hop || ' ' || coalesce(v_client, o_hop);
end;
$$;

comment on function private.live_link_subjects(text) is 'Who a live link failure counts against: the address the Atlas route relays (clientAddress(), A69-003) scoped under the address that reached PostgREST (private.request_ip(), A69-002), and that reaching address alone.';
revoke all on function private.live_link_subjects(text) from public, anon, authenticated;

create or replace function private.live_link_rate_limited(p_hop text, p_subject text)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select private.rate_limit_exceeded('live_link.failure', p_subject, 20, interval '10 minutes')
    or private.rate_limit_exceeded('live_link.hop_failure', p_hop, 2000, interval '15 minutes');
$$;

comment on function private.live_link_rate_limited(text, text) is 'True when an address used up its live link failures: 20 per relayed address in 10 minutes, or 2000 per reaching address in 15 minutes. Refuses a read-only transaction first, as every failure count does (A69-001).';
revoke all on function private.live_link_rate_limited(text, text) from public, anon, authenticated;

create or replace function private.note_live_link_failure(p_hop text, p_subject text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  select private.note_rate_event('live_link.failure', p_subject);
  select private.note_rate_event('live_link.hop_failure', p_hop);
$$;

comment on function private.note_live_link_failure(text, text) is 'Counts one failed live link lookup or wrong code against the relayed and the reaching address.';
revoke all on function private.note_live_link_failure(text, text) from public, anon, authenticated;

create or replace function private.live_link_refusal(p_reason text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('status', 'refused', 'reason', p_reason);
$$;

comment on function private.live_link_refusal(text) is 'The JSON every live link token RPC answers a refusal with: status refused and the reason.';
revoke all on function private.live_link_refusal(text) from public, anon, authenticated;

-- Opening a link ------------------------------------------------------------------------------------------------------

create or replace function api_public.open_live_link(p_token text, p_access_code text default null, p_client_address text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_subjects record;
  v_hash bytea;
  v_link app.live_links;
  v_grant text;
  v_grant_expires timestamptz;
begin
  perform private.require_read_write();
  select * into v_subjects from private.live_link_subjects(p_client_address);
  if private.live_link_rate_limited(v_subjects.o_hop, v_subjects.o_subject) then
    return private.live_link_refusal('live_link_rate_limited');
  end if;

  if p_token is not null and p_token ~ '^xs(hv|cr)_[0-9a-f]{64}$' then
    v_hash := private.share_token_hash(p_token);
    select * into v_link from app.live_links l where l.token_hash = v_hash for update;
  end if;
  if v_link.id is null then
    -- A regenerated or revoked token is a screen left open, not a guess.
    if v_hash is null or not exists (select 1 from private.retired_live_link_tokens r where r.token_hash = v_hash) then
      perform private.note_live_link_failure(v_subjects.o_hop, v_subjects.o_subject);
    end if;
    return private.live_link_refusal('live_link_invalid');
  end if;
  if v_link.revoked_at is not null or v_link.deleted_at is not null then
    return private.live_link_refusal('live_link_invalid');
  end if;
  if v_link.failed_attempts >= 5 then
    perform private.note_live_link_failure(v_subjects.o_hop, v_subjects.o_subject);
    return private.live_link_refusal('live_link_locked');
  end if;
  if v_link.expires_at <= now() then
    return private.live_link_refusal('live_link_expired');
  end if;
  if nullif(btrim(coalesce(p_access_code, '')), '') is null then
    return private.live_link_refusal('live_link_access_code_required');
  end if;
  if v_link.access_code_hash <> private.share_code_hash(p_token, p_access_code) then
    perform private.begin_trusted_operation('live_link_service');
    update app.live_links l set failed_attempts = least(l.failed_attempts + 1, 5) where l.id = v_link.id;
    perform private.end_trusted_operation('live_link_service');
    perform private.note_live_link_failure(v_subjects.o_hop, v_subjects.o_subject);
    return private.live_link_refusal(case when v_link.failed_attempts + 1 >= 5 then 'live_link_locked' else 'live_link_access_code' end);
  end if;

  delete from private.live_link_grants g where g.expires_at < now() - interval '1 day';
  v_grant := 'xlgr_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_grant_expires := least(v_link.expires_at, now() + interval '7 days');
  insert into private.live_link_grants (grant_hash, live_link_id, expires_at)
  values (private.share_token_hash(v_grant), v_link.id, v_grant_expires);

  perform private.begin_trusted_operation('live_link_service');
  update app.live_links l set open_count = l.open_count + 1, last_opened_at = now() where l.id = v_link.id;
  perform private.end_trusted_operation('live_link_service');

  return jsonb_build_object('status', 'ok', 'grant', v_grant, 'grant_expires_at', v_grant_expires, 'kind', v_link.link_kind);
end;
$$;

comment on function api_public.open_live_link(text, text, text) is 'Opens a live link without an account (ADR 0130; Section 7.5 invariant 8). Refuses a read-only (GET) call first; then, unless the address used up its failures (20 per relayed address p_client_address in 10 minutes, 2000 per reaching address in 15), locks the link row and checks it: unknown, revoked or deleted (live_link_invalid; a retired token never counts a failure), locked after 5 wrong codes, expired, code missing, or wrong code (counted). Answers JSON: status refused with the reason, or status ok with a device grant valid until the link expires or for 7 days, its expiry and the link kind. Counts the open.';
revoke all on function api_public.open_live_link(text, text, text) from public;
grant execute on function api_public.open_live_link(text, text, text) to anon, authenticated, service_role;

-- Reading a link ------------------------------------------------------------------------------------------------------

-- Checks a token and grant and, on success, switches request.jwt.claims to the link's creator; the caller restores
-- the claims it saved. Refusals come back as o_reason with the claims unchanged.
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
  v_user uuid;
  v_claims text := current_setting('request.jwt.claims', true);
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

  select p.user_id into v_user from app.people p where p.id = o_link.created_by and p.deleted_at is null;
  if v_user is null then
    o_reason := 'live_link_owner_access';
    return;
  end if;
  -- From here the link reads as its creator: the helpers the row level security policies use decide access.
  perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  if not private.is_member(o_link.org_id) or not private.can_on_project(o_link.project_id, o_collection.read_capability) then
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    o_reason := 'live_link_owner_access';
  end if;
end;
$$;

comment on function private.live_link_reader(text, text, text, app.live_link_kind) is 'Checks a live link read: the address failure limits (only without a valid device grant, so a proven screen is never blanked by its address''s failures), the token (live_link_invalid, live_link_expired), the device grant (live_link_grant), 1200 fetches an hour per grant and 60000 per link (live_link_rate_limited), the allowlist''s classification (live_link_reclassified), and that the creator is still a member who holds the collection''s read capability on the project (live_link_owner_access). On success the claims are the creator''s; the caller restores its own.';
revoke all on function private.live_link_reader(text, text, text, app.live_link_kind) from public, anon, authenticated;

create or replace function api_public.live_view(p_token text, p_grant text, p_client_address text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_claims text := current_setting('request.jwt.claims', true);
  v_read record;
  v_link app.live_links;
  v_collection private.live_view_collections;
  v_view app.saved_views;
  v_filters jsonb;
  v_sorts jsonb;
  v_rows jsonb;
  v_arranged record;
  v_channel text;
  v_truncated boolean := false;
begin
  select * into v_read from private.live_link_reader(p_token, p_grant, p_client_address, 'View');
  if v_read.o_reason is not null then
    return private.live_link_refusal(v_read.o_reason);
  end if;
  v_link := v_read.o_link;
  v_collection := v_read.o_collection;

  select * into v_view from app.saved_views v
  where v.id = v_link.saved_view_id and v.deleted_at is null and v.id in (select private.readable_saved_view_ids());
  if v_view.id is null then
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    return private.live_link_refusal('live_link_view_removed');
  end if;
  if not private.live_view_supported(v_view.id, v_link.project_id) then
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    return private.live_link_refusal('live_link_view_unsupported');
  end if;
  v_filters := private.live_view_filters(v_view.id, v_link.project_id);
  select coalesce(jsonb_agg(jsonb_build_object('key', s.field, 'descending', s.direction = 'Descending') order by s.position), '[]'::jsonb)
  into v_sorts
  from app.saved_view_sorts s where s.saved_view_id = v_view.id and s.deleted_at is null;

  if v_collection.collection_key = 'project/schedule' then
    -- The Schedule page's dated records (datedOnly): a start, an end or a due date.
    select coalesce(jsonb_agg(jsonb_build_object(
        'o', jsonb_build_object('key', p.project_key || '-' || r.record_number::text, 'title', r.title, 'kind', r.record_kind,
          'subtype', r.record_subtype, 'state', r.record_state, 'phase', r.phase_code, 'starts_at', r.starts_at,
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
    where r.project_id = v_link.project_id and r.deleted_at is null
      and r.project_id in (select private.project_ids_with('work.record.read'))
      and (r.starts_at is not null or r.ends_at is not null or r.due_at is not null);
    select * into v_arranged from private.live_view_arrange(v_rows, v_filters, v_view.search_text, v_sorts, array['key'], v_collection.max_rows);
    v_rows := v_arranged.o_rows;
    v_truncated := v_arranged.o_truncated;

  elsif v_collection.collection_key in ('project/show', 'show/run_of_show') then
    select coalesce(jsonb_agg(jsonb_build_object(
        'o', jsonb_build_object('id', r.id, 'name', r.name, 'show_date', r.show_date),
        's', jsonb_build_object('id', r.id::text, 'name', lower(r.name), 'show_date', to_char(r.show_date, 'YYYY-MM-DD')),
        't', r.name)), '[]'::jsonb)
    into v_rows
    from app.run_of_show r
    where r.project_id = v_link.project_id and r.deleted_at is null
      and r.project_id in (select private.project_ids_with('show.run_of_show.read'));
    select * into v_arranged from private.live_view_arrange(v_rows, v_filters, v_view.search_text, v_sorts, array['show_date', 'name'],
      v_collection.max_rows);
    v_truncated := v_arranged.o_truncated;
    -- Cues of the kept running orders, in order: at most 300 each and 3000 in all.
    with runs as (
      select (e ->> 'id')::uuid as id, n, e - 'id' as o
      from jsonb_array_elements(v_arranged.o_rows) with ordinality as x (e, n)
    ),
    ranked as (
      select c.run_of_show_id, c.position, jsonb_build_object('position', c.position, 'label', c.label, 'segment', c.segment,
          'planned_at', c.planned_at, 'duration_seconds', floor(extract(epoch from c.duration))::bigint, 'called_at', c.called_at) as o,
        row_number() over (partition by c.run_of_show_id order by c.position) as in_run,
        row_number() over (order by runs.n, c.position) as overall
      from runs join app.cues c on c.run_of_show_id = runs.id and c.deleted_at is null
    ),
    kept as (
      select * from ranked where in_run <= coalesce(v_collection.max_cues, 300) and overall <= 3000
    )
    select coalesce(jsonb_agg(runs.o || jsonb_build_object('cues', coalesce((
        select jsonb_agg(k.o order by k.position) from kept k where k.run_of_show_id = runs.id), '[]'::jsonb))
        order by runs.n), '[]'::jsonb),
      v_truncated or exists (select 1 from ranked where in_run > coalesce(v_collection.max_cues, 300) or overall > 3000)
    into v_rows, v_truncated
    from runs;

  elsif v_collection.collection_key = 'show/day_sheets' then
    -- Published day sheets only; the body is plain text to the page.
    select coalesce(jsonb_agg(jsonb_build_object(
        'o', jsonb_build_object('day', d.day, 'body', d.body, 'published_at', d.published_at),
        's', jsonb_build_object('id', d.id::text, 'day', to_char(d.day, 'YYYY-MM-DD')),
        't', to_char(d.day, 'YYYY-MM-DD') || ' ' || d.body)), '[]'::jsonb)
    into v_rows
    from app.day_sheets d
    where d.project_id = v_link.project_id and d.deleted_at is null and d.published_at is not null
      and d.project_id in (select private.project_ids_with('show.run_of_show.read'));
    select * into v_arranged from private.live_view_arrange(v_rows, v_filters, v_view.search_text, v_sorts, array['day'], v_collection.max_rows);
    v_rows := v_arranged.o_rows;
    v_truncated := v_arranged.o_truncated;
  end if;

  select 'xlink:' || c.channel_key into v_channel from private.live_link_channels c where c.live_link_id = v_link.id;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return jsonb_build_object(
    'status', 'ok',
    'meta', private.live_link_meta(v_link) || jsonb_build_object('collection_key', v_collection.collection_key,
      'view_name', v_view.name, 'view_type', v_view.view_type, 'group_by_field', v_view.group_by_field),
    'channel', v_channel,
    'server_now', now(),
    'rows', v_rows,
    'truncated', v_truncated);
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
  v_claims text := current_setting('request.jwt.claims', true);
  v_read record;
  v_link app.live_links;
  v_collection private.live_view_collections;
  v_run app.run_of_show;
  v_cues jsonb;
  v_channel text;
begin
  select * into v_read from private.live_link_reader(p_token, p_grant, p_client_address, 'Display');
  if v_read.o_reason is not null then
    return private.live_link_refusal(v_read.o_reason);
  end if;
  v_link := v_read.o_link;
  v_collection := v_read.o_collection;

  select * into v_run from app.run_of_show r
  where r.id = v_link.run_of_show_id and r.deleted_at is null
    and r.project_id in (select private.project_ids_with('show.run_of_show.read'));
  if v_run.id is null then
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    return private.live_link_refusal('live_link_view_removed');
  end if;

  select coalesce(jsonb_agg(x.o order by x.position), '[]'::jsonb) into v_cues
  from (
    select c.position, jsonb_build_object('position', c.position, 'label', c.label, 'segment', c.segment,
      'planned_at', c.planned_at, 'duration_seconds', floor(extract(epoch from c.duration))::bigint, 'called_at', c.called_at) as o
    from app.cues c
    where c.run_of_show_id = v_run.id and c.deleted_at is null
    order by c.position
    limit coalesce(v_collection.max_cues, 300)
  ) x;

  select 'xlink:' || c.channel_key into v_channel from private.live_link_channels c where c.live_link_id = v_link.id;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return jsonb_build_object(
    'status', 'ok',
    'meta', private.live_link_meta(v_link) || jsonb_build_object('name', v_run.name, 'show_date', v_run.show_date,
      'default_mode', v_link.default_mode),
    'channel', v_channel,
    'server_now', now(),
    'cues', v_cues);
end;
$$;

comment on function api_public.live_display(text, text, text) is 'Reads a display screen link with its device grant (ADR 0130; Section 7.5 invariant 8), acting as the link''s creator. Refuses as private.live_link_reader does, and live_link_view_removed when the running order is deleted. Answers JSON: meta (brand, project name and zone, running order name and show day, default mode, expiry), the Realtime channel, server_now and the cues in order (position, label, segment, planned_at, duration_seconds, called_at; never who called a cue, its description or its cue calls), at most 300.';
revoke all on function api_public.live_display(text, text, text) from public;
grant execute on function api_public.live_display(text, text, text) to anon, authenticated, service_role;
