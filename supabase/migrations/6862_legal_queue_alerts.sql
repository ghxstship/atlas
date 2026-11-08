-- 6862_legal_queue_alerts.sql
-- The legal queue's alerts (RRR-248; ADR 0167). A clock missed in a full inbox is the failure this exists to stop, so
-- the hourly sweep uses three paths that already exist and fail apart from each other:
--   * email: private.platform_emails (1382), the outbox the platform sends in its own name, worked every minute by the
--     subprocessor-notices Edge Function. One digest per sweep to each operator holding legal.queue, however many items
--     are due, so a bad day is one email and not forty.
--   * the on-call channel: the webhook synthetics already posts to (XOS_ALERT_WEBHOOK_URL), read from Vault as
--     xos_alert_webhook_url. An owner step; without it the sweep simply skips the post.
--   * the console: the banner on every page and the delivery check on the queue.
-- A failure on one path never stops another, and a failing feed never stops an alert (6860). A path that fails records nothing
-- as sent, so it tries again next hour, and the failure reaches the outside heartbeat. What the database cannot report about
-- itself, a stopped sweep or a failed path, an outside check reads through api_public.legal_queue_heartbeat (infra/synthetics).
-- Alerts go out at each lead the rule sets before a clock ends, then daily while it is overdue, until the item closes.
-- A backup contact gets the overdue alerts only, naming references and dates but never the matter, because a government
-- request can come with an order forbidding disclosure. The on-call post names references only. An operator's digest names
-- the matter, except on a government request's line, for the same reason.
-- A Customer's own clock (dsar_customer_register) alerts once, when overdue, by email only. While an outside reviewer is
-- appointed, the alerts on moderation appeals also go to them.

alter table private.platform_emails drop constraint platform_emails_template;
alter table private.platform_emails add constraint platform_emails_template
  check (template in ('subprocessor_confirm', 'subprocessor_notice', 'party_invitation', 'legal_clock_alert', 'moderation_notice'));
comment on column private.platform_emails.template is 'Template: subprocessor_confirm, subprocessor_notice, party_invitation, legal_clock_alert or moderation_notice (packages/email).';

-- A moderation notice names a listing and its reasons, so the org purge (1351) takes every row with this org_id.
alter table private.platform_emails add column org_id uuid references app.organizations (id);
comment on column private.platform_emails.org_id is 'The org a moderation notice is about, so the org purge (1351) takes the notice with it; null on every other template.';
create index platform_emails_org_idx on private.platform_emails (org_id);

-- An address can change before the account is deleted, so a row also names the sign-in it was sent to.
alter table private.platform_emails add column to_user_id uuid;
comment on column private.platform_emails.to_user_id is 'The sign-in a legal clock alert or moderation notice was sent to, so deleting that sign-in takes the row even after the person changed their address (6863); null on every other template, and for a backup contact or outside reviewer, who has none.';
create index platform_emails_to_user_idx on private.platform_emails (to_user_id);

comment on table private.platform_emails is 'Emails the platform sends in its own name rather than an org''s (Section 14.4): subprocessor subscription confirmations and change notices, party invitations, legal queue alerts and moderation outcomes that the notification queue cannot reach. Worked by the subprocessor-notices Edge Function; a row''s args, which may hold a token, are cleared once the email is sent. Legal clock alerts and moderation notices go on the periods of private.purge_legal_queue_people, and at once when the address''s sign-in is deleted or the org purged.';

create table private.legal_queue_alerts (
  id uuid primary key default private.uuid_v7(),
  legal_queue_item_id uuid not null references app.legal_queue_items (id) on delete cascade,
  clock text not null,
  clock_at timestamptz not null,
  stage text not null,
  path text not null,
  raised_at timestamptz not null default now(),
  constraint legal_queue_alerts_clock check (clock in ('First Response', 'Due')),
  constraint legal_queue_alerts_stage_length check (char_length(stage) between 1 and 40),
  constraint legal_queue_alerts_path check (path in ('operator', 'backup', 'reviewer', 'on_call')),
  constraint legal_queue_alerts_once unique (legal_queue_item_id, clock, clock_at, stage, path)
);
comment on table private.legal_queue_alerts is 'Which alert stages of each clock each path has taken (ADR 0167), so each goes once on each path, and a path that failed tries again. A moved due time starts its stages again.';
comment on column private.legal_queue_alerts.id is 'Alert id, UUID v7.';
comment on column private.legal_queue_alerts.legal_queue_item_id is 'Item.';
comment on column private.legal_queue_alerts.clock is 'First Response or Due.';
comment on column private.legal_queue_alerts.clock_at is 'When that clock ends.';
comment on column private.legal_queue_alerts.stage is 'A lead such as 3 days, or overdue with the local day, so overdue alerts repeat daily.';
comment on column private.legal_queue_alerts.path is 'Which path took it: operator, backup, reviewer or on_call.';
comment on column private.legal_queue_alerts.raised_at is 'When the sweep raised it.';

alter table private.legal_queue_alerts enable row level security;
revoke all on private.legal_queue_alerts from public, anon, authenticated;
grant select on private.legal_queue_alerts to service_role;

-- One path of the sweep's alert. Answers how many stages it raised, or null when it failed, and then nothing of it stands: a
-- failed path leaves no stage marked and no entry in the log, so the next sweep tries again. A path with nobody to reach marks
-- nothing either, so someone who arrives later hears of what is still due.
create function private.raise_legal_queue_alert_path(p_path text, p_lines jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_due jsonb;
  v_items jsonb;
  v_args jsonb;
  v_overdue integer;
  v_soon integer;
  v_taken integer := 0;
  v_failed boolean := false;
  v_person record;
  v_references text;
  v_url text;
begin
  select coalesce(jsonb_agg(l order by (l ->> 'clock_at')::timestamptz), '[]'::jsonb) into v_due
  from jsonb_array_elements(p_lines) as l
  where case p_path
          when 'operator' then true
          when 'backup' then (l ->> 'overdue')::boolean and not (l ->> 'customer_clock')::boolean
          when 'reviewer' then l ->> 'matter' = 'Moderation Appeal'
          else not (l ->> 'customer_clock')::boolean end
    and not exists (select 1 from private.legal_queue_alerts a
                    where a.legal_queue_item_id = (l ->> 'item_id')::uuid and a.clock = l ->> 'clock'
                      and a.clock_at = (l ->> 'clock_at')::timestamptz and a.stage = l ->> 'stage' and a.path = p_path);
  if jsonb_array_length(v_due) = 0 then
    return 0;
  end if;

  if p_path = 'on_call' then
    select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'xos_alert_webhook_url';
    if v_url is null then
      return 0;
    end if;
    select string_agg(distinct l ->> 'reference', ', ') into v_references from jsonb_array_elements(v_due) as l;
    perform net.http_post(
      url := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object('text', format('XOS legal queue: clocks need attention in the operator console: %s.', v_references)),
      timeout_milliseconds := 10000
    );
    v_taken := 1;
  else
    -- The digest's lines. The operator's name the matter, except a government request, whose existence can be under an order
    -- forbidding disclosure and which should not sit in a mailbox and the email provider's logs. The console holds it. A backup
    -- contact's never name it.
    select coalesce(jsonb_agg(jsonb_build_object('reference', l ->> 'reference', 'clock', l ->> 'clock', 'clock_at', l -> 'clock_at', 'overdue', l -> 'overdue')
             || case when p_path = 'backup' or l ->> 'matter' = 'Government Data Request' then '{}'::jsonb
                     else jsonb_build_object('matter', l ->> 'matter') end
             order by (l ->> 'clock_at')::timestamptz), '[]'::jsonb),
           count(*) filter (where (l ->> 'overdue')::boolean),
           count(*) filter (where not (l ->> 'overdue')::boolean)
      into v_items, v_overdue, v_soon
    from jsonb_array_elements(v_due) as l;
    v_args := jsonb_build_object('items', v_items, 'overdue', v_overdue, 'due_soon', v_soon,
      'audience', p_path, 'time_zone', private.legal_clock_time_zone());
    -- Each recipient on their own, so one bad address leaves the others their alert.
    for v_person in
      select distinct on (lower(u.email)) lower(u.email) as email, private.person_language(o.person_id, null) as locale, u.id as user_id
      from app.platform_operators o
      join private.platform_operator_permissions pp on pp.operator_role = o.operator_role and pp.permission = 'legal.queue'
      join app.people p on p.id = o.person_id
      join auth.users u on u.id = p.user_id
      where p_path = 'operator' and o.revoked_at is null and o.deleted_at is null and u.email is not null
      union all
      select c.email, 'en-US', null::uuid from private.legal_alert_contacts c where p_path = 'backup' and c.removed_at is null
      union all
      select r.email, 'en-US', null::uuid from private.legal_outside_reviewers r where p_path = 'reviewer' and r.ended_at is null
    loop
      begin
        insert into private.platform_emails (template, to_email, locale, args, to_user_id)
        values ('legal_clock_alert', v_person.email, v_person.locale, v_args, v_person.user_id);
        v_taken := v_taken + 1;
      exception when others then
        v_failed := true;
      end;
    end loop;
  end if;

  if v_taken > 0 then
    insert into private.legal_queue_alerts (legal_queue_item_id, clock, clock_at, stage, path)
    select (l ->> 'item_id')::uuid, l ->> 'clock', (l ->> 'clock_at')::timestamptz, l ->> 'stage', p_path
    from jsonb_array_elements(v_due) as l;
    -- The log says an alert went once one is on its way to an operator, who can act on it.
    if p_path = 'operator' then
      insert into private.legal_queue_events (legal_queue_item_id, event_kind, alert_clock, alert_clock_at, alert_overdue)
      select (l ->> 'item_id')::uuid, 'Alert Sent', l ->> 'clock', (l ->> 'clock_at')::timestamptz, (l ->> 'overdue')::boolean
      from jsonb_array_elements(v_due) as l;
    end if;
  end if;
  if v_failed and v_taken = 0 then
    return null;
  end if;
  -- Someone was reached and someone else was not: the stage stands, and the sweep still reports the failure.
  return case when v_failed then -jsonb_array_length(v_due) when v_taken > 0 then jsonb_array_length(v_due) else 0 end;
exception when others then
  return null;
end;
$$;
comment on function private.raise_legal_queue_alert_path(text, jsonb) is 'Sends one path of the legal queue''s alert (ADR 0167): operator, backup, reviewer or on_call, for the stages this path has not yet taken. Only once a recipient has taken it does it mark the stage and, for the operator path, log it on the item. Answers the stages raised; negative when some recipients failed and others took it; null when the path failed, which rolls back all of it so the next sweep tries again.';
revoke all on function private.raise_legal_queue_alert_path(text, jsonb) from public, anon, authenticated;

create function private.sweep_legal_queue(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_overdue boolean;
  v_stage text;
  v_lines jsonb := '[]'::jsonb;
  v_path text;
  v_raised integer;
  v_most integer := 0;
  v_failures text[] := '{}';
  v_day text := (p_now at time zone private.legal_clock_time_zone())::date::text;
begin
  -- Never raises, so an alert on a hand-entered item goes out whatever a feed's record has done.
  perform private.sync_legal_queue_feeds();
  begin
    perform private.purge_legal_queue_people();
  exception when others then
    v_failures := v_failures || 'purge'::text;
  end;

  for v_row in
    select i.id, i.reference, r.matter, r.customer_clock, r.alert_leads, c.clock, c.clock_at
    from app.legal_queue_items i
    join private.legal_queue_rules r on r.code = i.rule_code
    cross join lateral (values
      ('First Response', case when i.first_response_at is null then i.first_response_due_at end),
      ('Due', i.due_at)) as c (clock, clock_at)
    where i.closed_at is null and c.clock_at is not null
    order by c.clock_at
  loop
    v_overdue := p_now > v_row.clock_at;
    if v_overdue then
      v_stage := case when v_row.customer_clock then 'overdue' else 'overdue ' || v_day end;
    else
      -- Only the tightest lead reached, so an item added late sends one alert, not the whole ladder.
      select l.lead::text into v_stage from unnest(v_row.alert_leads) as l (lead)
      where p_now >= v_row.clock_at - l.lead order by l.lead limit 1;
      if v_stage is null then
        continue;
      end if;
    end if;
    v_lines := v_lines || jsonb_build_object('item_id', v_row.id, 'reference', v_row.reference, 'matter', v_row.matter,
      'customer_clock', v_row.customer_clock, 'clock', v_row.clock, 'clock_at', v_row.clock_at, 'overdue', v_overdue,
      'stage', v_stage);
  end loop;

  -- Each path on its own, and each keeps its own record of what it took, so one that fails leaves the others to carry the
  -- alert, tries again next hour, and does not repeat itself once it has worked.
  foreach v_path in array array['operator', 'backup', 'reviewer', 'on_call'] loop
    v_raised := private.raise_legal_queue_alert_path(v_path, v_lines);
    if v_raised is null or v_raised < 0 then
      v_failures := v_failures || v_path;
    end if;
    v_most := greatest(v_most, abs(coalesce(v_raised, 0)));
  end loop;

  update private.legal_queue_health
  set last_sweep_at = now(), failing_paths = v_failures,
    alert_path_failed_at = case when cardinality(v_failures) > 0 then now() else alert_path_failed_at end
  where id;
  return v_most;
end;
$$;
comment on function private.sweep_legal_queue(timestamptz) is 'Hourly (xos_sweep_legal_queue, ADR 0167): reads the feeds, deletes what the queue no longer keeps, then raises each alert stage reached by an open item''s clocks: the tightest lead its rule sets, then once a local day while overdue. Each path takes it apart from the others (private.raise_legal_queue_alert_path): one digest email per operator holding legal.queue, logged on the item; an overdue digest with no matter to each backup contact; appeals to any outside reviewer; and a post to the on-call webhook when Vault holds xos_alert_webhook_url. A path that fails marks nothing, so it tries again next hour, and is recorded in private.legal_queue_health, which the queue page and the outside heartbeat read. Returns the most stages any path raised.';
revoke all on function private.sweep_legal_queue(timestamptz) from public, anon, authenticated;

select cron.schedule('xos_sweep_legal_queue', '11 * * * *', 'select private.sweep_legal_queue()');

-- The outside heartbeat ------------------------------------------------------------------------------------------------

-- A stopped pg_cron cannot raise an alert about itself, and the queue page warns only someone who opens it. So an outside
-- scheduler (infra/synthetics, legal_queue.heartbeat) signs in as the synthetic user, reads this and pages on-call. It answers
-- booleans about the machinery and nothing about any matter, so any signed-in user may ask, and anon has no need to.
create function api_public.legal_queue_heartbeat()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'sweep_ok', coalesce(h.last_sweep_at > now() - interval '2 hours', false),
    'feeds_ok', coalesce(not h.feeds_failing and h.feeds_checked_at > now() - interval '2 hours', false),
    'email_ok', not exists (
      select 1 from private.platform_emails e
      where e.template in ('legal_clock_alert', 'moderation_notice')
        and ((e.send_state in ('Queued', 'Sending') and e.created_at < now() - interval '1 hour')
          or (e.send_state = 'Failed' and e.created_at > now() - interval '48 hours'))),
    'alert_path_ok', cardinality(h.failing_paths) = 0,
    -- The same people the operator path reaches: a holder whose sign-in is gone can be told nothing.
    'recipient_ok', exists (
      select 1 from app.platform_operators o
      join private.platform_operator_permissions pp on pp.operator_role = o.operator_role and pp.permission = 'legal.queue'
      join app.people p on p.id = o.person_id
      join auth.users u on u.id = p.user_id
      where o.revoked_at is null and o.deleted_at is null and u.email is not null))
  from private.legal_queue_health h;
$$;
comment on function api_public.legal_queue_heartbeat() is 'Whether the legal queue''s alert machinery is working (ADR 0167), for the outside synthetic check: the hourly sweep finished within 2 hours, its feeds ran clean, none of its paths failed last time, no alert or notice email is stuck or newly failed, and someone with a sign-in and an email holds legal.queue. Booleans only, with nothing about any item.';
revoke all on function api_public.legal_queue_heartbeat() from public, anon;
grant execute on function api_public.legal_queue_heartbeat() to authenticated, service_role;

-- The banner on every console page, for operators who hold legal.queue.
create function app.console_legal_queue_overdue()
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from private.platform_operator_permissions pp
    where pp.operator_role = (private.current_platform_operator()).operator_role and pp.permission = 'legal.queue') then
    return 0;
  end if;
  perform private.require_platform_operator('legal.queue');
  return (select count(*)::integer
          from app.legal_queue_items i join private.legal_queue_rules r on r.code = i.rule_code
          where i.closed_at is null and not r.customer_clock and now() > private.legal_queue_next_clock(i));
end;
$$;
comment on function app.console_legal_queue_overdue() is 'How many legal queue clocks are overdue, for the banner on every console page; 0 for an operator without legal.queue.';
revoke all on function app.console_legal_queue_overdue() from public, anon;
grant execute on function app.console_legal_queue_overdue() to authenticated;
