-- 1462_saved_search_alerts.sql
-- A89 (RRR-134), finding A65-008, work package WP8: the platform matcher that app.opportunity_alerts (0720) names.
-- "Saved searches send alerts by email and push" (Section 4.4.3). Every 15 minutes pg_cron runs
-- private.match_saved_searches, which for each saved search with alerts on:
--   * takes the listings published since the search was saved (at most 14 days back), that are still Published
--   * keeps those open to the search's owner (private.opportunity_open_to_person: Public, invited by name, pool or
--     network, with the org's marketplace visibility cap from A76's 1327 and Do Not Engage and moderation applied),
--     so an alert never shows a listing the person could not find in Explore
--   * keeps those that match the search (private.listing_matches, the rule Explore's search uses, 1460) and that the
--     person has not passed on or applied to
--   * writes one app.opportunity_alerts row per new match (idempotent through its unique key), at most 25 per search
--     a run, and notifies the person once per search and posting org with kind opportunity.matched by email and push
--     (A80's queue, so the person's preferences for the Opportunities category and their quiet hours apply: 1461).
--     A listing several of the person's searches match is notified once: the later alerts are recorded as delivered
-- delivered_at records when the alert was handed to the notification queue; the queue's deliveries record what each
-- channel did.

create index opportunity_state_transitions_published_idx on app.opportunity_state_transitions (created_at)
  where to_state = 'Published';

create or replace function private.notify_saved_search_matches(p_saved_search_id uuid, p_org_id uuid, p_alert_ids uuid[])
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_search app.saved_searches;
  v_first record;
  v_count integer := coalesce(cardinality(p_alert_ids), 0);
  v_notification uuid;
begin
  if v_count = 0 then
    return null;
  end if;
  select * into v_search from app.saved_searches s where s.id = p_saved_search_id;
  select o.id, o.title, o.project_id, og.name as org_name into v_first
  from app.opportunity_alerts a
  join app.opportunities o on o.id = a.opportunity_id
  join app.organizations og on og.id = o.org_id
  where a.id = any (p_alert_ids)
  order by o.deadline_at asc nulls last, o.starts_on asc nulls last, o.id
  limit 1;
  v_notification := private.notify(p_org_id, v_search.person_id, 'opportunity.matched', 'opportunities', v_first.id, v_first.project_id,
    jsonb_build_object(
      'title', v_first.title,
      'orgName', v_first.org_name,
      'searchName', v_search.name,
      'count', v_count,
      'gatewayPath', case when v_count = 1 then '/explore/' || private.gateway_display_key('OPP', v_first.id) else '/explore/alerts' end));
  if v_notification is not null then
    update app.opportunity_alerts set delivered_at = now() where id = any (p_alert_ids) and delivered_at is null;
  end if;
  return v_notification;
end;
$$;

comment on function private.notify_saved_search_matches(uuid, uuid, uuid[]) is 'Notifies a saved search''s owner of its new matches from one org with one opportunity.matched notification: the first listing''s title (soonest deadline), the org, the search name and the count, linking to the listing when there is one match and to Explore Alerts otherwise. Marks the alerts delivered once the notification is queued. Returns the notification id, or null.';
revoke all on function private.notify_saved_search_matches(uuid, uuid, uuid[]) from public, anon, authenticated;

create or replace function private.match_saved_searches(p_lookback interval default interval '14 days', p_per_search integer default 25)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_search app.saved_searches;
  v_opp record;
  v_alert uuid;
  v_org uuid;
  v_ids uuid[];
  v_written integer := 0;
begin
  for v_search in
    select s.* from app.saved_searches s
    join app.people p on p.id = s.person_id and p.deleted_at is null
    where s.deleted_at is null and s.alerts_enabled
    order by s.id
  loop
    v_org := null;
    v_ids := '{}';
    for v_opp in
      select o.id, o.org_id
      from (
        select t.opportunity_id, max(t.created_at) as published_at
        from app.opportunity_state_transitions t
        where t.to_state = 'Published' and t.deleted_at is null
          and t.created_at > greatest(v_search.created_at, now() - p_lookback)
        group by t.opportunity_id
      ) pub
      join app.opportunities o on o.id = pub.opportunity_id
      where o.deleted_at is null and o.opportunity_state = 'Published'
        and not exists (select 1 from app.opportunity_alerts a
                        where a.saved_search_id = v_search.id and a.opportunity_id = o.id and a.deleted_at is null)
        and not exists (select 1 from app.passed_opportunities po
                        where po.person_id = v_search.person_id and po.opportunity_id = o.id and po.deleted_at is null)
        and not exists (select 1 from app.applications ap
                        where ap.opportunity_id = o.id and ap.applicant_person_id = v_search.person_id and ap.deleted_at is null)
        and private.opportunity_open_to_person(o.id, o.org_id, o.visibility, o.opportunity_state, v_search.person_id)
        and private.listing_matches(o.id, v_search.query_text,
          case when v_search.role_type is null then null else array[v_search.role_type] end,
          v_search.role_code, v_search.disc_code, v_search.cat_urid, v_search.jurisdiction_id, v_search.starts_after,
          v_search.ends_before, v_search.min_rate_minor, v_search.currency_code, v_search.certification_name,
          v_search.near_latitude, v_search.near_longitude, v_search.radius_km, v_search.org_id)
      order by o.org_id, pub.published_at, o.id
      limit greatest(p_per_search, 1)
    loop
      if v_org is not null and v_opp.org_id <> v_org then
        perform private.notify_saved_search_matches(v_search.id, v_org, v_ids);
        v_ids := '{}';
      end if;
      v_org := v_opp.org_id;
      v_alert := null;
      insert into app.opportunity_alerts (saved_search_id, opportunity_id)
      values (v_search.id, v_opp.id)
      on conflict (saved_search_id, opportunity_id) where deleted_at is null do nothing
      returning id into v_alert;
      if v_alert is not null then
        v_written := v_written + 1;
        -- Several of a person's searches can match one listing: the first notifies, the others record the
        -- match already told (delivered) so the person hears about each listing once.
        if exists (select 1 from app.opportunity_alerts a2
                   join app.saved_searches s2 on s2.id = a2.saved_search_id
                   where s2.person_id = v_search.person_id and a2.opportunity_id = v_opp.id and a2.id <> v_alert
                     and a2.deleted_at is null) then
          update app.opportunity_alerts set delivered_at = now() where id = v_alert;
        else
          v_ids := v_ids || v_alert;
        end if;
      end if;
    end loop;
    if v_org is not null then
      perform private.notify_saved_search_matches(v_search.id, v_org, v_ids);
    end if;
  end loop;
  return v_written;
end;
$$;

comment on function private.match_saved_searches(interval, integer) is 'The saved-search matcher (Section 4.4.3, A65-008), run by pg_cron every 15 minutes: for each saved search with alerts on, writes an alert for each listing published since the search was saved (at most p_lookback back) that is still Published, open to the owner (private.opportunity_open_to_person), matching the search (private.listing_matches) and neither passed on nor applied to, at most p_per_search a run, then notifies the owner once per posting org (private.notify_saved_search_matches), and once per listing across all their searches. Idempotent: a listing alerts a search once. Returns how many alerts it wrote.';
revoke all on function private.match_saved_searches(interval, integer) from public, anon, authenticated;

select cron.schedule('xos_match_saved_searches', '*/15 * * * *', 'select private.match_saved_searches()');
