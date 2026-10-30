-- 2184_calendar_feeds_leave_out_archived.sql
-- A124 (RRR-169), trace row S4.10-02. A member or project calendar feed (1410) read app.records on deleted_at only, so
-- an archived meeting, milestone or deadline (2180) stayed in every subscribed calendar, while a party's person feed
-- dropped it through api_external.records (2183). It restates the feed's latest definition (1410) with archived records
-- left out of the member and project branch; unarchiving brings the event back on the next fetch. Shifts do not archive.
-- Security definer, search_path '', the comment, the revoke and the grants are restated.

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
        'locale', coalesce(private.calendar_feed_setting(v_feed.org_id, v_feed.project_id, 'locale.language'), 'en-US'))
    into v_meta
    from app.organizations o left join app.projects p on p.id = v_feed.project_id
    where o.id = v_feed.org_id;

    -- The window counts days on the feed's calendar (the project's zone for a project feed; A71), never UTC.
    v_zone := v_meta ->> 'time_zone';
    v_today := private.zone_today(v_zone);
    v_from := private.calendar_feed_day_start(v_today - 90, v_zone);
    v_to := private.calendar_feed_day_start((v_today + interval '18 months')::date + 1, v_zone);

    with ev as (
      select s.id, 'shift'::text as kind, coalesce(ro.job_title, s.role_code, '') as title, s.starts_at, s.ends_at, s.time_zone,
        case s.shift_state when 'Canceled' then 'cancelled' when 'Draft' then 'tentative' else 'confirmed' end as status,
        s.created_at, s.updated_at, p.name as project_name, p.project_key, null::text as record_key, n.name as scope_node_name
      from app.shifts s
      join app.projects p on p.id = s.project_id and p.deleted_at is null
      left join xpms.role ro on ro.role_code = s.role_code
      left join app.scope_nodes n on n.id = s.scope_node_id
      where s.deleted_at is null and s.org_id = v_feed.org_id and s.ends_at >= v_from and s.starts_at <= v_to
        and case when v_feed.project_id is null
              then s.membership_id = v_feed.membership_id
              else s.project_id = v_feed.project_id
                and (s.membership_id = v_feed.membership_id or s.project_id in (select private.project_ids_with('crew.shift.read')))
            end
      union all
      select r.id, lower(r.record_kind), r.title, coalesce(r.starts_at, r.due_at),
        case when r.starts_at is not null and r.ends_at > r.starts_at then r.ends_at end,
        coalesce(r.time_zone, p.time_zone),
        case r.record_state when 'Canceled' then 'cancelled' when 'Proposed' then 'tentative' else 'confirmed' end,
        r.created_at, r.updated_at, p.name, p.project_key, p.project_key || '-' || r.record_number::text, null::text
      from app.records r
      join app.projects p on p.id = r.project_id and p.deleted_at is null
      where r.deleted_at is null and r.archived_at is null and r.org_id = v_feed.org_id
        and r.record_kind in ('Meeting', 'Milestone', 'Deadline')
        and coalesce(r.starts_at, r.due_at) between v_from and v_to
        and case when v_feed.project_id is null
              then r.id in (select private.my_record_ids('work.record.read'))
              else r.project_id = v_feed.project_id
                and (r.project_id in (select private.project_ids_with('work.record.read'))
                     or r.id in (select private.my_record_ids('work.record.read')))
            end
    ),
    capped as (select * from ev order by starts_at, id limit 2000)
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'kind', c.kind, 'title', c.title, 'starts_at', c.starts_at, 'ends_at', c.ends_at, 'time_zone', c.time_zone,
        'status', c.status, 'sequence', private.calendar_feed_sequence(c.created_at, c.updated_at),
        'created_at', c.created_at, 'updated_at', c.updated_at, 'org_name', null, 'project_name', c.project_name,
        'project_key', c.project_key, 'record_key', c.record_key, 'scope_node_name', c.scope_node_name)
        || private.calendar_feed_dates(c.kind, c.starts_at, c.ends_at, c.time_zone)
      order by c.starts_at, c.id), '[]'::jsonb)
    into v_events
    from capped c;
  else
    v_meta := jsonb_build_object('scope', 'person', 'org_name', null, 'org_slug', null, 'project_name', null, 'project_key', null,
      'time_zone', coalesce(private.calendar_feed_setting(null, null, 'locale.time_zone'), 'UTC'),
      'locale', coalesce(private.calendar_feed_setting(null, null, 'locale.language'), 'en-US'));

    -- The window counts days on the feed's calendar (the project's zone for a project feed; A71), never UTC.
    v_zone := v_meta ->> 'time_zone';
    v_today := private.zone_today(v_zone);
    v_from := private.calendar_feed_day_start(v_today - 90, v_zone);
    v_to := private.calendar_feed_day_start((v_today + interval '18 months')::date + 1, v_zone);

    with ev as (
      select s.id, 'shift'::text as kind, coalesce(s.job_title, s.role_code, '') as title, s.starts_at, s.ends_at, s.time_zone,
        case s.shift_state when 'Canceled' then 'cancelled' else 'confirmed' end as status,
        sh.created_at, sh.updated_at, o.name as org_name, s.project_name, s.scope_node_name
      from api_external.shifts s
      join app.shifts sh on sh.id = s.id
      join app.organizations o on o.id = sh.org_id
      where s.ends_at >= v_from and s.starts_at <= v_to
      union all
      select r.id, lower(r.record_kind), r.title, coalesce(r.starts_at, r.due_at),
        case when r.starts_at is not null and r.ends_at > r.starts_at then r.ends_at end,
        coalesce(r.time_zone, p.time_zone),
        case r.record_state when 'Canceled' then 'cancelled' when 'Proposed' then 'tentative' else 'confirmed' end,
        rr.created_at, rr.updated_at, o.name, p.name, null::text
      from api_external.records r
      join app.records rr on rr.id = r.id
      join app.projects p on p.id = r.project_id
      join app.organizations o on o.id = p.org_id
      where r.record_kind in ('Meeting', 'Milestone', 'Deadline') and coalesce(r.starts_at, r.due_at) between v_from and v_to
    ),
    capped as (select * from ev order by starts_at, id limit 2000)
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'kind', c.kind, 'title', c.title, 'starts_at', c.starts_at, 'ends_at', c.ends_at, 'time_zone', c.time_zone,
        'status', c.status, 'sequence', private.calendar_feed_sequence(c.created_at, c.updated_at),
        'created_at', c.created_at, 'updated_at', c.updated_at, 'org_name', c.org_name, 'project_name', c.project_name,
        'project_key', null, 'record_key', null, 'scope_node_name', c.scope_node_name)
        || private.calendar_feed_dates(c.kind, c.starts_at, c.ends_at, c.time_zone)
      order by c.starts_at, c.id), '[]'::jsonb)
    into v_events
    from capped c;
  end if;

  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return jsonb_build_object('status', 'ok', 'feed', v_meta, 'events', v_events);
end;
$$;

comment on function api_public.calendar_feed(text, text) is 'Named token RPC behind /ical/{feedToken}.ics (Section 4.6.5, invariants 7 and 8; ADR 0040): resolves a live member, project or person feed token and returns its name parts, zone, locale and events (shifts, meetings, milestones and deadlines) evaluated with the owner''s access at this moment (archived records are left out until they are unarchived; A124), as one JSON document with status ok, not_found or rate_limited. A revoked, rotated-away or wrong token, an ended membership or a deleted person returns not_found. Limits: 120 fetches an hour per token; failed lookups 20 per relayed client address (p_client_address, from the route''s clientAddress()) under the reaching address (private.request_ip()) and 2000 per reaching address in 15 minutes; retired tokens never count as failures.';

revoke all on function api_public.calendar_feed(text, text) from public;
grant execute on function api_public.calendar_feed(text, text) to anon, authenticated, service_role;
