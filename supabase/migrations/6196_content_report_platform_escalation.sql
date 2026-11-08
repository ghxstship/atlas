-- 6196_content_report_platform_escalation.sql
-- App Store Review Guideline 1.2 and Google Play's user-generated content policy expect the developer to act on
-- reports of objectionable content in a timely way. Reports of posts, comments and messages go to each org's
-- moderators, who decide within 24 hours (1630). A report the org leaves undecided past those 24 hours now also goes
-- to GHXSTSHIP's Trust and Safety team in the operator console, so the platform can act when the org does not:
--   * app.content_reports.platform_escalated_at: when the report reached the console. The hourly job
--     (xos_escalate_content_reports_to_platform) stamps each open report past its due time once, and writes one row
--     to the org's audit ledger (content_report.escalated) when an item reaches the console, so the org can see what
--     GHXSTSHIP was given. A later report on an item already in the console joins it without another row; an item
--     whose reports were all decided and that is reported again goes again, with a new row.
--   * app.console_content_escalations lists those items without their text; app.console_content_escalation_detail
--     opens one, with the item and the reports as the moderators read them but without who reported, and logs the
--     view in the console ledger (content_report.viewed); app.console_decide_content_escalation decides it with the
--     same statement of reasons in parts the org's moderators give, and the same effect: removal hides a post,
--     deletes a comment or deletes a message. Each needs moderation.decide.
--   * A platform decision is an ordinary decision row marked decided_by_platform, so the org's moderators read it in
--     their queue as GHXSTSHIP's, never under the operator's name; the reporters and the author receive the same
--     notices, naming GHXSTSHIP where an org decision names the org (actorName); the console ledger records the
--     operator and the org's audit ledger records the decision.
--   * The org's moderators can still decide an escalated item themselves; once every report on it is decided, it
--     leaves the console's open list.
-- Platform operators still never read an org's reports that the org decides in time.

alter table app.content_reports add column platform_escalated_at timestamptz;
comment on column app.content_reports.platform_escalated_at is 'When the report, still undecided past its due time, went to GHXSTSHIP''s Trust and Safety team in the operator console (6196).';

create index content_reports_platform_open_idx on app.content_reports (platform_escalated_at)
  where platform_escalated_at is not null and content_moderation_decision_id is null and deleted_at is null;

alter table app.content_moderation_decisions add column decided_by_platform boolean not null default false;
comment on column app.content_moderation_decisions.decided_by_platform is 'Whether GHXSTSHIP''s Trust and Safety team decided the item from the operator console, after the org left its reports undecided past their due time (6196). The org reads such a decision as GHXSTSHIP''s.';

-- Escalation -----------------------------------------------------------------------------------------------------------

create or replace function private.escalate_content_reports_to_platform()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item record;
  v_count integer := 0;
  v_in_console boolean;
begin
  for v_item in
    select r.org_id, r.subject_kind, coalesce(r.feed_post_id, r.comment_id, r.chat_message_id) as subject_id,
      (array_agg(r.id order by r.reported_at))[1] as report_id, min(r.due_at) as due_at, count(*) as open_reports
    from app.content_reports r
    where r.deleted_at is null and r.content_moderation_decision_id is null and r.platform_escalated_at is null
      and r.due_at <= now()
    group by r.org_id, r.subject_kind, coalesce(r.feed_post_id, r.comment_id, r.chat_message_id)
  loop
    select exists (select 1 from app.content_reports r
                   where r.org_id = v_item.org_id and r.deleted_at is null and r.content_moderation_decision_id is null
                     and r.platform_escalated_at is not null
                     and coalesce(r.feed_post_id, r.comment_id, r.chat_message_id) = v_item.subject_id)
    into v_in_console;
    update app.content_reports set platform_escalated_at = now()
    where org_id = v_item.org_id and deleted_at is null and content_moderation_decision_id is null
      and platform_escalated_at is null and due_at <= now()
      and coalesce(feed_post_id, comment_id, chat_message_id) = v_item.subject_id;
    if not v_in_console then
      perform private.write_audit_event(v_item.org_id, 'content_report.escalated', 'app.content_reports', v_item.report_id,
        jsonb_build_object('subject_kind', v_item.subject_kind, 'subject_id', v_item.subject_id,
          'open_reports', v_item.open_reports, 'due_at', v_item.due_at, 'escalated_to', 'GHXSTSHIP Trust and Safety'));
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

comment on function private.escalate_content_reports_to_platform() is 'Hourly (xos_escalate_content_reports_to_platform): sends each item with reports still undecided past their due time to GHXSTSHIP''s Trust and Safety team in the operator console, stamping platform_escalated_at; an item that reaches the console writes content_report.escalated to the org''s audit ledger, and a later report on an item still in the console joins it without another row. Returns how many items reached the console.';
revoke all on function private.escalate_content_reports_to_platform() from public, anon, authenticated;

select cron.schedule('xos_escalate_content_reports_to_platform', '52 * * * *',
  'select private.escalate_content_reports_to_platform()');

-- The console ----------------------------------------------------------------------------------------------------------

create or replace function app.console_content_escalations(p_open boolean default true)
returns table (
  org_id uuid,
  org_name text,
  subject_kind app.content_subject_kind,
  subject_id uuid,
  removed boolean,
  open_reports bigint,
  total_reports bigint,
  reasons app.content_report_reason[],
  first_reported_at timestamptz,
  escalated_at timestamptz,
  last_action app.content_moderation_action,
  last_decided_at timestamptz,
  decided_by_platform boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_operator('moderation.decide');
  return query
  select q.org_id, o.name, q.subject_kind, q.subject_id, coalesce(i.removed, true), q.open_reports, q.total_reports,
    q.reasons, q.first_reported_at, q.escalated_at, d.action, d.decided_at, d.decided_by_platform
  from (
    select r.org_id, r.subject_kind, coalesce(r.feed_post_id, r.comment_id, r.chat_message_id) as subject_id,
      count(*) filter (where r.content_moderation_decision_id is null) as open_reports,
      count(*) as total_reports,
      array_agg(distinct r.reason order by r.reason) as reasons,
      min(r.reported_at) as first_reported_at,
      min(r.platform_escalated_at) as escalated_at
    from app.content_reports r
    where r.deleted_at is null
    group by r.org_id, r.subject_kind, coalesce(r.feed_post_id, r.comment_id, r.chat_message_id)
    having count(r.platform_escalated_at) > 0
  ) q
  join app.organizations o on o.id = q.org_id
  left join lateral (select x.removed from private.reported_content(q.subject_kind, q.subject_id) x limit 1) i on true
  left join lateral (select m.action, m.decided_at, m.decided_by_platform from app.content_moderation_decisions m
                     where m.org_id = q.org_id and coalesce(m.feed_post_id, m.comment_id, m.chat_message_id) = q.subject_id
                     order by m.decided_at desc, m.id desc limit 1) d on true
  where (p_open and q.open_reports > 0) or (not p_open and q.open_reports = 0)
  order by case when p_open then q.escalated_at end, d.decided_at desc nulls last
  limit 200;
end;
$$;

comment on function app.console_content_escalations(boolean) is 'Operator console (moderation.decide): posts, comments and messages whose reports an org left undecided past their due time (6196), the longest escalated first, with the org, report counts and reasons but not the text; or, with p_open false, escalated items whose reports are all decided now, by the org or by GHXSTSHIP, newest decision first.';
revoke all on function app.console_content_escalations(boolean) from public, anon;
grant execute on function app.console_content_escalations(boolean) to authenticated, service_role;

create or replace function private.require_escalated_content(p_subject_id uuid)
returns table (org_id uuid, subject_kind app.content_subject_kind)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select r.org_id, r.subject_kind from app.content_reports r
  where r.deleted_at is null and r.platform_escalated_at is not null
    and coalesce(r.feed_post_id, r.comment_id, r.chat_message_id) = p_subject_id
  limit 1;
  if not found then
    raise exception using errcode = '42501', message = 'no escalated report about this item';
  end if;
end;
$$;

comment on function private.require_escalated_content(uuid) is 'The org and kind of an item (a post, comment or message, by id) with a report escalated to GHXSTSHIP (6196); refuses 42501 for any other item, so the console never opens content an org decided in time.';
revoke all on function private.require_escalated_content(uuid) from public, anon, authenticated;

create or replace function app.console_content_escalation_detail(p_subject_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_kind app.content_subject_kind;
  v_item record;
  v_context text;
begin
  perform private.require_platform_operator('moderation.decide');
  select e.org_id, e.subject_kind into v_org, v_kind from private.require_escalated_content(p_subject_id) e;
  select * into v_item from private.reported_content(v_kind, p_subject_id);
  v_context := case v_kind
    when 'Feed Post' then (select coalesce(p.title, p.post_kind::text) from app.feed_posts p where p.id = p_subject_id)
    when 'Comment' then (select coalesce(p.title, p.post_kind::text) from app.comments c
                         join app.comment_threads t on t.id = c.comment_thread_id
                         join app.feed_posts p on p.id = t.subject_id where c.id = p_subject_id)
    else (select coalesce(g.name, c.conversation_kind::text) from app.chat_messages m
          join app.conversations c on c.id = m.conversation_id left join app.groups g on g.id = c.group_id
          where m.id = p_subject_id)
  end;
  perform private.log_operator_action('content_report.viewed', v_org, 'app.content_reports', (
    select r.id from app.content_reports r where r.deleted_at is null and r.platform_escalated_at is not null
      and coalesce(r.feed_post_id, r.comment_id, r.chat_message_id) = p_subject_id
    order by r.reported_at limit 1), null, jsonb_build_object('subject_kind', v_kind, 'subject_id', p_subject_id));
  return jsonb_build_object(
    'subject', jsonb_build_object('kind', v_kind, 'id', p_subject_id, 'context', v_context,
      'org_id', v_org, 'org_name', (select o.name from app.organizations o where o.id = v_org),
      'author_person_id', v_item.author_person_id,
      'author_name', (select pe.full_name from app.people pe where pe.id = v_item.author_person_id),
      'body', case when v_item.removed then null else v_item.body end,
      'removed', coalesce(v_item.removed, true)),
    'reports', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'reason', r.reason, 'details', r.details,
                           'content_excerpt', r.content_excerpt, 'reported_at', r.reported_at, 'due_at', r.due_at,
                           'escalated_at', r.platform_escalated_at, 'open', r.content_moderation_decision_id is null)
                           order by r.reported_at desc)
                         from app.content_reports r
                         where r.org_id = v_org and r.deleted_at is null
                           and coalesce(r.feed_post_id, r.comment_id, r.chat_message_id) = p_subject_id), '[]'::jsonb),
    'decisions', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'action', m.action, 'ground', m.ground,
                             'rule_reference', m.rule_reference, 'facts', m.facts, 'statement', m.statement_of_reasons,
                             'decided_at', m.decided_at, 'by_platform', m.decided_by_platform)
                             order by m.decided_at desc, m.id desc)
                           from app.content_moderation_decisions m
                           where m.org_id = v_org
                             and coalesce(m.feed_post_id, m.comment_id, m.chat_message_id) = p_subject_id), '[]'::jsonb));
end;
$$;

comment on function app.console_content_escalation_detail(uuid) is 'Operator console (moderation.decide): one item (a post, comment or message, by id) with a report escalated to GHXSTSHIP (6196): its text while not removed, where it was posted, its org and author, every report on it with the snapshot but never the reporter, and every decision, the org''s or GHXSTSHIP''s, without who decided. Logs content_report.viewed in the console ledger. Any other item is refused 42501.';
revoke all on function app.console_content_escalation_detail(uuid) from public, anon;
grant execute on function app.console_content_escalation_detail(uuid) to authenticated, service_role;

create or replace function app.console_decide_content_escalation(
  p_subject_id uuid,
  p_action app.content_moderation_action,
  p_ground app.moderation_ground,
  p_rule_reference text,
  p_facts text,
  p_statement text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_operator uuid := private.require_platform_operator('moderation.decide');
  v_org uuid;
  v_kind app.content_subject_kind;
  v_item record;
  v_id uuid;
  v_reporter uuid;
  v_conversation uuid;
begin
  select e.org_id, e.subject_kind into v_org, v_kind from private.require_escalated_content(p_subject_id) e;
  select * into v_item from private.reported_content(v_kind, p_subject_id);
  if v_item.author_person_id = v_operator then
    perform private.refuse('content_moderation_own', 'Another moderator decides reports about your own post, comment or message.');
  end if;
  if not exists (select 1 from app.content_reports r where r.org_id = v_org and r.deleted_at is null
                   and r.content_moderation_decision_id is null
                   and coalesce(r.feed_post_id, r.comment_id, r.chat_message_id) = p_subject_id) then
    perform private.refuse('content_moderation_nothing_open', 'Every report about this was already decided.');
  end if;

  insert into app.content_moderation_decisions (org_id, subject_kind, feed_post_id, comment_id, chat_message_id,
    author_person_id, action, ground, rule_reference, facts, statement_of_reasons, decided_by, decided_by_platform)
  values (v_org, v_kind,
    case when v_kind = 'Feed Post' then p_subject_id end,
    case when v_kind = 'Comment' then p_subject_id end,
    case when v_kind = 'Chat Message' then p_subject_id end,
    v_item.author_person_id, p_action, p_ground, btrim(p_rule_reference), btrim(p_facts), btrim(p_statement), v_operator,
    true)
  returning id into v_id;

  if p_action = 'Removed' and not v_item.removed then
    if v_kind = 'Feed Post' then
      update app.feed_posts set hidden_at = now(), hidden_reason = btrim(left(btrim(p_statement), 500)), pinned_at = null
      where id = p_subject_id;
      perform private.emit_event(v_org, 'feed_post.hidden', 'feed_posts', p_subject_id, v_item.project_id,
        jsonb_build_object('reason', btrim(left(btrim(p_statement), 500)), 'content_moderation_decision_id', v_id));
    elsif v_kind = 'Comment' then
      update app.comments set deleted_at = now() where id = p_subject_id;
    else
      update app.chat_messages set deleted_at = now() where id = p_subject_id
      returning conversation_id into v_conversation;
      perform private.emit_event(v_org, 'chat_message.deleted', 'chat_messages', p_subject_id, null,
        jsonb_build_object('conversation_id', v_conversation, 'content_moderation_decision_id', v_id));
    end if;
  end if;

  update app.content_reports set content_moderation_decision_id = v_id
  where org_id = v_org and deleted_at is null and content_moderation_decision_id is null
    and coalesce(feed_post_id, comment_id, chat_message_id) = p_subject_id;
  perform private.emit_event(v_org, 'content.moderated', 'content_moderation_decisions', v_id, v_item.project_id,
    jsonb_build_object('subject_kind', v_kind, 'action', p_action, 'ground', p_ground, 'decided_by_platform', true));

  -- The notices name GHXSTSHIP, as an org's decision names the org, never the operator.
  for v_reporter in
    select distinct r.reporter_person_id from app.content_reports r where r.content_moderation_decision_id = v_id
  loop
    perform private.notify(v_org, v_reporter, 'content_report.decided', 'app.content_moderation_decisions', v_id,
      v_item.project_id, jsonb_build_object('subject', private.content_subject_word(v_kind), 'action', p_action,
        'statement', btrim(p_statement), 'actorName', 'GHXSTSHIP'));
  end loop;
  if p_action = 'Removed' and v_item.author_person_id is not null then
    perform private.notify(v_org, v_item.author_person_id, 'content.removed', 'app.content_moderation_decisions', v_id,
      v_item.project_id, jsonb_build_object('subject', private.content_subject_word(v_kind), 'ground', p_ground,
        'ruleReference', btrim(p_rule_reference), 'statement', btrim(p_statement), 'actorName', 'GHXSTSHIP'));
  end if;
  perform private.log_operator_action('content_report.decided', v_org, 'app.content_moderation_decisions', v_id,
    btrim(p_statement), jsonb_build_object('subject_kind', v_kind, 'subject_id', p_subject_id, 'action', p_action,
      'ground', p_ground));
  return v_id;
end;
$$;

comment on function app.console_decide_content_escalation(uuid, app.content_moderation_action, app.moderation_ground, text, text, text) is 'Operator console (moderation.decide): GHXSTSHIP decides an item (a post, comment or message, by id) whose reports were escalated to it (6196) with a statement of reasons in parts, as an org moderator does with app.decide_content_report: Removed hides a post, deletes a comment or deletes a message; No Action leaves it. Decides every open report on the item, records decided_by_platform, tells each reporter the outcome (content_report.decided) and, on removal, sends the author the statement (content.removed), both naming GHXSTSHIP; logs content_report.decided in the console ledger. Refuses an item with no open report. Returns the decision id.';
revoke all on function app.console_decide_content_escalation(uuid, app.content_moderation_action, app.moderation_ground, text, text, text) from public, anon;
grant execute on function app.console_decide_content_escalation(uuid, app.content_moderation_action, app.moderation_ground, text, text, text) to authenticated, service_role;

-- The org's moderators read a decision GHXSTSHIP made as GHXSTSHIP's, never under the operator's name (1630's detail,
-- with decided_by_name and decided_by_platform).
create or replace function app.content_report_detail(p_org_id uuid, p_subject_kind app.content_subject_kind, p_subject_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_content_moderator(p_org_id);
  v_item record;
  v_context text;
begin
  select * into v_item from private.reported_content(p_subject_kind, p_subject_id);
  -- A moderator's own content answers as if nobody had reported it: its author never learns of a report.
  if v_item.org_id is distinct from p_org_id or v_item.author_person_id = v_person
     or not exists (select 1 from app.content_reports r where r.org_id = p_org_id and r.deleted_at is null
                      and coalesce(r.feed_post_id, r.comment_id, r.chat_message_id) = p_subject_id) then
    raise exception using errcode = '42501', message = 'no report about this item';
  end if;
  v_context := case p_subject_kind
    when 'Feed Post' then (select coalesce(p.title, p.post_kind::text) from app.feed_posts p where p.id = p_subject_id)
    when 'Comment' then (select coalesce(p.title, p.post_kind::text) from app.comments c
                         join app.comment_threads t on t.id = c.comment_thread_id
                         join app.feed_posts p on p.id = t.subject_id where c.id = p_subject_id)
    else (select coalesce(g.name, c.conversation_kind::text) from app.chat_messages m
          join app.conversations c on c.id = m.conversation_id left join app.groups g on g.id = c.group_id
          where m.id = p_subject_id)
  end;
  return jsonb_build_object(
    'subject', jsonb_build_object('kind', p_subject_kind, 'id', p_subject_id, 'context', v_context,
      'author_person_id', v_item.author_person_id,
      'author_name', (select pe.full_name from app.people pe where pe.id = v_item.author_person_id),
      'body', case when v_item.removed then null else v_item.body end,
      'removed', v_item.removed),
    'reports', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'reason', r.reason, 'details', r.details,
                           'content_excerpt', r.content_excerpt, 'reported_at', r.reported_at, 'due_at', r.due_at,
                           'reporter_name', pe.full_name, 'open', r.content_moderation_decision_id is null)
                           order by r.reported_at desc)
                         from app.content_reports r left join app.people pe on pe.id = r.reporter_person_id
                         where r.org_id = p_org_id and r.deleted_at is null
                           and coalesce(r.feed_post_id, r.comment_id, r.chat_message_id) = p_subject_id), '[]'::jsonb),
    'decisions', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'action', m.action, 'ground', m.ground,
                             'rule_reference', m.rule_reference, 'facts', m.facts, 'statement', m.statement_of_reasons,
                             'decided_at', m.decided_at,
                             'decided_by_name', case when m.decided_by_platform then 'GHXSTSHIP' else pe.full_name end,
                             'decided_by_platform', m.decided_by_platform)
                             order by m.decided_at desc, m.id desc)
                           from app.content_moderation_decisions m left join app.people pe on pe.id = m.decided_by
                           where m.org_id = p_org_id
                             and coalesce(m.feed_post_id, m.comment_id, m.chat_message_id) = p_subject_id), '[]'::jsonb));
end;
$$;

comment on function app.content_report_detail(uuid, app.content_subject_kind, uuid) is 'One reported item for the org''s moderators (org.communication.write): the item (its text while not removed, where it was posted and its author), every report on it with the snapshot and who reported it, and every decision with its statement of reasons, a decision by GHXSTSHIP (6196) under GHXSTSHIP''s name rather than the operator''s. The signed-in moderator''s own content is refused as an item nobody reported.';
revoke all on function app.content_report_detail(uuid, app.content_subject_kind, uuid) from public, anon;
grant execute on function app.content_report_detail(uuid, app.content_subject_kind, uuid) to authenticated, service_role;
