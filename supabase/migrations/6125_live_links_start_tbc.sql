-- 6125_live_links_start_tbc.sql
-- P2 and P1 (RRR-216, RRR-215; ADR 0131 decision 1, ADR 0130). A time to be confirmed never reads as a firm time on a
-- public live link or a display screen.
--
--   * A cue to be confirmed sends start_tbc true and no planned_at, so a screen shows TBC and has nothing to count down
--     to or to measure lateness from, whatever build is running. A called cue keeps called_at.
--   * A schedule record to be confirmed sends start_tbc beside starts_at: its estimate still places it on a day, as
--     records and cues are scheduled by it everywhere (6110), and the page shows TBC in place of the time.
--   * private.live_view_fields lists start_tbc, the allowlist every read keeps to.
--
-- api_public.live_view and api_public.live_display are restated from 3781, their latest definition, with only those
-- values changed. Security definer, search_path '', the comments, the revokes and the grants are restated.

insert into private.live_view_fields (collection_key, field_key, part, source_table, source_columns, value_type) values
  ('project/schedule', 'start_tbc', 'row', 'app.records', '{start_tbc}', 'boolean'),
  ('project/show', 'start_tbc', 'cue', 'app.cues', '{start_tbc}', 'boolean'),
  ('show/run_of_show', 'start_tbc', 'cue', 'app.cues', '{start_tbc}', 'boolean'),
  ('display', 'start_tbc', 'cue', 'app.cues', '{start_tbc}', 'boolean');

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
          'planned_at', case when c.start_tbc then null else c.planned_at end, 'start_tbc', c.start_tbc, 'duration_seconds', floor(extract(epoch from c.duration))::bigint, 'called_at', c.called_at) as o,
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
      'planned_at', case when c.start_tbc then null else c.planned_at end, 'start_tbc', c.start_tbc, 'duration_seconds', floor(extract(epoch from c.duration))::bigint, 'called_at', c.called_at) as o
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
