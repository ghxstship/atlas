-- 2925_showcaller_link_channels.sql
-- B3 Showcaller portal (RRR-227, ADR 0142). The portal updates while it is open, the way P1's live links do (2782):
-- each link has a private broadcast channel, xcall:<channel key>, that only the database sends to. A statement trigger
-- on each table the portal shows sends a ping that carries nothing of the rows, and the portal rereads through
-- api_public.showcaller_run, which decides what it shows.
--   * api_public.showcaller_channel_open(topic) is true only for the channel of a link that is not revoked, deleted or
--     expired. The portal learns the key only from a successful read, after the access code and with a device grant;
--     regenerating a link draws a new key (2923), so an old portal hears nothing more.
--   * The channel rule is a select policy on realtime.messages for anon, registered in private.realtime_channel_policies
--     (2060, with 2782's roles column) and created by private.ensure_realtime_channel_policies, which is not redefined.
--     Without the registry the policy is created directly when Realtime's table exists, as 2782 does. There is no send
--     rule: only the database sends.
--   * Pings go through P1's private.live_link_ping, so they never fail a write: without Realtime the portal catches up
--     on its pull. Running orders, cues, department calls, segment colors and cue custom values each get three
--     statement triggers (insert, update and delete, each with its own transition table). Each returns at once when no
--     showcaller link is live (unrevoked and unexpired), a probe of a partial index on the expiry.
--   * A revoked or regenerated link pings its own channel, so its open portal rereads and shows that it is gone.

create or replace function api_public.showcaller_channel_open(p_topic text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_topic ~ '^xcall:xcch_[0-9a-f]{64}$', false) and exists (
    select 1 from private.showcaller_link_channels c
    join app.showcaller_links l on l.id = c.showcaller_link_id
    where c.channel_key = substr(p_topic, 7) and l.revoked_at is null and l.deleted_at is null and l.expires_at > now());
$$;

comment on function api_public.showcaller_channel_open(text) is 'True when a Realtime topic is xcall: and the channel key of a showcaller link that is not revoked, deleted or expired (ADR 0142). The anon channel rule on realtime.messages calls it; the key reaches a portal only from a successful showcaller link read.';
revoke all on function api_public.showcaller_channel_open(text) from public;
grant execute on function api_public.showcaller_channel_open(text) to anon, authenticated, service_role;

-- The channel rule ------------------------------------------------------------------------------------------------------

do $do$
declare
  v_using constant text := $expr$
      realtime.messages.extension = 'broadcast'
      and api_public.showcaller_channel_open((select realtime.topic()))
    $expr$;
begin
  if to_regclass('private.realtime_channel_policies') is not null then
    execute 'insert into private.realtime_channel_policies (policy_name, command, using_expression, check_expression, roles)
      values ($1, $2, $3, null, $4) on conflict (policy_name) do nothing'
      using 'xos_showcaller_channel_read', 'select', v_using, '{anon}'::text[];
    perform private.ensure_realtime_channel_policies();
  elsif to_regclass('realtime.messages') is not null and to_regprocedure('realtime.topic()') is not null
        and not exists (
          select 1 from pg_catalog.pg_policy p
          where p.polrelid = 'realtime.messages'::regclass and p.polname = 'xos_showcaller_channel_read') then
    execute format('create policy xos_showcaller_channel_read on realtime.messages for select to anon using (%s)', v_using);
  end if;
end;
$do$;

-- Pings ---------------------------------------------------------------------------------------------------------------------

-- Expired links are never revoked, so the probe asks for an unexpired one; this index answers it.
create index showcaller_links_live_expiry_idx on app.showcaller_links (expires_at) where revoked_at is null and deleted_at is null;

create or replace function private.showcaller_link_ping_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_runs uuid[];
  v_topics text[];
begin
  -- The common case, a write while no link is live, costs one probe of the partial expiry index: a link that expired is
  -- live no more, though it was never revoked.
  if not exists (select 1 from app.showcaller_links l where l.revoked_at is null and l.deleted_at is null and l.expires_at > now()) then
    return null;
  end if;
  -- Each statement trigger names its transition table changed_rows: the new rows of an insert or update, the old rows
  -- of a delete. A superset is safe, since the ping carries no data.
  if tg_table_name = 'run_of_show' then
    select array_agg(distinct (to_jsonb(r) ->> 'id')::uuid) into v_runs from changed_rows r;
  elsif tg_table_name in ('cues', 'run_segment_colors') then
    select array_agg(distinct (to_jsonb(r) ->> 'run_of_show_id')::uuid) into v_runs from changed_rows r;
  elsif tg_table_name = 'cue_calls' then
    select array_agg(distinct c.run_of_show_id) into v_runs
    from changed_rows r join app.cues c on c.id = (to_jsonb(r) ->> 'cue_id')::uuid;
  elsif tg_table_name = 'custom_field_values' then
    select array_agg(distinct c.run_of_show_id) into v_runs
    from changed_rows r join app.cues c on c.id = (to_jsonb(r) ->> 'target_id')::uuid;
  end if;
  if v_runs is null then
    return null;
  end if;
  select array_agg(distinct 'xcall:' || c.channel_key) into v_topics
  from app.showcaller_links l
  join private.showcaller_link_channels c on c.showcaller_link_id = l.id
  where l.run_of_show_id = any (v_runs) and l.revoked_at is null and l.deleted_at is null and l.expires_at > now();
  if v_topics is not null then
    perform private.live_link_ping(v_topics);
  end if;
  return null;
end;
$$;

comment on function private.showcaller_link_ping_rows() is 'Statement trigger on running orders, cues, department calls, segment colors and custom field values: pings the channels of the live showcaller links of the running orders the statement changed (a custom field value counts when its target is a cue). Returns at once when no link is unrevoked and unexpired; never fails the write.';
revoke all on function private.showcaller_link_ping_rows() from public, anon, authenticated;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['run_of_show', 'cues', 'cue_calls', 'run_segment_colors', 'custom_field_values'] loop
    execute format('create trigger t96_showcaller_link_ping_insert after insert on app.%I referencing new table as changed_rows '
      'for each statement execute function private.showcaller_link_ping_rows()', v_table);
    execute format('create trigger t96_showcaller_link_ping_update after update on app.%I referencing new table as changed_rows '
      'for each statement execute function private.showcaller_link_ping_rows()', v_table);
    execute format('create trigger t96_showcaller_link_ping_delete after delete on app.%I referencing old table as changed_rows '
      'for each statement execute function private.showcaller_link_ping_rows()', v_table);
  end loop;
end;
$$;

-- Regeneration updates the link before it redraws the channel key, so the old channel hears it.
create or replace function private.showcaller_link_ping_link_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_topics text[];
begin
  select array_agg(distinct 'xcall:' || c.channel_key) into v_topics
  from new_rows n
  join old_rows o on o.id = n.id
  join private.showcaller_link_channels c on c.showcaller_link_id = n.id
  where n.revoked_at is distinct from o.revoked_at or n.token_hash <> o.token_hash;
  if v_topics is not null then
    perform private.live_link_ping(v_topics);
  end if;
  return null;
end;
$$;

comment on function private.showcaller_link_ping_link_changes() is 'Statement trigger after update on showcaller links: pings the channel of each link that was revoked or regenerated, so its open portal rereads and shows that it is gone.';
revoke all on function private.showcaller_link_ping_link_changes() from public, anon, authenticated;

create trigger t96_showcaller_link_ping_update after update on app.showcaller_links
  referencing old table as old_rows new table as new_rows
  for each statement execute function private.showcaller_link_ping_link_changes();
