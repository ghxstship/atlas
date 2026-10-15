-- 0773_party_conversations.sql
-- A28 Engagements and Marketplace (RRR-30), Gateway group 11 for A27 (Section 11.10 habit 8, chat native: every
-- engagement and every relationship has a conversation):
--   * app.party_threads and app.party_messages: org-level conversations between an org and an external person or
--     account, not tied to one engagement. The party reaches them while it holds an engagement with the org in the
--     engagement area or an application to one of the org's opportunities (Section 8.7)
--   * app.thread_reads: read receipts, one row per person and thread (engagement or party thread) holding when they last
--     read it; a message is read by everyone whose last read is at or after it
--   * app.start_party_thread and app.mark_thread_read
--   * api_external.party_threads (with unread counts), api_external.party_messages and api_external.thread_read_receipts
-- Engagement threads stay in 0740 and gain receipts here.

create table app.party_threads (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  party_person_id uuid references app.people (id),
  party_organization_id uuid references app.organizations (id),
  subject text not null,
  deleted_at timestamptz,
  constraint party_threads_one_party check (num_nonnulls(party_person_id, party_organization_id) = 1),
  constraint party_threads_not_own_org check (party_organization_id is distinct from org_id),
  constraint party_threads_subject_length check (char_length(btrim(subject)) between 1 and 200)
);

create index party_threads_party_person_id_idx on app.party_threads (party_person_id);
create index party_threads_party_organization_id_idx on app.party_threads (party_organization_id);

call private.install_domain_table('app.party_threads');
call private.describe('app.party_threads', 'Org-level conversations between an org and an external person or account, beyond any one engagement (Section 11.10 habit 8). The party reaches them while it holds an engagement with the org in the engagement area or an application to one of its opportunities.', array[
  'org_id', 'Org side of the conversation.',
  'party_person_id', 'External person on the other side; NULL for an account conversation.',
  'party_organization_id', 'External account on the other side; NULL for a person conversation.',
  'subject', 'Thread subject.'
]);

create table app.party_messages (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  party_thread_id uuid not null references app.party_threads (id),
  author_person_id uuid references app.people (id),
  body text not null,
  sent_at timestamptz not null default now(),
  constraint party_messages_body_length check (char_length(btrim(body)) between 1 and 10000)
);

create index party_messages_thread_idx on app.party_messages (party_thread_id, sent_at);
create index party_messages_author_idx on app.party_messages (author_person_id);

call private.install_domain_table('app.party_messages', 'app.party_threads', 'party_thread_id', '{}', true);
call private.describe('app.party_messages', 'Append-only messages on an org-level party thread, authored by the session person.', array[
  'party_thread_id', 'Thread.',
  'author_person_id', 'Author, set from the session.',
  'body', 'Message text.',
  'sent_at', 'When the message was sent, set by the database.'
]);

create trigger t40_stamp_party_message before insert on app.party_messages
  for each row execute function private.stamp_engagement_message();

insert into private.domain_event_types (code, subject, description) values
  ('party_message.sent', 'party_messages', 'A message was sent on an org-level party thread.');

create trigger t90_emit_party_message after insert on app.party_messages
  for each row execute function private.emit_row_event('party_message.sent', '-', 'party_thread_id');

-- Who the party side is (column values in, ADR 0016 item 14) ---------------------------------------------------------------

create or replace function private.party_side_open(p_org_id uuid, p_person_id uuid, p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (p_person_id is not null and p_person_id = private.current_person_id() and (
      exists (select 1 from app.engagements e where e.org_id = p_org_id and e.person_id = p_person_id and e.deleted_at is null
              and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, 'engagement'))
      or exists (select 1 from app.applications a where a.org_id = p_org_id and a.applicant_person_id = p_person_id and a.deleted_at is null)))
    or (p_organization_id is not null
      and p_organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin', 'Account Member']::app.account_role[]))
      and (exists (select 1 from app.engagements e join app.counterparties c on c.id = e.counterparty_id
                   where e.org_id = p_org_id and c.organization_id = p_organization_id and e.deleted_at is null
                     and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, 'engagement'))
        or exists (select 1 from app.applications a where a.org_id = p_org_id and a.applicant_organization_id = p_organization_id and a.deleted_at is null)));
$$;

comment on function private.party_side_open(uuid, uuid, uuid) is 'Section 8.7: true when the signed-in person is the party of an org-level thread (the person, or a member of the account) and the party holds an engagement with the org in the engagement area or an application to one of its opportunities. Takes the thread''s column values.';

create or replace function private.readable_party_thread_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id from app.party_threads t
  where t.deleted_at is null
    and (t.org_id in (select private.orgs_with_capability('opportunities.engagement.read'))
      or private.party_side_open(t.org_id, t.party_person_id, t.party_organization_id));
$$;

comment on function private.readable_party_thread_ids() is 'Party threads the signed-in person reads: internally with opportunities.engagement.read, or as the party.';

create or replace function private.writable_party_thread_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id from app.party_threads t
  where t.deleted_at is null
    and (t.org_id in (select private.orgs_with_capability('opportunities.engagement.write'))
      or private.party_side_open(t.org_id, t.party_person_id, t.party_organization_id));
$$;

comment on function private.writable_party_thread_ids() is 'Party threads the signed-in person may post to.';

call private.install_policies('app.party_threads',
  $$org_id in (select private.orgs_with_capability('opportunities.engagement.read'))
    or private.party_side_open(org_id, party_person_id, party_organization_id)$$);
call private.install_policies('app.party_messages',
  $$party_thread_id in (select private.readable_party_thread_ids())$$,
  $$party_thread_id in (select private.writable_party_thread_ids())$$);
revoke insert, update on app.party_messages from authenticated;
grant insert (party_thread_id, body) on app.party_messages to authenticated;

create or replace function app.start_party_thread(p_org_id uuid, p_party_person_id uuid, p_party_organization_id uuid, p_subject text, p_body text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_person();
  if not (p_org_id in (select private.orgs_with_capability('opportunities.engagement.write'))
          or private.party_side_open(p_org_id, p_party_person_id, p_party_organization_id)) then
    raise exception using errcode = '42501', message = 'only the org or the party starts this conversation';
  end if;
  insert into app.party_threads (org_id, party_person_id, party_organization_id, subject)
  values (p_org_id, p_party_person_id, p_party_organization_id, btrim(p_subject)) returning id into v_id;
  insert into app.party_messages (party_thread_id, body) values (v_id, p_body);
  return v_id;
end;
$$;

comment on function app.start_party_thread(uuid, uuid, uuid, text, text) is 'Starts an org-level conversation with its first message: the org (opportunities.engagement.write) with a party it has engaged or received an application from, or that party with the org. Returns the thread id.';

-- Read receipts -----------------------------------------------------------------------------------------------------------------

create table app.thread_reads (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  person_id uuid not null references app.people (id),
  engagement_thread_id uuid references app.engagement_threads (id),
  party_thread_id uuid references app.party_threads (id),
  last_read_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint thread_reads_one_thread check (num_nonnulls(engagement_thread_id, party_thread_id) = 1)
);

create unique index thread_reads_engagement_key on app.thread_reads (person_id, engagement_thread_id) where engagement_thread_id is not null;
create unique index thread_reads_party_key on app.thread_reads (person_id, party_thread_id) where party_thread_id is not null;
create index thread_reads_engagement_thread_id_idx on app.thread_reads (engagement_thread_id);
create index thread_reads_party_thread_id_idx on app.thread_reads (party_thread_id);

call private.install_domain_table('app.thread_reads', null, null, array['app.engagement_threads', 'engagement_thread_id', 'app.party_threads', 'party_thread_id']);
call private.describe('app.thread_reads', 'Read receipts: when each person last read each engagement or party thread. A message counts as read by everyone whose last read is at or after it was sent. Written only by app.mark_thread_read.', array[
  'org_id', 'Org of the thread.',
  'person_id', 'Reader, set from the session.',
  'engagement_thread_id', 'Engagement thread read.',
  'party_thread_id', 'Party thread read.',
  'last_read_at', 'When the person last read the thread.'
]);

call private.install_policies('app.thread_reads',
  $$engagement_thread_id in (select private.readable_thread_ids()) or party_thread_id in (select private.readable_party_thread_ids())$$);
revoke insert, update on app.thread_reads from authenticated;

create or replace function app.mark_thread_read(p_engagement_thread_id uuid, p_party_thread_id uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_org uuid;
  v_at timestamptz := now();
begin
  if num_nonnulls(p_engagement_thread_id, p_party_thread_id) <> 1 then
    perform private.refuse('thread_read_one_thread', 'Mark one thread at a time.');
  end if;
  if p_engagement_thread_id is not null then
    if p_engagement_thread_id not in (select private.readable_thread_ids()) then
      raise exception using errcode = '42501', message = 'thread not found';
    end if;
    select t.org_id into v_org from app.engagement_threads t where t.id = p_engagement_thread_id;
    insert into app.thread_reads (org_id, person_id, engagement_thread_id, last_read_at) values (v_org, v_person, p_engagement_thread_id, v_at)
    on conflict (person_id, engagement_thread_id) where engagement_thread_id is not null do update set last_read_at = excluded.last_read_at;
  else
    if p_party_thread_id not in (select private.readable_party_thread_ids()) then
      raise exception using errcode = '42501', message = 'thread not found';
    end if;
    select t.org_id into v_org from app.party_threads t where t.id = p_party_thread_id;
    insert into app.thread_reads (org_id, person_id, party_thread_id, last_read_at) values (v_org, v_person, p_party_thread_id, v_at)
    on conflict (person_id, party_thread_id) where party_thread_id is not null do update set last_read_at = excluded.last_read_at;
  end if;
  return v_at;
end;
$$;

comment on function app.mark_thread_read(uuid, uuid) is 'Records that the signed-in person read a thread they may read (one of an engagement thread or a party thread) up to now. Returns the time recorded.';

-- Projections ----------------------------------------------------------------------------------------------------------------------

create view api_external.party_threads as
select t.id, t.org_id, o.name as org_name, t.party_person_id, t.party_organization_id as account_id, t.subject, t.created_at,
  (select max(m.sent_at) from app.party_messages m where m.party_thread_id = t.id) as last_message_at,
  (select count(*) from app.party_messages m where m.party_thread_id = t.id
     and m.sent_at > coalesce((select r.last_read_at from app.thread_reads r where r.party_thread_id = t.id and r.person_id = private.current_person_id()), '-infinity')
     and m.author_person_id is distinct from private.current_person_id()) as unread_count
from app.party_threads t
join app.organizations o on o.id = t.org_id
where t.deleted_at is null and private.party_side_open(t.org_id, t.party_person_id, t.party_organization_id);

call private.describe('api_external.party_threads', 'The caller''s org-level conversations, with the latest message time and how many messages from others they have not read.', array[
  'id', 'Thread.', 'org_id', 'Org.', 'org_name', 'Org name.', 'party_person_id', 'The caller, for a person conversation.',
  'account_id', 'The caller''s account, for an account conversation.', 'subject', 'Subject.', 'created_at', 'When started.',
  'last_message_at', 'When the latest message was sent.', 'unread_count', 'Messages from others sent after the caller last read the thread.']);

create view api_external.party_messages as
select m.id, m.party_thread_id, m.author_person_id, pe.full_name as author_name, m.body, m.sent_at
from app.party_messages m
join app.party_threads t on t.id = m.party_thread_id and t.deleted_at is null
left join app.people pe on pe.id = m.author_person_id
where private.party_side_open(t.org_id, t.party_person_id, t.party_organization_id);

call private.describe('api_external.party_messages', 'Messages on the caller''s org-level conversations.', array[
  'id', 'Message.', 'party_thread_id', 'Thread.', 'author_person_id', 'Author.', 'author_name', 'Author name.', 'body', 'Text.', 'sent_at', 'When sent.']);

create view api_external.thread_read_receipts as
select r.id, r.engagement_thread_id, r.party_thread_id, r.person_id, pe.full_name as person_name, r.last_read_at
from app.thread_reads r
join app.people pe on pe.id = r.person_id
where r.deleted_at is null
  and (r.engagement_thread_id in (select t.id from app.engagement_threads t where t.deleted_at is null
                                  and t.engagement_id in (select private.my_engagement_ids('engagement')))
    or r.party_thread_id in (select t.id from app.party_threads t where t.deleted_at is null
                             and private.party_side_open(t.org_id, t.party_person_id, t.party_organization_id)));

call private.describe('api_external.thread_read_receipts', 'Read receipts on the caller''s engagement and party threads: who on either side last read each thread and when.', array[
  'id', 'Receipt.', 'engagement_thread_id', 'Engagement thread.', 'party_thread_id', 'Party thread.', 'person_id', 'Reader.',
  'person_name', 'Reader name.', 'last_read_at', 'When they last read the thread.']);

-- Retention, audit and privileges -------------------------------------------------------------------------------------------------------

call private.install_default_retention('app.party_threads');
call private.install_default_retention('app.party_messages');
call private.install_default_retention('app.thread_reads', interval '1 year');
call private.install_audit_trail('app.party_threads');

revoke all on function private.party_side_open(uuid, uuid, uuid) from public, anon;
revoke all on function private.readable_party_thread_ids() from public, anon;
revoke all on function private.writable_party_thread_ids() from public, anon;
grant execute on function private.party_side_open(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function private.readable_party_thread_ids() to authenticated, service_role;
grant execute on function private.writable_party_thread_ids() to authenticated, service_role;
revoke all on function app.start_party_thread(uuid, uuid, uuid, text, text) from public, anon;
revoke all on function app.mark_thread_read(uuid, uuid) from public, anon;
grant execute on function app.start_party_thread(uuid, uuid, uuid, text, text) to authenticated, service_role;
grant execute on function app.mark_thread_read(uuid, uuid) to authenticated, service_role;

revoke all on api_external.party_threads, api_external.party_messages, api_external.thread_read_receipts from public, anon;
grant select on api_external.party_threads, api_external.party_messages, api_external.thread_read_receipts to authenticated, service_role;
