-- 1592_support_channels_without_forum.sql
--
-- Orchestrator block (ADR 0022, 1590-1599), RRR-125. ADR 0033 decision 73 defers the community forum and in-app
-- support chat past 4.0, and the Service Level Agreement no longer offers them: Access gets the help center, Core and
-- Pro email, Team email with a priority queue. app.open_support_ticket still refused an Access org's platform request
-- with "The Access plan includes the help center and community forum", which Atlas shows. This recreates the function
-- from 0643, its only definition, with that message naming the help center alone; the refusal code
-- (support_plan_no_channel), the body, security definer, search_path, comment, revoke and grant are unchanged.

create or replace function app.open_support_ticket(
  p_org_id uuid,
  p_queue app.support_queue,
  p_category app.support_category,
  p_subject text,
  p_body text,
  p_severity app.support_severity default 'Severity 3',
  p_diagnostics jsonb default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_membership uuid;
  v_plan text;
  v_channel app.support_channel := 'In App';
  v_due timestamptz;
  v_id uuid;
  v_number text;
begin
  select m.id into v_membership from app.memberships m
  where m.org_id = p_org_id and m.person_id = v_person and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  order by m.valid_from desc limit 1;
  if v_membership is null then
    raise exception using errcode = '42501', message = 'only a member of the org can open a support ticket';
  end if;

  if p_queue = 'Platform' then
    if not private.has_capability(p_org_id, 'org.help.write') then
      perform private.refuse('support_platform_admins_only', 'Only org admins contact platform support; ask your admins through Contact Support.');
    end if;
    select s.plan_code into v_plan from app.subscriptions s
    where s.org_id = p_org_id and s.subscription_state <> 'canceled' and s.deleted_at is null;
    select t.channel, t.first_response_due_at into v_channel, v_due
    from private.platform_support_terms(v_plan, p_severity, now()) t;
    if v_channel is null then
      perform private.refuse('support_plan_no_channel', 'The Access plan includes the help center; upgrade to contact platform support.');
    end if;
  end if;

  if p_diagnostics is not null and coalesce(p_diagnostics ->> 'consent', '') <> 'true' then
    perform private.refuse('support_diagnostics_consent', 'Diagnostics are attached only when you agree to send them.');
  end if;

  v_number := 'SUP-' || lpad(private.next_sequence(p_org_id, 'support_ticket')::text, 4, '0');
  insert into app.support_tickets (membership_id, ticket_number, queue, category, severity, subject, body, channel, first_response_due_at)
  values (v_membership, v_number, p_queue, p_category, p_severity, btrim(p_subject), btrim(p_body), v_channel, v_due)
  returning id into v_id;

  if p_diagnostics is not null then
    insert into app.support_ticket_diagnostics (support_ticket_id, consented_at, route, app_version, device, recent_errors, screenshot_path)
    values (v_id, now(), nullif(p_diagnostics ->> 'route', ''), nullif(p_diagnostics ->> 'app_version', ''),
      nullif(p_diagnostics ->> 'device', ''), nullif(p_diagnostics ->> 'recent_errors', ''),
      nullif(p_diagnostics ->> 'screenshot_path', ''));
  end if;

  perform private.emit_event(p_org_id, 'support_ticket.opened', 'support_tickets', v_id, null,
    jsonb_build_object('ticket_number', v_number, 'queue', p_queue, 'category', p_category, 'severity', p_severity,
      'channel', v_channel, 'first_response_due_at', v_due, 'diagnostics', p_diagnostics is not null));
  return v_id;
end;
$$;

comment on function app.open_support_ticket(uuid, app.support_queue, app.support_category, text, text, app.support_severity, jsonb) is 'Opens a support ticket as the signed-in member. Organization queue: any member. Platform queue: holders of org.help.write on a plan with a platform channel, which sets the channel and the first response deadline. Diagnostics (route, app_version, device, recent_errors, screenshot_path) are stored only with "consent": true. Returns the ticket id.';
revoke all on function app.open_support_ticket(uuid, app.support_queue, app.support_category, text, text, app.support_severity, jsonb) from public, anon;
grant execute on function app.open_support_ticket(uuid, app.support_queue, app.support_category, text, text, app.support_severity, jsonb) to authenticated, service_role;
