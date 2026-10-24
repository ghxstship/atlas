-- 1630_content_reports.sql
-- ADR 0033 decision 57 (2026-10-23, RRR-137; App Store Review Guideline 1.2, user-generated content). A person reports a
-- post, a comment on a post or a chat message they can see, and the org's moderators act on it within 24 hours:
--   * app.content_reports: one report per reporter and item while it is open, with the reason, optional details, a
--     snapshot of the text as it was reported (moderators are rarely in the conversation) and the time it falls due,
--     24 hours after it arrived. Filed only through app.report_content, never about one's own content or content
--     already removed.
--   * The org's moderators are the members holding org.communication.write across the org, who already hide any feed
--     post (0801). Each is notified when a report arrives (content_report.filed), and again once when a report is
--     still undecided after 24 hours (content_report.overdue, hourly job). The author of the item is never told.
--   * app.content_moderation_decisions: a moderator decides an item with A90's statement of reasons in parts (1473):
--     the action (Removed or No Action), the ground (app.moderation_ground), the rule relied on, the facts and the
--     statement the people involved receive. Removal hides a post (as a moderator's hide does), deletes a comment or
--     deletes a message. One decision decides every open report on the item; each reporter is told the outcome
--     (content_report.decided) and, on removal, the author receives the statement (content.removed). Decisions are
--     append-only; nobody decides about their own content.
--   * Notifications about a decision name the org, never the moderator who decided.
-- Platform operators do not see these reports: workspace content is the org's data, processed for it (A90's console
-- moderates public marketplace listings only).

create type app.content_report_reason as enum ('Harassment', 'Hate', 'Sexual Content', 'Violence', 'Spam', 'Other');
comment on type app.content_report_reason is 'Why a person reported a post, comment or message: harassment or bullying, hate, sexual content, violence or threats, spam or scams, or something else.';

create type app.content_subject_kind as enum ('Feed Post', 'Comment', 'Chat Message');
comment on type app.content_subject_kind is 'What a content report or moderation decision is about: a feed post (any kind, recognition included), a comment on a feed post, or a chat message.';

create type app.content_moderation_action as enum ('Removed', 'No Action');
comment on type app.content_moderation_action is 'A moderator''s decision on reported content: removed (the post hidden, the comment or message deleted) or no action.';

insert into private.domain_event_types (code, subject, description) values
  ('content.reported', 'content_reports', 'A person reported a post, comment or message to the org''s moderators.'),
  ('content.moderated', 'content_moderation_decisions', 'An org moderator decided reported content: removed it or took no action.');

-- Decisions ------------------------------------------------------------------------------------------------------------

create table app.content_moderation_decisions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  subject_kind app.content_subject_kind not null,
  feed_post_id uuid references app.feed_posts (id),
  comment_id uuid references app.comments (id),
  chat_message_id uuid references app.chat_messages (id),
  author_person_id uuid references app.people (id),
  action app.content_moderation_action not null,
  ground app.moderation_ground not null,
  rule_reference text not null,
  facts text not null,
  statement_of_reasons text not null,
  decided_by uuid not null references app.people (id),
  decided_at timestamptz not null default now(),
  constraint content_moderation_decisions_one_subject check (
    num_nonnulls(feed_post_id, comment_id, chat_message_id) = 1
    and (subject_kind = 'Feed Post') = (feed_post_id is not null)
    and (subject_kind = 'Comment') = (comment_id is not null)
    and (subject_kind = 'Chat Message') = (chat_message_id is not null)),
  constraint content_moderation_decisions_ground_fits check (
    (action = 'Removed') = (ground in ('Illegal Content', 'Terms Violation'))),
  constraint content_moderation_decisions_rule_length check (char_length(btrim(rule_reference)) between 1 and 300),
  constraint content_moderation_decisions_facts_length check (char_length(btrim(facts)) between 1 and 4000),
  constraint content_moderation_decisions_statement_length check (char_length(btrim(statement_of_reasons)) between 1 and 4000),
  constraint content_moderation_decisions_not_own check (decided_by is distinct from author_person_id)
);

create index content_moderation_decisions_feed_post_idx on app.content_moderation_decisions (feed_post_id);
create index content_moderation_decisions_comment_idx on app.content_moderation_decisions (comment_id);
create index content_moderation_decisions_chat_message_idx on app.content_moderation_decisions (chat_message_id);
create index content_moderation_decisions_author_idx on app.content_moderation_decisions (author_person_id);
create index content_moderation_decisions_decided_by_idx on app.content_moderation_decisions (decided_by);

call private.install_domain_table('app.content_moderation_decisions', null, null,
  array['app.feed_posts', 'feed_post_id', 'app.comments', 'comment_id', 'app.chat_messages', 'chat_message_id'], true);

call private.describe('app.content_moderation_decisions', 'Append-only decisions by an org''s moderators on reported posts, comments and messages (ADR 0033 decision 57), with A90''s statement of reasons in parts (1473). Written only through app.decide_content_report; one decision decides every open report on the item.', array[
  'subject_kind', 'Feed Post, Comment or Chat Message.',
  'feed_post_id', 'Post decided, when the item is a post.',
  'comment_id', 'Comment decided, when the item is a comment on a post.',
  'chat_message_id', 'Message decided, when the item is a chat message.',
  'author_person_id', 'Person who wrote the item, who receives the statement of reasons on removal.',
  'action', 'Removed or No Action.',
  'ground', 'Illegal Content or Terms Violation for a removal, No Violation for no action.',
  'rule_reference', 'The law or the clause of the terms, policies or the org''s own rules relied on, for example Acceptable Use Policy 1.',
  'facts', 'The facts and circumstances the decision rests on.',
  'statement_of_reasons', 'The statement the reporters and, on removal, the author receive.',
  'decided_by', 'Moderator who decided, from the session; never the author.',
  'decided_at', 'When the decision was made, set by the database.'
]);


-- Reports --------------------------------------------------------------------------------------------------------------

create table app.content_reports (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  subject_kind app.content_subject_kind not null,
  feed_post_id uuid references app.feed_posts (id),
  comment_id uuid references app.comments (id),
  chat_message_id uuid references app.chat_messages (id),
  author_person_id uuid references app.people (id),
  reporter_person_id uuid not null references app.people (id),
  reason app.content_report_reason not null,
  details text,
  content_excerpt text not null,
  reported_at timestamptz not null default now(),
  due_at timestamptz not null,
  escalated_at timestamptz,
  content_moderation_decision_id uuid references app.content_moderation_decisions (id),
  constraint content_reports_one_subject check (
    num_nonnulls(feed_post_id, comment_id, chat_message_id) = 1
    and (subject_kind = 'Feed Post') = (feed_post_id is not null)
    and (subject_kind = 'Comment') = (comment_id is not null)
    and (subject_kind = 'Chat Message') = (chat_message_id is not null)),
  constraint content_reports_details_length check (details is null or char_length(btrim(details)) between 1 and 2000),
  constraint content_reports_excerpt_length check (char_length(content_excerpt) between 1 and 4000),
  constraint content_reports_not_own check (reporter_person_id is distinct from author_person_id)
);

create index content_reports_feed_post_idx on app.content_reports (feed_post_id);
create index content_reports_comment_idx on app.content_reports (comment_id);
create index content_reports_chat_message_idx on app.content_reports (chat_message_id);
create index content_reports_author_idx on app.content_reports (author_person_id);
create index content_reports_reporter_idx on app.content_reports (reporter_person_id);
create index content_reports_decision_idx on app.content_reports (content_moderation_decision_id);

call private.install_domain_table('app.content_reports', null, null,
  array['app.feed_posts', 'feed_post_id', 'app.comments', 'comment_id', 'app.chat_messages', 'chat_message_id',
        'app.content_moderation_decisions', 'content_moderation_decision_id']);

-- One open report per person and item; reporting it again returns the open one.
create unique index content_reports_one_open on app.content_reports
  (reporter_person_id, coalesce(feed_post_id, comment_id, chat_message_id))
  where content_moderation_decision_id is null and deleted_at is null;
create index content_reports_open_idx on app.content_reports (org_id, due_at)
  where content_moderation_decision_id is null and deleted_at is null;

call private.describe('app.content_reports', 'Reports of a post, a comment on a post or a chat message to the org''s moderators (ADR 0033 decision 57, App Store Review Guideline 1.2). Filed only through app.report_content; open until a moderator''s decision on the item decides it, due 24 hours after it arrived.', array[
  'subject_kind', 'Feed Post, Comment or Chat Message.',
  'feed_post_id', 'Post reported, when the item is a post.',
  'comment_id', 'Comment reported, when the item is a comment on a post.',
  'chat_message_id', 'Message reported, when the item is a chat message.',
  'author_person_id', 'Person who wrote the item; never told who reported it.',
  'reporter_person_id', 'Person who reported, from the session.',
  'reason', 'Harassment, Hate, Sexual Content, Violence, Spam or Other.',
  'details', 'What the reporter added, optional.',
  'content_excerpt', 'The item''s text when it was reported, so moderators see what was reported even when they cannot read the conversation.',
  'reported_at', 'When the report arrived, set by the database.',
  'due_at', 'When a decision is due: 24 hours after the report arrived.',
  'escalated_at', 'When the moderators were reminded that the report passed its due time undecided.',
  'content_moderation_decision_id', 'Decision that decided the report; NULL while it is open.'
]);

call private.install_policies('app.content_reports',
  $$reporter_person_id = (select private.current_person_id())
    or org_id in (select private.orgs_with_capability('org.communication.write'))$$);
call private.install_audit_trail('app.content_reports');
call private.install_default_retention('app.content_reports');

-- A decision reads to the moderators, the author and the people whose reports it decided.
call private.install_policies('app.content_moderation_decisions',
  $$author_person_id = (select private.current_person_id())
    or org_id in (select private.orgs_with_capability('org.communication.write'))
    or id in (select r.content_moderation_decision_id from app.content_reports r
              where r.reporter_person_id = (select private.current_person_id()))$$);
call private.install_audit_trail('app.content_moderation_decisions');
call private.install_default_retention('app.content_moderation_decisions');

-- The item behind a report -------------------------------------------------------------------------------------------

create or replace function private.reported_content(p_subject_kind app.content_subject_kind, p_subject_id uuid)
returns table (
  org_id uuid,
  project_id uuid,
  author_person_id uuid,
  body text,
  removed boolean,
  readable boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.org_id, p.project_id, m.person_id,
    left(concat_ws(E'\n', nullif(btrim(p.title), ''), p.body), 4000),
    p.hidden_at is not null or p.deleted_at is not null,
    private.can_read_feed_post(p.org_id, p.author_membership_id, p.publish_at, p.hidden_at, p.audience_kind, p.project_id,
      p.team_id, p.role_id, p.group_id, p.department_code)
  from app.feed_posts p
  left join app.memberships m on m.id = p.author_membership_id
  where p_subject_kind = 'Feed Post' and p.id = p_subject_id
  union all
  select c.org_id, p.project_id, c.author_person_id, left(c.body, 4000),
    c.deleted_at is not null or t.deleted_at is not null or p.hidden_at is not null or p.deleted_at is not null,
    private.can_read_feed_post(p.org_id, p.author_membership_id, p.publish_at, p.hidden_at, p.audience_kind, p.project_id,
      p.team_id, p.role_id, p.group_id, p.department_code)
  from app.comments c
  join app.comment_threads t on t.id = c.comment_thread_id and t.subject_table = 'app.feed_posts'
  join app.feed_posts p on p.id = t.subject_id
  where p_subject_kind = 'Comment' and c.id = p_subject_id
  union all
  select cm.org_id, null::uuid, m.person_id,
    left(coalesce(nullif(btrim(cm.body), ''), '[' || cm.message_kind::text || ']'), 4000),
    cm.deleted_at is not null,
    cm.conversation_id in (select private.my_conversation_ids())
  from app.chat_messages cm
  join app.memberships m on m.id = cm.author_membership_id
  where p_subject_kind = 'Chat Message' and cm.id = p_subject_id;
$$;

comment on function private.reported_content(app.content_subject_kind, uuid) is 'The item a content report is about: its org, project, author, text (a post''s title and body; a photo, file or voice message without text as its kind in brackets), whether it was removed, and whether the signed-in person reads it. Only comments on feed posts are reportable content.';
revoke all on function private.reported_content(app.content_subject_kind, uuid) from public, anon, authenticated;

create or replace function private.content_moderator_ids(p_org_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct m.person_id from app.memberships m
  where m.org_id = p_org_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    and private.person_capability_reach(m.person_id, p_org_id, 'org.communication.write', true) = 'organization';
$$;

comment on function private.content_moderator_ids(uuid) is 'The org''s moderators: active members holding org.communication.write across the org.';
revoke all on function private.content_moderator_ids(uuid) from public, anon, authenticated;

-- Reporting ------------------------------------------------------------------------------------------------------------

create or replace function private.content_subject_word(p_subject_kind app.content_subject_kind)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_subject_kind when 'Feed Post' then 'post' when 'Comment' then 'comment' else 'message' end;
$$;

comment on function private.content_subject_word(app.content_subject_kind) is 'The word the notification copy selects on for a reported item: post, comment or message (email.kinds.content_report and content.removed).';
revoke all on function private.content_subject_word(app.content_subject_kind) from public, anon, authenticated;


create or replace function app.report_content(
  p_subject_kind app.content_subject_kind,
  p_subject_id uuid,
  p_reason app.content_report_reason,
  p_details text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_item record;
  v_id uuid;
  v_due timestamptz;
  v_moderator uuid;
begin
  select * into v_item from private.reported_content(p_subject_kind, p_subject_id);
  if v_item.org_id is null or not v_item.readable then
    raise exception using errcode = '42501', message = 'the content does not exist or is not visible';
  end if;
  if v_item.author_person_id = v_person then
    perform private.refuse('content_report_own', 'You cannot report your own post, comment or message.');
  end if;
  select r.id into v_id from app.content_reports r
  where r.reporter_person_id = v_person and r.deleted_at is null and r.content_moderation_decision_id is null
    and coalesce(r.feed_post_id, r.comment_id, r.chat_message_id) = p_subject_id;
  if v_id is not null then
    return v_id;
  end if;
  if v_item.removed then
    perform private.refuse('content_report_removed', 'This was already removed.');
  end if;
  insert into app.content_reports (org_id, subject_kind, feed_post_id, comment_id, chat_message_id, author_person_id,
    reporter_person_id, reason, details, content_excerpt, due_at)
  values (v_item.org_id, p_subject_kind,
    case when p_subject_kind = 'Feed Post' then p_subject_id end,
    case when p_subject_kind = 'Comment' then p_subject_id end,
    case when p_subject_kind = 'Chat Message' then p_subject_id end,
    v_item.author_person_id, v_person, p_reason, nullif(btrim(p_details), ''), v_item.body, now() + interval '24 hours')
  returning id, due_at into v_id, v_due;
  perform private.emit_event(v_item.org_id, 'content.reported', 'content_reports', v_id, v_item.project_id,
    jsonb_build_object('subject_kind', p_subject_kind, 'reason', p_reason));
  -- The author is never told, even when they moderate.
  for v_moderator in
    select x from private.content_moderator_ids(v_item.org_id) x
    where x <> v_person and x is distinct from v_item.author_person_id
  loop
    perform private.notify(v_item.org_id, v_moderator, 'content_report.filed', 'app.content_reports', v_id, v_item.project_id,
      jsonb_build_object('subject', private.content_subject_word(p_subject_kind),
        'reason', lower(replace(p_reason::text, ' ', '_')), 'dueAt', v_due, 'actorName', ''));
  end loop;
  return v_id;
end;
$$;

comment on function app.report_content(app.content_subject_kind, uuid, app.content_report_reason, text) is 'Reports a feed post, a comment on a feed post or a chat message the signed-in person can see to the org''s moderators, with a reason and optional details, and notifies each moderator (content_report.filed) except the author. Refuses one''s own content and content already removed; reporting an item again while the first report is open returns that report. Returns the report id.';
revoke all on function app.report_content(app.content_subject_kind, uuid, app.content_report_reason, text) from public, anon;
grant execute on function app.report_content(app.content_subject_kind, uuid, app.content_report_reason, text) to authenticated, service_role;

-- The moderators' queue ------------------------------------------------------------------------------------------------

create or replace function private.require_content_moderator(p_org_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
begin
  if not private.has_capability(p_org_id, 'org.communication.write') then
    perform private.refuse('content_moderation_authority', 'Reviewing reported content needs org.communication.write.');
  end if;
  return v_person;
end;
$$;

comment on function private.require_content_moderator(uuid) is 'Refuses unless the signed-in person moderates the org (org.communication.write across it); returns their person id.';
revoke all on function private.require_content_moderator(uuid) from public, anon, authenticated;

create or replace function app.content_moderation_queue(p_org_id uuid, p_open boolean default true)
returns table (
  subject_kind app.content_subject_kind,
  subject_id uuid,
  author_person_id uuid,
  author_name text,
  content_excerpt text,
  removed boolean,
  open_reports bigint,
  total_reports bigint,
  reasons app.content_report_reason[],
  first_reported_at timestamptz,
  due_at timestamptz,
  overdue boolean,
  last_action app.content_moderation_action,
  last_decided_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_content_moderator(p_org_id);
  return query
  select q.subject_kind, q.subject_id, q.author_person_id, pe.full_name, q.content_excerpt, coalesce(i.removed, true),
    q.open_reports, q.total_reports, q.reasons, q.first_reported_at, q.due_at, q.due_at <= now(), d.action, d.decided_at
  from (
    select r.subject_kind, coalesce(r.feed_post_id, r.comment_id, r.chat_message_id) as subject_id,
      (array_agg(r.author_person_id order by r.reported_at desc))[1] as author_person_id,
      (array_agg(r.content_excerpt order by r.reported_at desc))[1] as content_excerpt,
      count(*) filter (where r.content_moderation_decision_id is null) as open_reports,
      count(*) as total_reports,
      array_agg(distinct r.reason order by r.reason) as reasons,
      min(r.reported_at) filter (where r.content_moderation_decision_id is null) as first_reported_at,
      min(r.due_at) filter (where r.content_moderation_decision_id is null) as due_at
    from app.content_reports r
    where r.org_id = p_org_id and r.deleted_at is null
    group by r.subject_kind, coalesce(r.feed_post_id, r.comment_id, r.chat_message_id)
  ) q
  left join app.people pe on pe.id = q.author_person_id
  left join lateral (select x.removed from private.reported_content(q.subject_kind, q.subject_id) x limit 1) i on true
  left join lateral (select m.action, m.decided_at from app.content_moderation_decisions m
                     where m.org_id = p_org_id and coalesce(m.feed_post_id, m.comment_id, m.chat_message_id) = q.subject_id
                     order by m.decided_at desc, m.id desc limit 1) d on true
  where (p_open and q.open_reports > 0) or (not p_open and q.open_reports = 0)
  order by q.due_at nulls last, d.decided_at desc nulls last
  limit 200;
end;
$$;

comment on function app.content_moderation_queue(uuid, boolean) is 'The org moderators'' queue (org.communication.write): reported posts, comments and messages with open reports, the one due first at the top, each with its newest snapshot, author, report counts, reasons, due time and whether it is overdue; or, with p_open false, items whose reports are all decided, newest decision first.';
revoke all on function app.content_moderation_queue(uuid, boolean) from public, anon;
grant execute on function app.content_moderation_queue(uuid, boolean) to authenticated, service_role;

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
  if v_item.org_id is distinct from p_org_id
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
      'removed', v_item.removed,
      'decidable_by_me', v_item.author_person_id is distinct from v_person),
    'reports', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'reason', r.reason, 'details', r.details,
                           'content_excerpt', r.content_excerpt, 'reported_at', r.reported_at, 'due_at', r.due_at,
                           'reporter_name', pe.full_name, 'open', r.content_moderation_decision_id is null)
                           order by r.reported_at desc)
                         from app.content_reports r left join app.people pe on pe.id = r.reporter_person_id
                         where r.org_id = p_org_id and r.deleted_at is null
                           and coalesce(r.feed_post_id, r.comment_id, r.chat_message_id) = p_subject_id), '[]'::jsonb),
    'decisions', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'action', m.action, 'ground', m.ground,
                             'rule_reference', m.rule_reference, 'facts', m.facts, 'statement', m.statement_of_reasons,
                             'decided_at', m.decided_at, 'decided_by_name', pe.full_name)
                             order by m.decided_at desc, m.id desc)
                           from app.content_moderation_decisions m left join app.people pe on pe.id = m.decided_by
                           where m.org_id = p_org_id
                             and coalesce(m.feed_post_id, m.comment_id, m.chat_message_id) = p_subject_id), '[]'::jsonb));
end;
$$;

comment on function app.content_report_detail(uuid, app.content_subject_kind, uuid) is 'One reported item for the org''s moderators (org.communication.write): the item (its text while not removed, where it was posted, its author, and whether the signed-in moderator may decide it, never their own), every report on it with the snapshot and who reported it, and every decision with its statement of reasons.';
revoke all on function app.content_report_detail(uuid, app.content_subject_kind, uuid) from public, anon;
grant execute on function app.content_report_detail(uuid, app.content_subject_kind, uuid) to authenticated, service_role;

-- Deciding -------------------------------------------------------------------------------------------------------------

create or replace function app.decide_content_report(
  p_org_id uuid,
  p_subject_kind app.content_subject_kind,
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
  v_person uuid := private.require_content_moderator(p_org_id);
  v_item record;
  v_id uuid;
  v_reporter uuid;
  v_conversation uuid;
begin
  select * into v_item from private.reported_content(p_subject_kind, p_subject_id);
  if v_item.org_id is distinct from p_org_id then
    raise exception using errcode = '42501', message = 'no report about this item';
  end if;
  if v_item.author_person_id = v_person then
    perform private.refuse('content_moderation_own', 'Another moderator decides reports about your own post, comment or message.');
  end if;
  if not exists (select 1 from app.content_reports r where r.org_id = p_org_id and r.deleted_at is null
                   and r.content_moderation_decision_id is null
                   and coalesce(r.feed_post_id, r.comment_id, r.chat_message_id) = p_subject_id) then
    perform private.refuse('content_moderation_nothing_open', 'Every report about this was already decided.');
  end if;

  insert into app.content_moderation_decisions (org_id, subject_kind, feed_post_id, comment_id, chat_message_id,
    author_person_id, action, ground, rule_reference, facts, statement_of_reasons, decided_by)
  values (p_org_id, p_subject_kind,
    case when p_subject_kind = 'Feed Post' then p_subject_id end,
    case when p_subject_kind = 'Comment' then p_subject_id end,
    case when p_subject_kind = 'Chat Message' then p_subject_id end,
    v_item.author_person_id, p_action, p_ground, btrim(p_rule_reference), btrim(p_facts), btrim(p_statement), v_person)
  returning id into v_id;

  if p_action = 'Removed' and not v_item.removed then
    if p_subject_kind = 'Feed Post' then
      update app.feed_posts set hidden_at = now(), hidden_reason = btrim(left(btrim(p_statement), 500)), pinned_at = null
      where id = p_subject_id;
      perform private.emit_event(p_org_id, 'feed_post.hidden', 'feed_posts', p_subject_id, v_item.project_id,
        jsonb_build_object('reason', btrim(left(btrim(p_statement), 500)), 'content_moderation_decision_id', v_id));
    elsif p_subject_kind = 'Comment' then
      update app.comments set deleted_at = now() where id = p_subject_id;
    else
      update app.chat_messages set deleted_at = now() where id = p_subject_id
      returning conversation_id into v_conversation;
      perform private.emit_event(p_org_id, 'chat_message.deleted', 'chat_messages', p_subject_id, null,
        jsonb_build_object('conversation_id', v_conversation, 'content_moderation_decision_id', v_id));
    end if;
  end if;

  update app.content_reports set content_moderation_decision_id = v_id
  where org_id = p_org_id and deleted_at is null and content_moderation_decision_id is null
    and coalesce(feed_post_id, comment_id, chat_message_id) = p_subject_id;
  perform private.emit_event(p_org_id, 'content.moderated', 'content_moderation_decisions', v_id, v_item.project_id,
    jsonb_build_object('subject_kind', p_subject_kind, 'action', p_action, 'ground', p_ground));

  -- The notices name the org, never the moderator who decided.
  for v_reporter in
    select distinct r.reporter_person_id from app.content_reports r where r.content_moderation_decision_id = v_id
  loop
    perform private.notify(p_org_id, v_reporter, 'content_report.decided', 'app.content_moderation_decisions', v_id,
      v_item.project_id, jsonb_build_object('subject', private.content_subject_word(p_subject_kind), 'action', p_action,
        'statement', btrim(p_statement), 'actorName', ''));
  end loop;
  if p_action = 'Removed' and v_item.author_person_id is not null then
    perform private.notify(p_org_id, v_item.author_person_id, 'content.removed', 'app.content_moderation_decisions', v_id,
      v_item.project_id, jsonb_build_object('subject', private.content_subject_word(p_subject_kind), 'ground', p_ground,
        'ruleReference', btrim(p_rule_reference), 'statement', btrim(p_statement), 'actorName', ''));
  end if;
  return v_id;
end;
$$;

comment on function app.decide_content_report(uuid, app.content_subject_kind, uuid, app.content_moderation_action, app.moderation_ground, text, text, text) is 'An org moderator (org.communication.write) decides a reported item with a statement of reasons in parts: Removed hides a post, deletes a comment or deletes a message; No Action leaves it. Decides every open report on the item, tells each reporter the outcome (content_report.decided) and, on removal, sends the author the statement (content.removed); the notices name the org. Refuses a moderator deciding about their own content and an item with no open report. Returns the decision id.';
revoke all on function app.decide_content_report(uuid, app.content_subject_kind, uuid, app.content_moderation_action, app.moderation_ground, text, text, text) from public, anon;
grant execute on function app.decide_content_report(uuid, app.content_subject_kind, uuid, app.content_moderation_action, app.moderation_ground, text, text, text) to authenticated, service_role;

-- Reports past their 24 hours --------------------------------------------------------------------------------------------

create or replace function private.escalate_overdue_content_reports()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item record;
  v_moderator uuid;
  v_count integer := 0;
begin
  for v_item in
    select r.org_id, r.subject_kind, coalesce(r.feed_post_id, r.comment_id, r.chat_message_id) as subject_id,
      (array_agg(r.id order by r.reported_at))[1] as report_id,
      (array_agg(r.author_person_id order by r.reported_at desc))[1] as author_person_id,
      min(r.due_at) as due_at, count(*) as open_reports
    from app.content_reports r
    where r.deleted_at is null and r.content_moderation_decision_id is null and r.escalated_at is null and r.due_at <= now()
    group by r.org_id, r.subject_kind, coalesce(r.feed_post_id, r.comment_id, r.chat_message_id)
  loop
    for v_moderator in
      select x from private.content_moderator_ids(v_item.org_id) x where x is distinct from v_item.author_person_id
    loop
      perform private.notify(v_item.org_id, v_moderator, 'content_report.overdue', 'app.content_reports', v_item.report_id, null,
        jsonb_build_object('subject', private.content_subject_word(v_item.subject_kind), 'openReports', v_item.open_reports,
          'dueAt', v_item.due_at, 'actorName', ''));
    end loop;
    update app.content_reports set escalated_at = now()
    where org_id = v_item.org_id and deleted_at is null and content_moderation_decision_id is null and escalated_at is null
      and coalesce(feed_post_id, comment_id, chat_message_id) = v_item.subject_id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function private.escalate_overdue_content_reports() is 'Hourly (xos_escalate_overdue_content_reports): reminds the org''s moderators, once per item, of reports still undecided 24 hours after they arrived (content_report.overdue), never the item''s author, and stamps them escalated. Returns how many items were escalated.';
revoke all on function private.escalate_overdue_content_reports() from public, anon, authenticated;

select cron.schedule('xos_escalate_overdue_content_reports', '47 * * * *', 'select private.escalate_overdue_content_reports()');
