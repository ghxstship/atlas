-- 2060_realtime_channel_rules.sql
--
-- A106 (RRR-151, ADR 0044; follow-up of A88). The co-editing channels doc:<doc id> are authorized by two policies on
-- realtime.messages (1453). That table belongs to Supabase Realtime, which creates it in its own tenant migrations, as
-- supabase_admin, so 1453 created the policies only where the table already existed when the migration ran. A local
-- stack has it (the CLI runs Realtime's migrations before ours), but a hosted project whose Realtime has not started
-- yet, or a Realtime upgrade that recreates the table, leaves the channels without a policy: every join is refused
-- (it fails closed) and editors fall back to the 15 s pull. This makes the rules present on every environment.
--
--   * private.realtime_channel_policies lists the policies the channels need, one row each: name, command and
--     expression. 1453's two document channel policies are its rows; a later channel rule is one more row.
--   * private.ensure_realtime_channel_policies() creates each listed policy realtime.messages lacks, and does nothing
--     while the table or realtime.topic() does not exist yet. It never drops or changes a policy that exists, and it
--     returns the names it created.
--   * It runs here, from the deploy path after every migration push (infra/runbooks/production.md), and every minute
--     from pg_cron (xos_ensure_realtime_channel_policies), so the rules are back within a minute of Realtime creating
--     or recreating the table, on any environment.
--   * Not an event trigger on ddl_command_end: Realtime runs its DDL as supabase_admin, a superuser, and an event
--     trigger created by postgres (allowed by supautils) does not fire for a superuser's DDL.
--   * 1450 needs no change. Its condition is the supabase_realtime publication, which the Postgres image creates when
--     the cluster is initialized, before any migration runs, and which Realtime never recreates.

-- Registry -----------------------------------------------------------------------------------------------------------

create table private.realtime_channel_policies (
  policy_name text primary key,
  command text not null,
  using_expression text,
  check_expression text,
  constraint realtime_channel_policies_name_format check (policy_name ~ '^xos_[a-z][a-z0-9_]{0,58}$'),
  constraint realtime_channel_policies_command check (command in ('select', 'insert')),
  constraint realtime_channel_policies_expression check (
    (command = 'select' and using_expression is not null and check_expression is null)
    or (command = 'insert' and check_expression is not null and using_expression is null))
);

comment on table private.realtime_channel_policies is 'Row level security policies on realtime.messages that authorize XOS''s private Realtime channels (1453, 2060), for the authenticated role. private.ensure_realtime_channel_policies creates any that the table lacks.';
comment on column private.realtime_channel_policies.policy_name is 'Policy name on realtime.messages.';
comment on column private.realtime_channel_policies.command is 'select authorizes receiving broadcasts and presence on a channel; insert authorizes sending them.';
comment on column private.realtime_channel_policies.using_expression is 'USING expression of a select policy.';
comment on column private.realtime_channel_policies.check_expression is 'WITH CHECK expression of an insert policy.';

alter table private.realtime_channel_policies enable row level security;
revoke all on private.realtime_channel_policies from public, anon, authenticated;
grant select on private.realtime_channel_policies to service_role;

-- The document channels doc:<doc id>, exactly as 1453 wrote them: receiving needs read access to the document's row,
-- broadcasting needs write access, and presence needs read access, so readers may track themselves.
insert into private.realtime_channel_policies (policy_name, command, using_expression, check_expression) values
  ('xos_doc_channel_read', 'select', $expr$
      realtime.messages.extension in ('broadcast', 'presence')
      and (select realtime.topic()) ~ '^doc:[0-9a-f-]{36}$'
      and private.coedit_can_read(substr((select realtime.topic()), 5)::uuid)
    $expr$, null),
  ('xos_doc_channel_write', 'insert', null, $expr$
      (select realtime.topic()) ~ '^doc:[0-9a-f-]{36}$'
      and (
        (realtime.messages.extension = 'broadcast' and private.coedit_can_write(substr((select realtime.topic()), 5)::uuid))
        or (realtime.messages.extension = 'presence' and private.coedit_can_read(substr((select realtime.topic()), 5)::uuid))
      )
    $expr$);

-- Ensuring the policies --------------------------------------------------------------------------------------------------

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
      execute format('create policy %I on realtime.messages for %s to authenticated %s',
        v_policy.policy_name, v_policy.command,
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

comment on function private.ensure_realtime_channel_policies() is 'Creates each policy in private.realtime_channel_policies that realtime.messages lacks, for the authenticated role, and returns their names; does nothing while Realtime has not created the table or realtime.topic(). Never drops or changes an existing policy. Run by migration 2060, by the deploy path after each migration push, and every minute by pg_cron (xos_ensure_realtime_channel_policies).';

revoke all on function private.ensure_realtime_channel_policies() from public, anon, authenticated;

select private.ensure_realtime_channel_policies();

-- Realtime creates or recreates its tables on its own schedule: the first time a project's Realtime starts, and in
-- some upgrades. Checking every minute costs one catalog lookup and brings the rules back within a minute.
select cron.schedule('xos_ensure_realtime_channel_policies', '* * * * *',
  'select private.ensure_realtime_channel_policies()');
