-- 2240_kind_attribute_history.sql
--
-- A131 (RRR-177, S4.10-04, ADR 0090, ADR 0022 block 2240-2249). Section 4.10 gives every record a history tab built on
-- the DiffViewer. A record's own columns had one since 1452, but the attributes of its kind live in its 1:1 extension
-- row (app.record_<kind>, 0311), which had no audit trail: editing a Task's progress or a Contract's value left no
-- trace in the record's history. This migration:
--   * gives every kind extension table an audit trail. private.audit_row_change (A130 owns it) keys an event by the
--     row's id column, and an extension row has none: its key is record_id. private.audit_keyed_row_change is the same
--     trigger with the key column named by its argument, so each event's subject is the extension table and the
--     record's id. It leaves out what audit_row_change leaves out (private.audit_excluded_columns: audit columns,
--     binary columns and Restricted columns) and skips the same rows (no org, a retention purge, a purged org);
--   * lists the extension tables in private.field_history_extensions, each with the subject table whose history
--     merges its changes;
--   * recreates app.field_history from its latest definition (1452; 2061 and 2100 did not redefine it) so a record's
--     history also carries its extension row's changes, one row per attribute, named attributes.<column>. Its
--     signature stays, so app.field_history_events (2061), which groups its rows into one row per event, merges
--     them too, and p_limit still counts events: an extension row's change is an event of its own. Saving the
--     attributes the first time reads as each attribute going from nothing to its value. The same read check (the
--     record's own read policies) and the same Restricted masking apply, the latter by the extension table's column;
--   * leaves out a column that signed-in people cannot select at all (a column grant withheld, as for
--     app.agreements.access_code_hash): the ledger keeps such a column's changes, but a history readable by everyone
--     who reads the row must not return what the row itself hides. A field that is no column (2100 writes a custom
--     object record's values as values.<key>) or a column dropped since stays.

-- 1. Keyed audit trail -------------------------------------------------------------------------------------------------

create or replace function private.audit_keyed_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key_column text := tg_argv[0];
  v_excluded text[] := private.audit_excluded_columns(tg_relid);
  v_old jsonb;
  v_new jsonb;
  v_diff jsonb;
  v_row jsonb;
  v_key text;
begin
  if private.in_trusted_operation('retention_purge') then
    return null;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    v_old := to_jsonb(old) - v_excluded;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_new := to_jsonb(new) - v_excluded;
  end if;
  v_row := coalesce(to_jsonb(new), to_jsonb(old));
  if (v_row ->> 'org_id') is null then
    return null;
  end if;
  if private.in_tenant_purge((v_row ->> 'org_id')::uuid) then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    v_diff := jsonb_build_object('old', '{}'::jsonb, 'new', '{}'::jsonb);
    for v_key in select k from jsonb_object_keys(v_new) k loop
      if (v_new -> v_key) is distinct from (v_old -> v_key) then
        v_diff := jsonb_set(v_diff, array['old', v_key], coalesce(v_old -> v_key, 'null'::jsonb));
        v_diff := jsonb_set(v_diff, array['new', v_key], v_new -> v_key);
      end if;
    end loop;
    if v_diff -> 'new' = '{}'::jsonb then
      return null;
    end if;
  elsif tg_op = 'INSERT' then
    v_diff := jsonb_build_object('new', v_new);
  else
    v_diff := jsonb_build_object('old', v_old);
  end if;
  perform private.write_audit_event((v_row ->> 'org_id')::uuid, tg_table_name || '.' || lower(tg_op), tg_table_schema || '.' || tg_table_name,
    (v_row ->> v_key_column)::uuid, v_diff);
  return null;
end;
$$;

comment on function private.audit_keyed_row_change() is 'After insert, update or delete trigger for a table keyed by a column other than id (its name is the trigger''s argument): writes the row change to the audit ledger as private.audit_row_change does, with that column as the subject id. A 1:1 extension row is thereby audited under the id of the row it extends.';
revoke all on function private.audit_keyed_row_change() from public, anon, authenticated;

-- 2. Extensions whose changes a subject's history merges ----------------------------------------------------------------

create table private.field_history_extensions (
  table_name text primary key,
  subject_table text not null references private.field_history_subjects (table_name),
  key_column text not null,
  field_prefix text not null,
  constraint field_history_extensions_table_format check (table_name ~ '^app\.[a-z][a-z0-9_]*$'),
  constraint field_history_extensions_prefix_format check (field_prefix ~ '^[a-z][a-z_]*$')
);

create index field_history_extensions_subject_table_idx on private.field_history_extensions (subject_table);

comment on table private.field_history_extensions is 'Tables whose rows extend a field history subject 1:1 (Section 4.10): each change of an extension row appears in the history of the row it extends, its fields named <field_prefix>.<column>. Each has a keyed audit trail (private.audit_keyed_row_change).';
comment on column private.field_history_extensions.table_name is 'Schema-qualified extension table.';
comment on column private.field_history_extensions.subject_table is 'The field history subject the extension rows belong to.';
comment on column private.field_history_extensions.key_column is 'The column holding the id of the subject row; the audit events'' subject id.';
comment on column private.field_history_extensions.field_prefix is 'Prefix of the field names the history gives the extension''s columns.';

alter table private.field_history_extensions enable row level security;
revoke all on private.field_history_extensions from public, anon, authenticated;
grant select on private.field_history_extensions to service_role;

create or replace procedure private.install_extension_history(p_table regclass, p_subject_table text, p_key_column text, p_field_prefix text)
language plpgsql
set search_path = ''
as $$
begin
  execute format('drop trigger if exists t85_audit_trail on %s', p_table);
  execute format('create trigger t85_audit_trail after insert or update or delete on %s for each row execute function private.audit_keyed_row_change(%L)',
    p_table, p_key_column);
  insert into private.field_history_extensions (table_name, subject_table, key_column, field_prefix)
  values (p_table::text, p_subject_table, p_key_column, p_field_prefix)
  on conflict (table_name) do update
    set subject_table = excluded.subject_table, key_column = excluded.key_column, field_prefix = excluded.field_prefix;
end;
$$;

comment on procedure private.install_extension_history(regclass, text, text, text) is 'Gives a 1:1 extension table a keyed audit trail and merges its changes into the field history of the subject it extends.';
revoke all on procedure private.install_extension_history(regclass, text, text, text) from public, anon, authenticated;

-- Every kind extension of the record spine: the tables private.install_record_extension (0311) tied to app.records by
-- the composite foreign key <table>_record_kind_fkey. pgTAP 2240 fails when a kind table lacks the trail.
do $$
declare
  v_table regclass;
begin
  for v_table in
    select c.conrelid::regclass
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_class r on r.oid = c.conrelid
    where c.contype = 'f' and c.confrelid = 'app.records'::regclass and c.conname = r.relname || '_record_kind_fkey'
    order by r.relname
  loop
    call private.install_extension_history(v_table, 'app.records', 'record_id', 'attributes');
  end loop;
end;
$$;

-- 3. Field history merges the extension rows ------------------------------------------------------------------------------

create or replace function app.field_history(p_subject_table text, p_subject_id uuid, p_limit integer default 200)
returns table (
  event_id uuid,
  changed_at timestamptz,
  actor_person_id uuid,
  actor_name text,
  operation text,
  field text,
  old_value jsonb,
  new_value jsonb,
  masked boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_person();
  if p_subject_table is null or p_subject_table not in (select s.table_name from private.field_history_subjects s) then
    perform private.refuse('field_history_unavailable', 'This kind of row has no field history.');
  end if;
  if p_subject_id is null or not private.caller_reads_row(p_subject_table, p_subject_id) then
    raise exception using errcode = '42501', message = 'the row is not available to you';
  end if;
  return query
  with sources as (
    select p_subject_table as table_name, null::text as key_column, null::text as field_prefix
    union all
    select x.table_name, x.key_column, x.field_prefix
    from private.field_history_extensions x
    where x.subject_table = p_subject_table
  ),
  events as (
    select e.id, e.created_at, e.actor_person_id, e.org_id, e.diff, s.table_name, s.key_column, s.field_prefix,
           split_part(e.action, '.', 2) as op
    from app.audit_events e
    join sources s on s.table_name = e.subject_table
    where e.subject_id = p_subject_id
      and split_part(e.action, '.', 2) in ('insert', 'update', 'delete')
    order by e.created_at desc
    limit greatest(1, least(coalesce(p_limit, 200), 1000))
  ),
  fields as (
    select ev.id, ev.created_at, ev.actor_person_id, ev.org_id, ev.table_name, f.key as column_name,
           f.key as field, ev.diff -> 'old' -> f.key as old_value, f.value as new_value
    from events ev
    cross join lateral jsonb_each(coalesce(ev.diff -> 'new', '{}'::jsonb)) f
    where ev.field_prefix is null and ev.op = 'update' and f.key not in ('id', 'org_id')
    union all
    -- An extension row's change is a change of the subject's attributes: an insert sets each attribute it holds, a
    -- delete clears each one, an update changes the ones it names.
    select ev.id, ev.created_at, ev.actor_person_id, ev.org_id, ev.table_name, f.key,
           ev.field_prefix || '.' || f.key,
           case when ev.op = 'insert' then 'null'::jsonb else coalesce(ev.diff -> 'old' -> f.key, 'null'::jsonb) end,
           case when ev.op = 'delete' then 'null'::jsonb else f.value end
    from events ev
    cross join lateral jsonb_each(coalesce(ev.diff -> case when ev.op = 'delete' then 'old' else 'new' end, '{}'::jsonb)) f
    where ev.field_prefix is not null
      and f.key not in (ev.key_column, 'org_id', 'record_kind', 'deleted_at')
      and (ev.op = 'update' or f.value <> 'null'::jsonb)
  )
  select ev.id, ev.created_at, ev.actor_person_id, p.full_name, ev.op, null::text, null::jsonb, null::jsonb, false
  from events ev
  left join app.people p on p.id = ev.actor_person_id
  where ev.field_prefix is null and ev.op in ('insert', 'delete')
  union all
  select f.id, f.created_at, f.actor_person_id, p.full_name, 'update', f.field,
         case when c.read_capability is not null and not private.has_capability(f.org_id, c.read_capability) then null else f.old_value end,
         case when c.read_capability is not null and not private.has_capability(f.org_id, c.read_capability) then null else f.new_value end,
         c.read_capability is not null and not private.has_capability(f.org_id, c.read_capability)
  from fields f
  left join pg_catalog.pg_attribute a
    on a.attrelid = f.table_name::regclass and a.attname = f.column_name and not a.attisdropped
  left join app.people p on p.id = f.actor_person_id
  left join private.column_classifications c
    on c.table_name = f.table_name and c.column_name = f.column_name and c.classification = 'Restricted'
  where a.attnum is null or pg_catalog.has_column_privilege('authenticated', a.attrelid, a.attnum, 'SELECT')
  order by 2 desc, 6;
end;
$$;

comment on function app.field_history(text, uuid, integer) is 'Field history of one row (Section 4.10): each change from the audit ledger, newest first, one row per changed field with its old and new value, plus a row for creation and deletion, and the person who acted. Changes of the row''s 1:1 extension rows (private.field_history_extensions) are merged in as changed fields named <prefix>.<column>, such as a record''s attributes.progress_pct. Only for someone who can read the row (its own read policies decide); a Restricted field is masked without its read capability, and a column signed-in people cannot select is left out. IP addresses and user agents are never returned.';

revoke all on function app.field_history(text, uuid, integer) from public, anon;
grant execute on function app.field_history(text, uuid, integer) to authenticated, service_role;
