-- 1410_calendar_feeds_served.sql
-- A84 (RRR-129), finding A65-018, Section 4.6.5: calendar feeds are served, rotated and revoked. 0550 stored member
-- and project feeds with hashed tokens and a token RPC, but nothing served `/ical/{feedToken}.ics`, no feed could be
-- rotated, and Gateway's external parties, who hold no membership, had no feed at all (Section 4.5.8 Work, Upcoming).
--   * app.person_calendar_feeds: a person's own feed across every org they work with through an engagement, read
--     through the api_external projections, so it shows exactly what Gateway shows them (Section 8.7)
--   * rotation (app.rotate_calendar_feed, app.rotate_person_calendar_feed) replaces a feed's token in place; the old
--     token stops at once. Revoking sets revoked_at once, never cleared, and removes the feed from the list
--   * retired token hashes (rotated or revoked) are kept a year in private.retired_calendar_feed_tokens, so a
--     calendar app that keeps polling a dead link gets 404 without counting as a failed guess against its address:
--     calendar servers such as Google's poll many people's feeds from a few shared addresses
--   * api_public.calendar_feed replaces api_public.calendar_feed_events and returns one JSON document: the status
--     (ok, not_found, rate_limited), the feed's name parts, time zone and locale, and its events with stable ids,
--     times, IANA zones, a status (tentative, confirmed, cancelled) and a sequence that grows with every change, for
--     the iCalendar writer in @xos/data. Canceled shifts and records stay in the feed as cancelled events
--   * limits (ADR 0038 item 3): 120 fetches an hour per token; 20 failed lookups per client address in 15 minutes,
--     where the address is the one the Atlas or Gateway route relays (clientAddress(), A69-003) scoped under the
--     address that reached PostgREST (private.request_ip(), A69-002); and 2000 failed lookups per reaching address in
--     15 minutes, which bounds a direct caller that invents relayed addresses
--   * at most 20 live feeds per membership and per person

-- Tokens --------------------------------------------------------------------------------------------------------------

create or replace function private.new_calendar_feed_token()
returns text
language sql
volatile
set search_path = ''
as $$
  select 'xcal_' || encode(extensions.gen_random_bytes(32), 'hex');
$$;

comment on function private.new_calendar_feed_token() is 'A new calendar feed token: xcal_ and 256 random bits in hex. Only its SHA-256 hash is stored.';
revoke all on function private.new_calendar_feed_token() from public, anon, authenticated;

create table private.retired_calendar_feed_tokens (
  token_hash bytea primary key,
  retired_at timestamptz not null default now(),
  constraint retired_calendar_feed_tokens_hash_length check (octet_length(token_hash) = 32)
);

create index retired_calendar_feed_tokens_retired_idx on private.retired_calendar_feed_tokens (retired_at);

comment on table private.retired_calendar_feed_tokens is 'SHA-256 hashes of calendar feed tokens that were rotated away or revoked, kept a year so a calendar still polling a dead link gets 404 without counting as a failed guess (ADR 0038 item 3).';
comment on column private.retired_calendar_feed_tokens.token_hash is 'SHA-256 of the retired token.';
comment on column private.retired_calendar_feed_tokens.retired_at is 'When the token was rotated away or revoked.';

alter table private.retired_calendar_feed_tokens enable row level security;
revoke all on private.retired_calendar_feed_tokens from public, anon, authenticated;
grant select on private.retired_calendar_feed_tokens to service_role;

select cron.schedule('xos_prune_retired_calendar_feed_tokens', '41 4 * * *',
  $$delete from private.retired_calendar_feed_tokens where retired_at < now() - interval '1 year'$$);

-- Member and project feeds: rotation and one-way revocation -------------------------------------------------------------

alter table app.calendar_feeds add column rotated_at timestamptz;
comment on column app.calendar_feeds.rotated_at is 'When the token was last replaced; the previous token stopped working then.';

revoke select on app.calendar_feeds from authenticated;
grant select (id, org_id, membership_id, project_id, token_hint, last_accessed_at, rotated_at, revoked_at, created_at, created_by,
  updated_at, updated_by, deleted_at) on app.calendar_feeds to authenticated;

create or replace function private.guard_calendar_feed_token()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    perform private.refuse('calendar_feed_revoked', 'A revoked calendar feed stays revoked. Create a new feed instead.');
  end if;
  if new.token_hash is distinct from old.token_hash or new.token_hint is distinct from old.token_hint
     or new.rotated_at is distinct from old.rotated_at then
    if not private.in_trusted_operation('calendar_feed_rotation') then
      perform private.refuse('calendar_feed_token', 'A feed''s token changes only by rotating the feed.');
    end if;
    if old.revoked_at is not null then
      perform private.refuse('calendar_feed_revoked', 'A revoked calendar feed stays revoked. Create a new feed instead.');
    end if;
    insert into private.retired_calendar_feed_tokens (token_hash) values (old.token_hash) on conflict do nothing;
  end if;
  if old.revoked_at is null and new.revoked_at is not null then
    new.revoked_at := now();
    new.deleted_at := coalesce(new.deleted_at, now());
    insert into private.retired_calendar_feed_tokens (token_hash) values (old.token_hash) on conflict do nothing;
  end if;
  return new;
end;
$$;

comment on function private.guard_calendar_feed_token() is 'Before update on calendar feed tables: the token changes only through rotation (trusted operation calendar_feed_rotation) and never on a revoked feed; revoking stamps revoked_at with the database time once, removes the feed from lists (deleted_at), and either way the old token''s hash is retired so it answers 404 without counting as a failed guess.';
revoke all on function private.guard_calendar_feed_token() from public, anon, authenticated;

create trigger t40_guard_calendar_feed_token before update on app.calendar_feeds
  for each row execute function private.guard_calendar_feed_token();

create or replace function app.create_calendar_feed(p_org_id uuid, p_project_id uuid default null)
returns table (calendar_feed_id uuid, feed_token text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_membership uuid;
  v_token text := private.new_calendar_feed_token();
  v_id uuid;
begin
  select m.id into v_membership from app.memberships m
  where m.id in (select private.my_membership_ids()) and m.org_id = p_org_id limit 1;
  if v_membership is null or not private.has_capability(p_org_id, 'me.calendar_feeds.write', private.current_person_id()) then
    raise exception using errcode = '42501', message = 'organization not found';
  end if;
  if p_project_id is not null and p_project_id not in (select private.readable_project_ids()) then
    raise exception using errcode = '42501', message = 'project not found';
  end if;
  if (select count(*) from app.calendar_feeds f where f.membership_id = v_membership and f.revoked_at is null and f.deleted_at is null) >= 20 then
    perform private.refuse('calendar_feed_limit', 'You have 20 calendar feeds in this organization. Revoke one before you add another.');
  end if;
  insert into app.calendar_feeds (membership_id, project_id, token_hash, token_hint)
  values (v_membership, p_project_id, extensions.digest(v_token, 'sha256'), right(v_token, 4))
  returning id into v_id;
  return query select v_id, v_token;
end;
$$;

comment on function app.create_calendar_feed(uuid, uuid) is 'Creates a calendar feed for the signed-in member, of their own schedule or of a project they can read, and returns its token once. At most 20 live feeds per membership.';

create or replace function app.rotate_calendar_feed(p_calendar_feed_id uuid)
returns table (calendar_feed_id uuid, feed_token text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_feed app.calendar_feeds;
  v_token text := private.new_calendar_feed_token();
begin
  select * into v_feed from app.calendar_feeds f
  where f.id = p_calendar_feed_id and f.membership_id in (select private.my_membership_ids())
    and f.revoked_at is null and f.deleted_at is null
  for update;
  if v_feed.id is null or not private.has_capability(v_feed.org_id, 'me.calendar_feeds.write', private.current_person_id()) then
    raise exception using errcode = '42501', message = 'calendar feed not found';
  end if;
  perform private.begin_trusted_operation('calendar_feed_rotation');
  update app.calendar_feeds
  set token_hash = extensions.digest(v_token, 'sha256'), token_hint = right(v_token, 4), rotated_at = now(), last_accessed_at = null
  where id = v_feed.id;
  perform private.end_trusted_operation('calendar_feed_rotation');
  return query select v_feed.id, v_token;
end;
$$;

comment on function app.rotate_calendar_feed(uuid) is 'Replaces the token of one of the signed-in member''s live calendar feeds and returns the new token once. The old token stops working at once and answers 404.';

-- A person's own feed (Gateway) -----------------------------------------------------------------------------------------

create table app.person_calendar_feeds (
  id uuid primary key default private.uuid_v7(),
  person_id uuid not null references app.people (id),
  token_hash bytea not null,
  token_hint text not null,
  last_accessed_at timestamptz,
  rotated_at timestamptz,
  revoked_at timestamptz,
  constraint person_calendar_feeds_token_hash_length check (octet_length(token_hash) = 32),
  constraint person_calendar_feeds_token_hint check (token_hint ~ '^[0-9a-f]{4}$')
);

create unique index person_calendar_feeds_token_hash_key on app.person_calendar_feeds (token_hash);

call private.install_person_table('app.person_calendar_feeds');
call private.describe('app.person_calendar_feeds', 'A person''s own iCalendar feed across every org they work with through an engagement (Section 4.5.8 Work, Upcoming; Section 4.6.5): their published shifts and the meetings, milestones and deadlines shared with them, read through the api_external projections. Only a SHA-256 hash of the token is kept; the token is shown once and can be rotated or revoked.', array[
  'id', 'Primary key, UUID v7.',
  'person_id', 'Person who owns the feed; it shows what Gateway shows them.',
  'token_hash', 'SHA-256 of the feed token.',
  'token_hint', 'Last four characters of the token, to tell feeds apart.',
  'last_accessed_at', 'Last time a calendar fetched the feed.',
  'rotated_at', 'When the token was last replaced; the previous token stopped working then.',
  'revoked_at', 'When the feed was revoked; a revoked feed serves nothing and never comes back.'
]);

revoke select, insert, update on app.person_calendar_feeds from authenticated;
grant select (id, person_id, token_hint, last_accessed_at, rotated_at, revoked_at, created_at, created_by, updated_at, updated_by, deleted_at)
  on app.person_calendar_feeds to authenticated;
grant update (revoked_at) on app.person_calendar_feeds to authenticated;

create trigger t40_guard_calendar_feed_token before update on app.person_calendar_feeds
  for each row execute function private.guard_calendar_feed_token();

call private.install_default_retention('app.person_calendar_feeds', interval '90 days');

create or replace function app.create_person_calendar_feed()
returns table (calendar_feed_id uuid, feed_token text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_token text := private.new_calendar_feed_token();
  v_id uuid;
begin
  if (select count(*) from app.person_calendar_feeds f where f.person_id = v_person and f.revoked_at is null and f.deleted_at is null) >= 20 then
    perform private.refuse('calendar_feed_limit', 'You have 20 calendar feeds. Revoke one before you add another.');
  end if;
  insert into app.person_calendar_feeds (person_id, token_hash, token_hint)
  values (v_person, extensions.digest(v_token, 'sha256'), right(v_token, 4))
  returning id into v_id;
  return query select v_id, v_token;
end;
$$;

comment on function app.create_person_calendar_feed() is 'Creates the signed-in person''s own calendar feed across their engagements and returns its token once. At most 20 live feeds per person.';

create or replace function app.rotate_person_calendar_feed(p_calendar_feed_id uuid)
returns table (calendar_feed_id uuid, feed_token text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_feed app.person_calendar_feeds;
  v_token text := private.new_calendar_feed_token();
begin
  select * into v_feed from app.person_calendar_feeds f
  where f.id = p_calendar_feed_id and f.person_id = private.current_person_id()
    and f.revoked_at is null and f.deleted_at is null
  for update;
  if v_feed.id is null then
    raise exception using errcode = '42501', message = 'calendar feed not found';
  end if;
  perform private.begin_trusted_operation('calendar_feed_rotation');
  update app.person_calendar_feeds
  set token_hash = extensions.digest(v_token, 'sha256'), token_hint = right(v_token, 4), rotated_at = now(), last_accessed_at = null
  where id = v_feed.id;
  perform private.end_trusted_operation('calendar_feed_rotation');
  return query select v_feed.id, v_token;
end;
$$;

comment on function app.rotate_person_calendar_feed(uuid) is 'Replaces the token of one of the signed-in person''s own live calendar feeds and returns the new token once. The old token stops working at once and answers 404.';

-- Serving -----------------------------------------------------------------------------------------------------------------

drop function api_public.calendar_feed_events(text);

create or replace function private.calendar_feed_sequence(p_created_at timestamptz, p_updated_at timestamptz)
returns integer
language sql
immutable
set search_path = ''
as $$
  select least(2147483647, greatest(0, floor(extract(epoch from (p_updated_at - p_created_at)))))::integer;
$$;

comment on function private.calendar_feed_sequence(timestamptz, timestamptz) is 'RFC 5545 SEQUENCE of a feed event: whole seconds between its creation and its last change, so every change and cancellation raises it and an untouched event stays at 0.';
revoke all on function private.calendar_feed_sequence(timestamptz, timestamptz) from public, anon, authenticated;

create or replace function private.calendar_feed_setting(p_org_id uuid, p_project_id uuid, p_key text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.value_text from app.resolve_settings(p_org_id, p_project_id) s where s.setting_key = p_key;
$$;

comment on function private.calendar_feed_setting(uuid, uuid, text) is 'One resolved setting (locale.language or locale.time_zone) of the person whose claims are set, in an org and project or personally when the org is null; read by api_public.calendar_feed while it acts as the feed''s owner.';
revoke all on function private.calendar_feed_setting(uuid, uuid, text) from public, anon, authenticated;

create or replace function api_public.calendar_feed(p_token text, p_client_address text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_hop text := coalesce(host(private.request_ip()), 'unknown');
  v_client text;
  v_subject text;
  v_hash bytea;
  v_feed app.calendar_feeds;
  v_person_feed app.person_calendar_feeds;
  v_user uuid;
  v_claims text := current_setting('request.jwt.claims', true);
  v_from timestamptz := now() - interval '90 days';
  v_to timestamptz := now() + interval '18 months';
  v_meta jsonb;
  v_events jsonb;
begin
  begin
    v_client := host(nullif(btrim(left(coalesce(p_client_address, ''), 64)), '')::inet);
  exception when invalid_text_representation then
    v_client := null;
  end;
  v_subject := v_hop || ' ' || coalesce(v_client, v_hop);
  if private.rate_limit_exceeded('calendar_feed.failure', v_subject, 20, interval '15 minutes')
     or private.rate_limit_exceeded('calendar_feed.hop_failure', v_hop, 2000, interval '15 minutes') then
    return jsonb_build_object('status', 'rate_limited', 'retry_after_seconds', 900);
  end if;

  if p_token is not null and p_token ~ '^xcal_[0-9a-f]{64}$' then
    v_hash := extensions.digest(p_token, 'sha256');
    select * into v_feed from app.calendar_feeds f where f.token_hash = v_hash and f.revoked_at is null and f.deleted_at is null;
    if v_feed.id is null then
      select * into v_person_feed from app.person_calendar_feeds f
      where f.token_hash = v_hash and f.revoked_at is null and f.deleted_at is null;
    end if;
  end if;
  if v_feed.id is null and v_person_feed.id is null then
    if v_hash is null or not (
      exists (select 1 from private.retired_calendar_feed_tokens r where r.token_hash = v_hash)
      or exists (select 1 from app.calendar_feeds f where f.token_hash = v_hash)
      or exists (select 1 from app.person_calendar_feeds f where f.token_hash = v_hash)) then
      perform private.note_rate_event('calendar_feed.failure', v_subject);
      perform private.note_rate_event('calendar_feed.hop_failure', v_hop);
    end if;
    return jsonb_build_object('status', 'not_found');
  end if;

  if private.rate_limit_exceeded('calendar_feed.fetch', encode(v_hash, 'hex'), 120, interval '1 hour') then
    return jsonb_build_object('status', 'rate_limited', 'retry_after_seconds', 900);
  end if;
  perform private.note_rate_event('calendar_feed.fetch', encode(v_hash, 'hex'));

  if v_feed.id is not null then
    select p.user_id into v_user from app.memberships m join app.people p on p.id = m.person_id
    where m.id = v_feed.membership_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
      and p.deleted_at is null;
  else
    select p.user_id into v_user from app.people p where p.id = v_person_feed.person_id and p.deleted_at is null;
  end if;
  if v_user is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_feed.id is not null then
    update app.calendar_feeds set last_accessed_at = now()
    where id = v_feed.id and (last_accessed_at is null or last_accessed_at < now() - interval '5 minutes');
  else
    update app.person_calendar_feeds set last_accessed_at = now()
    where id = v_person_feed.id and (last_accessed_at is null or last_accessed_at < now() - interval '5 minutes');
  end if;

  -- From here the feed reads as its owner: the same helpers the row level security policies use decide every row.
  perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);

  if v_feed.id is not null then
    select jsonb_build_object(
        'scope', case when v_feed.project_id is null then 'member' else 'project' end,
        'org_name', o.name, 'org_slug', o.slug, 'project_name', p.name, 'project_key', p.project_key,
        'time_zone', coalesce(p.time_zone, private.calendar_feed_setting(v_feed.org_id, null, 'locale.time_zone'), 'UTC'),
        'locale', coalesce(private.calendar_feed_setting(v_feed.org_id, v_feed.project_id, 'locale.language'), 'en-US'))
    into v_meta
    from app.organizations o left join app.projects p on p.id = v_feed.project_id
    where o.id = v_feed.org_id;

    with ev as (
      select s.id, 'shift'::text as kind, coalesce(ro.job_title, s.role_code, '') as title, s.starts_at, s.ends_at, s.time_zone,
        case s.shift_state when 'Canceled' then 'cancelled' when 'Draft' then 'tentative' else 'confirmed' end as status,
        s.created_at, s.updated_at, p.name as project_name, p.project_key, null::text as record_key, n.name as scope_node_name
      from app.shifts s
      join app.projects p on p.id = s.project_id and p.deleted_at is null
      left join xpms.role ro on ro.role_code = s.role_code
      left join app.scope_nodes n on n.id = s.scope_node_id
      where s.deleted_at is null and s.org_id = v_feed.org_id and s.ends_at >= v_from and s.starts_at <= v_to
        and case when v_feed.project_id is null
              then s.membership_id = v_feed.membership_id
              else s.project_id = v_feed.project_id
                and (s.membership_id = v_feed.membership_id or s.project_id in (select private.project_ids_with('crew.shift.read')))
            end
      union all
      select r.id, lower(r.record_kind), r.title, coalesce(r.starts_at, r.due_at),
        case when r.starts_at is not null and r.ends_at > r.starts_at then r.ends_at end,
        coalesce(r.time_zone, p.time_zone),
        case r.record_state when 'Canceled' then 'cancelled' when 'Proposed' then 'tentative' else 'confirmed' end,
        r.created_at, r.updated_at, p.name, p.project_key, p.project_key || '-' || r.record_number::text, null::text
      from app.records r
      join app.projects p on p.id = r.project_id and p.deleted_at is null
      where r.deleted_at is null and r.org_id = v_feed.org_id and r.record_kind in ('Meeting', 'Milestone', 'Deadline')
        and coalesce(r.starts_at, r.due_at) between v_from and v_to
        and case when v_feed.project_id is null
              then r.id in (select private.my_record_ids('work.record.read'))
              else r.project_id = v_feed.project_id
                and (r.project_id in (select private.project_ids_with('work.record.read'))
                     or r.id in (select private.my_record_ids('work.record.read')))
            end
    ),
    capped as (select * from ev order by starts_at, id limit 2000)
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'kind', c.kind, 'title', c.title, 'starts_at', c.starts_at, 'ends_at', c.ends_at, 'time_zone', c.time_zone,
        'status', c.status, 'sequence', private.calendar_feed_sequence(c.created_at, c.updated_at),
        'created_at', c.created_at, 'updated_at', c.updated_at, 'org_name', null, 'project_name', c.project_name,
        'project_key', c.project_key, 'record_key', c.record_key, 'scope_node_name', c.scope_node_name)
      order by c.starts_at, c.id), '[]'::jsonb)
    into v_events
    from capped c;
  else
    v_meta := jsonb_build_object('scope', 'person', 'org_name', null, 'org_slug', null, 'project_name', null, 'project_key', null,
      'time_zone', coalesce(private.calendar_feed_setting(null, null, 'locale.time_zone'), 'UTC'),
      'locale', coalesce(private.calendar_feed_setting(null, null, 'locale.language'), 'en-US'));

    with ev as (
      select s.id, 'shift'::text as kind, coalesce(s.job_title, s.role_code, '') as title, s.starts_at, s.ends_at, s.time_zone,
        case s.shift_state when 'Canceled' then 'cancelled' else 'confirmed' end as status,
        sh.created_at, sh.updated_at, o.name as org_name, s.project_name, s.scope_node_name
      from api_external.shifts s
      join app.shifts sh on sh.id = s.id
      join app.organizations o on o.id = sh.org_id
      where s.ends_at >= v_from and s.starts_at <= v_to
      union all
      select r.id, lower(r.record_kind), r.title, coalesce(r.starts_at, r.due_at),
        case when r.starts_at is not null and r.ends_at > r.starts_at then r.ends_at end,
        coalesce(r.time_zone, p.time_zone),
        case r.record_state when 'Canceled' then 'cancelled' when 'Proposed' then 'tentative' else 'confirmed' end,
        rr.created_at, rr.updated_at, o.name, p.name, null::text
      from api_external.records r
      join app.records rr on rr.id = r.id
      join app.projects p on p.id = r.project_id
      join app.organizations o on o.id = p.org_id
      where r.record_kind in ('Meeting', 'Milestone', 'Deadline') and coalesce(r.starts_at, r.due_at) between v_from and v_to
    ),
    capped as (select * from ev order by starts_at, id limit 2000)
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'kind', c.kind, 'title', c.title, 'starts_at', c.starts_at, 'ends_at', c.ends_at, 'time_zone', c.time_zone,
        'status', c.status, 'sequence', private.calendar_feed_sequence(c.created_at, c.updated_at),
        'created_at', c.created_at, 'updated_at', c.updated_at, 'org_name', c.org_name, 'project_name', c.project_name,
        'project_key', null, 'record_key', null, 'scope_node_name', c.scope_node_name)
      order by c.starts_at, c.id), '[]'::jsonb)
    into v_events
    from capped c;
  end if;

  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return jsonb_build_object('status', 'ok', 'feed', v_meta, 'events', v_events);
end;
$$;

comment on function api_public.calendar_feed(text, text) is 'Named token RPC behind /ical/{feedToken}.ics (Section 4.6.5, invariants 7 and 8; ADR 0038): resolves a live member, project or person feed token and returns its name parts, zone, locale and events (shifts, meetings, milestones and deadlines) evaluated with the owner''s access at this moment, as one JSON document with status ok, not_found or rate_limited. A revoked, rotated-away or wrong token, an ended membership or a deleted person returns not_found. Limits: 120 fetches an hour per token; failed lookups 20 per relayed client address (p_client_address, from the route''s clientAddress()) under the reaching address (private.request_ip()) and 2000 per reaching address in 15 minutes; retired tokens never count as failures.';

revoke all on function api_public.calendar_feed(text, text) from public;
grant execute on function api_public.calendar_feed(text, text) to anon, authenticated, service_role;

-- Privileges -------------------------------------------------------------------------------------------------------------

revoke all on function app.create_calendar_feed(uuid, uuid) from public, anon;
grant execute on function app.create_calendar_feed(uuid, uuid) to authenticated, service_role;
revoke all on function app.rotate_calendar_feed(uuid) from public, anon;
grant execute on function app.rotate_calendar_feed(uuid) to authenticated, service_role;
revoke all on function app.create_person_calendar_feed() from public, anon;
grant execute on function app.create_person_calendar_feed() to authenticated, service_role;
revoke all on function app.rotate_person_calendar_feed(uuid) from public, anon;
grant execute on function app.rotate_person_calendar_feed(uuid) to authenticated, service_role;
