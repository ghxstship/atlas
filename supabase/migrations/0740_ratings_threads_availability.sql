-- 0740_ratings_threads_availability.sql
-- A28 Engagements and Marketplace. Pools are in 0720; this migration adds the rest of step 5:
--   * two-sided ratings from completed engagements, released together once both sides have rated or 14 days
--     after the engagement completed, never edited or suppressed (Section 4.4.3, Section 14.9), and one public
--     reply by the rated side
--   * engagement threads and messages between the org and the engaged party
--   * availability calendars and blocks owned by the person (Section 4.4.1)
-- Release is recorded in private.rating_releases when the second rating arrives, so the ratings policy never
-- re-reads the ratings table (ADR 0016 item 14).

-- Enums ---------------------------------------------------------------------------------------------------------

create type app.rating_side as enum ('Organization', 'Party');
comment on type app.rating_side is 'Who gives a rating: the org rating the engaged party, or the party rating the org.';

create type app.availability_visibility as enum ('Private', 'Shared on Application', 'Public');
comment on type app.availability_visibility is 'Who sees a person''s availability (Section 4.4.1 field visibility): only the owner, orgs the person has applied to or works for, or the whole marketplace.';

create type app.availability_kind as enum ('Available', 'Unavailable', 'Tentative');
comment on type app.availability_kind is 'What an availability block says about the time it covers.';

insert into private.domain_event_types (code, subject, description) values
  ('rating.released', 'ratings', 'Both ratings of an engagement were released.'),
  ('engagement_message.sent', 'engagement_messages', 'A message was sent on an engagement thread.');

-- Ratings --------------------------------------------------------------------------------------------------------

create table app.ratings (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  engagement_id uuid not null references app.engagements (id),
  rater_side app.rating_side not null,
  score smallint not null,
  comment text,
  rated_by uuid references app.people (id),
  submitted_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint ratings_score_range check (score between 1 and 5),
  constraint ratings_comment_length check (comment is null or char_length(btrim(comment)) between 1 and 2000)
);

create index ratings_engagement_id_idx on app.ratings (engagement_id);
create index ratings_rated_by_idx on app.ratings (rated_by);
create unique index ratings_side_key on app.ratings (engagement_id, rater_side);

call private.install_domain_table('app.ratings', 'app.engagements', 'engagement_id');
call private.describe('app.ratings', 'Two-sided ratings of a completed engagement (Section 4.4.3): the org rates the party and the party rates the org. Both are released together once both are in or 14 days after the engagement completed. Ratings are never edited, withdrawn or suppressed (Section 14.9). Internal org notes and internal ratings live elsewhere and never appear here.', array[
  'engagement_id', 'Completed engagement rated.',
  'rater_side', 'Organization (rating the party) or Party (rating the org).',
  'score', 'Score from 1 to 5.',
  'comment', 'Public comment.',
  'rated_by', 'Person who gave the rating, set from the session.',
  'submitted_at', 'When the rating was given, set by the database.'
]);

create table private.rating_releases (
  engagement_id uuid primary key references app.engagements (id),
  released_at timestamptz not null default now()
);

comment on table private.rating_releases is 'When both ratings of an engagement arrived and were released together. Ratings without a row here release 14 days after the engagement completed.';
comment on column private.rating_releases.engagement_id is 'Engagement whose ratings were released.';
comment on column private.rating_releases.released_at is 'When the second rating arrived.';

alter table private.rating_releases enable row level security;
revoke all on private.rating_releases from public, anon, authenticated;
grant select on private.rating_releases to service_role;

create or replace function private.rating_released(p_engagement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.rating_releases r where r.engagement_id = p_engagement_id)
    or exists (
      select 1 from app.engagement_state_transitions t
      where t.engagement_id = p_engagement_id and t.to_state = 'Complete' and t.created_at <= now() - interval '14 days');
$$;

comment on function private.rating_released(uuid) is 'True when an engagement''s ratings are released: both sides have rated, or 14 days have passed since it completed.';

create table app.rating_replies (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  rating_id uuid not null references app.ratings (id),
  body text not null,
  replied_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint rating_replies_body_length check (char_length(btrim(body)) between 1 and 2000)
);

create unique index rating_replies_rating_key on app.rating_replies (rating_id);
create index rating_replies_replied_by_idx on app.rating_replies (replied_by);

call private.install_domain_table('app.rating_replies', 'app.ratings', 'rating_id');
call private.describe('app.rating_replies', 'The rated side''s one public reply to a released rating (Section 4.4.3).', array[
  'rating_id', 'Rating replied to.',
  'body', 'Reply.',
  'replied_by', 'Person who replied, set from the session.'
]);

create or replace function private.my_party_engagement_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id from app.engagements e
  left join app.counterparties c on c.id = e.counterparty_id
  where e.deleted_at is null
    and (e.person_id = private.current_person_id()
      or c.organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[])));
$$;

comment on function private.my_party_engagement_ids() is 'Engagements the signed-in person answers for as the party, whatever their state: as the engaged person or as an Account Owner or Admin of the engaged account. Ratings concern the party for as long as they exist.';

create or replace function private.guard_rating()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
  v_engagement app.engagements;
begin
  if tg_op = 'UPDATE' then
    perform private.refuse('rating_immutable', 'Ratings are never edited, withdrawn or suppressed.');
  end if;
  select * into v_engagement from app.engagements e where e.id = new.engagement_id;
  if v_engagement.engagement_state <> 'Complete' then
    perform private.refuse('rating_engagement_not_complete', 'Ratings come only from completed engagements.');
  end if;
  new.rated_by := v_me;
  new.submitted_at := now();
  if v_me is not null then
    if new.rater_side = 'Organization' and not private.can_on_project(v_engagement.project_id, 'opportunities.rating.write') then
      raise exception using errcode = '42501', message = 'opportunities.rating.write is required on the project';
    end if;
    if new.rater_side = 'Party' and not exists (select 1 from private.my_party_engagement_ids() x where x = new.engagement_id) then
      raise exception using errcode = '42501', message = 'only the engaged party rates the org';
    end if;
    if new.rater_side = 'Organization' and exists (select 1 from private.my_party_engagement_ids() x where x = new.engagement_id) then
      perform private.refuse('sod_rating_self', 'A person cannot rate their own engagement for the org.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_rating() is 'Ratings: only from Complete engagements, the org side by holders of opportunities.rating.write on the project, the party side by the engaged person or the engaged account''s Owner or Admin, never by someone rating themselves, stamped from the session, and never edited.';

create trigger t40_guard_rating before insert or update on app.ratings
  for each row execute function private.guard_rating();

create or replace function private.release_ratings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(*) from app.ratings r where r.engagement_id = new.engagement_id and r.deleted_at is null) = 2 then
    insert into private.rating_releases (engagement_id) values (new.engagement_id) on conflict do nothing;
    perform private.emit_event(new.org_id, 'rating.released', 'ratings', new.id,
      (select e.project_id from app.engagements e where e.id = new.engagement_id), jsonb_build_object('engagement_id', new.engagement_id));
  end if;
  return null;
end;
$$;

comment on function private.release_ratings() is 'After a rating arrives: when both sides have rated, records the release so both ratings show together.';

create trigger t85_release_ratings after insert on app.ratings
  for each row execute function private.release_ratings();

create or replace function private.guard_rating_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
  v_rating app.ratings;
  v_project uuid;
begin
  if tg_op = 'UPDATE' and (new.rating_id <> old.rating_id or new.body <> old.body) then
    perform private.refuse('rating_reply_immutable', 'A reply is never edited.');
  end if;
  if tg_op = 'UPDATE' then
    return new;
  end if;
  select * into v_rating from app.ratings r where r.id = new.rating_id;
  if not private.rating_released(v_rating.engagement_id) then
    perform private.refuse('rating_not_released', 'A rating can be answered once it is released.');
  end if;
  new.replied_by := v_me;
  if v_me is not null then
    select e.project_id into v_project from app.engagements e where e.id = v_rating.engagement_id;
    if (v_rating.rater_side = 'Organization' and not exists (select 1 from private.my_party_engagement_ids() x where x = v_rating.engagement_id))
       or (v_rating.rater_side = 'Party' and not private.can_on_project(v_project, 'opportunities.rating.write')) then
      raise exception using errcode = '42501', message = 'only the rated side replies';
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_rating_reply() is 'Replies: only by the rated side (the party to the org''s rating, the org to the party''s), only once the rating is released, and never edited.';

create trigger t40_guard_rating_reply before insert or update on app.rating_replies
  for each row execute function private.guard_rating_reply();

-- Threads and messages -----------------------------------------------------------------------------------------------

create table app.engagement_threads (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  engagement_id uuid not null references app.engagements (id),
  subject text not null,
  deleted_at timestamptz,
  constraint engagement_threads_subject_length check (char_length(btrim(subject)) between 1 and 200)
);

create index engagement_threads_engagement_id_idx on app.engagement_threads (engagement_id);

call private.install_domain_table('app.engagement_threads', 'app.engagements', 'engagement_id');
call private.describe('app.engagement_threads', 'Conversation threads between the org and the engaged party on one engagement (Section 7.3 messaging). The party reaches them while the engagement area is open (Section 8.7).', array[
  'engagement_id', 'Engagement.',
  'subject', 'Thread subject.'
]);

create table app.engagement_messages (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  engagement_thread_id uuid not null references app.engagement_threads (id),
  author_person_id uuid references app.people (id),
  body text not null,
  sent_at timestamptz not null default now(),
  constraint engagement_messages_body_length check (char_length(btrim(body)) between 1 and 10000)
);

create index engagement_messages_thread_idx on app.engagement_messages (engagement_thread_id, sent_at);
create index engagement_messages_author_idx on app.engagement_messages (author_person_id);

call private.install_domain_table('app.engagement_messages', 'app.engagement_threads', 'engagement_thread_id', '{}', true);
call private.describe('app.engagement_messages', 'Append-only messages on an engagement thread, authored by the session person.', array[
  'engagement_thread_id', 'Thread.',
  'author_person_id', 'Author, set from the session.',
  'body', 'Message text.',
  'sent_at', 'When the message was sent, set by the database.'
]);

create or replace function private.stamp_engagement_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.author_person_id := private.current_person_id();
  new.sent_at := now();
  return new;
end;
$$;

comment on function private.stamp_engagement_message() is 'Messages carry the session person as author and the database time.';

create trigger t40_stamp_engagement_message before insert on app.engagement_messages
  for each row execute function private.stamp_engagement_message();
create trigger t90_emit_engagement_message after insert on app.engagement_messages
  for each row execute function private.emit_row_event('engagement_message.sent', '-', 'engagement_thread_id');

-- Availability ---------------------------------------------------------------------------------------------------------

create table app.availability_calendars (
  id uuid primary key default private.uuid_v7(),
  org_id uuid references app.organizations (id),
  person_id uuid not null references app.people (id),
  time_zone text not null,
  visibility app.availability_visibility not null default 'Private',
  deleted_at timestamptz
);

create index availability_calendars_person_id_idx on app.availability_calendars (person_id);
create unique index availability_calendars_general_key on app.availability_calendars (person_id) where org_id is null and deleted_at is null;
create unique index availability_calendars_org_key on app.availability_calendars (person_id, org_id) where org_id is not null and deleted_at is null;

call private.install_domain_table('app.availability_calendars');
call private.describe('app.availability_calendars', 'A person''s availability calendar (Section 4.4.1), owned by the person. New calendars start Private (Section 4.8.3).', array[
  'org_id', 'NULL for the person''s own calendar; an org for a calendar the person keeps only for that org''s bookings, visible to it alone.',
  'person_id', 'Owner.',
  'time_zone', 'IANA time zone the person enters times in.',
  'visibility', 'Private, Shared on Application or Public.'
]);

create table app.availability_blocks (
  id uuid primary key default private.uuid_v7(),
  org_id uuid references app.organizations (id),
  availability_calendar_id uuid not null references app.availability_calendars (id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  availability_kind app.availability_kind not null,
  note text,
  deleted_at timestamptz,
  constraint availability_blocks_period check (ends_at > starts_at),
  constraint availability_blocks_note_length check (note is null or char_length(btrim(note)) between 1 and 500)
);

create index availability_blocks_calendar_idx on app.availability_blocks (availability_calendar_id, starts_at);

call private.install_domain_table('app.availability_blocks', 'app.availability_calendars', 'availability_calendar_id');
call private.describe('app.availability_blocks', 'Periods on an availability calendar. Others see the period and kind through api_external; the note is the owner''s alone.', array[
  'org_id', 'Org of the calendar, derived from it; NULL on the person''s own calendar.',
  'availability_calendar_id', 'Calendar.',
  'starts_at', 'Start.',
  'ends_at', 'End.',
  'availability_kind', 'Available, Unavailable or Tentative.',
  'note', 'Private note of the owner.'
]);

create or replace function private.guard_availability_calendar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_time_zone(new.time_zone);
  if tg_op = 'UPDATE' and new.person_id <> old.person_id then
    perform private.refuse('availability_calendar_owner', 'A calendar stays with its owner.');
  end if;
  return new;
end;
$$;

comment on function private.guard_availability_calendar() is 'Availability calendars keep their owner and an IANA time zone.';

create trigger t40_guard_availability_calendar before insert or update on app.availability_calendars
  for each row execute function private.guard_availability_calendar();

create or replace function private.availability_shared_with_me(p_person_id uuid, p_org_id uuid, p_visibility app.availability_visibility)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_person_id = private.current_person_id()
    or (p_org_id is null and p_visibility = 'Public' and private.current_person_id() is not null)
    or (p_visibility <> 'Private' and exists (
      select 1 from app.applications a join app.opportunities o on o.id = a.opportunity_id
      where a.applicant_person_id = p_person_id and a.deleted_at is null
        and (p_org_id is null or o.org_id = p_org_id)
        and o.project_id in (select private.project_ids_with('opportunities.application.read'))))
    or (p_visibility <> 'Private' and exists (
      select 1 from app.engagements e
      where e.person_id = p_person_id and e.deleted_at is null
        and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
        and (p_org_id is null or e.org_id = p_org_id)
        and e.project_id in (select private.project_ids_with('opportunities.engagement.read'))));
$$;

comment on function private.availability_shared_with_me(uuid, uuid, app.availability_visibility) is 'True when the signed-in person may see a calendar: its owner; anyone signed in for a Public general calendar; and, unless Private, members who read an application or an open engagement of the owner with their org. Takes the calendar''s column values.';

-- Policies -----------------------------------------------------------------------------------------------------------------

call private.install_policies('app.ratings',
  $$(engagement_id in (select private.internal_engagement_ids('opportunities.engagement.read'))
      and (rater_side = 'Organization' or private.rating_released(engagement_id)))
    or (engagement_id in (select private.my_party_engagement_ids())
      and (rater_side = 'Party' or private.rating_released(engagement_id)))$$,
  $$engagement_id in (select private.internal_engagement_ids('opportunities.rating.write'))
    or engagement_id in (select private.my_party_engagement_ids())$$);

create or replace function private.readable_rating_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.id from app.ratings r
  where r.deleted_at is null and private.rating_released(r.engagement_id)
    and (r.engagement_id in (select private.internal_engagement_ids('opportunities.engagement.read'))
      or r.engagement_id in (select private.my_party_engagement_ids()));
$$;

comment on function private.readable_rating_ids() is 'Released ratings of engagements the signed-in person reads internally or answers for as the party.';

call private.install_policies('app.rating_replies',
  $$rating_id in (select private.readable_rating_ids())$$,
  $$rating_id in (select private.readable_rating_ids())$$);

create or replace function private.readable_thread_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id from app.engagement_threads t
  where t.deleted_at is null
    and (t.engagement_id in (select private.internal_engagement_ids('opportunities.engagement.read'))
      or t.engagement_id in (select private.my_engagement_ids('engagement')));
$$;

comment on function private.readable_thread_ids() is 'Engagement threads the signed-in person reads: internally, or as an external party while the engagement area is open.';

create or replace function private.writable_thread_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id from app.engagement_threads t
  where t.deleted_at is null
    and (t.engagement_id in (select private.internal_engagement_ids('opportunities.engagement.write'))
      or t.engagement_id in (select private.my_engagement_ids('engagement')));
$$;

comment on function private.writable_thread_ids() is 'Engagement threads the signed-in person may post to.';

call private.install_policies('app.engagement_threads',
  $$engagement_id in (select private.internal_engagement_ids('opportunities.engagement.read'))
    or engagement_id in (select private.my_engagement_ids('engagement'))$$,
  $$engagement_id in (select private.internal_engagement_ids('opportunities.engagement.write'))
    or engagement_id in (select private.my_engagement_ids('engagement'))$$);
call private.install_policies('app.engagement_messages',
  $$engagement_thread_id in (select private.readable_thread_ids())$$,
  $$engagement_thread_id in (select private.writable_thread_ids())$$);

call private.install_policies('app.availability_calendars',
  $$private.availability_shared_with_me(person_id, org_id, visibility)$$,
  $$person_id = (select private.current_person_id())$$);

create or replace function private.my_calendar_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id from app.availability_calendars c where c.person_id = private.current_person_id() and c.deleted_at is null;
$$;

comment on function private.my_calendar_ids() is 'Availability calendars of the signed-in person.';

call private.install_policies('app.availability_blocks',
  $$availability_calendar_id in (select private.my_calendar_ids())$$,
  $$availability_calendar_id in (select private.my_calendar_ids())$$);

revoke insert, update on app.ratings, app.rating_replies, app.engagement_messages from authenticated;
grant insert (engagement_id, rater_side, score, comment) on app.ratings to authenticated;
grant insert (rating_id, body) on app.rating_replies to authenticated;
grant insert (engagement_thread_id, body) on app.engagement_messages to authenticated;

-- Function privileges -------------------------------------------------------------------------------------------------------

revoke all on function private.rating_released(uuid) from public, anon;
revoke all on function private.my_party_engagement_ids() from public, anon;
revoke all on function private.guard_rating() from public, anon, authenticated;
revoke all on function private.release_ratings() from public, anon, authenticated;
revoke all on function private.guard_rating_reply() from public, anon, authenticated;
revoke all on function private.stamp_engagement_message() from public, anon, authenticated;
revoke all on function private.guard_availability_calendar() from public, anon, authenticated;
revoke all on function private.availability_shared_with_me(uuid, uuid, app.availability_visibility) from public, anon;
revoke all on function private.readable_rating_ids() from public, anon;
revoke all on function private.readable_thread_ids() from public, anon;
revoke all on function private.writable_thread_ids() from public, anon;
revoke all on function private.my_calendar_ids() from public, anon;

grant execute on function private.rating_released(uuid) to authenticated, service_role;
grant execute on function private.my_party_engagement_ids() to authenticated, service_role;
grant execute on function private.availability_shared_with_me(uuid, uuid, app.availability_visibility) to authenticated, service_role;
grant execute on function private.readable_rating_ids() to authenticated, service_role;
grant execute on function private.readable_thread_ids() to authenticated, service_role;
grant execute on function private.writable_thread_ids() to authenticated, service_role;
grant execute on function private.my_calendar_ids() to authenticated, service_role;
