-- 2170_live_lists_and_presence.sql
-- A123 (RRR-168, ADR 0083; follow-up of A88 and ADR 0044). Live updates on the remaining Atlas lists, and presence on
-- records, peeks and documents (Section 11.7).
--
--   * The tables behind the projects, procurement (purchase orders, receipts, RFQs), vendors, work orders, advancing
--     and people lists join the supabase_realtime publication, as 1450 did for records, shifts, invoices, asset units
--     and SOPs. Realtime checks every change against the subscriber's own row level security, so a change reaches only
--     people who could read the row, and pages subscribe narrowed to their org (`org_id=eq.<id>`). The logistics lists
--     follow shipments, dock slots and the marshalling log, and the dispatch board follows incidents and dispatch
--     assignments, which are published already (0440, 0470).
--   * private.presence_subjects lists the tables whose rows show who else is looking at them. A record page, peek or
--     document joins the private Realtime channel `presence:<table>:<row id>` and tracks the person's name there;
--     presence is ephemeral in Realtime and never stored (Section 7.3).
--   * private.presence_can_join(topic) authorizes those channels with 1453's rule: whoever can read the row may join,
--     through the table's own read policies evaluated for the caller (private.caller_reads_row, 1452). Anyone else is
--     refused, so a channel never tells a non-reader who is looking at a row, or that the row exists. Joining sends
--     presence only: nobody broadcasts on these channels.
--   * The two channel rules on realtime.messages are rows of private.realtime_channel_policies when 2060 (A106) has
--     created that registry, so its pg_cron job keeps them present on every environment; on a database without the
--     registry they are created directly, as 1453 created the document channel rules.

-- Live lists ---------------------------------------------------------------------------------------------------------

do $$
declare
  v_table record;
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  for v_table in
    select t.table_name from (values
      ('projects'),
      ('purchase_orders'), ('po_lines'), ('goods_receipts'), ('rfqs'),
      ('vendors'),
      ('work_orders'),
      ('advance_packets'), ('advance_submissions'),
      ('memberships'), ('role_assignments'), ('requisitions'), ('agreements')
    ) as t (table_name)
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

-- Presence -----------------------------------------------------------------------------------------------------------

create table private.presence_subjects (
  table_name text primary key,
  constraint presence_subjects_table_format check (table_name ~ '^app\.[a-z][a-z0-9_]{0,58}$')
);

comment on table private.presence_subjects is 'Tables whose record pages, peeks and documents show who else is viewing them (Section 11.7): a row of one joins the private Realtime channel presence:<table without app.>:<row id>.';
comment on column private.presence_subjects.table_name is 'Schema-qualified table, in the app schema.';

alter table private.presence_subjects enable row level security;
revoke all on private.presence_subjects from public, anon, authenticated;
grant select on private.presence_subjects to service_role;

insert into private.presence_subjects (table_name) values
  ('app.records'),
  ('app.documents'),
  ('app.sops'),
  ('app.incidents'),
  ('app.purchase_orders'),
  ('app.goods_receipts'),
  ('app.rfqs'),
  ('app.vendors');

create or replace function private.presence_can_join(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[];
  v_table text;
begin
  v_parts := pg_catalog.regexp_match(p_topic,
    '^presence:([a-z][a-z0-9_]{0,58}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
  if v_parts is null then
    return false;
  end if;
  select s.table_name into v_table from private.presence_subjects s where s.table_name = 'app.' || v_parts[1];
  if v_table is null then
    return false;
  end if;
  return private.caller_reads_row(v_table, v_parts[2]::uuid);
end;
$$;

comment on function private.presence_can_join(text) is 'Whether the signed-in caller may join a presence channel presence:<table>:<row id>: the table is listed in private.presence_subjects and the caller can read the row, through the table''s own read policies (private.caller_reads_row). Any other topic answers false.';

revoke all on function private.presence_can_join(text) from public, anon;
grant execute on function private.presence_can_join(text) to authenticated, service_role;

-- Realtime authorization for the presence channels -------------------------------------------------------------------
-- Receiving needs read access to the row; so does tracking presence. Nothing else may be sent: a broadcast on a
-- presence channel is refused for everyone.

do $$
declare
  v_read text := $expr$
      realtime.messages.extension in ('broadcast', 'presence')
      and (select realtime.topic()) like 'presence:%'
      and private.presence_can_join((select realtime.topic()))
    $expr$;
  v_write text := $expr$
      realtime.messages.extension = 'presence'
      and (select realtime.topic()) like 'presence:%'
      and private.presence_can_join((select realtime.topic()))
    $expr$;
begin
  if to_regclass('private.realtime_channel_policies') is not null then
    execute $insert$
      insert into private.realtime_channel_policies (policy_name, command, using_expression, check_expression)
      values ('xos_presence_channel_read', 'select', $1, null), ('xos_presence_channel_write', 'insert', null, $2)
      on conflict (policy_name) do nothing
    $insert$ using v_read, v_write;
    perform private.ensure_realtime_channel_policies();
  elsif to_regclass('realtime.messages') is not null then
    execute format('create policy xos_presence_channel_read on realtime.messages for select to authenticated using (%s)',
      v_read);
    execute format('create policy xos_presence_channel_write on realtime.messages for insert to authenticated with check (%s)',
      v_write);
  end if;
end;
$$;
