-- 2161_gateway_live_updates.sql
-- A122 (RRR-166, ADR 0082; follow-up of A88's 1450). Gateway's lists update live (Section 11.7) on the one Realtime
-- channel per page that Atlas uses, by two routes, each confining a person to their own rows.
--
--   * Publication entries. Tables whose own row level security already confines an external person to their rows
--     join the supabase_realtime publication, as 1450's did: documents of their engagements, their timesheets,
--     applications and offers, tax forms, saved and passed opportunities. Realtime checks every change against the
--     subscriber's own policies with the subscriber's JWT, and Gateway pages narrow each subscription to the
--     person or the engagements they show, so a change reaches only a person who could read the row.
--   * A personal channel. Engagements, invoices and payments are read by external people only through their
--     api_external projections (Section 8.7); their tables stay closed to them, so they cannot be published to
--     Gateway. Instead a statement trigger on each pings the private Realtime channel gateway:<person id> of the
--     people on that row's side: the engaged person, members of the engaged account (for money, its Owners, Admins
--     and Finance) and the artist's representatives. The ping carries the table's name and nothing of the row; the
--     page then rereads through its projection, which decides what the person sees. The channel rule lets each
--     person join only their own channel, so a ping reaches no one else.
--   * Pinging never fails a write: without Realtime (a database it has not started on yet, or no partition of
--     realtime.messages for today) the ping is skipped and the list rereads on its next visit, as before.
--   * The channel rule is a policy on realtime.messages, which Realtime creates as its own. Where 1710's registry of
--     channel rules exists it is registered there, so it is kept on every environment; otherwise it is created here
--     when the table exists, as 1453 did.

-- Publication ----------------------------------------------------------------------------------------------------------

do $$
declare
  v_table record;
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  for v_table in
    select t.table_name from (values ('engagement_documents'), ('timesheets'), ('applications'), ('offers'), ('tax_forms'),
      ('saved_opportunities'), ('passed_opportunities')) as t (table_name)
  loop
    if not exists (
      select 1 from pg_catalog.pg_publication_tables p
      where p.pubname = 'supabase_realtime' and p.schemaname = 'app' and p.tablename = v_table.table_name
    ) then
      execute format('alter publication supabase_realtime add table app.%I', v_table.table_name);
    end if;
  end loop;
end;
$$;

-- The personal channel ---------------------------------------------------------------------------------------------------

create or replace function private.gateway_live_ping(p_people uuid[], p_table text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid;
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return;
  end if;
  foreach v_person in array coalesce(p_people, '{}'::uuid[]) loop
    begin
      perform realtime.send(jsonb_build_object('table', p_table), 'changed', 'gateway:' || v_person::text, true);
    exception when others then
      -- No partition of realtime.messages for today, or Realtime mid-upgrade: the write goes on without the ping.
      null;
    end;
  end loop;
end;
$$;

comment on function private.gateway_live_ping(uuid[], text) is 'Tells each person''s private Realtime channel gateway:<person id> that rows of a table their Gateway lists may show changed. Sends the table name only, never row data; does nothing without Realtime and never fails the calling write.';
revoke all on function private.gateway_live_ping(uuid[], text) from public, anon, authenticated;

create or replace function private.gateway_live_ping_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_people uuid[];
begin
  -- Each statement trigger names its transition table changed_rows: the new rows of an insert or update, the old rows
  -- of a delete.
  if tg_table_name = 'engagements' then
    select array_agg(distinct x.person_id) into v_people
    from (
      select c.person_id from changed_rows c
      union
      select m.person_id from changed_rows c
      join app.counterparties cp on cp.id = c.counterparty_id
      join app.account_memberships m on m.org_id = cp.organization_id and m.deleted_at is null
        and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
      union
      select a.person_id from changed_rows c
      join app.representations r on r.artist_person_id = c.person_id and c.role_type = 'Artist' and r.deleted_at is null
        and r.accepted_at is not null and r.revoked_at is null and r.expires_on >= current_date
      cross join lateral (
        select r.representative_person_id as person_id
        union
        select m.person_id from app.account_memberships m
        where m.org_id = r.org_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
      ) a
    ) x
    where x.person_id is not null;
  elsif tg_table_name in ('invoices', 'payments') then
    select array_agg(distinct x.person_id) into v_people
    from (
      select c.payee_person_id as person_id from changed_rows c
      union
      select m.person_id from changed_rows c
      join app.counterparties cp on cp.id = c.counterparty_id
      join app.account_memberships m on m.org_id = cp.organization_id and m.deleted_at is null
        and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
      join app.account_membership_roles r on r.account_membership_id = m.id and r.deleted_at is null
        and r.account_role in ('Account Owner', 'Account Admin', 'Account Finance')
    ) x
    where x.person_id is not null;
  end if;
  perform private.gateway_live_ping(v_people, tg_table_name);
  return null;
end;
$$;

comment on function private.gateway_live_ping_rows() is 'Statement trigger on app.engagements, app.invoices and app.payments: pings the Gateway channel of the people on each changed row''s side (the engaged or paid person, members of the engaged account, for money only its Owners, Admins and Finance, and an artist''s representatives). A superset of who reads the row is safe, since the ping carries no row data and the page rereads through its projection.';
revoke all on function private.gateway_live_ping_rows() from public, anon, authenticated;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['engagements', 'invoices', 'payments'] loop
    execute format('create trigger t95_gateway_live_insert after insert on app.%I referencing new table as changed_rows '
      'for each statement execute function private.gateway_live_ping_rows()', v_table);
    execute format('create trigger t95_gateway_live_update after update on app.%I referencing new table as changed_rows '
      'for each statement execute function private.gateway_live_ping_rows()', v_table);
    execute format('create trigger t95_gateway_live_delete after delete on app.%I referencing old table as changed_rows '
      'for each statement execute function private.gateway_live_ping_rows()', v_table);
  end loop;
end;
$$;

-- The channel rule --------------------------------------------------------------------------------------------------------
-- Receiving on gateway:<person id> needs to be that person. Nobody sends on it but the triggers above, which write as
-- the database, so there is no rule for sending.

do $$
declare
  v_using constant text := $expr$
      realtime.messages.extension in ('broadcast', 'presence')
      and (select realtime.topic()) = 'gateway:' || (select private.current_person_id())::text
    $expr$;
begin
  if to_regclass('private.realtime_channel_policies') is not null then
    execute 'insert into private.realtime_channel_policies (policy_name, command, using_expression, check_expression)
      values ($1, $2, $3, null) on conflict (policy_name) do nothing'
      using 'xos_gateway_channel_read', 'select', v_using;
    perform private.ensure_realtime_channel_policies();
  elsif to_regclass('realtime.messages') is not null and to_regprocedure('realtime.topic()') is not null
        and not exists (
          select 1 from pg_catalog.pg_policy p
          where p.polrelid = 'realtime.messages'::regclass and p.polname = 'xos_gateway_channel_read') then
    execute format('create policy xos_gateway_channel_read on realtime.messages for select to authenticated using (%s)', v_using);
  end if;
end;
$$;
