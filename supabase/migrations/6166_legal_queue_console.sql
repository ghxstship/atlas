-- 6166_legal_queue_console.sql
-- The console's side of the legal queue (RRR-248; ADR 0167). A new console permission, legal.queue, held only by the
-- Administrator role: a queue can hold a government request that the law forbids telling anyone about. Every RPC checks
-- it and the second factor first, and logs what it did on the item. Its rows in the console ledger say only that a legal
-- queue action happened, on which reference: every operator role reads that ledger, so a rule, a reason or a date there
-- would tell Support about a government request the queue itself keeps from them. They name no target org either, even for
-- a fed item: a row with target_org_id would make the org purge (1351) refuse that org.
--   * app.console_legal_queue: the list, with the repeat infringer counts, the government request count per calendar
--     year (DPA 13.6), who gets alerts and whether alerts are actually leaving.
--   * app.console_legal_queue_item: one item and its log. Each view is logged.
--   * app.console_add_legal_queue_item, _note_, _record_legal_first_response, _transition_, _extend_: the work.
--   * app.console_add_legal_alert_contact, _remove_; app.console_appoint_outside_reviewer, _end_: the two people who
--     can stand behind the owner, both optional.

insert into private.platform_operator_permissions (operator_role, permission) values ('Administrator', 'legal.queue');

comment on column private.platform_operator_permissions.permission is 'Console permission: tenants.read, support.sessions, flags.write, flags.kill_switch, plans.write, moderation.decide, banners.write, operators.manage or legal.queue.';

create function private.log_legal_queue_action(p_action text, p_subject_table text, p_subject_id uuid)
returns uuid
language sql
volatile
security definer
set search_path = ''
as $$
  select private.log_operator_action(p_action, null, p_subject_table, p_subject_id, null, '{}'::jsonb);
$$;
comment on function private.log_legal_queue_action(text, text, uuid) is 'Writes a legal queue action to the console ledger with no target org, no reason and no details. Every operator role reads that ledger (1470), and legal.queue is Administrator only, so what was done and why stays in private.legal_queue_events and the queue''s own tables.';
revoke all on function private.log_legal_queue_action(text, text, uuid) from public, anon, authenticated;

-- Repeat infringer counts ----------------------------------------------------------------------------------------------

create function private.legal_counted_dmca_notices()
returns table (subject_person_id uuid, received_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  -- Valid and uncontested, as the Copyright and DMCA Policy Section 5 says: Completed means the notice was valid and the
  -- material came down. A notice that was withdrawn or refused does not count, and neither does one a counter-notice
  -- answered, unless the notifier then filed a court action, or the counter-notice itself was refused or withdrawn. A
  -- counter-notice still open counts as an answer, so nobody passes the threshold while one waits.
  select n.subject_person_id, n.received_at
  from app.legal_queue_items n
  where n.rule_code = 'dmca_notice' and n.item_state = 'Completed' and n.subject_person_id is not null
    and not exists (
      select 1 from app.legal_queue_items c
      where c.related_item_id = n.id and c.rule_code = 'dmca_counter_notice'
        and (c.closed_at is null or (c.item_state = 'Completed' and not c.court_action_filed)));
$$;
comment on function private.legal_counted_dmca_notices() is 'The DMCA notices the repeat infringer rule counts: valid and uncontested, by the person they name (Copyright and DMCA Policy Section 5).';
revoke all on function private.legal_counted_dmca_notices() from public, anon, authenticated;

create function private.legal_repeat_infringer_counts()
returns table (subject_person_id uuid, counted integer, window_start timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  -- The busiest 12 months of each person's history: "any 12-month period", not just the last one.
  select distinct on (w.subject_person_id) w.subject_person_id, w.counted, w.window_start
  from (
    select a.subject_person_id, a.received_at as window_start, count(*)::integer as counted
    from private.legal_counted_dmca_notices() a
    join private.legal_counted_dmca_notices() b
      on b.subject_person_id = a.subject_person_id
     and b.received_at >= a.received_at and b.received_at < a.received_at + interval '12 months'
    group by a.subject_person_id, a.received_at
  ) w
  order by w.subject_person_id, w.counted desc, w.window_start desc;
$$;
comment on function private.legal_repeat_infringer_counts() is 'Per person, the most counted DMCA notices in any 12-month period and when that period starts. More than two meets the repeat infringer rule.';
revoke all on function private.legal_repeat_infringer_counts() from public, anon, authenticated;

create function private.queue_repeat_infringer_review(p_person_id uuid, p_actor uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_counted integer;
  v_latest timestamptz;
begin
  if p_person_id is null then
    return;
  end if;
  select c.counted into v_counted from private.legal_repeat_infringer_counts() c where c.subject_person_id = p_person_id;
  if coalesce(v_counted, 0) <= 2 then
    return;
  end if;
  select max(n.received_at) into v_latest from private.legal_counted_dmca_notices() n where n.subject_person_id = p_person_id;
  -- One review per crossing: none while one is open, and a new one only for a notice newer than the last review.
  if exists (select 1 from app.legal_queue_items i
             where i.rule_code = 'repeat_infringer_review' and i.subject_person_id = p_person_id
               and (i.closed_at is null or i.received_at >= v_latest)) then
    return;
  end if;
  perform private.open_legal_queue_item('repeat_infringer_review', format('%s valid, uncontested DMCA notices', v_counted), now(),
    p_subject_person_id => p_person_id, p_actor => p_actor);
end;
$$;
comment on function private.queue_repeat_infringer_review(uuid, uuid) is 'Opens a repeat infringer review when a person passes the threshold of the Copyright and DMCA Policy Section 5. A person decides what happens; nothing here ends an account.';
revoke all on function private.queue_repeat_infringer_review(uuid, uuid) from public, anon, authenticated;

-- Shape of an item -----------------------------------------------------------------------------------------------------

create function private.legal_queue_next_clock(p_item app.legal_queue_items)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case when p_item.first_response_at is null and p_item.first_response_due_at is not null
    then least(p_item.first_response_due_at, p_item.due_at) else p_item.due_at end;
$$;
comment on function private.legal_queue_next_clock(app.legal_queue_items) is 'The next clock an open item must meet: its first response while none is recorded, then its due time.';
revoke all on function private.legal_queue_next_clock(app.legal_queue_items) from public, anon, authenticated;

create function private.legal_queue_item_json(p_item app.legal_queue_items, p_now timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_item.id, 'reference', p_item.reference, 'matter', r.matter, 'rule_code', p_item.rule_code,
    'basis', r.basis, 'customer_clock', r.customer_clock, 'state', p_item.item_state,
    -- A fed report or appeal shows its listing's title, read live, so nothing of the tenant's is kept in the item. Null
    -- once the listing is gone.
    'live_title', case p_item.source_table
      when 'app.listing_reports' then (select o.title from app.listing_reports x join app.opportunities o on o.id = x.opportunity_id where x.id = p_item.source_id)
      when 'app.moderation_appeals' then (select o.title from app.moderation_appeals x join app.moderation_actions m on m.id = x.moderation_action_id
                                          join app.opportunities o on o.id = m.opportunity_id where x.id = p_item.source_id)
      when 'listing.moderated' then (select o.title from app.moderation_actions m join app.opportunities o on o.id = m.opportunity_id where m.id = p_item.source_id)
      when 'listing_report.decided' then (select o.title from app.listing_reports x join app.opportunities o on o.id = x.opportunity_id where x.id = p_item.source_id)
    end,
    -- Fed and system items carry a code in title, which the console words from its catalog in the operator's language.
    'title', p_item.title,
    'counted', case when p_item.rule_code = 'repeat_infringer_review' then (
      select c.counted from private.legal_repeat_infringer_counts() c where c.subject_person_id = p_item.subject_person_id) end,
    'org_name', (select o.name from app.organizations o where o.id = p_item.tenant_org_id),
    'received_at', p_item.received_at, 'first_response_due_at', p_item.first_response_due_at,
    'first_response_at', p_item.first_response_at, 'earliest_action_at', p_item.earliest_action_at,
    'due_at', p_item.due_at, 'next_clock_at', private.legal_queue_next_clock(p_item),
    'extended_at', p_item.extended_at, 'closed_at', p_item.closed_at, 'fed', p_item.source_id is not null,
    'overdue', p_item.closed_at is null and p_now > private.legal_queue_next_clock(p_item))
  from private.legal_queue_rules r where r.code = p_item.rule_code;
$$;
comment on function private.legal_queue_item_json(app.legal_queue_items, timestamptz) is 'One legal queue item as the console lists it.';
revoke all on function private.legal_queue_item_json(app.legal_queue_items, timestamptz) from public, anon, authenticated;

-- Reading --------------------------------------------------------------------------------------------------------------

create function app.console_legal_queue(p_open boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
begin
  perform private.require_platform_operator('legal.queue');
  perform private.sync_legal_queue_feeds();
  return jsonb_build_object(
    'time_zone', private.legal_clock_time_zone(),
    -- GHXSTSHIP's own work, by the clock that comes next. Watched clocks stay out: they stay open until a Customer closes
    -- them, and enough of them must not push real work off the list.
    'items', coalesce((
      select jsonb_agg(private.legal_queue_item_json(x.item, v_now) order by
        case when p_open then private.legal_queue_next_clock(x.item) end, case when not p_open then (x.item).closed_at end desc)
      from (select i as item from app.legal_queue_items i join private.legal_queue_rules r on r.code = i.rule_code
            where (i.closed_at is null) = p_open and (not p_open or not r.customer_clock)
            order by case when p_open then private.legal_queue_next_clock(i) end, case when not p_open then i.closed_at end desc
            limit 500) x), '[]'::jsonb),
    'watched', case when p_open then coalesce((
      select jsonb_agg(private.legal_queue_item_json(x.item, v_now) order by (x.item).due_at)
      from (select i as item from app.legal_queue_items i join private.legal_queue_rules r on r.code = i.rule_code
            where i.closed_at is null and r.customer_clock order by i.due_at limit 200) x), '[]'::jsonb) else '[]'::jsonb end,
    'summary', (
      select jsonb_build_object(
        'open', count(*) filter (where not r.customer_clock),
        'watched', count(*) filter (where r.customer_clock),
        -- A Customer's own clock is watched, so it never counts as work overdue here.
        'overdue', count(*) filter (where v_now > private.legal_queue_next_clock(i) and not r.customer_clock),
        'due_soon', count(*) filter (where v_now <= private.legal_queue_next_clock(i)
          and private.legal_queue_next_clock(i) <= v_now + interval '7 days' and not r.customer_clock))
      from app.legal_queue_items i join private.legal_queue_rules r on r.code = i.rule_code
      where i.closed_at is null),
    'delivery', jsonb_build_object(
      'stuck', (select count(*) from private.platform_emails e
                where e.template = 'legal_clock_alert' and e.send_state in ('Queued', 'Sending') and e.created_at < v_now - interval '1 hour'),
      'failed', (select count(*) from private.platform_emails e
                 where e.template = 'legal_clock_alert' and e.send_state = 'Failed' and e.created_at > v_now - interval '30 days'),
      -- The result of a decision or appeal on its way to the person. A failed one is also an item with its own clock.
      'notices_stuck', (select count(*) from private.platform_emails e
                        where e.template = 'moderation_notice' and e.send_state in ('Queued', 'Sending') and e.created_at < v_now - interval '1 hour'),
      'notices_failed', (select count(*) from private.platform_emails e
                         where e.template = 'moderation_notice' and e.send_state = 'Failed' and e.created_at > v_now - interval '30 days'),
      'last_sent_at', (select max(e.sent_at) from private.platform_emails e where e.template = 'legal_clock_alert'),
      -- The sweep alerts on each overdue item at least daily, and logs it once an operator's digest is on its way. So one with
      -- no alert in 26 hours says the sweep or its email path is down.
      'overdue_without_alert', (
        select count(*) from app.legal_queue_items i join private.legal_queue_rules r on r.code = i.rule_code
        where i.closed_at is null and not r.customer_clock and private.legal_queue_next_clock(i) < v_now - interval '2 hours'
          and i.created_at < v_now - interval '2 hours'
          and not exists (select 1 from private.legal_queue_events e where e.legal_queue_item_id = i.id
                            and e.event_kind = 'Alert Sent' and e.created_at > v_now - interval '26 hours')),
      'sweep_stale', coalesce((select h.last_sweep_at < v_now - interval '2 hours' from private.legal_queue_health h), true),
      'alert_path_failed', coalesce((select h.alert_path_failed_at > v_now - interval '24 hours' from private.legal_queue_health h), false),
      'webhook_configured', exists (select 1 from vault.decrypted_secrets s where s.name = 'xos_alert_webhook_url')),
    'repeat_infringers', coalesce((
      select jsonb_agg(jsonb_build_object('person_id', c.subject_person_id, 'name', p.full_name, 'counted', c.counted,
          'window_start', c.window_start, 'threshold_met', c.counted > 2) order by c.counted desc, p.full_name)
      from private.legal_repeat_infringer_counts() c left join app.people p on p.id = c.subject_person_id), '[]'::jsonb),
    'government_requests', coalesce((
      select jsonb_agg(jsonb_build_object('year', y.year, 'received', y.received) order by y.year desc)
      from (select extract(year from i.received_at at time zone private.legal_clock_time_zone())::integer as year, count(*) as received
            -- A mistake is Withdrawn with a reason, and a mistake is no request received.
            from app.legal_queue_items i where i.rule_code = 'government_request' and i.item_state <> 'Withdrawn' group by 1) y), '[]'::jsonb),
    'contacts', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.contact_name, 'email', c.email) order by c.added_at)
      from private.legal_alert_contacts c where c.removed_at is null), '[]'::jsonb),
    'outside_reviewer', (
      select jsonb_build_object('id', o.id, 'name', o.reviewer_name, 'organization', o.organization_name, 'email', o.email, 'appointed_at', o.appointed_at)
      from private.legal_outside_reviewers o where o.ended_at is null),
    'rules', (
      select jsonb_agg(jsonb_build_object('code', r.code, 'matter', r.matter, 'due_from_document', r.due_from_document) order by r.sort_order)
      from private.legal_queue_rules r where r.hand_entered));
end;
$$;
comment on function app.console_legal_queue(boolean) is 'The legal queue (legal.queue, ADR 0167), reading the feeds first: GHXSTSHIP''s open items by their next clock and the Customer clocks it watches apart, or closed items newest first, with the counts, repeat infringer figures, government requests per calendar year, whether alerts are leaving, the backup contacts, any outside reviewer and the rules an operator can add by hand.';
revoke all on function app.console_legal_queue(boolean) from public, anon;
grant execute on function app.console_legal_queue(boolean) to authenticated;

create function app.console_legal_queue_item(p_item_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item app.legal_queue_items;
  v_rule private.legal_queue_rules;
  v_notice_to text;
  v_notice_text text;
  v_now timestamptz := now();
begin
  perform private.require_platform_operator('legal.queue');
  perform private.sync_legal_queue_feeds();
  select * into v_item from app.legal_queue_items i where i.id = p_item_id;
  if v_item.id is null then
    raise exception using errcode = '42501', message = 'legal queue item not found';
  end if;
  select * into v_rule from private.legal_queue_rules r where r.code = v_item.rule_code;
  perform private.log_legal_queue_action('legal_queue.viewed', 'app.legal_queue_items', v_item.id);
  -- An undelivered notice reads who it was for and what it said live from the outbox, so the queue keeps no copy.
  select e.to_email, e.args -> 'values' ->> 'statement' into v_notice_to, v_notice_text
  from private.platform_emails e where v_item.source_table = 'private.platform_emails' and e.id = v_item.source_id;
  if v_item.source_table = 'listing.moderated' then
    select m.statement_of_reasons into v_notice_text from app.moderation_actions m where m.id = v_item.source_id;
  end if;
  return private.legal_queue_item_json(v_item, v_now) || jsonb_build_object(
    'time_zone', private.legal_clock_time_zone(), 'details', coalesce(v_item.details, v_notice_text),
    'requester_contact', coalesce(v_item.requester_contact, v_notice_to),
    'extension_reason', v_item.extension_reason, 'court_action_filed', v_item.court_action_filed,
    'subject_name', (select p.full_name from app.people p where p.id = v_item.subject_person_id),
    'related_reference', (select i.reference from app.legal_queue_items i where i.id = v_item.related_item_id),
    'related_id', v_item.related_item_id,
    'extendable', v_item.closed_at is null and v_item.extended_at is null and v_item.source_id is null and v_now <= v_item.due_at
      and v_rule.extension_amount is not null,
    're_review_required', v_rule.re_review_required, 're_review_same_person', v_item.re_review_same_person,
    -- While an outside reviewer is appointed a moderation appeal is theirs, however it arrived.
    'outside_reviewer_name', case when v_rule.matter = 'Moderation Appeal' and v_item.closed_at is null then
      (select o.reviewer_name from private.legal_outside_reviewers o where o.ended_at is null)
      else (select o.reviewer_name from private.legal_outside_reviewers o where o.id = v_item.outside_reviewer_id) end,
    -- A fed appeal or report is decided on its listing's moderation page.
    'opportunity_id', case
      when v_item.source_table in ('app.listing_reports', 'listing_report.decided') then (select r.opportunity_id from app.listing_reports r where r.id = v_item.source_id)
      when v_item.source_table = 'listing.moderated' then (select m.opportunity_id from app.moderation_actions m where m.id = v_item.source_id)
      when v_item.source_table = 'app.moderation_appeals' then (
        select m.opportunity_id from app.moderation_appeals a join app.moderation_actions m on m.id = a.moderation_action_id
        where a.id = v_item.source_id) end,
    'next_states', case when v_item.source_id is not null and not v_rule.operator_closes then '[]'::jsonb else coalesce((
      select jsonb_agg(t.to_state order by t.to_state)
      from private.legal_queue_transition_rules t
      where t.from_state = v_item.item_state), '[]'::jsonb) end,
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.event_kind, 'from_state', e.from_state, 'to_state', e.to_state,
          'note', e.note, 'alert_clock', e.alert_clock, 'alert_clock_at', e.alert_clock_at, 'alert_overdue', e.alert_overdue,
          'at', e.created_at, 'actor_name', p.full_name) order by e.created_at desc, e.id desc)
      from private.legal_queue_events e left join app.people p on p.id = e.actor_person_id
      where e.legal_queue_item_id = v_item.id), '[]'::jsonb));
end;
$$;
comment on function app.console_legal_queue_item(uuid) is 'One legal queue item and its log (legal.queue, ADR 0167), with the moves open to it. Each view is logged in the console ledger, which names only the reference.';
revoke all on function app.console_legal_queue_item(uuid) from public, anon;
grant execute on function app.console_legal_queue_item(uuid) to authenticated;

-- The work -------------------------------------------------------------------------------------------------------------

create function app.console_add_legal_queue_item(
  p_rule_code text,
  p_title text,
  p_received_local timestamp,
  p_details text default null,
  p_requester_contact text default null,
  p_subject_email text default null,
  p_related_reference text default null,
  p_due_local timestamp default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('legal.queue');
  v_rule private.legal_queue_rules;
  v_received timestamptz := private.legal_local_instant(p_received_local);
  v_due timestamptz := private.legal_local_instant(p_due_local);
  v_subject uuid;
  v_related uuid;
  v_id uuid;
begin
  select * into v_rule from private.legal_queue_rules r where r.code = p_rule_code and r.hand_entered;
  if v_rule.code is null then
    perform private.refuse('legal_queue_rule', 'Choose what this item is.');
  end if;
  if p_title is null or char_length(btrim(p_title)) not between 1 and 200 then
    perform private.refuse('legal_queue_title', 'Describe it in up to 200 characters.');
  end if;
  if v_received is null or v_received > now() + interval '5 minutes' then
    perform private.refuse('legal_queue_received', 'Say when it arrived. That cannot be in the future.');
  end if;
  if char_length(coalesce(p_details, '')) > 4000 then
    perform private.refuse('legal_queue_details', 'Keep the details to 4,000 characters.');
  end if;
  if char_length(coalesce(p_requester_contact, '')) > 320 then
    perform private.refuse('legal_queue_contact', 'Keep the contact to 320 characters.');
  end if;
  if v_rule.due_from_document and (v_due is null or v_due <= v_received) then
    perform private.refuse('legal_queue_due', 'Enter the date the document sets, after the day it arrived.');
  end if;
  if v_rule.matter = 'DMCA Notice' and nullif(btrim(p_subject_email), '') is not null then
    select p.id into v_subject from auth.users u join app.people p on p.user_id = u.id
    where lower(u.email) = lower(btrim(p_subject_email)) order by p.created_at limit 1;
    if v_subject is null then
      perform private.refuse('legal_queue_subject', 'No account uses that email. Leave it empty if the content has no account behind it.');
    end if;
  end if;
  if v_rule.matter = 'DMCA Counter-Notice' then
    select i.id into v_related from app.legal_queue_items i
    where i.reference = upper(btrim(p_related_reference)) and i.rule_code = 'dmca_notice';
    if v_related is null then
      perform private.refuse('legal_queue_related', 'Name the reference of the DMCA notice this answers.');
    end if;
  end if;
  v_id := private.open_legal_queue_item(v_rule.code, p_title, v_received, p_details, p_requester_contact, null, v_subject,
    v_related, null, null, v_due, v_operator);
  perform private.log_legal_queue_action('legal_queue.added', 'app.legal_queue_items', v_id);
  return v_id;
end;
$$;
comment on function app.console_add_legal_queue_item(text, text, timestamp, text, text, text, text, timestamp) is 'Adds an item by hand (legal.queue, ADR 0167) from a mailbox, a letter or a call. Times are typed in the zone the queue counts in (private.legal_local_instant), so each takes the offset of its own day. The clock starts when the matter arrived, not when it is entered, and the rule computes it. A government request or other written promise takes its due time from the document. A DMCA notice may name the account it is about, for the repeat infringer count, and a counter-notice names the notice it answers. Returns the item id.';
revoke all on function app.console_add_legal_queue_item(text, text, timestamp, text, text, text, text, timestamp) from public, anon;
grant execute on function app.console_add_legal_queue_item(text, text, timestamp, text, text, text, text, timestamp) to authenticated;

create function private.legal_queue_item_for_work(p_item_id uuid)
returns app.legal_queue_items
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item app.legal_queue_items;
begin
  select * into v_item from app.legal_queue_items i where i.id = p_item_id for update;
  if v_item.id is null then
    raise exception using errcode = '42501', message = 'legal queue item not found';
  end if;
  return v_item;
end;
$$;
comment on function private.legal_queue_item_for_work(uuid) is 'Locks one legal queue item for a change, or refuses as not found.';
revoke all on function private.legal_queue_item_for_work(uuid) from public, anon, authenticated;

create function app.console_note_legal_queue_item(p_item_id uuid, p_note text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('legal.queue');
  v_item app.legal_queue_items := private.legal_queue_item_for_work(p_item_id);
  v_id uuid;
begin
  if p_note is null or char_length(btrim(p_note)) not between 1 and 4000 then
    perform private.refuse('legal_queue_note', 'Say what was done, in up to 4,000 characters.');
  end if;
  insert into private.legal_queue_events (legal_queue_item_id, event_kind, note, actor_person_id)
  values (v_item.id, 'Note', btrim(p_note), v_operator)
  returning id into v_id;
  perform private.log_legal_queue_action('legal_queue.noted', 'app.legal_queue_items', v_item.id);
  return v_id;
end;
$$;
comment on function app.console_note_legal_queue_item(uuid, text) is 'Adds a line to an item''s log (legal.queue, ADR 0167), open or closed. The log is append-only. Returns the entry id.';
revoke all on function app.console_note_legal_queue_item(uuid, text) from public, anon;
grant execute on function app.console_note_legal_queue_item(uuid, text) to authenticated;

create function app.console_record_legal_first_response(p_item_id uuid, p_note text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('legal.queue');
  v_item app.legal_queue_items := private.legal_queue_item_for_work(p_item_id);
  v_id uuid;
begin
  if v_item.first_response_due_at is null or v_item.first_response_at is not null or v_item.closed_at is not null then
    perform private.refuse('legal_queue_first_response', 'This item has no first response waiting.');
  end if;
  if p_note is null or char_length(btrim(p_note)) not between 1 and 4000 then
    perform private.refuse('legal_queue_note', 'Say what was done, in up to 4,000 characters.');
  end if;
  update app.legal_queue_items set first_response_at = now(), updated_at = now() where id = v_item.id;
  insert into private.legal_queue_events (legal_queue_item_id, event_kind, note, actor_person_id)
  values (v_item.id, 'First Response', btrim(p_note), v_operator)
  returning id into v_id;
  perform private.log_legal_queue_action('legal_queue.first_response', 'app.legal_queue_items', v_item.id);
  return v_id;
end;
$$;
comment on function app.console_record_legal_first_response(uuid, text) is 'Records that the first response went out (legal.queue, ADR 0167), which stops that clock and leaves the due time running. Returns the log entry id.';
revoke all on function app.console_record_legal_first_response(uuid, text) from public, anon;
grant execute on function app.console_record_legal_first_response(uuid, text) to authenticated;

create function app.console_transition_legal_queue_item(
  p_item_id uuid,
  p_expected app.legal_queue_state,
  p_next app.legal_queue_state,
  p_reason text,
  p_court_action_filed boolean default false,
  p_re_review_notes text default null,
  p_told_how text default null,
  p_same_person boolean default false,
  p_outside_reviewer_decided boolean default false
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('legal.queue');
  v_item app.legal_queue_items := private.legal_queue_item_for_work(p_item_id);
  v_rule private.legal_queue_rules;
  v_closing boolean := p_next in ('Completed', 'Refused', 'Withdrawn');
  v_re_review boolean;
  v_outside uuid;
  v_id uuid;
begin
  select * into v_rule from private.legal_queue_rules r where r.code = v_item.rule_code;
  if v_item.source_id is not null and not v_rule.operator_closes then
    perform private.refuse('legal_queue_fed', 'This item follows its source. Act on the source, and it follows.');
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 4000 then
    perform private.refuse('transition_reason_required', 'Every state change carries a reason.');
  end if;
  if not exists (select 1 from private.legal_queue_transition_rules r
                 where r.from_state = p_expected and r.to_state = p_next) then
    perform private.refuse('legal_queue_item_transition_not_allowed', format('A legal queue item cannot move from %s to %s.', p_expected, p_next));
  end if;
  if v_item.item_state <> p_expected then
    perform private.refuse('legal_queue_item_state_conflict', format('The item is not %s any more.', p_expected));
  end if;
  if coalesce(p_court_action_filed, false) and not (v_item.rule_code = 'dmca_counter_notice' and p_next = 'Completed') then
    perform private.refuse('legal_queue_court_action', 'A court action applies only when completing a DMCA counter-notice.');
  end if;
  -- 17 U.S.C. 512(g)(2)(C): material is restored no sooner than the rule allows, unless a court action keeps it down.
  if p_next = 'Completed' and v_item.earliest_action_at is not null and now() <= v_item.earliest_action_at
     and not coalesce(p_court_action_filed, false) then
    perform private.refuse('legal_queue_too_early', 'The statute does not allow this before its earliest day. Wait for it, or record the court action.');
  end if;
  -- An appeal that arrived by email keeps the same promise as one decided on a listing (6168): a fresh, documented
  -- re-review, and the person told. A withdrawn appeal needs neither.
  v_re_review := v_rule.re_review_required and p_next in ('Completed', 'Refused');
  if v_re_review then
    if p_re_review_notes is null or char_length(btrim(p_re_review_notes)) not between 1 and 4000 then
      perform private.refuse('legal_queue_re_review', 'Record what you looked at again and how you weighed the grounds, in up to 4,000 characters.');
    end if;
    if p_told_how is null or char_length(btrim(p_told_how)) not between 1 and 1000 then
      perform private.refuse('legal_queue_person_told', 'Say how and when you told the person the result and the reasons, in up to 1,000 characters.');
    end if;
    if v_rule.matter = 'Moderation Appeal' then
      select o.id into v_outside from private.legal_outside_reviewers o where o.ended_at is null;
      if v_outside is not null and not coalesce(p_outside_reviewer_decided, false) then
        perform private.refuse('moderation_appeal_outside_reviewer', 'This appeal goes to the outside reviewer. Record their decision once they have made it.');
      end if;
    end if;
  end if;
  update app.legal_queue_items
  set item_state = p_next,
    closed_at = case when v_closing then now() end,
    court_action_filed = coalesce(p_court_action_filed, false),
    re_review_same_person = case when v_re_review then v_outside is null and coalesce(p_same_person, false) end,
    outside_reviewer_id = case when v_re_review then v_outside end,
    updated_at = now()
  where id = v_item.id;
  if v_re_review then
    insert into private.legal_queue_events (legal_queue_item_id, event_kind, note, actor_person_id)
    values (v_item.id, 'Re-Review', btrim(p_re_review_notes), v_operator),
           (v_item.id, 'Person Told', btrim(p_told_how), v_operator);
  end if;
  insert into private.legal_queue_events (legal_queue_item_id, event_kind, from_state, to_state, note, actor_person_id)
  values (v_item.id, 'State Changed', p_expected, p_next, btrim(p_reason), v_operator)
  returning id into v_id;
  perform private.log_legal_queue_action('legal_queue.moved', 'app.legal_queue_items', v_item.id);
  if v_closing and v_item.rule_code = 'dmca_notice' then
    perform private.queue_repeat_infringer_review(v_item.subject_person_id, v_operator);
  elsif v_closing and v_item.rule_code = 'dmca_counter_notice' then
    perform private.queue_repeat_infringer_review(
      (select n.subject_person_id from app.legal_queue_items n where n.id = v_item.related_item_id), v_operator);
  elsif p_next = 'Completed' and v_item.rule_code = 'undelivered_notice' then
    -- The operator reached the person another way, and the reason says how. The appeal's record now says they were told.
    update private.moderation_appeal_reviews r set told_by = 'Operator', told_at = now()
    where (v_item.source_table = 'private.platform_emails' and r.notice_email_id = v_item.source_id)
       or (v_item.source_table = 'private.moderation_appeal_reviews' and r.moderation_appeal_id = v_item.source_id);
  end if;
  return v_id;
end;
$$;
comment on function app.console_transition_legal_queue_item(uuid, app.legal_queue_state, app.legal_queue_state, text, boolean, text, text, boolean, boolean) is 'Moves a legal queue item through its lifecycle (legal.queue, ADR 0167) with a compare-and-set on the expected state and a reason, which the log keeps. Refuses a fed item that follows its source, and a DMCA restoration before its earliest day. Closing an appeal that arrived by email needs a documented re-review and how the person was told, says whether the first decider did it, and while an outside reviewer is appointed records their decision. Closing a DMCA notice or counter-notice rechecks the repeat infringer count. Completing an undelivered notice records that the person was told another way. Returns the log entry id.';
revoke all on function app.console_transition_legal_queue_item(uuid, app.legal_queue_state, app.legal_queue_state, text, boolean, text, text, boolean, boolean) from public, anon;
grant execute on function app.console_transition_legal_queue_item(uuid, app.legal_queue_state, app.legal_queue_state, text, boolean, text, text, boolean, boolean) to authenticated;

create function app.console_extend_legal_queue_item(p_item_id uuid, p_reason text)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('legal.queue');
  v_item app.legal_queue_items := private.legal_queue_item_for_work(p_item_id);
  v_rule private.legal_queue_rules;
  v_due timestamptz;
begin
  select * into v_rule from private.legal_queue_rules r where r.code = v_item.rule_code;
  if v_rule.extension_amount is null or v_item.source_id is not null then
    perform private.refuse('legal_queue_no_extension', 'This clock has no extension.');
  end if;
  if v_item.extended_at is not null or v_item.closed_at is not null then
    perform private.refuse('legal_queue_extended', 'This item can no longer be extended.');
  end if;
  -- The law allows an extension only if the person is told inside the first period.
  if now() > v_item.due_at then
    perform private.refuse('legal_queue_extension_late', 'An extension must be taken, and the person told, before the first period ends.');
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 1000 then
    perform private.refuse('legal_queue_extension_reason', 'Say why, in up to 1,000 characters, as you will tell the person.');
  end if;
  v_due := private.legal_clock_end(v_item.due_at, v_rule.extension_amount, v_rule.extension_unit);
  update app.legal_queue_items
  set due_at = v_due, extended_at = now(), extension_reason = btrim(p_reason), updated_at = now()
  where id = v_item.id;
  insert into private.legal_queue_events (legal_queue_item_id, event_kind, note, actor_person_id)
  values (v_item.id, 'Extended', btrim(p_reason), v_operator);
  perform private.log_legal_queue_action('legal_queue.extended', 'app.legal_queue_items', v_item.id);
  return v_due;
end;
$$;
comment on function app.console_extend_legal_queue_item(uuid, text) is 'Takes the one extension an item''s rule allows (legal.queue, ADR 0167), only before the first period ends and with a reason. Returns the new due time.';
revoke all on function app.console_extend_legal_queue_item(uuid, text) from public, anon;
grant execute on function app.console_extend_legal_queue_item(uuid, text) to authenticated;

-- Backup contact -------------------------------------------------------------------------------------------------------

create function app.console_add_legal_alert_contact(p_name text, p_email text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('legal.queue');
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_id uuid;
begin
  if p_name is null or char_length(btrim(p_name)) not between 1 and 200 then
    perform private.refuse('legal_contact_name', 'Say who this is, in up to 200 characters.');
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 320 then
    perform private.refuse('legal_contact_email', 'Enter a working email address.');
  end if;
  if exists (select 1 from private.legal_alert_contacts c where c.email = v_email and c.removed_at is null) then
    perform private.refuse('legal_contact_exists', 'This address already gets overdue alerts.');
  end if;
  insert into private.legal_alert_contacts (contact_name, email, added_by)
  values (btrim(p_name), v_email, v_operator)
  returning id into v_id;
  perform private.log_legal_queue_action('legal_contact.added', 'private.legal_alert_contacts', v_id);
  return v_id;
end;
$$;
comment on function app.console_add_legal_alert_contact(text, text) is 'Adds a backup address for overdue legal queue alerts (legal.queue, ADR 0167). Returns its id.';
revoke all on function app.console_add_legal_alert_contact(text, text) from public, anon;
grant execute on function app.console_add_legal_alert_contact(text, text) to authenticated;

create function app.console_remove_legal_alert_contact(p_contact_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('legal.queue');
begin
  update private.legal_alert_contacts set removed_at = now(), removed_by = v_operator
  where id = p_contact_id and removed_at is null;
  if not found then
    perform private.refuse('legal_contact_missing', 'That contact was already removed. Reload the page.');
  end if;
  perform private.log_legal_queue_action('legal_contact.removed', 'private.legal_alert_contacts', p_contact_id);
end;
$$;
comment on function app.console_remove_legal_alert_contact(uuid) is 'Removes a backup address for overdue legal queue alerts (legal.queue, ADR 0167).';
revoke all on function app.console_remove_legal_alert_contact(uuid) from public, anon;
grant execute on function app.console_remove_legal_alert_contact(uuid) to authenticated;

-- Outside reviewer -----------------------------------------------------------------------------------------------------

create function app.console_appoint_outside_reviewer(p_name text, p_organization text, p_email text, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('legal.queue');
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_id uuid;
begin
  if p_name is null or char_length(btrim(p_name)) not between 1 and 200 then
    perform private.refuse('outside_reviewer_name', 'Name the reviewer, in up to 200 characters.');
  end if;
  if char_length(coalesce(p_organization, '')) > 200 then
    perform private.refuse('outside_reviewer_organization', 'Keep the firm or body to 200 characters.');
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 320 then
    perform private.refuse('legal_contact_email', 'Enter a working email address.');
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    perform private.refuse('outside_reviewer_reason', 'Say why, in up to 500 characters.');
  end if;
  if exists (select 1 from private.legal_outside_reviewers o where o.ended_at is null) then
    perform private.refuse('outside_reviewer_exists', 'An outside reviewer is already appointed. End that appointment first.');
  end if;
  insert into private.legal_outside_reviewers (reviewer_name, organization_name, email, reason, appointed_by)
  values (btrim(p_name), nullif(btrim(p_organization), ''), v_email, btrim(p_reason), v_operator)
  returning id into v_id;
  perform private.log_legal_queue_action('outside_reviewer.appointed', 'private.legal_outside_reviewers', v_id);
  return v_id;
end;
$$;
comment on function app.console_appoint_outside_reviewer(text, text, text, text) is 'Names the one outside reviewer moderation appeals go to while the appointment lasts (legal.queue, ADR 0167). Returns the appointment id.';
revoke all on function app.console_appoint_outside_reviewer(text, text, text, text) from public, anon;
grant execute on function app.console_appoint_outside_reviewer(text, text, text, text) to authenticated;

create function app.console_end_outside_reviewer(p_reviewer_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('legal.queue');
begin
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    perform private.refuse('outside_reviewer_reason', 'Say why, in up to 500 characters.');
  end if;
  update private.legal_outside_reviewers set ended_at = now(), ended_by = v_operator, end_reason = btrim(p_reason)
  where id = p_reviewer_id and ended_at is null;
  if not found then
    perform private.refuse('outside_reviewer_missing', 'That appointment has already ended. Reload the page.');
  end if;
  perform private.log_legal_queue_action('outside_reviewer.ended', 'private.legal_outside_reviewers', p_reviewer_id);
end;
$$;
comment on function app.console_end_outside_reviewer(uuid, text) is 'Ends the outside reviewer''s appointment (legal.queue, ADR 0167); appeals then return to an operator''s fresh re-review.';
revoke all on function app.console_end_outside_reviewer(uuid, text) from public, anon;
grant execute on function app.console_end_outside_reviewer(uuid, text) to authenticated;
