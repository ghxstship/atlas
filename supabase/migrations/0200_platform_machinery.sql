-- 0200_platform_machinery.sql
-- A02 Platform Data (ADR 0004 range 0200 to 0299, ADR 0005).
-- Generic invariant machinery every tenant table reuses (Section 7.1, Section 7.5 invariant 1):
--   * org_id derived from the parent row on insert, never accepted from the caller
--   * refusal of any change of org_id after insert (no tenant move)
--   * refusal of foreign keys that point into another org
--   * created_at, created_by, updated_at and updated_by maintained by the database
-- Refusals raise SQLSTATE XR001 with a message that starts with the rule name, so the API
-- can return a 422 refusal naming the rule (ADR 0003).

-- Trusted operations -----------------------------------------------------------------
-- A SECURITY DEFINER RPC that has already authorized an act (creating an org with its
-- creator as Owner, accepting an invitation) records the act here for its own transaction.
-- Guards consult the ledger instead of re-applying rules that the RPC replaced. Only
-- definer functions can write to private tables, so the marker cannot be forged.

create table private.trusted_operations (
  xact_id xid8 not null default pg_current_xact_id(),
  operation text not null,
  primary key (xact_id, operation)
);

comment on table private.trusted_operations is 'Per-transaction markers written by definer RPCs that already authorized an act. Rows are removed before the RPC returns.';
comment on column private.trusted_operations.xact_id is 'Transaction that holds the marker.';
comment on column private.trusted_operations.operation is 'Name of the authorized act, for example bootstrap_owner or accept_invite.';

alter table private.trusted_operations enable row level security;
revoke all on private.trusted_operations from public, anon, authenticated;

create or replace function private.begin_trusted_operation(p_operation text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into private.trusted_operations (operation) values (p_operation)
  on conflict do nothing;
$$;

comment on function private.begin_trusted_operation(text) is 'Marks the current transaction as performing an act a definer RPC already authorized.';

create or replace function private.end_trusted_operation(p_operation text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  delete from private.trusted_operations
  where xact_id = pg_current_xact_id() and operation = p_operation;
$$;

comment on function private.end_trusted_operation(text) is 'Clears a trusted operation marker before the RPC returns.';

create or replace function private.in_trusted_operation(p_operation text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.trusted_operations
    where xact_id = pg_current_xact_id() and operation = p_operation
  );
$$;

comment on function private.in_trusted_operation(text) is 'True when a definer RPC in this transaction has marked the named act as authorized.';

revoke all on function private.begin_trusted_operation(text) from public, anon, authenticated;
revoke all on function private.end_trusted_operation(text) from public, anon, authenticated;
revoke all on function private.in_trusted_operation(text) from public, anon, authenticated;

-- Refusal helper --------------------------------------------------------------------

create or replace function private.refuse(p_rule text, p_message text)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  raise exception using errcode = 'XR001', message = p_rule || ': ' || p_message, hint = p_rule;
end;
$$;

comment on function private.refuse(text, text) is 'Raises a refusal (SQLSTATE XR001) whose message and hint name the rule that refused.';

revoke all on function private.refuse(text, text) from public, anon;
grant execute on function private.refuse(text, text) to authenticated, service_role;

-- org_id derivation ---------------------------------------------------------------------
-- Trigger arguments: the parent table (schema-qualified) and the column holding the parent id.
-- The parent's org_id overwrites whatever the caller sent. A parent whose org_id is null
-- (a platform system role) yields null, which the NOT NULL constraint of a tenant table refuses.

create or replace function private.derive_org_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent_table text := tg_argv[0];
  v_parent_column text := tg_argv[1];
  v_parent_id uuid := (to_jsonb(new) ->> v_parent_column)::uuid;
  v_org_id uuid;
  v_found boolean := false;
begin
  if v_parent_id is null then
    raise exception using errcode = '23502',
      message = format('%s.%s is required to derive org_id', tg_table_name, v_parent_column);
  end if;
  execute format('select org_id, true from %s where id = $1', v_parent_table)
    into v_org_id, v_found
    using v_parent_id;
  if v_found is not true then
    raise exception using errcode = '23503',
      message = format('%s.%s references a missing %s row', tg_table_name, v_parent_column, v_parent_table);
  end if;
  new := jsonb_populate_record(new, jsonb_build_object('org_id', v_org_id));
  return new;
end;
$$;

comment on function private.derive_org_id() is 'Before insert or update trigger: sets org_id from the parent row named by the trigger arguments (parent table, parent id column). Never trusts a caller-supplied org_id.';

-- No tenant move ------------------------------------------------------------------------

create or replace function private.refuse_org_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.org_id is distinct from old.org_id then
    perform private.refuse('tenant_move', format('%s rows cannot move to another org.', tg_table_name));
  end if;
  return new;
end;
$$;

comment on function private.refuse_org_change() is 'Before update trigger: refuses any change of org_id (Section 7.5 invariant 1).';

-- No cross-org references ----------------------------------------------------------------
-- Trigger arguments come in pairs: referenced table (schema-qualified), referencing column.
-- A referenced row whose org_id is null (a platform system role) may be used by every org.

create or replace function private.refuse_cross_org_reference()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_org_id uuid := (v_row ->> 'org_id')::uuid;
  v_ref_id uuid;
  v_ref_org uuid;
  v_found boolean;
  i integer := 0;
begin
  while i < tg_nargs loop
    v_ref_id := (v_row ->> tg_argv[i + 1])::uuid;
    if v_ref_id is not null then
      v_found := false;
      execute format('select org_id, true from %s where id = $1', tg_argv[i])
        into v_ref_org, v_found
        using v_ref_id;
      if v_found is not true then
        raise exception using errcode = '23503',
          message = format('%s.%s references a missing %s row', tg_table_name, tg_argv[i + 1], tg_argv[i]);
      end if;
      if v_ref_org is not null and v_ref_org is distinct from v_org_id then
        perform private.refuse('cross_org_reference',
          format('%s.%s points to a row of another org.', tg_table_name, tg_argv[i + 1]));
      end if;
    end if;
    i := i + 2;
  end loop;
  return new;
end;
$$;

comment on function private.refuse_cross_org_reference() is 'Before insert or update trigger: refuses a foreign key into another org (Section 7.5 invariant 1). Arguments are pairs of referenced table and referencing column.';

-- Audit columns ---------------------------------------------------------------------------
-- created_* are set once on insert and kept on update; updated_* follow every write.
-- The acting person comes from the session, never from the caller's payload.

create or replace function private.stamp_audit_columns()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.current_person_id();
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := v_person;
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  new.updated_at := now();
  new.updated_by := v_person;
  return new;
end;
$$;

comment on function private.stamp_audit_columns() is 'Before insert or update trigger: maintains created_at, created_by, updated_at and updated_by from the session.';

-- Append-only ledgers -------------------------------------------------------------------

create or replace function private.refuse_ledger_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.refuse('append_only', format('%s is an append-only ledger.', tg_table_name));
  return null;
end;
$$;

comment on function private.refuse_ledger_change() is 'Before update or delete trigger on append-only ledgers: refuses the change.';

revoke all on function private.derive_org_id() from public, anon, authenticated;
revoke all on function private.refuse_org_change() from public, anon, authenticated;
revoke all on function private.refuse_cross_org_reference() from public, anon, authenticated;
revoke all on function private.stamp_audit_columns() from public, anon, authenticated;
revoke all on function private.refuse_ledger_change() from public, anon, authenticated;

-- Installers ------------------------------------------------------------------------------
-- Migrations call these once per table so every tenant table gets the same machinery.
-- A03 and later ranges reuse them for their own tables.

create or replace procedure private.install_audit_columns(p_table regclass)
language plpgsql
set search_path = ''
as $$
declare
  v_name text := (select c.relname from pg_catalog.pg_class c where c.oid = p_table);
begin
  execute format('create index if not exists %I on %s (created_by)', v_name || '_created_by_idx', p_table);
  execute format('create index if not exists %I on %s (updated_by)', v_name || '_updated_by_idx', p_table);
  execute format('comment on column %s.created_at is %L', p_table, 'When the row was inserted. Set by the database.');
  execute format('comment on column %s.created_by is %L', p_table, 'Person who inserted the row, or null for a platform process. Set by the database.');
  execute format('comment on column %s.updated_at is %L', p_table, 'When the row last changed. Set by the database.');
  execute format('comment on column %s.updated_by is %L', p_table, 'Person who last changed the row, or null for a platform process. Set by the database.');
  execute format('comment on column %s.deleted_at is %L', p_table, 'Soft delete time. A row with deleted_at set is ignored by every access helper.');
  execute format('drop trigger if exists t90_stamp_audit_columns on %s', p_table);
  execute format(
    'create trigger t90_stamp_audit_columns before insert or update on %s for each row execute function private.stamp_audit_columns()',
    p_table);
end;
$$;

comment on procedure private.install_audit_columns(regclass) is 'Indexes and comments the ADR 0002 audit columns of a table and attaches the trigger that maintains them.';

create or replace procedure private.install_tenant_guards(
  p_table regclass,
  p_parent_table text default null,
  p_parent_column text default null,
  p_references text[] default '{}'
)
language plpgsql
set search_path = ''
as $$
declare
  v_args text;
begin
  if p_parent_table is not null then
    execute format('drop trigger if exists t10_derive_org_id on %s', p_table);
    execute format(
      'create trigger t10_derive_org_id before insert or update of %I on %s for each row execute function private.derive_org_id(%L, %L)',
      p_parent_column, p_table, p_parent_table, p_parent_column);
  end if;
  execute format('drop trigger if exists t20_refuse_org_change on %s', p_table);
  execute format(
    'create trigger t20_refuse_org_change before update on %s for each row execute function private.refuse_org_change()',
    p_table);
  if cardinality(p_references) > 0 then
    select string_agg(format('%L', a), ', ') into v_args from unnest(p_references) as a;
    execute format('drop trigger if exists t30_refuse_cross_org_reference on %s', p_table);
    execute format(
      'create trigger t30_refuse_cross_org_reference before insert or update on %s for each row execute function private.refuse_cross_org_reference(%s)',
      p_table, v_args);
  end if;
end;
$$;

comment on procedure private.install_tenant_guards(regclass, text, text, text[]) is 'Attaches org_id derivation from a parent (when given), the no tenant move trigger, and the cross-org reference trigger (pairs of referenced table and column) to a tenant table.';

revoke all on procedure private.install_audit_columns(regclass) from public, anon, authenticated;
revoke all on procedure private.install_tenant_guards(regclass, text, text, text[]) from public, anon, authenticated;
