-- 2962_calendar_feed_cues.sql
-- B7 (RRR-231, ADR 0146 decisions 1 and 2; gap G-50). Feeds serve their saved sources and audience, and cues.
--
--   * api_public.calendar_feed, from its latest definition (2791, P2) verbatim, with these changes:
--     - the feed document's meta gains name (the feed's name, or null for the default);
--     - each event kind is served only when its source is chosen; a feed without saved sources serves the 4.0 set,
--       so a legacy feed's events, ids, statuses and sequences are unchanged;
--     - a project feed with an audience (people, a team or a department) computes its memberships once, as the owner,
--       through private.schedule_audience_memberships (2961), and keeps the shifts and records that belong to it
--       (private.schedule_audience_shift, private.schedule_audience_record). The owner's reach applies first, so a
--       filter never shows more than the owner may see;
--     - Cues on a project feed: cues of the project's live runs with a planned time in the window, only for owners
--       who hold show.run_of_show.read on the project. A cue is tentative while its start is to be confirmed; its
--       sequence follows the cue, its run and the filtered call, so moving, nudging, renaming the run or editing the
--       call raises it. With a show department (cue_call_kind), only cues with a live call of that department, whose
--       instruction is call_instruction;
--     - Cues on a person feed: the rows of api_external.cues (an engaged Client's projects, an artist's own set
--       times), exactly what Gateway shows, with call_instruction null;
--     - every event carries run_id, run_name and call_instruction, null for every kind but a cue.
--   * The cap of 2000 events, the window, the rate limits, the not-found rules and P2's TBC record status are unchanged.

create or replace function api_public.calendar_feed(p_token text, p_client_address text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_hop text := coalesce(host(private.request_ip()), 'unknown');
  v_client text;
  v_subject text;
  v_hash bytea;
  v_feed app.calendar_feeds;
  v_person_feed app.person_calendar_feeds;
  v_user uuid;
  v_claims text := current_setting('request.jwt.claims', true);
  v_zone text;
  v_today date;
  v_from timestamptz;
  v_to timestamptz;
  v_meta jsonb;
  v_events jsonb;
  v_sources text[];
  v_audience boolean := false;
  v_members uuid[] := '{}';
  v_can_cues boolean := false;
begin
  begin
    v_client := host(nullif(btrim(left(coalesce(p_client_address, ''), 64)), '')::inet);
  exception when invalid_text_representation then
    v_client := null;
  end;
  v_subject := v_hop || ' ' || coalesce(v_client, v_hop);
  if private.rate_limit_exceeded('calendar_feed.failure', v_subject, 20, interval '15 minutes')
     or private.rate_limit_exceeded('calendar_feed.hop_failure', v_hop, 2000, interval '15 minutes') then
    return jsonb_build_object('status', 'rate_limited', 'retry_after_seconds', 900);
  end if;

  if p_token is not null and p_token ~ '^xcal_[0-9a-f]{64}$' then
    v_hash := extensions.digest(p_token, 'sha256');
    select * into v_feed from app.calendar_feeds f where f.token_hash = v_hash and f.revoked_at is null and f.deleted_at is null;
    if v_feed.id is null then
      select * into v_person_feed from app.person_calendar_feeds f
      where f.token_hash = v_hash and f.revoked_at is null and f.deleted_at is null;
    end if;
  end if;
  if v_feed.id is null and v_person_feed.id is null then
    if v_hash is null or not (
      exists (select 1 from private.retired_calendar_feed_tokens r where r.token_hash = v_hash)
      or exists (select 1 from app.calendar_feeds f where f.token_hash = v_hash)
      or exists (select 1 from app.person_calendar_feeds f where f.token_hash = v_hash)) then
      perform private.note_rate_event('calendar_feed.failure', v_subject);
      perform private.note_rate_event('calendar_feed.hop_failure', v_hop);
    end if;
    return jsonb_build_object('status', 'not_found');
  end if;

  if private.rate_limit_exceeded('calendar_feed.fetch', encode(v_hash, 'hex'), 120, interval '1 hour') then
    return jsonb_build_object('status', 'rate_limited', 'retry_after_seconds', 900);
  end if;
  perform private.note_rate_event('calendar_feed.fetch', encode(v_hash, 'hex'));

  if v_feed.id is not null then
    select p.user_id into v_user from app.memberships m join app.people p on p.id = m.person_id
    where m.id = v_feed.membership_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
      and p.deleted_at is null;
  else
    select p.user_id into v_user from app.people p where p.id = v_person_feed.person_id and p.deleted_at is null;
  end if;
  if v_user is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_feed.id is not null then
    update app.calendar_feeds set last_accessed_at = now()
    where id = v_feed.id and (last_accessed_at is null or last_accessed_at < now() - interval '5 minutes');
  else
    update app.person_calendar_feeds set last_accessed_at = now()
    where id = v_person_feed.id and (last_accessed_at is null or last_accessed_at < now() - interval '5 minutes');
  end if;

  -- From here the feed reads as its owner: the same helpers the row level security policies use decide every row.
  perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);

  if v_feed.id is not null then
    select jsonb_build_object(
        'scope', case when v_feed.project_id is null then 'member' else 'project' end,
        'org_name', o.name, 'org_slug', o.slug, 'project_name', p.name, 'project_key', p.project_key,
        'time_zone', coalesce(p.time_zone, private.calendar_feed_setting(v_feed.org_id, null, 'locale.time_zone'), 'UTC'),
        'locale', coalesce(private.calendar_feed_setting(v_feed.org_id, v_feed.project_id, 'locale.language'), 'en-US'),
        'name', v_feed.name)
    into v_meta
    from app.organizations o left join app.projects p on p.id = v_feed.project_id
    where o.id = v_feed.org_id;

    -- The window counts days on the feed's calendar (the project's zone for a project feed; A71), never UTC.
    v_zone := v_meta ->> 'time_zone';
    v_today := private.zone_today(v_zone);
    v_from := private.calendar_feed_day_start(v_today - 90, v_zone);
    v_to := private.calendar_feed_day_start((v_today + interval '18 months')::date + 1, v_zone);

    -- What the feed serves (the 4.0 set when none is saved), and its audience, computed once as the owner (ADR 0146).
    v_sources := private.calendar_feed_effective_sources(v_feed.sources)::text[];
    if v_feed.project_id is not null then
      v_audience := v_feed.team_id is not null or v_feed.department_code is not null
        or exists (select 1 from app.calendar_feed_members fm where fm.calendar_feed_id = v_feed.id and fm.deleted_at is null);
      if v_audience then
        v_members := array(select private.schedule_audience_memberships(v_feed.org_id,
          case when v_feed.team_id is null and v_feed.department_code is null then
            array(select m.person_id from app.calendar_feed_members fm join app.memberships m on m.id = fm.membership_id
                  where fm.calendar_feed_id = v_feed.id and fm.deleted_at is null) end,
          v_feed.team_id, v_feed.department_code));
      end if;
      v_can_cues := 'Cues' = any (v_sources) and v_feed.project_id in (select private.project_ids_with('show.run_of_show.read'));
    end if;

    with ev as (
      select s.id, 'shift'::text as kind, coalesce(ro.job_title, s.role_code, '') as title, s.starts_at, s.ends_at, s.time_zone,
        case s.shift_state when 'Canceled' then 'cancelled' when 'Draft' then 'tentative' else 'confirmed' end as status,
        s.created_at, s.updated_at, p.name as project_name, p.project_key, null::text as record_key, n.name as scope_node_name,
        null::uuid as run_id, null::text as run_name, null::text as call_instruction
      from app.shifts s
      join app.projects p on p.id = s.project_id and p.deleted_at is null
      left join xpms.role ro on ro.role_code = s.role_code
      left join app.scope_nodes n on n.id = s.scope_node_id
      where s.deleted_at is null and s.org_id = v_feed.org_id and s.ends_at >= v_from and s.starts_at <= v_to
        and case when v_feed.project_id is null
              then s.membership_id = v_feed.membership_id
              else s.project_id = v_feed.project_id
                and (s.membership_id = v_feed.membership_id or s.project_id in (select private.project_ids_with('crew.shift.read')))
                and (not v_audience or private.schedule_audience_shift(s.membership_id, s.role_code, v_members, v_feed.department_code))
            end
        and 'Shifts' = any (v_sources)
      union all
      select r.id, lower(r.record_kind), r.title, coalesce(r.starts_at, r.due_at),
        case when r.starts_at is not null and r.ends_at > r.starts_at then r.ends_at end,
        coalesce(r.time_zone, p.time_zone),
        case when r.record_state = 'Canceled' then 'cancelled'
          when r.record_state = 'Proposed' or (r.start_tbc and r.starts_at is not null) then 'tentative' else 'confirmed' end,
        r.created_at, r.updated_at, p.name, p.project_key, p.project_key || '-' || r.record_number::text, null::text,
        null::uuid, null::text, null::text
      from app.records r
      join app.projects p on p.id = r.project_id and p.deleted_at is null
      where r.deleted_at is null and r.org_id = v_feed.org_id and r.record_kind in ('Meeting', 'Milestone', 'Deadline')
        and coalesce(r.starts_at, r.due_at) between v_from and v_to
        and case when v_feed.project_id is null
              then r.id in (select private.my_record_ids('work.record.read'))
              else r.project_id = v_feed.project_id
                and (r.project_id in (select private.project_ids_with('work.record.read'))
                     or r.id in (select private.my_record_ids('work.record.read')))
                and (not v_audience or private.schedule_audience_record(r.id, v_members))
            end
        and (r.record_kind || 's') = any (v_sources)
      union all
      -- Cues of the project's live runs, for owners who read its run of show; with a show department, only cues that
      -- have that department's call, whose instruction the event carries. Moving, nudging, renaming the run or editing
      -- the call raises the sequence.
      select c.id, 'cue'::text, c.label, c.planned_at,
        case when c.duration > interval '0' then c.planned_at + c.duration end,
        coalesce(p.time_zone, v_zone),
        case when c.start_tbc then 'tentative' else 'confirmed' end,
        c.created_at, greatest(c.updated_at, ru.updated_at, cc.updated_at), p.name, p.project_key, null::text, null::text,
        ru.id, ru.name, cc.instruction
      from app.cues c
      join app.run_of_show ru on ru.id = c.run_of_show_id and ru.deleted_at is null
      join app.projects p on p.id = ru.project_id and p.deleted_at is null
      left join app.cue_calls cc on cc.cue_id = c.id and cc.call_kind = v_feed.cue_call_kind and cc.deleted_at is null
      where v_can_cues and c.deleted_at is null and ru.project_id = v_feed.project_id
        and c.planned_at between v_from and v_to
        and (v_feed.cue_call_kind is null or cc.id is not null)
    ),
    capped as (select * from ev order by starts_at, id limit 2000)
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'kind', c.kind, 'title', c.title, 'starts_at', c.starts_at, 'ends_at', c.ends_at, 'time_zone', c.time_zone,
        'status', c.status, 'sequence', private.calendar_feed_sequence(c.created_at, c.updated_at),
        'created_at', c.created_at, 'updated_at', c.updated_at, 'org_name', null, 'project_name', c.project_name,
        'project_key', c.project_key, 'record_key', c.record_key, 'scope_node_name', c.scope_node_name,
        'run_id', c.run_id, 'run_name', c.run_name, 'call_instruction', c.call_instruction)
        || private.calendar_feed_dates(c.kind, c.starts_at, c.ends_at, c.time_zone)
      order by c.starts_at, c.id), '[]'::jsonb)
    into v_events
    from capped c;
  else
    v_meta := jsonb_build_object('scope', 'person', 'org_name', null, 'org_slug', null, 'project_name', null, 'project_key', null,
      'time_zone', coalesce(private.calendar_feed_setting(null, null, 'locale.time_zone'), 'UTC'),
      'locale', coalesce(private.calendar_feed_setting(null, null, 'locale.language'), 'en-US'),
      'name', v_person_feed.name);
    v_sources := private.calendar_feed_effective_sources(v_person_feed.sources)::text[];

    -- The window counts days on the feed's calendar (the project's zone for a project feed; A71), never UTC.
    v_zone := v_meta ->> 'time_zone';
    v_today := private.zone_today(v_zone);
    v_from := private.calendar_feed_day_start(v_today - 90, v_zone);
    v_to := private.calendar_feed_day_start((v_today + interval '18 months')::date + 1, v_zone);

    with ev as (
      select s.id, 'shift'::text as kind, coalesce(s.job_title, s.role_code, '') as title, s.starts_at, s.ends_at, s.time_zone,
        case s.shift_state when 'Canceled' then 'cancelled' else 'confirmed' end as status,
        sh.created_at, sh.updated_at, o.name as org_name, s.project_name, s.scope_node_name,
        null::uuid as run_id, null::text as run_name
      from api_external.shifts s
      join app.shifts sh on sh.id = s.id
      join app.organizations o on o.id = sh.org_id
      where s.ends_at >= v_from and s.starts_at <= v_to and 'Shifts' = any (v_sources)
      union all
      select r.id, lower(r.record_kind), r.title, coalesce(r.starts_at, r.due_at),
        case when r.starts_at is not null and r.ends_at > r.starts_at then r.ends_at end,
        coalesce(r.time_zone, p.time_zone),
        case when r.record_state = 'Canceled' then 'cancelled'
          when r.record_state = 'Proposed' or (rr.start_tbc and rr.starts_at is not null) then 'tentative' else 'confirmed' end,
        rr.created_at, rr.updated_at, o.name, p.name, null::text, null::uuid, null::text
      from api_external.records r
      join app.records rr on rr.id = r.id
      join app.projects p on p.id = r.project_id
      join app.organizations o on o.id = p.org_id
      where r.record_kind in ('Meeting', 'Milestone', 'Deadline') and coalesce(r.starts_at, r.due_at) between v_from and v_to
        and (r.record_kind || 's') = any (v_sources)
      union all
      -- Cues exactly as Gateway shows them: a Client's projects, an artist's own set times (api_external.cues).
      select c.id, 'cue'::text, c.label, c.planned_at,
        case when c.duration > interval '0' then c.planned_at + c.duration end,
        coalesce(p.time_zone, v_zone),
        case when c.start_tbc then 'tentative' else 'confirmed' end,
        ac.created_at, greatest(ac.updated_at, ru.updated_at), o.name, p.name, null::text, ru.id, ru.name
      from api_external.cues c
      join app.cues ac on ac.id = c.id
      join app.run_of_show ru on ru.id = c.run_of_show_id
      join app.projects p on p.id = c.project_id
      join app.organizations o on o.id = p.org_id
      where 'Cues' = any (v_sources) and c.planned_at between v_from and v_to
    ),
    capped as (select * from ev order by starts_at, id limit 2000)
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'kind', c.kind, 'title', c.title, 'starts_at', c.starts_at, 'ends_at', c.ends_at, 'time_zone', c.time_zone,
        'status', c.status, 'sequence', private.calendar_feed_sequence(c.created_at, c.updated_at),
        'created_at', c.created_at, 'updated_at', c.updated_at, 'org_name', c.org_name, 'project_name', c.project_name,
        'project_key', null, 'record_key', null, 'scope_node_name', c.scope_node_name,
        'run_id', c.run_id, 'run_name', c.run_name, 'call_instruction', null)
        || private.calendar_feed_dates(c.kind, c.starts_at, c.ends_at, c.time_zone)
      order by c.starts_at, c.id), '[]'::jsonb)
    into v_events
    from capped c;
  end if;

  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return jsonb_build_object('status', 'ok', 'feed', v_meta, 'events', v_events);
end;
$$;

comment on function api_public.calendar_feed(text, text) is 'Named token RPC behind /ical/{feedToken}.ics (Section 4.6.5, invariants 7 and 8; ADR 0040, ADR 0146): resolves a live member, project or person feed token and returns its name, name parts, zone, locale and events evaluated with the owner''s access at this moment, as one JSON document with status ok, not_found or rate_limited. A feed serves its saved sources (shifts, meetings, milestones, deadlines and cues; the first four when none are saved) and, on a project feed, only its audience''s shifts and records (people, a team or a department) and, with a show department, only cues with that department''s call; never more than its owner may see. A revoked, rotated-away or wrong token, an ended membership or a deleted person returns not_found. Limits: 120 fetches an hour per token; failed lookups 20 per relayed client address (p_client_address, from the route''s clientAddress()) under the reaching address (private.request_ip()) and 2000 per reaching address in 15 minutes; retired tokens never count as failures. A meeting, milestone, deadline or cue whose start is to be confirmed (start_tbc) is tentative, at its estimated start (ADR 0131, amending ADR 0040 item 5).';

revoke all on function api_public.calendar_feed(text, text) from public;
grant execute on function api_public.calendar_feed(text, text) to anon, authenticated, service_role;
