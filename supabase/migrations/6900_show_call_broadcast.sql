-- 6900_show_call_broadcast.sql
-- A145 follow-up (RRR-243, ADR 0119 amendment). A called cue reaches every device following its running order through
-- a database broadcast, not only through the cue's Postgres change. Realtime finds Postgres changes by polling the
-- replication slot, so a change waited up to about half a second on a loaded machine before any device heard it; a
-- message sent with realtime.send reaches Realtime on its replication stream of realtime.messages, without the poll.
--   * Each running order has a private broadcast channel, show:<run id>, that only the database sends to. A row trigger
--     on app.cues sends one `called` message when a cue is called (inserted called, or called_at set from null), as the
--     cue.called event triggers fire (6243). The message carries the cue's id and called_at, which the cue's Postgres
--     change already carries to the same people, and nothing else.
--   * private.show_channel_can_join(topic) is true when the topic is show:<run id> and the signed-in caller can read that
--     running order through its own read policies (private.caller_reads_row, 1452). Cues are a child table of their
--     running order (0350), so whoever may read the run reads its cues. Any other topic answers false.
--   * The channel rule is a select policy on realtime.messages for authenticated, registered in
--     private.realtime_channel_policies (2060, with 3782's roles column) and created by
--     private.ensure_realtime_channel_policies, which is not redefined. Without the registry the policy is created
--     directly when Realtime's table exists, as 2170 does. There is no send rule: only the database sends.
--   * Sending never fails a call: without Realtime, or with no partition of realtime.messages for today, the message is
--     skipped and devices hear the call from the Postgres change or their 15-second pull, as before.
--   * The Postgres change stays: pages still reread from it (ADR 0044), and the reread stays the source of what a page
--     shows (ADR 0119, decision 2).

-- Whether a caller may join a running order's channel ----------------------------------------------------------------

create or replace function private.show_channel_can_join(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[];
begin
  v_parts := pg_catalog.regexp_match(p_topic,
    '^show:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
  if v_parts is null then
    return false;
  end if;
  return private.caller_reads_row('app.run_of_show', v_parts[1]::uuid);
end;
$$;

comment on function private.show_channel_can_join(text) is 'Whether the signed-in caller may join a running order''s private Realtime channel show:<run id> (6900): the caller can read the running order through its own read policies (private.caller_reads_row). Any other topic answers false.';

revoke all on function private.show_channel_can_join(text) from public, anon;
grant execute on function private.show_channel_can_join(text) to authenticated, service_role;

-- The channel rule ------------------------------------------------------------------------------------------------------

do $do$
declare
  v_using constant text := $expr$
      realtime.messages.extension = 'broadcast'
      and (select realtime.topic()) like 'show:%'
      and private.show_channel_can_join((select realtime.topic()))
    $expr$;
begin
  if to_regclass('private.realtime_channel_policies') is not null then
    execute 'insert into private.realtime_channel_policies (policy_name, command, using_expression, check_expression, roles)
      values ($1, $2, $3, null, $4) on conflict (policy_name) do nothing'
      using 'xos_show_channel_read', 'select', v_using, '{authenticated}'::text[];
    perform private.ensure_realtime_channel_policies();
  elsif to_regclass('realtime.messages') is not null and to_regprocedure('realtime.topic()') is not null
        and not exists (
          select 1 from pg_catalog.pg_policy p
          where p.polrelid = 'realtime.messages'::regclass and p.polname = 'xos_show_channel_read') then
    execute format('create policy xos_show_channel_read on realtime.messages for select to authenticated using (%s)', v_using);
  end if;
end;
$do$;

-- The call broadcast -------------------------------------------------------------------------------------------------------

create or replace function private.broadcast_cue_called()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return null;
  end if;
  begin
    perform realtime.send(
      pg_catalog.jsonb_build_object('cue_id', new.id, 'called_at', new.called_at),
      'called', 'show:' || new.run_of_show_id::text, true);
  exception when others then
    -- No partition of realtime.messages for today, or Realtime mid-upgrade: the call goes on without the message.
    null;
  end;
  return null;
end;
$$;

comment on function private.broadcast_cue_called() is 'Row trigger after a cue is called: sends a called message (cue_id, called_at) to its running order''s private channel show:<run id>, which Realtime delivers without waiting for its change poll (6900, ADR 0119). Does nothing without Realtime and never fails the call.';
revoke all on function private.broadcast_cue_called() from public, anon, authenticated;

create trigger t97_broadcast_cue_called_insert after insert on app.cues
  for each row when (new.called_at is not null and new.deleted_at is null)
  execute function private.broadcast_cue_called();
create trigger t97_broadcast_cue_called after update of called_at on app.cues
  for each row when (old.called_at is null and new.called_at is not null and new.deleted_at is null)
  execute function private.broadcast_cue_called();
