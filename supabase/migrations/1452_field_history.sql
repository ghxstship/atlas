-- 1452_field_history.sql
-- A88 (RRR-133, A65-006, ADR 0044). Field history (Section 4.10: "a history tab on every record, built on the
-- DiffViewer"): who changed which field of a row, when, from what to what, read from the audit ledger
-- (app.audit_events, 0501).
--
--   * The ledger itself stays readable only with audit.log.read. app.field_history answers for one row, and only to
--     someone who can read that row: it evaluates the subject table's own read policies (the permissive ones OR'd,
--     the restrictive ones AND'd, as row level security does) for the caller, so the history follows the row exactly.
--   * A field classified Restricted (private.column_classifications) shows as masked, with neither value, unless
--     the caller holds its read capability. Restricted columns never reach a diff in the first place (0501); this
--     covers a column classified after its changes were written.
--   * Actor IP addresses and user agents never leave the ledger.
--   * private.field_history_subjects lists the tables that offer it; each has an audit trail. app.asset_units gains
--     one here.

create table private.field_history_subjects (
  table_name text primary key,
  constraint field_history_subjects_table_format check (table_name ~ '^app\.[a-z][a-z0-9_]*$')
);

comment on table private.field_history_subjects is 'Tables whose rows show a field history (Section 4.10). Each has an audit trail, an id column and its own read policies, which the history follows.';
comment on column private.field_history_subjects.table_name is 'Schema-qualified table.';

alter table private.field_history_subjects enable row level security;
revoke all on private.field_history_subjects from public, anon, authenticated;
grant select on private.field_history_subjects to service_role;

call private.install_audit_trail('app.asset_units');

insert into private.field_history_subjects (table_name) values
  ('app.records'),
  ('app.shifts'),
  ('app.invoices'),
  ('app.asset_units'),
  ('app.sops'),
  ('app.documents'),
  ('app.purchase_orders'),
  ('app.vendors');

create or replace function private.caller_reads_row(p_table text, p_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_relid oid := p_table::regclass;
  v_permissive text;
  v_restrictive text;
  v_found boolean;
begin
  select string_agg('(' || pg_catalog.pg_get_expr(p.polqual, p.polrelid) || ')', ' or ')
    filter (where p.polpermissive),
         string_agg('(' || pg_catalog.pg_get_expr(p.polqual, p.polrelid) || ')', ' and ')
    filter (where not p.polpermissive)
    into v_permissive, v_restrictive
  from pg_catalog.pg_policy p
  where p.polrelid = v_relid and p.polcmd in ('r', '*') and p.polqual is not null
    and (0::oid = any (p.polroles) or 'authenticated'::regrole = any (p.polroles));
  if v_permissive is null then
    return false;
  end if;
  execute format('select exists (select 1 from %s where id = $1 and (%s)%s)',
    v_relid::regclass, v_permissive, case when v_restrictive is null then '' else ' and (' || v_restrictive || ')' end)
    into v_found using p_id;
  return coalesce(v_found, false);
end;
$$;

comment on function private.caller_reads_row(text, uuid) is 'Whether the signed-in caller can read one row: the table''s read policies, read from the catalog and evaluated for the caller (permissive OR''d, restrictive AND''d), as row level security would. Policy helpers read the caller from the JWT, so owner rights change nothing.';
revoke all on function private.caller_reads_row(text, uuid) from public, anon, authenticated;

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
  with events as (
    select e.id, e.created_at, e.actor_person_id, e.org_id, e.diff,
           split_part(e.action, '.', 2) as op
    from app.audit_events e
    where e.subject_id = p_subject_id and e.subject_table = p_subject_table
      and split_part(e.action, '.', 2) in ('insert', 'update', 'delete')
    order by e.created_at desc
    limit greatest(1, least(coalesce(p_limit, 200), 1000))
  ),
  fields as (
    select ev.id, ev.created_at, ev.actor_person_id, ev.org_id, ev.op, f.key as field,
           ev.diff -> 'old' -> f.key as old_value, f.value as new_value
    from events ev
    cross join lateral jsonb_each(coalesce(ev.diff -> 'new', '{}'::jsonb)) f
    where ev.op = 'update' and f.key not in ('id', 'org_id')
  )
  select ev.id, ev.created_at, ev.actor_person_id, p.full_name, ev.op, null::text, null::jsonb, null::jsonb, false
  from events ev
  left join app.people p on p.id = ev.actor_person_id
  where ev.op in ('insert', 'delete')
  union all
  select f.id, f.created_at, f.actor_person_id, p.full_name, f.op, f.field,
         case when c.read_capability is not null and not private.has_capability(f.org_id, c.read_capability) then null else f.old_value end,
         case when c.read_capability is not null and not private.has_capability(f.org_id, c.read_capability) then null else f.new_value end,
         c.read_capability is not null and not private.has_capability(f.org_id, c.read_capability)
  from fields f
  left join app.people p on p.id = f.actor_person_id
  left join private.column_classifications c
    on c.table_name = p_subject_table and c.column_name = f.field and c.classification = 'Restricted'
  order by 2 desc, 6;
end;
$$;

comment on function app.field_history(text, uuid, integer) is 'Field history of one row (Section 4.10): each change from the audit ledger, newest first, one row per changed field with its old and new value, plus a row for creation and deletion, and the person who acted. Only for someone who can read the row (its own read policies decide); a Restricted field is masked without its read capability. IP addresses and user agents are never returned.';

revoke all on function app.field_history(text, uuid, integer) from public, anon;
grant execute on function app.field_history(text, uuid, integer) to authenticated, service_role;
