-- 6167_legal_queue_alerts.sql
-- The legal queue's alerts (RRR-248; ADR 0167). A clock missed in a full inbox is the failure this exists to stop, so
-- the hourly sweep uses three paths that already exist and fail apart from each other:
--   * email: private.platform_emails (1382), the outbox the platform sends in its own name, worked every minute by the
--     subprocessor-notices Edge Function. One digest per sweep to each operator holding legal.queue, however many items
--     are due, so a bad day is one email and not forty.
--   * the on-call channel: the webhook synthetics already posts to (XOS_ALERT_WEBHOOK_URL), read from Vault as
--     xos_alert_webhook_url. An owner step; without it the sweep simply skips the post.
--   * the console: the banner on every page and the delivery check on the queue.
-- A failure on one path never stops another, and a failing feed never stops an alert (6165). What the database cannot report
-- about itself, a stopped sweep, an outside check reads through api_public.legal_queue_heartbeat (infra/synthetics).
-- Alerts go out at each lead the rule sets before a clock ends, then daily while it is overdue, until the item closes.
-- A backup contact gets the overdue alerts only, naming references and dates but never the matter, because a government
-- request can come with an order forbidding disclosure. The on-call post names references only.
-- A Customer's own clock (dsar_customer_register) alerts once, when overdue, by email only. While an outside reviewer is
-- appointed, the alerts on moderation appeals also go to them.

alter table private.platform_emails drop constraint platform_emails_template;
alter table private.platform_emails add constraint platform_emails_template
  check (template in ('subprocessor_confirm', 'subprocessor_notice', 'party_invitation', 'legal_clock_alert', 'moderation_notice'));
comment on column private.platform_emails.template is 'Template: subprocessor_confirm, subprocessor_notice, party_invitation, legal_clock_alert or moderation_notice (packages/email).';

comment on table private.platform_emails is 'Emails the platform sends in its own name rather than an org''s (Section 14.4): subprocessor subscription confirmations and change notices, party invitations, legal queue alerts and moderation outcomes that the notification queue cannot reach. Worked by the subprocessor-notices Edge Function; a row''s args, which may hold a token, are cleared once the email is sent.';

create table private.legal_queue_alerts (
  id uuid primary key default private.uuid_v7(),
  legal_queue_item_id uuid not null references app.legal_queue_items (id) on delete cascade,
  clock text not null,
  clock_at timestamptz not null,
  stage text not null,
  raised_at timestamptz not null default now(),
  constraint legal_queue_alerts_clock check (clock in ('First Response', 'Due')),
  constraint legal_queue_alerts_stage_length check (char_length(stage) between 1 and 40),
  constraint legal_queue_alerts_once unique (legal_queue_item_id, clock, clock_at, stage)
);
comment on table private.legal_queue_alerts is 'Which alert stages of each clock have gone out (ADR 0167), so each goes once. A moved due time starts its stages again.';
comment on column private.legal_queue_alerts.id is 'Alert id, UUID v7.';
comment on column private.legal_queue_alerts.legal_queue_item_id is 'Item.';
comment on column private.legal_queue_alerts.clock is 'First Response or Due.';
comment on column private.legal_queue_alerts.clock_at is 'When that clock ends.';
comment on column private.legal_queue_alerts.stage is 'A lead such as 3 days, or overdue with the local day, so overdue alerts repeat daily.';
comment on column private.legal_queue_alerts.raised_at is 'When the sweep raised it.';

alter table private.legal_queue_alerts enable row level security;
revoke all on private.legal_queue_alerts from public, anon, authenticated;
grant select on private.legal_queue_alerts to service_role;

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
  v_alert uuid;
  v_lines jsonb := '[]'::jsonb;
  v_overdue_lines jsonb := '[]'::jsonb;
  v_appeal_lines jsonb;
  v_references text[] := '{}';
  v_overdue_count integer := 0;
  v_soon_count integer := 0;
  v_line jsonb;
  v_url text;
  v_day text := (p_now at time zone private.legal_clock_time_zone())::date::text;
begin
  -- Never raises, so an alert on a hand-entered item goes out whatever a feed's record has done.
  perform private.sync_legal_queue_feeds();
  perform private.purge_legal_queue_people();

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
    insert into private.legal_queue_alerts (legal_queue_item_id, clock, clock_at, stage, raised_at)
    values (v_row.id, v_row.clock, v_row.clock_at, v_stage, p_now)
    on conflict on constraint legal_queue_alerts_once do nothing
    returning id into v_alert;
    if v_alert is null then
      continue;
    end if;
    insert into private.legal_queue_events (legal_queue_item_id, event_kind, alert_clock, alert_clock_at, alert_overdue)
    values (v_row.id, 'Alert Sent', v_row.clock, v_row.clock_at, v_overdue);
    v_line := jsonb_build_object('reference', v_row.reference, 'clock', v_row.clock, 'clock_at', v_row.clock_at,
      'overdue', v_overdue);
    v_lines := v_lines || (v_line || jsonb_build_object('matter', v_row.matter));
    if v_overdue then
      v_overdue_count := v_overdue_count + 1;
      if not v_row.customer_clock then
        v_overdue_lines := v_overdue_lines || v_line;
      end if;
    else
      v_soon_count := v_soon_count + 1;
    end if;
    if not v_row.customer_clock then
      v_references := array_append(v_references, v_row.reference);
    end if;
  end loop;

  if jsonb_array_length(v_lines) > 0 then
    -- Each path in its own block, so one that fails leaves the others to carry the alert.
    begin
      -- One digest to each operator holding legal.queue.
      insert into private.platform_emails (template, to_email, locale, args)
      select distinct on (lower(u.email)) 'legal_clock_alert', lower(u.email), private.person_language(o.person_id, null),
        jsonb_build_object('items', v_lines, 'overdue', v_overdue_count, 'due_soon', v_soon_count, 'audience', 'operator', 'time_zone', private.legal_clock_time_zone())
      from app.platform_operators o
      join private.platform_operator_permissions pp on pp.operator_role = o.operator_role and pp.permission = 'legal.queue'
      join app.people p on p.id = o.person_id
      join auth.users u on u.id = p.user_id
      where o.revoked_at is null and o.deleted_at is null and u.email is not null;

      -- The backup contacts: overdue only, with no matter.
      if jsonb_array_length(v_overdue_lines) > 0 then
        insert into private.platform_emails (template, to_email, locale, args)
        select 'legal_clock_alert', c.email, 'en-US',
          jsonb_build_object('items', v_overdue_lines, 'overdue', jsonb_array_length(v_overdue_lines), 'due_soon', 0, 'audience', 'backup', 'time_zone', private.legal_clock_time_zone())
        from private.legal_alert_contacts c
        where c.removed_at is null;
      end if;

      -- The outside reviewer, when one is appointed: the appeals, which are theirs to re-review.
      select coalesce(jsonb_agg(l), '[]'::jsonb) into v_appeal_lines
      from jsonb_array_elements(v_lines) as l where l ->> 'matter' = 'Moderation Appeal';
      if jsonb_array_length(v_appeal_lines) > 0 then
        insert into private.platform_emails (template, to_email, locale, args)
        select 'legal_clock_alert', o.email, 'en-US',
          jsonb_build_object('items', v_appeal_lines, 'overdue',
            (select count(*) from jsonb_array_elements(v_appeal_lines) as l where (l ->> 'overdue')::boolean),
            'due_soon', (select count(*) from jsonb_array_elements(v_appeal_lines) as l where not (l ->> 'overdue')::boolean),
            'audience', 'reviewer', 'time_zone', private.legal_clock_time_zone())
        from private.legal_outside_reviewers o
        where o.ended_at is null;
      end if;
    exception when others then
      update private.legal_queue_health set alert_path_failed_at = now();
    end;

    -- The on-call channel, the alert path synthetics posts to, naming references only.
    if coalesce(array_length(v_references, 1), 0) > 0 then
      begin
        select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'xos_alert_webhook_url';
        if v_url is not null then
          perform net.http_post(
            url := v_url,
            headers := jsonb_build_object('Content-Type', 'application/json'),
            body := jsonb_build_object('text', format('XOS legal queue: clocks need attention in the operator console: %s.',
              array_to_string(v_references, ', '))),
            timeout_milliseconds := 10000
          );
        end if;
      exception when others then
        update private.legal_queue_health set alert_path_failed_at = now();
      end;
    end if;
  end if;

  update private.legal_queue_health set last_sweep_at = now();
  return jsonb_array_length(v_lines);
end;
$$;
comment on function private.sweep_legal_queue(timestamptz) is 'Hourly (xos_sweep_legal_queue, ADR 0167): reads the feeds, then raises each alert stage reached by an open item''s clocks: the tightest lead its rule sets, then once a local day while overdue. Each is logged on the item. Queues one digest email per operator holding legal.queue, an overdue digest with no matter to each backup contact, and a post to the on-call webhook when Vault holds xos_alert_webhook_url. A path that fails is recorded and leaves the others running. Stamps private.legal_queue_health, which the outside heartbeat reads. Returns how many stages it raised.';
revoke all on function private.sweep_legal_queue(timestamptz) from public, anon, authenticated;

select cron.schedule('xos_sweep_legal_queue', '11 * * * *', 'select private.sweep_legal_queue()');

-- The outside heartbeat ------------------------------------------------------------------------------------------------

-- A stopped pg_cron cannot raise an alert about itself, and the queue page warns only someone who opens it. So an outside
-- scheduler (infra/synthetics, legal_queue.heartbeat) reads this and pages on-call. It answers booleans about the machinery,
-- and nothing about any matter, so anyone may ask.
create function api_public.legal_queue_heartbeat()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'sweep_ok', coalesce(h.last_sweep_at > now() - interval '2 hours', false),
    'feeds_ok', coalesce(h.feeds_ok_at > now() - interval '2 hours', false),
    'email_ok', not exists (
      select 1 from private.platform_emails e
      where e.template in ('legal_clock_alert', 'moderation_notice')
        and ((e.send_state in ('Queued', 'Sending') and e.created_at < now() - interval '1 hour')
          or (e.send_state = 'Failed' and e.created_at > now() - interval '48 hours'))),
    'recipient_ok', exists (
      select 1 from app.platform_operators o
      join private.platform_operator_permissions pp on pp.operator_role = o.operator_role and pp.permission = 'legal.queue'
      where o.revoked_at is null and o.deleted_at is null))
  from private.legal_queue_health h;
$$;
comment on function api_public.legal_queue_heartbeat() is 'Whether the legal queue''s alert machinery is working (ADR 0167), for the outside synthetic check: the hourly sweep finished within 2 hours, its feeds ran clean, no alert or notice email is stuck or newly failed, and someone holds legal.queue. Booleans only, with nothing about any item.';
revoke all on function api_public.legal_queue_heartbeat() from public;
grant execute on function api_public.legal_queue_heartbeat() to anon, authenticated, service_role;

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
