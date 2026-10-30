-- 2782_live_link_channels.sql
-- P1 (RRR-215, ADR 0130). Live links update while they are open. The publication route of 1450 cannot carry them:
-- Realtime checks each change against the subscriber's own JWT, and an anonymous visitor reads no row. Instead each
-- link has a private broadcast channel, xlink:<channel key>, that only the database sends to, as 2161 does for
-- Gateway: a statement trigger on each table a link shows sends a ping that carries nothing of the rows, and the page
-- rereads through its token RPC (2781), which decides what it shows.
--   * api_public.live_channel_open(topic) is true only for the channel of a link that is not revoked, deleted or
--     expired. The page learns the key only from a successful read, after the access code and with a device grant.
--     Regenerating a link draws a new key (2780), so an old screen hears nothing more.
--   * The channel rule is a select policy on realtime.messages for the anon role, since the screen joins with the
--     publishable key. 2060's registry created every policy for authenticated; it gains a roles column, and
--     private.ensure_realtime_channel_policies is redefined from its 2060 definition to create each policy for its
--     row's roles. The existing rows keep {authenticated}. Without the registry the policy is created directly when
--     Realtime's table exists, as 2161 does. There is no send rule: only the database sends.
--   * Pinging never fails a write: without Realtime the ping is skipped and the page catches up on its pull.
--   * Each table gets three statement triggers (insert, update and delete), each with its own transition table, since
--     PostgreSQL refuses transition tables on a trigger with more than one event (as 2161). Each returns at once when
--     no live link exists.

-- Whether a topic is a live link's open channel ----------------------------------------------------------------------

create or replace function api_public.live_channel_open(p_topic text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_topic ~ '^xlink:xlch_[0-9a-f]{64}$', false) and exists (
    select 1 from private.live_link_channels c
    join app.live_links l on l.id = c.live_link_id
    where c.channel_key = substr(p_topic, 7) and l.revoked_at is null and l.deleted_at is null and l.expires_at > now());
$$;

comment on function api_public.live_channel_open(text) is 'True when a Realtime topic is xlink: and the channel key of a live link that is not revoked, deleted or expired (ADR 0130). The anon channel rule on realtime.messages calls it; the key reaches a page only from a successful live link read.';
revoke all on function api_public.live_channel_open(text) from public;
grant execute on function api_public.live_channel_open(text) to anon, authenticated, service_role;

-- The channel rule ------------------------------------------------------------------------------------------------------

do $do$
declare
  v_using constant text := $expr$
      realtime.messages.extension = 'broadcast'
      and api_public.live_channel_open((select realtime.topic()))
    $expr$;
begin
  if to_regclass('private.realtime_channel_policies') is not null then
    alter table private.realtime_channel_policies
      add column roles text[] not null default '{authenticated}',
      add constraint realtime_channel_policies_roles check (roles <@ '{anon,authenticated}' and cardinality(roles) > 0);
    comment on column private.realtime_channel_policies.roles is 'Roles the policy applies to: authenticated for a signed-in person''s channels, anon for a live link''s screen (2782), which joins with the publishable key.';
    comment on table private.realtime_channel_policies is 'Row level security policies on realtime.messages that authorize XOS''s private Realtime channels (1453, 2060, 2782), each for its roles. private.ensure_realtime_channel_policies creates any that the table lacks.';

    -- From 2060, with one change: the policy is created for the row's roles instead of always authenticated.
    create or replace function private.ensure_realtime_channel_policies()
    returns text[]
    language plpgsql
    volatile
    security definer
    set search_path = ''
    as $$
    declare
      v_messages regclass := to_regclass('realtime.messages');
      v_policy private.realtime_channel_policies;
      v_created text[] := '{}';
    begin
      if v_messages is null or to_regprocedure('realtime.topic()') is null then
        return v_created;
      end if;
      -- One caller at a time: pg_cron and the deploy path may run it together.
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('xos_ensure_realtime_channel_policies'));
      for v_policy in select * from private.realtime_channel_policies p order by p.policy_name loop
        if not exists (
          select 1 from pg_catalog.pg_policy pol where pol.polrelid = v_messages and pol.polname = v_policy.policy_name
        ) then
          execute format('create policy %I on realtime.messages for %s to %s %s',
            v_policy.policy_name, v_policy.command,
            (select string_agg(pg_catalog.quote_ident(r), ', ' order by r) from unnest(v_policy.roles) r),
            case v_policy.command
              when 'select' then format('using (%s)', v_policy.using_expression)
              else format('with check (%s)', v_policy.check_expression)
            end);
          v_created := v_created || v_policy.policy_name;
        end if;
      end loop;
      if cardinality(v_created) > 0 then
        raise log 'xos: created the Realtime channel policies %', v_created;
      end if;
      return v_created;
    end;
    $$;

    comment on function private.ensure_realtime_channel_policies() is 'Creates each policy in private.realtime_channel_policies that realtime.messages lacks, for the roles its row names, and returns their names; does nothing while Realtime has not created the table or realtime.topic(). Never drops or changes an existing policy. Run by migrations 2060 and 2782, by the deploy path after each migration push, and every minute by pg_cron (xos_ensure_realtime_channel_policies).';
    revoke all on function private.ensure_realtime_channel_policies() from public, anon, authenticated;

    execute 'insert into private.realtime_channel_policies (policy_name, command, using_expression, check_expression, roles)
      values ($1, $2, $3, null, $4) on conflict (policy_name) do nothing'
      using 'xos_live_link_channel_read', 'select', v_using, '{anon}'::text[];
    perform private.ensure_realtime_channel_policies();
  elsif to_regclass('realtime.messages') is not null and to_regprocedure('realtime.topic()') is not null
        and not exists (
          select 1 from pg_catalog.pg_policy p
          where p.polrelid = 'realtime.messages'::regclass and p.polname = 'xos_live_link_channel_read') then
    execute format('create policy xos_live_link_channel_read on realtime.messages for select to anon using (%s)', v_using);
  end if;
end;
$do$;

-- Pings -------------------------------------------------------------------------------------------------------------------

create or replace function private.live_link_ping(p_topics text[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_topic text;
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return;
  end if;
  foreach v_topic in array coalesce(p_topics, '{}'::text[]) loop
    begin
      perform realtime.send('{}'::jsonb, 'changed', v_topic, true);
    exception when others then
      -- No partition of realtime.messages for today, or Realtime mid-upgrade: the write goes on without the ping.
      null;
    end;
  end loop;
end;
$$;

comment on function private.live_link_ping(text[]) is 'Tells live link channels (xlink:<channel key>) that what they show changed. Sends an empty message, never row data; does nothing without Realtime and never fails the calling write.';
revoke all on function private.live_link_ping(text[]) from public, anon, authenticated;

create or replace function private.live_link_ping_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_topics text[];
begin
  -- The common case, a write while no link is live, costs one probe of the partial index.
  if not exists (select 1 from app.live_links l where l.revoked_at is null and l.deleted_at is null) then
    return null;
  end if;
  -- Each statement trigger names its transition table changed_rows: the new rows of an insert or update, the old rows
  -- of a delete.
  if tg_table_name = 'records' then
    select array_agg(distinct 'xlink:' || c.channel_key) into v_topics
    from app.live_links l
    join app.saved_views v on v.id = l.saved_view_id
    join private.live_link_channels c on c.live_link_id = l.id
    where l.revoked_at is null and l.deleted_at is null and l.expires_at > now() and l.link_kind = 'View'
      and v.collection_key = 'project/schedule'
      and l.project_id in (select distinct r.project_id from changed_rows r);
  elsif tg_table_name = 'day_sheets' then
    select array_agg(distinct 'xlink:' || c.channel_key) into v_topics
    from app.live_links l
    join app.saved_views v on v.id = l.saved_view_id
    join private.live_link_channels c on c.live_link_id = l.id
    where l.revoked_at is null and l.deleted_at is null and l.expires_at > now() and l.link_kind = 'View'
      and v.collection_key = 'show/day_sheets'
      and l.project_id in (select distinct r.project_id from changed_rows r);
  elsif tg_table_name in ('run_of_show', 'cues') then
    -- A running order's own id, or a cue's running order.
    select array_agg(distinct 'xlink:' || c.channel_key) into v_topics
    from app.live_links l
    left join app.saved_views v on v.id = l.saved_view_id
    join private.live_link_channels c on c.live_link_id = l.id
    where l.revoked_at is null and l.deleted_at is null and l.expires_at > now()
      and (
        (l.link_kind = 'View' and v.collection_key in ('project/show', 'show/run_of_show')
          and l.project_id in (select distinct r.project_id from changed_rows r))
        or (l.link_kind = 'Display' and l.run_of_show_id in (
          select case when tg_table_name = 'cues' then (to_jsonb(r) ->> 'run_of_show_id')::uuid else (to_jsonb(r) ->> 'id')::uuid end
          from changed_rows r)));
  elsif tg_table_name = 'saved_views' then
    select array_agg(distinct 'xlink:' || c.channel_key) into v_topics
    from app.live_links l join private.live_link_channels c on c.live_link_id = l.id
    where l.revoked_at is null and l.deleted_at is null and l.saved_view_id in (select (to_jsonb(r) ->> 'id')::uuid from changed_rows r);
  elsif tg_table_name in ('saved_view_filters', 'saved_view_sorts') then
    select array_agg(distinct 'xlink:' || c.channel_key) into v_topics
    from app.live_links l join private.live_link_channels c on c.live_link_id = l.id
    where l.revoked_at is null and l.deleted_at is null
      and l.saved_view_id in (select (to_jsonb(r) ->> 'saved_view_id')::uuid from changed_rows r);
  end if;
  if v_topics is not null then
    perform private.live_link_ping(v_topics);
  end if;
  return null;
end;
$$;

comment on function private.live_link_ping_rows() is 'Statement trigger on records, running orders, cues, day sheets, saved views and their filters and sorts: pings the channels of the live links that show the changed rows (View links by project and collection, Display links by running order, and any link of a changed saved view). Returns at once when no link is live. A superset is safe, since the ping carries no data and the page rereads through its token RPC.';
revoke all on function private.live_link_ping_rows() from public, anon, authenticated;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['records', 'run_of_show', 'cues', 'day_sheets', 'saved_views', 'saved_view_filters',
    'saved_view_sorts'] loop
    execute format('create trigger t96_live_link_ping_insert after insert on app.%I referencing new table as changed_rows '
      'for each statement execute function private.live_link_ping_rows()', v_table);
    execute format('create trigger t96_live_link_ping_update after update on app.%I referencing new table as changed_rows '
      'for each statement execute function private.live_link_ping_rows()', v_table);
    execute format('create trigger t96_live_link_ping_delete after delete on app.%I referencing old table as changed_rows '
      'for each statement execute function private.live_link_ping_rows()', v_table);
  end loop;
end;
$$;

-- A revoked or regenerated link tells its open screens, which reread and show that it is gone. Regeneration updates
-- the link before it redraws the channel key, so the old channel hears it.
create or replace function private.live_link_ping_link_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_topics text[];
begin
  select array_agg(distinct 'xlink:' || c.channel_key) into v_topics
  from new_rows n
  join old_rows o on o.id = n.id
  join private.live_link_channels c on c.live_link_id = n.id
  where n.revoked_at is distinct from o.revoked_at or n.token_hash <> o.token_hash;
  if v_topics is not null then
    perform private.live_link_ping(v_topics);
  end if;
  return null;
end;
$$;

comment on function private.live_link_ping_link_changes() is 'Statement trigger after update on live links: pings the channel of each link that was revoked or regenerated, so its open screens reread and show that it is gone.';
revoke all on function private.live_link_ping_link_changes() from public, anon, authenticated;

create trigger t96_live_link_ping_update after update on app.live_links
  referencing old table as old_rows new table as new_rows
  for each statement execute function private.live_link_ping_link_changes();
