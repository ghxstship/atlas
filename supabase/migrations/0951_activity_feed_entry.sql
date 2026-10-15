-- 0951_activity_feed_entry.sql
-- A07 late slot (ADR 0022: 0950 to 0954), because the feed reads A18's 0501 tables. app.activity_feed gains p_activity_id, so the public API
-- reads one entry (activityEvents.get) under the same feed rule, and returns the catalog description
-- of the event type. The 0400 signature is replaced; the rule itself is unchanged.

drop function if exists app.activity_feed(uuid, uuid, timestamptz, integer);

create or replace function app.activity_feed(
  p_org_id uuid,
  p_project_id uuid default null,
  p_before timestamptz default null,
  p_limit integer default 50,
  p_activity_id uuid default null
)
returns table (
  id uuid,
  occurred_at timestamptz,
  event_type text,
  subject_table text,
  subject_id uuid,
  project_id uuid,
  project_key text,
  project_name text,
  actor_person_id uuid,
  actor_name text,
  record_key text,
  record_title text,
  data jsonb,
  description text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_reach text;
begin
  perform private.require_person();
  if p_org_id is null or p_org_id not in (select private.my_org_ids()) then
    raise exception using errcode = '42501', message = 'activity.feed.read is required in the org';
  end if;
  v_reach := private.capability_reach(p_org_id, 'activity.feed.read')::text;
  if v_reach is null then
    raise exception using errcode = '42501', message = 'activity.feed.read is required in the org';
  end if;
  return query
  select a.id, a.created_at, e.event_type, e.subject_table, e.subject_id, e.project_id,
    p.project_key, p.name, a.actor_person_id, ap.full_name,
    case when r.id is not null then p.project_key || '-' || r.record_number end,
    r.title,
    e.data,
    t.description
  from app.activity_events a
  join app.domain_events e on e.id = a.domain_event_id
  join private.domain_event_types t on t.code = e.event_type
  left join app.projects p on p.id = e.project_id
  left join app.people ap on ap.id = a.actor_person_id
  left join app.records r on e.subject_table = 'records' and r.id = e.subject_id
  where a.org_id = p_org_id
    and (p_project_id is null or e.project_id = p_project_id)
    and (p_activity_id is null or a.id = p_activity_id)
    and (p_before is null or a.created_at < p_before)
    and (
      (e.project_id is null and v_reach = 'organization')
      or e.project_id in (select private.my_project_ids())
      or (v_reach = 'organization' and e.project_id in (select private.readable_project_ids()))
    )
  order by a.created_at desc, a.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

comment on function app.activity_feed(uuid, uuid, timestamptz, integer, uuid) is 'The user-facing activity feed (Section 4.2 Activity), newest first, one row per domain event with the person who caused it and the catalog description of the event; p_activity_id reads one entry. Needs activity.feed.read in the org. At organization reach it shows org events and events on projects the person may read; at assigned reach only events on projects they are a member of (invariant 2). Keyset paging by p_before; at most 200 rows.';

revoke all on function app.activity_feed(uuid, uuid, timestamptz, integer, uuid) from public, anon;
grant execute on function app.activity_feed(uuid, uuid, timestamptz, integer, uuid) to authenticated, service_role;
