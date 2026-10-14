-- 0580_comments.sql
-- A18 Platform Services. The one unified comment system (Section 7.3 Workflow engine), for every module:
--   * comment_threads keyed by subject table and subject id, comments with a version history of every edit,
--     comment_mentions, comment_reactions and thread_subscriptions
--   * row level security follows the subject's own read policy: private.can_read_subject runs as the caller
--     and asks the subject table itself, so whoever cannot read the record cannot read its comments
--     (invariant 2). Helpers take column values as arguments (ADR 0016 rule 14)
--   * mentions and new comments notify through private.notify; edits keep the earlier text; deletes are soft
--     and clear the text from view; domain events and the audit trail cover every change
--   * verified email replies (0550) post as comments in the thread of the notification's subject

-- Commentable subjects -----------------------------------------------------------------------------------------

create table private.comment_subjects (
  table_name text primary key,
  constraint comment_subjects_table_format check (table_name ~ '^app\.[a-z][a-z0-9_]*$')
);

comment on table private.comment_subjects is 'Tables whose rows carry comments and attachments. Module ranges add their own tables here. Every subject table has id, org_id and its own read policy, which comment access follows.';
comment on column private.comment_subjects.table_name is 'Schema-qualified subject table.';

alter table private.comment_subjects enable row level security;
revoke all on private.comment_subjects from public, anon, authenticated;
grant select on private.comment_subjects to service_role;

insert into private.comment_subjects (table_name)
select t from unnest(array[
  'app.records', 'app.projects', 'app.purchase_orders', 'app.invoices', 'app.expenses', 'app.change_orders', 'app.vendors',
  'app.venues', 'app.incidents', 'app.asset_units', 'app.documents', 'app.shifts', 'app.timesheets', 'app.rfqs',
  'app.custom_object_records', 'app.work_orders', 'app.punch_items', 'app.engagements', 'app.opportunities',
  'app.inspections', 'app.advance_packets', 'app.shipments', 'app.payroll_runs'
]) t
where to_regclass(t) is not null;

create view app.comment_subjects as
select s.table_name from private.comment_subjects s;
comment on view app.comment_subjects is 'Tables whose rows carry comments and attachments.';
comment on column app.comment_subjects.table_name is 'Subject table.';
revoke all on app.comment_subjects from public, anon;
grant select on app.comment_subjects to authenticated, service_role;

-- Subject access ------------------------------------------------------------------------------------------------

create or replace function private.can_read_subject(p_subject_table text, p_subject_id uuid)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_found boolean;
begin
  if p_subject_table is null or p_subject_id is null
     or p_subject_table not in (select s.table_name from app.comment_subjects s) then
    return false;
  end if;
  execute format('select exists (select 1 from %s t where t.id = $1 and t.deleted_at is null)', p_subject_table)
    into v_found using p_subject_id;
  return v_found;
end;
$$;

comment on function private.can_read_subject(text, uuid) is 'True when the caller can read a comment or attachment subject. Runs as the caller (security invoker), so the subject table''s own read policy decides (invariant 2). Takes the subject as arguments and never reads comment tables (ADR 0016 rule 14). References only app objects, which the caller may resolve.';

create or replace function private.subject_row(p_subject_table text, p_subject_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
begin
  if p_subject_table not in (select s.table_name from private.comment_subjects s) then
    return null;
  end if;
  execute format('select to_jsonb(t) from %s t where t.id = $1', p_subject_table) into v_row using p_subject_id;
  if p_subject_table = 'app.projects' and v_row is not null then
    v_row := v_row || jsonb_build_object('project_id', v_row -> 'id');
  end if;
  return v_row;
end;
$$;

comment on function private.subject_row(text, uuid) is 'The subject row as JSON, read with definer rights, for deriving its org, project and title inside triggers; a project subject carries its own id as project_id. Never returned to callers.';

create or replace function private.subject_title(p_subject jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_subject ->> 'title', p_subject ->> 'name', p_subject ->> 'project_key', p_subject ->> 'asset_tag', '');
$$;

comment on function private.subject_title(jsonb) is 'Display title of a subject row: its title, name, project key or asset tag.';

create or replace function private.person_may_read_subject(p_person_id uuid, p_subject jsonb)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((p_subject ->> 'org_id')::uuid in (select private.person_org_ids(p_person_id)), false)
    and (
      p_subject ->> 'project_id' is null
      or exists (
        select 1 from app.project_members pm join app.memberships m on m.id = pm.membership_id
        where pm.project_id = (p_subject ->> 'project_id')::uuid and m.person_id = p_person_id
          and pm.deleted_at is null and pm.valid_from <= now() and (pm.valid_to is null or pm.valid_to > now())
          and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()))
      or coalesce(private.person_capability_reach(p_person_id, (p_subject ->> 'org_id')::uuid, 'projects.members.manage', false) = 'organization', false)
    );
$$;

comment on function private.person_may_read_subject(uuid, jsonb) is 'Whether another person can reach a subject, for mentions and notifications: an active member of its org and, for a project subject, of its project or an overseer of every project (invariant 2). Nobody is notified about a subject they cannot open.';

-- Threads ---------------------------------------------------------------------------------------------------------

create table app.comment_threads (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  subject_table text not null references private.comment_subjects (table_name),
  subject_id uuid not null,
  anchor text,
  resolved_at timestamptz,
  resolved_by uuid references app.people (id),
  constraint comment_threads_anchor_length check (anchor is null or char_length(anchor) between 1 and 200),
  constraint comment_threads_resolved_pair check ((resolved_at is null) = (resolved_by is null))
);

create index comment_threads_subject_idx on app.comment_threads (subject_table, subject_id);
create index comment_threads_subject_id_idx on app.comment_threads (subject_id);
create index comment_threads_resolved_by_idx on app.comment_threads (resolved_by);

call private.install_domain_table('app.comment_threads');
call private.describe('app.comment_threads', 'Comment threads on any subject row (Section 7.3: one unified comment system). A subject has its main thread and may have anchored threads, for example on a field or a passage of a document. Readable by whoever can read the subject.', array[
  'org_id', 'Org of the subject, derived from it on insert; never accepted from the caller.',
  'subject_table', 'Table of the subject.',
  'subject_id', 'Row the thread is about.',
  'anchor', 'What part of the subject the thread is anchored to, or null for the main thread.',
  'resolved_at', 'When the thread was resolved.',
  'resolved_by', 'Who resolved it, set from the session.'
]);

create unique index comment_threads_one_per_anchor on app.comment_threads (subject_table, subject_id, coalesce(anchor, '')) where deleted_at is null;

create or replace function private.guard_comment_thread()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject jsonb := private.subject_row(new.subject_table, new.subject_id);
begin
  if tg_op = 'INSERT' then
    if v_subject is null then
      perform private.refuse('comment_subject_unknown', 'The subject does not exist or does not take comments.');
    end if;
    new.org_id := (v_subject ->> 'org_id')::uuid;
    new.resolved_at := null;
    new.resolved_by := null;
    return new;
  end if;
  if new.subject_table <> old.subject_table or new.subject_id <> old.subject_id or new.anchor is distinct from old.anchor then
    perform private.refuse('comment_thread_immutable', 'A thread stays on its subject.');
  end if;
  if new.resolved_at is distinct from old.resolved_at then
    new.resolved_at := case when new.resolved_at is null then null else now() end;
    new.resolved_by := case when new.resolved_at is null then null else private.current_person_id() end;
  end if;
  return new;
end;
$$;

comment on function private.guard_comment_thread() is 'Comment threads: org derived from the subject, a thread never moves, and resolution is stamped with the database time and the session person.';

create trigger t11_guard_comment_thread before insert or update on app.comment_threads
  for each row execute function private.guard_comment_thread();

call private.install_policies('app.comment_threads',
  $$private.can_read_subject(subject_table, subject_id)$$,
  $$private.can_read_subject(subject_table, subject_id)$$);

create or replace function private.can_read_thread(p_thread_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (select 1 from app.comment_threads t where t.id = p_thread_id and t.deleted_at is null);
$$;

comment on function private.can_read_thread(uuid) is 'True when the caller can read a thread. Runs as the caller, so the thread''s policy (the subject''s read policy) decides; takes the thread id as an argument (ADR 0016 rule 14).';

-- Comments ----------------------------------------------------------------------------------------------------------

create type app.comment_source as enum ('App', 'Email', 'API');
comment on type app.comment_source is 'Where a comment was written: in an XOS app, as an email reply, or through the API.';

create table app.comments (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  comment_thread_id uuid not null references app.comment_threads (id),
  author_person_id uuid not null references app.people (id),
  body text not null,
  source app.comment_source not null default 'App',
  edited_at timestamptz,
  constraint comments_body_length check (char_length(body) <= 20000)
);

create index comments_author_idx on app.comments (author_person_id);

call private.install_domain_table('app.comments', 'app.comment_threads', 'comment_thread_id');
create index comments_thread_idx on app.comments (comment_thread_id, created_at);
call private.describe('app.comments', 'Comments in a thread. Editing keeps every earlier text in comment_versions; deleting is soft and clears the text from view.', array[
  'comment_thread_id', 'Thread the comment is in.',
  'author_person_id', 'Person who wrote it, set from the session.',
  'body', 'Comment text (Markdown subset), empty once deleted.',
  'source', 'App, Email or API.',
  'edited_at', 'When the text was last edited.'
]);

alter table app.comments add constraint comments_body_present check (deleted_at is not null or char_length(btrim(body)) >= 1);

create table app.comment_versions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  comment_id uuid not null references app.comments (id),
  version_number integer not null,
  body text not null,
  constraint comment_versions_number_positive check (version_number > 0)
);

create unique index comment_versions_number_key on app.comment_versions (comment_id, version_number);

call private.install_domain_table('app.comment_versions', 'app.comments', 'comment_id', '{}', true);
call private.describe('app.comment_versions', 'Edit history of comments: the text each comment had before every edit or deletion, numbered from 1. Append-only. Readable by the author and by readers of the audit log.', array[
  'comment_id', 'Comment.',
  'version_number', 'Version, 1 for the first text.',
  'body', 'Text the comment had in this version.'
]);

create or replace function private.guard_comment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.current_person_id();
begin
  if tg_op = 'INSERT' then
    if not private.in_trusted_operation('comment_from_email') then
      if v_person is null then
        perform private.refuse('comment_author_required', 'A comment has a signed-in author.');
      end if;
      new.author_person_id := v_person;
      if new.source = 'Email' then
        perform private.refuse('comment_source', 'Email comments arrive only through verified replies.');
      end if;
    end if;
    new.edited_at := null;
    new.deleted_at := null;
    if exists (select 1 from app.comment_threads t where t.id = new.comment_thread_id and t.deleted_at is not null) then
      perform private.refuse('comment_thread_closed', 'The thread was deleted.');
    end if;
    return new;
  end if;
  if new.comment_thread_id <> old.comment_thread_id or new.author_person_id <> old.author_person_id or new.source <> old.source then
    perform private.refuse('comment_immutable', 'A comment keeps its thread, author and source.');
  end if;
  if old.deleted_at is not null then
    perform private.refuse('comment_deleted', 'A deleted comment stays deleted.');
  end if;
  if new.deleted_at is not null then
    new.deleted_at := now();
    new.body := '';
  elsif new.body is distinct from old.body then
    new.edited_at := now();
  end if;
  if new.body is distinct from old.body then
    insert into app.comment_versions (comment_id, version_number, body)
    values (old.id, coalesce((select max(v.version_number) from app.comment_versions v where v.comment_id = old.id), 0) + 1, old.body);
  end if;
  return new;
end;
$$;

comment on function private.guard_comment() is 'Comments: the author comes from the session (email replies excepted), a comment keeps its thread, author and source, every change of text saves the earlier text to comment_versions, and a delete is soft, clears the text and is final.';

create trigger t40_guard_comment before insert or update on app.comments
  for each row execute function private.guard_comment();

call private.install_policies('app.comments',
  $$private.can_read_thread(comment_thread_id)$$,
  $$private.can_read_thread(comment_thread_id) and author_person_id = (select private.current_person_id())$$,
  $$private.can_read_thread(comment_thread_id) and author_person_id = (select private.current_person_id())$$);

call private.install_policies('app.comment_versions',
  $$comment_id in (select c.id from app.comments c where c.author_person_id = (select private.current_person_id()))
    or org_id in (select private.orgs_with_capability('audit.log.read'))$$);

-- Mentions ------------------------------------------------------------------------------------------------------------

create table app.comment_mentions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  comment_id uuid not null references app.comments (id),
  mentioned_person_id uuid not null references app.people (id)
);

create index comment_mentions_comment_idx on app.comment_mentions (comment_id);
create index comment_mentions_person_idx on app.comment_mentions (mentioned_person_id);

call private.install_domain_table('app.comment_mentions', 'app.comments', 'comment_id');
call private.describe('app.comment_mentions', 'People mentioned in a comment. Only people who can reach the subject may be mentioned; each mention notifies and subscribes them.', array[
  'comment_id', 'Comment.',
  'mentioned_person_id', 'Person mentioned.'
]);

create unique index comment_mentions_unique on app.comment_mentions (comment_id, mentioned_person_id) where deleted_at is null;

create or replace function private.comment_context(p_comment_id uuid)
returns table (comment_thread_id uuid, author_person_id uuid, subject_table text, subject_id uuid, subject jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select c.comment_thread_id, c.author_person_id, t.subject_table, t.subject_id, private.subject_row(t.subject_table, t.subject_id)
  from app.comments c join app.comment_threads t on t.id = c.comment_thread_id
  where c.id = p_comment_id;
$$;

comment on function private.comment_context(uuid) is 'Thread, author and subject of a comment, for triggers.';

create or replace function private.after_comment_mention()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ctx record;
begin
  select * into v_ctx from private.comment_context(new.comment_id);
  if v_ctx.author_person_id <> private.current_person_id() and not private.in_trusted_operation('comment_from_email') then
    perform private.refuse('comment_mention_author', 'Only the author mentions people in a comment.');
  end if;
  if not private.person_may_read_subject(new.mentioned_person_id, v_ctx.subject) then
    perform private.refuse('comment_mention_no_access', 'Only people who can open the subject can be mentioned.');
  end if;
  insert into app.thread_subscriptions (comment_thread_id, person_id, subscribed)
  values (v_ctx.comment_thread_id, new.mentioned_person_id, true)
  on conflict (comment_thread_id, person_id) where deleted_at is null do nothing;
  if new.mentioned_person_id <> v_ctx.author_person_id then
    perform private.notify(new.org_id, new.mentioned_person_id, 'mention.created', v_ctx.subject_table, v_ctx.subject_id,
      (v_ctx.subject ->> 'project_id')::uuid,
      jsonb_build_object('actorName', coalesce((select p.full_name from app.people p where p.id = v_ctx.author_person_id), ''),
        'title', private.subject_title(v_ctx.subject)));
  end if;
  return null;
end;
$$;

comment on function private.after_comment_mention() is 'After insert trigger on mentions: only the author mentions, only people who can reach the subject, and each mention subscribes the person to the thread and notifies them (category mentions).';

create trigger t60_after_comment_mention after insert on app.comment_mentions
  for each row execute function private.after_comment_mention();

call private.install_policies('app.comment_mentions',
  $$comment_id in (select c.id from app.comments c where private.can_read_thread(c.comment_thread_id))$$,
  $$comment_id in (select c.id from app.comments c where c.author_person_id = (select private.current_person_id()))$$);
revoke update on app.comment_mentions from authenticated;
drop policy comment_mentions_update on app.comment_mentions;

-- Reactions ------------------------------------------------------------------------------------------------------------

create table private.comment_reaction_codes (
  code text primary key,
  sort_order smallint not null unique,
  constraint comment_reaction_codes_format check (code ~ '^[a-z][a-z_]*$')
);

comment on table private.comment_reaction_codes is 'Reactions a comment accepts. Labels and glyphs come from the design system keyed by code.';
comment on column private.comment_reaction_codes.code is 'Reaction code.';
comment on column private.comment_reaction_codes.sort_order is 'Display order.';

alter table private.comment_reaction_codes enable row level security;
revoke all on private.comment_reaction_codes from public, anon, authenticated;
grant select on private.comment_reaction_codes to service_role;

insert into private.comment_reaction_codes (code, sort_order) values
  ('thumbs_up', 1), ('heart', 2), ('check', 3), ('eyes', 4), ('laugh', 5), ('celebrate', 6);

create table app.comment_reactions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  comment_id uuid not null references app.comments (id),
  person_id uuid not null references app.people (id),
  reaction_code text not null references private.comment_reaction_codes (code)
);

create index comment_reactions_comment_idx on app.comment_reactions (comment_id);
create index comment_reactions_person_idx on app.comment_reactions (person_id);
create index comment_reactions_code_idx on app.comment_reactions (reaction_code);

call private.install_domain_table('app.comment_reactions', 'app.comments', 'comment_id');
call private.describe('app.comment_reactions', 'One reaction of one person to one comment. Removing a reaction soft deletes it.', array[
  'comment_id', 'Comment reacted to.',
  'person_id', 'Person who reacted, set from the session.',
  'reaction_code', 'Reaction.'
]);

create unique index comment_reactions_unique on app.comment_reactions (comment_id, person_id, reaction_code) where deleted_at is null;

create or replace function private.stamp_session_person()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_column text := tg_argv[0];
begin
  if tg_op = 'INSERT' then
    new := jsonb_populate_record(new, jsonb_build_object(v_column, private.current_person_id()));
  elsif (to_jsonb(new) ->> v_column) is distinct from (to_jsonb(old) ->> v_column) then
    perform private.refuse('person_immutable', format('%s never changes.', v_column));
  end if;
  return new;
end;
$$;

comment on function private.stamp_session_person() is 'Before insert or update trigger: sets the named person column from the session on insert and refuses changing it. Argument: column name.';

create trigger t40_stamp_reaction_person before insert or update on app.comment_reactions
  for each row execute function private.stamp_session_person('person_id');

call private.install_policies('app.comment_reactions',
  $$comment_id in (select c.id from app.comments c where private.can_read_thread(c.comment_thread_id))$$,
  $$person_id = (select private.current_person_id())
    and comment_id in (select c.id from app.comments c where c.deleted_at is null and private.can_read_thread(c.comment_thread_id))$$);

-- Subscriptions ---------------------------------------------------------------------------------------------------------

create table app.thread_subscriptions (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  comment_thread_id uuid not null references app.comment_threads (id),
  person_id uuid not null references app.people (id),
  subscribed boolean not null
);

create index thread_subscriptions_thread_idx on app.thread_subscriptions (comment_thread_id);
create index thread_subscriptions_person_idx on app.thread_subscriptions (person_id);

call private.install_domain_table('app.thread_subscriptions', 'app.comment_threads', 'comment_thread_id');
call private.describe('app.thread_subscriptions', 'Who follows a thread. Authors and mentioned people are subscribed automatically; anyone who can read the thread may subscribe or unsubscribe. A false row mutes the thread.', array[
  'comment_thread_id', 'Thread.',
  'person_id', 'Person, set from the session for their own choice.',
  'subscribed', 'True to be notified of new comments, false to mute.'
]);

create unique index thread_subscriptions_unique on app.thread_subscriptions (comment_thread_id, person_id) where deleted_at is null;

create or replace function private.guard_thread_subscription()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.person_id <> old.person_id or new.comment_thread_id <> old.comment_thread_id) then
    perform private.refuse('subscription_immutable', 'A subscription keeps its thread and person.');
  end if;
  return new;
end;
$$;

comment on function private.guard_thread_subscription() is 'Thread subscriptions keep their thread and person; people change only their own (policy).';

create trigger t40_guard_thread_subscription before update on app.thread_subscriptions
  for each row execute function private.guard_thread_subscription();

call private.install_policies('app.thread_subscriptions',
  $$person_id = (select private.current_person_id()) and private.can_read_thread(comment_thread_id)$$,
  $$person_id = (select private.current_person_id()) and private.can_read_thread(comment_thread_id)$$);

-- Notifications, events and audit ------------------------------------------------------------------------------------

insert into private.domain_event_types (code, subject, description) values
  ('comment.created', 'comments', 'A comment was posted on a subject.'),
  ('comment.edited', 'comments', 'A comment''s text was edited.'),
  ('comment.deleted', 'comments', 'A comment was deleted.'),
  ('comment_thread.resolved', 'comment_threads', 'A comment thread was resolved.');

create or replace function private.after_comment_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ctx record;
begin
  select * into v_ctx from private.comment_context(new.id);
  insert into app.thread_subscriptions (comment_thread_id, person_id, subscribed)
  values (new.comment_thread_id, new.author_person_id, true)
  on conflict (comment_thread_id, person_id) where deleted_at is null do nothing;
  perform private.emit_event(new.org_id, 'comment.created', 'comments', new.id, (v_ctx.subject ->> 'project_id')::uuid,
    jsonb_build_object('comment_id', new.id, 'comment_thread_id', new.comment_thread_id,
      'subject_table', v_ctx.subject_table, 'subject_id', v_ctx.subject_id, 'source', new.source));
  return null;
end;
$$;

comment on function private.after_comment_insert() is 'After insert trigger on comments: subscribes the author and emits comment.created (no text in the payload).';

create trigger t60_after_comment_insert after insert on app.comments
  for each row execute function private.after_comment_insert();

create or replace function private.notify_comment_subscribers()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ctx record;
  v_person uuid;
begin
  if new.deleted_at is not null then
    return null;
  end if;
  select * into v_ctx from private.comment_context(new.id);
  for v_person in
    select s.person_id from app.thread_subscriptions s
    where s.comment_thread_id = new.comment_thread_id and s.subscribed and s.deleted_at is null
      and s.person_id <> new.author_person_id
      and not exists (select 1 from app.comment_mentions m where m.comment_id = new.id and m.mentioned_person_id = s.person_id and m.deleted_at is null)
  loop
    if private.person_may_read_subject(v_person, v_ctx.subject) then
      perform private.notify(new.org_id, v_person, 'comment.created', v_ctx.subject_table, v_ctx.subject_id,
        (v_ctx.subject ->> 'project_id')::uuid,
        jsonb_build_object('actorName', coalesce((select p.full_name from app.people p where p.id = new.author_person_id), ''),
          'title', private.subject_title(v_ctx.subject)));
    end if;
  end loop;
  return null;
end;
$$;

comment on function private.notify_comment_subscribers() is 'Deferred constraint trigger on comments: at commit, once the comment''s mentions exist, notifies every subscriber except the author and the people the comment mentions (who got a mention notification), and only those who can still reach the subject.';

create constraint trigger t70_notify_comment_subscribers after insert on app.comments
  deferrable initially deferred
  for each row execute function private.notify_comment_subscribers();

create or replace function private.after_comment_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ctx record;
begin
  select * into v_ctx from private.comment_context(new.id);
  if new.deleted_at is not null and old.deleted_at is null then
    perform private.emit_event(new.org_id, 'comment.deleted', 'comments', new.id, (v_ctx.subject ->> 'project_id')::uuid,
      jsonb_build_object('comment_id', new.id, 'comment_thread_id', new.comment_thread_id, 'subject_table', v_ctx.subject_table, 'subject_id', v_ctx.subject_id));
  elsif new.body is distinct from old.body then
    perform private.emit_event(new.org_id, 'comment.edited', 'comments', new.id, (v_ctx.subject ->> 'project_id')::uuid,
      jsonb_build_object('comment_id', new.id, 'comment_thread_id', new.comment_thread_id, 'subject_table', v_ctx.subject_table, 'subject_id', v_ctx.subject_id));
  end if;
  return null;
end;
$$;

comment on function private.after_comment_update() is 'After update trigger on comments: emits comment.edited or comment.deleted.';

create trigger t60_after_comment_update after update on app.comments
  for each row execute function private.after_comment_update();

create or replace function private.after_thread_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.resolved_at is not null and old.resolved_at is null then
    perform private.emit_event(new.org_id, 'comment_thread.resolved', 'comment_threads', new.id,
      (private.subject_row(new.subject_table, new.subject_id) ->> 'project_id')::uuid,
      jsonb_build_object('comment_thread_id', new.id, 'subject_table', new.subject_table, 'subject_id', new.subject_id));
  end if;
  return null;
end;
$$;

comment on function private.after_thread_update() is 'After update trigger on comment threads: emits comment_thread.resolved.';

create trigger t60_after_thread_update after update on app.comment_threads
  for each row execute function private.after_thread_update();

call private.install_audit_trail('app.comments');
call private.install_audit_trail('app.comment_threads');

-- Posting -------------------------------------------------------------------------------------------------------------

create or replace function app.post_comment(
  p_subject_table text,
  p_subject_id uuid,
  p_body text,
  p_mentions uuid[] default '{}',
  p_anchor text default null
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_thread uuid;
  v_comment uuid;
  v_readable boolean := false;
begin
  if p_subject_table in (select s.table_name from app.comment_subjects s) then
    execute format('select exists (select 1 from %s t where t.id = $1 and t.deleted_at is null)', p_subject_table)
      into v_readable using p_subject_id;
  end if;
  if not v_readable then
    raise exception using errcode = '42501', message = 'subject not found';
  end if;
  select t.id into v_thread from app.comment_threads t
  where t.subject_table = p_subject_table and t.subject_id = p_subject_id and t.anchor is not distinct from p_anchor and t.deleted_at is null;
  if v_thread is null then
    insert into app.comment_threads (subject_table, subject_id, anchor) values (p_subject_table, p_subject_id, p_anchor)
    returning id into v_thread;
  end if;
  insert into app.comments (comment_thread_id, body) values (v_thread, p_body) returning id into v_comment;
  insert into app.comment_mentions (comment_id, mentioned_person_id)
  select v_comment, m from (select distinct unnest(coalesce(p_mentions, '{}')) as m) d;
  return v_comment;
end;
$$;

comment on function app.post_comment(text, uuid, text, uuid[], text) is 'Posts a comment on a subject the caller can read, in its main thread or the thread of an anchor (created on first use), with mentions. Runs as the caller, so every row passes the subject''s own policy. Returns the comment id.';

-- Email replies post as comments (the 0550 carry-over) -------------------------------------------------------------------

alter table app.inbound_messages add column posted_comment_id uuid references app.comments (id);
create index inbound_messages_posted_comment_idx on app.inbound_messages (posted_comment_id);
comment on column app.inbound_messages.posted_comment_id is 'Comment a verified reply was posted as.';

create or replace function private.post_email_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_thread uuid;
  v_comment uuid;
  v_subject jsonb;
begin
  if new.purpose <> 'Reply' or new.inbound_status <> 'Verified' or new.body_text is null or btrim(new.body_text) = ''
     or new.reply_subject_table not in (select s.table_name from private.comment_subjects s) then
    return null;
  end if;
  v_subject := private.subject_row(new.reply_subject_table, new.reply_subject_id);
  if v_subject is null or not private.person_may_read_subject(new.reply_person_id, v_subject) then
    return null;
  end if;
  perform private.begin_trusted_operation('comment_from_email');
  select t.id into v_thread from app.comment_threads t
  where t.subject_table = new.reply_subject_table and t.subject_id = new.reply_subject_id and t.anchor is null and t.deleted_at is null;
  if v_thread is null then
    insert into app.comment_threads (subject_table, subject_id) values (new.reply_subject_table, new.reply_subject_id) returning id into v_thread;
  end if;
  insert into app.comments (comment_thread_id, author_person_id, body, source)
  values (v_thread, new.reply_person_id, left(new.body_text, 20000), 'Email') returning id into v_comment;
  perform private.end_trusted_operation('comment_from_email');
  update app.inbound_messages set posted_comment_id = v_comment where id = new.id;
  return null;
end;
$$;

comment on function private.post_email_reply() is 'After insert trigger on inbound messages: a verified reply (DKIM, signed address, own sender address, still a member) whose person can still reach the subject is posted as an Email comment in the subject''s main thread (Section 4.6.5).';

create trigger t60_post_email_reply after insert on app.inbound_messages
  for each row execute function private.post_email_reply();

-- Retention --------------------------------------------------------------------------------------------------------------

call private.install_default_retention('app.comment_threads');
call private.install_default_retention('app.comments');
call private.install_default_retention('app.comment_versions');
call private.install_default_retention('app.comment_mentions');
call private.install_default_retention('app.comment_reactions', interval '1 year');
call private.install_default_retention('app.thread_subscriptions', interval '90 days');

-- Privileges -------------------------------------------------------------------------------------------------------------

revoke all on function private.can_read_subject(text, uuid) from public, anon;
grant execute on function private.can_read_subject(text, uuid) to authenticated, service_role;
revoke all on function private.subject_row(text, uuid) from public, anon, authenticated;
revoke all on function private.subject_title(jsonb) from public, anon, authenticated;
revoke all on function private.person_may_read_subject(uuid, jsonb) from public, anon, authenticated;
revoke all on function private.guard_comment_thread() from public, anon, authenticated;
revoke all on function private.can_read_thread(uuid) from public, anon;
grant execute on function private.can_read_thread(uuid) to authenticated, service_role;
revoke all on function private.guard_comment() from public, anon, authenticated;
revoke all on function private.comment_context(uuid) from public, anon, authenticated;
revoke all on function private.after_comment_mention() from public, anon, authenticated;
revoke all on function private.stamp_session_person() from public, anon, authenticated;
revoke all on function private.guard_thread_subscription() from public, anon, authenticated;
revoke all on function private.after_comment_insert() from public, anon, authenticated;
revoke all on function private.notify_comment_subscribers() from public, anon, authenticated;
revoke all on function private.after_comment_update() from public, anon, authenticated;
revoke all on function private.after_thread_update() from public, anon, authenticated;
revoke all on function app.post_comment(text, uuid, text, uuid[], text) from public, anon;
grant execute on function app.post_comment(text, uuid, text, uuid[], text) to authenticated, service_role;
revoke all on function private.post_email_reply() from public, anon, authenticated;
